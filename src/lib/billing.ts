// ─── Billing helpers ────────────────────────────────────────────────────────
// Lógica para cobro de planes Pollar Pay (Scale: $25/mes).
//
// Reutilizamos 100% el motor de cobros (claim_wallet, processor, worker).
// La única diferencia con un cobro normal es que el "proyecto" detrás es
// uno especial de Pollar (system project) cuya payout_wallet apunta a
// la wallet de plataforma — no a la del comercio.
//
// El system project + su owner se auto-bootstrappean en el primer pago
// de Scale. No hace falta correr ningún seed ni endpoint admin manual.
// ─────────────────────────────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto';
import { supabase } from '@/lib/supabase';
import { TIERS, type Tier } from '@/lib/tiers';

/** Wallet destino opcional para los cobros de planes (override). Si no se
 *  setea, usamos la treasury automáticamente. */
export const BILLING_WALLET = process.env.POLLAR_BILLING_WALLET || null;

/** Nombre del system project en la DB (lo identificamos por este nombre fijo). */
export const BILLING_PROJECT_NAME = '__pollar_billing__';

/** Email del system profile que es dueño del billing project.
 *  .internal es TLD reservado por IANA — nunca va a chocar con un email real. */
export const SYSTEM_PROFILE_EMAIL = 'billing-system@pollar.internal';

const STELLAR_NETWORK = (process.env.STELLAR_NETWORK || 'TESTNET').toLowerCase() === 'mainnet'
    ? 'mainnet'
    : 'testnet';

/**
 * Precio único de upgrade a un tier (USDC). Por ahora cobramos solo Scale
 * ($25). Starter y Growth se activan sin cobro.
 */
export function priceForTier(tier: Tier): number {
    if (tier === 'scale') return TIERS.scale.monthlyFee; // $25
    return 0;
}

/**
 * Busca el system project de billing. Devuelve null si todavía no se setupeó.
 */
export async function getBillingProject(): Promise<{
    id: string;
    api_key: string;
    payout_wallet: string;
} | null> {
    const { data, error } = await supabase
        .from('projects')
        .select('id, api_key, payout_wallet')
        .eq('name', BILLING_PROJECT_NAME)
        .maybeSingle();
    if (error || !data) return null;
    return data;
}

/**
 * Devuelve el ID del profile dueño del billing project. Idempotente:
 *   1) Reusa profile con SYSTEM_PROFILE_EMAIL si ya existe
 *   2) Reusa cualquier profile con role='admin' legacy
 *   3) Bootstrap: crea auth user con password random + promueve a admin
 */
export async function ensureSystemOwnerId(): Promise<string> {
    const { data: existing } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', SYSTEM_PROFILE_EMAIL)
        .maybeSingle();
    if (existing?.id) return existing.id;

    const { data: legacyAdmin } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'admin')
        .limit(1)
        .maybeSingle();
    if (legacyAdmin?.id) return legacyAdmin.id;

    // Bootstrap: crear auth user system via admin API
    const randomPassword = randomBytes(32).toString('hex');
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
        email: SYSTEM_PROFILE_EMAIL,
        password: randomPassword,
        email_confirm: true,
        user_metadata: { is_system: true, purpose: 'billing_owner' },
    });
    if (createErr || !created?.user) {
        throw new Error(`No se pudo crear el system user: ${createErr?.message ?? 'unknown'}`);
    }
    const systemUserId = created.user.id;

    const { error: updErr } = await supabase
        .from('profiles')
        .update({ role: 'admin' })
        .eq('id', systemUserId);
    if (updErr) {
        throw new Error(`No se pudo promover el system profile: ${updErr.message}`);
    }
    return systemUserId;
}

/**
 * Devuelve el billing project. Si no existe, lo crea junto con el system owner.
 * Idempotente — llamarlo N veces da el mismo project.
 *
 * Payout wallet: si POLLAR_BILLING_WALLET está seteado lo usa; sino agarra
 * la treasury automáticamente. Lanza si no hay ninguno disponible.
 */
export async function ensureBillingProject(): Promise<{
    id: string;
    api_key: string;
    payout_wallet: string;
}> {
    const existing = await getBillingProject();
    if (existing) return existing;

    // Resolver payout wallet — preferimos override env, sino treasury.
    let payoutWallet = BILLING_WALLET;
    if (!payoutWallet) {
        const { data: treasury } = await supabase
            .from('wallets')
            .select('public_key')
            .eq('wallet_type', 'treasury')
            .maybeSingle();
        if (!treasury?.public_key) {
            throw new Error(
                'No hay treasury wallet ni POLLAR_BILLING_WALLET. Aplicá database/seeds/pollar-pay-treasury.sql.',
            );
        }
        payoutWallet = treasury.public_key;
    }

    const ownerId = await ensureSystemOwnerId();

    // generate_api_key es un RPC del schema; le pasamos la red
    const { data: keyResult, error: keyErr } = await supabase
        .rpc('generate_api_key', { p_network: STELLAR_NETWORK });
    if (keyErr || !keyResult) {
        throw new Error(`No se pudo generar la api_key del billing project: ${keyErr?.message ?? 'unknown'}`);
    }

    const { data: created, error: insErr } = await supabase
        .from('projects')
        .insert({
            merchant_id: ownerId,
            name: BILLING_PROJECT_NAME,
            reason: 'Cobros internos de planes Pollar Pay',
            payout_wallet: payoutWallet,
            api_key: keyResult,
        })
        .select('id, api_key, payout_wallet')
        .single();

    if (insErr) {
        // Postgres error 23505 = unique_violation. Lo dispara nuestro
        // UNIQUE INDEX uniq_pollar_billing_project cuando 2 ensureBilling
        // corren concurrentes y la otra request ya creó la fila.
        // Refetch + return — no es un error real, es la condición esperada.
        const isUniqueViolation =
            (insErr as { code?: string }).code === '23505' ||
            /duplicate key|unique constraint/i.test(insErr.message ?? '');
        if (isUniqueViolation) {
            const winner = await getBillingProject();
            if (winner) return winner;
        }
        throw new Error(`No se pudo crear el billing project: ${insErr.message}`);
    }
    if (!created) {
        throw new Error('No se pudo crear el billing project: respuesta vacía');
    }
    return created;
}
