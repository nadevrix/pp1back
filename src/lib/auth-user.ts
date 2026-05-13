// ─── Auth helper ────────────────────────────────────────────────────────────
// Valida el access_token de Supabase Auth que el frontend (pollar-web) envía
// en el header `Authorization: Bearer <jwt>`. Devuelve el user de Supabase
// o null si el token es inválido / faltante.
//
// Por qué Bearer y no cookies: pollar-web y pollar-backend corren en
// orígenes distintos (puertos/dominios distintos), así que las cookies de
// Supabase no se comparten automáticamente. El frontend extrae el token de
// su sesión y lo manda en cada request.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, type User } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('[AUTH] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
}

/**
 * Extrae el JWT del header Authorization y resuelve al user.
 * Devuelve null si no hay token, está mal formado, o expiró.
 */
export async function getUserFromRequest(request: Request): Promise<User | null> {
    const authHeader = request.headers.get('authorization') || request.headers.get('Authorization');
    if (!authHeader) return null;

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;

    const token = match[1].trim();
    if (!token) return null;

    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user) return null;

    return data.user;
}
