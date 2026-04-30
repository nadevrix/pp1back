import { Keypair, TransactionBuilder, Operation, Networks } from '@stellar/stellar-sdk';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';
import { encryptKey } from '../src/lib/crypto';
import { server, USDC_ASSET, NETWORK_PASSPHRASE } from '../src/lib/forwarder';

// Load env variables
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("Missing Supabase credentials in .env.local");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const NUMBER_OF_POOL_WALLETS = 5;

async function fundWithFriendbot(publicKey: string): Promise<boolean> {
    try {
        const res = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
        return res.ok;
    } catch (error) {
        console.error(`Friendbot error for ${publicKey}:`, error);
        return false;
    }
}

/**
 * Establish USDC trustline for a wallet so it can receive USDC tokens.
 * Without this, any USDC payment to the wallet will be rejected by Stellar.
 */
async function createUSDCTrustline(keypair: Keypair): Promise<void> {
    const account = await server.loadAccount(keypair.publicKey());
    const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: NETWORK_PASSPHRASE
    })
        .addOperation(Operation.changeTrust({ asset: USDC_ASSET }))
        .setTimeout(30)
        .build();

    tx.sign(keypair);
    await server.submitTransaction(tx);
    console.log(`   🔗 USDC Trustline established for ${keypair.publicKey()}`);
}

async function setupWallets() {
    console.log("🚀 Starting Pollar-Pay Wallet Genesis on Testnet...\n");

    // 1. Generate Treasury Wallet
    console.log("── Treasury Wallet ──");
    const treasuryKp = Keypair.random();
    const tSuccess = await fundWithFriendbot(treasuryKp.publicKey());
    if (tSuccess) {
        await createUSDCTrustline(treasuryKp);
        await supabase.from('wallets').insert({
            public_key: treasuryKp.publicKey(),
            secret_key_encrypted: encryptKey(treasuryKp.secret()),
            wallet_type: 'treasury'
        });
        console.log(`   ✅ Treasury created: ${treasuryKp.publicKey()}\n`);
    } else {
        console.error("   ❌ Failed to fund Treasury Wallet.\n");
    }

    // 2. Generate Pool Wallets
    console.log(`── Pool Wallets (${NUMBER_OF_POOL_WALLETS}) ──`);
    for (let i = 0; i < NUMBER_OF_POOL_WALLETS; i++) {
        const poolKp = Keypair.random();
        const pSuccess = await fundWithFriendbot(poolKp.publicKey());

        if (pSuccess) {
            await createUSDCTrustline(poolKp);
            await supabase.from('wallets').insert({
                public_key: poolKp.publicKey(),
                secret_key_encrypted: encryptKey(poolKp.secret()),
                wallet_type: 'pool'
            });
            console.log(`   ✅ Pool Wallet ${i + 1} created: ${poolKp.publicKey()}`);
        } else {
            console.error(`   ❌ Failed to fund Pool Wallet ${i + 1}`);
        }

        // Respect Friendbot rate limits
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log("\n🎉 Wallet Genesis Complete! All wallets have USDC trustlines.");
}

setupWallets().catch(console.error);

