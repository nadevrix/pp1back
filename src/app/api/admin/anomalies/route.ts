// ─── Anomalías para revisión manual del admin ──────────────────────────────
// Devuelve 2 grupos de transacciones que requieren acción del admin:
//
//   1. forward_failures — fondos del cliente colgados en pool wallet porque
//      el reenvío al merchant falló on-chain. Se resuelve con retry-forward.
//
//   2. overpayments — cliente pagó más de lo esperado. El excedente está en
//      la treasury. Como muchos pagos vienen desde Binance/exchanges, no se
//      puede refundear on-chain — se resuelve hablando con el cliente por
//      fuera del sistema (whatsapp, etc) y se marca como resolved.
//
// Las filas con support_resolved_at NOT NULL se filtran (ya las resolviste).
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
    support_resolved_at: string | null;
    projects: { name: string } | { name: string }[] | null;
}

function shapeRow(r: AnomalyRow) {
    const p = r.projects;
    const project_name = !p ? null : Array.isArray(p) ? p[0]?.name ?? null : p.name;
    const expected = parseFloat(String(r.amount_expected));
    const paid = parseFloat(String(r.amount_paid));
    const excess = Math.max(0, paid - expected);
    return {
        id: r.id,
        status: r.status,
        forward_status: r.forward_status,
        amount_expected: expected.toFixed(7),
        amount_paid: paid.toFixed(7),
        excess: excess.toFixed(7),
        wallet_pubkey: r.wallet_pubkey,
        created_at: r.created_at,
        expires_at: r.expires_at,
        project_id: r.project_id,
        project_name,
        reason: r.reason,
        support_resolved_at: r.support_resolved_at,
    };
}

export async function GET(request: Request) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    try {
        // Forward failures — fondos colgados en pool, requieren retry on-chain
        const { data: failures, error: fErr } = await supabase
            .from('transactions')
            .select('id, status, forward_status, amount_expected, amount_paid, wallet_pubkey, created_at, expires_at, project_id, reason, support_resolved_at, projects!project_id(name)')
            .eq('forward_status', 'failed')
            .is('support_resolved_at', null)
            .order('created_at', { ascending: false })
            .limit(200);
        if (fErr) throw fErr;

        // Overpaids no resueltos — excedente en treasury, requieren contacto manual
        const { data: overpaids, error: oErr } = await supabase
            .from('transactions')
            .select('id, status, forward_status, amount_expected, amount_paid, wallet_pubkey, created_at, expires_at, project_id, reason, support_resolved_at, projects!project_id(name)')
            .eq('status', 'overpaid')
            .is('support_resolved_at', null)
            .order('created_at', { ascending: false })
            .limit(200);
        if (oErr) throw oErr;

        // Recientemente resueltos — para mostrar bajo "Deshacer" en el UI por
        // si el admin tildó Comprobado por error. Limit 50.
        const { data: resolved, error: rErr } = await supabase
            .from('transactions')
            .select('id, status, forward_status, amount_expected, amount_paid, wallet_pubkey, created_at, expires_at, project_id, reason, support_resolved_at, projects!project_id(name)')
            .not('support_resolved_at', 'is', null)
            .order('support_resolved_at', { ascending: false })
            .limit(50);
        if (rErr) throw rErr;

        const forward_failures = (failures ?? []).map(r => shapeRow(r as AnomalyRow));
        const overpayments = (overpaids ?? []).map(r => shapeRow(r as AnomalyRow));
        const recently_resolved = (resolved ?? []).map(r => shapeRow(r as AnomalyRow));

        return NextResponse.json({
            success: true,
            data: {
                forward_failures,
                overpayments,
                recently_resolved,
                counts: {
                    forward_failures: forward_failures.length,
                    overpayments: overpayments.length,
                    recently_resolved: recently_resolved.length,
                },
            },
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[ADMIN] anomalies list failed:', msg);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
