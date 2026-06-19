'use strict';
const express = require('express');
const { errorHandler } = require('./_helpers');
const adminDeckRouter = require('./admin.deck.routes');

/**
 * mountDeck — wire the QNTM Control Deck read/aggregate + admin-wallet API.
 *
 *   const { mountDeck } = require('./qntm-ledger/src/routes/mount-deck');
 *   mountDeck(app);   // -> /api/qntm/admin/deck/*
 *
 * Pairs with mountQntm (core admin: mint/grant/adjust/supply) and mountPayments
 * (exchange + webhook + payment-order management). `app` must populate req.user
 * with an elevated role before these routes.
 */
function mountDeck(app, { base = '/api/qntm/admin/deck' } = {}) {
  app.use(base, express.json(), adminDeckRouter);
  app.use(errorHandler);
  return app;
}

module.exports = { mountDeck };
