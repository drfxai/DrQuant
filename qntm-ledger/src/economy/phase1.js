'use strict';
const wallets = require('../wallets');
const { postTransaction } = require('../ledger');
const { writeAudit } = require('../audit');
const { splitAmount } = require('../fees');
const { E } = require('../errors');
const decimal = require('../decimal');

/**
 * phase1.js -- the two new value flows for the controlled internal economy.
 *
 *   grantFromPool()  -- an admin moves already-issued QNTM from a platform pool
 *                       into a user's personal wallet. It NEVER mints: it debits
 *                       an existing pool, so the fixed supply is conserved. If
 *                       the pool lacks the balance, the ledger's non-negative
 *                       trigger rejects the whole transaction (InsufficientFunds).
 *
 *   marketplacePay() -- a buyer pays a creator in QNTM in ONE atomic transaction
 *                       that splits the amount creator/platform/reward by basis
 *                       points (default 70/20/10, env-configurable). The
 *                       indivisible remainder goes to the creator, so no base
 *                       unit is ever created or lost.
 *
 * Both compose on postTransaction(), inheriting atomicity, row locking,
 * double-entry, balance checks and idempotency rather than re-implementing them.
 */

// Pools an admin may grant FROM. Excludes genesis (mint contra), burn, escrow,
// fee, staking, tournament_pool, subscription_settlement, and team_vesting
// (a locked allocation).
const GRANTABLE_POOLS = ['treasury', 'reward_pool', 'ecosystem', 'community_reserve'];

// Marketplace revenue split in basis points; MUST sum to 10000. Env-overridable.
const MKT = {
  creator: Number(process.env.QNTM_MKT_CREATOR_BPS || 7000),
  platform: Number(process.env.QNTM_MKT_PLATFORM_BPS || 2000),
  reward: Number(process.env.QNTM_MKT_REWARD_BPS || 1000),
};
if (MKT.creator + MKT.platform + MKT.reward !== 10000) {
  throw new Error(
    'QNTM marketplace split misconfigured: ' +
    MKT.creator + '+' + MKT.platform + '+' + MKT.reward + ' bps != 10000'
  );
}

/**
 * Admin grant: debit `pool` -> credit the user's personal wallet. No minting.
 * @param {string} pool        one of GRANTABLE_POOLS (default 'reward_pool')
 * @param {string|number} toUserId
 * @param {string} amount      decimal string (e.g. '100')
 * @param {string} actorId     the admin performing the grant (audited)
 */
async function grantFromPool({ pool = 'reward_pool', toUserId, amount, actorId, reason, idempotencyKey }) {
  if (!GRANTABLE_POOLS.includes(pool)) {
    throw E.Validation('pool must be one of ' + GRANTABLE_POOLS.join(', ') + ' (got ' + pool + ')');
  }
  if (!toUserId) throw E.Validation('toUserId is required');
  if (!decimal.isPositive(amount)) throw E.InvalidAmount();

  return wallets.withTransaction(async (cx) => {
    const fromId = await wallets.systemWalletId(pool, 'QNTM', cx);
    const to = await wallets.getOrCreateWallet('user', toUserId, 'personal', 'QNTM', cx);
    const txn = await postTransaction({
      type: 'reward', // economically a platform-funded credit
      amount,
      movements: [
        { walletId: fromId, direction: 'debit', amount, description: 'grant from ' + pool },
        { walletId: to.id, direction: 'credit', amount, description: reason || 'admin grant' },
      ],
      initiatorUserId: actorId,
      reference: { type: 'grant', id: idempotencyKey || null },
      idempotencyKey,
      metadata: { kind: 'admin_grant', pool, toUserId: String(toUserId), reason: reason || null },
    }, cx);
    await writeAudit({
      actorId, action: 'qntm.admin.grant', walletId: to.id, transactionId: txn.id, reason,
      metadata: { pool, amount, toUserId: String(toUserId) },
    }, cx);
    return { transaction: txn, pool, toUserId: String(toUserId), amount };
  });
}

/**
 * Marketplace payment: buyer pays `amount` for a creator's item; the amount is
 * split creator/platform/reward atomically. Returns the exact split.
 * @param {string|number} buyerUserId
 * @param {string|number} creatorUserId   credited in their PERSONAL wallet
 * @param {string} amount        decimal string
 * @param {string} [productRef]  opaque product reference, stored in metadata
 * @param {object} [client]      optional pg transaction to COMPOSE into, so a
 *                               caller (e.g. the Market buy flow) can settle the
 *                               payment and record the license in ONE atomic
 *                               transaction. Omit for a self-contained txn.
 *                               Backward compatible: callers that pass no client
 *                               are unaffected.
 */
async function marketplacePay({ buyerUserId, creatorUserId, amount, productRef, actorId, idempotencyKey }, client) {
  if (!buyerUserId || !creatorUserId) throw E.Validation('buyerUserId and creatorUserId are required');
  if (String(buyerUserId) === String(creatorUserId)) throw E.Validation('cannot purchase from yourself');
  if (!decimal.isPositive(amount)) throw E.InvalidAmount();

  // Exact, lossless split; creator absorbs the indivisible remainder.
  const shares = splitAmount(amount, MKT, 'creator'); // { creator, platform, reward }

  const run = async (cx) => {
    const buyer = await wallets.getOrCreateWallet('user', buyerUserId, 'personal', 'QNTM', cx);
    const creator = await wallets.getOrCreateWallet('user', creatorUserId, 'personal', 'QNTM', cx);
    const treasuryId = await wallets.systemWalletId('treasury', 'QNTM', cx);
    const rewardId = await wallets.systemWalletId('reward_pool', 'QNTM', cx);

    const txn = await postTransaction({
      type: 'marketplace_purchase',
      amount,
      movements: [
        { walletId: buyer.id, direction: 'debit', amount, description: 'marketplace payment' },
        { walletId: creator.id, direction: 'credit', amount: shares.creator, description: 'creator share' },
        { walletId: treasuryId, direction: 'credit', amount: shares.platform, description: 'platform fee' },
        { walletId: rewardId, direction: 'credit', amount: shares.reward, description: 'reward-growth share' },
      ],
      initiatorUserId: actorId || String(buyerUserId),
      reference: { type: 'marketplace_pay', id: productRef != null ? String(productRef) : (idempotencyKey || null) },
      idempotencyKey,
      metadata: {
        kind: 'marketplace_pay',
        buyerId: String(buyerUserId), creatorId: String(creatorUserId),
        productRef: productRef != null ? String(productRef) : null,
        split: shares, splitBps: MKT,
      },
    }, cx);
    await writeAudit({
      actorId: actorId || String(buyerUserId), action: 'qntm.marketplace.pay', transactionId: txn.id,
      metadata: { buyerId: String(buyerUserId), creatorId: String(creatorUserId), amount, split: shares },
    }, cx);
    return { transaction: txn, split: shares, splitBps: MKT };
  };

  // Compose into the caller's transaction when one is supplied; otherwise run in
  // our own. This is what lets the Market buy flow keep payment + license atomic.
  return client ? run(client) : wallets.withTransaction(run);
}

module.exports = { grantFromPool, marketplacePay, GRANTABLE_POOLS, MKT };
