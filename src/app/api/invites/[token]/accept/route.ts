// POST /api/invites/[token]/accept — el user logueado acepta la invitación
// y queda como miembro de la sucursal.
//
// Validaciones:
//   - Token existe, no revocado, no vencido, con usos disponibles.
//   - Si invited_email está seteado, debe coincidir con el email del user.
//   - El user no puede aceptar su propia invitación (no tiene sentido — ya es owner).
//   - Si ya es miembro, devolvemos OK idempotente sin incrementar use_count.

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';

export async function POST(
    request: Request,
    { params }: { params: Promise<{ token: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Tenés que iniciar sesión para aceptar la invitación' }, { status: 401 });
        }

        const { token } = await params;

        const { data: invite, error: invErr } = await supabase
            .from('branch_invites')
            .select('id, project_id, role, invited_email, max_uses, use_count, expires_at, revoked_at, created_by')
            .eq('token', token)
            .maybeSingle();
        if (invErr || !invite) {
            return NextResponse.json({ error: 'Invitación no encontrada' }, { status: 404 });
        }

        if (invite.revoked_at) {
            return NextResponse.json({ error: 'La invitación fue revocada' }, { status: 410 });
        }
        if (new Date(invite.expires_at) < new Date()) {
            return NextResponse.json({ error: 'La invitación expiró' }, { status: 410 });
        }
        if (invite.use_count >= invite.max_uses) {
            return NextResponse.json({ error: 'La invitación ya se usó el máximo de veces' }, { status: 410 });
        }

        // Si la invitación tiene email específico, validar que coincida
        if (invite.invited_email) {
            const { data: profile } = await supabase
                .from('profiles').select('email').eq('id', user.id).single();
            const userEmail = (profile?.email ?? '').toLowerCase();
            if (userEmail !== invite.invited_email.toLowerCase()) {
                return NextResponse.json(
                    { error: `Esta invitación es para ${invite.invited_email}. Iniciá sesión con esa cuenta.` },
                    { status: 403 },
                );
            }
        }

        // El owner del proyecto no puede aceptar la invitación a su propia sucursal
        const { data: ownerCheck } = await supabase
            .from('projects')
            .select('merchant_id')
            .eq('id', invite.project_id)
            .single();
        if (ownerCheck?.merchant_id === user.id) {
            return NextResponse.json({ error: 'Ya sos el dueño de esta sucursal' }, { status: 400 });
        }

        // Idempotente: si ya es miembro, no incrementamos use_count.
        const { data: existing } = await supabase
            .from('branch_members')
            .select('user_id')
            .eq('project_id', invite.project_id)
            .eq('user_id', user.id)
            .maybeSingle();

        if (!existing) {
            const { error: insErr } = await supabase
                .from('branch_members')
                .insert({
                    project_id: invite.project_id,
                    user_id: user.id,
                    role: invite.role,
                    added_by: invite.created_by,
                });
            if (insErr) throw insErr;

            const { error: bumpErr } = await supabase
                .from('branch_invites')
                .update({ use_count: invite.use_count + 1 })
                .eq('id', invite.id);
            if (bumpErr) console.error('[INVITES] could not bump use_count', bumpErr.message);
        }

        return NextResponse.json({ success: true, project_id: invite.project_id });
    } catch (err: any) {
        console.error('Invite Accept Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
