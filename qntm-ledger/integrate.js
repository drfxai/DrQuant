'use strict';
const express = require('express');
const wallets = require('./src/wallets');
const { ensureQntmSchema, ensureEconomyWallets } = require('./src/economy/schema');
const adminEconomyRouter = require('./src/routes/admin.economy.routes');
const adminEconomyConsoleRouter = require('./src/routes/admin.economy.console.routes');
const adminPaymentsRouter = require('./src/routes/admin.payments.routes');
const walletRouter = require('./src/routes/wallet.routes');
const marketplacePayRouter = require('./src/routes/marketplace.pay.routes');
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
 * Phase-1 scoped mount of the QNTM internal economy. Deliberately does NOT call
 * the engine's global mountQntm() (which would also expose marketplace escrow,
 * subscriptions, staking, tournaments, public rewards and the on-chain bridge).
 * Only the controlled-phase surface is wired:
 *
 *   /api/qntm/admin/economy  admin Economy Console: summary / ledger / grant /
 *                            reclaim / transfer-pool                (auth + admin)
 *   /api/qntm/admin          admin economy API + POST /grant        (auth + admin)
 *   /api/qntm/wallets        GET /me, /me/transactions, transfer    (auth)
 *   /api/qntm/marketplace    POST /pay (atomic split payment)       (auth)
 *
 * NOT mounted in this phase (no route exists regardless of any flag): external
 * buy/sell, on-chain bridge, withdrawals, staking, tournaments, subscriptions,
 * automatic public reward emission, and admin mint. Per-capability feature flags
 * live in ./src/economy/flags.js.
 *
 * Pass the host app's authMiddleware and adminMiddleware. The latter also gates
 * grants and every Economy Console action; substitute an economy-admin role
 * here later without touching the financial code.
 */
function mountQntmEconomy(app, opts) {
  opts = opts || {};
  const root = opts.root || '/api/qntm';
  const adminBase = opts.base || (root + '/admin');
  const userGuards = [opts.authMiddleware].filter(Boolean);
  const adminGuards = [opts.authMiddleware, opts.adminMiddleware].filter(Boolean);

  // Admin Economy Console: the economy-dedicated admin wallet. Mounted at the
  // MORE SPECIFIC /admin/economy path BEFORE the general /admin router below so
  // it takes precedence for those routes.
  app.use(adminBase + '/economy', express.json(), ...adminGuards, adminEconomyConsoleRouter);

  // Payment orders (NOWPayments top-ups): list / re-credit / mark-failed.
  app.use(adminBase + '/payment-orders', express.json(), ...adminGuards, adminPaymentsRouter);

  // Admin economy API: overview / wallets / transactions / bootstrap / grant.
  app.use(adminBase, express.json(), ...adminGuards, adminEconomyRouter);

  // User wallet: balance + history + peer transfer.
  app.use(root + '/wallets', express.json(), ...userGuards, walletRouter);

  // Marketplace: atomic split payment in QNTM.
  app.use(root + '/marketplace', express.json(), ...userGuards, marketplacePayRouter);

  app.use(errorHandler);
  return app;
}

module.exports = { setupQntmSchema, mountQntmEconomy };
