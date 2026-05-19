import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { authenticateRequest } from '@/lib/pollar-auth';

const STELLAR_NETWORK = process.env.STELLAR_NETWORK || 'TESTNET';
const CHECKOUT_BASE_URL = process.env.NEXT_PUBLIC_CHECKOUT_BASE_URL || 'http://localhost:3002';

function getExpirationTimestamp() {
    const date = new Date();
    date.setMinutes(date.getMinutes() + 15);
    return date.toISOString();
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { amount_expected, reason, api_key } = body;

        if (!amount_expected || !reason) {
            return NextResponse.json({ error: 'Missing amount_expected or reason' }, { status: 400 });
        }

        const parsedAmount = parseFloat(amount_expected);
        if (isNaN(parsedAmount) || parsedAmount < 0.01 || parsedAmount > 1_000_000) {
            return NextResponse.json(
                { error: 'Invalid amount: must be between 0.01 and 1,000,000 USDC' },
                { status: 400 }
            );
        }

        // Authenticate: supports x-pollar-api-key header (new) or api_key in body (legacy)
        const auth = await authenticateRequest(request, api_key);
        if (!auth) {
            return NextResponse.json({ error: 'Invalid API Key' }, { status: 401 });
        }

        const expiresAt = getExpirationTimestamp();

        // Atomic round-robin wallet claim — race-condition safe via FOR UPDATE SKIP LOCKED
        const { data: assignedWallet, error: claimError } = await supabase.rpc('claim_wallet', {
            p_project_id: auth.projectId,
            p_locked_until: expiresAt
        });

        if (claimError || !assignedWallet) {
            return NextResponse.json(
                { error: 'System busy: No available wallets in the pool. Retry in 1 minute.' },
                { status: 503 }
            );
        }

        const { data: transaction, error: tError } = await supabase
            .from('transactions')
            .insert({
                project_id: auth.projectId,
                wallet_pubkey: assignedWallet,
                reason: reason,
                amount_expected: parsedAmount,
                asset_code: 'USDC',
                status: 'pending',
                expires_at: expiresAt
            })
            .select('id, wallet_pubkey, reason, amount_expected, expires_at')
            .single();

        if (tError) {
            // Release the wallet if transaction creation fails
            await supabase.from('wallets')
                .update({ is_locked: false, locked_until: null })
                .eq('public_key', assignedWallet);
            throw tError;
        }

        return NextResponse.json({
            success: true,
            data: {
                transaction_id: transaction.id,
                wallet_address: transaction.wallet_pubkey,
                reason: transaction.reason,
                amount: transaction.amount_expected,
                asset: 'USDC',
                expires_at: transaction.expires_at,
                network: STELLAR_NETWORK,
                // Hosted Checkout: el comercio redirige al cliente acá.
                checkout_url: `${CHECKOUT_BASE_URL.replace(/\/$/, '')}/checkout/${transaction.id}`,
            }
        });

    } catch (err: any) {
        console.error("Payment SDK Error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

