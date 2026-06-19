'use strict';
const { pool } = require('./db');
const { emit } = require('./events');
const decimal = require('./decimal');
/**
 * risk.js — lightweight fraud/risk hooks (spec §21.5, §25). This is a policy
 * surface, not a full fraud engine: it returns a decision the caller can act on
 * BEFORE posting (allow / review / block) and flags transactions for manual
 * review. Real scoring (velocity ML, device fingerprinting) plugs in here.
 */
const VELOCITY_WINDOW_MIN = Number(process.env.QNTM_RISK_WINDOW_MIN || 60);
const VELOCITY_MAX = process.env.QNTM_RISK_VELOCITY_MAX || '100000';

async function assessTransfer({ fromUserId, amount, currency = 'QNTM' }) {
  // Sum this user's outbound volume in the recent window.
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS spent FROM transactions
     WHERE initiator_user_id=$1 AND currency=$2 AND type IN ('transfer','withdrawal','ai_feature_payment')
       AND created_at >= now() - ($3 || ' minutes')::interval`,
    [String(fromUserId), currency, String(VELOCITY_WINDOW_MIN)]
  );
  const projected = decimal.add(rows[0].spent, amount);
  let decision = 'allow';
  if (decimal.cmp(projected, VELOCITY_MAX) > 0) decision = 'review';
  if (decision !== 'allow') {
    emit('risk.flagged', { fromUserId: String(fromUserId), amount, projected, decision });
  }
  return { decision, projected, windowMinutes: VELOCITY_WINDOW_MIN };
}

/** Put a transaction under manual review (status transition allowed by guard). */
async function flagForReview(transactionId, reason) {
  const { rows } = await pool.query(
    `UPDATE transactions SET status='under_review',
       metadata = metadata || jsonb_build_object('review_reason', $2::text)
     WHERE id=$1 AND status IN ('pending','completed') RETURNING *`,
    [transactionId, reason]
  );
  return rows[0] || null;
}
module.exports = { assessTransfer, flagForReview };
