'use strict';
const { pool } = require('../db');
const wallets = require('../wallets');
const { postTransaction } = require('../ledger');
const { writeAudit } = require('../audit');
const { E } = require('../errors');
const decimal = require('../decimal');
const cfg = require('./token.config');

/**
 * adminEconomy.js -- service layer for the admin "Economy Console"
 * (mounted at /api/qntm/admin/economy). It is the SECOND, economy-dedicated
 * admin wallet: a read model of the whole internal QNTM economy plus three
 * privileged value flows an administrator uses to steer it.
 *
 *   economySummary()  aggregated dashboard -- system pools, circulation,
 *                     emissions, pool health. EVERY figure is derived live from
 *                     wallet balances / ledger_entries; never a cached field.
 *   economyLedger()   recent economy-affecting ledger movements, filterable.
 *   adminGrant()      reward_pool -> user          (txn type admin_manual_grant)
 *   adminReclaim()    user        -> reward_pool   (txn type admin_manual_reclaim)
 *   transferPool()    system pool -> system pool   (txn type pool_transfer)
 *
 * None of the three write flows mint: each debits an EXISTING balance, and the
 * ledger's non-negative trigger rejects any overdraw, so the fixed supply is
 * conserved exactly. All compose on postTransaction() (atomicity, row locking,
 * double-entry and idempotency are inherited, not re-implemented). The acting
 * admin's id is recorded in BOTH the transaction metadata and the append-only
 * audit_log. Admin authorization is enforced by the host middleware at mount.
 */

// System wallets an admin may move value BETWEEN, and grant FROM. Mirrors
// phase1.GRANTABLE_POOLS: excludes genesis (the mint contra-account -- moving
// out of it would mint), burn (a one-way sink), escrow/fee/staking/
// tournament_pool/subscription_settlement (operational), and team_vesting (a
// locked allocation). NOTE: transfer-pool's spec was truncated in the source
// brief; this allowlist is the conservative interpretation -- widen only on an
// explicit decision.
const TRANSFERABLE_POOLS = ['treasury', 'reward_pool', 'ecosystem', 'community_reserve'];

const QNTM = 'QNTM';

/** Expose every amount as BOTH a 6-decimal QNTM string and integer base units. */
function amt(s) { return { qntm: cfg.toQntm6(s), baseUnits: cfg.toBase6(s) }; }

/** Validate a user-supplied amount as a positive, non-negative decimal string. */
function amountString(amount) {
  const s = String(amount == null ? '' : amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s) || !decimal.isPositive(s)) throw E.InvalidAmount();
  return s;
}

// ---- pool-health labelling --------------------------------------------------
const REWARD_POOL_TARGET =
  (cfg.ALLOCATIONS.find((a) => a.walletType === 'reward_pool') || {}).amount || '0';

function rewardPoolPct(balanceRaw) {
  const target = Number(REWARD_POOL_TARGET) || 0;
  if (target <= 0) return 0;
  const bal = Number(balanceRaw) || 0;
  return Math.round((bal / target) * 10000) / 100; // 2 decimal places
}
function rewardPoolStatus(pct) {
  if (pct > 25) return 'healthy';
  if (pct > 10) return 'low';
  return 'critical';
}
function walletHealth(walletType, row, pct) {
  if (walletType === 'genesis') return 'healthy';            // contra account; negative is normal
  if (walletType === 'reward_pool') return rewardPoolStatus(pct);
  if (row && row.status && row.status !== 'active') return row.status; // frozen / closed
  return 'healthy';
}

// Curated display order; any present system wallet not listed is appended.
const WALLET_ORDER = [
  'reward_pool', 'treasury', 'ecosystem', 'team_vesting', 'community_reserve',
  'burn', 'escrow', 'fee', 'staking', 'tournament_pool', 'subscription_settlement', 'genesis',
];

async function systemWalletRows(client = pool) {
  const { rows } = await client.query(
    `SELECT id, wallet_type, owner_type, available_balance, pending_balance, locked_balance, status
       FROM wallets WHERE currency = $1 AND owner_id IS NULL`, [QNTM]);
  return { rows, map: new Map(rows.map((r) => [r.wallet_type, r])) };
}

/**
 * Aggregated economic dashboard. Shape mirrors the admin brief: systemWallets /
 * circulation / emissions / health. Missing system wallets are reported as
 * `{ configured:false, status:'not_configured' }` rather than fabricated.
 */
async function economySummary(client = pool) {
  const { rows: sysRows, map } = await systemWalletRows(client);

  const rewardRow = map.get('reward_pool') || null;
  const treasuryRow = map.get('treasury') || null;
  const rewardId = rewardRow ? rewardRow.id : -1;
  const treasuryId = treasuryRow ? treasuryRow.id : -1;
  const rewardPct = rewardRow ? rewardPoolPct(rewardRow.available_balance) : 0;

  // ----- systemWallets (reward_pool + treasury always present as keys) -----
  const systemWallets = {};
  const seen = new Set();
  const put = (wt) => {
    if (seen.has(wt)) return;
    const r = map.get(wt);
    if (!r) {
      if (wt === 'reward_pool' || wt === 'treasury') {
        systemWallets[wt] = { configured: false, status: 'not_configured' };
        seen.add(wt);
      }
      return;
    }
    const pct = wt === 'reward_pool' ? rewardPct : undefined;
    systemWallets[wt] = {
      configured: true,
      walletId: r.id,
      balance: amt(r.available_balance),
      pending: amt(r.pending_balance),
      locked: amt(r.locked_balance),
      walletStatus: r.status,
      status: walletHealth(wt, r, pct),
      ...(pct !== undefined ? { percentRemaining: pct } : {}),
    };
    seen.add(wt);
  };
  for (const wt of WALLET_ORDER) put(wt);
  for (const r of sysRows) put(r.wallet_type);

  // ----- circulation (derived from balances + ledger_entries) -----
  const circ = (await client.query(
    `SELECT
       (SELECT COALESCE(SUM(available_balance + pending_balance + locked_balance), 0)
          FROM wallets WHERE owner_type = 'user' AND currency = $1)                       AS user_total,
       (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries
          WHERE wallet_id = $2 AND direction = 'debit')                                   AS distributed_reward,
       (SELECT COALESCE(SUM(le.amount), 0) FROM ledger_entries le
          JOIN transactions t ON t.id = le.transaction_id
          WHERE le.wallet_id = $3 AND le.direction = 'credit'
            AND t.type::text IN ('marketplace_purchase', 'platform_fee'))                 AS treasury_collected,
       (SELECT COALESCE(SUM(amount), 0) FROM transactions
          WHERE type::text = 'marketplace_purchase' AND currency = $1)                    AS mkt_volume`,
    [QNTM, rewardId, treasuryId])).rows[0];

  // ----- emissions (single pass over transactions) -----
  const em = (await client.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE type::text = 'reward' AND metadata->>'kind' = 'signup_reward'), 0)  AS signup,
       COALESCE(SUM(amount) FILTER (WHERE type::text = 'reward' AND metadata->>'kind' = 'pro_reward'), 0)     AS pro,
       COALESCE(SUM(amount) FILTER (WHERE type::text = 'reward' AND metadata->>'kind' = 'creator_reward'), 0) AS creator,
       COALESCE(SUM(amount) FILTER (WHERE type::text = 'initial_qntm_airdrop'), 0)                            AS airdrops,
       COALESCE(SUM(amount) FILTER (WHERE type::text = 'admin_manual_grant'
                                       OR (type::text = 'reward' AND metadata->>'kind' = 'admin_grant')), 0)  AS manual_grants,
       COALESCE(SUM(amount) FILTER (WHERE type::text = 'admin_manual_reclaim'), 0)                            AS reclaimed
     FROM transactions WHERE currency = $1 AND status = 'completed'`,
    [QNTM])).rows[0];

  // ----- health + warnings -----
  const warnings = [];
  if (!rewardRow) warnings.push('reward_pool wallet is not configured (run bootstrap / setupQntmSchema)');
  else if (rewardPct <= 10) warnings.push('reward_pool critically low: ' + rewardPct + '% of allocation remaining');
  else if (rewardPct <= 25) warnings.push('reward_pool low: ' + rewardPct + '% of allocation remaining');
  if (!treasuryRow) warnings.push('treasury wallet is not configured');
  for (const r of sysRows) {
    if (r.status && r.status !== 'active') warnings.push(r.wallet_type + ' wallet is ' + r.status);
  }

  return {
    systemWallets,
    circulation: {
      userBalancesTotal: amt(circ.user_total),
      distributedFromRewardPool: amt(circ.distributed_reward),
      treasuryCollected: amt(circ.treasury_collected),
      marketplaceVolume: amt(circ.mkt_volume),
    },
    emissions: {
      signupRewardsTotal: amt(em.signup),
      proRewardsTotal: amt(em.pro),
      creatorRewardsTotal: amt(em.creator),
      airdropsTotal: amt(em.airdrops),
      manualGrantsTotal: amt(em.manual_grants),
      reclaimedTotal: amt(em.reclaimed),
    },
    health: {
      rewardPoolPercentRemaining: rewardRow ? rewardPct : null,
      rewardPoolStatus: rewardRow ? rewardPoolStatus(rewardPct) : 'not_configured',
      warnings,
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Recent economy-affecting ledger movements, newest first. Each record carries
 * its transaction type/amount, the source wallet(s) (debits), the destination
 * wallet(s) (credits), the acting user, an optional reason, and the timestamp.
 *
 * Filters (all optional): type, walletType, userId, limit (<=200), before (txn
 * id, for pagination), since/until (ISO timestamps).
 */
async function economyLedger(
  { type = null, walletType = null, userId = null, limit = 50, before = null, since = null, until = null } = {},
  client = pool
) {
  const params = [QNTM];
  const where = ['t.currency = $1'];
  if (type) { params.push(String(type)); where.push('t.type::text = $' + params.length); }
  if (before) { params.push(Number(before)); where.push('t.id < $' + params.length); }
  if (since) { params.push(since); where.push('t.created_at >= $' + params.length); }
  if (until) { params.push(until); where.push('t.created_at <= $' + params.length); }
  if (walletType) {
    params.push(String(walletType));
    where.push(
      'EXISTS (SELECT 1 FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id' +
      ' WHERE le.transaction_id = t.id AND w.wallet_type::text = $' + params.length + ')');
  }
  if (userId) {
    params.push(String(userId));
    const p = '$' + params.length;
    where.push(
      '(t.initiator_user_id = ' + p +
      ' OR EXISTS (SELECT 1 FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id' +
      " WHERE le.transaction_id = t.id AND w.owner_type = 'user' AND w.owner_id = " + p + '))');
  }
  params.push(Math.min(Number(limit) || 50, 200));

  const { rows: txns } = await client.query(
    `SELECT t.id, t.public_id, t.type, t.status, t.amount, t.currency,
            t.initiator_user_id, t.reference_type, t.reference_id, t.metadata, t.created_at
       FROM transactions t WHERE ${where.join(' AND ')}
       ORDER BY t.id DESC LIMIT $${params.length}`, params);
  if (!txns.length) return [];

  const ids = txns.map((t) => t.id);
  const { rows: entries } = await client.query(
    `SELECT le.transaction_id, le.direction, le.amount, le.balance_kind,
            w.id AS wallet_id, w.wallet_type, w.owner_type, w.owner_id
       FROM ledger_entries le JOIN wallets w ON w.id = le.wallet_id
       WHERE le.transaction_id = ANY($1::bigint[])
       ORDER BY le.id ASC`, [ids]);
  const byTxn = new Map();
  for (const e of entries) {
    if (!byTxn.has(e.transaction_id)) byTxn.set(e.transaction_id, []);
    byTxn.get(e.transaction_id).push(e);
  }
  const ref = (e) => ({
    walletId: e.wallet_id, walletType: e.wallet_type,
    ownerType: e.owner_type, ownerId: e.owner_id, amount: amt(e.amount),
  });
  return txns.map((t) => {
    const es = byTxn.get(t.id) || [];
    const debits = es.filter((e) => e.direction === 'debit').map(ref);
    const credits = es.filter((e) => e.direction === 'credit').map(ref);
    return {
      id: t.id, publicId: t.public_id, type: t.type, status: t.status,
      amount: amt(t.amount), currency: t.currency,
      actorId: t.initiator_user_id,
      reason: t.metadata ? (t.metadata.reason || null) : null,
      source: debits.length === 1 ? debits[0] : debits,
      destinations: credits,
      reference: { type: t.reference_type, id: t.reference_id },
      metadata: t.metadata,
      createdAt: t.created_at,
    };
  });
}

/**
 * Admin manual grant: debit reward_pool -> credit the user's personal wallet.
 * Never mints. Insufficient reward_pool => the ledger rejects it (409).
 */
async function adminGrant({ toUserId, amount, reason = null, actorId, idempotencyKey }, client) {
  if (!toUserId) throw E.Validation('toUserId is required');
  const amountStr = amountString(amount);
  const actor = actorId != null ? String(actorId) : null;
  const run = async (cx) => {
    const fromId = await wallets.systemWalletId('reward_pool', QNTM, cx);
    const to = await wallets.getOrCreateWallet('user', toUserId, 'personal', QNTM, cx);
    const txn = await postTransaction({
      type: 'admin_manual_grant',
      amount: amountStr,
      movements: [
        { walletId: fromId, direction: 'debit', amount: amountStr, description: 'admin grant from reward_pool' },
        { walletId: to.id, direction: 'credit', amount: amountStr, description: reason || 'admin manual grant' },
      ],
      initiatorUserId: actor,
      reference: { type: 'admin_manual_grant', id: idempotencyKey || null },
      idempotencyKey: idempotencyKey || null,
      metadata: { kind: 'admin_manual_grant', toUserId: String(toUserId), reason: reason || null, actorId: actor },
    }, cx);
    await writeAudit({
      actorId: actor, action: 'qntm.economy.grant', walletId: to.id, transactionId: txn.id, reason,
      metadata: { pool: 'reward_pool', amount: amountStr, toUserId: String(toUserId) },
    }, cx);
    return { transaction: txn, fromPool: 'reward_pool', toUserId: String(toUserId), amount: amountStr, reason: reason || null };
  };
  return client ? run(client) : wallets.withTransaction(run);
}

/**
 * Admin reclaim: debit a user's personal wallet -> credit reward_pool. Touches
 * the available balance only. Insufficient user balance => rejected (409).
 */
async function adminReclaim({ fromUserId, amount, reason = null, actorId, idempotencyKey }, client) {
  if (!fromUserId) throw E.Validation('fromUserId is required');
  const amountStr = amountString(amount);
  const actor = actorId != null ? String(actorId) : null;
  const run = async (cx) => {
    const from = await wallets.getOrCreateWallet('user', fromUserId, 'personal', QNTM, cx);
    const toId = await wallets.systemWalletId('reward_pool', QNTM, cx);
    const txn = await postTransaction({
      type: 'admin_manual_reclaim',
      amount: amountStr,
      movements: [
        { walletId: from.id, direction: 'debit', amount: amountStr, description: reason || 'admin reclaim' },
        { walletId: toId, direction: 'credit', amount: amountStr, description: 'reclaim to reward_pool' },
      ],
      initiatorUserId: actor,
      reference: { type: 'admin_manual_reclaim', id: idempotencyKey || null },
      idempotencyKey: idempotencyKey || null,
      metadata: { kind: 'admin_manual_reclaim', fromUserId: String(fromUserId), reason: reason || null, actorId: actor },
    }, cx);
    await writeAudit({
      actorId: actor, action: 'qntm.economy.reclaim', walletId: from.id, transactionId: txn.id, reason,
      metadata: { pool: 'reward_pool', amount: amountStr, fromUserId: String(fromUserId) },
    }, cx);
    return { transaction: txn, fromUserId: String(fromUserId), toPool: 'reward_pool', amount: amountStr, reason: reason || null };
  };
  return client ? run(client) : wallets.withTransaction(run);
}

/**
 * Admin inter-pool transfer: debit one system pool -> credit another. Both ends
 * must be in TRANSFERABLE_POOLS and distinct. Insufficient source => rejected.
 */
async function transferPool({ fromPool, toPool, amount, reason = null, actorId, idempotencyKey }, client) {
  if (!TRANSFERABLE_POOLS.includes(fromPool)) {
    throw E.Validation('fromPool must be one of ' + TRANSFERABLE_POOLS.join(', ') + ' (got ' + fromPool + ')');
  }
  if (!TRANSFERABLE_POOLS.includes(toPool)) {
    throw E.Validation('toPool must be one of ' + TRANSFERABLE_POOLS.join(', ') + ' (got ' + toPool + ')');
  }
  if (String(fromPool) === String(toPool)) throw E.Validation('fromPool and toPool must differ');
  const amountStr = amountString(amount);
  const actor = actorId != null ? String(actorId) : null;
  const run = async (cx) => {
    const fromId = await wallets.systemWalletId(fromPool, QNTM, cx);
    const toId = await wallets.systemWalletId(toPool, QNTM, cx);
    const txn = await postTransaction({
      type: 'pool_transfer',
      amount: amountStr,
      movements: [
        { walletId: fromId, direction: 'debit', amount: amountStr, description: 'pool transfer ' + fromPool + ' -> ' + toPool },
        { walletId: toId, direction: 'credit', amount: amountStr, description: reason || ('transfer from ' + fromPool) },
      ],
      initiatorUserId: actor,
      reference: { type: 'pool_transfer', id: idempotencyKey || null },
      idempotencyKey: idempotencyKey || null,
      metadata: { kind: 'pool_transfer', fromPool, toPool, reason: reason || null, actorId: actor },
    }, cx);
    await writeAudit({
      actorId: actor, action: 'qntm.economy.transfer_pool', transactionId: txn.id, reason,
      metadata: { amount: amountStr, fromPool, toPool },
    }, cx);
    return { transaction: txn, fromPool, toPool, amount: amountStr, reason: reason || null };
  };
  return client ? run(client) : wallets.withTransaction(run);
}

module.exports = {
  economySummary, economyLedger, adminGrant, adminReclaim, transferPool,
  TRANSFERABLE_POOLS,
};
