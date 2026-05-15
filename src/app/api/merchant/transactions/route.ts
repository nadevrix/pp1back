import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';

// Listado consolidado de transacciones del comercio (todas sus sucursales).
// Filtros: status, project_id (sucursal), desde, hasta. Paginación con limit + offset.
// Devuelve también el nombre de la sucursal en cada fila para que la UI no
// tenga que hacer un segundo round-trip.
const MAX_LIMIT = 200;

export async function GET(request: Request) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { searchParams } = new URL(request.url);
        const status = searchParams.get('status');
        const branchId = searchParams.get('branch_id');
        const fromIso = searchParams.get('from');
        const toIso = searchParams.get('to');
        const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50', 10), 1), MAX_LIMIT);
        const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

        const { data: projects, error: pErr } = await supabase
            .from('projects')
            .select('id, name')
            .eq('merchant_id', user.id);
        if (pErr) throw pErr;
        if (!projects || projects.length === 0) {
            return NextResponse.json({ success: true, transactions: [], total: 0, branches: [] });
        }

        const ownedIds = new Set(projects.map(p => p.id));
        const filterIds = branchId && ownedIds.has(branchId) ? [branchId] : projects.map(p => p.id);

        let query = supabase
            .from('transactions')
            .select(
                'id, status, reason, amount_expected, amount_paid, fee_amount, payout_amount, tier_at_time, is_free_tx, asset_code, wallet_pubkey, expires_at, created_at, forward_status, forward_tx_hash, crypto_tx_hash, project_id',
                { count: 'exact' },
            )
            .in('project_id', filterIds)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (status) query = query.eq('status', status);
        if (fromIso) query = query.gte('created_at', fromIso);
        if (toIso) query = query.lte('created_at', toIso);

        const { data, count, error } = await query;
        if (error) throw error;

        const projectName = new Map(projects.map(p => [p.id, p.name]));
        const transactions = (data ?? []).map(t => ({
            ...t,
            branch_name: projectName.get(t.project_id) || '',
        }));

        return NextResponse.json({
            success: true,
            transactions,
            total: count ?? transactions.length,
            branches: projects.map(p => ({ id: p.id, name: p.name })),
        });
    } catch (err: any) {
        console.error('Merchant Transactions Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
