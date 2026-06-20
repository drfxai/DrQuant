'use strict';
/**
 * flags.js -- phase-1 feature flags for the QNTM internal economy.
 *
 * Phase 1 ("first controlled active internal economy") turns ON exactly four
 * capabilities and nothing else:
 *   - walletView   balance + history
 *   - transfer     user -> user QNTM
 *   - grant        platform pool -> user (admin; never mints)
 *   - marketplace  atomic split payment in QNTM
 *
 * Everything that touches real-world value, an external ramp, or speculation
 * stays OFF and is NOT mounted at all by integrate.js (bridge, withdrawal,
 * external buy/sell, staking, tournaments, subscriptions, automatic public
 * reward emission). The flags below for those are belt-and-suspenders: even if
 * flipped on, their routes are never wired in this phase.
 *
 * Override any flag with an env var: 1 / true / on / yes = enabled.
 */
function flag(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

const flags = {
  // ---- ON in phase 1 ----
  walletView: flag('QNTM_FLAG_WALLET_VIEW', true),
  transfer: flag('QNTM_FLAG_TRANSFER', true),
  grant: flag('QNTM_FLAG_GRANT', true),
  marketplace: flag('QNTM_FLAG_MARKETPLACE', true),
  // ---- OFF in phase 1 (routes not mounted regardless of value) ----
  bridge: flag('QNTM_FLAG_BRIDGE', false),
  withdrawal: flag('QNTM_FLAG_WITHDRAWAL', false),
  externalSale: flag('QNTM_FLAG_EXTERNAL_SALE', false),
  staking: flag('QNTM_FLAG_STAKING', false),
  tournaments: flag('QNTM_FLAG_TOURNAMENTS', false),
  subscriptions: flag('QNTM_FLAG_SUBSCRIPTIONS', false),
  publicRewards: flag('QNTM_FLAG_PUBLIC_REWARDS', false),
};

/** Express middleware: 403 when the named capability is disabled. */
function flagGuard(name) {
  return function (req, res, next) {
    if (!flags[name]) {
      return res.status(403).json({
        error: { code: 'feature_disabled', message: 'QNTM ' + name + ' is disabled' },
      });
    }
    next();
  };
}

module.exports = { flags, flagGuard };
