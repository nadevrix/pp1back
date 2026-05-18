// POST /api/merchant/tx/[id]/verify
// Fuerza la verificación contra Horizon de una transaction del merchant.
// Lo usa el dashboard cuando se aprieta el botón "Verificar pago".
//
// Auth: JWT del merchant. Solo el owner del project_id o un miembro invitado
// puede disparar la verificación.

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';
import { getUserRoleForProject } from '@/lib/branch-access';
import { processSingleTransaction, type PendingTx } from '@/lib/payments/processor';

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

        const { id } = await params;

        const txQuery = await supabase
            .from('transactions')
            .select('id, status, reason, amount_expected, amount_paid, asset_code, wallet_pubkey, expires_at, created_at, forward_status, forward_tx_hash, project_id, projects!project_id(payout_wallet)')
            .eq('id', id)
            .single();

        if (txQuery.error || !txQuery.data) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }
        let tx = txQuery.data;

        const role = await getUserRoleForProject(user.id, tx.project_id);
        if (!role) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        if (tx.status === 'pending' && tx.wallet_pubkey) {
            try {
                await processSingleTransaction(tx as unknown as PendingTx, new Date());
                const refetch = await supabase
                    .from('transactions')
                    .select('id, status, reason, amount_expected, amount_paid, asset_code, wallet_pubkey, expires_at, created_at, forward_status, forward_tx_hash, project_id, projects!project_id(payout_wallet)')
                    .eq('id', id)
                    .single();
                if (refetch.data) tx = refetch.data;
            } catch (e: any) {
                console.error('[VERIFY] processSingleTransaction failed:', e?.message);
            }
        }

        return NextResponse.json({
            success: true,
            data: {
                transaction_id: tx.id,
                status: tx.status,
                amount_paid: tx.amount_paid,
                forward_status: tx.forward_status,
                forward_tx_hash: tx.forward_tx_hash ?? null,
            },
        });
    } catch (err: any) {
        console.error('Verify endpoint error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
