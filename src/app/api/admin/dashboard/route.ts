import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { validateAdminAuth } from '@/lib/admin-auth';

// GET — Dashboard KPIs with real data from Supabase
export async function GET(request: Request) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    try {
        // Pool wallet stats
        const { data: wallets } = await supabase
            .from('wallets')
            .select('public_key, wallet_type, is_locked');

        const poolWallets = wallets?.filter(w => w.wallet_type === 'pool') || [];
        const treasuryWallets = wallets?.filter(w => w.wallet_type === 'treasury') || [];

        // Transaction stats
        const { data: allTxs } = await supabase
            .from('transactions')
            .select('status, amount_expected, amount_paid');

        const transactions = allTxs || [];

        const completed = transactions.filter(t => t.status === 'completed');
        const anomalies = transactions.filter(t =>
            ['underpaid', 'overpaid', 'anomaly', 'late_anomaly'].includes(t.status)
        );
        const pending = transactions.filter(t => t.status === 'pending');

        // Calculate total volume (completed + overpaid)
        const totalVolume = [...completed, ...transactions.filter(t => t.status === 'overpaid')]
            .reduce((sum, t) => sum + parseFloat(t.amount_paid || '0'), 0);

        // Count recent transactions (last 24h)
        const { count: last24h } = await supabase
            .from('transactions')
            .select('id', { count: 'exact', head: true })
            .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

        return NextResponse.json({
            success: true,
            data: {
                pool: {
                    total: poolWallets.length,
                    available: poolWallets.filter(w => !w.is_locked).length,
                    locked: poolWallets.filter(w => w.is_locked).length
                },
                treasury: {
                    count: treasuryWallets.length,
                    public_key: treasuryWallets[0]?.public_key || null
                },
                transactions: {
                    total: transactions.length,
                    completed: completed.length,
                    pending: pending.length,
                    anomalies: anomalies.length,
                    last_24h: last24h || 0
                },
                volume: {
                    total_processed_usdc: totalVolume.toFixed(2)
                }
            }
        });
    } catch (err: any) {
        console.error('Dashboard Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
