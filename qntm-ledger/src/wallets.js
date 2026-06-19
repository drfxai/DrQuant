'use strict';
const { pool, withTransaction } = require('./db');
const { E } = require('./errors');

/**
 * wallets.js — wallet provisioning and lookup.
 *
 * Every user, creator, company and platform function owns a wallet. System
 * wallets (treasury, escrow, burn, reward_pool, staking, tournament_pool,
 * fee, subscription_settlement, genesis) are singletons with owner_id = NULL.
 */

const SYSTEM_WALLETS = [
  ['genesis', 'system'],
  ['treasury', 'platform'],
  ['escrow', 'platform'],
  ['burn', 'platform'],
  ['reward_pool', 'platform'],
  ['staking', 'platform'],
  ['tournament_pool', 'platform'],
  ['fee', 'platform'],
  ['subscription_settlement', 'platform'],
];

/** Idempotently create all singleton system wallets. Run once at boot. */
async function ensureSystemWallets(currency = 'QNTM', client = pool) {
  for (const [wtype, otype] of SYSTEM_WALLETS) {
    await client.query(
      `INSERT INTO wallets (owner_type, owner_id, wallet_type, currency)
       VALUES ($1, NULL, $2, $3)
       ON CONFLICT (wallet_type, currency) WHERE owner_id IS NULL DO NOTHING`,
      [otype, wtype, currency]
    );
  }
}

/** Fetch a singleton system wallet id (cached per process). */
const _systemCache = new Map();
async function systemWalletId(walletType, currency = 'QNTM', client = pool) {
  const key = `${walletType}:${currency}`;
  if (_systemCache.has(key)) return _systemCache.get(key);
  const { rows } = await client.query(
    `SELECT id FROM wallets
     WHERE wallet_type = $1 AND currency = $2 AND owner_id IS NULL`,
    [walletType, currency]
  );
  if (!rows.length) throw E.WalletNotFound(`system wallet ${walletType} missing — run ensureSystemWallets`);
  _systemCache.set(key, rows[0].id);
  return rows[0].id;
}

/**
 * Get (or lazily create) a principal's wallet. ownerType is 'user' | 'creator'
 * | 'company'; walletType defaults to 'personal'.
 */
async function getOrCreateWallet(ownerType, ownerId, walletType = 'personal', currency = 'QNTM', client = pool) {
  if (!ownerId) throw E.Validation('ownerId is required for a non-system wallet');
  const { rows } = await client.query(
    `INSERT INTO wallets (owner_type, owner_id, wallet_type, currency)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_type, owner_id, wallet_type, currency) WHERE owner_id IS NOT NULL
       DO UPDATE SET updated_at = now()
     RETURNING *`,
    [ownerType, String(ownerId), walletType, currency]
  );
  return rows[0];
}

/** Read a wallet with derived total_balance. */
async function getWallet(walletId, client = pool) {
  const { rows } = await client.query(`SELECT * FROM wallet_balances WHERE id = $1`, [walletId]);
  if (!rows.length) throw E.WalletNotFound();
  return rows[0];
}

/** Read a user's primary wallet + balances by owner identity. */
async function getUserWallet(ownerId, ownerType = 'user', currency = 'QNTM', client = pool) {
  const { rows } = await client.query(
    `SELECT * FROM wallet_balances
     WHERE owner_type = $1 AND owner_id = $2 AND wallet_type = 'personal' AND currency = $3`,
    [ownerType, String(ownerId), currency]
  );
  return rows[0] || null;
}

/**
 * Lock a set of wallet rows FOR UPDATE, ordered by id to prevent deadlocks.
 * Returns a Map<id, row>. Used by the ledger before applying any balance
 * change so two concurrent transactions can never double-spend the same row.
 */
async function lockWallets(client, walletIds) {
  const unique = [...new Set(walletIds.map(String))].map(Number).sort((a, b) => a - b);
  if (!unique.length) return new Map();
  const { rows } = await client.query(
    `SELECT * FROM wallets WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
    [unique]
  );
  const map = new Map(rows.map((r) => [Number(r.id), r]));
  for (const id of unique) {
    if (!map.has(id)) throw E.WalletNotFound(`wallet ${id} not found`);
  }
  return map;
}

/** Admin: freeze / unfreeze / close a wallet. */
async function setWalletStatus(walletId, status) {
  const { rows } = await pool.query(
    `UPDATE wallets SET status = $2 WHERE id = $1 RETURNING *`,
    [walletId, status]
  );
  if (!rows.length) throw E.WalletNotFound();
  return rows[0];
}

module.exports = {
  SYSTEM_WALLETS,
  ensureSystemWallets,
  systemWalletId,
  getOrCreateWallet,
  getWallet,
  getUserWallet,
  lockWallets,
  setWalletStatus,
  withTransaction,
};
