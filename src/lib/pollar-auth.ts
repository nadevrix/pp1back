// ─── Pollar Auth Middleware ───────────────────────────────────────────────────
// Validates api_key against the local projects table.
//
// Authentication modes:
//   1. x-pollar-api-key header (recommended)
//   2. api_key in request body (POST endpoints)
//   3. api_key as query parameter (GET endpoints)
//
// All three resolve to the same lookup against projects.api_key.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from '@/lib/supabase';

/** Result of successful authentication. */
export interface PollarAuthResult {
    projectId: string;
}

/**
 * Validates authentication from a request.
 *
 * Checks for an API key in this priority order:
 *   1. `x-pollar-api-key` header
 *   2. `api_key` in body (passed as bodyApiKey)
 *   3. `api_key` in query string (passed as queryApiKey)
 *
 * @returns The project ID if authenticated, or null if not.
 */
export async function authenticateRequest(
    request: Request,
    bodyApiKey?: string,
    queryApiKey?: string,
): Promise<PollarAuthResult | null> {
    const apiKey =
        request.headers.get('x-pollar-api-key') ||
        bodyApiKey ||
        queryApiKey;

    if (!apiKey) return null;

    const { data: project, error } = await supabase
        .from('projects')
        .select('id')
        .eq('api_key', apiKey)
        .single();

    if (error || !project) return null;

    return { projectId: project.id };
}
