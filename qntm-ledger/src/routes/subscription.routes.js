'use strict';
const { Router } = require('express');
const { asyncHandler, requireAuth } = require('./_helpers');
const subscriptions = require('../subscriptions');

const router = Router();

// POST /subscriptions — start a subscription to a creator
router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const { planId, creatorId, amount, intervalDays, trialDays } = req.body || {};
  const result = await subscriptions.createSubscription({
    subscriberUserId: req.user.id, planId, creatorOwnerId: creatorId, amount, intervalDays, trialDays,
  });
  res.status(201).json(result);
}));

// POST /subscriptions/:id/cancel
router.post('/:id/cancel', requireAuth, asyncHandler(async (req, res) => {
  const sub = await subscriptions.cancel(Number(req.params.id), { atPeriodEnd: !!(req.body && req.body.atPeriodEnd) });
  res.json({ subscription: sub });
}));

module.exports = router;
