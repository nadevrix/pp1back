import { NextResponse } from 'next/server';
import { processPendingPayments } from '@/lib/payments/processor';
import { flushAllPending } from '@/lib/webhooks/dispatch';

const CRON_SECRET = process.env.CRON_SECRET || '';

// Auth: acepta dos formatos
//   - "Authorization: Bearer <CRON_SECRET>"  (lo manda Vercel Cron automáticamente)
//   - "x-cron-secret: <CRON_SECRET>"         (para curl/testing manual)
export async function GET(request: Request) {
    if (!CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    const custom = request.headers.get('x-cron-secret');
    if (bearer !== CRON_SECRET && custom !== CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // Procesa cobros pendientes + barre webhook deliveries vencidas.
        // Las deliveries van capped a 50 para no exceder el timeout del cron
        // en Vercel (10s Hobby / 60s Pro).
        const [payments, flushed] = await Promise.all([
            processPendingPayments(),
            flushAllPending(50),
        ]);
        return NextResponse.json({
            success: true,
            ...payments,
            webhooks_flushed: flushed,
        });
    } catch (err: any) {
        console.error('[CRON] Payment check failed:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
