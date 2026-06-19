'use strict';
const { pool } = require('./db');
const treasury = require('./treasury');
/**
 * supply.js — supply & financial reporting (spec §27/§28). Thin reporting layer
 * over the authoritative wallet balances; figures are derived, never stored, so
 * they cannot drift from the ledger.
 */
async function snapshot() { return treasury.supplySummary(); }

/** Per-wallet-type balance totals — useful for an admin dashboard. */
async function byWalletType(currency = 'QNTM') {
  const { rows } = await pool.query(
    `SELECT wallet_type,
            COUNT(*)::int AS wallets,
            SUM(available_balance) AS available,
            SUM(pending_balance) AS pending,
            SUM(locked_balance) AS locked,
            SUM(available_balance+pending_balance+locked_balance) AS total
     FROM wallets WHERE currency=$1 GROUP BY wallet_type ORDER BY wallet_type`, [currency]);
  return rows;
}

/** Transaction volume by type over a window (defaults to last 30 days). */
async function volumeByType({ sinceDays = 30, currency = 'QNTM' } = {}) {
  const { rows } = await pool.query(
    `SELECT type, status, COUNT(*)::int AS count, SUM(amount) AS volume
     FROM transactions
     WHERE currency=$1 AND created_at >= now() - ($2 || ' days')::interval
     GROUP BY type, status ORDER BY type`, [currency, String(sinceDays)]);
  return rows;
}

/**
 * Integrity check: confirm the global double-entry invariant holds across the
 * ENTIRE ledger (every transaction nets to zero per currency). Returns the list
 * of any offending transactions — should always be empty.
 */
async function verifyIntegrity() {
  const { rows } = await pool.query(
    `SELECT transaction_id, currency, SUM(signed_amount) AS net
     FROM ledger_entries GROUP BY transaction_id, currency HAVING SUM(signed_amount) <> 0`);
  return { ok: rows.length === 0, offenders: rows };
}
module.exports = { snapshot, byWalletType, volumeByType, verifyIntegrity };
