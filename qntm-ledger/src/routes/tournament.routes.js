'use strict';
const { Router } = require('express');
const { asyncHandler, requireAuth, requireRole } = require('./_helpers');
const tournaments = require('../tournaments');

const router = Router();

// POST /tournaments/:id/join — pay entry fee into the prize pool
router.post('/:id/join', requireAuth, asyncHandler(async (req, res) => {
  const { entryFee } = req.body || {};
  const txn = await tournaments.join({ tournamentId: req.params.id, ownerId: req.user.id, entryFee });
  res.status(201).json({ transaction: txn });
}));

// GET /tournaments/:id/pool — collected pool size
router.get('/:id/pool', requireAuth, asyncHandler(async (req, res) => {
  res.json({ tournamentId: req.params.id, pool: await tournaments.collectedPool(req.params.id) });
}));

// POST /tournaments/:id/settle — distribute prizes (admin/system)
router.post('/:id/settle', requireAuth, requireRole('admin', 'system'), asyncHandler(async (req, res) => {
  const { winners, rakeBps } = req.body || {};
  const result = await tournaments.settle({ tournamentId: req.params.id, winners, rakeBps });
  res.json(result);
}));

module.exports = router;
