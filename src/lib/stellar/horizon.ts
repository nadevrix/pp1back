import { Horizon } from '@stellar/stellar-sdk';
import { stellarClient, USDC_ISSUER } from './client';

/**
 * Returns the total USDC received by a wallet on Stellar since a given date.
 * Filters by: payment type, destination = walletPubkey, asset = USDC with correct issuer,
 * and created_at >= sinceDate.
 * Returns 0 if the account has no transaction history yet (Horizon 404).
 *
 * Las pool wallets se reusan por round-robin, así que su historial crece sin
 * tope. Pedimos los pagos en orden descendente y cortamos en cuanto vemos uno
 * anterior a `sinceDate` — así escaneamos solo lo nuevo, en vez de recorrer
 * todas las páginas históricas.
 */
export async function getUsdcReceivedSince(walletPubkey: string, sinceDate: string): Promise<number> {
    const sinceMs = new Date(sinceDate).getTime();
    let total = 0;
    try {
        let page = await stellarClient.payments()
            .forAccount(walletPubkey)
            .order('desc')
            .limit(200)
            .call();

        while (true) {
            for (const record of page.records) {
                if (record.type !== 'payment') continue;
                const payment = record as Horizon.ServerApi.PaymentOperationRecord;
                // En orden desc, el primer record viejo nos da permiso para
                // cortar — todo lo siguiente también va a ser viejo.
                if (new Date(payment.created_at).getTime() < sinceMs) return total;
                if (
                    payment.to !== walletPubkey ||
                    payment.asset_code !== 'USDC' ||
                    payment.asset_issuer !== USDC_ISSUER
                ) continue;
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
