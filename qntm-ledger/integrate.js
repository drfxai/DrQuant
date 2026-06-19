'use strict';
const express = require('express');
const wallets = require('./src/wallets');
const { ensureQntmSchema, ensureEconomyWallets } = require('./src/economy/schema');
const adminEconomyRouter = require('./src/routes/admin.economy.routes');
const { errorHandler } = require('./src/routes/_helpers');

/**
 * integrate.js -- the single entrypoint the host app (server.js) uses to wire
 * the QNTM economic layer in.
 *
 * The engine connects to the SAME database as the host via DATABASE_URL (it has
 * its own pool; sharing the literal pool object would mean touching every
 * engine module, so we keep them on one connection string instead -- same DB,
 * same tables). Schema is applied through this function from the host boot
 * sequence, satisfying "apply via initDB".
 */

/** Apply the ledger + economy schema and ensure system/allocation wallets. */
async function setupQntmSchema() {
  await ensureQntmSchema();
  await wallets.ensureSystemWallets('QNTM');
  await ensureEconomyWallets();
}

/**
 * Mount the QNTM admin economy API under `base` (default /api/qntm/admin),
 * guarded by the HOST's auth middlewares. Pass the app's authMiddleware and
 * adminMiddleware.
 *
 * The direct "buy QNTM" sale path (qntm-ledger payments/exchange) is
 * deliberately NOT mounted here: QNTM is not sold to users in this phase.
 */
function mountQntmEconomy(app, opts) {
  opts = opts || {};
  const base = opts.base || '/api/qntm/admin';
  const guards = [opts.authMiddleware, opts.adminMiddleware].filter(Boolean);
  app.use(base, express.json(), ...guards, adminEconomyRouter);
  app.use(errorHandler);
  return app;
}

module.exports = { setupQntmSchema, mountQntmEconomy };
