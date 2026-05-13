import { Horizon, Asset, Networks } from '@stellar/stellar-sdk';

export const HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
export const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;
export const USDC_ISSUER = process.env.STELLAR_USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
export const USDC_ASSET = new Asset('USDC', USDC_ISSUER);

export const stellarClient = new Horizon.Server(HORIZON_URL);
