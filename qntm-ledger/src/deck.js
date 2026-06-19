'use strict';
const { pool } = require('./db');
const wallets = require('./wallets');
const treasury = require('./treasury');
const supply = require('./supply');

/**
 * deck.js — read/aggregate queries for the QNTM Control Deck (spec §5.2).
 *
 * READ-ONLY. Every figure is derived from the authoritative wallet/ledger
 * tables, never stored, so the dashboard cannot drift from the ledger. State
 * changes (mint, grant, adjust, re-credit) go through the existing admin routes
 * and the ledger engine — nothing here writes balances.
 */

function negateBalance(s) {
  if (s == null) return null;
  if (s.startsWith('-')) return s.slice(1);
  if (/^0(\.0+)?$/.test(s)) return s;
  return `-${s}`;
}

async function _systemBalance(walletType, currency) {
  try {
    const w = await wallets.getWallet(await wallets.systemWalletId(walletType, currency));
    return w ? w.available_balance : null;
  } catch (_) { return null; } // wallet may not exist yet (e.g. pre-002 control_deck)
}

/** §5.2.1 — dashboard summary cards + integrity + recent activity. */
async function dashboard({ currency = 'QNTM', recent = 10 } = {}) {
  const supplySummary = await treasury.supplySummary();
  const genesisBal = await _systemBalance('genesis', currency);
  const { rows: userAgg } = await pool.query(
    `SELECT COALESCE(SUM(available_balance + pending_balance + locked_balance), 0) AS total,
            COUNT(*)::int AS wallets
       FROM wallets WHERE owner_type = 'user' AND currency = $1`, [currency]);
  const { rows: active } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM wallets WHERE currency = $1 AND status = 'active'`, [currency]);

  let recentOrders = [];
  try {
    const { rows } = await pool.query(
      `SELECT public_id, user_id, qntm_amount, fiat_amount_usd, pay_currency, status, created_at, updated_at
         FROM payment_orders ORDER BY id DESC LIMIT $1`, [recent]);
    recentOrders = rows;
  } catch (_) { /* payment_orders absent pre-002 */ }

  return {
    currency,
    totalIssued: negateBalance(genesisBal),       // genesis holds -(total issued)
    treasuryBalance: await _systemBalance('treasury', currency),
    controlDeckBalance: await _systemBalance('control_deck', currency),
    revenueBalance: await _systemBalance('revenue', currency),
    userBalanceTotal: userAgg[0].total,
    userWalletCount: userAgg[0].wallets,
    activeWallets: active[0].n,
    supply: supplySummary,
    integrity: await supply.verifyIntegrity(),
    recentTransactions: await recentTransactions({ limit: recent, currency }),
    recentPaymentOrders: recentOrders,
  };
}

async function recentTransactions({ limit = 20, currency = 'QNTM' } = {}) {
  const { rows } = await pool.query(
    `SELECT id, public_id, type, status, amount, currency, initiator_user_id,
            reference_type, reference_id, metadata, created_at
       FROM transactions WHERE currency = $1 ORDER BY id DESC LIMIT $2`,
    [currency, Math.min(limit, 200)]);
  return rows;
}

/**
 * §5.2.4 — ledger explorer. Filter transactions by type, initiating user,
 * involved wallet, and/or date range; paginate with `before` (an id). Pass
 * withEntries=true to attach each transaction's double-entry lines.
 */
async function ledgerExplorer({
  type, initiatorUserId, walletId, fromDate, toDate,
  currency = 'QNTM', limit = 50, before = null, withEntries = false,
} = {}) {
  const params = [currency];
  const where = ['t.currency = $1'];
  if (type) { params.push(type); where.push(`t.type = $${params.length}`); }
  if (initiatorUserId) { params.push(String(initiatorUserId)); where.push(`t.initiator_user_id = $${params.length}`); }
  if (fromDate) { params.push(fromDate); where.push(`t.created_at >= $${params.length}`); }
  if (toDate) { params.push(toDate); where.push(`t.created_at <= $${params.length}`); }
  if (before) { params.push(before); where.push(`t.id < $${params.length}`); }
  let join = '';
  if (walletId) { params.push(Number(walletId)); join = `JOIN ledger_entries le ON le.transaction_id = t.id AND le.wallet_id = $${params.length}`; }
  params.push(Math.min(limit, 200));
  const { rows } = await pool.query(
    `SELECT DISTINCT t.id, t.public_id, t.type, t.status, t.amount, t.currency,
            t.initiator_user_id, t.reference_type, t.reference_id, t.metadata, t.created_at
       FROM transactions t ${join} WHERE ${where.join(' AND ')}
       ORDER BY t.id DESC LIMIT $${params.length}`, params);

  if (withEntries && rows.length) {
    const ids = rows.map((r) => r.id);
    const { rows: entries } = await pool.query(
      `SELECT le.transaction_id, le.wallet_id, w.owner_type, w.owner_id, w.wallet_type,
              le.direction, le.amount, le.balance_kind, le.balance_after, le.description
         FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id
        WHERE le.transaction_id = ANY($1) ORDER BY le.transaction_id DESC, le.id`, [ids]);
    const byTxn = new Map();
    for (const e of entries) {
      if (!byTxn.has(e.transaction_id)) byTxn.set(e.transaction_id, []);
      byTxn.get(e.transaction_id).push(e);
    }
    for (const r of rows) r.entries = byTxn.get(r.id) || [];
  }
  return rows;
}

/** A single transaction with all its ledger entries. */
async function transactionDetail(publicId) {
  const { rows } = await pool.query(`SELECT * FROM transactions WHERE public_id = $1`, [publicId]);
  if (!rows.length) return null;
  const t = rows[0];
  const { rows: entries } = await pool.query(
    `SELECT le.id, le.wallet_id, w.owner_type, w.owner_id, w.wallet_type,
            le.direction, le.amount, le.balance_kind, le.balance_after, le.description, le.created_at
       FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id
      WHERE le.transaction_id = $1 ORDER BY le.id`, [t.id]);
  t.entries = entries;
  return t;
}

/**
 * §5.2.5 — user wallet inspector. The ledger keys users by id; email/username
 * resolution is the host app's job, so this takes a userId. Returns the wallet,
 * recent transactions touching it, and a per-type/direction breakdown.
 */
async function userInspector({ userId, ownerType = 'user', currency = 'QNTM', limit = 50 } = {}) {
  const wallet = await wallets.getUserWallet(userId, ownerType, currency);
  if (!wallet) return { userId: String(userId), wallet: null, transactions: [], breakdown: [] };
  const { rows: txns } = await pool.query(
    `SELECT DISTINCT t.id, t.public_id, t.type, t.status, t.amount, t.created_at
       FROM transactions t JOIN ledger_entries le ON le.transaction_id = t.id
      WHERE le.wallet_id = $1 ORDER BY t.id DESC LIMIT $2`, [wallet.id, Math.min(limit, 200)]);
  const { rows: breakdown } = await pool.query(
    `SELECT t.type, le.direction, COUNT(*)::int AS count, SUM(le.amount) AS volume
       FROM transactions t JOIN ledger_entries le ON le.transaction_id = t.id
      WHERE le.wallet_id = $1 GROUP BY t.type, le.direction ORDER BY t.type`, [wallet.id]);
  return { userId: String(userId), wallet, transactions: txns, breakdown };
}

/** §5.2.6 — admin personal wallet (owner_type='admin'), same model as a user. */
async function getOrCreateAdminWallet(adminId, currency = 'QNTM') {
  return wallets.getOrCreateWallet('admin', adminId, 'personal', currency);
}

async function adminWalletHistory(adminId, { currency = 'QNTM', limit = 50 } = {}) {
  const wallet = await getOrCreateAdminWallet(adminId, currency);
  const { rows } = await pool.query(
    `SELECT t.id, t.public_id, t.type, t.status, t.amount, t.created_at,
            le.direction, le.amount AS entry_amount, le.description
       FROM transactions t JOIN ledger_entries le ON le.transaction_id = t.id
      WHERE le.wallet_id = $1 ORDER BY t.id DESC LIMIT $2`, [wallet.id, Math.min(limit, 200)]);
  return { wallet, transactions: rows };
}

module.exports = {
  dashboard, recentTransactions, ledgerExplorer, transactionDetail,
  userInspector, getOrCreateAdminWallet, adminWalletHistory,
};
