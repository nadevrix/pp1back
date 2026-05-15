import { supabase } from '@/lib/supabase';
import { getUsdcReceivedSince } from '@/lib/stellar/horizon';
import { forwardFromPool } from '@/lib/stellar/transactions';

// Controls how many wallets are checked against Horizon simultaneously.
// At 100 wallets the default of 10 is fine. Scale up for larger pools.
const CONCURRENCY = parseInt(process.env.PROCESSOR_CONCURRENCY || '10');

// Cuánto puede durar como máximo un procesamiento antes de que otro lo robe.
// Si la función crashea entre claim y release, el lock se libera solo después de este TTL.
const PROCESSING_LEASE_MS = 30_000;

export interface PendingTx {
    id: string;
    wallet_pubkey: string;
    amount_expected: number;
    amount_paid: number;
    expires_at: string;
    created_at: string;
    project_id: string;
    projects: {
        payout_wallet: string;
    } | { payout_wallet: string }[];
}


export interface ProcessResult {
    id: string;
    status: string;
    received?: number;
    expected?: number;
    error?: string;
}

function getPayoutWallet(tx: PendingTx): string | undefined {
    const p = tx.projects;
    if (!p) return undefined;
    if (Array.isArray(p)) return p[0]?.payout_wallet;
    return p.payout_wallet;
}

async function unlockWallet(walletPubkey: string): Promise<void> {
    const { error } = await supabase
        .from('wallets')
        .update({ is_locked: false, locked_until: null })
        .eq('public_key', walletPubkey);
    if (error) console.error(`[PROCESSOR] Failed to unlock wallet ${walletPubkey}:`, error.message);
}

/**
 * Intenta reclamar un "lease" sobre la tx para procesarla. El UPDATE es atómico:
 * solo una request puede marcar el processing_started_at si la tx sigue pending
 * y no hay un lease vigente. Devuelve true si la conseguimos, false si otra request
 * ya está procesando.
 */
async function tryClaimProcessing(txId: string): Promise<boolean> {
    const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS).toISOString();
    const now = new Date().toISOString();

    // .or() en Supabase espera el predicado completo. Hay dos casos válidos para
    // reclamar el lease: o processing_started_at está null, o ya venció.
    const { data, error } = await supabase
        .from('transactions')
        .update({ processing_started_at: now })
        .eq('id', txId)
        .eq('status', 'pending')
        .or(`processing_started_at.is.null,processing_started_at.lt.${staleBefore}`)
        .select('id');

    if (error) {
        console.error(`[PROCESSOR] tryClaimProcessing failed for ${txId}:`, error.message);
        return false;
    }
    return Array.isArray(data) && data.length > 0;
}

async function releaseProcessing(txId: string): Promise<void> {
    await supabase
        .from('transactions')
        .update({ processing_started_at: null })
        .eq('id', txId);
}

export async function processSingleTransaction(
    tx: PendingTx,
    now: Date,
    opts: { skipLock?: boolean } = {},
): Promise<ProcessResult> {
    // Bug 1 fix — reclamar lease antes de tocar Horizon o Stellar para evitar
    // que dos pollings concurrentes hagan doble forward.
    if (!opts.skipLock) {
        const claimed = await tryClaimProcessing(tx.id);
        if (!claimed) {
            return { id: tx.id, status: 'already_processing' };
        }
    }

    try {
        const isExpired = new Date(tx.expires_at) <= now;
        const totalReceived = await getUsdcReceivedSince(tx.wallet_pubkey, tx.created_at);
        const amountExpected = parseFloat(String(tx.amount_expected));
        const alreadyRecorded = parseFloat(String(tx.amount_paid || '0'));

        if (isExpired) {
            let finalStatus: string;
            if (totalReceived <= 0) {
                finalStatus = 'expired';
            } else if (totalReceived < amountExpected) {
                finalStatus = 'underpaid';
            } else {
                finalStatus = totalReceived > amountExpected ? 'overpaid' : 'completed';
            }

            // Forward funds BEFORE updating status.
            let forwardHash: string | null = null;
            let forwardStatus: string = 'pending';

            if (totalReceived > 0) {
                const payoutWallet = getPayoutWallet(tx);
                if (!payoutWallet) {
                    console.error(`[PROCESSOR] No payout_wallet for project ${tx.project_id}, tx ${tx.id}. Funds remain in pool wallet.`);
                    finalStatus = 'anomaly';
                    forwardStatus = 'failed';
                } else {
                    try {
                        forwardHash = await forwardFromPool(tx.wallet_pubkey, payoutWallet, totalReceived.toFixed(7));
                        forwardStatus = 'completed';
                    } catch (e: any) {
                        console.error(`[PROCESSOR] Forward to merchant failed for expired tx ${tx.id}:`, e.message);
                        finalStatus = 'anomaly';
                        forwardStatus = 'failed';
                    }
                }
            } else {
                forwardStatus = 'skipped';
            }

            await supabase.from('transactions')
                .update({
                    status: finalStatus,
                    amount_paid: totalReceived,
                    ...(forwardHash && { forward_tx_hash: forwardHash }),
                    forward_status: forwardStatus,
                })
                .eq('id', tx.id);

            // Bug 2 fix — Solo liberar la wallet si el forward salió bien
            // (o si nunca hubo que forwardear porque no llegaron fondos).
            // Si forwardStatus === 'failed', dejamos la wallet lockeada con los
            // fondos del cliente adentro hasta que un admin haga retry.
            if (forwardStatus !== 'failed') {
                await unlockWallet(tx.wallet_pubkey);
            } else {
                console.warn(`[PROCESSOR] Wallet ${tx.wallet_pubkey.slice(0, 8)}... left locked with funds. Tx ${tx.id} requires manual retry via /api/admin/tx/${tx.id}/retry-forward`);
            }
            return { id: tx.id, status: finalStatus, received: totalReceived };
        }

        // Not expired — check for new or updated payments
        if (totalReceived > 0 && totalReceived !== alreadyRecorded) {
            if (totalReceived >= amountExpected) {
                let finalStatus = totalReceived > amountExpected ? 'overpaid' : 'completed';

                let forwardHash: string | null = null;
                let forwardStatus: string = 'pending';

                const payoutWallet = getPayoutWallet(tx);
                if (!payoutWallet) {
                    console.error(`[PROCESSOR] No payout_wallet for project ${tx.project_id}, tx ${tx.id}. Funds remain in pool wallet.`);
                    finalStatus = 'anomaly';
                    forwardStatus = 'failed';
                } else {
                    try {
                        forwardHash = await forwardFromPool(tx.wallet_pubkey, payoutWallet, totalReceived.toFixed(7));
                        forwardStatus = 'completed';
                    } catch (e: any) {
                        console.error(`[PROCESSOR] Forward to merchant failed for tx ${tx.id}:`, e.message);
                        finalStatus = 'anomaly';
                        forwardStatus = 'failed';
                    }
                }

                await supabase.from('transactions')
                    .update({
                        status: finalStatus,
                        amount_paid: totalReceived,
                        ...(forwardHash && { forward_tx_hash: forwardHash }),
                        forward_status: forwardStatus,
                    })
                    .eq('id', tx.id);

                if (forwardStatus !== 'failed') {
                    await unlockWallet(tx.wallet_pubkey);
                } else {
                    console.warn(`[PROCESSOR] Wallet ${tx.wallet_pubkey.slice(0, 8)}... left locked with funds. Tx ${tx.id} requires manual retry via /api/admin/tx/${tx.id}/retry-forward`);
                }
                return { id: tx.id, status: finalStatus, received: totalReceived };
            }

            // Partial payment: update amount_paid, keep pending
            await supabase.from('transactions')
                .update({ amount_paid: totalReceived })
                .eq('id', tx.id);

            return { id: tx.id, status: 'partial', received: totalReceived, expected: amountExpected };
        }

        return { id: tx.id, status: 'waiting' };
    } finally {
        // Liberar lease siempre, incluso si hay throw inesperado.
        // Si la tx ya no está pending (porque acabamos de marcarla completed/anomaly/etc),
        // el processing_started_at se setea a null igual — no afecta el status final.
        if (!opts.skipLock) {
            await releaseProcessing(tx.id);
        }
    }
}

/**
 * Reintento manual del forward para una tx que quedó con forward_status='failed'.
 * La wallet del pool sigue lockeada con los fondos adentro. Si el reintento pasa,
 * se libera la wallet y se marca la tx como completed/overpaid según corresponda.
 */
export async function retryForward(txId: string): Promise<ProcessResult> {
    const { data: tx, error } = await supabase
        .from('transactions')
        .select('id, wallet_pubkey, amount_expected, amount_paid, expires_at, created_at, project_id, status, forward_status, projects!project_id(payout_wallet)')
        .eq('id', txId)
        .single();

    if (error || !tx) {
        return { id: txId, status: 'not_found', error: error?.message };
    }
    if (tx.forward_status !== 'failed') {
        return { id: txId, status: 'not_failed', error: `forward_status is ${tx.forward_status}, expected 'failed'` };
    }
    if (!tx.wallet_pubkey) {
        return { id: txId, status: 'no_wallet', error: 'tx has no wallet_pubkey' };
    }

    const payoutWallet = getPayoutWallet(tx as unknown as PendingTx);
    if (!payoutWallet) {
        return { id: txId, status: 'no_payout', error: 'project has no payout_wallet' };
    }

    const totalPaid = parseFloat(String(tx.amount_paid || '0'));
    if (totalPaid <= 0) {
        return { id: txId, status: 'no_funds', error: 'amount_paid is 0' };
    }

    try {
        const hash = await forwardFromPool(tx.wallet_pubkey, payoutWallet, totalPaid.toFixed(7));
        const amountExpected = parseFloat(String(tx.amount_expected));
        const newStatus = totalPaid > amountExpected ? 'overpaid' : 'completed';

        await supabase.from('transactions')
            .update({
                status: newStatus,
                forward_tx_hash: hash,
                forward_status: 'completed',
            })
            .eq('id', txId);

        await unlockWallet(tx.wallet_pubkey);
        return { id: txId, status: newStatus, received: totalPaid };
    } catch (e: any) {
        return { id: txId, status: 'retry_failed', error: e.message };
    }
}

/**
 * Processes all pending transactions in parallel batches.
 * Batch size is controlled by PROCESSOR_CONCURRENCY (default: 10).
 * Each batch checks Horizon concurrently, then waits before starting the next batch.
 * This keeps Horizon request volume predictable as the pool grows to 1000+ wallets.
 */
export async function processPendingPayments(): Promise<{ processed: number; results: ProcessResult[] }> {
    const { data: pendingTxs, error } = await supabase
        .from('transactions')
        .select('id, wallet_pubkey, amount_expected, amount_paid, expires_at, created_at, project_id, projects!project_id(payout_wallet)')
        .eq('status', 'pending');

    if (error) throw error;
    if (!pendingTxs || pendingTxs.length === 0) return { processed: 0, results: [] };

    const now = new Date();
    const txList = pendingTxs as PendingTx[];
    const allResults: ProcessResult[] = [];

    // Process in concurrent batches to avoid hammering Horizon with 1000+ simultaneous requests
    for (let i = 0; i < txList.length; i += CONCURRENCY) {
        const batch = txList.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.allSettled(
            batch.map(tx => processSingleTransaction(tx, now))
        );

        for (const result of batchResults) {
            if (result.status === 'fulfilled') {
                allResults.push(result.value);
            } else {
                console.error('[PROCESSOR] Unhandled error in batch:', result.reason?.message);
                allResults.push({ id: 'unknown', status: 'error', error: result.reason?.message });
            }
        }
    }

    return { processed: txList.length, results: allResults };
}
