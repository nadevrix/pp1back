import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';
import { isTier, type Tier } from '@/lib/tiers';
import { getBillingProject, priceForTier } from '@/lib/billing';

const STELLAR_NETWORK = process.env.STELLAR_NETWORK || 'TESTNET';

function getExpirationTimestamp() {
    const date = new Date();
    date.setMinutes(date.getMinutes() + 15);
    return date.toISOString();
}

// ─── POST /api/merchant/billing/upgrade ─────────────────────────────────────
// Crea un intent de pago para activar un tier pago.
//
// Body: { tier: 'starter' | 'growth' | 'scale' }
//
// Si el tier no tiene costo (starter / growth), activa inmediatamente y
// devuelve { activated: true }. Si tiene costo (scale), claim_wallet + crea
// transaction asociada al billing project + crea billing_intents row y
// devuelve { intent: { transaction_id, wallet_address, amount, expires_at } }
// para que la UI muestre el QR.
//
// El motor estándar (worker + processor) detecta el pago y reenvía a la
// billing wallet. La activación del tier se hace cuando el merchant
// (o la UI poleando) hace GET /api/merchant/billing/status?id=...
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json().catch(() => ({}));
        const target = body.tier as Tier;
        if (!isTier(target)) {
            return NextResponse.json(
                { error: 'tier inválido. Valores: free, starter, growth, scale' },
                { status: 400 },
            );
        }

        const price = priceForTier(target);

        // Tiers sin costo (free, starter, growth) → activación inmediata sin QR
        if (price <= 0) {
            const { error } = await supabase
                .from('profiles')
                .update({
                    tier: target,
                    tier_assigned_at: new Date().toISOString(),
                    // Si vino desde onboarding, también marcamos done.
                    onboarding_completed: true,
                })
                .eq('id', user.id);
            if (error) throw error;
            return NextResponse.json({
                success: true,
                activated: true,
                tier: target,
                amount_charged: 0,
            });
        }

        // Tier pago (Scale) → crear cobro QR
        const project = await getBillingProject();
        if (!project) {
            return NextResponse.json(
                {
                    error: 'Billing no configurado. Pediile al admin que corra POST /api/admin/billing/setup.',
                    code: 'BILLING_NOT_SETUP',
                },
                { status: 503 },
            );
        }

        const expiresAt = getExpirationTimestamp();

        // claim_wallet — round robin atómico (mismo RPC que /sdk/pay)
        const { data: assignedWallet, error: claimError } = await supabase.rpc('claim_wallet', {
            p_project_id: project.id,
            p_locked_until: expiresAt,
        });
        if (claimError || !assignedWallet) {
            return NextResponse.json(
                { error: 'Pool de wallets ocupado. Reintentá en 1 minuto.', code: 'NO_WALLETS_AVAILABLE' },
                { status: 503 },
            );
        }

        const reason = `Activación plan ${target.toUpperCase()} — merchant ${user.id.slice(0, 8)}`;

        const { data: tx, error: txErr } = await supabase
            .from('transactions')
            .insert({
                project_id: project.id,
                wallet_pubkey: assignedWallet,
                reason,
                amount_expected: price,
                asset_code: 'USDC',
                status: 'pending',
                expires_at: expiresAt,
            })
            .select('id, wallet_pubkey, amount_expected, expires_at, created_at')
            .single();
        if (txErr) {
            // Liberar la wallet si falla el insert
            await supabase
                .from('wallets')
                .update({ is_locked: false, locked_until: null })
                .eq('public_key', assignedWallet);
            throw txErr;
        }

        const { data: intent, error: biErr } = await supabase
            .from('billing_intents')
            .insert({
                merchant_id: user.id,
                transaction_id: tx.id,
                target_tier: target,
                amount_usdc: price,
                status: 'pending',
            })
            .select('id, target_tier, status, amount_usdc, created_at')
            .single();
        if (biErr) {
            console.error('billing_intent insert error:', biErr.message);
            // No abortamos — la tx ya existe. Lo loggeamos para investigar.
        }

        return NextResponse.json({
            success: true,
            activated: false,
            intent: {
                id: intent?.id,
                target_tier: target,
                amount: price.toFixed(2),
                transaction_id: tx.id,
                wallet_address: tx.wallet_pubkey,
                expires_at: tx.expires_at,
                network: STELLAR_NETWORK,
            },
        });
    } catch (err: any) {
        console.error('Billing upgrade error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
