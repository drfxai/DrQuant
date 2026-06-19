'use strict';
const { pool, withTransaction } = require('./db');
const { lockWallets } = require('./wallets');
const { E } = require('./errors');
const { emit } = require('./events');
const decimal = require('./decimal');

/**
 * ledger.js — the single chokepoint through which ALL value moves.
 *
 * Every domain flow (transfer, marketplace, subscription, staking, burn, …)
 * does exactly one thing: build a balanced set of `movements` and hand them to
 * postTransaction(). Concentrating every balance mutation here means the
 * guarantees below are proven in ONE place and inherited everywhere:
 *
 *   atomicity   — one DB transaction; any failure rolls back all of it
 *   isolation   — affected wallet rows are SELECT ... FOR UPDATE locked
 *   double-entry— movements must net to zero (checked in JS and again by the DB)
 *   idempotency — a repeated idempotency_key returns the original transaction
 *   no floats   — amounts are strings → NUMERIC; arithmetic happens in SQL
 *
 * A movement:
 *   { walletId, direction: 'debit'|'credit', amount: '50.00',
 *     balance?: 'available'|'pending'|'locked',  // default 'available'
 *     description?: string }
 *
 * Convention: a `debit` removes tokens from a wallet's balance kind, a
 * `credit` adds them. (Standard ledger sign convention for asset accounts.)
 */

const BAL_COLUMN = {
  available: 'available_balance',
  pending: 'pending_balance',
  locked: 'locked_balance',
};

function validateMovements(movements) {
  if (!Array.isArray(movements) || movements.length < 2) {
    throw E.Validation('a transaction needs at least two movements (one debit, one credit)');
  }
  const signed = [];
  for (const m of movements) {
    if (!m.walletId) throw E.Validation('movement.walletId is required');
    if (m.direction !== 'debit' && m.direction !== 'credit') {
      throw E.Validation(`movement.direction must be debit|credit, got ${m.direction}`);
    }
    if (!BAL_COLUMN[m.balance || 'available']) {
      throw E.Validation(`movement.balance must be available|pending|locked, got ${m.balance}`);
    }
    if (!decimal.isPositive(m.amount)) {
      throw E.InvalidAmount(`movement.amount must be > 0, got ${m.amount}`);
    }
    signed.push(m.direction === 'debit' ? decimal.neg(m.amount) : m.amount);
  }
  // Fast pre-flight of the double-entry invariant; the DB enforces it for real.
  if (!decimal.sumIsZero(signed)) {
    throw E.Unbalanced(
      `movements net to ${signed.reduce((a, b) => decimal.add(a, b), '0')} (must be 0)`
    );
  }
}

/**
 * Post a balanced transaction. If `client` is supplied the caller owns the
 * surrounding DB transaction (lets a domain flow compose several ledger
 * operations atomically); otherwise we open our own.
 */
async function postTransaction(params, client) {
  const {
    type,
    movements,
    amount,                 // gross principal for reporting; defaults to sum of credits
    currency = 'QNTM',
    initiatorUserId = null,
    reference = {},         // { type, id }
    idempotencyKey = null,
    metadata = {},
    status = 'completed',
    allowFrozen = false,    // admin override for unfreeze/adjustment flows
  } = params;

  if (!type) throw E.Validation('transaction type is required');
  validateMovements(movements);

  const run = async (cx) => {
    // ---- idempotent replay ----
    if (idempotencyKey) {
      const existing = await cx.query(
        `SELECT * FROM transactions WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      if (existing.rows.length) {
        return { transaction: existing.rows[0], idempotentReplay: true };
      }
    }

    // gross principal = sum of credit movements (what actually "moved in")
    const gross = amount != null
      ? amount
      : movements
          .filter((m) => m.direction === 'credit')
          .reduce((acc, m) => decimal.add(acc, m.amount), '0');

    // ---- create the transaction row ----
    let txn;
    try {
      const ins = await cx.query(
        `INSERT INTO transactions
           (type, status, amount, currency, initiator_user_id,
            reference_type, reference_id, idempotency_key, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [type, status, gross, currency, initiatorUserId,
         reference.type || null, reference.id != null ? String(reference.id) : null,
         idempotencyKey, metadata]
      );
      txn = ins.rows[0];
    } catch (err) {
      // race: another request inserted the same idempotency_key first
      if (err.code === '23505' && idempotencyKey) {
        const again = await cx.query(
          `SELECT * FROM transactions WHERE idempotency_key = $1`,
          [idempotencyKey]
        );
        if (again.rows.length) return { transaction: again.rows[0], idempotentReplay: true };
      }
      throw err;
    }

    // ---- lock every affected wallet row ----
    const walletMap = await lockWallets(cx, movements.map((m) => m.walletId));

    // ---- apply each movement + write its ledger entry ----
    for (const m of movements) {
      const w = walletMap.get(Number(m.walletId));
      if (!allowFrozen && w.status !== 'active') {
        throw E.WalletFrozen(`wallet ${w.id} is ${w.status}`);
      }
      const col = BAL_COLUMN[m.balance || 'available'];
      const delta = m.direction === 'debit' ? decimal.neg(m.amount) : m.amount;

      // Arithmetic in SQL on NUMERIC — never in JS. The wallet_nonneg trigger
      // rejects any debit that would overdraw, which rolls back the whole txn.
      let updated;
      try {
        const upd = await cx.query(
          `UPDATE wallets SET ${col} = ${col} + $2::numeric WHERE id = $1
           RETURNING ${col} AS balance_after`,
          [w.id, delta]
        );
        updated = upd.rows[0];
      } catch (err) {
        if (err.code === '23514' || /insufficient_funds/.test(err.message)) {
          throw E.InsufficientFunds(
            `wallet ${w.id} cannot be debited ${m.amount} ${currency}`
          );
        }
        throw err;
      }

      await cx.query(
        `INSERT INTO ledger_entries
           (transaction_id, wallet_id, direction, amount, balance_kind,
            currency, balance_after, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [txn.id, w.id, m.direction, m.amount, m.balance || 'available',
         currency, updated.balance_after, m.description || null]
      );
    }

    // The DEFERRED ledger_balanced constraint re-verifies sum-to-zero at COMMIT.
    return { transaction: txn, idempotentReplay: false };
  };

  const result = client ? await run(client) : await withTransaction(run);

  if (!result.idempotentReplay) {
    emit(`ledger.${type}.completed`, {
      transactionId: result.transaction.public_id,
      type,
      amount: result.transaction.amount,
      currency,
      reference,
    });
  }
  return result.transaction;
}

/**
 * Mechanically reverse a prior transaction by posting the mirror image of its
 * entries (debit<->credit). The original is marked 'reversed'. This is the
 * ONLY sanctioned way to undo a settled transaction — the ledger itself is
 * never edited.
 */
async function reverseTransaction(originalTxnId, { reason, actorId } = {}, client) {
  const run = async (cx) => {
    const { rows: orig } = await cx.query(
      `SELECT * FROM transactions WHERE id = $1 FOR UPDATE`,
      [originalTxnId]
    );
    if (!orig.length) throw E.Validation(`transaction ${originalTxnId} not found`);
    const original = orig[0];
    if (original.status === 'reversed') throw E.Conflict('transaction already reversed');

    const { rows: entries } = await cx.query(
      `SELECT * FROM ledger_entries WHERE transaction_id = $1 ORDER BY id`,
      [originalTxnId]
    );

    const movements = entries.map((e) => ({
      walletId: e.wallet_id,
      direction: e.direction === 'debit' ? 'credit' : 'debit',
      amount: e.amount,
      balance: e.balance_kind,
      description: `reversal of entry ${e.id}`,
    }));

    const reversal = await postTransaction(
      {
        type: 'reversal',
        movements,
        currency: original.currency,
        initiatorUserId: actorId || original.initiator_user_id,
        reference: { type: 'transaction', id: original.public_id },
        metadata: { reverses: original.public_id, reason: reason || null },
        allowFrozen: true,
      },
      cx
    );

    // The reversal transaction points at what it reverses...
    await cx.query(
      `UPDATE transactions SET reverses_txn_id = $2 WHERE id = $1`,
      [reversal.id, original.id]
    );
    // ...and the original is marked reversed (allowed: completed -> reversed).
    await cx.query(
      `UPDATE transactions SET status = 'reversed' WHERE id = $1`,
      [original.id]
    );
    return reversal;
  };
  return client ? run(client) : withTransaction(run);
}

/** List a wallet's ledger history (most recent first). */
async function walletLedger(walletId, { limit = 50, before = null } = {}) {
  const params = [walletId, Math.min(limit, 200)];
  let where = `le.wallet_id = $1`;
  if (before) { params.push(before); where += ` AND le.id < $3`; }
  const { rows } = await pool.query(
    `SELECT le.*, t.type AS txn_type, t.public_id AS txn_public_id, t.status AS txn_status
     FROM ledger_entries le JOIN transactions t ON t.id = le.transaction_id
     WHERE ${where}
     ORDER BY le.id DESC LIMIT $2`,
    params
  );
  return rows;
}

module.exports = {
  postTransaction,
  reverseTransaction,
  walletLedger,
  validateMovements,
};
