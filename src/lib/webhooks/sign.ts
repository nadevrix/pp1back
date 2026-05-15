// Firma HMAC SHA-256 — el comercio verifica con el mismo secret del lado suyo.
// Header: x-pollar-signature: sha256=<hex>
// Para evitar replay attacks incluimos x-pollar-timestamp y el comercio puede
// rechazar payloads viejos.

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export function generateWebhookSecret(): string {
    // 32 bytes = 256 bits, hex => 64 chars. Lo mostramos una sola vez.
    return 'whsec_' + randomBytes(32).toString('hex');
}

/**
 * Firma el payload con HMAC-SHA256.
 * Formato del string firmado: `${timestamp}.${body}` — protege contra replay
 * y permite que el verificador recree exactamente lo que firmamos.
 */
export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
    const signed = `${timestamp}.${body}`;
    return createHmac('sha256', secret).update(signed).digest('hex');
}

/**
 * Verificación segura del lado del comercio. Exportada por si tiene sentido
 * usarla en algún test o helper interno. Usa timingSafeEqual para evitar
 * timing attacks.
 */
export function verifyWebhookSignature(
    secret: string,
    timestamp: string,
    body: string,
    signature: string,
): boolean {
    const expected = signWebhookPayload(secret, timestamp, body);
    if (expected.length !== signature.length) return false;
    try {
        return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
        return false;
    }
}
