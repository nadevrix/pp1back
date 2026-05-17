// Gestión de invitaciones a una sucursal. Solo el owner puede listar y crear.
//
// GET  /api/projects/[id]/invites           — lista invitaciones activas (no revocadas, no vencidas, con uses disponibles)
// POST /api/projects/[id]/invites           — crea un link de invitación. Body opcional: { role, expires_in_days, max_uses, invited_email }
//
// El tier Free está limitado a 1 sucursal así que las invitaciones empiezan a
// tener sentido desde Starter. Igualmente no bloqueamos por tier acá — un Free
// con su única sucursal puede invitar a un cajero si quiere. Si más adelante
// querés monetizar esto, agregar check de tier acá.

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';
import {
    getUserRoleForProject,
    generateInviteToken,
    defaultInviteExpiry,
    type BranchRole,
} from '@/lib/branch-access';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const { id } = await params;

        const role = await getUserRoleForProject(user.id, id);
        if (role !== 'owner') {
            return NextResponse.json({ error: 'Solo el dueño puede gestionar invitaciones' }, { status: 403 });
        }

        const now = new Date().toISOString();
        const { data, error } = await supabase
            .from('branch_invites')
            .select('id, token, role, invited_email, max_uses, use_count, expires_at, created_at, revoked_at')
            .eq('project_id', id)
            .is('revoked_at', null)
            .gt('expires_at', now)
            .order('created_at', { ascending: false });
        if (error) throw error;

        const active = (data ?? []).filter(i => i.use_count < i.max_uses);
        return NextResponse.json({ success: true, invites: active });
    } catch (err: any) {
        console.error('Invites List Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const { id } = await params;

        const role = await getUserRoleForProject(user.id, id);
        if (role !== 'owner') {
            return NextResponse.json({ error: 'Solo el dueño puede crear invitaciones' }, { status: 403 });
        }

        const body = await request.json().catch(() => ({}));

        let inviteRole: BranchRole = 'cashier';
        if (body.role === 'cashier') inviteRole = 'cashier';
        // Owner role no se puede asignar por invitación (1 owner por proyecto).
        if (body.role && body.role !== 'cashier') {
            return NextResponse.json({ error: 'Role inválido. Solo se puede invitar como "cashier"' }, { status: 400 });
        }

        let maxUses = 1;
        if (body.max_uses !== undefined) {
            const n = parseInt(body.max_uses, 10);
            if (!Number.isFinite(n) || n < 1 || n > 100) {
                return NextResponse.json({ error: 'max_uses debe ser entre 1 y 100' }, { status: 400 });
            }
            maxUses = n;
        }

        let expiresAt = defaultInviteExpiry();
        if (body.expires_in_days !== undefined) {
            const d = parseInt(body.expires_in_days, 10);
            if (!Number.isFinite(d) || d < 1 || d > 90) {
                return NextResponse.json({ error: 'expires_in_days debe ser entre 1 y 90' }, { status: 400 });
            }
            expiresAt = new Date(Date.now() + d * 24 * 60 * 60 * 1000);
        }

        let invitedEmail: string | null = null;
        if (body.invited_email) {
            const e = String(body.invited_email).trim().toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
                return NextResponse.json({ error: 'Email inválido' }, { status: 400 });
            }
            invitedEmail = e;
        }

        const token = generateInviteToken();

        const { data, error } = await supabase
            .from('branch_invites')
            .insert({
                project_id: id,
                token,
                role: inviteRole,
                invited_email: invitedEmail,
                max_uses: maxUses,
                expires_at: expiresAt.toISOString(),
                created_by: user.id,
            })
            .select('id, token, role, invited_email, max_uses, use_count, expires_at, created_at')
            .single();
        if (error) throw error;

        return NextResponse.json({ success: true, invite: data });
    } catch (err: any) {
        console.error('Invites Create Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
