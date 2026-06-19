'use strict';
const { Router } = require('express');
const { asyncHandler } = require('./_helpers');
const orders = require('../payments/orders');

/**
 * webhooks.routes.js — NOWPayments IPN handler (spec §3.5).
 * Mounted at /api/webhooks/nowpayments. NO auth middleware (it's a server-to-
 * server callback); authenticity is established by HMAC signature verification
 * inside handleWebhook. A bad signature => 403 and zero balance change.
 *
 * The signature is computed over the JSON body (keys sorted), so the standard
 * express.json() parser is sufficient — no raw-body capture required.
 */
const router = Router();

router.post('/nowpayments', asyncHandler(async (req, res) => {
  const signature = req.get('x-nowpayments-sig');
  const result = await orders.handleWebhook({ body: req.body || {}, signature });
  // Always 200 on a handled webhook so NOWPayments doesn't needlessly retry;
  // the result.status records what actually happened.
  res.status(200).json(result);
}));

module.exports = router;
