'use strict';
const { Router } = require('express');
const { asyncHandler, requireAuth, requireRole } = require('./_helpers');
const treasury = require('../treasury');
const rewards = require('../rewards');
const adjustments = require('../adjustments');
const wallets = require('../wallets');
const supply = require('../supply');
const { searchAudit } = require('../audit');

const router = Router();
// Everything here requires an elevated role.
router.use(requireAuth, requireRole('admin', 'superadmin', 'system'));

// ----- supply control -----
// POST /admin/mint — issue new QNTM into treasury (this is where "the number of
// tokens" you send is applied; set QNTM_MAX_SUPPLY to cap it).
router.post('/mint', asyncHandler(async (req, res) => {
  const { amount, reason } = req.body || {};
  const txn = await treasury.mint(amount, { actorId: req.user.id, reason, idempotencyKey: req.get('Idempotency-Key') || null });
  res.status(201).json({ transaction: txn, supply: await treasury.supplySummary() });
}));

// POST /admin/grant — move issued tokens from treasury to a wallet
router.post('/grant', asyncHandler(async (req, res) => {
  const { userId, ownerType = 'user', walletType = 'personal', amount, reason } = req.body || {};
  const w = await wallets.getOrCreateWallet(ownerType, userId, walletType);
  const txn = await treasury.grant(w.id, amount, { actorId: req.user.id, reason, idempotencyKey: req.get('Idempotency-Key') || null });
  res.status(201).json({ transaction: txn });
}));

// POST /admin/reward-pool/fund — top up the reward pool from treasury
router.post('/reward-pool/fund', asyncHandler(async (req, res) => {
  const { amount, reason } = req.body || {};
  const txn = await rewards.fundRewardPool(amount, { actorId: req.user.id, reason });
  res.status(201).json({ transaction: txn });
}));

// ----- wallet controls -----
// POST /admin/wallets/:id/status — freeze / unfreeze / close
router.post('/wallets/:id/status', asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  res.json({ wallet: await wallets.setWalletStatus(Number(req.params.id), status) });
}));

// ----- two-person adjustments -----
// POST /admin/adjustments — request a balance correction
router.post('/adjustments', asyncHandler(async (req, res) => {
  const { walletId, direction, balanceKind, amount, reason } = req.body || {};
  const adj = await adjustments.requestAdjustment({ walletId, direction, balanceKind, amount, reason, requestedBy: req.user.id });
  res.status(201).json({ adjustment: adj });
}));

// GET /admin/adjustments/pending
router.get('/adjustments/pending', asyncHandler(async (req, res) => {
  res.json({ pending: await adjustments.listPending() });
}));

// POST /admin/adjustments/:id/approve — a DIFFERENT admin approves + executes
router.post('/adjustments/:id/approve', asyncHandler(async (req, res) => {
  const result = await adjustments.approveAndExecute(Number(req.params.id), { approverId: req.user.id });
  res.json(result);
}));

// POST /admin/adjustments/:id/reject
router.post('/adjustments/:id/reject', asyncHandler(async (req, res) => {
  const adj = await adjustments.reject(Number(req.params.id), { approverId: req.user.id, note: req.body && req.body.note });
  res.json({ adjustment: adj });
}));

// ----- reporting -----
// GET /admin/supply — supply snapshot + integrity check
router.get('/supply', asyncHandler(async (req, res) => {
  res.json({ supply: await supply.snapshot(), integrity: await supply.verifyIntegrity() });
}));

// GET /admin/supply/by-type
router.get('/supply/by-type', asyncHandler(async (req, res) => {
  res.json({ byType: await supply.byWalletType() });
}));

// GET /admin/audit?actorId=&action=
router.get('/audit', asyncHandler(async (req, res) => {
  res.json({ audit: await searchAudit({ ...req.query, limit: Number(req.query.limit) || 100 }) });
}));

module.exports = router;
