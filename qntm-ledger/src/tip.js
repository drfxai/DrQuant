'use strict';
const wallets = require('./wallets');
const { postTransaction } = require('./ledger');
const decimal = require('./decimal');
const { E } = require('./errors');

/**
 * tip.js — user-to-user tip of QNTM credits (spec §4.2.5). Closed-loop: the
 * recipient's credits are equally non-redeemable, so this is a gift of internal
 * credits (like gifting in-game currency), never a money transfer.
 */
async function tip({ fromOwnerId, toOwnerId, amount, note, currency = 'QNTM', idempotencyKey }) {
  if (!decimal.isPositive(amount)) throw E.InvalidAmount();
  if (String(fromOwnerId) === String(toOwnerId)) throw E.Validation('cannot tip yourself');
  const from = await wallets.getOrCreateWallet('user', fromOwnerId, 'personal', currency);
  const to = await wallets.getOrCreateWallet('user', toOwnerId, 'personal', currency);
  return postTransaction({
    type: 'tip',
    amount,
    movements: [
      { walletId: from.id, direction: 'debit', amount, description: note || 'tip' },
      { walletId: to.id, direction: 'credit', amount, description: note || 'tip' },
    ],
    currency,
    initiatorUserId: String(fromOwnerId),
    reference: { type: 'tip', id: idempotencyKey || null },
    idempotencyKey,
    metadata: { note: note || null, to: String(toOwnerId) },
  });
}
module.exports = { tip };
