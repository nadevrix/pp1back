import { Keypair, TransactionBuilder, Operation } from '@stellar/stellar-sdk';
import { stellarClient, USDC_ASSET, NETWORK_PASSPHRASE } from './client';
import { supabase } from '@/lib/supabase';

export interface ForwardResult {
    /** Stellar hash de la tx con las 1-2 operaciones de payment */
    hash: string;
    /** USDC efectivamente enviados al merchant (= grossAmount - feeAmount) */
    payoutAmount: string;
    /** USDC enviados al treasury (0 si no aplica fee) */
    feeAmount: string;
}

/**
 * Reenvía fondos del pool al merchant. Si feeAmount > 0, hace una sola tx
 * Stellar con 2 operaciones atómicas: payment(merchant, gross-fee) +
 * payment(treasury, fee). Si feeAmount = 0, una sola op al merchant.
 *
 * Atómico: o pasan ambos pagos o ninguno. Si la tx falla, los fondos quedan
 * en el pool y el processor marca forward_status='failed' para retry manual.
 *
 * grossAmount, feeAmount y el monto al merchant se pasan ya formateados con
 * la precisión Stellar (7 decimales) — caller decide el redondeo.
 */
export async function forwardFromPool(
    poolPubkey: string,
    destinationPubkey: string,
    grossAmount: string,
    feeAmount: string = '0',
    treasuryPubkey?: string,
): Promise<ForwardResult> {
    const gross = parseFloat(grossAmount);
    const fee = parseFloat(feeAmount);
    const payout = Math.max(0, gross - fee);
    const payoutStr = payout.toFixed(7);
    const feeStr = fee.toFixed(7);

    console.log(
        `[FORWARDER] ${gross.toFixed(7)} USDC → merchant ${destinationPubkey.slice(0, 8)}... ` +
        `${payoutStr} + treasury ${feeStr} (pool ${poolPubkey.slice(0, 8)}...)`,
    );

    const { data: poolWallet } = await supabase
        .from('wallets')
        .select('secret_key')
        .eq('public_key', poolPubkey)
        .single();

    if (!poolWallet) throw new Error(`Pool wallet not found: ${poolPubkey}`);

    let resolvedTreasury = treasuryPubkey;
    if (fee > 0 && !resolvedTreasury) {
        const { data: t } = await supabase
            .from('wallets')
            .select('public_key')
            .eq('wallet_type', 'treasury')
            .single();
        if (!t) throw new Error('Treasury wallet not configured — cannot collect fee');
        resolvedTreasury = t.public_key;
    }

    const poolKp = Keypair.fromSecret(poolWallet.secret_key);
    const sourceAccount = await stellarClient.loadAccount(poolKp.publicKey());

    // Base fee = 100 stroops por operación. Con 2 ops son 200 stroops total.
    const builder = new TransactionBuilder(sourceAccount, {
        fee: '200',
        networkPassphrase: NETWORK_PASSPHRASE,
    });

    if (payout > 0) {
        builder.addOperation(Operation.payment({
            destination: destinationPubkey,
            asset: USDC_ASSET,
            amount: payoutStr,
        }));
    }
    if (fee > 0 && resolvedTreasury) {
        builder.addOperation(Operation.payment({
            destination: resolvedTreasury,
            asset: USDC_ASSET,
            amount: feeStr,
        }));
    }

    const tx = builder.setTimeout(30).build();
    tx.sign(poolKp);
    const response = await stellarClient.submitTransaction(tx);

    return {
        hash: response.hash,
        payoutAmount: payoutStr,
        feeAmount: feeStr,
    };
}

export async function dispatchRefundFromTreasury(destinationPubkey: string, amount: string): Promise<string> {
    console.log(`[TREASURY] Dispatching refund of ${amount} USDC to ${destinationPubkey}`);

    const { data: treasuryWallet } = await supabase
        .from('wallets')
        .select('secret_key')
        .eq('wallet_type', 'treasury')
        .single();

    if (!treasuryWallet) throw new Error('Treasury wallet not configured');

    const treasuryKp = Keypair.fromSecret(treasuryWallet.secret_key);
    const sourceAccount = await stellarClient.loadAccount(treasuryKp.publicKey());

    const tx = new TransactionBuilder(sourceAccount, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(Operation.payment({
            destination: destinationPubkey,
            asset: USDC_ASSET,
            amount
        }))
        .setTimeout(30)
        .build();

    tx.sign(treasuryKp);
    const response = await stellarClient.submitTransaction(tx);
    return response.hash;
}
