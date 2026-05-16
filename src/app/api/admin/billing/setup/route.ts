import { NextResponse } from 'next/server';
import { StrKey } from '@stellar/stellar-sdk';
import { supabase } from '@/lib/supabase';
import { validateAdminAuth } from '@/lib/admin-auth';
import { BILLING_PROJECT_NAME, BILLING_WALLET, getBillingProject } from '@/lib/billing';

const STELLAR_NETWORK = (process.env.STELLAR_NETWORK || 'TESTNET').toLowerCase() === 'mainnet'
    ? 'mainnet'
    : 'testnet';

// ─── POST /api/admin/billing/setup ──────────────────────────────────────────
// Idempotente. Crea (o reusa) el "system billing project" que recibe los
// cobros de planes pagos. El profile owner del project es el admin
// (cualquier user con role='admin' — el primero que encuentre).
//
// Body opcional:
//   { payout_wallet?: string }   override la wallet (sino usa POLLAR_BILLING_WALLET)
//
// Devuelve:
//   { project_id, api_key, payout_wallet, network }
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    try {
        const body = await request.json().catch(() => ({}));
        const walletOverride = typeof body.payout_wallet === 'string' && body.payout_wallet.trim()
            ? body.payout_wallet.trim()
            : null;

        const wallet = walletOverride ?? BILLING_WALLET;
        if (!wallet) {
            return NextResponse.json(
                { error: 'No billing wallet set. Pasá payout_wallet en el body o seteá POLLAR_BILLING_WALLET en env.' },
                { status: 400 },
            );
        }
        if (!StrKey.isValidEd25519PublicKey(wallet)) {
            return NextResponse.json(
                { error: 'payout_wallet inválida (debe ser una pubkey Stellar G...)' },
                { status: 400 },
            );
        }

        // ¿Ya existe?
        const existing = await getBillingProject();
        if (existing) {
            // Si la wallet cambió, la actualizamos
            if (existing.payout_wallet !== wallet) {
                const { data: updated, error: uErr } = await supabase
                    .from('projects')
                    .update({ payout_wallet: wallet })
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

        // No existe — buscar (o crear) un admin profile como owner.
        const { data: admins } = await supabase
            .from('profiles')
            .select('id')
            .eq('role', 'admin')
            .limit(1);
        let adminId = admins?.[0]?.id;
        if (!adminId) {
            return NextResponse.json(
                {
                    error: 'No hay ningún profile con role=admin. Promové uno desde el SQL editor: UPDATE profiles SET role=\'admin\' WHERE email LIKE \'%@pollar.local\' LIMIT 1;',
                },
                { status: 400 },
            );
        }

        // Generar api_key alineada con la network del backend
        const { data: keyResult, error: keyErr } = await supabase
            .rpc('generate_api_key', { p_network: STELLAR_NETWORK });
        if (keyErr || !keyResult) {
            console.error('billing-setup: gen api_key error', keyErr);
            return NextResponse.json({ error: 'No se pudo generar la api_key' }, { status: 500 });
        }

        const { data: created, error: insErr } = await supabase
            .from('projects')
            .insert({
                merchant_id: adminId,
                name: BILLING_PROJECT_NAME,
                reason: 'Cobros internos de planes Pollar Pay',
                payout_wallet: wallet,
                api_key: keyResult,
            })
            .select('id, api_key, payout_wallet')
            .single();
        if (insErr) throw insErr;

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
