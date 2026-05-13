import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { dispatchRefundFromTreasury } from '@/lib/stellar/transactions';
import { validateAdminAuth } from '@/lib/admin-auth';
import { StrKey } from '@stellar/stellar-sdk';

export async function POST(request: Request) {
    // Admin authentication required
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    try {
        const { transaction_id, destination_wallet, amount } = await request.json();

        if (!transaction_id || !destination_wallet || !amount) {
            return NextResponse.json({ error: 'Missing required refund payload fields' }, { status: 400 });
        }

        if (parseFloat(amount) <= 0) {
            return NextResponse.json({ error: 'Refund amount must be greater than 0' }, { status: 400 });
        }

        if (!StrKey.isValidEd25519PublicKey(destination_wallet)) {
            return NextResponse.json({ error: 'Invalid destination_wallet: must be a valid Stellar public key' }, { status: 400 });
        }

        // Verify the transaction exists and is in a refundable state
        const { data: tx, error: txError } = await supabase
            .from('transactions')
            .select('id, status, amount_paid')
            .eq('id', transaction_id)
            .single();

        if (txError || !tx) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }

        if (tx.status === 'refunded') {
            return NextResponse.json({ error: 'Transaction already refunded' }, { status: 409 });
        }

        // Attempt the Stellar blockchain refund
        const refundHash = await dispatchRefundFromTreasury(destination_wallet, amount.toString());

        // If successful, update the transaction status to 'refunded' in Supabase
        const { error: updateError } = await supabase
            .from('transactions')
            .update({ status: 'refunded', crypto_tx_hash: refundHash })
            .eq('id', transaction_id);

        if (updateError) throw updateError;

        return NextResponse.json({ success: true, message: 'Refund successfully completed', hash: refundHash });

    } catch (err: any) {
        console.error("Refund API Error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

