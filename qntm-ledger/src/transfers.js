'use strict';
const wallets = require('./wallets');
const { postTransaction } = require('./ledger');
const { writeAudit } = require('./audit');
const { E } = require('./errors');
const decimal = require('./decimal');

/**
 * transfers.js — user-to-user QNTM transfer (spec §8).
 * Validation (existence, sufficient balance, frozen state, double-spend) is
 * inherited from the ledger primitive; we only add product-level checks and an
 * optional flat platform fee.
 */
async function transfer({
  fromOwnerId, fromOwnerType = 'user',
  toOwnerId, toOwnerType = 'user',
  amount, note, fee = '0', idempotencyKey, currency = 'QNTM', initiatorUserId,
}) {
  if (!decimal.isPositive(amount)) throw E.InvalidAmount();
  if (String(fromOwnerId) === String(toOwnerId) && fromOwnerType === toOwnerType) {
    throw E.Validation('cannot transfer to yourself');
  }
  const from = await wallets.getOrCreateWallet(fromOwnerType, fromOwnerId, 'personal', currency);
  const to = await wallets.getOrCreateWallet(toOwnerType, toOwnerId, 'personal', currency);

  const movements = [
    { walletId: from.id, direction: 'debit', amount, description: note || 'transfer' },
    { walletId: to.id, direction: 'credit', amount, description: note || 'transfer' },
  ];
  if (decimal.isPositive(fee)) {
    const feeWallet = await wallets.systemWalletId('fee', currency);
    // fee is charged on top: sender pays amount + fee, fee goes to fee wallet
    movements[0].amount = decimal.add(amount, fee);
    movements.push({ walletId: feeWallet, direction: 'credit', amount: fee, description: 'transfer fee' });
  }
  const txn = await postTransaction({
    type: 'transfer',
    movements,
    amount,
    currency,
    initiatorUserId: initiatorUserId || String(fromOwnerId),
    reference: { type: 'transfer', id: idempotencyKey || null },
    idempotencyKey,
    metadata: { note: note || null, fee },
  });
  return txn;
}
module.exports = { transfer };
