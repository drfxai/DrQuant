'use strict';
const { pool, withTransaction } = require('./db');
const wallets = require('./wallets');
const { postTransaction } = require('./ledger');
const { splitAmount } = require('./fees');
const { emit } = require('./events');
const { E } = require('./errors');
const decimal = require('./decimal');

/**
 * subscriptions.js — recurring creator subscriptions (spec §16).
 *
 * A charge debits the subscriber and splits the amount creator/treasury/burn.
 * Unlike one-off marketplace sales, subscription revenue is credited to the
 * creator's AVAILABLE balance immediately (lower chargeback risk, matches the
 * spec's direct split). If the subscriber has insufficient funds the charge
 * fails softly: the subscription goes `past_due`, failed_attempts increments,
 * and after `maxAttempts` it is cancelled (classic dunning).
 */
const DEFAULT_POLICY = { creator: 8000, treasury: 1600, burn: 400 };
const MAX_ATTEMPTS = Number(process.env.QNTM_SUB_MAX_ATTEMPTS || 3);

async function createSubscription({
  subscriberUserId, planId, creatorOwnerId, creatorOwnerType = 'creator',
  amount, intervalDays = 30, trialDays = 0, currency = 'QNTM',
}) {
  if (!decimal.isPositive(amount)) throw E.InvalidAmount();
  const creator = await wallets.getOrCreateWallet(creatorOwnerType, creatorOwnerId, 'creator', currency);
  const status = trialDays > 0 ? 'trialing' : 'active';
  const periodEnd = new Date(Date.now() + (trialDays > 0 ? trialDays : intervalDays) * 86400000);
  const { rows } = await pool.query(
    `INSERT INTO subscriptions
       (subscriber_user_id, plan_id, creator_wallet_id, amount, currency,
        status, interval_days, current_period_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [String(subscriberUserId), planId, creator.id, amount, currency, status, intervalDays, periodEnd]
  );
  const sub = rows[0];
  emit('subscription.created', { subscriptionId: sub.public_id, status, subscriberUserId: String(subscriberUserId) });
  // Trials are not charged now; active subs take their first charge immediately.
  if (status === 'active') return charge(sub.id);
  return sub;
}

/**
 * Charge one billing cycle. Idempotent per period via a deterministic key so a
 * retried cron tick never double-charges.
 */
async function charge(subscriptionId, { policy = DEFAULT_POLICY } = {}) {
  return withTransaction(async (cx) => {
    const { rows } = await cx.query(`SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE`, [subscriptionId]);
    if (!rows.length) throw E.Validation('subscription not found');
    const sub = rows[0];
    if (['cancelled', 'expired', 'paused'].includes(sub.status)) {
      throw E.Conflict(`subscription is ${sub.status}`);
    }
    const subscriber = await wallets.getOrCreateWallet('user', sub.subscriber_user_id, 'personal', sub.currency);
    const treasuryId = await wallets.systemWalletId('treasury', sub.currency, cx);
    const burnId = await wallets.systemWalletId('burn', sub.currency, cx);
    const shares = splitAmount(sub.amount, policy, 'creator');
    const periodKey = `sub:${sub.id}:${sub.current_period_end ? sub.current_period_end.toISOString() : 'init'}`;

    // A failed charge aborts the surrounding transaction in Postgres, so we
    // attempt it inside a SAVEPOINT: on insufficient funds we roll back just
    // the attempt and fall through to dunning on a healthy connection.
    await cx.query('SAVEPOINT charge_attempt');
    try {
      const txn = await postTransaction({
        type: 'subscription_payment', amount: sub.amount,
        movements: [
          { walletId: subscriber.id, direction: 'debit', amount: sub.amount, description: `subscription ${sub.plan_id}` },
          { walletId: sub.creator_wallet_id, direction: 'credit', amount: shares.creator, description: 'subscription revenue' },
          { walletId: treasuryId, direction: 'credit', amount: shares.treasury, description: 'subscription fee' },
          { walletId: burnId, direction: 'credit', amount: shares.burn, description: 'subscription burn' },
        ],
        currency: sub.currency, initiatorUserId: sub.subscriber_user_id,
        reference: { type: 'subscription', id: sub.public_id },
        idempotencyKey: periodKey,
      }, cx);
      await cx.query('RELEASE SAVEPOINT charge_attempt');

      const nextEnd = new Date((sub.current_period_end?.getTime() || Date.now()) + sub.interval_days * 86400000);
      await cx.query(
        `UPDATE subscriptions SET status='active', failed_attempts=0, current_period_end=$2 WHERE id=$1`,
        [sub.id, nextEnd]
      );
      emit('subscription.charged', { subscriptionId: sub.public_id, amount: sub.amount, nextPeriodEnd: nextEnd.toISOString() });
      return { subscription: { ...sub, status: 'active', current_period_end: nextEnd }, transaction: txn };
    } catch (err) {
      if (err.code !== 'insufficient_funds') throw err;
      await cx.query('ROLLBACK TO SAVEPOINT charge_attempt');
      // Soft fail → dunning.
      const attempts = sub.failed_attempts + 1;
      const newStatus = attempts >= MAX_ATTEMPTS ? 'cancelled' : 'past_due';
      await cx.query(
        `UPDATE subscriptions SET status=$2, failed_attempts=$3 WHERE id=$1`,
        [sub.id, newStatus, attempts]
      );
      emit('subscription.payment_failed', {
        subscriptionId: sub.public_id, attempts, status: newStatus,
      });
      return { subscription: { ...sub, status: newStatus, failed_attempts: attempts }, transaction: null, failed: true };
    }
  });
}

async function cancel(subscriptionId, { atPeriodEnd = false } = {}) {
  const status = atPeriodEnd ? 'active' : 'cancelled'; // at-period-end keeps access until expiry
  const { rows } = await pool.query(
    `UPDATE subscriptions
       SET status = $2, metadata = metadata || jsonb_build_object('cancel_at_period_end', $3::boolean)
     WHERE id = $1 RETURNING *`,
    [subscriptionId, status, atPeriodEnd]
  );
  if (!rows.length) throw E.Validation('subscription not found');
  emit('subscription.cancelled', { subscriptionId: rows[0].public_id, atPeriodEnd });
  return rows[0];
}

/** Subscriptions whose period has ended and need a renewal charge. */
async function dueForRenewal(limit = 200) {
  const { rows } = await pool.query(
    `SELECT * FROM subscriptions
     WHERE status IN ('active','past_due') AND current_period_end IS NOT NULL
       AND current_period_end <= now()
     ORDER BY current_period_end ASC LIMIT $1`, [limit]);
  return rows;
}
module.exports = { createSubscription, charge, cancel, dueForRenewal, DEFAULT_POLICY };
