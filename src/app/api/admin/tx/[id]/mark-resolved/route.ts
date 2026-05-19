// ─── Marcar / desmarcar transacción como resuelta off-system ────────────
// POST   → setea support_resolved_at = NOW() (admin tilda "Comprobado")
// DELETE → setea support_resolved_at = NULL (admin clickea "Deshacer")
//
// No toca status ni amount_paid — solo el flag de revisión administrativa.
// Las tx con support_resolved_at NOT NULL desaparecen de /admin/anomalies.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { validateAdminAuth } from '@/lib/admin-auth';

async function setResolved(
    request: Request,
    id: string,
    timestamp: string | null,
) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
    }

    const { data, error } = await supabase
        .from('transactions')
        .update({ support_resolved_at: timestamp })
        .eq('id', id)
        .select('id, support_resolved_at')
        .single();

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
        return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true, ...data });
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    return setResolved(request, id, new Date().toISOString());
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    return setResolved(request, id, null);
}
