import { Horizon, Keypair, TransactionBuilder, Operation, Asset, Networks } from '@stellar/stellar-sdk';
import { supabase } from './supabase';
import { decryptKey } from './crypto';

const HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;

// USDC on Stellar Testnet — change issuer for mainnet (Circle's official issuer)
const USDC_ISSUER = process.env.STELLAR_USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_ASSET = new Asset('USDC', USDC_ISSUER);

const server = new Horizon.Server(HORIZON_URL);

export { USDC_ASSET, USDC_ISSUER, server, NETWORK_PASSPHRASE };

export async function forwardToTreasury(walletPubkey: string, amountToMove: string, memoContext: string) {
    try {
        console.log(`[FORWARDER] Initiating transfer of ${amountToMove} USDC from ${walletPubkey} to Treasury...`);
        const { data: poolWallet } = await supabase.from('wallets').select('secret_key_encrypted').eq('public_key', walletPubkey).single();
        if (!poolWallet) throw new Error('Pool wallet not found');
        const poolKp = Keypair.fromSecret(decryptKey(poolWallet.secret_key_encrypted));

        const { data: treasuryWallet } = await supabase.from('wallets').select('public_key').eq('wallet_type', 'treasury').single();
        if (!treasuryWallet) throw new Error('Treasury wallet not established');
        const treasuryPubkey = treasuryWallet.public_key;

        const sourceAccount = await server.loadAccount(poolKp.publicKey());
        const tx = new TransactionBuilder(sourceAccount, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
            .addOperation(Operation.payment({
                destination: treasuryPubkey,
                asset: USDC_ASSET,
                amount: amountToMove
            }))
            .setTimeout(30)
            .build();

        tx.sign(poolKp);
        const response = await server.submitTransaction(tx);
        return response.hash;
    } catch (error: any) {
        console.error(`[FORWARDER ERROR]:`, error.message);
        throw error;
    }
}

export async function dispatchRefundFromTreasury(destinationPubkey: string, amount: string) {
    console.log(`[TREASURY] Dispatching automated refund of ${amount} to ${destinationPubkey}`);
    const { data: treasuryWallet } = await supabase.from('wallets').select('secret_key_encrypted').eq('wallet_type', 'treasury').single();
    if (!treasuryWallet) throw new Error('Treasury wallet not established');
    const treasuryKp = Keypair.fromSecret(decryptKey(treasuryWallet.secret_key_encrypted));

    const sourceAccount = await server.loadAccount(treasuryKp.publicKey());
    const tx = new TransactionBuilder(sourceAccount, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(Operation.payment({
            destination: destinationPubkey,
            asset: USDC_ASSET,
            amount: amount
        }))
        .setTimeout(30)
        .build();

    tx.sign(treasuryKp);
    const response = await server.submitTransaction(tx);
    return response.hash;
}
