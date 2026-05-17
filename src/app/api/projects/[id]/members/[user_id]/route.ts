// DELETE /api/projects/[id]/members/[user_id] — remueve a un miembro.
// El owner no se puede remover desde acá (se va con el borrado del proyecto).
// Un cashier puede removerse a sí mismo (renunciar al acceso).

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';
import { getUserRoleForProject } from '@/lib/branch-access';

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string; user_id: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const { id, user_id: targetUserId } = await params;

        const role = await getUserRoleForProject(user.id, id);
        if (!role) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        // Owner remueve a cualquiera. Cashier solo a sí mismo.
        if (role !== 'owner' && user.id !== targetUserId) {
            return NextResponse.json({ error: 'Solo el dueño puede remover otros miembros' }, { status: 403 });
        }

        const { error } = await supabase
            .from('branch_members')
            .delete()
            .eq('project_id', id)
            .eq('user_id', targetUserId);
        if (error) throw error;

        return NextResponse.json({ success: true });
    } catch (err: any) {
        console.error('Member Delete Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
