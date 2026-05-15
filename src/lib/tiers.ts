// Tiers de Pollar Pay — fuente de verdad para fees, mínimos y umbrales.
// Refleja exactamente la "Estructura de precios" de la propuesta comercial.
//
// Convención: percent es decimal (0.012 = 1.2 %). minimum y monthlyFee en USDC.

export type Tier = 'free' | 'starter' | 'growth' | 'scale';

export interface TierConfig {
    readonly id: Tier;
    readonly label: string;
    readonly percent: number;        // ej. 0.012 = 1.2%
    readonly minimum: number;        // USDC mínimos por cobro
    readonly monthlyFee: number;     // USDC fijos por mes
    readonly monthlyVolumeMin: number; // umbral inferior (cobros/mes)
    readonly monthlyVolumeMax: number | null; // umbral superior (null = sin tope)
    readonly freeTransactions: number; // gratis "primeras N" — solo Free
    readonly features: readonly string[];
}

export const TIERS: Record<Tier, TierConfig> = {
    free: {
        id: 'free',
        label: 'Free',
        percent: 0.012,
        minimum: 0.20,
        monthlyFee: 0,
        monthlyVolumeMin: 0,
        monthlyVolumeMax: 150,
        freeTransactions: 50,
        features: [
            '50 primeras transacciones gratuitas',
            'QR de cobro ilimitado',
            '1 sucursal',
            'Exportación últimos 3 meses',
            'Soporte por email',
        ],
    },
    starter: {
        id: 'starter',
        label: 'Starter',
        percent: 0.009,
        minimum: 0.20,
        monthlyFee: 0,
        monthlyVolumeMin: 150,
        monthlyVolumeMax: 400,
        freeTransactions: 0,
        features: [
            'Todo lo del tier Free',
            'Múltiples sucursales',
            'Exportación últimos 6 meses',
            'Soporte por email <48 h',
        ],
    },
    growth: {
        id: 'growth',
        label: 'Growth',
        percent: 0.007,
        minimum: 0.15,
        monthlyFee: 0,
        monthlyVolumeMin: 400,
        monthlyVolumeMax: 1000,
        freeTransactions: 0,
        features: [
            'Todo lo del tier Starter',
            'Exportación historial completo',
            'Notificaciones webhook',
            'Soporte por chat <4 h',
        ],
    },
    scale: {
        id: 'scale',
        label: 'Scale',
        percent: 0.005,
        minimum: 0,
        monthlyFee: 25,
        monthlyVolumeMin: 1000,
        monthlyVolumeMax: null,
        freeTransactions: 0,
        features: [
            'Todo lo del tier Growth',
            'Exportación programada automática',
            'API de integración completa',
            'Soporte WhatsApp/Telegram <1 h',
        ],
    },
};

export const TIER_LIST: readonly TierConfig[] = ['free', 'starter', 'growth', 'scale'].map(
    t => TIERS[t as Tier],
);

export function isTier(value: unknown): value is Tier {
    return value === 'free' || value === 'starter' || value === 'growth' || value === 'scale';
}

/**
 * Calcula el fee a cobrar al comercio por una transacción.
 *
 *   fee = max(amount * percent, minimum)
 *
 * Si la transacción califica como "gratis" (primeras N del tier Free), fee = 0.
 * El resultado se redondea a 7 decimales (precisión de Stellar).
 */
export function calculateFee(grossAmount: number, tier: Tier, isFreeTx: boolean): number {
    if (isFreeTx) return 0;
    const t = TIERS[tier];
    const fee = Math.max(grossAmount * t.percent, t.minimum);
    // Stellar maneja hasta 7 decimales, redondear hacia arriba para no perder fracciones de centavo
    return Math.ceil(fee * 1e7) / 1e7;
}

/**
 * Computa el split fee/payout para un cobro. amount_paid se conserva tal cual
 * (lo bruto recibido del cliente), payout es lo que va al merchant.
 *
 * Si el fee es mayor que el monto recibido (caso edge: cliente pagó muy poco),
 * el fee se trunca al monto y payout queda en 0. Esto evita números negativos.
 */
export function splitPayment(opts: {
    grossAmount: number;
    tier: Tier;
    isFreeTx: boolean;
}): { fee: number; payout: number } {
    const fee = Math.min(opts.grossAmount, calculateFee(opts.grossAmount, opts.tier, opts.isFreeTx));
    const payout = Math.max(0, opts.grossAmount - fee);
    return { fee, payout };
}

/**
 * Tier sugerido según el volumen de cobros completados en el último mes.
 * Devuelve el tier cuyo rango contiene a `monthlyCount`. Si ya está en el
 * tier óptimo, devuelve el mismo tier.
 */
export function suggestTier(monthlyCount: number): Tier {
    for (const t of TIER_LIST) {
        const overMin = monthlyCount >= t.monthlyVolumeMin;
        const underMax = t.monthlyVolumeMax === null || monthlyCount < t.monthlyVolumeMax;
        if (overMin && underMax) return t.id;
    }
    return 'free';
}
