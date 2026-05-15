// Aplicar el fee de tier al momento de hacer el forward. Esta capa concentra
// las consultas a profiles + el contador de transacciones gratuitas para que
// el processor no se llene de queries auxiliares.

import { supabase } from '@/lib/supabase';
import { splitPayment, isTier, type Tier } from '@/lib/tiers';

export interface FeeContext {
    tier: Tier;
    /** true si esta tx debe entrar como gratuita (Free + cupo < 50) */
    isFreeTx: boolean;
    fee: number;
    payout: number;
}

/**
 * Resuelve el merchant + tier desde el projectId y calcula el split fee/payout.
 *
 * Para las 50 gratis: contamos cuántas tx del merchant tienen `is_free_tx = true`
 * y, si ese contador < 50 AND tier = 'free', esta tx también es gratis. El check
 * se hace por merchant (no por sucursal): el cupo es del comercio, no por proyecto.
 */
export async function resolveFeeContext(
    projectId: string,
    grossAmount: number,
): Promise<FeeContext> {
    const { data: project, error: pErr } = await supabase
        .from('projects')
        .select('merchant_id, profiles!merchant_id(tier)')
        .eq('id', projectId)
        .single();

    if (pErr || !project) {
        // No deberíamos llegar acá, pero si pasa: default seguro = free, sin gratis.
        console.warn(`[FEES] No project/profile found for ${projectId}, defaulting to free`);
        const fallback = splitPayment({ grossAmount, tier: 'free', isFreeTx: false });
        return { tier: 'free', isFreeTx: false, ...fallback };
    }

    const profileObj = project.profiles as { tier?: string } | { tier?: string }[] | null;
    const rawTier = Array.isArray(profileObj) ? profileObj[0]?.tier : profileObj?.tier;
    const tier: Tier = isTier(rawTier) ? rawTier : 'free';

    let isFreeTx = false;
    if (tier === 'free') {
        const { data: merchantProjects } = await supabase
            .from('projects')
            .select('id')
            .eq('merchant_id', project.merchant_id);
        const projectIds = merchantProjects?.map(p => p.id) ?? [];
        if (projectIds.length > 0) {
            const { count } = await supabase
                .from('transactions')
                .select('id', { count: 'exact', head: true })
                .eq('is_free_tx', true)
                .in('project_id', projectIds);
            isFreeTx = (count ?? 0) < 50;
        } else {
            isFreeTx = true;
        }
    }

    const { fee, payout } = splitPayment({ grossAmount, tier, isFreeTx });
    return { tier, isFreeTx, fee, payout };
}

/**
 * Conveniencia: aplica el fee al payload de UPDATE de la tx después de un forward
 * exitoso. Solo agrega los campos relacionados a fee — el caller mantiene status,
 * forward_tx_hash, etc.
 */
export function feeUpdateFields(ctx: FeeContext): Record<string, unknown> {
    return {
        fee_amount: ctx.fee,
        payout_amount: ctx.payout,
        tier_at_time: ctx.tier,
        is_free_tx: ctx.isFreeTx,
    };
}
