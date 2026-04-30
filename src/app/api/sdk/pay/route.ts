import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { SUPPORT_CONTACT } from '@/lib/admin-auth';

// Helper to calculate expiration time (15 minutes from now)
function getExpirationTimestamp() {
    const date = new Date();
    date.setMinutes(date.getMinutes() + 15);
    return date.toISOString();
}

export async function POST(request: Request) {
    try {
        const { api_key, amount_expected } = await request.json();

        if (!api_key || !amount_expected) {
            return NextResponse.json({ error: 'Missing api_key or amount_expected' }, { status: 400 });
        }

        // Validate amount
        const parsedAmount = parseFloat(amount_expected);
        if (isNaN(parsedAmount) || parsedAmount < 0.01 || parsedAmount > 1_000_000) {
            return NextResponse.json(
                { error: 'Invalid amount: must be between 0.01 and 1,000,000 USDC' },
                { status: 400 }
            );
        }

        // 1. Verify the API Key and get the Project
        const { data: project, error: pError } = await supabase
            .from('projects')
            .select('id, merchant_id')
            .eq('api_key', api_key)
            .single();

        if (pError || !project) {
            return NextResponse.json({ error: 'Invalid API Key' }, { status: 401 });
        }

        // 2. Find an available pool wallet (Round Robin / First Available)
        // We only select unlocked wallets OR wallets whose lock has expired
        const now = new Date().toISOString();
        const { data: availableWallets, error: wError } = await supabase
            .from('wallets')
            .select('public_key')
            .eq('wallet_type', 'pool')
            .or(`is_locked.eq.false,locked_until.lt.${now}`)
            .limit(1);

        if (wError || !availableWallets || availableWallets.length === 0) {
            // In a real high-traffic app, we would dynamically generate a new wallet here, 
            // but for V1 we return a 503 indicating traffic is too high for the pool.
            return NextResponse.json({ error: 'System busy: No available wallets in the pool. Retry in 1 minute.' }, { status: 503 });
        }

        const assignedWallet = availableWallets[0].public_key;
        const expiresAt = getExpirationTimestamp();

        // 3. Lock the wallet dynamically
        const { error: lockError } = await supabase
            .from('wallets')
            .update({
                is_locked: true,
                locked_until: expiresAt,
                last_project_id: project.id
            })
            .eq('public_key', assignedWallet);

        if (lockError) throw lockError;

        // 4. Create the Transaction Intent Document
        const { data: transaction, error: tError } = await supabase
            .from('transactions')
            .insert({
                project_id: project.id,
                wallet_pubkey: assignedWallet,
                amount_expected: amount_expected,
                asset_code: 'USDC',
                status: 'pending',
                expires_at: expiresAt
            })
            .select('id, wallet_pubkey, amount_expected, expires_at')
            .single();

        if (tError) {
            // Rollback the lock if transaction creation fails
            await supabase.from('wallets').update({ is_locked: false }).eq('public_key', assignedWallet);
            throw tError;
        }

        // 5. Return payload for the SDK to generate the QR Code
        return NextResponse.json({
            success: true,
            data: {
                transaction_id: transaction.id,
                wallet_address: transaction.wallet_pubkey,
                amount: transaction.amount_expected,
                asset: 'USDC',
                expires_at: transaction.expires_at,
                network: 'TESTNET'
            }
        });

    } catch (err: any) {
        console.error("Payment SDK Error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
