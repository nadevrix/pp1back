import { NextResponse } from 'next/server';
import { processPendingPayments } from '@/lib/payments/processor';

const CRON_SECRET = process.env.CRON_SECRET || '';

// Call this endpoint every 5-10 seconds via Vercel Cron, an external scheduler, or curl.
// Header required: x-cron-secret: <CRON_SECRET>
export async function GET(request: Request) {
    if (!CRON_SECRET || request.headers.get('x-cron-secret') !== CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const result = await processPendingPayments();
        return NextResponse.json({ success: true, ...result });
    } catch (err: any) {
        console.error('[CRON] Payment check failed:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
