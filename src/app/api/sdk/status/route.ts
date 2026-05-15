import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { SUPPORT_CONTACT } from '@/lib/admin-auth';
import { authenticateRequest } from '@/lib/pollar-auth';
import { processSingleTransaction, type PendingTx } from '@/lib/payments/processor';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const transactionId = searchParams.get('transaction_id');
        const apiKey = searchParams.get('api_key'); // legacy support

        if (!transactionId) {
            return NextResponse.json(
                { error: 'Missing required query param: transaction_id' },
                { status: 400 }
            );
        }

        // Authenticate: supports x-pollar-api-key header (new) or api_key query param (legacy)
        const auth = await authenticateRequest(request, undefined, apiKey ?? undefined);
        if (!auth) {
            return NextResponse.json({ error: 'Invalid API Key' }, { status: 401 });
        }

        // Fetch the transaction (must belong to this project).
        // Incluye projects!project_id(payout_wallet) por si hay que reenviar fondos.
        const txQuery = await supabase
            .from('transactions')
            .select('id, status, reason, amount_expected, amount_paid, fee_amount, payout_amount, is_free_tx, asset_code, expires_at, created_at, wallet_pubkey, forward_status, forward_tx_hash, project_id, projects!project_id(payout_wallet)')
            .eq('id', transactionId)
            .eq('project_id', auth.projectId)
            .single();

        let tx = txQuery.data;
        if (txQuery.error || !tx) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }

        // Auto-procesa la tx si todavía está pending: consulta Horizon, detecta el pago,
        // reenvía al payout_wallet del merchant y actualiza el estado. Así no hace falta
        // un cron — cada poll del SDK dispara la verificación de esa tx específica.
        if (tx.status === 'pending' && tx.wallet_pubkey) {
            try {
                await processSingleTransaction(tx as unknown as PendingTx, new Date());
                // Refetch para devolver el estado actualizado al cliente
                const refetched = await supabase
                    .from('transactions')
                    .select('id, status, reason, amount_expected, amount_paid, fee_amount, payout_amount, is_free_tx, asset_code, expires_at, created_at, wallet_pubkey, forward_status, forward_tx_hash, project_id, projects!project_id(payout_wallet)')
                    .eq('id', transactionId)
                    .eq('project_id', auth.projectId)
                    .single();
                if (refetched.data) tx = refetched.data;
            } catch (e: any) {
                console.error('[STATUS] auto-process failed for tx', tx.id, e?.message);
                // No fallamos la request — el cliente recibe el estado actual igual.
            }
        }

        // Calculate remaining amount and time
        const amountExpected = parseFloat(tx.amount_expected);
        const amountPaid = parseFloat(tx.amount_paid || '0');
        const remaining = Math.max(0, amountExpected - amountPaid);

        const expiresAt = new Date(tx.expires_at);
        const now = new Date();
        const timeRemainingMs = expiresAt.getTime() - now.getTime();
        const timeRemainingSeconds = Math.max(0, Math.floor(timeRemainingMs / 1000));
        const isExpired = timeRemainingMs <= 0;

        // Include support info for anomalies
        const needsSupport = ['overpaid', 'underpaid', 'anomaly', 'late_anomaly'].includes(tx.status);
        const excess = amountPaid > amountExpected ? (amountPaid - amountExpected).toFixed(2) : null;

        return NextResponse.json({
            success: true,
            data: {
                transaction_id: tx.id,
                status: tx.status,
                reason: tx.reason,
                amount_expected: tx.amount_expected,
                amount_paid: tx.amount_paid,
                fee_amount: tx.fee_amount,
                payout_amount: tx.payout_amount,
                is_free_tx: tx.is_free_tx,
                remaining: remaining.toFixed(2),
                asset: tx.asset_code,
                wallet_address: tx.wallet_pubkey,
                expires_at: tx.expires_at,
                time_remaining_seconds: timeRemainingSeconds,
                is_expired: isExpired,
                created_at: tx.created_at,
                forward_status: tx.forward_status,
                ...(tx.forward_tx_hash && { forward_tx_hash: tx.forward_tx_hash }),
                // Support info — only included when there's an anomaly
                ...(needsSupport && {
                    support: {
                        contact: SUPPORT_CONTACT.phone,
                        message: tx.status === 'overpaid'
                            ? `Payment completed with excess of ${excess} USDC. ${SUPPORT_CONTACT.message}`
                            : SUPPORT_CONTACT.message
                    }
                })
            }
        });

    } catch (err: any) {
        console.error("Status Check Error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

