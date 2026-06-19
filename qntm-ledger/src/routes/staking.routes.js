'use strict';
const { Router } = require('express');
const { asyncHandler, requireAuth } = require('./_helpers');
const staking = require('../staking');

const router = Router();

// POST /staking/stake — lock QNTM (available -> locked) for a tier
router.post('/stake', requireAuth, asyncHandler(async (req, res) => {
  const { amount } = req.body || {};
  const result = await staking.stake({ ownerId: req.user.id, amount, idempotencyKey: req.get('Idempotency-Key') || null });
  res.status(201).json(result);
}));

// GET /staking — list the user's stakes
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  res.json({ stakes: await staking.listStakes(req.user.id) });
}));

// POST /staking/:id/unstake — begin cooldown
router.post('/:id/unstake', requireAuth, asyncHandler(async (req, res) => {
  res.json({ stake: await staking.requestUnstake(Number(req.params.id)) });
}));

// POST /staking/:id/complete — finalize after cooldown (locked -> available)
router.post('/:id/complete', requireAuth, asyncHandler(async (req, res) => {
  res.json(await staking.completeUnstake(Number(req.params.id)));
}));

module.exports = router;
