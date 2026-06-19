'use strict';
const express = require('express');
const { errorHandler } = require('./_helpers');
const exchangeRouter = require('./exchange.routes');
const webhooksRouter = require('./webhooks.routes');
const adminPaymentsRouter = require('./admin.payments.routes');
const { ensurePaymentWallets } = require('../payments/orders');

/**
 * mountPayments — wire the NOWPayments top-up surface onto an Express app.
 *
 *   const { mountPayments } = require('./qntm-ledger/src/routes/mount-payments');
 *   const { ensureSystemWallets } = require('./qntm-ledger/src/wallets');
 *   await ensureSystemWallets('QNTM');
 *   await ensurePaymentWallets('QNTM');           // (also called here at mount)
 *   mountPayments(app, {
 *     ipnCallbackUrl: 'https://drfx.io/api/webhooks/nowpayments',
 *   });
 *
 * Paths (per spec §3): exchange at /api/exchange/qntm, IPN at
 * /api/webhooks/nowpayments, Control Deck order management under
 * /api/qntm/admin/payment-orders. `app` must populate req.user before these.
 */
function mountPayments(app, {
  exchangeBase = '/api/exchange/qntm',
  webhookPath = '/api/webhooks/nowpayments',
  adminBase = '/api/qntm/admin/payment-orders',
  ipnCallbackUrl,
  successUrl,
  cancelUrl,
} = {}) {
  // Best-effort wallet bootstrap (idempotent); host can also await it at boot.
  Promise.resolve(ensurePaymentWallets('QNTM')).catch((e) =>
    // eslint-disable-next-line no-console
    console.error('[qntm] ensurePaymentWallets failed:', e));

  app.use(exchangeBase, express.json(), exchangeRouter({ ipnCallbackUrl, successUrl, cancelUrl }));
  app.use(webhookPath, express.json(), webhooksRouter);
  app.use(adminBase, express.json(), adminPaymentsRouter);
  app.use(errorHandler);
  return app;
}

module.exports = { mountPayments, ensurePaymentWallets };
