import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { authenticateRequest } from '@/lib/pollar-auth';
import { getUsdcReceivedSince } from '@/lib/stellar/horizon';
import { forwardFromPool } from '@/lib/stellar/transactions';
import { resolveFeeContext, feeUpdateFields, type FeeContext } from '@/lib/payments/fees';
import { dispatchEvent, buildPaymentEventPayload } from '@/lib/webhooks/dispatch';

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
            .select('id, wallet_pubkey, status, reason, amount_expected, created_at, project_id, projects!project_id(payout_wallet)')
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
        let feeCtx: FeeContext | null = null;

        // Si hubo pago crypto, mirar cuánto se recibió para reenviarlo.
        // El fee se calcula sobre lo esperado (no sobre el bruto) — el excedente
        // de un overpaid va al treasury en una op separada, igual que en el
        // processor automático. Sin esto, en manual-complete con overpaid el
        // merchant se quedaba con el excedente y el fee se inflaba.
        const amountExpected = parseFloat(String(tx.amount_expected));
        let excessForwarded = 0;

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
                        const baseForFee = Math.min(amountForwarded, amountExpected);
                        excessForwarded = Math.max(0, amountForwarded - amountExpected);
                        feeCtx = await resolveFeeContext(tx.project_id, baseForFee);
                        const result = await forwardFromPool(
                            tx.wallet_pubkey,
                            payoutWallet,
                            amountForwarded.toFixed(7),
                            feeCtx.fee.toFixed(7),
                            excessForwarded.toFixed(7),
                        );
                        forwardHash = result.hash;
                        forwardStatus = 'completed';
                    } catch (e: any) {
                        console.error(`[MANUAL] Forward failed for ${tx.id}:`, e.message);
                        forwardStatus = 'failed';
                    }
                }
            }
        }

        // Si hubo excedente y el forward salió bien, marcamos overpaid para que
        // la métrica refleje que el cliente pagó de más. Si no hubo pago crypto
        // (clásico cierre por efectivo) marcamos completed sin más.
        const finalStatus =
            forwardStatus === 'completed' && excessForwarded > 0 ? 'overpaid' : 'completed';

        const updates: Record<string, unknown> = {
            status: finalStatus,
            forward_status: forwardStatus,
        };
        if (amountForwarded > 0) updates.amount_paid = amountForwarded;
        if (forwardHash) updates.forward_tx_hash = forwardHash;
        if (feeCtx && forwardStatus === 'completed') Object.assign(updates, feeUpdateFields(feeCtx));

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

        // Webhook — el manual-complete cierra la tx; los integradores deberían
        // enterarse igual que en el flujo on-chain. Si hubo excedente lo
        // notificamos como overpaid para que el comercio pueda accionar.
        try {
            const event = finalStatus === 'overpaid' ? 'payment.overpaid' : 'payment.completed';
            await dispatchEvent({
                projectId: tx.project_id,
                transactionId: tx.id,
                event,
                payload: buildPaymentEventPayload({
                    event,
                    projectId: tx.project_id,
                    transaction: {
                        id: tx.id,
                        status: finalStatus,
                        reason: tx.reason,
                        amount_expected: tx.amount_expected,
                        amount_paid: amountForwarded,
                        fee_amount: feeCtx?.fee,
                        payout_amount: feeCtx?.payout,
                        wallet_pubkey: tx.wallet_pubkey,
                        forward_tx_hash: forwardHash,
                        created_at: tx.created_at,
                    },
                }),
            });
        } catch (e: any) {
            console.error('[WEBHOOKS] manual-complete dispatch failed', e?.message);
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
