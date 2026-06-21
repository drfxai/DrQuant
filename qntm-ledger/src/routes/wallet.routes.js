'use strict';
const { Router } = require('express');
const { asyncHandler, requireAuth } = require('./_helpers');
const wallets = require('../wallets');
const { walletLedger } = require('../ledger');
const transfers = require('../transfers');
const risk = require('../risk');
const { guard } = require('../ratelimit');
const { flagGuard } = require('../economy/flags');
const treasury = require('../treasury');
const decimal = require('../decimal');
const cfg = require('../economy/token.config');
const bootstrap = require('../economy/bootstrap');
const { pool } = require('../db');

const router = Router();

// The reward pool's fixed allocation (350,000,000 QNTM) — its bucket target.
const REWARD_POOL_TARGET = (cfg.ALLOCATIONS.find(function (a) { return a.walletType === 'reward_pool'; }) || {}).amount || '0';

// GET /wallets/supply — read-only economy snapshot for the in-app token card.
// Every figure is an AGGREGATE derived from wallet balances (no per-user data),
// so it is safe for any authenticated user to read. Powers the desktop Market
// rail "QNTM Token" card: reward-pool balance, total held by users, and the
// amount distributed out of the reward pool — all live.
router.get('/supply', requireAuth, asyncHandler(async (req, res) => {
  const sup = await treasury.supplySummary();
  const { rows } = await pool.query(
    "SELECT COALESCE(SUM(available_balance),0) AS held FROM wallets WHERE currency='QNTM' AND owner_id IS NOT NULL");
  const heldByUsers = rows[0].held;
  const st = await bootstrap.status().catch(function () { return null; });
  const bootstrapped = !!(st && st.completed);
  // Distributed out of the reward pool = its fixed target minus what remains.
  // Only meaningful once the supply is bootstrapped (else the pool is unfunded).
  let fromRewardPool = bootstrapped ? decimal.sub(REWARD_POOL_TARGET, sup.rewardPool) : '0';
  if (decimal.cmp(fromRewardPool, '0') < 0) fromRewardPool = '0';
  const amt = function (s) { return { qntm: cfg.toQntm6(s), baseUnits: cfg.toBase6(s) }; };
  res.json({
    symbol: cfg.SYMBOL,
    priceUsd: 0.01,                        // 1 QNTM = $0.01 (fixed internal price)
    bootstrapped,
    maxSupply: amt(cfg.TOTAL_SUPPLY),
    totalIssued: amt(sup.totalIssued),
    rewardPool: amt(sup.rewardPool),       // remaining in the reward pool (live)
    rewardPoolTarget: amt(REWARD_POOL_TARGET),
    fromRewardPool: amt(fromRewardPool),   // distributed out of the reward pool (live)
    heldByUsers: amt(heldByUsers),         // total QNTM held in user wallets (live)
  });
}));

// GET /wallets/me — current user's balances
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const w = await wallets.getOrCreateWallet('user', req.user.id, 'personal');
  res.json({ wallet: await wallets.getWallet(w.id) });
}));

// GET /wallets/me/transactions — ledger history
router.get('/me/transactions', requireAuth, asyncHandler(async (req, res) => {
  const w = await wallets.getOrCreateWallet('user', req.user.id, 'personal');
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const before = req.query.before ? Number(req.query.before) : null;
  res.json({ entries: await walletLedger(w.id, { limit, before }) });
}));

// POST /wallets/transfer — send QNTM to another user
router.post('/transfer', requireAuth, flagGuard('transfer'), guard({ scope: 'transfer', capacity: 10, refillPerSec: 0.5 }),
  asyncHandler(async (req, res) => {
    const { toUserId, amount, note, idempotencyKey } = req.body || {};
    const r = await risk.assessTransfer({ fromUserId: req.user.id, amount });
    if (r.decision === 'review') {
      return res.status(202).json({ status: 'under_review', message: 'transfer queued for review', risk: r });
    }
    const txn = await transfers.transfer({
      fromOwnerId: req.user.id, toOwnerId: toUserId, amount, note,
      idempotencyKey: idempotencyKey || req.get('Idempotency-Key') || null,
      initiatorUserId: req.user.id,
    });
    res.status(201).json({ transaction: txn });
  }));

module.exports = router;
