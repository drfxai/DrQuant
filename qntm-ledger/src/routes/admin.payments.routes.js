'use strict';
const { Router } = require('express');
const { asyncHandler, requireAuth, requireRole } = require('./_helpers');
const orders = require('../payments/orders');

/**
 * admin.payments.routes.js — QNTM Control Deck payment-order management
 * (spec §5.2.3). Super-admin only.
 */
const router = Router();
router.use(requireAuth, requireRole('admin', 'superadmin', 'system'));

// GET /payment-orders?status=&userId=
router.get('/', asyncHandler(async (req, res) => {
  res.json({ orders: await orders.listOrders({ status: req.query.status, userId: req.query.userId, limit: Number(req.query.limit) || 100 }) });
}));

// GET /payment-orders/:publicId
router.get('/:publicId', asyncHandler(async (req, res) => {
  const order = await orders.getOrder(req.params.publicId);
  if (!order) return res.status(404).json({ error: { code: 'not_found', message: 'order not found' } });
  res.json({ order });
}));

// POST /payment-orders/:publicId/recredit — credit a paid-but-uncredited order
router.post('/:publicId/recredit', asyncHandler(async (req, res) => {
  res.json(await orders.manualReCredit(req.params.publicId, { adminId: req.user.id }));
}));

// POST /payment-orders/:publicId/fail — manual override (no balance change)
router.post('/:publicId/fail', asyncHandler(async (req, res) => {
  res.json({ order: await orders.markFailed(req.params.publicId, { adminId: req.user.id, reason: req.body && req.body.reason }) });
}));

module.exports = router;
