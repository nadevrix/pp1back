import { supabase } from '@/lib/supabase';
import { getUsdcReceivedSince } from '@/lib/stellar/horizon';
import { forwardFromPool } from '@/lib/stellar/transactions';

// Controls how many wallets are checked against Horizon simultaneously.
// At 100 wallets the default of 10 is fine. Scale up for larger pools.
const CONCURRENCY = parseInt(process.env.PROCESSOR_CONCURRENCY || '10');

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

export async function processSingleTransaction(tx: PendingTx, now: Date): Promise<ProcessResult> {
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

        // FIX: Forward funds BEFORE updating status.
        // If forward fails, mark as 'anomaly' instead of the original finalStatus,
        // so funds are not reported as delivered when they weren't.
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

        await unlockWallet(tx.wallet_pubkey);
        return { id: tx.id, status: finalStatus, received: totalReceived };
    }

    // Not expired — check for new or updated payments
    if (totalReceived > 0 && totalReceived !== alreadyRecorded) {
        if (totalReceived >= amountExpected) {
            let finalStatus = totalReceived > amountExpected ? 'overpaid' : 'completed';

            // FIX: Forward funds BEFORE updating status.
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

            await unlockWallet(tx.wallet_pubkey);
            return { id: tx.id, status: finalStatus, received: totalReceived };
        }

        // Partial payment: update amount_paid, keep pending
        await supabase.from('transactions')
            .update({ amount_paid: totalReceived })
            .eq('id', tx.id);

        return { id: tx.id, status: 'partial', received: totalReceived, expected: amountExpected };
    }

    return { id: tx.id, status: 'waiting' };
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
