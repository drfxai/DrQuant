'use strict';
const { pool, withTransaction } = require('./db');
const wallets = require('./wallets');
const { postTransaction } = require('./ledger');
const { E } = require('./errors');
const decimal = require('./decimal');

/**
 * escrow.js — generic escrow lifecycle (spec §10).
 *   created -> funded -> active -> released | refunded
 *                                  \-> disputed -> released | refunded
 * Buyer funds the singleton escrow wallet; on release the funds are split to
 * the seller (+ fee/burn sinks) per the caller's policy; on refund they go
 * back to the buyer in full. Money only ever moves through postTransaction.
 */

async function createAndFund({
  buyerWalletId, sellerWalletId, amount, releaseAfterSeconds = 0,
  reference = {}, currency = 'QNTM', initiatorUserId, idempotencyKey,
}) {
  if (!decimal.isPositive(amount)) throw E.InvalidAmount();
  const escrowWalletId = await wallets.systemWalletId('escrow', currency);
  return withTransaction(async (cx) => {
    const txn = await postTransaction({
      type: 'escrow_lock',
      amount,
      movements: [
        { walletId: buyerWalletId, direction: 'debit', amount, description: 'escrow fund' },
        { walletId: escrowWalletId, direction: 'credit', amount, description: 'escrow hold' },
      ],
      currency, initiatorUserId,
      reference: { type: 'escrow', id: reference.id || null },
      idempotencyKey,
      metadata: reference,
    }, cx);

    const releaseAfter = releaseAfterSeconds > 0
      ? new Date(Date.now() + releaseAfterSeconds * 1000) : null;
    const { rows } = await cx.query(
      `INSERT INTO escrows
         (buyer_wallet_id, seller_wallet_id, escrow_wallet_id, amount, currency,
          status, release_after, reference_type, reference_id, metadata)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9)
       RETURNING *`,
      [buyerWalletId, sellerWalletId, escrowWalletId, amount, currency,
       releaseAfter, reference.type || null, reference.id != null ? String(reference.id) : null, reference]
    );
    return { escrow: rows[0], transaction: txn };
  });
}

/** Lock + load an escrow row inside an existing tx. */
async function _loadForUpdate(cx, escrowId) {
  const { rows } = await cx.query(`SELECT * FROM escrows WHERE id = $1 FOR UPDATE`, [escrowId]);
  if (!rows.length) throw E.Validation(`escrow ${escrowId} not found`);
  return rows[0];
}

/**
 * Release escrow to the seller. `split` is an object of { walletId: amount }
 * that MUST sum to the escrow amount; pass the result of fees.splitAmount
 * mapped to wallet ids (seller pending, treasury, burn, ...).
 * `creditKinds` optionally maps walletId -> 'pending'|'available' (seller funds
 * usually land in 'pending' until the dispute window fully closes).
 */
async function release(escrowId, { split, creditKinds = {}, initiatorUserId } = {}) {
  return withTransaction(async (cx) => {
    const esc = await _loadForUpdate(cx, escrowId);
    if (!['active', 'funded', 'disputed'].includes(esc.status)) {
      throw E.Conflict(`escrow ${escrowId} cannot be released from status ${esc.status}`);
    }
    const total = Object.values(split).reduce((a, b) => decimal.add(a, b), '0');
    if (decimal.cmp(total, esc.amount) !== 0) {
      throw E.Validation(`split total ${total} != escrow amount ${esc.amount}`);
    }
    const movements = [
      { walletId: esc.escrow_wallet_id, direction: 'debit', amount: esc.amount, description: 'escrow release' },
      ...Object.entries(split).map(([walletId, amount]) => ({
        walletId: Number(walletId), direction: 'credit', amount,
        balance: creditKinds[walletId] || 'available',
        description: 'escrow settlement',
      })),
    ];
    const txn = await postTransaction({
      type: 'escrow_release', amount: esc.amount, movements,
      currency: esc.currency, initiatorUserId,
      reference: { type: 'escrow', id: esc.public_id },
    }, cx);
    await cx.query(`UPDATE escrows SET status = 'released' WHERE id = $1`, [escrowId]);
    return txn;
  });
}

/** Full refund back to the buyer. */
async function refund(escrowId, { initiatorUserId } = {}) {
  return withTransaction(async (cx) => {
    const esc = await _loadForUpdate(cx, escrowId);
    if (!['active', 'funded', 'disputed'].includes(esc.status)) {
      throw E.Conflict(`escrow ${escrowId} cannot be refunded from status ${esc.status}`);
    }
    const txn = await postTransaction({
      type: 'escrow_refund', amount: esc.amount,
      movements: [
        { walletId: esc.escrow_wallet_id, direction: 'debit', amount: esc.amount, description: 'escrow refund' },
        { walletId: esc.buyer_wallet_id, direction: 'credit', amount: esc.amount, description: 'escrow refund' },
      ],
      currency: esc.currency, initiatorUserId,
      reference: { type: 'escrow', id: esc.public_id },
    }, cx);
    await cx.query(`UPDATE escrows SET status = 'refunded' WHERE id = $1`, [escrowId]);
    return txn;
  });
}

async function dispute(escrowId) {
  const { rows } = await pool.query(
    `UPDATE escrows SET status = 'disputed', updated_at = now()
     WHERE id = $1 AND status IN ('active','funded') RETURNING *`, [escrowId]);
  if (!rows.length) throw E.Conflict('escrow not in a disputable state');
  return rows[0];
}

/** Find escrows whose refund window has elapsed and are ready to settle. */
async function dueForSettlement(limit = 100) {
  const { rows } = await pool.query(
    `SELECT * FROM escrows
     WHERE status = 'active' AND release_after IS NOT NULL AND release_after <= now()
     ORDER BY release_after ASC LIMIT $1`, [limit]);
  return rows;
}
module.exports = { createAndFund, release, refund, dispute, dueForSettlement };
