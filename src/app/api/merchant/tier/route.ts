import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';
import { TIERS, isTier, suggestTier, type Tier } from '@/lib/tiers';

// GET — Estado del tier del comercio: tier actual, uso del mes, fee acumulado,
// tier sugerido y free transactions restantes. Una sola request consolidada
// para que el dashboard pueda renderizar la tarjeta de "Tu plan" sin N llamadas.
//
// El cambio de tier va exclusivamente por /api/merchant/billing/upgrade, que
// exige cobro on-chain para los tiers pagos (Scale). No exponemos un POST acá
// para evitar bypass de billing.

export async function GET(request: Request) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { data: profile, error: pErr } = await supabase
            .from('profiles')
            .select('tier, tier_assigned_at, scale_paid_until, onboarding_completed')
            .eq('id', user.id)
            .single();
        if (pErr || !profile) {
            return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
        }

        const tier: Tier = isTier(profile.tier) ? profile.tier : 'free';
        const tierConfig = TIERS[tier];

        // Proyectos del merchant — necesarios para acotar las queries
        const { data: projects } = await supabase
            .from('projects')
            .select('id')
            .eq('merchant_id', user.id);
        const projectIds = (projects ?? []).map(p => p.id);

        let monthCount = 0;
        let monthFee = 0;
        let monthVolume = 0;
        let freeTxUsed = 0;

        if (projectIds.length > 0) {
            const monthStart = new Date();
            monthStart.setDate(1);
            monthStart.setHours(0, 0, 0, 0);

            const { data: monthTxs } = await supabase
                .from('transactions')
                .select('amount_paid, fee_amount, status')
                .in('project_id', projectIds)
                .gte('created_at', monthStart.toISOString())
                .in('status', ['completed', 'overpaid']);

            const m = monthTxs ?? [];
            monthCount = m.length;
            monthFee = m.reduce((s, t) => s + parseFloat(t.fee_amount || '0'), 0);
            monthVolume = m.reduce((s, t) => s + parseFloat(t.amount_paid || '0'), 0);

            // Lifetime de las 50 gratuitas
            const { count: freeCount } = await supabase
                .from('transactions')
                .select('id', { count: 'exact', head: true })
                .in('project_id', projectIds)
                .eq('is_free_tx', true);
            freeTxUsed = freeCount ?? 0;
        }

        const suggested = suggestTier(monthCount);
        const freeTxRemaining = tier === 'free' ? Math.max(0, 50 - freeTxUsed) : 0;

        return NextResponse.json({
            success: true,
            data: {
                tier,
                tier_label: tierConfig.label,
                tier_assigned_at: profile.tier_assigned_at,
                scale_paid_until: profile.scale_paid_until ?? null,
                onboarding_completed: profile.onboarding_completed ?? true,
                percent: tierConfig.percent,
                minimum: tierConfig.minimum,
                monthly_fee: tierConfig.monthlyFee,
                features: tierConfig.features,
                usage: {
                    transactions_this_month: monthCount,
                    fee_paid_this_month: monthFee.toFixed(2),
                    volume_this_month: monthVolume.toFixed(2),
                    monthly_volume_min: tierConfig.monthlyVolumeMin,
                    monthly_volume_max: tierConfig.monthlyVolumeMax,
                    free_tx_used: freeTxUsed,
                    free_tx_remaining: freeTxRemaining,
                },
                suggested_tier: suggested === tier ? null : suggested,
                suggested_label: suggested === tier ? null : TIERS[suggested].label,
            },
        });
    } catch (err: any) {
        console.error('Tier GET Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

