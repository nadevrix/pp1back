// DELETE /api/projects/[id]/invites/[token] — revoca un link de invitación.

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';
import { getUserRoleForProject } from '@/lib/branch-access';

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string; token: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const { id, token } = await params;

        const role = await getUserRoleForProject(user.id, id);
        if (role !== 'owner') {
            return NextResponse.json({ error: 'Solo el dueño puede revocar invitaciones' }, { status: 403 });
        }

        const { error } = await supabase
            .from('branch_invites')
            .update({ revoked_at: new Date().toISOString() })
            .eq('project_id', id)
            .eq('token', token);
        if (error) throw error;

        return NextResponse.json({ success: true });
    } catch (err: any) {
        console.error('Invite Revoke Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
