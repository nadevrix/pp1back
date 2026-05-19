// ─── Lista de transacciones con forward fallido ─────────────────────────────
// Las consume el panel admin (/admin/anomalies) para mostrar fondos colgados
// en pool wallets y permitir reintentar el forward (POST /api/admin/tx/[id]/retry-forward).
//
// Criterio: forward_status='failed'. Cuando esto pasa, la wallet del pool queda
// lockeada con los USDC del cliente adentro hasta que un admin reintente.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { validateAdminAuth } from '@/lib/admin-auth';

interface AnomalyRow {
    id: string;
    status: string;
    forward_status: string;
    amount_expected: string | number;
    amount_paid: string | number;
    wallet_pubkey: string | null;
    created_at: string;
    expires_at: string;
    project_id: string;
    reason: string;
    projects: { name: string } | { name: string }[] | null;
}

export async function GET(request: Request) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    try {
        const { data, error } = await supabase
            .from('transactions')
            .select('id, status, forward_status, amount_expected, amount_paid, wallet_pubkey, created_at, expires_at, project_id, reason, projects!project_id(name)')
            .eq('forward_status', 'failed')
            .order('created_at', { ascending: false })
            .limit(200);

        if (error) throw error;

        const rows = (data ?? []) as AnomalyRow[];
        const transactions = rows.map(r => {
            const p = r.projects;
            const project_name = !p ? null : Array.isArray(p) ? p[0]?.name ?? null : p.name;
            return {
                id: r.id,
                status: r.status,
                forward_status: r.forward_status,
                amount_expected: String(r.amount_expected),
                amount_paid: String(r.amount_paid),
                wallet_pubkey: r.wallet_pubkey,
                created_at: r.created_at,
                expires_at: r.expires_at,
                project_id: r.project_id,
                project_name,
                reason: r.reason,
            };
        });

        return NextResponse.json({
            success: true,
            data: {
                count: transactions.length,
                transactions,
            },
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[ADMIN] anomalies list failed:', msg);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
