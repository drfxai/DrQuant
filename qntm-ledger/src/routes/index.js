'use strict';
const { Router } = require('express');
const { errorHandler } = require('./_helpers');

/**
 * Mounts every QNTM router under a base path and attaches the error handler.
 *
 *   const express = require('express');
 *   const { mountQntm } = require('./qntm-ledger/src/routes');
 *   const { ensureSystemWallets } = require('./qntm-ledger/src/wallets');
 *   await ensureSystemWallets('QNTM');
 *   mountQntm(app, { basePath: '/api/qntm' });
 *
 * `app` must already populate req.user = { id, role } via your JWT/RBAC
 * middleware before these routes run.
 */
function mountQntm(app, { basePath = '/api/qntm' } = {}) {
  const api = Router();
  api.use('/wallets', require('./wallet.routes'));
  api.use('/marketplace', require('./marketplace.routes'));
  api.use('/subscriptions', require('./subscription.routes'));
  api.use('/staking', require('./staking.routes'));
  api.use('/tournaments', require('./tournament.routes'));
  api.use('/rewards', require('./reward.routes'));
  api.use('/admin', require('./admin.routes'));
  api.use('/bridge', require('./bridge.routes')); // 501 stubs (disabled ramp)
  app.use(basePath, api);
  app.use(errorHandler);
  return app;
}
module.exports = { mountQntm, errorHandler };
