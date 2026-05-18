// Endpoint PÚBLICO del Hosted Checkout — devuelve info de una transaction
// solo con su ID (UUID no enumerable). Lo consume /checkout/[id] en pollar-web.
//
// La diferencia con /api/sdk/status es que NO requiere api_key. Esto es seguro
// porque:
//   - El UUID de la tx es random; nadie puede adivinarlo
//   - La info devuelta es para el CLIENTE que paga (monto, wallet, status),
//     no para el comercio que ya tiene su api_key
//   - No expone project_id ni nada sensible del merchant
//
// Cada GET dispara processSingleTransaction si la tx está pending → así el
// botón "Verificar pago" funciona sin necesidad de cron.

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { processSingleTransaction, type PendingTx } from '@/lib/payments/processor';

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const { id } = await params;

        const initial = await supabase
            .from('transactions')
            .select('id, status, reason, amount_expected, amount_paid, asset_code, wallet_pubkey, expires_at, created_at, forward_status, forward_tx_hash, project_id, projects!project_id(name, payout_wallet)')
            .eq('id', id)
            .single();

        if (initial.error || !initial.data) {
            return NextResponse.json({ error: 'Cobro no encontrado' }, { status: 404 });
        }

        let tx = initial.data;

        // Auto-proceso si está pending → así un poll del checkout o un click
        // en "Verificar pago" alcanza para que el sistema confirme.
        if (tx.status === 'pending' && tx.wallet_pubkey) {
            try {
                await processSingleTransaction(tx as unknown as PendingTx, new Date());
                const refetch = await supabase
                    .from('transactions')
                    .select('id, status, reason, amount_expected, amount_paid, asset_code, wallet_pubkey, expires_at, created_at, forward_status, forward_tx_hash, project_id, projects!project_id(name, payout_wallet)')
                    .eq('id', id)
                    .single();
                if (refetch.data) tx = refetch.data;
            } catch (e: any) {
                console.error('[CHECKOUT] auto-process failed:', e?.message);
            }
        }

        type ProjectInfo = { name: string; payout_wallet: string } | { name: string; payout_wallet: string }[] | null;
        const p = tx.projects as ProjectInfo;
        const merchantName = Array.isArray(p) ? p[0]?.name ?? '' : p?.name ?? '';

        const amountExpected = parseFloat(tx.amount_expected);
        const amountPaid = parseFloat(tx.amount_paid || '0');
        const remaining = Math.max(0, amountExpected - amountPaid);

        const expiresAt = new Date(tx.expires_at);
        const now = new Date();
        const timeRemainingMs = expiresAt.getTime() - now.getTime();
        const timeRemainingSeconds = Math.max(0, Math.floor(timeRemainingMs / 1000));
        const isExpired = timeRemainingMs <= 0;

        return NextResponse.json({
            success: true,
            data: {
                transaction_id: tx.id,
                merchant_name: merchantName,
                status: tx.status,
                reason: tx.reason,
                amount_expected: tx.amount_expected,
                amount_paid: tx.amount_paid,
                remaining: remaining.toFixed(2),
                asset: tx.asset_code,
                wallet_address: tx.wallet_pubkey,
                expires_at: tx.expires_at,
                time_remaining_seconds: timeRemainingSeconds,
                is_expired: isExpired,
                created_at: tx.created_at,
                forward_status: tx.forward_status,
                ...(tx.forward_tx_hash && { forward_tx_hash: tx.forward_tx_hash }),
            },
        });
    } catch (err: any) {
        console.error('Checkout endpoint error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
