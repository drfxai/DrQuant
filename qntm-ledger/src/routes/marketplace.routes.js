'use strict';
const { Router } = require('express');
const { asyncHandler, requireAuth, requireRole } = require('./_helpers');
const marketplace = require('../marketplace');

const router = Router();

// POST /marketplace/purchase — buy a creator product (escrow-protected)
router.post('/purchase', requireAuth, asyncHandler(async (req, res) => {
  const { creatorId, amount, productRef, refundWindowSeconds } = req.body || {};
  const result = await marketplace.purchase({
    buyerOwnerId: req.user.id, creatorOwnerId: creatorId, amount, productRef,
    refundWindowSeconds, idempotencyKey: req.get('Idempotency-Key') || null,
  });
  res.status(201).json({ escrow: result.escrow, transaction: result.transaction });
}));

// POST /marketplace/settle/:escrowId — settle escrow into creator pending + fees
// (normally invoked by a scheduled job after the refund window; admin-gated here)
router.post('/settle/:escrowId', requireAuth, requireRole('admin', 'system'),
  asyncHandler(async (req, res) => {
    const result = await marketplace.settle(Number(req.params.escrowId));
    res.json(result);
  }));

module.exports = router;
