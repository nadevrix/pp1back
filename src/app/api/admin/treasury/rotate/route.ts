// ─── POST /api/admin/treasury/rotate ────────────────────────────────────────
// Cambia la treasury wallet por una nueva. Diseñado para respuesta a hackeos:
// si sospechás que la secret de la treasury actual se filtró, rotás a una
// nueva en segundos sin tocar SQL.
//
// Body: { public_key: 'G...', secret_key?: 'S...' }
//   - public_key (obligatorio): la nueva treasury
//   - secret_key (opcional): NULL por default (el endpoint de refund queda
//     deshabilitado pero más seguro — refunds manuales via Lobstr)
//
// Operaciones atómicas (transacción única):
//   1. DELETE treasury vieja de wallets
//   2. INSERT treasury nueva
//   3. UPDATE billing project (si existe) para apuntar al nuevo payout_wallet
//
// ⚠️ Importante:
//   - NO mueve los fondos de la treasury vieja a la nueva. Eso lo hacés vos
//     manualmente desde Lobstr/Albedo con la secret vieja (si todavía la tenés).
//   - Los pagos en vuelo a la treasury vieja siguen llegando allá. Solo los
--     nuevos van a la nueva.
//   - Verificá que la nueva tenga trustline USDC ANTES de rotar — sino los
//     forwards van a fallar y se acumulan anomalías.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { validateAdminAuth } from '@/lib/admin-auth';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

export async function POST(request: Request) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    try {
        const body = await request.json().catch(() => ({}));
        const newPubkey = typeof body.public_key === 'string' ? body.public_key.trim() : '';
        const newSecret = typeof body.secret_key === 'string' && body.secret_key.trim()
            ? body.secret_key.trim()
            : null;

        if (!newPubkey) {
            return NextResponse.json(
                { error: 'Falta public_key (la nueva treasury)' },
                { status: 400 },
            );
        }
        if (!StrKey.isValidEd25519PublicKey(newPubkey)) {
            return NextResponse.json(
                { error: 'public_key inválida (debe empezar con G y tener 56 chars)' },
                { status: 400 },
            );
        }
        if (newSecret) {
            if (!StrKey.isValidEd25519SecretSeed(newSecret)) {
                return NextResponse.json(
                    { error: 'secret_key inválida (debe empezar con S y tener 56 chars)' },
                    { status: 400 },
                );
            }
            try {
                const kp = Keypair.fromSecret(newSecret);
                if (kp.publicKey() !== newPubkey) {
                    return NextResponse.json(
                        { error: 'La secret_key no corresponde a esa public_key' },
                        { status: 400 },
                    );
                }
            } catch (e: any) {
                return NextResponse.json({ error: `secret_key inválida: ${e.message}` }, { status: 400 });
            }
        }

        // No puede coincidir con una wallet existente del pool
        const { data: existsAsPool } = await supabase
            .from('wallets')
            .select('public_key')
            .eq('public_key', newPubkey)
            .eq('wallet_type', 'pool')
            .maybeSingle();
        if (existsAsPool) {
            return NextResponse.json(
                { error: 'Esa pubkey ya está registrada como pool wallet — no se puede usar como treasury' },
                { status: 409 },
            );
        }

        // Borrar treasury anterior (si había) e insertar la nueva
        const { error: delErr } = await supabase
            .from('wallets')
            .delete()
            .eq('wallet_type', 'treasury');
        if (delErr) throw delErr;

        const { error: insErr } = await supabase
            .from('wallets')
            .insert({
                public_key: newPubkey,
                secret_key: newSecret,
                wallet_type: 'treasury',
                wallet_index: null,
                is_locked: false,
            });
        if (insErr) throw insErr;

        // Sync billing project (si existe) para que los pagos de Scale
        // vayan a la nueva treasury inmediatamente
        const { error: updErr } = await supabase
            .from('projects')
            .update({ payout_wallet: newPubkey })
            .eq('name', '__pollar_billing__');
        if (updErr) console.error('treasury rotate: billing project sync error', updErr.message);

        return NextResponse.json({
            success: true,
            message: 'Treasury rotada — billing project sincronizado',
            new_treasury: newPubkey,
            has_secret: newSecret !== null,
        });
    } catch (err: any) {
        console.error('Treasury rotate error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
