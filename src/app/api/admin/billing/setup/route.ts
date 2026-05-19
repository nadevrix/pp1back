import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import { supabase } from '@/lib/supabase';
import { validateAdminAuth } from '@/lib/admin-auth';
import { BILLING_PROJECT_NAME, BILLING_WALLET, getBillingProject } from '@/lib/billing';

const STELLAR_NETWORK = (process.env.STELLAR_NETWORK || 'TESTNET').toLowerCase() === 'mainnet'
    ? 'mainnet'
    : 'testnet';

// Email del system profile que es dueño del billing project.
// .internal es un TLD reservado por IANA — nunca va a chocar con un email real.
const SYSTEM_PROFILE_EMAIL = 'billing-system@pollar.internal';

/**
 * Devuelve el ID del profile dueño del billing project. Si no existe (primer
 * setup en este Supabase), crea uno self-contenido:
 *   1) Crea un auth.user vía admin API con password random (no se loguea nunca)
 *   2) El trigger handle_new_user inserta su profile
 *   3) Actualiza el profile a role='admin' y devuelve su id
 *
 * Idempotente: si el system profile ya existe, lo reusa.
 */
async function ensureSystemOwnerId(): Promise<string> {
    // 1. ¿Ya existe el system profile?
    const { data: existing } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', SYSTEM_PROFILE_EMAIL)
        .maybeSingle();
    if (existing?.id) return existing.id;

    // 2. ¿Hay otro admin "legacy" (de antes de este código)?
    const { data: legacyAdmin } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'admin')
        .limit(1)
        .maybeSingle();
    if (legacyAdmin?.id) return legacyAdmin.id;

    // 3. No existe ninguno — bootstrap. Crear auth user + promoverlo a admin.
    const randomPassword = randomBytes(32).toString('hex');
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email: SYSTEM_PROFILE_EMAIL,
        password: randomPassword,
        email_confirm: true, // sin email de confirmación — internal user
        user_metadata: { is_system: true, purpose: 'billing_owner' },
    });
    if (createErr || !created?.user) {
        throw new Error(`No se pudo crear el system user: ${createErr?.message ?? 'unknown'}`);
    }
    const systemUserId = created.user.id;

    // El trigger handle_new_user ya insertó el profile. Lo promovemos a admin.
    const { error: updErr } = await supabase
        .from('profiles')
        .update({ role: 'admin' })
        .eq('id', systemUserId);
    if (updErr) {
        throw new Error(`No se pudo promover el system profile: ${updErr.message}`);
    }

    return systemUserId;
}

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

        // No existe — bootstrappear system owner (idempotente).
        const ownerId = await ensureSystemOwnerId();

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
                merchant_id: ownerId,
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
