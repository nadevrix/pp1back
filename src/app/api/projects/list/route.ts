import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';
import { getAccessibleProjectIds } from '@/lib/branch-access';

export async function GET(request: Request) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const ids = await getAccessibleProjectIds(user.id);
        if (ids.length === 0) {
            return NextResponse.json({ success: true, projects: [] });
        }

        const { data, error } = await supabase
            .from('projects')
            .select('id, name, reason, payout_wallet, api_key, default_amount, merchant_id, created_at')
            .in('id', ids)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Anotamos role para que la UI sepa si esconder acciones de owner
        // (editar wallet, gestionar miembros, etc).
        const projects = (data ?? []).map(p => ({
            ...p,
            role: p.merchant_id === user.id ? 'owner' : 'cashier',
        }));

        return NextResponse.json({ success: true, projects });
    } catch (err: any) {
        console.error('Project List Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
