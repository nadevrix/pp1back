import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { SUPPORT_CONTACT } from '@/lib/admin-auth';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const transactionId = searchParams.get('transaction_id');
        const apiKey = searchParams.get('api_key');

        if (!transactionId || !apiKey) {
            return NextResponse.json(
                { error: 'Missing required query params: transaction_id, api_key' },
                { status: 400 }
            );
        }

        // 1. Verify the API Key
        const { data: project, error: pError } = await supabase
            .from('projects')
            .select('id')
            .eq('api_key', apiKey)
            .single();

        if (pError || !project) {
            return NextResponse.json({ error: 'Invalid API Key' }, { status: 401 });
        }

        // 2. Fetch the transaction (must belong to this project)
        const { data: tx, error: txError } = await supabase
            .from('transactions')
            .select('id, status, amount_expected, amount_paid, asset_code, expires_at, created_at, wallet_pubkey')
            .eq('id', transactionId)
            .eq('project_id', project.id)
            .single();

        if (txError || !tx) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }

        // 3. Calculate remaining amount and time
        const amountExpected = parseFloat(tx.amount_expected);
        const amountPaid = parseFloat(tx.amount_paid || '0');
        const remaining = Math.max(0, amountExpected - amountPaid);

        const expiresAt = new Date(tx.expires_at);
        const now = new Date();
        const timeRemainingMs = expiresAt.getTime() - now.getTime();
        const timeRemainingSeconds = Math.max(0, Math.floor(timeRemainingMs / 1000));
        const isExpired = timeRemainingMs <= 0;

        // 4. Include support info for anomalies
        const needsSupport = ['overpaid', 'underpaid', 'anomaly', 'late_anomaly'].includes(tx.status);
        const excess = amountPaid > amountExpected ? (amountPaid - amountExpected).toFixed(2) : null;

        return NextResponse.json({
            success: true,
            data: {
                transaction_id: tx.id,
                status: tx.status,
                amount_expected: tx.amount_expected,
                amount_paid: tx.amount_paid,
                remaining: remaining.toFixed(2),
                asset: tx.asset_code,
                wallet_address: tx.wallet_pubkey,
                expires_at: tx.expires_at,
                time_remaining_seconds: timeRemainingSeconds,
                is_expired: isExpired,
                created_at: tx.created_at,
                // Support info — only included when there's an anomaly
                ...(needsSupport && {
                    support: {
                        contact: SUPPORT_CONTACT.phone,
                        message: tx.status === 'overpaid'
                            ? `Payment completed with excess of ${excess} USDC. ${SUPPORT_CONTACT.message}`
                            : SUPPORT_CONTACT.message
                    }
                })
            }
        });

    } catch (err: any) {
        console.error("Status Check Error:", err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
