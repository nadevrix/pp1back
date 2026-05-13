import { Keypair, TransactionBuilder, Operation, Asset, Networks, Horizon } from '@stellar/stellar-sdk';

const FRIENDBOT = 'https://friendbot.stellar.org';
const HORIZON = 'https://horizon-testnet.stellar.org';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC = new Asset('USDC', USDC_ISSUER);
const server = new Horizon.Server(HORIZON);

async function main() {
  const kp = Keypair.random();
  console.log('Generando wallet...');
  console.log('  PUBLIC:', kp.publicKey());

  const r = await fetch(`${FRIENDBOT}?addr=${kp.publicKey()}`);
  if (!r.ok) throw new Error('Friendbot failed: ' + r.status);
  console.log('  Fondeada con XLM ✓');

  const acct = await server.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(30)
    .build();
  tx.sign(kp);
  await server.submitTransaction(tx);
  console.log('  Trustline USDC ✓');

  console.log('\n=== WALLET LISTA PARA USAR COMO PAYOUT ===');
  console.log('PUBLIC :', kp.publicKey());
  console.log('SECRET :', kp.secret());
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
