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

        // Enforce "1 sucursal" para Free (PDF pág. 8). Starter en adelante = ilimitado.
        // El merchant ve esto en la UI antes (chequeamos en /sucursales) pero el
        // backend valida de nuevo por si alguien llama al endpoint directo.
        const { data: profile, error: profErr } = await supabase
            .from('profiles')
            .select('tier')
            .eq('id', user.id)
            .single();
        if (profErr) {
            console.error('Failed to load profile for sucursal-limit check:', profErr.message);
            return NextResponse.json({ error: 'Could not load merchant profile' }, { status: 500 });
        }

        if (profile?.tier === 'free') {
            const { count, error: cntErr } = await supabase
                .from('projects')
                .select('id', { count: 'exact', head: true })
                .eq('merchant_id', user.id);
            if (cntErr) throw cntErr;
            if ((count ?? 0) >= 1) {
                return NextResponse.json(
                    {
                        error: 'El plan Free permite 1 sucursal. Subí a Starter para registrar más.',
                        code: 'TIER_BRANCH_LIMIT',
                        tier: 'free',
                    },
                    { status: 403 }
                );
            }
        }

        // Genera api_key alineada con la network del backend (testnet/mainnet)
        // El SDK lee el prefijo para resolver la URL del backend.
        const { data: apiKeyResult, error: keyErr } = await supabase
            .rpc('generate_api_key', { p_network: STELLAR_NETWORK });

        if (keyErr || !apiKeyResult) {
            console.error('Failed to generate api_key:', keyErr?.message);
            return NextResponse.json({ error: 'Failed to generate api key' }, { status: 500 });
        }

        // default_amount: opcional, validar si vino
        let defaultAmount: number | null = null;
        const rawDefault = (await request.clone().json().catch(() => ({}))).default_amount;
        if (rawDefault !== undefined && rawDefault !== null && rawDefault !== '') {
            const n = typeof rawDefault === 'number' ? rawDefault : parseFloat(rawDefault);
            if (isNaN(n) || n < 0.01 || n > 1_000_000) {
                return NextResponse.json(
                    { error: 'default_amount inválido (0.01 – 1,000,000 USDC)' },
                    { status: 400 },
                );
            }
            defaultAmount = n;
        }

        const { data, error } = await supabase
            .from('projects')
            .insert({
                merchant_id: user.id,
                name,
                reason,
                payout_wallet,
                api_key: apiKeyResult,
                default_amount: defaultAmount,
            })
            .select('id, api_key, name, payout_wallet, reason, default_amount, created_at')
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
