'use strict';
const wallets = require('./wallets');
const { postTransaction } = require('./ledger');
/**
 * creators.js — creator earnings protection (spec §11). Sale revenue lands in
 * the creator's PENDING balance and is moved to AVAILABLE only after the
 * refund/dispute window closes, shielding the platform from chargeback-style
 * abuse and fake sales.
 */
async function releasePending(creatorWalletId, amount, { reason, idempotencyKey, currency = 'QNTM', initiatorUserId } = {}) {
  return postTransaction({
    type: 'creator_release',
    amount,
    movements: [
      { walletId: creatorWalletId, direction: 'debit', amount, balance: 'pending', description: reason || 'release earnings' },
      { walletId: creatorWalletId, direction: 'credit', amount, balance: 'available', description: reason || 'release earnings' },
    ],
    currency, initiatorUserId,
    reference: { type: 'creator_release', id: idempotencyKey || null },
    idempotencyKey,
    metadata: { reason: reason || null },
  });
}
module.exports = { releasePending };
