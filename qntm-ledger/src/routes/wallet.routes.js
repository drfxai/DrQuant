'use strict';
const { Router } = require('express');
const { asyncHandler, requireAuth } = require('./_helpers');
const wallets = require('../wallets');
const { walletLedger } = require('../ledger');
const transfers = require('../transfers');
const risk = require('../risk');
const { guard } = require('../ratelimit');
const { flagGuard } = require('../economy/flags');

const router = Router();

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
