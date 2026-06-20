'use strict';
const { Router } = require('express');
const { asyncHandler } = require('./_helpers');
const overview = require('../economy/overview');
const bootstrap = require('../economy/bootstrap');
const phase1 = require('../economy/phase1');
const { flagGuard } = require('../economy/flags');

/**
 * admin.economy.routes.js -- QNTM economic-layer admin API (Phase 1).
 *
 * Auth is applied by the HOST at mount time (see qntm-ledger/integrate.js):
 * the app's authMiddleware + adminMiddleware run before this router, so every
 * handler can assume req.user.{id,role} is present and the caller is an admin.
 * 'admin' is the highest role today; a future super-admin/root tier can be
 * substituted at the mount without touching this financial code.
 */
const router = Router();

// GET /overview -- token, bootstrap status, supply figures, per-bucket balances.
router.get('/overview', asyncHandler(async (req, res) => {
  res.json(await overview.overview());
}));

// GET /wallets -- singleton system + allocation wallets with balances.
router.get('/wallets', asyncHandler(async (req, res) => {
  res.json({ wallets: await overview.walletsView() });
}));

// GET /transactions?type=&before=&limit= -- recent QNTM ledger transactions.
router.get('/transactions', asyncHandler(async (req, res) => {
  res.json({
    transactions: await overview.transactionsView({
      limit: Number(req.query.limit) || 50,
      before: req.query.before ? Number(req.query.before) : null,
      type: req.query.type || null,
    }),
  });
}));

// POST /bootstrap -- run the one-time bootstrap (201) or report done (409).
router.post('/bootstrap', asyncHandler(async (req, res) => {
  try {
    const result = await bootstrap.bootstrap({ actorId: req.user && req.user.id });
    res.status(201).json({ ok: true, result });
  } catch (e) {
    if (e.code === 'already_bootstrapped') {
      return res.status(409).json({ error: { code: e.code, message: e.message } });
    }
    throw e;
  }
}));

// POST /grant -- move issued QNTM from a platform pool into a user's wallet.
// This NEVER mints: it debits an existing pool (treasury / reward_pool /
// ecosystem / community_reserve) and the ledger rejects any overdraw. Admin
// guards are applied at mount; the grant feature flag gates it further.
router.post('/grant', flagGuard('grant'), asyncHandler(async (req, res) => {
  const { pool, toUserId, amount, reason } = req.body || {};
  const result = await phase1.grantFromPool({
    pool, toUserId, amount, reason,
    actorId: req.user && req.user.id,
    idempotencyKey: req.get('Idempotency-Key') || null,
  });
  res.status(201).json({ ok: true, ...result });
}));

module.exports = router;
