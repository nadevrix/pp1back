// ─── POST /api/admin/billing/setup ──────────────────────────────────────────
// Endpoint manual para crear (o actualizar) el billing project.
//
// Normalmente NO HACE FALTA llamarlo — billing/upgrade lo auto-crea la
// primera vez que un merchant intenta pagar Scale. Este endpoint queda
// como entry point manual por si querés:
//   - Cambiar el payout_wallet del billing project (pasar `payout_wallet`
//     en el body)
//   - Forzar el bootstrap sin esperar al primer Scale
//
// Body opcional:
//   { payout_wallet?: string }   override la wallet (sino usa treasury)
//
// Devuelve: { project_id, api_key, payout_wallet, network }
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { StrKey } from '@stellar/stellar-sdk';
import { supabase } from '@/lib/supabase';
import { validateAdminAuth } from '@/lib/admin-auth';
import { ensureBillingProject, getBillingProject } from '@/lib/billing';

const STELLAR_NETWORK = (process.env.STELLAR_NETWORK || 'TESTNET').toLowerCase() === 'mainnet'
    ? 'mainnet'
    : 'testnet';

export async function POST(request: Request) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    try {
        const body = await request.json().catch(() => ({}));
        const walletOverride = typeof body.payout_wallet === 'string' && body.payout_wallet.trim()
            ? body.payout_wallet.trim()
            : null;

        if (walletOverride && !StrKey.isValidEd25519PublicKey(walletOverride)) {
            return NextResponse.json(
                { error: 'payout_wallet inválida (debe ser una pubkey Stellar G...)' },
                { status: 400 },
            );
        }

        // Si el billing project ya existe y el caller pasó un nuevo payout_wallet,
        // actualizamos esa wallet. Sino reusamos.
        const existing = await getBillingProject();
        if (existing) {
            if (walletOverride && existing.payout_wallet !== walletOverride) {
                const { data: updated, error: uErr } = await supabase
                    .from('projects')
                    .update({ payout_wallet: walletOverride })
                    .eq('id', existing.id)
                    .select('id, api_key, payout_wallet')
                    .single();
                if (uErr) throw uErr;
                return NextResponse.json({
                    success: true,
                    message: 'Billing project actualizado',
                    project_id: updated.id,
                    api_key: updated.api_key,
                    payout_wallet: updated.payout_wallet,
                    network: STELLAR_NETWORK,
                });
            }
            return NextResponse.json({
                success: true,
                message: 'Billing project ya existía',
                project_id: existing.id,
                api_key: existing.api_key,
                payout_wallet: existing.payout_wallet,
                network: STELLAR_NETWORK,
            });
        }

        // No existe — bootstrap completo (idempotente).
        // Si pasaron payout_wallet override, lo seteamos en env effectivo
        // vía el helper (no podemos mutar process.env post-bootstrap, así
        // que si querés override lo manejamos via UPDATE post-create).
        const created = await ensureBillingProject();
        if (walletOverride && created.payout_wallet !== walletOverride) {
            const { data: updated, error: uErr } = await supabase
                .from('projects')
                .update({ payout_wallet: walletOverride })
                .eq('id', created.id)
                .select('id, api_key, payout_wallet')
                .single();
            if (uErr) throw uErr;
            return NextResponse.json({
                success: true,
                message: 'Billing project creado con override',
                project_id: updated.id,
                api_key: updated.api_key,
                payout_wallet: updated.payout_wallet,
                network: STELLAR_NETWORK,
            });
        }
        return NextResponse.json({
            success: true,
            message: 'Billing project creado',
            project_id: created.id,
            api_key: created.api_key,
            payout_wallet: created.payout_wallet,
            network: STELLAR_NETWORK,
        });
    } catch (err: any) {
        console.error('Billing setup error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
