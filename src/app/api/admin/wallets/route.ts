import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { validateAdminAuth } from '@/lib/admin-auth';
import { Keypair, TransactionBuilder, Operation } from '@stellar/stellar-sdk';
import { server, USDC_ASSET, NETWORK_PASSPHRASE } from '@/lib/forwarder';
import { encryptKey } from '@/lib/crypto';

// GET — List all wallets with lock status
export async function GET(request: Request) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    try {
        const { data: wallets, error } = await supabase
            .from('wallets')
            .select('public_key, wallet_type, is_locked, locked_until, last_project_id, created_at')
            .order('wallet_type', { ascending: false })
            .order('created_at', { ascending: true });

        if (error) throw error;

        const poolWallets = wallets?.filter(w => w.wallet_type === 'pool') || [];
        const treasuryWallets = wallets?.filter(w => w.wallet_type === 'treasury') || [];

        return NextResponse.json({
            success: true,
            data: {
                total_pool: poolWallets.length,
                pool_locked: poolWallets.filter(w => w.is_locked).length,
                pool_available: poolWallets.filter(w => !w.is_locked).length,
                treasury_count: treasuryWallets.length,
                wallets: wallets
            }
        });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// POST — Create a new pool wallet (Friendbot + USDC trustline + DB insert)
export async function POST(request: Request) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    try {
        const keypair = Keypair.random();
        const publicKey = keypair.publicKey();

        // 1. Fund with Friendbot (testnet only)
        const friendbotRes = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
        if (!friendbotRes.ok) {
            return NextResponse.json(
                { error: 'Friendbot funding failed. Testnet may be overloaded, retry in a few seconds.' },
                { status: 503 }
            );
        }

        // 2. Establish USDC trustline
        const account = await server.loadAccount(publicKey);
        const tx = new TransactionBuilder(account, {
            fee: '100',
            networkPassphrase: NETWORK_PASSPHRASE
        })
            .addOperation(Operation.changeTrust({ asset: USDC_ASSET }))
            .setTimeout(30)
            .build();

        tx.sign(keypair);
        await server.submitTransaction(tx);

        // 3. Insert into DB
        const { error: dbError } = await supabase.from('wallets').insert({
            public_key: publicKey,
            secret_key_encrypted: encryptKey(keypair.secret()),
            wallet_type: 'pool'
        });

        if (dbError) throw dbError;

        return NextResponse.json({
            success: true,
            message: 'Pool wallet created with USDC trustline',
            wallet: {
                public_key: publicKey,
                wallet_type: 'pool',
                is_locked: false,
                note: 'Restart the stream listener to start monitoring this wallet, or wait for the next dynamic refresh cycle.'
            }
        }, { status: 201 });

    } catch (err: any) {
        console.error('Wallet Creation Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// DELETE — Remove a wallet from the pool (only if unlocked and no pending transactions)
export async function DELETE(request: Request) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    try {
        const { public_key } = await request.json();

        if (!public_key) {
            return NextResponse.json({ error: 'Missing public_key' }, { status: 400 });
        }

        // 1. Check the wallet exists and is a pool wallet
        const { data: wallet, error: wError } = await supabase
            .from('wallets')
            .select('public_key, wallet_type, is_locked')
            .eq('public_key', public_key)
            .single();

        if (wError || !wallet) {
            return NextResponse.json({ error: 'Wallet not found' }, { status: 404 });
        }

        if (wallet.wallet_type === 'treasury') {
            return NextResponse.json({ error: 'Cannot delete treasury wallet' }, { status: 403 });
        }

        if (wallet.is_locked) {
            return NextResponse.json(
                { error: 'Wallet is currently locked (in use). Wait for it to unlock before removing.' },
                { status: 409 }
            );
        }

        // 2. Check no pending transactions use this wallet
        const { data: pendingTxs } = await supabase
            .from('transactions')
            .select('id')
            .eq('wallet_pubkey', public_key)
            .eq('status', 'pending')
            .limit(1);

        if (pendingTxs && pendingTxs.length > 0) {
            return NextResponse.json(
                { error: 'Wallet has pending transactions. Wait for them to complete or expire.' },
                { status: 409 }
            );
        }

        // 3. Delete from DB (the wallet still exists on Stellar, just removed from pool rotation)
        const { error: delError } = await supabase
            .from('wallets')
            .delete()
            .eq('public_key', public_key);

        if (delError) throw delError;

        return NextResponse.json({
            success: true,
            message: 'Wallet removed from pool rotation',
            note: 'The Stellar account still exists. Funds can be recovered manually if needed.'
        });

    } catch (err: any) {
        console.error('Wallet Deletion Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
