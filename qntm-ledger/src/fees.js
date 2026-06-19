'use strict';
const decimal = require('./decimal');
const { E } = require('./errors');
/**
 * fees.js — turn a gross amount + a basis-point policy into an exact split.
 * Weights are in basis points (1% = 100 bps) and MUST sum to 10000. The
 * indivisible-unit remainder is assigned to whichever part is flagged
 * `remainder` (usually the creator), so the split is always lossless.
 *
 *   splitAmount('100', { creator: 8500, treasury: 1000, burn: 500 }, 'creator')
 *     => { creator: '85', treasury: '10', burn: '5' }
 */
function splitAmount(gross, bpsByKey, remainderKey) {
  const parts = Object.entries(bpsByKey).map(([key, bps]) => ({
    key, bps, remainder: key === remainderKey,
  }));
  if (!parts.some((p) => p.remainder)) parts[0].remainder = true;
  try {
    return decimal.splitByBps(gross, parts);
  } catch (err) {
    throw E.Validation(err.message);
  }
}
module.exports = { splitAmount };
