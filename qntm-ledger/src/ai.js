'use strict';
const wallets = require('./wallets');
const { postTransaction } = require('./ledger');
const { splitAmount } = require('./fees');
const decimal = require('./decimal');
const { E } = require('./errors');

/**
 * ai.js — pay-per-use AI features (spec §17), e.g. AI chart analysis. The user
 * is charged QNTM; the spend is a sink split between treasury (revenue) and the
 * burn wallet (deflationary). Default: 90% treasury / 10% burn.
 */
const DEFAULT_POLICY = { treasury: 9000, burn: 1000 };

async function charge({
  userOwnerId, userOwnerType = 'user', amount, feature,
  policy = DEFAULT_POLICY, currency = 'QNTM', idempotencyKey,
}) {
  if (!decimal.isPositive(amount)) throw E.InvalidAmount();
  const user = await wallets.getOrCreateWallet(userOwnerType, userOwnerId, 'personal', currency);
  const treasuryId = await wallets.systemWalletId('treasury', currency);
  const burnId = await wallets.systemWalletId('burn', currency);
  const shares = splitAmount(amount, policy, 'treasury');
  return postTransaction({
    type: 'ai_feature_payment', amount,
    movements: [
      { walletId: user.id, direction: 'debit', amount, description: feature || 'ai feature' },
      { walletId: treasuryId, direction: 'credit', amount: shares.treasury, description: 'ai revenue' },
      { walletId: burnId, direction: 'credit', amount: shares.burn, description: 'ai burn' },
    ],
    currency, initiatorUserId: String(userOwnerId),
    reference: { type: 'ai_feature', id: feature || null },
    idempotencyKey,
    metadata: { feature: feature || null },
  });
}
module.exports = { charge, DEFAULT_POLICY };
