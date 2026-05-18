/**
 * One-time setup script: seeds pool wallets into the database AND exports a SQL file.
 *
 * Lo que hace:
 *   1. Genera keypairs Stellar aleatorios
 *   2. Fondea cada una con Friendbot (testnet) → obtiene XLM para fees
 *   3. Establece trustline de USDC
 *   4. Inserta en Supabase con las secrets en plaintext
 *   5. Exporta database/seeds/pollar-pay-wallets.sql para commitear al repo
 *
 * La próxima vez que deploys, solo pegar el SQL en Supabase — sin re-correr este script.
 *
 * Usage:
 *   npx ts-node --project tsconfig.json scripts/seed-wallets.ts
 *   npx ts-node --project tsconfig.json scripts/seed-wallets.ts --count 10
 *
 * Requirements: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { writeFileSync } from 'fs';
config({ path: resolve(__dirname, '../.env.local') });

import { createClient } from '@supabase/supabase-js';
import { Keypair, TransactionBuilder, Operation, Asset, Networks, Horizon } from '@stellar/stellar-sdk';

const SUPABASE_URL         = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY         = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const HORIZON_URL          = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL        = process.env.STELLAR_FRIENDBOT_URL || 'https://friendbot.stellar.org';
const NETWORK_PASSPHRASE   = process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;
const USDC_ISSUER          = process.env.STELLAR_USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
}

const supabase       = createClient(SUPABASE_URL, SUPABASE_KEY);
const server         = new Horizon.Server(HORIZON_URL);
const USDC_ASSET     = new Asset('USDC', USDC_ISSUER);

// Output SQL file path (relative to project root)
const SQL_OUTPUT_PATH = resolve(__dirname, '../../database/seeds/pollar-pay-wallets.sql');

async function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

async function fundAndSetupWallet(keypair: Keypair, retries = 3): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(`${FRIENDBOT_URL}?addr=${keypair.publicKey()}`);
            if (!res.ok) throw new Error(`Friendbot failed: ${res.status}`);

            const account = await server.loadAccount(keypair.publicKey());
            const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
                .addOperation(Operation.changeTrust({ asset: USDC_ASSET }))
                .setTimeout(30)
                .build();
            tx.sign(keypair);
            await server.submitTransaction(tx);
            return;
        } catch (err: any) {
            if (attempt === retries) throw err;
            console.warn(`  Attempt ${attempt} failed, retrying in 3s...`);
            await sleep(3000);
        }
    }
}

function escapeSQL(str: string): string {
    return str.replace(/'/g, "''");
}

async function main() {
    const args      = process.argv.slice(2);
    const countArg  = args.indexOf('--count');
    // Default 20 wallets. Para mainnet alcanza con 20 (15 min por intent → 20
    // intents concurrentes en cualquier instante; capacidad enorme para arrancar).
    // Si esto se queda corto, subir el count.
    const WALLET_COUNT = countArg !== -1 ? parseInt(args[countArg + 1]) : 20;

    console.log(`\nPollar Pay — Pool Wallet Seeder`);
    console.log(`Seeding ${WALLET_COUNT} pool wallets...\n`);

    // Check existing pool wallet count in DB
    const { count: existing } = await supabase
        .from('wallets')
        .select('public_key', { count: 'exact', head: true })
        .eq('wallet_type', 'pool');

    const startIndex = existing || 0;

    if (startIndex > 0) {
        console.log(`⚠️  ${startIndex} pool wallet(s) already exist. Adding from index ${startIndex}.\n`);
    }

    const sqlRows: string[] = [];
    let successCount = 0;

    for (let i = 0; i < WALLET_COUNT; i++) {
        const walletIndex = startIndex + i;
        const keypair     = Keypair.random();

        process.stdout.write(`[${i + 1}/${WALLET_COUNT}] Index ${walletIndex}: ${keypair.publicKey().slice(0, 12)}...`);

        try {
            await fundAndSetupWallet(keypair);

            const secret = keypair.secret();

            // Insert into Supabase (plaintext — fail-fast if alguien lee la DB)
            const { error: dbError } = await supabase.from('wallets').insert({
                public_key:   keypair.publicKey(),
                secret_key:   secret,
                wallet_type:  'pool',
                wallet_index: walletIndex,
                is_locked:    false
            });

            if (dbError) throw dbError;

            // Collect SQL row for export
            sqlRows.push(
                `('${escapeSQL(keypair.publicKey())}', '${escapeSQL(secret)}', 'pool', ${walletIndex}, false)`
            );

            successCount++;
            process.stdout.write(` ✓\n`);
        } catch (err: any) {
            process.stdout.write(` ✗ ${err.message}\n`);
        }

        // Rate limit: 1 wallet per 1.5 seconds to avoid Friendbot throttling
        if (i < WALLET_COUNT - 1) await sleep(1500);
    }

    console.log(`\nDone: ${successCount}/${WALLET_COUNT} wallets created successfully.`);

    if (sqlRows.length > 0) {
        writeSQLFile(sqlRows, startIndex);
    }

    if (successCount < WALLET_COUNT) {
        console.log(`\nRun the script again to retry failed wallets (it will continue from index ${startIndex + successCount}).`);
    }
}

function writeSQLFile(rows: string[], startIndex: number) {
    const timestamp = new Date().toISOString();
    const header = `-- =============================================================
-- POLLAR-PAY — Pool Wallet Seed
-- =============================================================
-- Generado: ${timestamp}
-- Wallets: ${rows.length} (índices ${startIndex}..${startIndex + rows.length - 1})
-- Red: ${NETWORK_PASSPHRASE}
--
-- ⚠️  Las secret keys están en PLAINTEXT. Quien tenga acceso al SQL o a
--     la DB tiene control total sobre los fondos del pool. No commitear
--     este archivo en repos públicos.
--
-- CÓMO APLICAR EN SUPABASE:
--   1. Asegurate de haber aplicado database/schema.sql primero
--   2. Pegá este archivo en el SQL Editor de Supabase y ejecutá
--
-- ON CONFLICT DO NOTHING: seguro de correr múltiples veces.
-- =============================================================

INSERT INTO public.wallets (public_key, secret_key, wallet_type, wallet_index, is_locked)
VALUES
${rows.map((r, i) => `  ${r}${i < rows.length - 1 ? ',' : ''}`).join('\n')}
ON CONFLICT (public_key) DO NOTHING;
`;

    // Ensure output directory exists
    const { mkdirSync } = require('fs');
    const { dirname }   = require('path');
    mkdirSync(dirname(SQL_OUTPUT_PATH), { recursive: true });

    writeFileSync(SQL_OUTPUT_PATH, header, 'utf8');
    console.log(`\n✅ SQL exportado a: database/seeds/pollar-pay-wallets.sql`);
    console.log(`   Commitealo al repo para no tener que re-correr este script.`);
    console.log(`   En futuros deploys: schema.sql → pollar-pay-wallets.sql → listo.\n`);
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
