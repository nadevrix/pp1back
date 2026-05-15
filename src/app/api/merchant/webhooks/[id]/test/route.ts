import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';
import { attemptDelivery, loadDeliverable } from '@/lib/webhooks/deliver';

// Genera un evento de prueba en este endpoint sin tocar transacciones reales.
// Crea una delivery con un payload sintético y dispara el delivery inline.

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const { id } = await params;

        const { data: endpoint } = await supabase
            .from('webhook_endpoints')
            .select('id, project_id, active, projects!project_id(merchant_id)')
            .eq('id', id)
            .single();
        if (!endpoint) return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
        const project = endpoint.projects as { merchant_id: string } | { merchant_id: string }[] | null;
        const merchantId = Array.isArray(project) ? project[0]?.merchant_id : project?.merchant_id;
        if (merchantId !== user.id) return NextResponse.json({ error: 'No encontrado' }, { status: 404 });

        const payload = {
            event: 'payment.completed',
            project_id: endpoint.project_id,
            timestamp: new Date().toISOString(),
            test: true,
            transaction: {
                id: '00000000-0000-0000-0000-000000000000',
                status: 'completed',
                reason: 'Prueba de webhook',
                asset: 'USDC',
                amount_expected: '10.00',
                amount_paid: '10.00',
                fee_amount: '0.20',
                payout_amount: '9.80',
                wallet_address: null,
                forward_tx_hash: null,
                created_at: new Date().toISOString(),
            },
        };

        const { data: inserted, error: insErr } = await supabase
            .from('webhook_deliveries')
            .insert({
                endpoint_id: id,
                project_id: endpoint.project_id,
                event_type: 'payment.completed',
                payload,
                status: 'pending',
            })
            .select('id')
            .single();
        if (insErr || !inserted) throw insErr;

        const deliverable = await loadDeliverable(inserted.id);
        if (!deliverable) {
            return NextResponse.json({ error: 'No se pudo cargar la entrega' }, { status: 500 });
        }

        const outcome = await attemptDelivery(deliverable);
        return NextResponse.json({ success: true, outcome });
    } catch (err: any) {
        console.error('Webhook test Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
