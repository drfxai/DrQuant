'use strict';
const wallets = require('./wallets');
const { reward } = require('./rewards');
const { E } = require('./errors');

/**
 * referrals.js — referral bonuses (spec §15) with anti-abuse baked in:
 *   * no self-referral (referrer != referee)
 *   * each (referrer, referee, action) pays at most once — enforced via a
 *     deterministic idempotency key, so duplicate webhook/clicks are no-ops.
 * Bonuses are paid from the reward pool (same budgeting as rewards).
 */
async function rewardReferral({
  referrerOwnerId, referrerOwnerType = 'user',
  refereeUserId, amount, action = 'signup', currency = 'QNTM',
}) {
  if (String(referrerOwnerId) === String(refereeUserId)) {
    throw E.Validation('self-referral is not allowed');
  }
  const referrer = await wallets.getOrCreateWallet(referrerOwnerType, referrerOwnerId, 'personal', currency);
  const idempotencyKey = `ref:${referrerOwnerId}:${refereeUserId}:${action}`;
  return reward(referrer.id, amount, {
    rewardType: 'referral_bonus',
    referenceId: `${refereeUserId}:${action}`,
    idempotencyKey,
    currency,
  });
}
module.exports = { rewardReferral };
