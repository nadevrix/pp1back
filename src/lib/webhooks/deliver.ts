// Entrega de un webhook a la URL del comercio.
//   - POST con JSON body
//   - timeout duro de 3 s (importante en Vercel — la request del processor
//     no puede quedarse esperando)
//   - HMAC-SHA256 en x-pollar-signature
//   - actualiza webhook_deliveries con el resultado
//
// Política de retry:
//   - hasta 8 intentos totales
//   - backoff: 1m, 5m, 15m, 1h, 6h, 1d, 2d, 4d (cap)
//   - después de 8 intentos, status='abandoned'
//
// La función no lanza — siempre persiste el resultado y devuelve el delivery
// actualizado. El caller decide si re-intentar inline o esperar al on-poll.

import { supabase } from '@/lib/supabase';
import { signWebhookPayload } from './sign';

const TIMEOUT_MS = 3_000;
const MAX_ATTEMPTS = 8;

// Backoff en minutos. attempt es 1-based.
const BACKOFF_MINUTES = [1, 5, 15, 60, 360, 1440, 2880, 5760];

export interface DeliverableDelivery {
    id: string;
    endpoint_id: string;
    project_id: string;
    event_type: string;
    payload: unknown;
    attempts: number;
    endpoint: {
        url: string;
        secret: string;
        active: boolean;
    } | null;
}

export interface DeliveryOutcome {
    deliveryId: string;
    status: 'delivered' | 'failed' | 'abandoned';
    responseStatus: number | null;
    error?: string;
}

function nextAttemptAt(attempts: number): Date {
    const idx = Math.min(attempts, BACKOFF_MINUTES.length) - 1;
    const minutes = BACKOFF_MINUTES[Math.max(0, idx)];
    return new Date(Date.now() + minutes * 60_000);
}

export async function attemptDelivery(d: DeliverableDelivery): Promise<DeliveryOutcome> {
    if (!d.endpoint || !d.endpoint.active) {
        // Endpoint borrado o desactivado entre que se enqueueó y se intentó
        await supabase
            .from('webhook_deliveries')
            .update({
                status: 'abandoned',
                last_attempt_at: new Date().toISOString(),
                response_body: 'endpoint inactive or deleted',
            })
            .eq('id', d.id);
        return { deliveryId: d.id, status: 'abandoned', responseStatus: null, error: 'endpoint inactive' };
    }

    const attempts = d.attempts + 1;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify(d.payload);
    const signature = signWebhookPayload(d.endpoint.secret, timestamp, body);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let responseStatus: number | null = null;
    let responseBody: string | null = null;
    let success = false;
    let errMsg: string | undefined;

    try {
        const res = await fetch(d.endpoint.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Pollar-Pay-Webhooks/1.0',
                'x-pollar-event': d.event_type,
                'x-pollar-timestamp': timestamp,
                'x-pollar-signature': `sha256=${signature}`,
                'x-pollar-delivery-id': d.id,
            },
            body,
            signal: controller.signal,
        });
        responseStatus = res.status;
        // Sólo guardamos los primeros 500 chars del response (debug, sin llenar la DB)
        try {
            const text = await res.text();
            responseBody = text.slice(0, 500);
        } catch {
            responseBody = null;
        }
        success = res.ok; // 2xx = success
    } catch (e: any) {
        errMsg = e?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : (e?.message || 'unknown');
        responseBody = (errMsg ?? '').slice(0, 500);
    } finally {
        clearTimeout(timer);
    }

    const now = new Date().toISOString();

    if (success) {
        await supabase
            .from('webhook_deliveries')
            .update({
                status: 'delivered',
                attempts,
                last_attempt_at: now,
                delivered_at: now,
                response_status: responseStatus,
                response_body: responseBody,
            })
            .eq('id', d.id);
        return { deliveryId: d.id, status: 'delivered', responseStatus };
    }

    // Falló: decidir si reintentar o abandonar
    if (attempts >= MAX_ATTEMPTS) {
        await supabase
            .from('webhook_deliveries')
            .update({
                status: 'abandoned',
                attempts,
                last_attempt_at: now,
                response_status: responseStatus,
                response_body: responseBody,
            })
            .eq('id', d.id);
        return { deliveryId: d.id, status: 'abandoned', responseStatus, error: errMsg };
    }

    await supabase
        .from('webhook_deliveries')
        .update({
            status: 'pending',
            attempts,
            last_attempt_at: now,
            next_attempt_at: nextAttemptAt(attempts).toISOString(),
            response_status: responseStatus,
            response_body: responseBody,
        })
        .eq('id', d.id);

    return { deliveryId: d.id, status: 'failed', responseStatus, error: errMsg };
}

/**
 * Fetcha un delivery + su endpoint en una sola query.
 */
export async function loadDeliverable(deliveryId: string): Promise<DeliverableDelivery | null> {
    const { data, error } = await supabase
        .from('webhook_deliveries')
        .select('id, endpoint_id, project_id, event_type, payload, attempts, webhook_endpoints!endpoint_id(url, secret, active)')
        .eq('id', deliveryId)
        .single();
    if (error || !data) return null;
    const ep = data.webhook_endpoints as
        | { url: string; secret: string; active: boolean }
        | { url: string; secret: string; active: boolean }[]
        | null;
    const endpoint = Array.isArray(ep) ? ep[0] ?? null : ep;
    return {
        id: data.id,
        endpoint_id: data.endpoint_id,
        project_id: data.project_id,
        event_type: data.event_type,
        payload: data.payload,
        attempts: data.attempts,
        endpoint,
    };
}
