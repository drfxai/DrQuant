'use strict';
const wallets = require('./wallets');
const { postTransaction } = require('./ledger');
const { withTransaction } = require('./db');
const { writeAudit } = require('./audit');
const decimal = require('./decimal');
const { E } = require('./errors');

/**
 * rewards.js — engagement/loyalty rewards (spec §14). Rewards are paid from the
 * singleton reward_pool wallet, which must be funded ahead of time from treasury
 * (fundRewardPool). Paying from a finite, pre-funded pool makes reward spend
 * budgetable and prevents unbounded issuance.
 */
async function fundRewardPool(amount, { actorId, reason } = {}) {
  if (!decimal.isPositive(amount)) throw E.InvalidAmount();
  return withTransaction(async (cx) => {
    const treasuryId = await wallets.systemWalletId('treasury', 'QNTM', cx);
    const poolId = await wallets.systemWalletId('reward_pool', 'QNTM', cx);
    const txn = await postTransaction({
      type: 'reward', amount,
      movements: [
        { walletId: treasuryId, direction: 'debit', amount, description: 'fund reward pool' },
        { walletId: poolId, direction: 'credit', amount, description: 'reward pool top-up' },
      ],
      initiatorUserId: actorId, allowFrozen: true,
      reference: { type: 'reward_pool_funding' },
      metadata: { reason: reason || null },
    }, cx);
    await writeAudit({ actorId, action: 'rewards.fund_pool', transactionId: txn.id, metadata: { amount } }, cx);
    return txn;
  });
}

async function reward(toWalletId, amount, { rewardType, referenceId, idempotencyKey, currency = 'QNTM' } = {}) {
  if (!decimal.isPositive(amount)) throw E.InvalidAmount();
  const poolId = await wallets.systemWalletId('reward_pool', currency);
  return postTransaction({
    type: 'reward', amount,
    movements: [
      { walletId: poolId, direction: 'debit', amount, description: rewardType || 'reward' },
      { walletId: toWalletId, direction: 'credit', amount, description: rewardType || 'reward' },
    ],
    currency,
    reference: { type: rewardType || 'reward', id: referenceId || null },
    idempotencyKey,
    metadata: { rewardType: rewardType || null },
  });
}
module.exports = { fundRewardPool, reward };
