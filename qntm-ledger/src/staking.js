'use strict';
const { pool, withTransaction } = require('./db');
const wallets = require('./wallets');
const { postTransaction } = require('./ledger');
const { emit } = require('./events');
const { E } = require('./errors');
const decimal = require('./decimal');

/**
 * staking.js — staking / locking (spec §19). Staking RECLASSIFIES a user's own
 * tokens from `available` to `locked` within the same wallet (no transfer to a
 * pool), so total balance is unchanged and the lock is provable on the ledger.
 * Unstaking enters a cooldown; after it elapses the tokens return to available.
 *
 * Tiers gate platform perks by staked size (the perks themselves live in app
 * logic; here we just record the tier).
 */
const TIERS = [
  { name: 'Institutional', min: '50000' },
  { name: 'Gold', min: '10000' },
  { name: 'Silver', min: '2000' },
  { name: 'Bronze', min: '500' },
];
const COOLDOWN_DAYS = Number(process.env.QNTM_STAKE_COOLDOWN_DAYS || 7);

function tierFor(amount) {
  for (const t of TIERS) if (decimal.cmp(amount, t.min) >= 0) return t.name;
  return null;
}

async function stake({ ownerId, ownerType = 'user', amount, currency = 'QNTM', idempotencyKey }) {
  if (!decimal.isPositive(amount)) throw E.InvalidAmount();
  const w = await wallets.getOrCreateWallet(ownerType, ownerId, 'personal', currency);
  return withTransaction(async (cx) => {
    const txn = await postTransaction({
      type: 'staking_lock', amount,
      movements: [
        { walletId: w.id, direction: 'debit', amount, balance: 'available', description: 'stake' },
        { walletId: w.id, direction: 'credit', amount, balance: 'locked', description: 'stake' },
      ],
      currency, initiatorUserId: String(ownerId),
      reference: { type: 'stake' }, idempotencyKey,
    }, cx);
    const tier = tierFor(amount);
    const { rows } = await cx.query(
      `INSERT INTO stakes (wallet_id, amount, tier, status) VALUES ($1,$2,$3,'active') RETURNING *`,
      [w.id, amount, tier]
    );
    emit('staking.locked', { stakeId: rows[0].public_id, walletId: w.id, amount, tier });
    return { stake: rows[0], transaction: txn, tier };
  });
}

/**
 * Begin unstaking: moves the stake to `cooldown` and stamps cooldown_until.
 * Tokens stay locked during cooldown. Call completeUnstake() once it elapses.
 */
async function requestUnstake(stakeId) {
  const { rows } = await pool.query(
    `UPDATE stakes SET status='cooldown', cooldown_until = now() + ($2 || ' days')::interval, updated_at=now()
     WHERE id=$1 AND status='active' RETURNING *`,
    [stakeId, String(COOLDOWN_DAYS)]
  );
  if (!rows.length) throw E.Conflict('stake not active');
  emit('staking.cooldown', { stakeId: rows[0].public_id, cooldownUntil: rows[0].cooldown_until });
  return rows[0];
}

/** After cooldown, return locked tokens to available and close the stake. */
async function completeUnstake(stakeId) {
  return withTransaction(async (cx) => {
    const { rows } = await cx.query(`SELECT * FROM stakes WHERE id=$1 FOR UPDATE`, [stakeId]);
    if (!rows.length) throw E.Validation('stake not found');
    const stake = rows[0];
    if (stake.status === 'released') throw E.Conflict('stake already released');
    if (stake.status !== 'cooldown') throw E.Conflict('stake is not in cooldown');
    if (stake.cooldown_until && new Date(stake.cooldown_until) > new Date()) {
      throw E.Conflict(`cooldown active until ${stake.cooldown_until.toISOString()}`);
    }
    const txn = await postTransaction({
      type: 'staking_unlock', amount: stake.amount,
      movements: [
        { walletId: stake.wallet_id, direction: 'debit', amount: stake.amount, balance: 'locked', description: 'unstake' },
        { walletId: stake.wallet_id, direction: 'credit', amount: stake.amount, balance: 'available', description: 'unstake' },
      ],
      currency: 'QNTM', reference: { type: 'stake', id: stake.public_id },
    }, cx);
    await cx.query(`UPDATE stakes SET status='released' WHERE id=$1`, [stakeId]);
    emit('staking.released', { stakeId: stake.public_id, amount: stake.amount });
    return { stake: { ...stake, status: 'released' }, transaction: txn };
  });
}

async function listStakes(ownerId, ownerType = 'user', currency = 'QNTM') {
  const w = await wallets.getUserWallet(ownerId, ownerType, currency);
  if (!w) return [];
  const { rows } = await pool.query(
    `SELECT * FROM stakes WHERE wallet_id = $1 ORDER BY created_at DESC`, [w.id]);
  return rows;
}
module.exports = { stake, requestUnstake, completeUnstake, listStakes, tierFor, TIERS, COOLDOWN_DAYS };
