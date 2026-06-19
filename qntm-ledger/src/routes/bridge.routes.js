'use strict';
const { Router } = require('express');
const { requireAuth } = require('./_helpers');

/**
 * bridge.routes.js — on-chain deposit/withdrawal ON/OFF-RAMP (spec §20, Phase 3+).
 *
 * INTENTIONALLY DISABLED. QNTM is an internal, NON-REDEEMABLE platform credit.
 * There is deliberately no path to (a) buy QNTM with fiat/crypto, or
 * (b) withdraw/redeem QNTM for anything of monetary value.
 *
 * Activating a real ramp converts the system into custody + money transmission
 * (and, depending on how QNTM is marketed, potentially a securities/AML matter).
 * That requires legal counsel, licensing, KYC/AML, sanctions screening, and a
 * Travel-Rule program FIRST. Until that work is signed off, these endpoints
 * return HTTP 501 so the contract is explicit and no ramp can be wired in by
 * accident. See COMPLIANCE.md.
 */
const router = Router();

function gated(_req, res) {
  res.status(501).json({
    error: {
      code: 'ramp_disabled',
      message:
        'QNTM is an internal, non-redeemable credit. Deposit/withdrawal (on/off-ramp) ' +
        'is intentionally disabled and requires legal/compliance sign-off before it can exist. ' +
        'See COMPLIANCE.md.',
    },
  });
}

router.post('/deposit', requireAuth, gated);
router.post('/withdraw', requireAuth, gated);
router.get('/deposit/address', requireAuth, gated);
router.get('/status', requireAuth, (_req, res) =>
  res.json({ enabled: false, reason: 'internal non-redeemable token; ramp gated pending compliance' }));

module.exports = router;
