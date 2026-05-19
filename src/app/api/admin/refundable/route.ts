// ─── Lista de transacciones con saldo refundable ────────────────────────────
// Las consume el panel admin (/admin/treasury) para mostrar overpaids
// pendientes de devolución al cliente final. Cuando un cliente paga más
// de lo esperado, el comercio recibe solo lo cobrado y el excedente queda
// en la treasury hasta que el cliente reclame por soporte.
//
// El UUID interno (transactions.id) que pide /api/admin/refund no es visible
// al cliente, por eso lo listamos acá con datos suficientes para que el admin
// matchee con la persona que está reclamando.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { validateAdminAuth } from '@/lib/admin-auth';

interface RefundableRow {
    id: string;
    status: string;
    amount_expected: string | number;
    amount_paid: string | number;
    wallet_pubkey: string | null;
    crypto_tx_hash: string | null;
    forward_tx_hash: string | null;
    created_at: string;
    project_id: string;
    reason: string;
    projects: { name: string } | { name: string }[] | null;
}

export async function GET(request: Request) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    try {
        // status='overpaid' significa que el comercio recibió lo esperado y el
        // excedente está retenido en la treasury. status='refunded' ya se devolvió,
        // queda excluido.
        const { data, error } = await supabase
            .from('transactions')
            .select('id, status, amount_expected, amount_paid, wallet_pubkey, crypto_tx_hash, forward_tx_hash, created_at, project_id, reason, projects!project_id(name)')
            .eq('status', 'overpaid')
            .order('created_at', { ascending: false })
            .limit(200);

        if (error) throw error;

        const rows = (data ?? []) as RefundableRow[];
        const transactions = rows.map(r => {
            const p = r.projects;
            const project_name = !p ? null : Array.isArray(p) ? p[0]?.name ?? null : p.name;
            const expected = parseFloat(String(r.amount_expected));
            const paid = parseFloat(String(r.amount_paid));
            const excess = Math.max(0, paid - expected);
            return {
                id: r.id,
                status: r.status,
                amount_expected: expected.toFixed(7),
                amount_paid: paid.toFixed(7),
                excess: excess.toFixed(7),
                wallet_pubkey: r.wallet_pubkey,
                crypto_tx_hash: r.crypto_tx_hash,
                forward_tx_hash: r.forward_tx_hash,
                created_at: r.created_at,
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
        console.error('[ADMIN] refundable list failed:', msg);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
