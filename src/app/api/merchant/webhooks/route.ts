import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';
import { generateWebhookSecret } from '@/lib/webhooks/sign';
import { isTier } from '@/lib/tiers';

// Webhooks son feature de tier Growth+ (alineado con la propuesta comercial).
// Los tiers Free y Starter pueden listar sus endpoints existentes (para no
// perder visibilidad si bajaron de plan) pero no pueden crear nuevos.

const ALLOWED_CREATE_TIERS = new Set(['growth', 'scale']);

export async function GET(request: Request) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        // Proyectos del merchant
        const { data: projects } = await supabase
            .from('projects')
            .select('id, name')
            .eq('merchant_id', user.id);
        const projectIds = (projects ?? []).map(p => p.id);
        if (projectIds.length === 0) {
            return NextResponse.json({ success: true, endpoints: [] });
        }

        const { data, error } = await supabase
            .from('webhook_endpoints')
            .select('id, project_id, url, active, events, created_at')
            .in('project_id', projectIds)
            .order('created_at', { ascending: false });
        if (error) throw error;

        const projectName = new Map((projects ?? []).map(p => [p.id, p.name]));
        const endpoints = (data ?? []).map(e => ({
            ...e,
            branch_name: projectName.get(e.project_id) || '',
        }));
        return NextResponse.json({ success: true, endpoints });
    } catch (err: any) {
        console.error('Webhooks GET Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        // Tier-gate: solo Growth+ pueden crear
        const { data: profile } = await supabase
            .from('profiles')
            .select('tier')
            .eq('id', user.id)
            .single();
        const tier = isTier(profile?.tier) ? profile!.tier : 'free';
        if (!ALLOWED_CREATE_TIERS.has(tier)) {
            return NextResponse.json(
                { error: 'Webhooks están disponibles a partir del tier Growth. Actualizá tu plan en /dashboard/plan.' },
                { status: 403 },
            );
        }

        const body = await request.json().catch(() => ({}));
        const { project_id, url } = body as { project_id?: string; url?: string };
        if (!project_id || !url) {
            return NextResponse.json({ error: 'project_id y url son requeridos' }, { status: 400 });
        }
        if (!/^https?:\/\//i.test(url)) {
            return NextResponse.json({ error: 'url debe empezar con http(s)' }, { status: 400 });
        }

        // Ownership del proyecto
        const { data: project } = await supabase
            .from('projects')
            .select('merchant_id')
            .eq('id', project_id)
            .single();
        if (!project || project.merchant_id !== user.id) {
            return NextResponse.json({ error: 'Sucursal no encontrada' }, { status: 404 });
        }

        const secret = generateWebhookSecret();
        const { data: created, error } = await supabase
            .from('webhook_endpoints')
            .insert({ project_id, url, secret, active: true })
            .select('id, project_id, url, secret, active, created_at')
            .single();
        if (error) throw error;

        // El secret se devuelve una sola vez — el comercio debe guardarlo
        return NextResponse.json({ success: true, endpoint: created }, { status: 201 });
    } catch (err: any) {
        console.error('Webhooks POST Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
