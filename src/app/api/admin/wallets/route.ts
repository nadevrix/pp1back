import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { validateAdminAuth } from '@/lib/admin-auth';
import { Keypair, TransactionBuilder, Operation } from '@stellar/stellar-sdk';
import { stellarClient, USDC_ASSET, NETWORK_PASSPHRASE } from '@/lib/stellar/client';

// GET — List all wallets with lock status
export async function GET(request: Request) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    try {
        const { data: wallets, error } = await supabase
            .from('wallets')
            .select('public_key, wallet_type, wallet_index, is_locked, locked_until, last_project_id, created_at')
            .order('wallet_type', { ascending: false })
            .order('wallet_index', { ascending: true });

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
                wallets
            }
        });
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

// POST — Create a new pool wallet and add it to the round-robin rotation
export async function POST(request: Request) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    try {
        const keypair = Keypair.random();
        const publicKey = keypair.publicKey();

        // 1. Fund with Friendbot (testnet only — STELLAR_FRIENDBOT_URL must be set)
        const FRIENDBOT_URL = process.env.STELLAR_FRIENDBOT_URL;
        if (!FRIENDBOT_URL) {
            return NextResponse.json(
                { error: 'STELLAR_FRIENDBOT_URL is not configured. Friendbot only exists on testnet.' },
                { status: 503 }
            );
        }
        const friendbotRes = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
        if (!friendbotRes.ok) {
            return NextResponse.json(
                { error: 'Friendbot funding failed. Testnet may be overloaded, retry in a few seconds.' },
                { status: 503 }
            );
        }

        // 2. Establish USDC trustline
        const account = await stellarClient.loadAccount(publicKey);
        const tx = new TransactionBuilder(account, {
            fee: '100',
            networkPassphrase: NETWORK_PASSPHRASE
        })
            .addOperation(Operation.changeTrust({ asset: USDC_ASSET }))
            .setTimeout(30)
            .build();

        tx.sign(keypair);
        await stellarClient.submitTransaction(tx);

        // 3. Determine the next wallet_index so this wallet enters the round robin automatically
        const { data: maxRow } = await supabase
            .from('wallets')
            .select('wallet_index')
            .eq('wallet_type', 'pool')
            .order('wallet_index', { ascending: false })
            .limit(1)
            .single();

        const nextIndex = (maxRow?.wallet_index ?? -1) + 1;

        // 4. Insert into DB
        const { error: dbError } = await supabase.from('wallets').insert({
            public_key: publicKey,
            secret_key: keypair.secret(),
            wallet_type: 'pool',
            wallet_index: nextIndex
        });

        if (dbError) throw dbError;

        return NextResponse.json({
            success: true,
            message: 'Pool wallet created and added to round-robin rotation',
            wallet: {
                public_key: publicKey,
                wallet_type: 'pool',
                wallet_index: nextIndex,
                is_locked: false
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

        const { error: delError } = await supabase
            .from('wallets')
            .delete()
            .eq('public_key', public_key);

        if (delError) throw delError;

        return NextResponse.json({
            success: true,
            message: 'Wallet removed from pool rotation',
            note: 'The Stellar account still exists on the blockchain. The round-robin will skip this index automatically.'
        });

    } catch (err: any) {
        console.error('Wallet Deletion Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
