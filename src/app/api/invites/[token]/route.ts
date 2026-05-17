// GET /api/invites/[token] — info pública de una invitación (para mostrar
// en la pantalla "Te invitaron a la sucursal X" antes de aceptar).
// No requiere auth — devuelve solo metadata mínima (nombre del proyecto,
// rol asignado, fecha de expiración, si está vigente).

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ token: string }> },
) {
    try {
        const { token } = await params;

        const { data, error } = await supabase
            .from('branch_invites')
            .select('id, project_id, role, invited_email, max_uses, use_count, expires_at, revoked_at, projects!branch_invites_project_id_fkey(name, reason)')
            .eq('token', token)
            .maybeSingle();

        if (error || !data) {
            return NextResponse.json({ error: 'Invitación no encontrada' }, { status: 404 });
        }

        const now = new Date();
        const expired = new Date(data.expires_at) < now;
        const usedUp = data.use_count >= data.max_uses;
        const revoked = data.revoked_at !== null;
        const valid = !expired && !usedUp && !revoked;

        type ProjectInfo = { name: string; reason: string } | { name: string; reason: string }[] | null;
        const p = data.projects as ProjectInfo;
        const projectName = Array.isArray(p) ? p[0]?.name ?? '' : p?.name ?? '';
        const projectReason = Array.isArray(p) ? p[0]?.reason ?? '' : p?.reason ?? '';

        return NextResponse.json({
            success: true,
            invite: {
                role: data.role,
                invited_email: data.invited_email,
                expires_at: data.expires_at,
                project_name: projectName,
                project_reason: projectReason,
                valid,
                reason: revoked ? 'revoked' : expired ? 'expired' : usedUp ? 'used_up' : null,
            },
        });
    } catch (err: any) {
        console.error('Invite Info Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
