import { Keypair, TransactionBuilder, Operation, Asset, Networks, Horizon } from '@stellar/stellar-sdk';

const FRIENDBOT = 'https://friendbot.stellar.org';
const HORIZON = 'https://horizon-testnet.stellar.org';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC = new Asset('USDC', USDC_ISSUER);
const XLM = Asset.native();
const server = new Horizon.Server(HORIZON);

async function main() {
  const kp = Keypair.random();
  console.log('Generando customer wallet (con USDC para pagar)...');
  console.log('  PUBLIC:', kp.publicKey());

  const r = await fetch(`${FRIENDBOT}?addr=${kp.publicKey()}`);
  if (!r.ok) throw new Error('Friendbot failed: ' + r.status);
  console.log('  Fondeada con 10000 XLM ✓');

  let acct = await server.loadAccount(kp.publicKey());
  const trustTx = new TransactionBuilder(acct, { fee: '100', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(30)
    .build();
  trustTx.sign(kp);
  await server.submitTransaction(trustTx);
  console.log('  Trustline USDC ✓');

  // Path payment XLM -> USDC usando AMM testnet
  acct = await server.loadAccount(kp.publicKey());
  try {
    const swapTx = new TransactionBuilder(acct, { fee: '1000', networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.pathPaymentStrictReceive({
        sendAsset: XLM,
        sendMax: '5000',           // hasta 5000 XLM por 100 USDC
        destination: kp.publicKey(),
        destAsset: USDC,
        destAmount: '100',
        path: [],
      }))
      .setTimeout(30)
      .build();
    swapTx.sign(kp);
    await server.submitTransaction(swapTx);
    console.log('  Swap XLM→USDC: 100 USDC ✓');
  } catch (e: any) {
    console.log('  Swap falló (sin liquidez en AMM testnet):', e.response?.data?.extras?.result_codes ?? e.message);
    console.log('  → Usá Circle Faucet: https://faucet.circle.com/  (Stellar testnet + paste public key)');
  }

  // Verificar balance
  const final = await server.loadAccount(kp.publicKey());
  const usdcBal = final.balances.find(b => b.asset_type !== 'native' && (b as any).asset_code === 'USDC');
  const xlmBal  = final.balances.find(b => b.asset_type === 'native');

  console.log('\n=== CUSTOMER WALLET ===');
  console.log('PUBLIC :', kp.publicKey());
  console.log('SECRET :', kp.secret());
  console.log('XLM    :', xlmBal?.balance);
  console.log('USDC   :', usdcBal?.balance ?? '0');
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
