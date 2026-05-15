import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';

// DELETE — borra un endpoint (cascadea sus deliveries pendientes).
// PATCH — toggle active/inactive (para pausar sin perder historial).

async function loadOwnedEndpoint(userId: string, id: string) {
    const { data } = await supabase
        .from('webhook_endpoints')
        .select('id, project_id, projects!project_id(merchant_id)')
        .eq('id', id)
        .single();
    if (!data) return null;
    const project = data.projects as { merchant_id: string } | { merchant_id: string }[] | null;
    const merchantId = Array.isArray(project) ? project[0]?.merchant_id : project?.merchant_id;
    if (merchantId !== userId) return null;
    return data;
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const { id } = await params;

        const owned = await loadOwnedEndpoint(user.id, id);
        if (!owned) return NextResponse.json({ error: 'Webhook no encontrado' }, { status: 404 });

        const { error } = await supabase
            .from('webhook_endpoints')
            .delete()
            .eq('id', id);
        if (error) throw error;

        return NextResponse.json({ success: true });
    } catch (err: any) {
        console.error('Webhook DELETE Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const { id } = await params;
        const body = await request.json().catch(() => ({}));

        const owned = await loadOwnedEndpoint(user.id, id);
        if (!owned) return NextResponse.json({ error: 'Webhook no encontrado' }, { status: 404 });

        const updates: Record<string, unknown> = {};
        if (typeof body.active === 'boolean') updates.active = body.active;
        if (typeof body.url === 'string') {
            if (!/^https?:\/\//i.test(body.url)) {
                return NextResponse.json({ error: 'url inválida' }, { status: 400 });
            }
            updates.url = body.url;
        }
        if (Object.keys(updates).length === 0) {
            return NextResponse.json({ error: 'sin campos para actualizar' }, { status: 400 });
        }

        const { data, error } = await supabase
            .from('webhook_endpoints')
            .update(updates)
            .eq('id', id)
            .select('id, project_id, url, active, events, created_at')
            .single();
        if (error) throw error;

        return NextResponse.json({ success: true, endpoint: data });
    } catch (err: any) {
        console.error('Webhook PATCH Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
