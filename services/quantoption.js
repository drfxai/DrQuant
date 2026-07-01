// services/quantoption.js
// ============================================================================
// Quant Option — the real, wallet-connected options-simulation engine.
//
// Same money model as Easy Trade: value moves ONLY through the authoritative
// qntm-ledger (postTransaction), so a Quant Option stake/payout is the same
// double-entry transaction as a transfer. The balance shown in Quant Option IS
// the user's main wallet — there is no separate or shadow balance, and the
// browser never decides an outcome.
//
// Flow
//   open   debit user → credit quantoption pool      (stake escrowed in pool)
//   win    debit pool → credit user  (1.85× stake)    (stake + 85% profit)
//   draw   debit pool → credit user  (1× stake)       (escrow returned)
//   lose   (nothing — the stake already sits in the pool)
//
// The price path + win/lose/draw verdict are computed SERVER-SIDE by
// services/quantoption-engine.js from a per-position server seed. The seed's
// hash is committed when the position opens and the seed is revealed on
// settlement, so the path is provably fair. The client only displays polled
// prices; it cannot fabricate a win.
//
// Durability: open positions hold escrowed stakes (real money), so they live in
// Postgres and survive restarts. A keeper (sweepMatured) settles positions whose
// expiry has passed even if the player closed the app, exactly like Easy Trade's
// stale sweeper / Baby Pick's quick-round keeper.
//
// Solvency: the pool is a normal wallet; the ledger's non-negative trigger makes
// it impossible to overdraw. On top of that, openPosition() enforces the
// EXPOSURE GUARD (pool ≥ 1.85 × all open stakes) so every open position can be
// paid even if they ALL win at once.
// ============================================================================
"use strict";

const crypto = require("crypto");
const { pool, withTransaction } = require("../qntm-ledger/src/db");
const { postTransaction } = require("../qntm-ledger/src/ledger");
const wallets = require("../qntm-ledger/src/wallets");
const decimal = require("../qntm-ledger/src/decimal");
const engine = require("./quantoption-engine");
const priceFeed = require("./quantoption-pricefeed");

// When true, Quant Option settles against REAL market prices (Binance for crypto,
// TwelveData for FX/metals) using true barrier/touch detection in
// services/quantoption-pricefeed.js. When false (default), the provably-fair
// simulated engine is used unchanged — zero behavior change.
const REAL_PRICES = process.env.QUANTOPTION_REAL_PRICES === "true";

const MIN_STAKE = 10;
const MAX_STAKE = 1000000;
const STEP_MS = 220;                 // price-walk tick; matches the v1 feel
const PAYOUT_MULT = "1.85";          // display only (engine is the source of truth)
const MATURE_GRACE_MS = 1500;        // keeper waits this past expiry before settling
const POOL_OWNER = ["platform", "quantoption", "reward_pool"]; // dedicated pool wallet, distinct from the singleton reward_pool (owner_id NULL)

// expiries offered, in seconds
const EXPIRIES = [30, 60, 120, 180, 300, 600, 900];

// tradeable symbols. `base` seeds the ambient price; `vol` is the per-step walk
// sigma (also scales target/stop distance); `dp` is display decimals.
const SYMBOLS = [
  { symbol: "BTCUSDT", label: "BTC/USDT", base: 64000,   vol: 0.0016, dp: 1 },
  { symbol: "ETHUSDT", label: "ETH/USDT", base: 3200,    vol: 0.0018, dp: 2 },
  { symbol: "SOLUSDT", label: "SOL/USDT", base: 150,     vol: 0.0024, dp: 3 },
  { symbol: "BNBUSDT", label: "BNB/USDT", base: 580,     vol: 0.0020, dp: 2 },
  { symbol: "XAUUSD",  label: "XAU/USD",  base: 2330,    vol: 0.0009, dp: 2 },
  { symbol: "EURUSD",  label: "EUR/USD",  base: 1.0850,  vol: 0.0006, dp: 5 },
  { symbol: "GBPUSD",  label: "GBP/USD",  base: 1.2700,  vol: 0.0007, dp: 5 },
];
const SYM = {};
for (const s of SYMBOLS) SYM[s.symbol] = Object.assign({}, s, { wave: engine.deriveWave(s.symbol) });

let _ready = null;
let _poolWalletId = null;

// REAL-mode symbol-strip price state. The picker tiles show real spot prices in
// real mode; to keep the TwelveData free tier (8 req/min) safe we (a) cache the
// whole strip for a few seconds and (b) remember each symbol's last real spot so
// a momentarily rate-limited FX/metal tile holds its last real price instead of
// flickering back to the simulated curve.
const STRIP_TTL_MS = 4000;
let _stripCache = { at: 0, data: null };
const _lastRealSpot = new Map(); // SYMBOL -> last good real spot (Number)

async function init() {
  if (_ready) return _ready;
  _ready = (async () => {
    await ensureSchema();
    const w = await wallets.getOrCreateWallet(POOL_OWNER[0], POOL_OWNER[1], POOL_OWNER[2], "QNTM");
    _poolWalletId = w.id;
  })().catch((e) => { _ready = null; throw e; });
  return _ready;
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quantoption_positions (
      id          BIGSERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      symbol      TEXT NOT NULL,
      direction   TEXT NOT NULL,                 -- long | short
      stake       NUMERIC NOT NULL,
      entry_price NUMERIC NOT NULL,
      target_price NUMERIC NOT NULL,
      stop_price  NUMERIC NOT NULL,
      expiry_sec  INT NOT NULL,
      vol         NUMERIC NOT NULL,
      step_ms     INT NOT NULL,
      server_seed TEXT NOT NULL,
      seed_hash   TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'open',   -- open | won | lost | draw | void
      exit_price  NUMERIC,
      payout      NUMERIC NOT NULL DEFAULT 0,
      stake_txn   TEXT,
      payout_txn  TEXT,
      opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      settled_at  TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS qo_pos_user ON quantoption_positions(user_id, status, id DESC);
    CREATE INDEX IF NOT EXISTS qo_pos_open ON quantoption_positions(status, expires_at) WHERE status = 'open';
    ALTER TABLE quantoption_positions ADD COLUMN IF NOT EXISTS void_on_timeout BOOLEAN NOT NULL DEFAULT false;
  `);
  // Signal-bound positions (real God Mode trades) live in their OWN table so the
  // simulated-engine queries in this file never touch a seedless signal row. The
  // pool is shared (same wallet), so exposureOk() below counts BOTH tables.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quantoption_signal_positions (
      id             BIGSERIAL PRIMARY KEY,
      user_id        TEXT NOT NULL,
      signal_ext_id  TEXT NOT NULL,
      symbol         TEXT NOT NULL,
      direction      TEXT NOT NULL,
      stake          NUMERIC NOT NULL,
      entry_price    NUMERIC,
      target_price   NUMERIC,
      stop_price     NUMERIC,
      tier           INT NOT NULL DEFAULT 1,
      time_limit_sec INT,
      status         TEXT NOT NULL DEFAULT 'open',
      outcome        TEXT,
      exit_price     NUMERIC,
      payout         NUMERIC NOT NULL DEFAULT 0,
      stake_txn      TEXT,
      payout_txn     TEXT,
      opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at     TIMESTAMPTZ,
      settled_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS qo_sigpos_user ON quantoption_signal_positions(user_id, status, id DESC);
    CREATE INDEX IF NOT EXISTS qo_sigpos_bind ON quantoption_signal_positions(signal_ext_id, status);
    CREATE INDEX IF NOT EXISTS qo_sigpos_exp ON quantoption_signal_positions(status, expires_at) WHERE status = 'open';
  `);
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function poolBalance(client = pool) {
  const w = await wallets.getWallet(_poolWalletId, client);
  return w.available_balance;
}
async function userWalletId(userId, client = pool) {
  const w = await wallets.getOrCreateWallet("user", userId, "personal", "QNTM", client);
  return w.id;
}
function symCfg(symbol) { return SYM[symbol] || null; }
function ambientPrice(symbol, atMs) {
  const c = symCfg(symbol); if (!c) return null;
  return engine.clockPrice(c.base, c.wave, atMs == null ? Date.now() : atMs);
}
function roundPx(symbol, price) {
  const c = symCfg(symbol); const dp = c ? c.dp : 2;
  return Number(price).toFixed(dp);
}

// public symbol descriptors for the client (base + wave so it can animate the
// pre-trade chart locally, plus a price snapshot). SIMULATED mode = ambient clock
// price (as before). REAL mode = real spot from the feed with graceful fallback
// (last-known real spot -> ambient) so a tile is never blank and an FX/metal
// symbol rate-limited by TwelveData holds its last real price rather than
// dropping back to the simulated curve. `real` flags which.
function ambientStrip() {
  const now = Date.now();
  return SYMBOLS.map((s) => ({
    symbol: s.symbol, label: s.label, base: s.base, dp: s.dp, vol: s.vol, stepMs: STEP_MS,
    price: roundPx(s.symbol, ambientPrice(s.symbol, now)),
    wave: SYM[s.symbol].wave,
  }));
}
async function symbolList() {
  if (!REAL_PRICES) return ambientStrip();
  const now = Date.now();
  if (_stripCache.data && (now - _stripCache.at) < STRIP_TTL_MS) return _stripCache.data;
  const spots = await Promise.all(SYMBOLS.map(async (s) => {
    try {
      const maxAgeMs = priceFeed.providerFor(s.symbol) === "twelvedata" ? 45000 : 4000;
      const p = await priceFeed.getSpot(s.symbol, { maxAgeMs });
      if (Number.isFinite(p) && p > 0) { _lastRealSpot.set(s.symbol, p); return { real: true, p }; }
    } catch (e) { /* fall through to last-known / ambient */ }
    if (_lastRealSpot.has(s.symbol)) return { real: true, p: _lastRealSpot.get(s.symbol) };
    return { real: false, p: ambientPrice(s.symbol, now) };
  }));
  const data = SYMBOLS.map((s, i) => ({
    symbol: s.symbol, label: s.label, base: s.base, dp: s.dp, vol: s.vol, stepMs: STEP_MS,
    price: roundPx(s.symbol, spots[i].p), real: spots[i].real,
    wave: SYM[s.symbol].wave,
  }));
  _stripCache = { at: now, data };
  return data;
}

// lightweight payload for the client's real-mode strip poller: just the symbol
// list (real spots). Much cheaper than /me, which also re-evaluates positions.
async function prices() {
  await init();
  return { realPrices: REAL_PRICES, symbols: await symbolList() };
}

// ── snapshot for the section header: wallet + pool + open position + config ──
async function me(userId) {
  await init();
  const w = await wallets.getOrCreateWallet("user", userId, "personal", "QNTM"); // same wallet as /api/qntm/wallets/me
  const balance = w.available_balance;
  const poolBal = await poolBalance();
  // evaluate (and settle if matured) ALL open positions, newest first
  const { rows: openRows } = await pool.query(
    `SELECT * FROM quantoption_positions WHERE user_id=$1 AND status='open' ORDER BY id DESC`, [String(userId)]);
  const evaluated = [];
  for (const r of openRows) evaluated.push(await liveView(r, userId));
  const stillOpen = evaluated.filter((p) => p.status === "open"); // a matured one may have settled
  return {
    balance, pool: poolBal, min: MIN_STAKE, max: MAX_STAKE,
    payoutBps: engine.PAYOUT_BPS, payoutMult: PAYOUT_MULT, stepMs: STEP_MS,
    expiries: EXPIRIES, symbols: await symbolList(),
    realPrices: REAL_PRICES,
    open: stillOpen[0] || null,        // newest open (backward-compatible single)
    openPositions: stillOpen,          // full list (real mode can stack positions)
  };
}

// ── EXPOSURE GUARD — pool must hold 1.85 × all open stakes ───────────────────
async function exposureOk(client, addStake) {
  const { rows } = await client.query(
    `SELECT (COALESCE((SELECT SUM(stake) FROM quantoption_positions WHERE status='open'),0)
           + COALESCE((SELECT SUM(stake) FROM quantoption_signal_positions WHERE status='open'),0)) AS s`);
  const totalAfter = decimal.add(rows[0].s, addStake);          // S + s
  const required = engine.requiredPool(totalAfter);             // 1.85 · (S + s)
  const haveAfter = decimal.add(await poolBalance(client), addStake); // pool gains +s on open
  return decimal.cmp(haveAfter, required) >= 0;
}

// ── open a position: validate → atomic (insert + debit stake → pool) ─────────
async function openPosition(userId, input) {
  await init();
  input = input || {};
  const cfg = symCfg(String(input.symbol || ""));
  if (!cfg) { const e = new Error("unknown symbol"); e.code = "bad_symbol"; throw e; }
  const dir = String(input.direction || input.dir || "").toLowerCase();
  if (dir !== "long" && dir !== "short") { const e = new Error("direction must be long or short"); e.code = "bad_dir"; throw e; }
  const expirySec = Math.floor(Number(input.expirySec || input.expiry));
  if (EXPIRIES.indexOf(expirySec) < 0) { const e = new Error("invalid expiry"); e.code = "bad_expiry"; throw e; }
  const stakeNum = Math.floor(Number(input.stake));
  if (!Number.isFinite(stakeNum) || stakeNum < MIN_STAKE) { const e = new Error("stake below minimum"); e.code = "bad_stake"; throw e; }
  if (stakeNum > MAX_STAKE) { const e = new Error("stake above maximum"); e.code = "bad_stake"; throw e; }
  const stake = String(stakeNum);
  // optional "auto-close time limit": VOID+refund the stake if neither TP nor SL is
  // touched by expiry (instead of the default distance verdict at the deadline).
  const voidOnTimeout = input.voidOnTimeout === true || input.voidOnTimeout === "true";

  // SIMULATED mode keeps one open position per user (simple UX + settlement, like
  // Easy Trade). REAL mode allows stacking concurrent positions, so the guard is
  // skipped — exposureOk() inside the transaction still bounds total risk.
  if (!REAL_PRICES) {
    const { rows: openRows } = await pool.query(
      `SELECT id FROM quantoption_positions WHERE user_id=$1 AND status='open' LIMIT 1`, [String(userId)]);
    if (openRows.length) { const e = new Error("you already have an open position"); e.code = "has_open"; throw e; }
  }

  const now = Date.now();
  // REAL mode stamps the entry from the live feed and FAILS CLOSED if the feed is
  // unavailable (never opens on a guessed price). SIMULATED stamps from the public
  // ambient curve as before. A throwaway seed is still generated below in both
  // modes, so the NOT NULL seed columns need no migration.
  let entry;
  if (REAL_PRICES) {
    try {
      entry = await priceFeed.getSpot(cfg.symbol);
    } catch (e) {
      const err = new Error("Live price unavailable — please try again in a moment");
      err.code = "feed_unavailable"; throw err;
    }
    if (!Number.isFinite(entry) || entry <= 0) {
      const err = new Error("Live price unavailable — please try again in a moment");
      err.code = "feed_unavailable"; throw err;
    }
  } else {
    entry = engine.clockPrice(cfg.base, cfg.wave, now);     // server-stamped entry (on the public ambient curve)
  }
  // levels: use the trader's manual TP/SL when provided (TP becomes the settlement
  // target = TP3; TP1/TP2 are derived for display). Both are required together and
  // must sit on the correct side of the entry for the chosen direction; otherwise
  // auto-generate them from volatility as before.
  let target, stop;
  const mT = (input.target != null && String(input.target).trim() !== "") ? Number(input.target) : null;
  const mS = (input.stop != null && String(input.stop).trim() !== "") ? Number(input.stop) : null;
  if (mT != null || mS != null) {
    if (mT == null || mS == null || !Number.isFinite(mT) || !Number.isFinite(mS) || mT <= 0 || mS <= 0) {
      const e = new Error("Enter both a TP and an SL price"); e.code = "bad_levels"; throw e;
    }
    const okLong = dir === "long" && mT > entry && mS < entry;
    const okShort = dir === "short" && mT < entry && mS > entry;
    if (!okLong && !okShort) {
      const e = new Error(dir === "long"
        ? "For a long, TP must be above and SL below the entry (" + String(entry) + ")"
        : "For a short, TP must be below and SL above the entry (" + String(entry) + ")");
      e.code = "bad_levels"; throw e;
    }
    target = mT; stop = mS;
  } else {
    const offset = engine.offsetFor(entry, cfg.vol, expirySec, STEP_MS);
    target = dir === "long" ? entry + offset : entry - offset;
    stop = dir === "long" ? entry - offset : entry + offset;
  }
  const seedPair = engine.newSeed();
  const expiresAt = new Date(now + expirySec * 1000);

  return withTransaction(async (cx) => {
    if (!(await exposureOk(cx, stake))) { const e = new Error("Quant Option is at capacity — try a smaller stake"); e.code = "capacity"; throw e; }
    const uwId = await userWalletId(userId, cx);
    const { rows: pr } = await cx.query(
      `INSERT INTO quantoption_positions
         (user_id, symbol, direction, stake, entry_price, target_price, stop_price, expiry_sec, vol, step_ms, server_seed, seed_hash, expires_at, void_on_timeout)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [String(userId), cfg.symbol, dir, stake, String(entry), String(target), String(stop),
       expirySec, String(cfg.vol), STEP_MS, seedPair.seed, seedPair.hash, expiresAt, voidOnTimeout]);
    const p = pr[0];
    // debit the user, credit the pool — overdraw throws InsufficientFunds and
    // rolls the whole open back (position insert included).
    const txn = await postTransaction({
      type: "tournament_entry", amount: stake,
      movements: [
        { walletId: uwId, direction: "debit", amount: stake, description: "Quant Option stake" },
        { walletId: _poolWalletId, direction: "credit", amount: stake, description: "Quant Option stake" },
      ],
      initiatorUserId: String(userId),
      reference: { type: "quantoption_position", id: p.id },
      idempotencyKey: "qo:stake:" + p.id,
      metadata: { app: "quantoption", kind: "stake", symbol: cfg.symbol, dir, expirySec },
    }, cx);
    await cx.query(`UPDATE quantoption_positions SET stake_txn=$2 WHERE id=$1`, [p.id, txn.public_id]);
    return positionView({ ...p, stake_txn: txn.public_id }, { now });
  }).catch((err) => {
    if (/insufficient/i.test(err.message) || err.code === "insufficient_funds") {
      const e = new Error("Not enough QNTM in your wallet"); e.code = "insufficient"; throw e;
    }
    throw err;
  });
}

// ── poll a position (settling it if it has resolved) ─────────────────────────
async function getPosition(userId, id) {
  await init();
  const { rows } = await pool.query(`SELECT * FROM quantoption_positions WHERE id=$1 AND user_id=$2`, [id, String(userId)]);
  if (!rows.length) return null;
  return liveView(rows[0], userId);
}

// list ALL open positions for a user (evaluates + settles matured ones). Backs
// GET /api/quantoption/positions and the multi-position client view.
async function listOpenPositions(userId) {
  await init();
  const { rows } = await pool.query(
    `SELECT * FROM quantoption_positions WHERE user_id=$1 AND status='open' ORDER BY id DESC`, [String(userId)]);
  const evaluated = [];
  for (const row of rows) evaluated.push(await liveView(row, userId));
  const positions = evaluated.filter((p) => p.status === "open");
  return { realPrices: REAL_PRICES, count: positions.length, positions };
}

// server-side chart candles, so the TwelveData key never reaches the browser.
// Works for every tradeable symbol with a real feed; crypto may also chart
// browser-direct from Binance. Throws (→ fail()) when no real feed is available.
async function chartData(symbol, opts) {
  await init();
  const cfg = symCfg(String(symbol || ""));
  if (!cfg) { const e = new Error("unknown symbol"); e.code = "bad_symbol"; throw e; }
  if (!priceFeed.isSupported(cfg.symbol)) { const e = new Error("no real feed for " + cfg.symbol); e.code = "feed_unavailable"; throw e; }
  opts = opts || {};
  const limit = Math.min(500, Math.max(10, Math.floor(Number(opts.limit) || 200)));
  const candles = await priceFeed.getCandles(cfg.symbol, { limit });
  return {
    symbol: cfg.symbol, label: cfg.label, dp: cfg.dp,
    provider: priceFeed.providerFor(cfg.symbol),
    candles: candles.map((k) => ({ time: Math.floor(k.t / 1000), open: k.o, high: k.h, low: k.l, close: k.c })),
  };
}

// shared: evaluate an open row; if resolved, settle then re-read; build the view
async function liveView(row, userId) {
  if (row.status !== "open") return positionView(row, { now: Date.now() });
  const now = Date.now();
  if (REAL_PRICES) {
    const rev = await realEvaluate(row, now);
    if (rev.resolved) {
      await resolve(row.id, rev.outcome, rev.exitPrice);
      const { rows: fresh } = await pool.query(`SELECT * FROM quantoption_positions WHERE id=$1`, [row.id]);
      return positionView(fresh[0] || row, { now, realEv: rev });
    }
    return positionView(row, { now, realEv: rev });
  }
  const ev = engine.evaluate(enginePos(row), now);
  if (ev.resolved) {
    await resolve(row.id, ev.outcome, ev.exitPrice);
    const { rows: fresh } = await pool.query(`SELECT * FROM quantoption_positions WHERE id=$1`, [row.id]);
    return positionView(fresh[0] || row, { now, ev });
  }
  return positionView(row, { now, ev });
}

// REAL-PRICE evaluation: pull real candles for the position window and apply the
// locked settlement rules via engine.detectBarrierTouch + engine.expiryOutcome.
// Fail-closed: if the feed can't return data, a MATURED position settles VOID
// (draw/refund); a still-live position simply reports no live price yet.
async function realEvaluate(row, nowMs) {
  const openedMs = new Date(row.opened_at).getTime();
  const expiryMs = new Date(row.expires_at).getTime();
  const windowEnd = Math.min(nowMs, expiryMs);
  const target = Number(row.target_price);
  const stop = Number(row.stop_price);
  const dir = row.direction;

  let candles = null;
  try {
    candles = await priceFeed.getRange(row.symbol, openedMs, windowEnd);
  } catch (e) {
    console.warn("[quantoption] real feed getRange failed for #" + row.id + ":", e.message);
    candles = null;
  }

  // rule 4 — no reliable data at settlement
  if (!candles || candles.length === 0) {
    if (nowMs >= expiryMs) {
      return { resolved: true, outcome: "draw", livePrice: Number(row.entry_price), exitPrice: Number(row.entry_price), reason: "no_data_void" };
    }
    return { resolved: false, outcome: null, livePrice: null, reason: "no_data_live" };
  }

  const livePrice = Number(candles[candles.length - 1].c);

  // rules 1 & 2 — barrier touch (incl. same-candle ambiguity → VOID)
  const touch = engine.detectBarrierTouch(dir, candles, target, stop);
  if (touch) {
    return { resolved: true, outcome: touch.outcome, livePrice, exitPrice: touch.exitPrice,
             ambiguous: !!touch.ambiguous, reason: touch.ambiguous ? "void_same_candle" : "barrier" };
  }

  // rule 3 — reached expiry with no touch → distance verdict
  if (nowMs >= expiryMs) {
    const outcome = row.void_on_timeout ? "void" : engine.expiryOutcome(livePrice, target, stop);
    return { resolved: true, outcome, livePrice, exitPrice: livePrice,
             reason: row.void_on_timeout ? "expiry_void" : "expiry_distance" };
  }

  // still live, no touch yet
  return { resolved: false, outcome: null, livePrice, reason: "live" };
}

// map a DB row to the engine's position shape
function enginePos(row) {
  return {
    dir: row.direction, entry: Number(row.entry_price), target: Number(row.target_price),
    stop: Number(row.stop_price), vol: Number(row.vol), stepMs: Number(row.step_ms),
    expirySec: Number(row.expiry_sec), seed: row.server_seed,
    openedMs: new Date(row.opened_at).getTime(),
    voidOnTimeout: !!row.void_on_timeout,
  };
}

// ── settle a resolved position (idempotent) ──────────────────────────────────
async function resolve(positionId, outcome, exitPrice) {
  return withTransaction(async (cx) => {
    const { rows } = await cx.query(`SELECT * FROM quantoption_positions WHERE id=$1 FOR UPDATE`, [positionId]);
    if (!rows.length) return { ok: false, reason: "no_position" };
    const p = rows[0];
    if (p.status !== "open") return { ok: true, already: true };

    const status = outcome === "win" ? "won" : outcome === "draw" ? "draw" : outcome === "void" ? "void" : "lost";
    const amt = engine.settleAmounts(outcome, p.stake);
    let payoutTxnId = null;

    if (decimal.isPositive(amt.credit)) {
      // win → 1.85× ; draw → 1× : pool pays the user
      const isWin = outcome === "win";
      const isVoid = outcome === "void";
      const refundDesc = isVoid ? "Quant Option void refund" : "Quant Option draw refund";
      const txn = await postTransaction({
        type: isWin ? "tournament_prize" : "refund", amount: amt.credit,
        movements: [
          { walletId: _poolWalletId, direction: "debit", amount: amt.credit, description: isWin ? "Quant Option win" : refundDesc },
          { walletId: await userWalletId(p.user_id, cx), direction: "credit", amount: amt.credit, description: isWin ? "Quant Option win" : refundDesc },
        ],
        initiatorUserId: p.user_id,
        reference: { type: "quantoption_position", id: p.id },
        idempotencyKey: (isWin ? "qo:payout:" : "qo:refund:") + p.id,
        metadata: { app: "quantoption", kind: isWin ? "payout" : (isVoid ? "void" : "draw"), outcome },
      }, cx);
      payoutTxnId = txn.public_id;
    }

    await cx.query(
      `UPDATE quantoption_positions
         SET status=$2, exit_price=$3, payout=$4, payout_txn=$5, settled_at=now()
       WHERE id=$1`,
      [p.id, status, exitPrice != null ? String(exitPrice) : null, amt.credit, payoutTxnId]);
    return { ok: true, outcome, status, credit: amt.credit };
  });
}

// ── early cash-out: settle an OPEN position NOW at the live price ─────────────
// Pool-funded amount = engine.cashoutMultiplier()*stake (stop 0x -> entry 1.0x ->
// target 1.85x, clamped). Solvency-safe: credit <= 1.85*stake, the ceiling the
// exposure guard reserved at open. Status maps by result so lifetime stats stay
// coherent: profit -> won, break-even -> draw, loss -> lost (metadata.kind tags it).
async function cashOut(userId, id) {
  await init();
  return withTransaction(async (cx) => {
    const { rows } = await cx.query(`SELECT * FROM quantoption_positions WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, String(userId)]);
    if (!rows.length) { const e = new Error("position not found"); e.code = "not_found"; throw e; }
    const p = rows[0];
    if (p.status !== "open") { const e = new Error("position already settled"); e.code = "not_open"; throw e; }
    let live = REAL_PRICES ? await priceFeed.getSpot(p.symbol).catch(() => null) : ambientPrice(p.symbol);
    if (!Number.isFinite(Number(live))) { const e = new Error("Live price unavailable — try again in a moment"); e.code = "feed_unavailable"; throw e; }
    live = Number(live);
    const m = engine.cashoutMultiplier(p.entry_price, p.target_price, p.stop_price, live);
    if (m == null) { const e = new Error("Live price unavailable — try again in a moment"); e.code = "feed_unavailable"; throw e; }
    const credit = engine.cashoutCredit(p.stake, m);
    const c = decimal.cmp(credit, String(p.stake));
    const status = c > 0 ? "won" : c === 0 ? "draw" : "lost";
    let payoutTxnId = null;
    if (decimal.isPositive(credit)) {
      const txn = await postTransaction({
        type: "refund", amount: credit,
        movements: [
          { walletId: _poolWalletId, direction: "debit", amount: credit, description: "Quant Option cash-out" },
          { walletId: await userWalletId(p.user_id, cx), direction: "credit", amount: credit, description: "Quant Option cash-out" },
        ],
        initiatorUserId: p.user_id,
        reference: { type: "quantoption_position", id: p.id },
        idempotencyKey: "qo:cashout:" + p.id,
        metadata: { app: "quantoption", kind: "cashout", multiplierBps: Math.round(m * 10000) },
      }, cx);
      payoutTxnId = txn.public_id;
    }
    await cx.query(
      `UPDATE quantoption_positions SET status=$2, exit_price=$3, payout=$4, payout_txn=$5, settled_at=now() WHERE id=$1`,
      [p.id, status, String(live), credit, payoutTxnId]);
    const view = positionView({ ...p, status, exit_price: String(live), payout: credit, payout_txn: payoutTxnId, settled_at: new Date().toISOString() }, { now: Date.now() });
    view.cashedOut = true; view.cashoutMult = m;
    return view;
  });
}

// ── keeper: settle positions whose expiry has passed (app-closed backstop) ──
async function sweepMatured(limitInput) {
  await init();
  const limit = Math.min(500, Math.max(1, Math.floor(Number(limitInput) || 200)));
  const { rows } = await pool.query(
    `SELECT * FROM quantoption_positions
       WHERE status='open' AND expires_at < now() - ($1 * INTERVAL '1 millisecond')
       ORDER BY id LIMIT $2`, [MATURE_GRACE_MS, limit]);
  let settled = 0;
  for (const row of rows) {
    try {
      let outcome, exit;
      if (REAL_PRICES) {
        const rev = await realEvaluate(row, Date.now());
        if (rev.resolved) { outcome = rev.outcome; exit = rev.exitPrice; }
        else { outcome = "draw"; exit = Number(row.entry_price); } // matured + unresolved → fail-closed VOID
      } else {
        const ev = engine.evaluate(enginePos(row), Date.now());
        // matured rows always resolve (now >= expiry), but guard anyway
        outcome = ev.resolved ? ev.outcome : engine.expiryOutcome(ev.livePrice, Number(row.target_price), Number(row.stop_price));
        exit = ev.exitPrice != null ? ev.exitPrice : ev.livePrice;
      }
      const r = await resolve(row.id, outcome, exit);
      if (r && r.ok && !r.already) settled++;
    } catch (e) { console.warn("[quantoption] settle failed for #" + row.id + ":", e.message); }
  }
  return { swept: rows.length, settled };
}

// ── a user's history + lifetime P/L summary ─────────────────────────────────
async function history(userId, limitInput, offsetInput) {
  await init();
  const limit = Math.min(100, Math.max(1, Math.floor(Number(limitInput) || 30)));
  const offset = Math.max(0, Math.floor(Number(offsetInput) || 0));
  const { rows } = await pool.query(
    `SELECT * FROM quantoption_positions WHERE user_id=$1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
    [String(userId), limit, offset]);
  const { rows: agg } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('won','lost','draw','void')) AS settled,
            COUNT(*) FILTER (WHERE status='won')   AS won,
            COUNT(*) FILTER (WHERE status='lost')  AS lost,
            COUNT(*) FILTER (WHERE status='draw')  AS draw,
            COUNT(*) FILTER (WHERE status='void')  AS voided,
            COUNT(*) FILTER (WHERE status='open')  AS open,
            COALESCE(SUM(stake)  FILTER (WHERE status IN ('won','lost','draw','void')),0) AS staked,
            COALESCE(SUM(payout) FILTER (WHERE status IN ('won','draw','void')),0)        AS paid
       FROM quantoption_positions WHERE user_id=$1`, [String(userId)]);
  const a = agg[0] || {};
  const settled = Number(a.settled || 0), won = Number(a.won || 0), lost = Number(a.lost || 0);
  return {
    items: rows.map((r) => positionView(r, { brief: true })),
    summary: {
      settled, won, lost, draw: Number(a.draw || 0), voided: Number(a.voided || 0), open: Number(a.open || 0),
      winRate: (won + lost) ? Math.round((won / (won + lost)) * 100) : null,
      staked: a.staked || "0", paid: a.paid || "0",
      net: decimal.sub(a.paid || "0", a.staked || "0"),
    },
    limit, offset, count: rows.length,
  };
}

// ── admin: fund the pool from treasury ──────────────────────────────────────
async function fundPool(amount, actorId) {
  await init();
  if (!decimal.isPositive(String(amount))) { const e = new Error("amount must be positive"); e.code = "bad_amount"; throw e; }
  const treasuryId = await wallets.systemWalletId("treasury", "QNTM");
  const txn = await postTransaction({
    type: "transfer", amount: String(amount),
    movements: [
      { walletId: treasuryId, direction: "debit", amount: String(amount), description: "fund Quant Option pool" },
      { walletId: _poolWalletId, direction: "credit", amount: String(amount), description: "Quant Option pool top-up" },
    ],
    initiatorUserId: actorId ? String(actorId) : null, allowFrozen: true,
    reference: { type: "quantoption_pool" },
  });
  return { funded: String(amount), pool: await poolBalance(), txn: txn.public_id };
}

// ── keeper: keep the pool topped up to a floor (treasury → pool) ────────────
// Transfers ONLY the shortfall to reach `target`; no-op at/above target; skips
// (logs) if the treasury can't cover it. Mirrors easytrade.topUpPool exactly.
async function topUpPool(targetInput, actorId) {
  await init();
  const target = String(Math.floor(Number(targetInput) || 0));
  if (!decimal.isPositive(target)) return { topped: false, reason: "no_target", pool: await poolBalance() };
  const have = await poolBalance();
  if (decimal.cmp(have, target) >= 0) return { topped: false, pool: have, target };
  const shortfall = decimal.sub(target, have);
  const treasuryId = await wallets.systemWalletId("treasury", "QNTM");
  const treasuryBal = (await wallets.getWallet(treasuryId)).available_balance;
  if (decimal.cmp(treasuryBal, shortfall) < 0) {
    console.warn("[quantoption] pool top-up skipped: treasury has " + treasuryBal + ", need " + shortfall + " to reach " + target);
    return { topped: false, reason: "treasury_short", pool: have, target, shortfall, treasury: treasuryBal };
  }
  try {
    const txn = await postTransaction({
      type: "transfer", amount: shortfall,
      movements: [
        { walletId: treasuryId, direction: "debit", amount: shortfall, description: "Quant Option pool auto-topup" },
        { walletId: _poolWalletId, direction: "credit", amount: shortfall, description: "Quant Option pool auto-topup" },
      ],
      initiatorUserId: actorId ? String(actorId) : null, allowFrozen: true,
      reference: { type: "quantoption_pool_topup" },
    });
    const after = await poolBalance();
    console.log("[quantoption] pool topped up +" + shortfall + " -> " + after + " (floor " + target + ")");
    return { topped: true, added: shortfall, pool: after, target, txn: txn.public_id };
  } catch (e) {
    if (/insufficient/i.test(e.message) || e.code === "insufficient_funds") {
      console.warn("[quantoption] pool top-up failed (treasury short): needed " + shortfall + " for floor " + target);
      return { topped: false, reason: "treasury_short", pool: have, target, shortfall };
    }
    throw e;
  }
}

// ── admin read helpers ──────────────────────────────────────────────────────
async function poolStats() {
  await init();
  const poolBal = await poolBalance();
  const { rows } = await pool.query(`SELECT COALESCE(SUM(stake),0) AS s, COUNT(*)::int AS n FROM quantoption_positions WHERE status='open'`);
  const exposure = rows[0].s; const openPositions = rows[0].n;
  const headroom = decimal.sub(poolBal, engine.requiredPool(exposure)); // pool − 1.85·exposure
  const { rows: won } = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(payout),0) AS paid FROM quantoption_positions WHERE status='won'`);
  return { pool: poolBal, exposure, openPositions, headroom, wins: won[0].n, totalPaid: won[0].paid,
    payoutBps: engine.PAYOUT_BPS, payoutMult: PAYOUT_MULT, min: MIN_STAKE, max: MAX_STAKE };
}

// ── LEADERBOARD — ranked from settled positions (mirrors Easy Trade) ────────
//   wins      = COUNT(status='won')
//   winRate   = wins / (won + lost)   (draws excluded; ≥5 settled for the rate board)
//   tokensWon = SUM(payout) over won positions
//   xp        = wins*20 + losses*5 + floor(totalStaked/100)
async function leaderboard(opts) {
  await init();
  opts = opts || {};
  const sort = ["xp", "winrate", "wins", "tokens"].includes(opts.sort) ? opts.sort : "xp";
  const limit = Math.min(500, Math.max(1, Math.floor(Number(opts.limit) || 100)));
  const minSettled = sort === "winrate" ? 5 : 1;
  const viewerId = (opts.viewerId != null && Number.isFinite(Number(opts.viewerId))) ? Math.floor(Number(opts.viewerId)) : null;

  const orderBy = {
    xp:      "xp DESC, wins DESC, tokens_won DESC",
    winrate: "win_rate DESC, settled DESC, wins DESC",
    wins:    "wins DESC, win_rate DESC, tokens_won DESC",
    tokens:  "tokens_won DESC, wins DESC, win_rate DESC",
  }[sort];

  const AGG = `
    SELECT qp.user_id,
      COUNT(*) FILTER (WHERE qp.status='won')               AS wins,
      COUNT(*) FILTER (WHERE qp.status='lost')              AS losses,
      COUNT(*) FILTER (WHERE qp.status IN ('won','lost'))   AS rated,
      COUNT(*) FILTER (WHERE qp.status IN ('won','lost','draw')) AS settled,
      COALESCE(SUM(qp.payout) FILTER (WHERE qp.status='won'),0)              AS tokens_won,
      COALESCE(SUM(qp.stake)  FILTER (WHERE qp.status IN ('won','lost','draw')),0) AS staked,
      MAX(qp.settled_at) AS last_played
    FROM quantoption_positions qp`;
  const DECOR = `
    a.user_id, a.wins, a.losses, a.rated, a.settled, a.tokens_won, a.staked, a.last_played,
    (a.wins*20 + a.losses*5 + floor(a.staked/100))::bigint AS xp,
    CASE WHEN a.rated>0 THEN round((a.wins::numeric / a.rated) * 100) ELSE 0 END AS win_rate,
    (a.tokens_won - a.staked) AS net`;

  const { rows } = await pool.query(
    `WITH agg AS (${AGG} GROUP BY qp.user_id)
     SELECT ${DECOR}, u.name, u.username, u.avatar
       FROM agg a LEFT JOIN users u ON u.id::text = a.user_id
      WHERE a.settled >= ${minSettled}
      ORDER BY ${orderBy}
      LIMIT ${limit}`);

  const view = (r) => ({
    userId: Number(r.user_id), name: r.name || null, username: r.username || null, avatar: r.avatar || null,
    wins: Number(r.wins), losses: Number(r.losses), settled: Number(r.settled),
    tokensWon: Number(r.tokens_won), staked: Number(r.staked), net: Number(r.net),
    xp: Number(r.xp), winRate: Number(r.win_rate), lastPlayed: r.last_played,
  });
  const players = rows.map((r, i) => Object.assign({ rank: i + 1 }, view(r)));

  let meRow = null;
  if (viewerId != null) {
    const { rows: mr } = await pool.query(
      `WITH agg AS (${AGG} WHERE qp.user_id = '${viewerId}' GROUP BY qp.user_id)
       SELECT ${DECOR}, u.name, u.username, u.avatar
         FROM agg a LEFT JOIN users u ON u.id::text = a.user_id`);
    meRow = mr.length ? view(mr[0]) : null;
  }
  return { sort, minSettled, count: players.length, players, me: meRow };
}

// ── shaping ─────────────────────────────────────────────────────────────────
// `extra` may carry { now, ev (engine.evaluate result), brief }.
function positionView(p, extra) {
  extra = extra || {};
  const now = extra.now || Date.now();
  const settled = p.status !== "open";
  const expiresMs = new Date(p.expires_at).getTime();
  const out = {
    id: p.id, symbol: p.symbol, label: (symCfg(p.symbol) || {}).label || p.symbol,
    dir: p.direction, stake: p.stake, status: p.status,
    entry: p.entry_price, target: p.target_price, stop: p.stop_price,
    tp1: roundPx(p.symbol, Number(p.entry_price) + (Number(p.target_price) - Number(p.entry_price)) / 3),
    tp2: roundPx(p.symbol, Number(p.entry_price) + (Number(p.target_price) - Number(p.entry_price)) * 2 / 3),
    tp3: roundPx(p.symbol, Number(p.target_price)),
    expirySec: Number(p.expiry_sec), stepMs: Number(p.step_ms), dp: (symCfg(p.symbol) || {}).dp,
    voidOnTimeout: !!p.void_on_timeout,
    openedAt: p.opened_at, expiresAt: p.expires_at, settledAt: p.settled_at,
    seedHash: p.seed_hash,                                  // commitment (always visible)
    payout: p.payout, exitPrice: p.exit_price,
    potentialWin: decimal.add(p.stake, engine.profitOf(p.stake)),  // 1.85× preview
  };
  if (settled) out.serverSeed = p.server_seed;             // reveal only once settled
  if (extra.brief) return out;
  if (!settled) {
    if (REAL_PRICES) {
      // REAL mode: live price comes from the feed (may be null if momentarily
      // unavailable). The client charts from /api/quantoption/chart, so no
      // synthetic ticks are emitted here.
      const rev = extra.realEv || {};
      const lp = (rev.livePrice != null && Number.isFinite(Number(rev.livePrice))) ? Number(rev.livePrice) : null;
      out.livePrice = lp != null ? roundPx(p.symbol, lp) : null;
      out.livePriceRaw = lp;
      out.countdownMs = Math.max(0, expiresMs - now);
      out.realPrices = true;
      const entryN = Number(p.entry_price), targetN = Number(p.target_price);
      out.progress = (lp != null && targetN !== entryN) ? (lp - entryN) / (targetN - entryN) : 0;
    } else {
      const ev = extra.ev || engine.evaluate(enginePos(p), now);
      out.livePrice = roundPx(p.symbol, ev.livePrice);
      out.livePriceRaw = ev.livePrice;
      out.countdownMs = Math.max(0, expiresMs - now);
      out.ticks = ev.ticks.map((k) => ({ t: k.t, price: Number(roundPx(p.symbol, k.price)) }));
      // indicative progress toward target (1.0 = target, 0 = entry, <0 = toward stop)
      const entryN = Number(p.entry_price), targetN = Number(p.target_price);
      out.progress = targetN === entryN ? 0 : (ev.livePrice - entryN) / (targetN - entryN);
    }
  } else if (extra.ev) {
    out.ticks = extra.ev.ticks.map((k) => ({ t: k.t, price: Number(roundPx(p.symbol, k.price)) }));
  }
  return out;
}

module.exports = {
  init, me, openPosition, getPosition, listOpenPositions, chartData, prices, cashOut,
  resolve, sweepMatured, history,
  fundPool, topUpPool, poolStats, leaderboard,
  MIN_STAKE, MAX_STAKE, EXPIRIES, SYMBOLS, STEP_MS, REAL_PRICES,
};
