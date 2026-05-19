import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';
import { processSingleTransaction, type PendingTx } from '@/lib/payments/processor';

// ─── GET /api/merchant/billing/status?id=<intent_id> ────────────────────────
// Polea el estado de un billing intent. Si la tx asociada quedó completed/
// overpaid y el billing intent sigue pending, activa el tier del merchant
// y marca el intent como 'activated' (atómico).
//
// Devuelve la forma similar a /api/sdk/status para que la UI lo trate igual:
//   { status: 'pending|completed|overpaid|expired|...',
//     amount_paid, time_remaining_seconds, is_expired,
//     activated: bool, target_tier, forward_tx_hash? }
// ─────────────────────────────────────────────────────────────────────────────

const COMPLETED_OK = new Set(['completed', 'overpaid']);

export async function GET(request: Request) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { searchParams } = new URL(request.url);
        const intentId = searchParams.get('id');
        if (!intentId) {
            return NextResponse.json({ error: 'Missing query param: id' }, { status: 400 });
        }

        const { data: intent, error: iErr } = await supabase
            .from('billing_intents')
            .select('id, merchant_id, transaction_id, target_tier, amount_usdc, status, activated_at, created_at')
            .eq('id', intentId)
            .single();

        if (iErr || !intent) {
            return NextResponse.json({ error: 'Intent not found' }, { status: 404 });
        }
        if (intent.merchant_id !== user.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        // Refrescar el estado de la tx — dispara on-chain check si sigue pending
        const { data: tx } = await supabase
            .from('transactions')
            .select('id, status, amount_expected, amount_paid, expires_at, created_at, wallet_pubkey, reason, project_id, forward_tx_hash, forward_status, projects!project_id(payout_wallet)')
            .eq('id', intent.transaction_id)
            .single();

        if (!tx) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }

        if (tx.status === 'pending' && tx.wallet_pubkey) {
            try {
                await processSingleTransaction(tx as unknown as PendingTx, new Date());
                // Refetch para devolver el estado fresh
                const refetch = await supabase
                    .from('transactions')
                    .select('id, status, amount_expected, amount_paid, expires_at, created_at, wallet_pubkey, forward_tx_hash, forward_status')
                    .eq('id', intent.transaction_id)
                    .single();
                if (refetch.data) Object.assign(tx, refetch.data);
            } catch (e: any) {
                console.warn('[BILLING STATUS] processSingleTransaction failed:', e?.message);
            }
        }

        // Si la tx llegó a estado bueno y el intent sigue pending → activar el tier
        let activated = intent.status === 'activated';
        let activatedNow = false;
        if (!activated && COMPLETED_OK.has(tx.status)) {
            const now = new Date();
            const nowIso = now.toISOString();

            // Para Scale ($25/mes recurring), extender scale_paid_until 30 días.
            // Si todavía hay tiempo paid (renovación temprana), partimos del
            // expiry actual para no perder los días no usados.
            const updateFields: Record<string, unknown> = {
                tier: intent.target_tier,
                tier_assigned_at: nowIso,
            };
            if (intent.target_tier === 'scale') {
                // Leer scale_paid_until actual para extender
                const { data: prof } = await supabase
                    .from('profiles')
                    .select('scale_paid_until')
                    .eq('id', user.id)
                    .single();
                const currentExpiryStr = prof?.scale_paid_until as string | null | undefined;
                const currentExpiry = currentExpiryStr ? new Date(currentExpiryStr) : null;
                const startFrom = currentExpiry && currentExpiry > now ? currentExpiry : now;
                const newExpiry = new Date(startFrom.getTime() + 30 * 24 * 60 * 60 * 1000);
                updateFields.scale_paid_until = newExpiry.toISOString();
            }

            const { error: profErr } = await supabase
                .from('profiles')
                .update(updateFields)
                .eq('id', user.id);
            if (profErr) throw profErr;

            const { error: intErr } = await supabase
                .from('billing_intents')
                .update({ status: 'activated', activated_at: nowIso })
                .eq('id', intent.id);
            if (intErr) console.error('billing_intent update error:', intErr.message);

            activated = true;
            activatedNow = true;
        }

        const expiresAt = new Date(tx.expires_at);
        const now = new Date();
        const timeRemainingMs = expiresAt.getTime() - now.getTime();
        const timeRemainingSeconds = Math.max(0, Math.floor(timeRemainingMs / 1000));
        const isExpired = timeRemainingMs <= 0;

        return NextResponse.json({
            success: true,
            data: {
                intent_id: intent.id,
                target_tier: intent.target_tier,
                status: tx.status,
                amount_expected: String(intent.amount_usdc),
                amount_paid: tx.amount_paid,
                wallet_address: tx.wallet_pubkey,
                expires_at: tx.expires_at,
                time_remaining_seconds: timeRemainingSeconds,
                is_expired: isExpired,
                forward_tx_hash: tx.forward_tx_hash ?? null,
                forward_status: tx.forward_status ?? null,
                activated,
                activated_now: activatedNow,
            },
        });
    } catch (err: any) {
        console.error('Billing status error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
