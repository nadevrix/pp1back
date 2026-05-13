import { Keypair, TransactionBuilder, Operation } from '@stellar/stellar-sdk';
import { stellarClient, USDC_ASSET, NETWORK_PASSPHRASE } from './client';
import { supabase } from '@/lib/supabase';
import { decryptKey } from '@/lib/crypto';

export async function forwardFromPool(poolPubkey: string, destinationPubkey: string, amount: string): Promise<string> {
    console.log(`[FORWARDER] Moving ${amount} USDC from pool ${poolPubkey.slice(0, 8)}... to ${destinationPubkey.slice(0, 8)}...`);

    const { data: poolWallet } = await supabase
        .from('wallets')
        .select('secret_key_encrypted')
        .eq('public_key', poolPubkey)
        .single();

    if (!poolWallet) throw new Error(`Pool wallet not found: ${poolPubkey}`);

    const poolKp = Keypair.fromSecret(decryptKey(poolWallet.secret_key_encrypted));
    const sourceAccount = await stellarClient.loadAccount(poolKp.publicKey());

    const tx = new TransactionBuilder(sourceAccount, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(Operation.payment({
            destination: destinationPubkey,
            asset: USDC_ASSET,
            amount
        }))
        .setTimeout(30)
        .build();

    tx.sign(poolKp);
    const response = await stellarClient.submitTransaction(tx);
    return response.hash;
}

export async function dispatchRefundFromTreasury(destinationPubkey: string, amount: string): Promise<string> {
    console.log(`[TREASURY] Dispatching refund of ${amount} USDC to ${destinationPubkey}`);

    const { data: treasuryWallet } = await supabase
        .from('wallets')
        .select('secret_key_encrypted')
        .eq('wallet_type', 'treasury')
        .single();

    if (!treasuryWallet) throw new Error('Treasury wallet not configured');

    const treasuryKp = Keypair.fromSecret(decryptKey(treasuryWallet.secret_key_encrypted));
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
