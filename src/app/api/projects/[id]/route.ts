import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getUserFromRequest } from '@/lib/auth-user';
import { StrKey } from '@stellar/stellar-sdk';
import { getUserRoleForProject } from '@/lib/branch-access';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id } = await params;

        const { data, error } = await supabase
            .from('projects')
            .select('id, name, reason, payout_wallet, api_key, default_amount, created_at, merchant_id')
            .eq('id', id)
            .single();

        if (error || !data) {
            return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }

        const role = await getUserRoleForProject(user.id, id);
        if (!role) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        // No exponemos merchant_id al cliente — viene del session
        const { merchant_id, ...projectSafe } = data;
        return NextResponse.json({ success: true, project: { ...projectSafe, role } });
    } catch (err: any) {
        console.error('Project Get Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id } = await params;
        const body = await request.json();

        // Solo dejamos cambiar campos editables — api_key, merchant_id y created_at NO se tocan.
        const allowed: Record<string, unknown> = {};
        if (typeof body.name === 'string' && body.name.trim()) allowed.name = body.name.trim();
        if (typeof body.reason === 'string' && body.reason.trim()) allowed.reason = body.reason.trim();
        if (typeof body.payout_wallet === 'string' && body.payout_wallet.trim()) {
            const w = body.payout_wallet.trim();
            if (!StrKey.isValidEd25519PublicKey(w)) {
                return NextResponse.json(
                    { error: 'Invalid payout_wallet: must be a valid Stellar public key (starts with G)' },
                    { status: 400 },
                );
            }
            allowed.payout_wallet = w;
        }
        // default_amount: number (0.01-1000000) o null para limpiar el preset
        if ('default_amount' in body) {
            if (body.default_amount === null || body.default_amount === '') {
                allowed.default_amount = null;
            } else {
                const n = typeof body.default_amount === 'number'
                    ? body.default_amount
                    : parseFloat(body.default_amount);
                if (isNaN(n) || n < 0.01 || n > 1_000_000) {
                    return NextResponse.json(
                        { error: 'default_amount must be a number between 0.01 and 1,000,000 USDC, or null' },
                        { status: 400 },
                    );
                }
                allowed.default_amount = n;
            }
        }

        if (Object.keys(allowed).length === 0) {
            return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
        }

        const { data: existing, error: getErr } = await supabase
            .from('projects')
            .select('merchant_id')
            .eq('id', id)
            .single();

        if (getErr || !existing) {
            return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }
        if (existing.merchant_id !== user.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const { data, error } = await supabase
            .from('projects')
            .update(allowed)
            .eq('id', id)
            .select('id, name, reason, payout_wallet, api_key, default_amount, created_at')
            .single();

        if (error) throw error;

        return NextResponse.json({ success: true, project: data });
    } catch (err: any) {
        console.error('Project Update Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getUserFromRequest(request);
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { id } = await params;

        const { data: existing, error: getErr } = await supabase
            .from('projects')
            .select('merchant_id')
            .eq('id', id)
            .single();

        if (getErr || !existing) {
            return NextResponse.json({ error: 'Project not found' }, { status: 404 });
        }
        if (existing.merchant_id !== user.id) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const { error } = await supabase.from('projects').delete().eq('id', id);
        if (error) throw error;

        return NextResponse.json({ success: true });
    } catch (err: any) {
        console.error('Project Delete Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
