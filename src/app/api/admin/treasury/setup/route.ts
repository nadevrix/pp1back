// ─── Treasury setup ─────────────────────────────────────────────────────────
// POST /api/admin/treasury/setup
//
// Crea la wallet treasury que recibe los fondos para refunds.
//
// Modo TESTNET (auto):
//   - Genera keypair, fondea con Friendbot, agrega trustline USDC, guarda.
//
// Modo MAINNET (manual):
//   - Si querés crear desde cero, generá la keypair offline y enviala
//     en el body como `{ secret: "S..." }`. La wallet ya debe estar
//     fondeada con XLM (≥ 2) y tener trustline USDC.
//   - Este endpoint solo encripta y guarda.
//
// Devuelve la public key de la treasury (existente o nueva).
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { validateAdminAuth } from '@/lib/admin-auth';
import { Keypair, TransactionBuilder, Operation } from '@stellar/stellar-sdk';
import { stellarClient, NETWORK_PASSPHRASE, USDC_ASSET } from '@/lib/stellar/client';

const FRIENDBOT_URL = process.env.STELLAR_FRIENDBOT_URL || 'https://friendbot.stellar.org';
const STELLAR_NETWORK = (process.env.STELLAR_NETWORK || 'TESTNET').toUpperCase();

async function ensureTrustline(keypair: Keypair) {
    const account = await stellarClient.loadAccount(keypair.publicKey());

    const hasTrustline = account.balances.some(b =>
        b.asset_type !== 'native' &&
        'asset_code' in b &&
        b.asset_code === 'USDC');

    if (hasTrustline) return;

    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
        .addOperation(Operation.changeTrust({ asset: USDC_ASSET }))
        .setTimeout(30)
        .build();
    tx.sign(keypair);
    await stellarClient.submitTransaction(tx);
}

export async function POST(request: Request) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    try {
        const { data: existing } = await supabase
            .from('wallets')
            .select('public_key')
            .eq('wallet_type', 'treasury')
            .maybeSingle();

        if (existing) {
            return NextResponse.json({
                success: true,
                message: 'Treasury already exists',
                public_key: existing.public_key,
                created: false,
            });
        }

        let body: { secret?: string } = {};
        try { body = await request.json(); } catch { /* body opcional */ }

        let keypair: Keypair;

        if (body.secret) {
            try {
                keypair = Keypair.fromSecret(body.secret);
            } catch {
                return NextResponse.json({ error: 'Invalid secret key' }, { status: 400 });
            }
        } else if (STELLAR_NETWORK === 'TESTNET') {
            keypair = Keypair.random();
            const friendbotRes = await fetch(`${FRIENDBOT_URL}?addr=${keypair.publicKey()}`);
            if (!friendbotRes.ok) {
                return NextResponse.json(
                    { error: `Friendbot failed (${friendbotRes.status}). Try again or pass a secret manually.` },
                    { status: 502 },
                );
            }
        } else {
            return NextResponse.json({
                error: 'On mainnet you must pass a pre-funded keypair via { secret: "S..." } in the body. ' +
                       'The wallet must have ≥ 2 XLM and ideally already a USDC trustline.',
            }, { status: 400 });
        }

        try {
            await ensureTrustline(keypair);
        } catch (e: any) {
            return NextResponse.json(
                { error: `Failed to add USDC trustline: ${e.message}` },
                { status: 500 },
            );
        }

        const { error: insertErr } = await supabase.from('wallets').insert({
            public_key: keypair.publicKey(),
            secret_key: keypair.secret(),
            wallet_type: 'treasury',
            wallet_index: null,
            is_locked: false,
        });

        if (insertErr) throw insertErr;

        return NextResponse.json({
            success: true,
            message: 'Treasury created',
            public_key: keypair.publicKey(),
            created: true,
            network: STELLAR_NETWORK,
        });
    } catch (err: any) {
        console.error('Treasury Setup Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function GET(request: Request) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    const { data: existing } = await supabase
        .from('wallets')
        .select('public_key, created_at')
        .eq('wallet_type', 'treasury')
        .maybeSingle();

    if (!existing) {
        return NextResponse.json({ exists: false });
    }
    return NextResponse.json({ exists: true, ...existing });
}
