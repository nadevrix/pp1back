// Uso: npx tsx scripts/pay.ts <DESTINO_PUBLIC_KEY> <AMOUNT>
// Ej:  npx tsx scripts/pay.ts GAB...XYZ 5

import { Keypair, TransactionBuilder, Operation, Asset, Networks, Horizon } from '@stellar/stellar-sdk';

const HORIZON = 'https://horizon-testnet.stellar.org';
const USDC = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
const server = new Horizon.Server(HORIZON);

const CUSTOMER_SECRET = process.env.CUSTOMER_SECRET;
if (!CUSTOMER_SECRET) {
  console.error('ERROR: falta CUSTOMER_SECRET en el entorno (define en .env.local)');
  process.exit(1);
}

async function main() {
  const [destination, amount] = process.argv.slice(2);
  if (!destination || !amount) {
    console.error('Uso: npx tsx scripts/pay.ts <DESTINO> <AMOUNT_USDC>');
    process.exit(1);
  }

  const kp = Keypair.fromSecret(CUSTOMER_SECRET);
  console.log(`Pagando ${amount} USDC desde ${kp.publicKey().slice(0,8)}... a ${destination.slice(0,8)}...`);

  const acct = await server.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination, asset: USDC, amount }))
    .setTimeout(30)
    .build();
  tx.sign(kp);

  const res = await server.submitTransaction(tx);
  console.log('  Hash:', res.hash);
  console.log('  Ver en explorer: https://stellar.expert/explorer/testnet/tx/' + res.hash);
  console.log('  ✓ Pago enviado. El worker debería detectarlo en ~1 segundo.');
}
main().catch(e => { console.error('ERROR:', e.response?.data?.extras?.result_codes ?? e.message); process.exit(1); });
