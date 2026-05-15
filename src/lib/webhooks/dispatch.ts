// Punto de entrada que usan otros módulos (processor, manual-complete) para
// "emitir un evento". La función:
//   1. Encuentra los endpoints activos del proyecto.
//   2. Inserta una row por endpoint en webhook_deliveries.
//   3. Intenta la entrega inline (best-effort, sin bloquear demasiado).
//
// Vercel-friendly: si la entrega inline tarda más de TIMEOUT_MS, queda como
// pending y el siguiente /api/sdk/status la flushea.

import { supabase } from '@/lib/supabase';
import { attemptDelivery, loadDeliverable } from './deliver';

export type WebhookEvent =
    | 'payment.completed'
    | 'payment.overpaid'
    | 'payment.underpaid'
    | 'payment.expired'
    | 'payment.anomaly';

export interface WebhookEventPayload {
    event: WebhookEvent;
    transaction: {
        id: string;
        status: string;
        reason: string;
        asset: string;
        amount_expected: string;
        amount_paid: string;
        fee_amount?: string;
        payout_amount?: string;
        wallet_address: string | null;
        forward_tx_hash: string | null;
        created_at: string;
    };
    project_id: string;
    timestamp: string; // ISO
}

interface DispatchInput {
    projectId: string;
    transactionId: string;
    event: WebhookEvent;
    payload: WebhookEventPayload;
}

/**
 * Inserta deliveries para todos los endpoints activos del proyecto y dispara
 * el primer intento en paralelo. No throwea — los errores se loguean y la
 * delivery queda como pending para el siguiente flush.
 */
export async function dispatchEvent(input: DispatchInput): Promise<void> {
    const { data: endpoints, error } = await supabase
        .from('webhook_endpoints')
        .select('id')
        .eq('project_id', input.projectId)
        .eq('active', true);

    if (error) {
        console.error('[WEBHOOKS] failed to load endpoints', error.message);
        return;
    }
    if (!endpoints || endpoints.length === 0) return;

    // Crear las rows de delivery
    const inserts = endpoints.map(ep => ({
        endpoint_id: ep.id,
        project_id: input.projectId,
        transaction_id: input.transactionId,
        event_type: input.event,
        payload: input.payload,
        status: 'pending',
    }));

    const { data: inserted, error: insErr } = await supabase
        .from('webhook_deliveries')
        .insert(inserts)
        .select('id');

    if (insErr) {
        console.error('[WEBHOOKS] failed to insert deliveries', insErr.message);
        return;
    }
    if (!inserted) return;

    // Inline best-effort. allSettled para que un endpoint lento no bloquee
    // a los otros. Cada attemptDelivery tiene su propio timeout interno.
    await Promise.allSettled(
        inserted.map(async d => {
            const full = await loadDeliverable(d.id);
            if (!full) return;
            await attemptDelivery(full);
        }),
    );
}

/**
 * Flushea entregas pending del proyecto cuyo next_attempt_at ya pasó.
 * Llamado desde /api/sdk/status para aprovechar el polling que ya hace el
 * checkout — mismo patrón que tenemos con Horizon.
 *
 * limit acota el trabajo por request para no exceder timeouts de Vercel.
 */
export async function flushPendingForProject(projectId: string, limit = 5): Promise<number> {
    const { data: due, error } = await supabase
        .from('webhook_deliveries')
        .select('id')
        .eq('project_id', projectId)
        .eq('status', 'pending')
        .lte('next_attempt_at', new Date().toISOString())
        .order('next_attempt_at', { ascending: true })
        .limit(limit);

    if (error || !due || due.length === 0) return 0;

    await Promise.allSettled(
        due.map(async d => {
            const full = await loadDeliverable(d.id);
            if (!full) return;
            await attemptDelivery(full);
        }),
    );
    return due.length;
}

/**
 * Flush global — uso del cron diario para barrer rezagados.
 */
export async function flushAllPending(limit = 50): Promise<number> {
    const { data: due, error } = await supabase
        .from('webhook_deliveries')
        .select('id')
        .eq('status', 'pending')
        .lte('next_attempt_at', new Date().toISOString())
        .order('next_attempt_at', { ascending: true })
        .limit(limit);

    if (error || !due || due.length === 0) return 0;

    await Promise.allSettled(
        due.map(async d => {
            const full = await loadDeliverable(d.id);
            if (!full) return;
            await attemptDelivery(full);
        }),
    );
    return due.length;
}

/**
 * Helper para que el caller del processor arme el payload sin duplicar shape.
 */
export function buildPaymentEventPayload(opts: {
    event: WebhookEvent;
    projectId: string;
    transaction: {
        id: string;
        status: string;
        reason: string;
        asset_code?: string | null;
        amount_expected: number | string;
        amount_paid: number | string;
        fee_amount?: number | string | null;
        payout_amount?: number | string | null;
        wallet_pubkey?: string | null;
        forward_tx_hash?: string | null;
        created_at: string;
    };
}): WebhookEventPayload {
    const t = opts.transaction;
    return {
        event: opts.event,
        project_id: opts.projectId,
        timestamp: new Date().toISOString(),
        transaction: {
            id: t.id,
            status: t.status,
            reason: t.reason,
            asset: t.asset_code || 'USDC',
            amount_expected: String(t.amount_expected),
            amount_paid: String(t.amount_paid),
            fee_amount: t.fee_amount != null ? String(t.fee_amount) : undefined,
            payout_amount: t.payout_amount != null ? String(t.payout_amount) : undefined,
            wallet_address: t.wallet_pubkey ?? null,
            forward_tx_hash: t.forward_tx_hash ?? null,
            created_at: t.created_at,
        },
    };
}
