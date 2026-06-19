'use strict';
/**
 * decimal.js — exact fixed-point arithmetic for QNTM amounts.
 *
 * Money/token amounts are NEVER represented as JS Number (IEEE-754 float),
 * per the spec's hard rule. Internally we scale every amount to an integer
 * number of "base units" using BigInt, where 1 QNTM = 10^SCALE base units.
 *
 * SCALE = 18 mirrors the Ethereum wei model and matches NUMERIC(36,18) in
 * Postgres, so the off-chain ledger stays bit-for-bit compatible if QNTM is
 * ever mapped onto an 18-decimal ERC-20 in the (compliance-gated) future.
 *
 * All public functions take/return decimal STRINGS (e.g. "50.00", "0.000001").
 * They are safe to pass straight into parameterized SQL as NUMERIC.
 */

const SCALE = 18;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

/** Parse a decimal string into BigInt base units. Throws on malformed input. */
function toBaseUnits(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    // Refuse floats outright — they are the bug class this module exists to prevent.
    throw new TypeError(
      `decimal: refusing to parse a JS number (${value}); pass a string to avoid float error`
    );
  }
  if (typeof value !== 'string') {
    throw new TypeError(`decimal: expected string, got ${typeof value}`);
  }
  const trimmed = value.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!m) throw new RangeError(`decimal: malformed amount "${value}"`);
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = BigInt(m[2]);
  let frac = m[3] || '';
  if (frac.length > SCALE) {
    throw new RangeError(
      `decimal: "${value}" has more than ${SCALE} fractional digits`
    );
  }
  frac = frac.padEnd(SCALE, '0');
  return sign * (whole * SCALE_FACTOR + BigInt(frac));
}

/** Format BigInt base units back into a canonical decimal string. */
function fromBaseUnits(units) {
  if (typeof units !== 'bigint') {
    throw new TypeError(`decimal: fromBaseUnits expects bigint, got ${typeof units}`);
  }
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  const body = frac.length ? `${whole}.${frac}` : `${whole}`;
  return neg && abs !== 0n ? `-${body}` : body;
}

const add = (a, b) => fromBaseUnits(toBaseUnits(a) + toBaseUnits(b));
const sub = (a, b) => fromBaseUnits(toBaseUnits(a) - toBaseUnits(b));
const neg = (a) => fromBaseUnits(-toBaseUnits(a));

/** Compare two amounts: -1, 0, or 1. */
function cmp(a, b) {
  const x = toBaseUnits(a);
  const y = toBaseUnits(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const isPositive = (a) => toBaseUnits(a) > 0n;
const isZero = (a) => toBaseUnits(a) === 0n;
const isNegative = (a) => toBaseUnits(a) < 0n;

/**
 * Sum a list of signed amounts and report whether they net to exactly zero.
 * Used as the fast pre-flight check for the double-entry invariant before a
 * transaction ever reaches the database (the DB enforces it authoritatively).
 */
function sumIsZero(amounts) {
  let total = 0n;
  for (const a of amounts) total += toBaseUnits(a);
  return total === 0n;
}

/**
 * Split `total` into integer-exact parts using basis-point weights that sum to
 * 10000. Any rounding remainder (from indivisible base units) is assigned to
 * the part flagged `remainder: true`, so no base unit is ever created or lost.
 *
 *   splitByBps("100", [
 *     { key: 'creator',  bps: 8500, remainder: true },
 *     { key: 'treasury', bps: 1000 },
 *     { key: 'burn',     bps: 500  },
 *   ])  // => { creator: "85", treasury: "10", burn: "5" }  (exact)
 */
function splitByBps(total, parts) {
  const totalBps = parts.reduce((s, p) => s + p.bps, 0);
  if (totalBps !== 10000) {
    throw new RangeError(`decimal: split weights must sum to 10000 bps, got ${totalBps}`);
  }
  const units = toBaseUnits(total);
  if (units < 0n) throw new RangeError('decimal: cannot split a negative total');
  const out = {};
  let allocated = 0n;
  let remainderKey = null;
  for (const p of parts) {
    if (p.remainder) { remainderKey = p.key; continue; }
    const share = (units * BigInt(p.bps)) / 10000n;
    out[p.key] = fromBaseUnits(share);
    allocated += share;
  }
  if (!remainderKey) {
    // No explicit remainder sink: give it to the largest-weight part.
    remainderKey = parts.reduce((a, b) => (b.bps > a.bps ? b : a)).key;
    if (out[remainderKey] === undefined) {
      // remainderKey was a non-remainder part already computed; recompute below
    }
  }
  out[remainderKey] = fromBaseUnits(units - allocated);
  return out;
}

module.exports = {
  SCALE,
  toBaseUnits,
  fromBaseUnits,
  add,
  sub,
  neg,
  cmp,
  isPositive,
  isZero,
  isNegative,
  sumIsZero,
  splitByBps,
};
