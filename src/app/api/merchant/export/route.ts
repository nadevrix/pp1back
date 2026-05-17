import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';
import { earliestExportDate, isTier, type Tier } from '@/lib/tiers';
import {
    rowsToCsv,
    rowsToPdf,
    rowsToXlsx,
    type ExportRow,
    type ExportMeta,
} from '@/lib/export-formatters';

// Export de movimientos del comercio en CSV / XLSX / PDF.
//
// Query params:
//   format      — 'csv' (default) | 'xlsx' | 'pdf'
//   from        — ISO date (inclusive). Si no se pasa, ventana máxima del tier.
//   to          — ISO date (inclusive). Default = ahora.
//   status      — filtra por estado.
//   branch_id   — filtra por sucursal (debe pertenecer al merchant).
//
// La ventana hacia atrás se acota por tier (free=3m, starter=6m, growth/scale=todo).

const MAX_ROWS = 50_000;

type Format = 'csv' | 'xlsx' | 'pdf';

function parseFormat(raw: string | null): Format {
    if (raw === 'xlsx' || raw === 'pdf') return raw;
    return 'csv';
}

export async function GET(request: Request) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { data: profile } = await supabase
            .from('profiles')
            .select('tier, email')
            .eq('id', user.id)
            .single();
        const tier: Tier = isTier(profile?.tier) ? profile!.tier : 'free';

        const now = new Date();
        const tierEarliest = earliestExportDate(tier, now);

        const { searchParams } = new URL(request.url);
        const status = searchParams.get('status');
        const branchId = searchParams.get('branch_id');
        const format = parseFormat(searchParams.get('format'));

        let fromDate: Date;
        const fromParam = searchParams.get('from');
        if (fromParam) {
            const parsed = new Date(fromParam);
            if (isNaN(parsed.getTime())) {
                return NextResponse.json({ error: 'Invalid `from` date' }, { status: 400 });
            }
            fromDate = tierEarliest && parsed < tierEarliest ? tierEarliest : parsed;
        } else {
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

        const { data: projects } = await supabase
            .from('projects')
            .select('id, name')
            .eq('merchant_id', user.id);
        const ownedIds = new Set((projects ?? []).map(p => p.id));
        const projectName = new Map((projects ?? []).map(p => [p.id, p.name]));

        let rows: ExportRow[] = [];
        if (ownedIds.size > 0) {
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

            const { data: dbRows, error } = await query;
            if (error) throw error;

            rows = (dbRows ?? []).map(r => ({
                transaction_id: r.id,
                created_at: r.created_at,
                status: r.status,
                reason: r.reason,
                branch: projectName.get(r.project_id) || '',
                asset: r.asset_code,
                amount_paid: r.amount_paid,
                fee_amount: r.fee_amount,
                payout_amount: r.payout_amount,
                tier_at_time: r.tier_at_time,
                is_free_tx: r.is_free_tx,
                forward_tx_hash: r.forward_tx_hash,
                crypto_tx_hash: r.crypto_tx_hash,
                wallet_pubkey: r.wallet_pubkey,
            }));
        }

        const meta: ExportMeta = {
            merchantEmail: profile?.email ?? user.id,
            from: fromDate,
            to: toDate,
            tier,
            generatedAt: now,
        };

        const stamp = now.toISOString().slice(0, 10);

        if (format === 'xlsx') {
            const buf = await rowsToXlsx(rows, meta);
            return new NextResponse(new Uint8Array(buf), {
                status: 200,
                headers: {
                    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    'Content-Disposition': `attachment; filename="pollar-pay-${stamp}.xlsx"`,
                    'Cache-Control': 'no-store',
                    'x-pollar-export-from': fromDate.toISOString(),
                    'x-pollar-export-to': toDate.toISOString(),
                    'x-pollar-tier': tier,
                },
            });
        }

        if (format === 'pdf') {
            const buf = await rowsToPdf(rows, meta);
            return new NextResponse(new Uint8Array(buf), {
                status: 200,
                headers: {
                    'Content-Type': 'application/pdf',
                    'Content-Disposition': `attachment; filename="pollar-pay-${stamp}.pdf"`,
                    'Cache-Control': 'no-store',
                    'x-pollar-export-from': fromDate.toISOString(),
                    'x-pollar-export-to': toDate.toISOString(),
                    'x-pollar-tier': tier,
                },
            });
        }

        const body = rowsToCsv(rows);
        return new NextResponse(body, {
            status: 200,
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="pollar-pay-${stamp}.csv"`,
                'Cache-Control': 'no-store',
                'x-pollar-export-from': fromDate.toISOString(),
                'x-pollar-export-to': toDate.toISOString(),
                'x-pollar-tier': tier,
            },
        });
    } catch (err: any) {
        console.error('Export Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
