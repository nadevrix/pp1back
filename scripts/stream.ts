import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';
import Decimal from 'decimal.js';
import { forwardToTreasury, USDC_ISSUER, server } from '../src/lib/forwarder';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── Payment Handler ───────────────────────────────────────────────

async function handleIncomingPayment(payment: any) {
    if (payment.type !== 'payment') return;

    // CRITICAL: Only process USDC payments, ignore XLM or other tokens
    if (payment.asset_type === 'native') {
        console.log(`[IGNORED] Native XLM payment on ${payment.to}, skipping.`);
        return;
    }
    if (payment.asset_code !== 'USDC' || payment.asset_issuer !== USDC_ISSUER) {
        console.warn(`[IGNORED] Non-USDC asset (${payment.asset_code}/${payment.asset_issuer}) on ${payment.to}`);
        return;
    }

    const receiverWallet = payment.to;
    const amountReceived = new Decimal(payment.amount);

    console.log(`[STREAM] Detected USDC payment of ${amountReceived.toString()} to ${receiverWallet}`);

    const { data: tx, error: txError } = await supabase
        .from('transactions')
        .select('*')
        .eq('wallet_pubkey', receiverWallet)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    if (txError || !tx) {
        console.warn(`[ANOMALY] Unmapped payment on ${receiverWallet}. Sweeping to Treasury...`);
        await forwardToTreasury(receiverWallet, amountReceived.toString(), 'UNMAPPED_LATE_PAYMENT');
        return;
    }

    const expectedAmount = new Decimal(tx.amount_expected);

    // Check if the payment arrived after the 15-minute lock expired
    const isLate = new Date() > new Date(tx.expires_at);
    if (isLate) {
        console.warn(`[LATE ANOMALY] Payment arrived after 15m expiration for Tx ${tx.id}. Sweeping to Treasury...`);
        await supabase.from('transactions').update({ status: 'late_anomaly', amount_paid: amountReceived.toString(), crypto_tx_hash: payment.transaction_hash }).eq('id', tx.id);
        await forwardToTreasury(receiverWallet, amountReceived.toString(), `LATE_TX_${tx.id}`);
        return;
    }

    const previouslyPaid = new Decimal(tx.amount_paid || '0');
    const newTotalPaid = previouslyPaid.plus(amountReceived);

    console.log(`[STATUS] Expected: ${expectedAmount.toString()}, Paid So Far: ${newTotalPaid.toString()}`);

    if (newTotalPaid.greaterThanOrEqualTo(expectedAmount)) {
        const isOverpaid = newTotalPaid.greaterThan(expectedAmount);
        const status = isOverpaid ? 'overpaid' : 'completed';
        const excess = isOverpaid ? newTotalPaid.minus(expectedAmount).toString() : '0';

        console.log(`[${status.toUpperCase()}] Tx ${tx.id}${isOverpaid ? ` — Excess: ${excess} USDC` : ''}`);

        await supabase.from('transactions').update({
            status,
            amount_paid: newTotalPaid.toString(),
            crypto_tx_hash: payment.transaction_hash
        }).eq('id', tx.id);

        // Unlock wallet for Round Robin reuse
        await supabase.from('wallets').update({ is_locked: false, locked_until: null }).eq('public_key', receiverWallet);

        // Forward collected funds to Treasury
        await forwardToTreasury(receiverWallet, newTotalPaid.toString(), `${status.toUpperCase()}_TX_${tx.id}`);
    } else {
        const remaining = expectedAmount.minus(newTotalPaid);
        console.log(`[PARTIAL] Partial payment for Tx ${tx.id}. Remaining: ${remaining.toString()} USDC. Waiting...`);
        await supabase.from('transactions').update({
            amount_paid: newTotalPaid.toString(),
            crypto_tx_hash: payment.transaction_hash
        }).eq('id', tx.id);
        // Do NOT unlock the wallet — keep waiting for remaining payments
    }
}

// ─── Expiration Sweep ──────────────────────────────────────────────
// Runs every 60 seconds: marks expired pending transactions and unlocks their wallets

async function sweepExpiredTransactions() {
    const now = new Date().toISOString();

    const { data: expired, error } = await supabase
        .from('transactions')
        .select('id, wallet_pubkey, amount_paid')
        .eq('status', 'pending')
        .lt('expires_at', now);

    if (error || !expired || expired.length === 0) return;

    console.log(`[SWEEP] Found ${expired.length} expired transaction(s), cleaning up...`);

    for (const tx of expired) {
        const amountPaid = new Decimal(tx.amount_paid || '0');

        if (amountPaid.greaterThan(0)) {
            // Partial payment was made but expired — mark as underpaid anomaly
            console.warn(`[SWEEP] Tx ${tx.id} expired with partial payment of ${amountPaid.toString()} USDC. Sweeping to Treasury.`);
            await supabase.from('transactions').update({ status: 'underpaid' }).eq('id', tx.id);
            await forwardToTreasury(tx.wallet_pubkey, amountPaid.toString(), `UNDERPAID_EXPIRED_TX_${tx.id}`);
        } else {
            // No payment was made at all — simply expire
            console.log(`[SWEEP] Tx ${tx.id} expired with no payment. Marking as expired.`);
            await supabase.from('transactions').update({ status: 'expired' }).eq('id', tx.id);
        }

        // Unlock the wallet regardless
        await supabase.from('wallets').update({ is_locked: false, locked_until: null }).eq('public_key', tx.wallet_pubkey);
    }
}

// ─── Stream Startup ────────────────────────────────────────────────

const monitoredWallets = new Set<string>();

function startWalletStream(publicKey: string) {
    if (monitoredWallets.has(publicKey)) return;
    monitoredWallets.add(publicKey);

    server.payments().forAccount(publicKey).cursor('now').stream({
        onmessage: (payment: any) => handleIncomingPayment(payment).catch(console.error),
        onerror: (error: any) => console.error(`[STREAM ERROR] ${publicKey}:`, error)
    });
    console.log(`   📡 Stream active for ${publicKey}`);
}

async function refreshWalletStreams() {
    const { data: wallets } = await supabase.from('wallets').select('public_key').eq('wallet_type', 'pool');
    if (!wallets) return;

    let newCount = 0;
    for (const w of wallets) {
        if (!monitoredWallets.has(w.public_key)) {
            startWalletStream(w.public_key);
            newCount++;
        }
    }
    if (newCount > 0) {
        console.log(`[REFRESH] Added ${newCount} new wallet stream(s). Total monitored: ${monitoredWallets.size}`);
    }
}

async function startStream() {
    console.log("🚀 Starting Pollar-Pay SSE Stream Listener...");
    const { data: wallets } = await supabase.from('wallets').select('public_key').eq('wallet_type', 'pool');
    if (!wallets || wallets.length === 0) {
        console.error("❌ No pool wallets found. Run setup-wallets.ts first.");
        return process.exit(1);
    }

    console.log(`📡 Opening streams for ${wallets.length} pool wallet(s)...`);
    wallets.forEach((w) => startWalletStream(w.public_key));

    // Every 60 seconds: sweep expired transactions + detect new wallets
    setInterval(async () => {
        await sweepExpiredTransactions().catch(console.error);
        await refreshWalletStreams().catch(console.error);
    }, 60_000);

    console.log("⏰ Expiration sweep + wallet refresh active (every 60s)");
}

startStream().catch(console.error);
