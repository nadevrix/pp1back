// Helpers para resolver acceso multi-usuario a proyectos (sucursales).
// Ver migración 006 — branch_members + branch_invites.

import { supabase } from '@/lib/supabase';
import { randomBytes } from 'crypto';

export type BranchRole = 'owner' | 'cashier';

/**
 * Devuelve todos los IDs de proyecto a los que el user tiene acceso:
 * tanto los que él creó (owner) como los que le invitaron (miembro).
 */
export async function getAccessibleProjectIds(userId: string): Promise<string[]> {
    const [ownedRes, memberRes] = await Promise.all([
        supabase.from('projects').select('id').eq('merchant_id', userId),
        supabase.from('branch_members').select('project_id').eq('user_id', userId),
    ]);

    const ids = new Set<string>();
    for (const r of ownedRes.data ?? []) ids.add(r.id);
    for (const r of memberRes.data ?? []) ids.add(r.project_id);
    return Array.from(ids);
}

/**
 * Determina el rol del user sobre un proyecto:
 *   - 'owner'   si el user es el merchant_id del proyecto
 *   - 'cashier' si tiene una fila en branch_members con ese rol
 *   - null      si no tiene acceso
 */
export async function getUserRoleForProject(
    userId: string,
    projectId: string,
): Promise<BranchRole | null> {
    const { data: owned } = await supabase
        .from('projects')
        .select('id')
        .eq('id', projectId)
        .eq('merchant_id', userId)
        .maybeSingle();
    if (owned) return 'owner';

    const { data: member } = await supabase
        .from('branch_members')
        .select('role')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .maybeSingle();
    if (member) return member.role as BranchRole;
    return null;
}

/** Genera un token aleatorio URL-safe para el link de invitación. */
export function generateInviteToken(): string {
    return randomBytes(24).toString('base64url');
}

/** Fecha por defecto de expiración: 7 días. */
export function defaultInviteExpiry(): Date {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d;
}
