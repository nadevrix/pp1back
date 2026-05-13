// ─── Payment worker ─────────────────────────────────────────────────────────
// Mantiene suscripciones SSE a Horizon para cada wallet del pool con tx
// pending. Cuando llega un pago, dispara el procesamiento al instante.
// Adicionalmente corre un poll de fallback cada 30s para:
//   - Manejar transacciones expiradas (timer venció sin pago)
//   - Re-sincronizar suscripciones (nueva tx, tx finalizada, restart)
//   - Atrapar pagos que el stream haya perdido
//
// Arranca desde src/instrumentation.ts cuando el server inicia.
// Solo corre en runtime nodejs (no edge) y solo una instancia por proceso.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from '@/lib/supabase';
import { stellarClient } from '@/lib/stellar/client';
import {
    processPendingPayments,
    processSingleTransaction,
    type PendingTx,
} from '@/lib/payments/processor';

const POLL_INTERVAL_MS = parseInt(process.env.WORKER_POLL_INTERVAL_MS || '30000', 10);

// wallet_pubkey -> función para cerrar el stream SSE
const subscriptions = new Map<string, () => void>();

// Locks por tx para evitar que SSE y poll procesen la misma tx simultáneamente
const processing = new Set<string>();

async function fetchPendingTxsForWallet(walletPubkey: string): Promise<PendingTx[]> {
    const { data, error } = await supabase
        .from('transactions')
        .select('id, wallet_pubkey, amount_expected, amount_paid, expires_at, created_at, project_id, projects!project_id(payout_wallet)')
        .eq('wallet_pubkey', walletPubkey)
        .eq('status', 'pending');

    if (error) {
        console.error(`[WORKER] Failed to fetch pending tx for wallet ${walletPubkey.slice(0, 8)}:`, error.message);
        return [];
    }
    return (data ?? []) as PendingTx[];
}

async function processWallet(walletPubkey: string) {
    const txs = await fetchPendingTxsForWallet(walletPubkey);
    if (txs.length === 0) {
        removeSubscription(walletPubkey);
        return;
    }

    const now = new Date();
    for (const tx of txs) {
        if (processing.has(tx.id)) continue;
        processing.add(tx.id);
        try {
            const result = await processSingleTransaction(tx, now);
            console.log(`[WORKER] tx ${tx.id.slice(0, 8)} -> ${result.status}`);
        } catch (e: any) {
            console.error(`[WORKER] processSingleTransaction failed for ${tx.id}:`, e.message);
        } finally {
            processing.delete(tx.id);
        }
    }

    const remaining = await fetchPendingTxsForWallet(walletPubkey);
    if (remaining.length === 0) removeSubscription(walletPubkey);
}

function ensureSubscription(walletPubkey: string) {
    if (subscriptions.has(walletPubkey)) return;

    console.log(`[WORKER] Subscribing to ${walletPubkey.slice(0, 8)}...`);

    const stop = stellarClient.payments()
        .forAccount(walletPubkey)
        .cursor('now')
        .stream({
            onmessage: (record: unknown) => {
                const r = record as { type?: string; to?: string };
                if (r.type !== 'payment') return;
                if (r.to !== walletPubkey) return;
                processWallet(walletPubkey).catch(e =>
                    console.error(`[WORKER] processWallet failed:`, e.message));
            },
            onerror: (err: unknown) => {
                console.error(`[WORKER] SSE error for ${walletPubkey.slice(0, 8)}:`,
                    err instanceof Error ? err.message : String(err));
                // SDK reconecta solo. Si no, el poll de fallback re-suscribirá.
            },
        });

    subscriptions.set(walletPubkey, stop);
}

function removeSubscription(walletPubkey: string) {
    const stop = subscriptions.get(walletPubkey);
    if (!stop) return;
    try { stop(); } catch { /* noop */ }
    subscriptions.delete(walletPubkey);
    console.log(`[WORKER] Unsubscribed from ${walletPubkey.slice(0, 8)}`);
}

async function syncSubscriptions() {
    const { data, error } = await supabase
        .from('transactions')
        .select('wallet_pubkey')
        .eq('status', 'pending');

    if (error) {
        console.error('[WORKER] syncSubscriptions failed:', error.message);
        return;
    }

    const active = new Set<string>();
    for (const row of data ?? []) {
        if (row.wallet_pubkey) active.add(row.wallet_pubkey);
    }

    for (const w of active) ensureSubscription(w);
    for (const w of Array.from(subscriptions.keys())) {
        if (!active.has(w)) removeSubscription(w);
    }
}

let started = false;
let pollHandle: ReturnType<typeof setInterval> | null = null;

export function startWorker() {
    if (started) return;
    started = true;

    console.log(`[WORKER] Starting payment worker (SSE + fallback poll every ${POLL_INTERVAL_MS}ms)`);

    syncSubscriptions().catch(e =>
        console.error('[WORKER] initial sync failed:', e.message));

    pollHandle = setInterval(async () => {
        try {
            await syncSubscriptions();
            await processPendingPayments();
        } catch (e: any) {
            console.error('[WORKER] poll cycle failed:', e.message);
        }
    }, POLL_INTERVAL_MS);

    const shutdown = () => {
        console.log('[WORKER] Shutting down...');
        if (pollHandle) clearInterval(pollHandle);
        for (const w of Array.from(subscriptions.keys())) removeSubscription(w);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}
