// ─── Billing helpers ────────────────────────────────────────────────────────
// Lógica para cobro de planes Pollar Pay (PDF pág. 8 — Scale: $25/mes).
//
// Reutilizamos 100% el motor de cobros (claim_wallet, processor, worker).
// La única diferencia con un cobro normal es que el "proyecto" detrás es
// uno especial de Pollar (system project) cuya payout_wallet apunta a
// la wallet de plataforma — no a la del comercio.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from '@/lib/supabase';
import { TIERS, type Tier } from '@/lib/tiers';

/** Wallet destino de los cobros de planes — env var, cae a null si no está. */
export const BILLING_WALLET = process.env.POLLAR_BILLING_WALLET || null;

/** Nombre del system project en la DB (lo identificamos por este nombre fijo). */
export const BILLING_PROJECT_NAME = '__pollar_billing__';

/**
 * Precio único de upgrade a un tier (USDC). Por ahora cobramos solo Scale
 * ($25). Starter y Growth se activan sin cobro (PDF: "sin cuota mensual").
 * Free se puede activar sin pago (downgrade).
 */
export function priceForTier(tier: Tier): number {
    if (tier === 'scale') return TIERS.scale.monthlyFee; // $25
    return 0; // free/starter/growth → activación gratuita
}

/**
 * Busca el system project de billing. Devuelve null si todavía no se setupeó —
 * el endpoint /api/admin/billing/setup lo crea idempotente.
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
