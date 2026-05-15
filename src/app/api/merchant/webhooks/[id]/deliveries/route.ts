import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';

// Últimas N entregas del endpoint. Por defecto 50, máximo 200.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const { id } = await params;

        // Ownership: el endpoint tiene que pertenecer a un proyecto del merchant
        const { data: endpoint } = await supabase
            .from('webhook_endpoints')
            .select('id, projects!project_id(merchant_id)')
            .eq('id', id)
            .single();
        if (!endpoint) return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
        const project = endpoint.projects as { merchant_id: string } | { merchant_id: string }[] | null;
        const merchantId = Array.isArray(project) ? project[0]?.merchant_id : project?.merchant_id;
        if (merchantId !== user.id) {
            return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
        }

        const { searchParams } = new URL(request.url);
        const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || `${DEFAULT_LIMIT}`, 10), 1), MAX_LIMIT);

        const { data, error } = await supabase
            .from('webhook_deliveries')
            .select('id, event_type, status, attempts, next_attempt_at, last_attempt_at, response_status, response_body, delivered_at, created_at, transaction_id')
            .eq('endpoint_id', id)
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) throw error;

        return NextResponse.json({ success: true, deliveries: data ?? [] });
    } catch (err: any) {
        console.error('Webhook deliveries GET Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
