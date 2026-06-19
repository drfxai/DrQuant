'use strict';
const { Router } = require('express');
const { asyncHandler, requireAuth, requireRole } = require('./_helpers');
const deck = require('../deck');
const treasury = require('../treasury');

/**
 * admin.deck.routes.js — QNTM Control Deck read/aggregate + admin-wallet API
 * (spec §5.2.1/.4/.5/.6). Super-admin only. State-changing supply ops live in
 * admin.routes.js; payment-order ops in admin.payments.routes.js.
 */
const router = Router();
router.use(requireAuth, requireRole('admin', 'superadmin', 'system'));

// GET /dashboard — summary cards, integrity, recent activity (§5.2.1)
router.get('/dashboard', asyncHandler(async (req, res) => {
  res.json(await deck.dashboard({ recent: Number(req.query.recent) || 10 }));
}));

// GET /transactions?type=&userId=&walletId=&from=&to=&before=&limit=&entries=1 (§5.2.4)
router.get('/transactions', asyncHandler(async (req, res) => {
  const q = req.query;
  res.json({
    transactions: await deck.ledgerExplorer({
      type: q.type, initiatorUserId: q.userId, walletId: q.walletId,
      fromDate: q.from, toDate: q.to, before: q.before ? Number(q.before) : null,
      limit: Number(q.limit) || 50, withEntries: q.entries === '1' || q.entries === 'true',
    }),
  });
}));

// GET /transactions/:publicId — one transaction with all entries
router.get('/transactions/:publicId', asyncHandler(async (req, res) => {
  const t = await deck.transactionDetail(req.params.publicId);
  if (!t) return res.status(404).json({ error: { code: 'not_found', message: 'transaction not found' } });
  res.json({ transaction: t });
}));

// GET /users/:userId — user wallet inspector (§5.2.5)
router.get('/users/:userId', asyncHandler(async (req, res) => {
  res.json(await deck.userInspector({ userId: req.params.userId, limit: Number(req.query.limit) || 50 }));
}));

// GET /admin-wallet — the calling admin's own personal wallet + history (§5.2.6)
router.get('/admin-wallet', asyncHandler(async (req, res) => {
  res.json(await deck.adminWalletHistory(req.user.id, { limit: Number(req.query.limit) || 50 }));
}));

// GET /admin-wallet/:adminId — view a specific admin's personal wallet
router.get('/admin-wallet/:adminId', asyncHandler(async (req, res) => {
  res.json(await deck.adminWalletHistory(req.params.adminId, { limit: Number(req.query.limit) || 50 }));
}));

// POST /admin-wallet/fund — fund the calling admin's personal wallet from treasury
// (a standard `grant`; fully audited by the ledger). For test/demo/internal use.
router.post('/admin-wallet/fund', asyncHandler(async (req, res) => {
  const { amount, reason } = req.body || {};
  const wallet = await deck.getOrCreateAdminWallet(req.user.id);
  const txn = await treasury.grant(wallet.id, amount, {
    actorId: req.user.id, reason: reason || 'fund admin personal wallet',
    idempotencyKey: req.get('Idempotency-Key') || null,
  });
  res.status(201).json({ transaction: txn, wallet });
}));

module.exports = router;
