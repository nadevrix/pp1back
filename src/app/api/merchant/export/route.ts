import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';
import { earliestExportDate, isTier, type Tier } from '@/lib/tiers';

// Export CSV de movimientos del comercio.
//
// Query params:
//   from        — ISO date (inclusive). Si no se pasa, default = ventana máxima del tier.
//   to          — ISO date (inclusive). Default = ahora.
//   status      — filtra por estado.
//   branch_id   — filtra por sucursal (debe pertenecer al merchant).
//
// La ventana hacia atrás se acota por tier (free=3m, starter=6m, growth/scale=todo).
// Si el `from` solicitado es más viejo que lo permitido, se trunca silenciosamente
// y se devuelve la fecha efectiva en el header `x-pollar-export-from`.

const MAX_ROWS = 50_000; // límite duro contra accidentes; Vercel soporta varias MB de body
const CSV_HEADER = [
    'transaction_id',
    'created_at',
    'status',
    'reason',
    'branch',
    'asset',
    'amount_paid',
    'fee_amount',
    'payout_amount',
    'tier_at_time',
    'is_free_tx',
    'forward_tx_hash',
    'crypto_tx_hash',
    'wallet_pubkey',
].join(',');

function csvEscape(value: unknown): string {
    if (value === null || value === undefined) return '';
    const s = String(value);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

export async function GET(request: Request) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Tier del comercio para acotar la ventana
        const { data: profile } = await supabase
            .from('profiles')
            .select('tier')
            .eq('id', user.id)
            .single();
        const tier: Tier = isTier(profile?.tier) ? profile!.tier : 'free';

        const now = new Date();
        const tierEarliest = earliestExportDate(tier, now);

        const { searchParams } = new URL(request.url);
        const status = searchParams.get('status');
        const branchId = searchParams.get('branch_id');

        let fromDate: Date;
        const fromParam = searchParams.get('from');
        if (fromParam) {
            const parsed = new Date(fromParam);
            if (isNaN(parsed.getTime())) {
                return NextResponse.json({ error: 'Invalid `from` date' }, { status: 400 });
            }
            // Truncar si pidió más allá de la ventana del tier
            fromDate = tierEarliest && parsed < tierEarliest ? tierEarliest : parsed;
        } else {
            // Sin from → arrancamos en la ventana máxima del tier (o epoch si es ilimitado)
            fromDate = tierEarliest ?? new Date(0);
        }

        let toDate: Date = now;
        const toParam = searchParams.get('to');
        if (toParam) {
            const parsed = new Date(toParam);
            if (isNaN(parsed.getTime())) {
                return NextResponse.json({ error: 'Invalid `to` date' }, { status: 400 });
            }
            toDate = parsed;
        }

        if (fromDate > toDate) {
            return NextResponse.json({ error: '`from` must be before `to`' }, { status: 400 });
        }

        // Proyectos del merchant — para filtrar y para resolver branch_name
        const { data: projects } = await supabase
            .from('projects')
            .select('id, name')
            .eq('merchant_id', user.id);
        const ownedIds = new Set((projects ?? []).map(p => p.id));
        if (ownedIds.size === 0) {
            return new NextResponse(CSV_HEADER + '\n', {
                status: 200,
                headers: csvHeaders(now),
            });
        }
        const projectName = new Map((projects ?? []).map(p => [p.id, p.name]));
        const filterIds = branchId && ownedIds.has(branchId) ? [branchId] : Array.from(ownedIds);

        let query = supabase
            .from('transactions')
            .select('id, status, reason, amount_paid, fee_amount, payout_amount, tier_at_time, is_free_tx, asset_code, wallet_pubkey, forward_tx_hash, crypto_tx_hash, project_id, created_at')
            .in('project_id', filterIds)
            .gte('created_at', fromDate.toISOString())
            .lte('created_at', toDate.toISOString())
            .order('created_at', { ascending: false })
            .limit(MAX_ROWS);

        if (status) query = query.eq('status', status);

        const { data: rows, error } = await query;
        if (error) throw error;

        const lines: string[] = [CSV_HEADER];
        for (const r of rows ?? []) {
            lines.push([
                csvEscape(r.id),
                csvEscape(r.created_at),
                csvEscape(r.status),
                csvEscape(r.reason),
                csvEscape(projectName.get(r.project_id) || ''),
                csvEscape(r.asset_code),
                csvEscape(r.amount_paid),
                csvEscape(r.fee_amount),
                csvEscape(r.payout_amount),
                csvEscape(r.tier_at_time),
                csvEscape(r.is_free_tx),
                csvEscape(r.forward_tx_hash),
                csvEscape(r.crypto_tx_hash),
                csvEscape(r.wallet_pubkey),
            ].join(','));
        }

        const body = lines.join('\n') + '\n';
        return new NextResponse(body, { status: 200, headers: csvHeaders(now, fromDate, toDate, tier) });
    } catch (err: any) {
        console.error('Export Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

function csvHeaders(now: Date, fromDate?: Date, toDate?: Date, tier?: Tier): HeadersInit {
    const stamp = now.toISOString().slice(0, 10);
    const headers: Record<string, string> = {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="pollar-pay-${stamp}.csv"`,
        'Cache-Control': 'no-store',
    };
    if (fromDate) headers['x-pollar-export-from'] = fromDate.toISOString();
    if (toDate) headers['x-pollar-export-to'] = toDate.toISOString();
    if (tier) headers['x-pollar-tier'] = tier;
    return headers;
}
