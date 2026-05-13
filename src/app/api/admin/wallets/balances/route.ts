import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { validateAdminAuth } from '@/lib/admin-auth';
import { stellarClient, USDC_ISSUER } from '@/lib/stellar/client';

// XLM thresholds — Stellar base reserve is 1 XLM + 0.5 per trustline
// A pool wallet with 1 trustline (USDC) needs 1.5 XLM minimum reserve (untouchable)
// Below 2 XLM: warning. Below 1.5 XLM: critical (can't transact).
const XLM_WARNING  = 2.0;
const XLM_CRITICAL = 1.5;

interface WalletBalance {
    public_key:    string;
    wallet_type:   string;
    wallet_index:  number | null;
    is_locked:     boolean;
    xlm_balance:   string;
    usdc_balance:  string;
    xlm_status:    'ok' | 'warning' | 'critical' | 'error';
    horizon_error: string | null;
}

export async function GET(request: Request) {
    const authError = validateAdminAuth(request);
    if (authError) return authError;

    try {
        const { data: wallets, error } = await supabase
            .from('wallets')
            .select('public_key, wallet_type, wallet_index, is_locked')
            .order('wallet_type', { ascending: false })
            .order('wallet_index', { ascending: true, nullsFirst: false });

        if (error) throw error;
        if (!wallets || wallets.length === 0) {
            return NextResponse.json({ success: true, data: { wallets: [], summary: { total: 0, critical: 0, warning: 0, ok: 0, error: 0 } } });
        }

        // Query Horizon for each wallet in parallel
        const balances: WalletBalance[] = await Promise.all(
            wallets.map(async (w) => {
                try {
                    const account = await stellarClient.loadAccount(w.public_key);

                    let xlm  = '0';
                    let usdc = '0';

                    for (const balance of account.balances) {
                        if (balance.asset_type === 'native') {
                            xlm = balance.balance;
                        } else if (
                            balance.asset_type === 'credit_alphanum4' &&
                            (balance as any).asset_code   === 'USDC' &&
                            (balance as any).asset_issuer === USDC_ISSUER
                        ) {
                            usdc = balance.balance;
                        }
                    }

                    const xlmNum = parseFloat(xlm);
                    const xlmStatus =
                        xlmNum < XLM_CRITICAL ? 'critical' :
                        xlmNum < XLM_WARNING  ? 'warning'  : 'ok';

                    return {
                        public_key:    w.public_key,
                        wallet_type:   w.wallet_type,
                        wallet_index:  w.wallet_index,
                        is_locked:     w.is_locked,
                        xlm_balance:   xlm,
                        usdc_balance:  usdc,
                        xlm_status:    xlmStatus,
                        horizon_error: null
                    };
                } catch (err: any) {
                    return {
                        public_key:    w.public_key,
                        wallet_type:   w.wallet_type,
                        wallet_index:  w.wallet_index,
                        is_locked:     w.is_locked,
                        xlm_balance:   '0',
                        usdc_balance:  '0',
                        xlm_status:    'error' as const,
                        horizon_error: err.message
                    };
                }
            })
        );

        const summary = {
            total:    balances.length,
            critical: balances.filter(b => b.xlm_status === 'critical').length,
            warning:  balances.filter(b => b.xlm_status === 'warning').length,
            ok:       balances.filter(b => b.xlm_status === 'ok').length,
            error:    balances.filter(b => b.xlm_status === 'error').length,
            total_usdc_in_pool: balances
                .filter(b => b.wallet_type === 'pool')
                .reduce((sum, b) => sum + parseFloat(b.usdc_balance), 0)
                .toFixed(7),
            total_usdc_in_treasury: balances
                .filter(b => b.wallet_type === 'treasury')
                .reduce((sum, b) => sum + parseFloat(b.usdc_balance), 0)
                .toFixed(7)
        };

        return NextResponse.json({ success: true, data: { summary, wallets: balances } });

    } catch (err: any) {
        console.error('Wallet Balances Error:', err.message);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
