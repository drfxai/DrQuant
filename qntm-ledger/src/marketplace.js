'use strict';
const wallets = require('./wallets');
const escrow = require('./escrow');
const creators = require('./creators');
const { splitAmount } = require('./fees');
const { emit } = require('./events');
const { E } = require('./errors');
const decimal = require('./decimal');

/**
 * marketplace.js — escrow-protected purchase + settlement (spec §9, §29).
 *
 * Flow:
 *   1. purchase(): buyer funds escrow, product access is granted immediately,
 *      a refund window starts.
 *   2. settle(): after the window, escrow is split — creator's share to their
 *      PENDING balance, platform fee to treasury, burn share to the burn wallet.
 *   3. releaseToCreator(): after the dispute window, creator PENDING -> AVAILABLE.
 *
 * Default fee policy (override per call): creator 85% / treasury 10% / burn 5%.
 */
const DEFAULT_POLICY = { creator: 8500, treasury: 1000, burn: 500 };

async function purchase({
  buyerOwnerId, buyerOwnerType = 'user',
  creatorOwnerId, creatorOwnerType = 'creator',
  amount, productRef, refundWindowSeconds = 86400, currency = 'QNTM', idempotencyKey,
}) {
  if (!decimal.isPositive(amount)) throw E.InvalidAmount();
  const buyer = await wallets.getOrCreateWallet(buyerOwnerType, buyerOwnerId, 'personal', currency);
  const seller = await wallets.getOrCreateWallet(creatorOwnerType, creatorOwnerId, 'creator', currency);

  const { escrow: esc, transaction } = await escrow.createAndFund({
    buyerWalletId: buyer.id, sellerWalletId: seller.id, amount,
    releaseAfterSeconds: refundWindowSeconds,
    reference: { type: 'product', id: productRef, kind: 'marketplace' },
    currency, initiatorUserId: String(buyerOwnerId), idempotencyKey,
  });

  emit('marketplace.purchase.completed', {
    transactionId: transaction.public_id, escrowId: esc.public_id,
    buyerId: String(buyerOwnerId), creatorId: String(creatorOwnerId),
    amount, currency, productRef,
  });
  // Access-granting is the caller's domain; we just signal it's safe to grant.
  return { escrow: esc, transaction };
}

/** Settle a funded escrow into creator pending + fee sinks. */
async function settle(escrowId, { policy = DEFAULT_POLICY } = {}) {
  // We need the escrow's seller + amount to map the split to wallet ids.
  const { pool } = require('./db');
  const { rows } = await pool.query(`SELECT * FROM escrows WHERE id = $1`, [escrowId]);
  if (!rows.length) throw E.Validation('escrow not found');
  const esc = rows[0];
  const treasuryId = await wallets.systemWalletId('treasury', esc.currency);
  const burnId = await wallets.systemWalletId('burn', esc.currency);

  const shares = splitAmount(esc.amount, policy, 'creator'); // creator absorbs remainder
  const split = {
    [esc.seller_wallet_id]: shares.creator,
    [treasuryId]: shares.treasury,
    [burnId]: shares.burn,
  };
  // creator share lands in PENDING; fees are immediately available/burned.
  const creditKinds = { [esc.seller_wallet_id]: 'pending' };
  const txn = await escrow.release(escrowId, { split, creditKinds });

  emit('creator.revenue.pending', {
    escrowId: esc.public_id, creatorWalletId: esc.seller_wallet_id,
    amount: shares.creator, currency: esc.currency,
  });
  return { transaction: txn, shares };
}

/** After the dispute window, move the creator's pending share to available. */
async function releaseToCreator(creatorWalletId, amount, opts = {}) {
  return creators.releasePending(creatorWalletId, amount, opts);
}

module.exports = { purchase, settle, releaseToCreator, DEFAULT_POLICY };
