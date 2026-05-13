import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';

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

        const { data, error } = await supabase
            .from('projects')
            .select('id, name, reason, payout_wallet, api_key, created_at, merchant_id')
            .eq('id', id)
            .single();

        if (error || !data) {
            return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }

        if (data.merchant_id !== user.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        // No exponemos merchant_id al cliente — viene del session
        const { merchant_id, ...projectSafe } = data;
        return NextResponse.json({ success: true, project: projectSafe });
    } catch (err: any) {
        console.error('Project Get Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id } = await params;

        const { data: existing, error: getErr } = await supabase
            .from('projects')
            .select('merchant_id')
            .eq('id', id)
            .single();

        if (getErr || !existing) {
            return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }
        if (existing.merchant_id !== user.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const { error } = await supabase.from('projects').delete().eq('id', id);
        if (error) throw error;

        return NextResponse.json({ success: true });
    } catch (err: any) {
        console.error('Project Delete Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
