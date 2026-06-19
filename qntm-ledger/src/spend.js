'use strict';
const wallets = require('./wallets');
const { postTransaction } = require('./ledger');
const decimal = require('./decimal');
const { E } = require('./errors');

/**
 * spend.js — a user spends QNTM on a platform service/feature (spec §4.2.4).
 * Debits the user and credits a system sink wallet (default: the singleton
 * `revenue` wallet). This is the generic primitive behind feature unlocks,
 * usage-based billing, and any "pay with credits" action that isn't already
 * modeled by a richer flow (marketplace, subscription, ai, tournament).
 */
async function spend({ userOwnerId, userOwnerType = 'user', amount, sink = 'revenue', reason, currency = 'QNTM', idempotencyKey }) {
  if (!decimal.isPositive(amount)) throw E.InvalidAmount();
  const user = await wallets.getOrCreateWallet(userOwnerType, userOwnerId, 'personal', currency);
  const sinkId = await wallets.systemWalletId(sink, currency);
  return postTransaction({
    type: 'spend',
    amount,
    movements: [
      { walletId: user.id, direction: 'debit', amount, description: reason || 'spend' },
      { walletId: sinkId, direction: 'credit', amount, description: reason || 'spend' },
    ],
    currency,
    initiatorUserId: String(userOwnerId),
    reference: { type: 'spend', id: idempotencyKey || null },
    idempotencyKey,
    metadata: { reason: reason || null, sink },
  });
}
module.exports = { spend };
