import { Horizon } from '@stellar/stellar-sdk';
import { stellarClient, USDC_ISSUER } from './client';

/**
 * Returns the total USDC received by a wallet on Stellar since a given date.
 * Filters by: payment type, destination = walletPubkey, asset = USDC with correct issuer,
 * and created_at >= sinceDate.
 * Returns 0 if the account has no transaction history yet (Horizon 404).
 */
export async function getUsdcReceivedSince(walletPubkey: string, sinceDate: string): Promise<number> {
    let total = 0;
    try {
        let page = await stellarClient.payments()
            .forAccount(walletPubkey)
            .order('asc')
            .limit(200)
            .call();

        while (true) {
            for (const record of page.records) {
                if (record.type !== 'payment') continue;
                const payment = record as Horizon.ServerApi.PaymentOperationRecord;
                if (
                    payment.to !== walletPubkey ||
                    payment.asset_code !== 'USDC' ||
                    payment.asset_issuer !== USDC_ISSUER
                ) continue;
                if (new Date(payment.created_at) < new Date(sinceDate)) continue;
                total += parseFloat(payment.amount);
            }
            if (page.records.length < 200) break;
            page = await page.next();
        }
    } catch (err: any) {
        if (err.response?.status === 404) return 0;
        throw err;
    }
    return total;
}
