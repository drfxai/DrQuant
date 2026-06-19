'use strict';
const { Router } = require('express');
const { asyncHandler, requireAuth } = require('./_helpers');
const orders = require('../payments/orders');

/**
 * exchange.routes.js — user-facing QNTM top-up (spec §3).
 * Mounted at /api/exchange/qntm. One-way only: buy credits, never cash out.
 *
 * `ipnCallbackUrl` is injected at mount time so the order knows where
 * NOWPayments should send the IPN.
 */
module.exports = function exchangeRouter({ ipnCallbackUrl, successUrl, cancelUrl } = {}) {
  const router = Router();

  // POST /api/exchange/qntm/quote  { mode: 'qntm'|'usd', amount }
  router.post('/quote', requireAuth, asyncHandler(async (req, res) => {
    const { mode, amount } = req.body || {};
    res.json(orders.quote({ mode, amount }));
  }));

  // POST /api/exchange/qntm/buy/nowpayments  { mode, amount, pay_currency }
  router.post('/buy/nowpayments', requireAuth, asyncHandler(async (req, res) => {
    const { mode, amount, pay_currency: payCurrency } = req.body || {};
    const result = await orders.createNowpaymentsOrder({
      userId: req.user.id, mode, amount, payCurrency,
      ipnCallbackUrl, successUrl, cancelUrl,
    });
    res.status(201).json(result);
  }));

  return router;
};
