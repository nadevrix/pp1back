// GET /api/projects/[id]/members — lista los miembros de la sucursal
// (owner + cashiers invitados). Owner ve todos; cashiers solo se ven a sí mismos.

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';
import { getUserRoleForProject } from '@/lib/branch-access';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const { id } = await params;

        const role = await getUserRoleForProject(user.id, id);
        if (!role) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        // Owner del proyecto — figura primero, viene de projects.merchant_id
        const { data: project, error: pErr } = await supabase
            .from('projects')
            .select('merchant_id, profiles!projects_merchant_id_fkey(email)')
            .eq('id', id)
            .single();
        if (pErr || !project) {
            return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }

        type ProfileEmail = { email: string } | { email: string }[] | null;
        const ownerProfile = project.profiles as ProfileEmail;
        const ownerEmail = Array.isArray(ownerProfile)
            ? ownerProfile[0]?.email ?? ''
            : ownerProfile?.email ?? '';

        const owner = {
            user_id: project.merchant_id,
            email: ownerEmail,
            role: 'owner' as const,
            added_by: null,
            created_at: null,
        };

        // Si quien consulta es cashier, solo se ve a sí mismo (+ owner por contexto).
        if (role === 'cashier') {
            const { data: self } = await supabase
                .from('branch_members')
                .select('user_id, role, added_by, created_at, profiles!branch_members_user_id_fkey(email)')
                .eq('project_id', id)
                .eq('user_id', user.id)
                .maybeSingle();
            const selfProfile = self?.profiles as ProfileEmail;
            const selfEmail = Array.isArray(selfProfile)
                ? selfProfile[0]?.email ?? ''
                : selfProfile?.email ?? '';
            return NextResponse.json({
                success: true,
                members: self
                    ? [owner, { user_id: self.user_id, email: selfEmail, role: self.role, added_by: self.added_by, created_at: self.created_at }]
                    : [owner],
                viewer_role: 'cashier',
            });
        }

        const { data: rows, error } = await supabase
            .from('branch_members')
            .select('user_id, role, added_by, created_at, profiles!branch_members_user_id_fkey(email)')
            .eq('project_id', id)
            .order('created_at', { ascending: true });
        if (error) throw error;

        const members = (rows ?? []).map(r => {
            const p = r.profiles as ProfileEmail;
            const email = Array.isArray(p) ? p[0]?.email ?? '' : p?.email ?? '';
            return {
                user_id: r.user_id,
                email,
                role: r.role,
                added_by: r.added_by,
                created_at: r.created_at,
            };
        });

        return NextResponse.json({
            success: true,
            members: [owner, ...members],
            viewer_role: 'owner',
        });
    } catch (err: any) {
        console.error('Members List Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
