'use strict';
const { pool, withTransaction } = require('./db');
const { postTransaction } = require('./ledger');
const { writeAudit } = require('./audit');
const { E } = require('./errors');
const decimal = require('./decimal');

/**
 * adjustments.js — administrative balance corrections with MANDATORY two-person
 * approval (spec §22). One admin REQUESTS an adjustment (with a reason); a
 * DIFFERENT admin APPROVES it; only then is the balance change posted. The
 * "approver != requester" rule is also enforced by a CHECK constraint at the DB
 * level, so it cannot be bypassed in code.
 *
 * The contra side of an adjustment is the treasury wallet, so the ledger stays
 * balanced and every correction is fully traceable.
 */
async function requestAdjustment({ walletId, direction, balanceKind = 'available', amount, reason, requestedBy, currency = 'QNTM' }) {
  if (!decimal.isPositive(amount)) throw E.InvalidAmount();
  if (direction !== 'debit' && direction !== 'credit') throw E.Validation('direction must be debit|credit');
  if (!reason) throw E.Validation('a reason is required for adjustments');
  const { rows } = await pool.query(
    `INSERT INTO adjustment_requests
       (wallet_id, direction, balance_kind, amount, currency, reason, requested_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,
    [walletId, direction, balanceKind, amount, currency, reason, String(requestedBy)]
  );
  await writeAudit({ actorId: String(requestedBy), action: 'adjustment.requested', walletId, reason, metadata: { amount, direction } });
  return rows[0];
}

async function reject(adjustmentId, { approverId, note } = {}) {
  const { rows } = await pool.query(
    `UPDATE adjustment_requests SET status='rejected', approved_by=$2, updated_at=now()
     WHERE id=$1 AND status='pending' RETURNING *`, [adjustmentId, String(approverId)]);
  if (!rows.length) throw E.Conflict('adjustment not pending');
  await writeAudit({ actorId: String(approverId), action: 'adjustment.rejected', metadata: { adjustmentId, note: note || null } });
  return rows[0];
}

/**
 * Approve AND execute. Enforces approver != requester (also a DB CHECK). Posts
 * the balancing transaction against the treasury wallet.
 */
async function approveAndExecute(adjustmentId, { approverId }) {
  return withTransaction(async (cx) => {
    const { rows } = await cx.query(`SELECT * FROM adjustment_requests WHERE id=$1 FOR UPDATE`, [adjustmentId]);
    if (!rows.length) throw E.Validation('adjustment not found');
    const adj = rows[0];
    if (adj.status !== 'pending') throw E.Conflict(`adjustment is ${adj.status}`);
    if (String(approverId) === adj.requested_by) {
      throw E.Forbidden('two-person rule: approver must differ from requester');
    }
    const { systemWalletId } = require('./wallets');
    const treasuryId = await systemWalletId('treasury', adj.currency, cx);

    // direction = credit  -> add to target wallet (treasury debited)
    // direction = debit   -> remove from target wallet (treasury credited)
    const movements = adj.direction === 'credit'
      ? [
          { walletId: treasuryId, direction: 'debit', amount: adj.amount, description: 'adjustment source' },
          { walletId: adj.wallet_id, direction: 'credit', amount: adj.amount, balance: adj.balance_kind, description: adj.reason },
        ]
      : [
          { walletId: adj.wallet_id, direction: 'debit', amount: adj.amount, balance: adj.balance_kind, description: adj.reason },
          { walletId: treasuryId, direction: 'credit', amount: adj.amount, description: 'adjustment recovery' },
        ];

    const txn = await postTransaction({
      type: 'adjustment', amount: adj.amount, movements,
      currency: adj.currency, initiatorUserId: String(approverId),
      reference: { type: 'adjustment', id: adj.public_id },
      metadata: { reason: adj.reason, requestedBy: adj.requested_by, approvedBy: String(approverId) },
      allowFrozen: true,
    }, cx);

    await cx.query(
      `UPDATE adjustment_requests SET status='executed', approved_by=$2, executed_txn_id=$3, updated_at=now() WHERE id=$1`,
      [adjustmentId, String(approverId), txn.id]
    );
    await writeAudit({ actorId: String(approverId), action: 'adjustment.executed', walletId: adj.wallet_id, transactionId: txn.id, reason: adj.reason, metadata: { amount: adj.amount } }, cx);
    return { adjustment: { ...adj, status: 'executed' }, transaction: txn };
  });
}

async function listPending(limit = 100) {
  const { rows } = await pool.query(
    `SELECT * FROM adjustment_requests WHERE status='pending' ORDER BY created_at ASC LIMIT $1`, [limit]);
  return rows;
}
module.exports = { requestAdjustment, reject, approveAndExecute, listPending };
