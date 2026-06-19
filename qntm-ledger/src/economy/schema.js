'use strict';
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');
const cfg = require('./token.config');

/**
 * schema.js -- idempotent application of the QNTM ledger + economy schema.
 *
 * The core engine ships raw-SQL migrations (001 core, 002 payments). On a fresh
 * database those are applied once here, guarded by table existence so re-runs
 * are no-ops. The economy migration (003) only adds three wallet_type enum
 * values and a status table; ALTER TYPE ... ADD VALUE is run statement-by-
 * statement (autocommit) because it cannot share a transaction with later use
 * of the value, and IF NOT EXISTS makes it safe on every boot.
 */

const SQL_DIR = path.join(__dirname, '..', '..', 'sql');
function readSql(f) { return fs.readFileSync(path.join(SQL_DIR, f), 'utf8'); }

async function ensureQntmSchema(client = pool) {
  // 001 core ledger -- run once if the wallets table is absent.
  const core = await client.query("SELECT to_regclass('public.wallets') AS t");
  if (!core.rows[0].t) await client.query(readSql('001_init.sql'));

  // 002 payments -- run once if the payment_orders table is absent.
  const pay = await client.query("SELECT to_regclass('public.payment_orders') AS t");
  if (!pay.rows[0].t) await client.query(readSql('002_payments.sql'));

  // 003 economy -- enum values (per-statement, idempotent) + status table.
  for (const wtype of cfg.NEW_WALLET_TYPES) {
    await client.query("ALTER TYPE wallet_type ADD VALUE IF NOT EXISTS '" + wtype + "'");
  }
  await client.query(
    `CREATE TABLE IF NOT EXISTS qntm_system_status (
       key         TEXT PRIMARY KEY,
       value       JSONB       NOT NULL DEFAULT '{}'::jsonb,
       created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
}

/** Idempotently create the five singleton allocation-bucket system wallets. */
async function ensureEconomyWallets(client = pool) {
  for (const a of cfg.ALLOCATIONS) {
    await client.query(
      `INSERT INTO wallets (owner_type, owner_id, wallet_type, currency)
       VALUES ('platform', NULL, $1, 'QNTM')
       ON CONFLICT (wallet_type, currency) WHERE owner_id IS NULL DO NOTHING`,
      [a.walletType]
    );
  }
}

module.exports = { ensureQntmSchema, ensureEconomyWallets };
