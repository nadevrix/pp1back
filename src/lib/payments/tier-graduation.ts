// ─── Tier auto-graduation ───────────────────────────────────────────────────
// Lógica para subir / bajar el tier de un merchant según volumen mensual.
//
// SUBIR (promoteIfEligible): se llama inline desde el processor cuando una
// tx pasa a completed/overpaid. Es instantáneo — el cobro que cruza el
// umbral es el que dispara la promoción.
//
// BAJAR (rebalanceMerchant): se llama desde el cron tier-rebalance mensual.
// Recalcula el tier correcto basado en cobros últimos 30 días.
//
// Reglas:
//   - Free + ≥150 cobros → Starter (auto)
//   - Starter + ≥400      → Growth  (auto)
//   - Growth + ≥1000      → NO auto a Scale (Scale es pago, requiere QR)
//   - Scale → si scale_paid_until < NOW, baja al tier que justifique el volumen
//   - Tier inferior si volumen cayó debajo del mínimo del tier actual
//
// El conteo es de los últimos 30 días corridos (no calendar month) para evitar
// el efecto "día 1 todos parecen no tener cobros".
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from '@/lib/supabase';
import { TIERS, type Tier } from '@/lib/tiers';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Tiers que el sistema asigna automáticamente (sin requerir pago). */
const AUTO_ASSIGNABLE: readonly Tier[] = ['free', 'starter', 'growth'];

/**
 * Devuelve el tier automático que mejor encaja con `count` cobros en los
 * últimos 30 días. Nunca devuelve 'scale' (Scale es opt-in con pago).
 */
function tierForVolume(count: number): Tier {
    if (count >= TIERS.growth.monthlyVolumeMin) return 'growth';
    if (count >= TIERS.starter.monthlyVolumeMin) return 'starter';
    return 'free';
}

interface PromoteResult {
    promoted: boolean;
    fromTier?: Tier;
    toTier?: Tier;
    count?: number;
    reason?: string;
}

/** Cuenta cobros completados/overpaid del merchant en los últimos 30 días. */
async function countCompleted30d(merchantId: string): Promise<number> {
    const since = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();

    const { data: projects } = await supabase
        .from('projects')
        .select('id')
        .eq('merchant_id', merchantId);
    const projectIds = (projects ?? []).map(p => p.id);
    if (projectIds.length === 0) return 0;

    const { count, error } = await supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .in('project_id', projectIds)
        .in('status', ['completed', 'overpaid'])
        .gte('created_at', since);

    if (error) {
        console.error('[TIER] count30d failed:', error.message);
        return 0;
    }
    return count ?? 0;
}

async function getMerchantOfProject(projectId: string): Promise<string | null> {
    const { data } = await supabase
        .from('projects')
        .select('merchant_id')
        .eq('id', projectId)
        .single();
    return data?.merchant_id ?? null;
}

/**
 * Llamado inline desde el processor después de cerrar un cobro. Solo PROMUEVE
 * (Free→Starter o Starter→Growth). No baja ni toca Scale.
 *
 * No tira si falla — solo logguea. La promoción no es crítica para el flujo
 * del cobro; si se pierde un disparo, el cron mensual lo recupera.
 */
export async function promoteIfEligible(projectId: string): Promise<PromoteResult> {
    try {
        const merchantId = await getMerchantOfProject(projectId);
        if (!merchantId) return { promoted: false, reason: 'no_merchant' };

        const { data: profile } = await supabase
            .from('profiles')
            .select('tier')
            .eq('id', merchantId)
            .single();
        if (!profile) return { promoted: false, reason: 'no_profile' };

        const currentTier = profile.tier as Tier;

        // Solo Free y Starter son auto-promovibles inline. Growth ya no sube
        // (Scale es pago). Scale tampoco se toca acá.
        if (currentTier !== 'free' && currentTier !== 'starter') {
            return { promoted: false, fromTier: currentTier, reason: 'not_eligible' };
        }

        const count = await countCompleted30d(merchantId);
        const targetTier = tierForVolume(count);

        // Solo promovemos hacia arriba. Nunca bajamos desde acá.
        const order: Tier[] = ['free', 'starter', 'growth'];
        const currentIdx = order.indexOf(currentTier);
        const targetIdx = order.indexOf(targetTier);
        if (targetIdx <= currentIdx) {
            return { promoted: false, fromTier: currentTier, toTier: targetTier, count };
        }

        const { error } = await supabase
            .from('profiles')
            .update({ tier: targetTier, tier_assigned_at: new Date().toISOString() })
            .eq('id', merchantId);
        if (error) {
            console.error('[TIER] promote update failed:', error.message);
            return { promoted: false, reason: error.message };
        }

        console.log(`[TIER] Merchant ${merchantId.slice(0, 8)} promoted ${currentTier} → ${targetTier} (${count} cobros últimos 30d)`);
        return { promoted: true, fromTier: currentTier, toTier: targetTier, count };
    } catch (e: any) {
        console.error('[TIER] promoteIfEligible threw:', e.message);
        return { promoted: false, reason: e.message };
    }
}

interface RebalanceResult {
    merchantId: string;
    fromTier: Tier;
    toTier: Tier;
    count: number;
    changed: boolean;
    reason: string;
}

/**
 * Recalcula el tier correcto para un merchant. Usado por el cron mensual.
 *
 * Lógica:
 *   - Si tier='scale' y scale_paid_until > NOW: queda en Scale (no se toca).
 *   - Si tier='scale' y vencido: pasa al tier que justifique su volumen.
 *   - Para los demás: tier = tierForVolume(count). Puede subir o bajar.
 *
 * Es idempotente: correr múltiples veces da el mismo resultado.
 */
export async function rebalanceMerchant(merchantId: string): Promise<RebalanceResult> {
    const { data: profile, error: pErr } = await supabase
        .from('profiles')
        .select('tier, scale_paid_until')
        .eq('id', merchantId)
        .single();
    if (pErr || !profile) {
        return {
            merchantId,
            fromTier: 'free',
            toTier: 'free',
            count: 0,
            changed: false,
            reason: 'no_profile',
        };
    }

    const currentTier = profile.tier as Tier;
    const scalePaidUntil = profile.scale_paid_until ? new Date(profile.scale_paid_until as string) : null;
    const now = new Date();

    // Scale con suscripción vigente → no se toca
    if (currentTier === 'scale' && scalePaidUntil && scalePaidUntil > now) {
        return {
            merchantId,
            fromTier: currentTier,
            toTier: currentTier,
            count: 0,
            changed: false,
            reason: 'scale_paid_until_valid',
        };
    }

    const count = await countCompleted30d(merchantId);
    const targetTier = tierForVolume(count);

    if (targetTier === currentTier) {
        return {
            merchantId,
            fromTier: currentTier,
            toTier: currentTier,
            count,
            changed: false,
            reason: 'same_tier',
        };
    }

    const updateFields: Record<string, unknown> = {
        tier: targetTier,
        tier_assigned_at: now.toISOString(),
    };
    // Si bajamos de Scale, limpiamos scale_paid_until (ya venció)
    if (currentTier === 'scale' && targetTier !== 'scale') {
        updateFields.scale_paid_until = null;
    }

    const { error } = await supabase
        .from('profiles')
        .update(updateFields)
        .eq('id', merchantId);
    if (error) {
        return {
            merchantId,
            fromTier: currentTier,
            toTier: targetTier,
            count,
            changed: false,
            reason: error.message,
        };
    }

    return {
        merchantId,
        fromTier: currentTier,
        toTier: targetTier,
        count,
        changed: true,
        reason: currentTier === 'scale' ? 'scale_expired' : 'volume_changed',
    };
}

/**
 * Rebalancea todos los merchants. Usado por el cron tier-rebalance.
 */
export async function rebalanceAll(): Promise<{ processed: number; changed: number; results: RebalanceResult[] }> {
    const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id')
        .in('tier', AUTO_ASSIGNABLE as unknown as string[])
        .order('id'); // determinístico para retries

    // Scale también — para detectar expiry
    const { data: scalers } = await supabase
        .from('profiles')
        .select('id')
        .eq('tier', 'scale');

    if (error) throw error;
    const merchants = [...(profiles ?? []), ...(scalers ?? [])];

    const results: RebalanceResult[] = [];
    for (const m of merchants) {
        const r = await rebalanceMerchant(m.id);
        results.push(r);
    }

    return {
        processed: results.length,
        changed: results.filter(r => r.changed).length,
        results,
    };
}
