'use strict';
const wallets = require('./wallets');
const { postTransaction } = require('./ledger');
/**
 * burn.js — burn-wallet model (spec §13.1). Tokens are moved to the singleton
 * burn wallet and thereby excluded from circulating supply. They are never
 * destroyed in-place, so the burn total is always auditable and could later be
 * reconciled against on-chain burns.
 */
async function burn(fromWalletId, amount, { reason, currency = 'QNTM', initiatorUserId, idempotencyKey } = {}) {
  const burnWallet = await wallets.systemWalletId('burn', currency);
  return postTransaction({
    type: 'burn',
    amount,
    movements: [
      { walletId: fromWalletId, direction: 'debit', amount, description: reason || 'burn' },
      { walletId: burnWallet, direction: 'credit', amount, description: reason || 'burn' },
    ],
    currency,
    initiatorUserId,
    reference: { type: 'burn', id: idempotencyKey || null },
    idempotencyKey,
    metadata: { reason: reason || null },
  });
}
module.exports = { burn };
