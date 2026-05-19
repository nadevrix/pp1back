import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { validateAdminAuth } from '@/lib/admin-auth';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

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

// POST — Registrar una wallet pool YA preparada externamente.
//
// El admin debe:
//   1. Generar el keypair en Lobstr/Stellar Lab/etc.
//   2. Fondearla (testnet: Friendbot; mainnet: ≥2 XLM real)
//   3. Agregar trustline USDC (issuer correcto para la red)
//   4. ENTONCES sí, llamar este endpoint con { public_key, secret_key }
//
// El backend NO hace ninguna operación Stellar — solo guarda el keypair en
// la DB con el siguiente índice libre. Si después la wallet no tiene
// trustline / sin XLM, los forwards van a fallar — eso lo verificás vos
// antes de registrar.
export async function POST(request: Request) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    try {
        const body = await request.json().catch(() => ({}));
        const publicKey = typeof body.public_key === 'string' ? body.public_key.trim() : '';
        const secretKey = typeof body.secret_key === 'string' ? body.secret_key.trim() : '';

        if (!publicKey || !secretKey) {
            return NextResponse.json(
                { error: 'Faltan public_key y/o secret_key' },
                { status: 400 },
            );
        }
        if (!StrKey.isValidEd25519PublicKey(publicKey)) {
            return NextResponse.json(
                { error: 'public_key inválida (debe empezar con G y tener 56 chars)' },
                { status: 400 },
            );
        }
        if (!StrKey.isValidEd25519SecretSeed(secretKey)) {
            return NextResponse.json(
                { error: 'secret_key inválida (debe empezar con S y tener 56 chars)' },
                { status: 400 },
            );
        }

        // Verificá que el secret se corresponde con la pubkey — error temprano si
        // pegaste el secret de otra wallet por accidente.
        try {
            const kp = Keypair.fromSecret(secretKey);
            if (kp.publicKey() !== publicKey) {
                return NextResponse.json(
                    { error: 'La secret_key no corresponde a esa public_key — chequeá que pegaste el par correcto' },
                    { status: 400 },
                );
            }
        } catch (e: any) {
            return NextResponse.json({ error: `secret_key inválida: ${e.message}` }, { status: 400 });
        }

        // ¿Ya existe esa pubkey en el pool?
        const { data: dup } = await supabase
            .from('wallets')
            .select('public_key, wallet_type')
            .eq('public_key', publicKey)
            .maybeSingle();
        if (dup) {
            return NextResponse.json(
                { error: `Esa pubkey ya está registrada como wallet ${dup.wallet_type}` },
                { status: 409 },
            );
        }

        // Auto-asignar el siguiente índice libre
        const { data: maxRow } = await supabase
            .from('wallets')
            .select('wallet_index')
            .eq('wallet_type', 'pool')
            .order('wallet_index', { ascending: false })
            .limit(1)
            .maybeSingle();
        const nextIndex = (maxRow?.wallet_index ?? -1) + 1;

        const { error: dbError } = await supabase.from('wallets').insert({
            public_key: publicKey,
            secret_key: secretKey,
            wallet_type: 'pool',
            wallet_index: nextIndex,
            is_locked: false,
        });

        if (dbError) throw dbError;

        return NextResponse.json({
            success: true,
            message: 'Wallet pool registrada — asegurate de que tenga trustline USDC y XLM suficiente',
            wallet: {
                public_key: publicKey,
                wallet_type: 'pool',
                wallet_index: nextIndex,
                is_locked: false,
            },
        }, { status: 201 });

    } catch (err: any) {
        console.error('Wallet register error:', err.message);
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
            return NextResponse.json({ error: 'Cannot delete treasury wallet — use treasury rotate instead' }, { status: 403 });
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
            note: 'La cuenta sigue viva en Stellar. El round-robin saltea su índice automáticamente.'
        });

    } catch (err: any) {
        console.error('Wallet Deletion Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
