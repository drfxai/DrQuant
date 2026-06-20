'use strict';
const { Router } = require('express');
const { asyncHandler, requireAuth } = require('./_helpers');
const { flagGuard } = require('../economy/flags');
const { guard } = require('../ratelimit');
const phase1 = require('../economy/phase1');

const router = Router();

// POST /marketplace/pay -- atomic split payment in QNTM.
// Body: { creatorId, amount, productRef? }   (Idempotency-Key header recommended)
// Buyer is the authenticated user. The amount is split creator/platform/reward
// (default 70/20/10) in a single atomic ledger transaction.
router.post('/pay', requireAuth, flagGuard('marketplace'),
  guard({ scope: 'marketplace_pay', capacity: 20, refillPerSec: 1 }),
  asyncHandler(async (req, res) => {
    const { creatorId, amount, productRef } = req.body || {};
    const result = await phase1.marketplacePay({
      buyerUserId: req.user.id, creatorUserId: creatorId, amount, productRef,
      actorId: req.user.id, idempotencyKey: req.get('Idempotency-Key') || null,
    });
    res.status(201).json({ ok: true, ...result });
  }));

module.exports = router;
