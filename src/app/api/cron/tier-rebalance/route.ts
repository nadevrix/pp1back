// ─── Cron tier-rebalance ────────────────────────────────────────────────────
// Recalcula el tier correcto para cada merchant.
//
// Llamadas válidas:
//   - Authorization: Bearer <CRON_SECRET>  (Vercel Cron)
//   - x-cron-secret: <CRON_SECRET>          (manual / testing)
//
// Schedule recomendado en vercel.json (o equivalente):
//   { "crons": [{ "path": "/api/cron/tier-rebalance", "schedule": "0 3 * * *" }] }
//   — corre todos los días a las 03:00 UTC
//
// Qué hace (idempotente):
//   - Para cada merchant en tier scale: si scale_paid_until ya venció, baja
//     al tier que justifique su volumen últimos 30 días
//   - Para cada merchant en free/starter/growth: si su volumen últimos 30 días
//     ya no encaja en el rango del tier actual, lo ajusta (puede subir o bajar)
//
// La promoción inline (cuando una tx pasa a completed) cubre el "subir al
// instante". Este cron cubre el "bajar al fin del período" y agarra cualquier
// promoción que el inline haya perdido.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { rebalanceAll } from '@/lib/payments/tier-graduation';

const CRON_SECRET = process.env.CRON_SECRET || '';

export async function GET(request: Request) {
    if (!CRON_SECRET) {
        return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
    }
    const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    const custom = request.headers.get('x-cron-secret');
    if (bearer !== CRON_SECRET && custom !== CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const result = await rebalanceAll();
        // Devolvemos solo los cambios para no inflar el body con cientos de "same_tier"
        const changes = result.results.filter(r => r.changed);
        return NextResponse.json({
            success: true,
            processed: result.processed,
            changed: result.changed,
            changes,
        });
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[CRON] tier-rebalance failed:', msg);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
