import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { authenticateRequest } from '@/lib/pollar-auth';
import { getUsdcReceivedSince } from '@/lib/stellar/horizon';
import { forwardFromPool } from '@/lib/stellar/transactions';

const FINAL_STATES = ['completed', 'overpaid', 'expired', 'refunded', 'anomaly', 'late_anomaly'];

export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const { transaction_id, api_key } = body as { transaction_id?: string; api_key?: string };

        if (!transaction_id) {
            return NextResponse.json({ error: 'Missing transaction_id' }, { status: 400 });
        }

        const auth = await authenticateRequest(request, api_key);
        if (!auth) {
            return NextResponse.json({ error: 'Invalid API Key' }, { status: 401 });
        }

        const { data: tx, error: tErr } = await supabase
            .from('transactions')
            .select('id, wallet_pubkey, status, created_at, project_id, projects!project_id(payout_wallet)')
            .eq('id', transaction_id)
            .eq('project_id', auth.projectId)
            .single();

        if (tErr || !tx) {
            return NextResponse.json({ error: 'Transaction not found or unauthorized' }, { status: 404 });
        }

        if (FINAL_STATES.includes(tx.status)) {
            return NextResponse.json({ error: 'Transaction is already in a final state' }, { status: 400 });
        }

        // Si hubo pago crypto antes del manual-complete, reenviarlo al merchant
        // antes de cerrar la tx. Sin esto, los fondos quedarían huérfanos en
        // la wallet del pool.
        let forwardHash: string | null = null;
        let forwardStatus: 'completed' | 'failed' | 'skipped' = 'skipped';
        let amountForwarded = 0;

        if (tx.wallet_pubkey) {
            try {
                amountForwarded = await getUsdcReceivedSince(tx.wallet_pubkey, tx.created_at);
            } catch (e: any) {
                console.warn(`[MANUAL] Could not check on-chain balance for ${tx.id}:`, e.message);
            }

            if (amountForwarded > 0) {
                const projects = tx.projects as
                    | { payout_wallet: string }
                    | { payout_wallet: string }[]
                    | null;
                const payoutWallet = Array.isArray(projects)
                    ? projects[0]?.payout_wallet
                    : projects?.payout_wallet;

                if (!payoutWallet) {
                    console.error(`[MANUAL] No payout_wallet for project ${tx.project_id}`);
                    forwardStatus = 'failed';
                } else {
                    try {
                        forwardHash = await forwardFromPool(
                            tx.wallet_pubkey,
                            payoutWallet,
                            amountForwarded.toFixed(7),
                        );
                        forwardStatus = 'completed';
                    } catch (e: any) {
                        console.error(`[MANUAL] Forward failed for ${tx.id}:`, e.message);
                        forwardStatus = 'failed';
                    }
                }
            }
        }

        const updates: Record<string, unknown> = {
            status: 'completed',
            forward_status: forwardStatus,
        };
        if (amountForwarded > 0) updates.amount_paid = amountForwarded;
        if (forwardHash) updates.forward_tx_hash = forwardHash;

        const { error: updateError } = await supabase
            .from('transactions')
            .update(updates)
            .eq('id', transaction_id);

        if (updateError) throw updateError;

        // Liberar la wallet del pool
        if (tx.wallet_pubkey) {
            await supabase
                .from('wallets')
                .update({ is_locked: false, locked_until: null })
                .eq('public_key', tx.wallet_pubkey);
        }

        return NextResponse.json({
            success: true,
            message: 'Transaction manually completed',
            forwarded_amount: amountForwarded > 0 ? amountForwarded.toFixed(7) : null,
            forward_status: forwardStatus,
            forward_tx_hash: forwardHash,
        });
    } catch (err: any) {
        console.error('Manual Complete SDK Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
