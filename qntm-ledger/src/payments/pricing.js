'use strict';
const decimal = require('../decimal');
const { E } = require('../errors');

/**
 * pricing.js — exact QNTM <-> USD conversion for top-ups.
 *
 * Fixed rate: 1 QNTM = 0.01 USD  (i.e. 1 QNTM = exactly 1 US cent).
 *
 * All math is done on integer BigInt base units (no floating point), so every
 * conversion is exact. To keep both sides representable we require:
 *   - USD amounts have at most 2 decimal places (whole cents), and
 *   - QNTM purchase amounts are whole credits (a fractional credit would map to
 *     a sub-cent USD price, which a payment processor cannot charge).
 *
 * usd  = qntm / 100      (qntm cents -> dollars)
 * qntm = usd  * 100      (dollars   -> qntm cents)
 */
const UNIT_PRICE_USD_PER_QNTM = '0.01';
const SCALE = decimal.SCALE;                  // 18
const CENT_IN_BASE = 10n ** BigInt(SCALE - 2); // base units representing 0.01

function _assertDecimalString(s, label) {
  if (typeof s !== 'string' || !/^\d+(\.\d+)?$/.test(s.trim())) {
    throw E.Validation(`${label} must be a positive decimal string`);
  }
}

/** usd (<=2dp) -> whole-cent integer count of QNTM. */
function qntmFromUsd(usd) {
  _assertDecimalString(usd, 'usd amount');
  const frac = usd.split('.')[1] || '';
  if (frac.length > 2) throw E.Validation('usd amount cannot have more than 2 decimal places (cents)');
  const units = decimal.toBaseUnits(usd);
  if (units <= 0n) throw E.InvalidAmount('amount must be greater than zero');
  // qntm = usd * 100
  return decimal.fromBaseUnits(units * 100n);
}

/** whole-credit qntm -> usd (2dp). */
function usdFromQntm(qntm) {
  _assertDecimalString(qntm, 'qntm amount');
  const units = decimal.toBaseUnits(qntm);
  if (units <= 0n) throw E.InvalidAmount('amount must be greater than zero');
  // A whole credit is an exact multiple of one base-unit "credit" (10^18).
  if (units % (10n ** BigInt(SCALE)) !== 0n) {
    throw E.Validation('qntm purchase amount must be a whole number of credits');
  }
  // usd = qntm / 100  (exact: a whole credit is 1 cent, so this is integer cents)
  return decimal.fromBaseUnits(units / 100n);
}

/**
 * Normalize a quote request into both amounts (as strings).
 *   mode: 'qntm' -> amount is QNTM (whole credits)
 *   mode: 'usd'  -> amount is USD (<=2dp)
 */
function quote({ mode, amount }) {
  if (mode === 'qntm') {
    const usd = usdFromQntm(amount);
    return { qntm_amount: amount.trim(), usd_amount: usd, unit_price_usd_per_qntm: UNIT_PRICE_USD_PER_QNTM };
  }
  if (mode === 'usd') {
    const qntm = qntmFromUsd(amount);
    return { qntm_amount: qntm, usd_amount: amount.trim(), unit_price_usd_per_qntm: UNIT_PRICE_USD_PER_QNTM };
  }
  throw E.Validation("mode must be 'qntm' or 'usd'");
}

module.exports = { quote, qntmFromUsd, usdFromQntm, UNIT_PRICE_USD_PER_QNTM };
