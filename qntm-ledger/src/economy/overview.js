'use strict';
const { pool } = require('../db');
const treasury = require('../treasury');
const cfg = require('./token.config');
const bootstrap = require('./bootstrap');

/**
 * overview.js -- read models for the admin economy endpoints. Read-only; every
 * figure is derived from wallet balances / the ledger. Amounts are exposed in
 * BOTH 6-decimal QNTM and integer base-unit string form (never a float).
 */

function amt(ledgerStr) {
  return { qntm: cfg.toQntm6(ledgerStr), baseUnits: cfg.toBase6(ledgerStr) };
}

async function bucketBalances(client = pool) {
  const out = [];
  for (const a of cfg.ALLOCATIONS) {
    const { rows } = await client.query(
      "SELECT available_balance FROM wallets WHERE wallet_type = $1 AND owner_id IS NULL AND currency = 'QNTM'",
      [a.walletType]);
    const bal = rows.length ? rows[0].available_balance : '0';
    out.push({
      code: a.code, walletType: a.walletType, percent: a.percent,
      target: amt(a.amount), balance: amt(bal), policy: a.policy,
    });
  }
  return out;
}

async function overview(client = pool) {
  const sup = await treasury.supplySummary(client);
  const st = await bootstrap.status(client);
  return {
    token: {
      symbol: cfg.SYMBOL, name: cfg.NAME, decimals: cfg.DECIMALS,
      baseUnitsPerQntm: cfg.BASE_UNITS_PER_QNTM.toString(),
      maxSupply: amt(cfg.TOTAL_SUPPLY), publicSaleEnabled: cfg.PUBLIC_SALE_ENABLED,
    },
    bootstrapped: !!(st && st.completed),
    bootstrap: st || { completed: false },
    supply: {
      totalIssued: amt(sup.totalIssued),
      circulating: amt(sup.circulating),
      treasury: amt(sup.treasury),
      rewardPool: amt(sup.rewardPool),
      lockedTotal: amt(sup.lockedTotal),
      burned: amt(sup.burned),
    },
    allocations: await bucketBalances(client),
  };
}

async function walletsView(client = pool) {
  const { rows } = await client.query(
    `SELECT id, owner_type, wallet_type, currency, available_balance, pending_balance, locked_balance, status
     FROM wallets WHERE currency = 'QNTM' AND owner_id IS NULL ORDER BY wallet_type`);
  return rows.map((w) => ({
    id: w.id, walletType: w.wallet_type, ownerType: w.owner_type, status: w.status,
    available: amt(w.available_balance), pending: amt(w.pending_balance), locked: amt(w.locked_balance),
  }));
}

async function transactionsView({ limit = 50, before = null, type = null } = {}, client = pool) {
  const params = ['QNTM'];
  const where = ['currency = $1'];
  if (type) { params.push(type); where.push('type = $' + params.length); }
  if (before) { params.push(before); where.push('id < $' + params.length); }
  params.push(Math.min(Number(limit) || 50, 200));
  const { rows } = await client.query(
    `SELECT id, public_id, type, status, amount, currency, initiator_user_id,
            reference_type, reference_id, metadata, created_at
     FROM transactions WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`,
    params);
  return rows.map((t) => Object.assign({}, t, {
    amountQntm: cfg.toQntm6(t.amount), amountBaseUnits: cfg.toBase6(t.amount),
  }));
}

module.exports = { overview, walletsView, transactionsView, bucketBalances };
