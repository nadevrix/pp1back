import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';
import { attemptDelivery, loadDeliverable } from '@/lib/webhooks/deliver';

// Reintento manual de una entrega — equivalente al botón "Verificar" que
// usás en cobros. Marca la delivery como pending y dispara attemptDelivery
// inmediatamente, sin esperar al backoff.

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const { id } = await params;

        // Ownership
        const { data: row } = await supabase
            .from('webhook_deliveries')
            .select('id, status, projects!project_id(merchant_id)')
            .eq('id', id)
            .single();
        if (!row) return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
        const project = row.projects as { merchant_id: string } | { merchant_id: string }[] | null;
        const merchantId = Array.isArray(project) ? project[0]?.merchant_id : project?.merchant_id;
        if (merchantId !== user.id) return NextResponse.json({ error: 'No encontrado' }, { status: 404 });

        if (row.status === 'delivered') {
            return NextResponse.json({ error: 'La entrega ya está completada' }, { status: 400 });
        }

        // Forzamos next_attempt_at = NOW y dejamos pending para que attemptDelivery
        // la considere fresca. Si estaba abandoned, la volvemos a pending para reintentar.
        await supabase
            .from('webhook_deliveries')
            .update({ status: 'pending', next_attempt_at: new Date().toISOString() })
            .eq('id', id);

        const deliverable = await loadDeliverable(id);
        if (!deliverable) {
            return NextResponse.json({ error: 'No se pudo cargar la entrega' }, { status: 500 });
        }

        const outcome = await attemptDelivery(deliverable);
        return NextResponse.json({ success: true, outcome });
    } catch (err: any) {
        console.error('Webhook retry Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
