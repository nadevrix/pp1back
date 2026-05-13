import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { StrKey } from '@stellar/stellar-sdk';
import { getUserFromRequest } from '@/lib/auth-user';

const STELLAR_NETWORK = (process.env.STELLAR_NETWORK || 'TESTNET').toLowerCase() === 'mainnet'
    ? 'mainnet'
    : 'testnet';

export async function POST(request: Request) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { name, reason, payout_wallet } = await request.json();

        if (!name || !reason || !payout_wallet) {
            return NextResponse.json(
                { error: 'Missing required fields: name, reason, payout_wallet' },
                { status: 400 }
            );
        }

        if (!StrKey.isValidEd25519PublicKey(payout_wallet)) {
            return NextResponse.json(
                { error: 'Invalid payout_wallet: must be a valid Stellar public key (starts with G)' },
                { status: 400 }
            );
        }

        // Genera api_key alineada con la network del backend (testnet/mainnet)
        // El SDK lee el prefijo para resolver la URL del backend.
        const { data: apiKeyResult, error: keyErr } = await supabase
            .rpc('generate_api_key', { p_network: STELLAR_NETWORK });

        if (keyErr || !apiKeyResult) {
            console.error('Failed to generate api_key:', keyErr?.message);
            return NextResponse.json({ error: 'Failed to generate api key' }, { status: 500 });
        }

        const { data, error } = await supabase
            .from('projects')
            .insert({
                merchant_id: user.id,
                name,
                reason,
                payout_wallet,
                api_key: apiKeyResult,
            })
            .select('id, api_key, name, payout_wallet, reason, created_at')
            .single();

        if (error) throw error;

        return NextResponse.json({
            success: true,
            message: 'Project created successfully',
            project: data
        }, { status: 201 });

    } catch (err: any) {
        console.error('Project Creation Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
