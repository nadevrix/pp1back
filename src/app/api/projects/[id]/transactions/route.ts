import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';
import { getUserRoleForProject } from '@/lib/branch-access';

const MAX_LIMIT = 100;

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id } = await params;

        // Owner o miembro pueden ver las transacciones de la sucursal.
        const role = await getUserRoleForProject(user.id, id);
        if (!role) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const { searchParams } = new URL(request.url);
        const limitParam = parseInt(searchParams.get('limit') || '50', 10);
        const limit = Math.min(Math.max(limitParam, 1), MAX_LIMIT);
        const status = searchParams.get('status');

        let query = supabase
            .from('transactions')
            .select('id, status, reason, amount_expected, amount_paid, asset_code, wallet_pubkey, expires_at, created_at, forward_status, forward_tx_hash, crypto_tx_hash')
            .eq('project_id', id)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (status) query = query.eq('status', status);

        const { data, error } = await query;
        if (error) throw error;

        return NextResponse.json({ success: true, transactions: data ?? [] });
    } catch (err: any) {
        console.error('Project Transactions Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
