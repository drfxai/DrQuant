'use strict';
const { Router } = require('express');
const { asyncHandler, requireAuth, requireRole } = require('./_helpers');
const rewards = require('../rewards');
const referrals = require('../referrals');
const wallets = require('../wallets');

const router = Router();

// POST /rewards/grant — issue an engagement reward (admin/system)
router.post('/grant', requireAuth, requireRole('admin', 'system'), asyncHandler(async (req, res) => {
  const { userId, amount, rewardType, referenceId } = req.body || {};
  const w = await wallets.getOrCreateWallet('user', userId, 'personal');
  const txn = await rewards.reward(w.id, amount, { rewardType, referenceId, idempotencyKey: req.get('Idempotency-Key') || null });
  res.status(201).json({ transaction: txn });
}));

// POST /rewards/referral — credit a referral bonus (admin/system; anti-abuse enforced)
router.post('/referral', requireAuth, requireRole('admin', 'system'), asyncHandler(async (req, res) => {
  const { referrerId, refereeId, amount, action } = req.body || {};
  const txn = await referrals.rewardReferral({ referrerOwnerId: referrerId, refereeUserId: refereeId, amount, action });
  res.status(201).json({ transaction: txn });
}));

module.exports = router;
