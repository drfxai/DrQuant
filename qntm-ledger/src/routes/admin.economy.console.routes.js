'use strict';
const { Router } = require('express');
const { asyncHandler } = require('./_helpers');
const econ = require('../economy/adminEconomy');

/**
 * admin.economy.console.routes.js -- the admin "Economy Console" API.
 *
 * Mounted at /api/qntm/admin/economy by qntm-ledger/integrate.js, BEHIND the
 * host app's authMiddleware + adminMiddleware. Every handler may therefore
 * assume req.user is present and is an admin; a non-admin is rejected with 403
 * before reaching this router (access control is enforced on the backend, not
 * merely hidden in the UI).
 *
 * This is the SECOND, economy-dedicated admin wallet -- distinct from the
 * general admin economy API (admin.economy.routes.js at /api/qntm/admin). It
 * monitors the system pools and performs the three privileged value flows
 * (grant / reclaim / inter-pool transfer). The ledger is the only source of
 * truth; nothing here reads a cached balance.
 */
const router = Router();

/**
 * Money-moving endpoints REQUIRE an Idempotency-Key header, so an accidental
 * double-submit or a client retry can never double-spend: the ledger keys the
 * transaction on it and returns the original on replay.
 */
function requireIdemKey(req, res, next) {
  const k = req.get('Idempotency-Key');
  if (!k || !String(k).trim()) {
    return res.status(400).json({
      error: {
        code: 'idempotency_key_required',
        message: 'Idempotency-Key header is required for this operation',
      },
    });
  }
  req.idempotencyKey = String(k).trim();
  next();
}

// GET /summary -- aggregated economic dashboard: system pools, circulation,
// emissions, and pool health. All figures derived live from the ledger.
router.get('/summary', asyncHandler(async (req, res) => {
  res.json(await econ.economySummary());
}));

// GET /ledger -- recent economy-affecting ledger movements. Optional filters:
//   ?type=         transaction type (e.g. marketplace_purchase, admin_manual_grant)
//   ?wallet=       wallet_type touched (e.g. reward_pool, treasury)
//   ?userId=       a user who initiated or whose wallet was touched
//   ?limit=        max records (<= 200, default 50)
//   ?before=       transaction id, for pagination (older than)
//   ?since= &until= ISO timestamps bounding created_at
router.get('/ledger', asyncHandler(async (req, res) => {
  const q = req.query || {};
  res.json({
    movements: await econ.economyLedger({
      type: q.type || null,
      walletType: q.wallet || q.walletType || null,
      userId: q.userId || q.user || null,
      limit: Number(q.limit) || 50,
      before: q.before ? Number(q.before) : null,
      since: q.since || q.from || null,
      until: q.until || q.to || null,
    }),
  });
}));

// POST /grant -- reward_pool -> user. Body: { toUserId, amount, reason }
router.post('/grant', requireIdemKey, asyncHandler(async (req, res) => {
  const { toUserId, amount, reason } = req.body || {};
  const result = await econ.adminGrant({
    toUserId, amount, reason: reason || null,
    actorId: req.user && req.user.id,
    idempotencyKey: req.idempotencyKey,
  });
  res.status(201).json({ ok: true, ...result });
}));

// POST /reclaim -- user -> reward_pool. Body: { fromUserId, amount, reason }
router.post('/reclaim', requireIdemKey, asyncHandler(async (req, res) => {
  const { fromUserId, amount, reason } = req.body || {};
  const result = await econ.adminReclaim({
    fromUserId, amount, reason: reason || null,
    actorId: req.user && req.user.id,
    idempotencyKey: req.idempotencyKey,
  });
  res.status(201).json({ ok: true, ...result });
}));

// POST /transfer-pool -- system pool -> system pool.
// Body: { fromPool, toPool, amount, reason }
router.post('/transfer-pool', requireIdemKey, asyncHandler(async (req, res) => {
  const { fromPool, toPool, amount, reason } = req.body || {};
  const result = await econ.transferPool({
    fromPool, toPool, amount, reason: reason || null,
    actorId: req.user && req.user.id,
    idempotencyKey: req.idempotencyKey,
  });
  res.status(201).json({ ok: true, ...result });
}));

module.exports = router;
