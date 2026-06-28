// services/quantoption-engine.js
// ============================================================================
// Quant Option — pure, dependency-free engine (no DB, no network, no globals).
//
// This module holds EVERY decision that matters: the price path a position
// follows, whether/when it hits target or stop, the expiry verdict, and the
// exact QNTM amounts that move on settlement. It is deliberately isolated from
// the ledger/DB so it can be unit-tested in full and reasoned about in one
// place. services/quantoption.js orchestrates the DB + ledger around it.
//
// PROVABLY FAIR: a position's price path is a deterministic function of its
// server seed (committed as a hash when the position opens, revealed at
// settlement). Given the seed + entry + vol + step, anyone can replay the exact
// path and confirm the outcome. The operator cannot change the result after the
// hash is shown without breaking the hash.
//
// PRICES vs MONEY: market prices are ordinary JS numbers (they are quotes, not
// balances). QNTM amounts are NEVER floats — they are decimal strings run
// through qntm-ledger/src/decimal, exactly like the rest of the ledger.
// ============================================================================
"use strict";

const crypto = require("crypto");
const decimal = require("../qntm-ledger/src/decimal");

// 85% payout: a winning position returns stake + 85% of stake (1.85x). A draw
// returns the stake. A loss forfeits the stake to the pool. PAYOUT_BPS is the
// PROFIT portion in basis points (8500 = 85%).
const PAYOUT_BPS = 8500;

// ── deterministic standard-normal from (seedHex, stepIndex) ─────────────────
// Box-Muller over two uint32 lanes pulled from sha256(seed:":"step). Pure and
// reproducible: same (seed, i) always yields the same z. Used to drive the walk.
function gauss(seedHex, i) {
  const h = crypto.createHash("sha256").update(seedHex + ":" + i).digest();
  // two 32-bit lanes -> (0,1) uniforms (avoid exactly 0)
  const u1 = (h.readUInt32BE(0) + 1) / 4294967297;
  const u2 = (h.readUInt32BE(4) + 1) / 4294967297;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// number of discrete steps in a position of `expirySec` seconds at `stepMs` ms
function stepsFor(expirySec, stepMs) {
  return Math.max(1, Math.round((expirySec * 1000) / stepMs));
}

// Target/stop distance from entry, in PRICE units. Scaled so the move is
// reachable-but-not-trivial over the life of the position: ~0.9 of the walk's
// expected 1-sigma envelope across all steps. Larger vol / longer expiry → wider.
function offsetFor(entry, vol, expirySec, stepMs) {
  const steps = stepsFor(expirySec, stepMs);
  return entry * vol * Math.sqrt(steps) * 0.9;
}

// price after `stepIndex` steps of the seeded multiplicative walk from `entry`
function pathAt(entry, vol, seedHex, stepIndex) {
  let p = entry;
  for (let i = 1; i <= stepIndex; i++) p *= Math.exp(vol * gauss(seedHex, i));
  return p;
}

// Early-resolution check at a single price. Returns "win" | "lose" | null.
//   long : win when price >= target (above entry), lose when price <= stop
//   short: win when price <= target (below entry), lose when price >= stop
function hitOutcome(dir, price, target, stop) {
  if (dir === "long") {
    if (price >= target) return "win";
    if (price <= stop) return "lose";
  } else {
    if (price <= target) return "win";
    if (price >= stop) return "lose";
  }
  return null;
}

// Expiry verdict (no early hit): whichever of target/stop the final price is
// nearer to wins; an exact tie (within epsilon) is a draw.
function expiryOutcome(price, target, stop) {
  const dT = Math.abs(price - target);
  const dS = Math.abs(price - stop);
  const eps = Math.abs(target - stop) * 1e-9;
  if (Math.abs(dT - dS) <= eps) return "draw";
  return dT < dS ? "win" : "lose";
}

// ── full evaluation of a position up to `nowMs` ─────────────────────────────
// Replays the seeded walk from open to min(now, expiry). Returns the live price,
// whether it has resolved (early hit OR expiry reached), the outcome + exit
// price if so, and a downsampled tick array for charting. `maxTicks` bounds the
// returned series (the scan itself is always full-fidelity).
function evaluate(pos, nowMs, maxTicks) {
  maxTicks = maxTicks || 120;
  const entry = Number(pos.entry);
  const target = Number(pos.target);
  const stop = Number(pos.stop);
  const vol = Number(pos.vol);
  const dir = pos.dir;
  const stepMs = Number(pos.stepMs);
  const openedMs = pos.openedMs;
  const expirySteps = stepsFor(Number(pos.expirySec), stepMs);
  const nowSteps = Math.max(0, Math.floor((nowMs - openedMs) / stepMs));
  const scanTo = Math.min(nowSteps, expirySteps);

  const every = Math.max(1, Math.ceil(scanTo / maxTicks));
  const ticks = [{ i: 0, t: openedMs, price: entry }];

  let price = entry;
  let resolved = false;
  let outcome = null;
  let exitPrice = null;
  let exitStep = null;

  for (let i = 1; i <= scanTo; i++) {
    price *= Math.exp(vol * gauss(pos.seed, i));
    if (i % every === 0) ticks.push({ i: i, t: openedMs + i * stepMs, price: price });
    const hit = hitOutcome(dir, price, target, stop);
    if (hit) { resolved = true; outcome = hit; exitPrice = price; exitStep = i; break; }
  }

  if (!resolved && nowSteps >= expirySteps) {
    // reached expiry with no early hit → distance verdict at the expiry price
    resolved = true;
    outcome = expiryOutcome(price, target, stop);
    exitPrice = price;
    exitStep = expirySteps;
  }

  const last = ticks[ticks.length - 1];
  if (!last || last.i !== (exitStep != null ? exitStep : scanTo)) {
    ticks.push({ i: exitStep != null ? exitStep : scanTo, t: openedMs + (exitStep != null ? exitStep : scanTo) * stepMs, price: price });
  }

  return {
    resolved: resolved,
    outcome: outcome,                 // "win" | "lose" | "draw" | null
    livePrice: price,
    exitPrice: exitPrice,
    exitStep: exitStep,
    nowSteps: nowSteps,
    expirySteps: expirySteps,
    ticks: ticks,
  };
}

// ── money ───────────────────────────────────────────────────────────────────
// 85% of a stake, exact (remainder, if any single base-unit, favors the user).
function profitOf(stake) {
  return decimal.splitByBps(stake, [
    { key: "p", bps: PAYOUT_BPS, remainder: true },
    { key: "r", bps: 10000 - PAYOUT_BPS },
  ]).p;
}

// What the pool pays the user, and the user's net P/L, for a settled position.
//   win  → credit = stake + 85%  (pool pays 1.85x; user net +85%)
//   draw → credit = stake        (pool returns the escrow; user net 0)
//   lose → credit = 0            (escrow stays in pool; user net -stake)
function settleAmounts(outcome, stake) {
  if (outcome === "win") { const profit = profitOf(stake); return { credit: decimal.add(stake, profit), profit: profit }; }
  if (outcome === "draw") return { credit: stake, profit: "0" };
  return { credit: "0", profit: decimal.neg(stake) };
}

// Pool balance required to safely cover EVERY open position paying out at once.
// The pool already holds the sum of open stakes (S); a full win pays 1.85·S, so
// it must additionally hold 0.85·S of profit buffer. required = 1.85 · S.
function requiredPool(totalOpenStake) {
  return decimal.add(totalOpenStake, profitOf(totalOpenStake));
}

// ── provably-fair seed pair ─────────────────────────────────────────────────
function newSeed() {
  const seed = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  return { seed: seed, hash: hash };
}
function seedHash(seed) {
  return crypto.createHash("sha256").update(seed).digest("hex");
}

// ── ambient ("market") price — public, seed-free, bounded ───────────────────
// A smooth deterministic function of wall-clock time so every client renders the
// SAME pre-trade chart without polling, and the server can stamp an entry price
// on the same curve. Three sine waves (bounded) + a gentle fast wave for life.
// `wave` carries per-symbol amplitudes/periods/phases derived from a symbol key.
function deriveWave(symbolKey) {
  // deterministic params from the symbol name; periods in seconds
  const h = crypto.createHash("sha256").update("wave:" + symbolKey).digest();
  const f = (o) => h.readUInt32BE(o) / 4294967296; // (0,1)
  return {
    a1: 0.010 + f(0) * 0.014,  p1: 240 + Math.floor(f(4) * 220),  ph1: f(8) * Math.PI * 2,
    a2: 0.006 + f(12) * 0.010, p2: 1700 + Math.floor(f(16) * 1900), ph2: f(20) * Math.PI * 2,
    a3: 0.0016 + f(24) * 0.0026, p3: 41 + Math.floor(f(28) * 37),  ph3: (f(0) + f(28)) * Math.PI * 2,
  };
}
function clockPrice(base, wave, tMs) {
  const s = tMs / 1000;
  const x =
    wave.a1 * Math.sin((2 * Math.PI * s) / wave.p1 + wave.ph1) +
    wave.a2 * Math.sin((2 * Math.PI * s) / wave.p2 + wave.ph2) +
    wave.a3 * Math.sin((2 * Math.PI * s) / wave.p3 + wave.ph3);
  return base * Math.exp(x);
}

module.exports = {
  PAYOUT_BPS,
  gauss, stepsFor, offsetFor, pathAt, hitOutcome, expiryOutcome, evaluate,
  profitOf, settleAmounts, requiredPool,
  newSeed, seedHash, deriveWave, clockPrice,
};
