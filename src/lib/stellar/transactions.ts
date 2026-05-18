import { Keypair, TransactionBuilder, Operation } from '@stellar/stellar-sdk';
import { stellarClient, USDC_ASSET, NETWORK_PASSPHRASE } from './client';
import { supabase } from '@/lib/supabase';

export interface ForwardResult {
    /** Stellar hash de la tx atómica con todas las operaciones */
    hash: string;
    /** USDC efectivamente enviados al merchant (= grossAmount - fee - excess) */
    payoutAmount: string;
    /** USDC enviados al treasury como fee (0 si no aplica) */
    feeAmount: string;
    /** USDC enviados al treasury como excedente (0 si no es overpaid) */
    excessAmount: string;
}

/**
 * Reenvía fondos del pool en una sola tx Stellar atómica con hasta 3 operaciones:
 *
 *   1. payment(merchant, gross - fee - excess)  ← lo que el merchant esperaba menos fee
 *   2. payment(treasury, fee)                   ← tu fee de Pollar Pay
 *   3. payment(treasury, excess)                ← excedente cuando hay overpaid
 *
 * Casos:
 *   - Pago exacto: 2 ops (merchant + fee treasury)
 *   - Overpaid: 3 ops (merchant recibe expected−fee, treasury recibe fee+excess
 *     en 2 ops separadas para que se vea en Stellar Expert qué es qué)
 *   - Underpaid en expired: 2 ops igual (merchant recibe received−fee, fee sobre
 *     lo realmente recibido, no hay excess)
 *   - Free tier o gas-only: 1 op (solo al merchant si fee=0 y excess=0)
 *
 * Atómico: o pasan todas o ninguna. Si la tx falla, los fondos quedan en el
 * pool y el processor marca forward_status='failed' para retry manual.
 */
export async function forwardFromPool(
    poolPubkey: string,
    destinationPubkey: string,
    grossAmount: string,
    feeAmount: string = '0',
    excessAmount: string = '0',
    treasuryPubkey?: string,
): Promise<ForwardResult> {
    const gross = parseFloat(grossAmount);
    const fee = parseFloat(feeAmount);
    const excess = parseFloat(excessAmount);
    const payout = Math.max(0, gross - fee - excess);
    const payoutStr = payout.toFixed(7);
    const feeStr = fee.toFixed(7);
    const excessStr = excess.toFixed(7);

    console.log(
        `[FORWARDER] ${gross.toFixed(7)} USDC → merchant ${destinationPubkey.slice(0, 8)}... ` +
        `${payoutStr} + treasury(fee) ${feeStr}` +
        (excess > 0 ? ` + treasury(excess) ${excessStr}` : '') +
        ` (pool ${poolPubkey.slice(0, 8)}...)`,
    );

    const { data: poolWallet } = await supabase
        .from('wallets')
        .select('secret_key')
        .eq('public_key', poolPubkey)
        .single();

    if (!poolWallet) throw new Error(`Pool wallet not found: ${poolPubkey}`);
    if (!poolWallet.secret_key) throw new Error(`Pool wallet ${poolPubkey} has no secret_key — cannot sign forward`);

    let resolvedTreasury = treasuryPubkey;
    if ((fee > 0 || excess > 0) && !resolvedTreasury) {
        const { data: t } = await supabase
            .from('wallets')
            .select('public_key')
            .eq('wallet_type', 'treasury')
            .single();
        if (!t) throw new Error('Treasury wallet not configured — cannot collect fee/excess');
        resolvedTreasury = t.public_key;
    }

    const poolKp = Keypair.fromSecret(poolWallet.secret_key);
    const sourceAccount = await stellarClient.loadAccount(poolKp.publicKey());

    // 100 stroops por operación. Hasta 3 ops = 300 stroops total ≈ $0.000007.
    const builder = new TransactionBuilder(sourceAccount, {
        fee: '300',
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
    if (excess > 0 && resolvedTreasury) {
        builder.addOperation(Operation.payment({
            destination: resolvedTreasury,
            asset: USDC_ASSET,
            amount: excessStr,
        }));
    }

    const tx = builder.setTimeout(30).build();
    tx.sign(poolKp);
    const response = await stellarClient.submitTransaction(tx);

    return {
        hash: response.hash,
        payoutAmount: payoutStr,
        feeAmount: feeStr,
        excessAmount: excessStr,
    };
}

/**
 * Reembolsa USDC desde la treasury a una wallet destino.
 *
 * Requiere que la treasury tenga `secret_key` cargada en la DB. Por
 * default Pollar Pay guarda solo la pubkey de la treasury (ver
 * database/seeds/pollar-pay-treasury.sql) y los refunds se hacen
 * manualmente importando la secret en Lobstr/Albedo. Si querés que el
 * backend pueda refundear automático, agregá la secret en el SQL del
 * treasury seed antes de aplicarlo.
 */
export async function dispatchRefundFromTreasury(destinationPubkey: string, amount: string): Promise<string> {
    console.log(`[TREASURY] Dispatching refund of ${amount} USDC to ${destinationPubkey}`);

    const { data: treasuryWallet } = await supabase
        .from('wallets')
        .select('secret_key')
        .eq('wallet_type', 'treasury')
        .single();

    if (!treasuryWallet) throw new Error('Treasury wallet not configured');
    if (!treasuryWallet.secret_key) {
        throw new Error(
            'Treasury secret_key is null — automatic refunds disabled. ' +
            'Hacé el refund manualmente importando la secret de tu treasury en Lobstr/Albedo.',
        );
    }

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
