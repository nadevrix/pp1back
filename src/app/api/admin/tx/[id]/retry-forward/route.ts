import { NextResponse } from 'next/server';
import { retryForward } from '@/lib/payments/processor';

const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY || '';

/**
 * Reintenta el forward de una tx cuya pool wallet quedó con fondos colgados
 * porque el forward original falló (forward_status === 'failed', status === 'anomaly').
 *
 * Auth: header X-Admin-Secret: <ADMIN_SECRET_KEY>
 *
 * Si pasa el forward:
 *   - status pasa a completed / overpaid
 *   - forward_status pasa a completed
 *   - se libera la pool wallet para que vuelva al round robin
 *
 * Si vuelve a fallar:
 *   - los campos quedan como estaban (la wallet sigue lockeada con los fondos)
 *   - devuelve el motivo del fallo
 */
export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    if (!ADMIN_SECRET) {
        return NextResponse.json({ error: 'ADMIN_SECRET_KEY not configured' }, { status: 500 });
    }
    const provided = request.headers.get('x-admin-secret');
    if (provided !== ADMIN_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { id } = await params;
        const result = await retryForward(id);

        const httpStatus = result.status === 'completed' || result.status === 'overpaid' ? 200 : 400;
        return NextResponse.json({ success: httpStatus === 200, ...result }, { status: httpStatus });
    } catch (err: any) {
        console.error('[ADMIN] retry-forward failed:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
