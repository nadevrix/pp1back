import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';

export async function GET(request: Request) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { data, error } = await supabase
            .from('projects')
            .select('id, name, reason, payout_wallet, api_key, created_at')
            .eq('merchant_id', user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        return NextResponse.json({ success: true, projects: data ?? [] });
    } catch (err: any) {
        console.error('Project List Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
