import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';

// Resumen del comercio para el dashboard home: KPIs agregados de todas las
// sucursales del merchant + las últimas N transacciones. Una sola request en
// lugar de N (una por sucursal). Vercel-friendly.
export async function GET(request: Request) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { searchParams } = new URL(request.url);
        const recentLimit = Math.min(Math.max(parseInt(searchParams.get('recent') || '5', 10), 1), 50);

        const { data: projects, error: pErr } = await supabase
            .from('projects')
            .select('id, name')
            .eq('merchant_id', user.id);
        if (pErr) throw pErr;

        const branchCount = projects?.length ?? 0;
        if (branchCount === 0) {
            return NextResponse.json({
                success: true,
                data: {
                    branches: 0,
                    totals: { received_usdc: '0.00', transactions: 0, pending: 0, last_24h: 0 },
                    recent: [],
                },
            });
        }

        const projectIds = projects!.map(p => p.id);

        const { data: allTxs, error: tErr } = await supabase
            .from('transactions')
            .select('id, status, amount_paid, amount_expected, fee_amount, payout_amount, reason, created_at, project_id, wallet_pubkey, forward_status, forward_tx_hash, crypto_tx_hash, expires_at, asset_code')
            .in('project_id', projectIds)
            .order('created_at', { ascending: false });
        if (tErr) throw tErr;

        const txs = allTxs ?? [];
        const completed = txs.filter(t => t.status === 'completed' || t.status === 'overpaid');
        const pending = txs.filter(t => t.status === 'pending');

        // Bruto recibido del cliente vs neto que llegó al merchant (descontando fees)
        const totalReceived = completed.reduce(
            (sum, t) => sum + parseFloat(t.amount_paid || '0'),
            0,
        );
        const totalPayout = completed.reduce(
            (sum, t) => sum + parseFloat(t.payout_amount || t.amount_paid || '0'),
            0,
        );
        const totalFees = completed.reduce(
            (sum, t) => sum + parseFloat(t.fee_amount || '0'),
            0,
        );

        const since = Date.now() - 24 * 60 * 60 * 1000;
        const last24h = txs.filter(t => new Date(t.created_at).getTime() >= since).length;

        const projectName = new Map(projects!.map(p => [p.id, p.name]));
        const recent = txs.slice(0, recentLimit).map(t => ({
            ...t,
            branch_name: projectName.get(t.project_id) || '',
        }));

        return NextResponse.json({
            success: true,
            data: {
                branches: branchCount,
                totals: {
                    received_usdc: totalReceived.toFixed(2),
                    payout_usdc: totalPayout.toFixed(2),
                    fees_usdc: totalFees.toFixed(2),
                    transactions: completed.length,
                    pending: pending.length,
                    last_24h: last24h,
                },
                recent,
            },
        });
    } catch (err: any) {
        console.error('Merchant Overview Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
