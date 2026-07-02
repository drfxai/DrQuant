// services/quantoption-signals.js
// ============================================================================
// Quant Option — SIGNAL trading (real God Mode trades), the second position
// type alongside the simulated "quick" engine in services/quantoption.js.
//
// A signal-bound position takes the SAME side as a live God Mode signal and
// settles on the REAL trade's outcome — win if the trade reaches its first
// target before its stop, lose if the stop hits first — exactly like Easy
// Trade, but surfaced inside Quant Option and openable from a chat signal.
//
// Money model is identical to quick positions and Easy Trade: value moves only
// through the qntm-ledger, escrowed into the SAME shared Quant Option pool
// wallet, with the SAME 85% payout. The exposure guard here counts BOTH the
// quick and signal position tables, because they draw from one pool.
//
//   open   debit user → credit pool        (stake escrowed)
//   win    debit pool → credit user 1.85×   (trade hit target first)
//   lose   (nothing — stake stays in pool)  (trade hit stop first)
//   draw   debit pool → credit user 1×      (optional time-limit expired with
//                                            no real outcome → stake refunded)
//
// Signals arrive on the DEDICATED Quant Option webhook (routes/quantoption-
// webhook.js) that the admin pastes into a God Mode TradingView alarm. The
// webhook feeds ingestSignalEvent() with the same {signal_id,event,symbol,
// direction,entry,sl,tp1,tp2,tp3,price,result,tf} shape Easy Trade uses.
//
// This module is intentionally self-contained (its own ledger wiring, its own
// pool-wallet handle by the same owner identity) so a fault here can never take
// down the simulated engine or app boot — it is required behind try/catch.
// ============================================================================
"use strict";

const { pool, withTransaction } = require("../qntm-ledger/src/db");
const { postTransaction } = require("../qntm-ledger/src/ledger");
const wallets = require("../qntm-ledger/src/wallets");
const decimal = require("../qntm-ledger/src/decimal");
const engine = require("./quantoption-engine"); // pure money math only (profitOf/settleAmounts/requiredPool)
const priceFeed = require("./quantoption-pricefeed"); // real spot for early cash-out

const MIN_STAKE = 10;
const MAX_STAKE = 1000000;
const POOL_OWNER = ["platform", "quantoption", "reward_pool"]; // SAME pool wallet as services/quantoption.js
const DEFAULT_TIER = 3;                 // win = trade reaches its FINAL target (tp3) before sl
const MIN_TIME_LIMIT = 30;              // seconds, if a time limit is chosen
const MAX_TIME_LIMIT = 86400;           // 24h ceiling on the optional auto-close

let _ready = null;
let _poolWalletId = null;

async function init() {
  if (_ready) return _ready;
  _ready = (async () => {
    await ensureSchema();
    const w = await wallets.getOrCreateWallet(POOL_OWNER[0], POOL_OWNER[1], POOL_OWNER[2], "QNTM");
    _poolWalletId = w.id;
  })().catch((e) => { _ready = null; throw e; });
  return _ready;
}

// Both tables are also ensured by services/quantoption.js; CREATE ... IF NOT
// EXISTS makes running them here idempotent and order-independent.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quantoption_signals (
      id          BIGSERIAL PRIMARY KEY,
      ext_id      TEXT,
      symbol      TEXT,
      direction   TEXT,
      entry       NUMERIC,
      sl          NUMERIC,
      tp1         NUMERIC,
      tp2         NUMERIC,
      tp3         NUMERIC,
      tf          TEXT,
      status      TEXT NOT NULL DEFAULT 'live',  -- live | won | lost | closed | void
      max_tp      INT  NOT NULL DEFAULT 0,
      last_price  NUMERIC,
      result      TEXT,
      channel_id  BIGINT,
      message_id  BIGINT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      settled_at  TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS qo_signals_ext ON quantoption_signals(ext_id) WHERE ext_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS qo_signals_live ON quantoption_signals(status, id DESC);
  `);
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

// ── helpers ─────────────────────────────────────────────────────────────────
async function poolBalance(client = pool) {
  const w = await wallets.getWallet(_poolWalletId, client);
  return w.available_balance;
}
async function userWalletId(userId, client = pool) {
  const w = await wallets.getOrCreateWallet("user", userId, "personal", "QNTM", client);
  return w.id;
}
// Pool must hold 1.85 × ALL open stakes across BOTH position tables (one pool).
async function exposureOk(client, addStake) {
  const { rows } = await client.query(
    `SELECT (COALESCE((SELECT SUM(stake) FROM quantoption_positions WHERE status='open'),0)
           + COALESCE((SELECT SUM(stake) FROM quantoption_signal_positions WHERE status='open'),0)) AS s`);
  const totalAfter = decimal.add(rows[0].s, addStake);
  const required = engine.requiredPool(totalAfter);
  const haveAfter = decimal.add(await poolBalance(client), addStake);
  return decimal.cmp(haveAfter, required) >= 0;
}

function num(v) { if (v == null || v === "" || v === "null") return null; const n = Number(v); return Number.isFinite(n) ? String(n) : null; }
function dir(v) { v = String(v || "").toLowerCase(); return (v === "long" || v === "buy") ? "long" : (v === "short" || v === "sell") ? "short" : null; }

// ── signal validity against the LIVE price ──────────────────────────────────
// A God Mode signal is tradeable only while price is still inside the usable
// zone: it must NOT have reached the 2nd target (tp2, or tp3 if tp2 is absent)
// and must NOT have reached the stop (sl). Direction-aware. Returns a reason so
// callers can log/mark WHY a signal was invalidated.
//   long : dead if price >= 2nd-target (target reached) OR price <= sl (stopped)
//   short: dead if price <= 2nd-target (target reached) OR price >= sl (stopped)
function secondTarget(sig) {
  const tp2 = sig.tp2 != null ? Number(sig.tp2) : null;
  const tp3 = sig.tp3 != null ? Number(sig.tp3) : null;
  return tp2 != null ? tp2 : tp3; // fall back to final target when tp2 absent
}
function signalValidity(sig, livePrice) {
  if (!sig || sig.status !== "live") return { valid: false, reason: "not_live" };
  if (sig.entry == null || sig.sl == null || !sig.direction) return { valid: false, reason: "incomplete" };
  const lp = Number(livePrice);
  if (!Number.isFinite(lp)) return { valid: true, reason: "no_price" }; // can't disprove → allow (fail-open only for validity gating; open path re-checks with a real feed)
  const sl = Number(sig.sl);
  const t2 = secondTarget(sig);
  if (sig.direction === "long") {
    if (lp <= sl) return { valid: false, reason: "stopped" };
    if (t2 != null && lp >= t2) return { valid: false, reason: "target_reached" };
  } else {
    if (lp >= sl) return { valid: false, reason: "stopped" };
    if (t2 != null && lp <= t2) return { valid: false, reason: "target_reached" };
  }
  return { valid: true, reason: "ok" };
}
function normEvent(e) {
  e = String(e || "").toLowerCase().trim();
  if (e === "entry" || e === "open" || e === "filled") return "entry";
  if (/^tp\s*1$|^t1$|^target1$/.test(e)) return "tp1";
  if (/^tp\s*2$|^t2$|^target2$/.test(e)) return "tp2";
  if (/^tp\s*3$|^t3$|^target3$|^target$/.test(e)) return "tp3";
  if (/^sl$|^stop$|^stoploss$|^stop_loss$/.test(e)) return "sl";
  if (/^close$|^exit$|^cancel$|^invalidate$|^invalidated$/.test(e)) return "close";
  if (/^price$|^tick$/.test(e)) return "price";
  return null;
}

// ── webhook intake: drive the signal store + settle bound positions ─────────
// Resolve the authoritative live price for validity checks: prefer the real feed
// (Binance/TwelveData), fall back to the signal's last webhook price.
async function livePriceFor(sig) {
  let lp = await priceFeed.getSpot(sig.symbol).catch(() => null);
  if (!(Number.isFinite(Number(lp)) && Number(lp) > 0)) lp = (sig.last_price != null ? Number(sig.last_price) : null);
  return (Number.isFinite(Number(lp)) && Number(lp) > 0) ? Number(lp) : null;
}

// Mark a live signal as invalidated by price (removed from the tradeable list).
// Uses status 'closed' so it leaves the live feed but is distinct from won/lost.
async function invalidateSignal(sig, livePrice, reason) {
  await pool.query(
    `UPDATE quantoption_signals SET status='closed', last_price=COALESCE($2,last_price), settled_at=now()
       WHERE id=$1 AND status='live'`, [sig.id, livePrice != null ? String(livePrice) : null]);
  return { invalidated: true, reason };
}

// payload: { signal_id, event, symbol, direction, entry, sl, tp1, tp2, tp3, price, result, tf }
async function ingestSignalEvent(payload) {
  await init();
  const ev = normEvent(payload && payload.event);
  if (!ev) return { ok: false, reason: "unknown_event" };
  const extId = (payload && payload.signal_id != null) ? String(payload.signal_id) : null;
  if (!extId) return { ok: false, reason: "no_signal_id" };

  if (ev === "entry") return upsertSignalEntry(extId, payload);

  // progress/terminal event for an existing signal
  const { rows } = await pool.query(`SELECT * FROM quantoption_signals WHERE ext_id=$1`, [extId]);
  const signal = rows[0];
  if (!signal) return { ok: false, reason: "no_signal" };

  if (num(payload.price) != null) await pool.query(`UPDATE quantoption_signals SET last_price=$2 WHERE id=$1`, [signal.id, num(payload.price)]);
  if (ev === "tp1" || ev === "tp2" || ev === "tp3") {
    const n = Number(ev.slice(2));
    await pool.query(`UPDATE quantoption_signals SET max_tp=GREATEST(max_tp,$2) WHERE id=$1`, [signal.id, n]);
  }
  if (ev === "price") return { ok: true, signal: signal.id, event: ev };

  const terminal = ev === "sl" || ev === "close" || ev === "tp3";
  if (!terminal) return { ok: true, signal: signal.id, event: ev };

  // verdict (tier-1 semantics): trust the indicator's declared result, else the
  // terminal event, else whether at least the first target was reached.
  const result = payload.result ? String(payload.result).toLowerCase() : null;
  const maxTp = Math.max(Number(signal.max_tp || 0), ev === "tp3" ? 3 : 0);
  let outcome;
  if (result === "win") outcome = "win";
  else if (result === "loss" || result === "lose") outcome = "lose";
  else if (ev === "tp3") outcome = "win";
  else if (ev === "sl") outcome = "lose";
  else outcome = maxTp >= DEFAULT_TIER ? "win" : "lose"; // close
  return settleSignal(extId, outcome, num(payload.price));
}

async function upsertSignalEntry(extId, p) {
  const d = dir(p.direction);
  const { rows } = await pool.query(
    `INSERT INTO quantoption_signals (ext_id, symbol, direction, entry, sl, tp1, tp2, tp3, tf, status, last_price)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'live',$4)
     ON CONFLICT (ext_id) WHERE ext_id IS NOT NULL
       DO UPDATE SET symbol=EXCLUDED.symbol, direction=EXCLUDED.direction, entry=EXCLUDED.entry,
                     sl=EXCLUDED.sl, tp1=EXCLUDED.tp1, tp2=EXCLUDED.tp2, tp3=EXCLUDED.tp3, tf=EXCLUDED.tf,
                     status='live', max_tp=0, result=NULL, settled_at=NULL
     RETURNING *`,
    [extId, p.symbol ? String(p.symbol).toUpperCase().slice(0, 32) : null, d,
     num(p.entry), num(p.sl), num(p.tp1), num(p.tp2), num(p.tp3),
     p.tf ? String(p.tf).slice(0, 16) : null]);
  return { ok: true, signal: rows[0] ? rows[0].id : null, ext_id: extId, entry: true };
}

// terminal settlement: mark the signal and pay out every bound open position
async function settleSignal(extId, outcome, lastPrice) {
  return withTransaction(async (cx) => {
    const { rows } = await cx.query(`SELECT * FROM quantoption_signals WHERE ext_id=$1 FOR UPDATE`, [extId]);
    const signal = rows[0];
    if (!signal) return { ok: false, reason: "no_signal" };
    const sigStatus = outcome === "win" ? "won" : "lost";
    if (signal.status !== "won" && signal.status !== "lost") {
      await cx.query(`UPDATE quantoption_signals SET status=$2, result=$3, last_price=COALESCE($4,last_price), settled_at=now() WHERE id=$1`,
        [signal.id, sigStatus, outcome, lastPrice]);
    }
    const { rows: pos } = await cx.query(
      `SELECT * FROM quantoption_signal_positions WHERE signal_ext_id=$1 AND status='open' FOR UPDATE`, [extId]);
    let won = 0, lost = 0;
    for (const p of pos) { const r = await settleOnePosition(cx, p, outcome, lastPrice); if (r === "win") won++; else if (r === "lose") lost++; }
    return { ok: true, signal: signal.id, outcome, won, lost };
  });
}

// settle ONE bound position (within an existing tx). outcome: win | lose | draw
async function settleOnePosition(cx, p, outcome, exitPrice) {
  if (p.status !== "open") return "already";
  const status = outcome === "win" ? "won" : outcome === "draw" ? "draw" : "lost";
  const amt = engine.settleAmounts(outcome, p.stake); // win→1.85×, draw→1×, lose→0
  let payoutTxnId = null;
  if (decimal.isPositive(amt.credit)) {
    const isWin = outcome === "win";
    const txn = await postTransaction({
      type: isWin ? "tournament_prize" : "refund", amount: amt.credit,
      movements: [
        { walletId: _poolWalletId, direction: "debit", amount: amt.credit, description: isWin ? "Quant Option signal win" : "Quant Option signal refund" },
        { walletId: await userWalletId(p.user_id, cx), direction: "credit", amount: amt.credit, description: isWin ? "Quant Option signal win" : "Quant Option signal refund" },
      ],
      initiatorUserId: p.user_id,
      reference: { type: "quantoption_signal_position", id: p.id },
      idempotencyKey: (isWin ? "qo:sigpayout:" : "qo:sigrefund:") + p.id,
      metadata: { app: "quantoption", kind: isWin ? "signal_payout" : "signal_refund", outcome },
    }, cx);
    payoutTxnId = txn.public_id;
  }
  await cx.query(
    `UPDATE quantoption_signal_positions SET status=$2, outcome=$3, exit_price=$4, payout=$5, payout_txn=$6, settled_at=now() WHERE id=$1`,
    [p.id, status, outcome, exitPrice != null ? String(exitPrice) : null, amt.credit, payoutTxnId]);
  return outcome;
}

// ── open a signal-bound position ────────────────────────────────────────────
async function openSignalPosition(userId, input) {
  await init();
  input = input || {};
  const extId = input.extId != null ? String(input.extId)
    : (input.signalExtId != null ? String(input.signalExtId)
    : (input.signalId != null ? String(input.signalId) : null));
  if (!extId) { const e = new Error("signal id required"); e.code = "bad_signal"; throw e; }

  const stakeNum = Math.floor(Number(input.stake));
  if (!Number.isFinite(stakeNum) || stakeNum < MIN_STAKE) { const e = new Error("stake below minimum"); e.code = "bad_stake"; throw e; }
  if (stakeNum > MAX_STAKE) { const e = new Error("stake above maximum"); e.code = "bad_stake"; throw e; }
  const stake = String(stakeNum);

  let timeLimit = null;
  if (input.timeLimitSec != null && input.timeLimitSec !== "" && Number(input.timeLimitSec) > 0) {
    const tl = Math.floor(Number(input.timeLimitSec));
    if (!Number.isFinite(tl) || tl < MIN_TIME_LIMIT) { const e = new Error("time limit too short"); e.code = "bad_time"; throw e; }
    timeLimit = Math.min(MAX_TIME_LIMIT, tl);
  }

  return withTransaction(async (cx) => {
    const { rows: srows } = await cx.query(`SELECT * FROM quantoption_signals WHERE ext_id=$1 FOR UPDATE`, [extId]);
    const signal = srows[0];
    if (!signal) { const e = new Error("signal not found"); e.code = "not_found"; throw e; }
    if (signal.status !== "live") { const e = new Error("this signal has already resolved"); e.code = "signal_closed"; throw e; }
    if (signal.entry == null || signal.tp3 == null || signal.sl == null || !signal.direction) {
      const e = new Error("signal is missing entry, target, or stop"); e.code = "bad_signal"; throw e;
    }

    // Live-price validity gate: a signal is only tradeable while price has NOT yet
    // reached its 2nd target or its stop. Re-check against a fresh price here so a
    // stale signal can never be opened (and mark it dead so it leaves the list).
    const livePx = await livePriceFor(signal);
    const validity = signalValidity(signal, livePx);
    if (!validity.valid) {
      if (validity.reason === "stopped" || validity.reason === "target_reached") {
        try { await invalidateSignal(signal, livePx, validity.reason); } catch (e2) { /* best-effort */ }
      }
      const msg = validity.reason === "stopped" ? "This signal has already hit its stop — it's no longer tradeable"
        : validity.reason === "target_reached" ? "This signal has already reached its target — it's no longer tradeable"
        : "This signal is no longer valid";
      const e = new Error(msg); e.code = "signal_invalid"; throw e;
    }
    if (livePx == null) { const e = new Error("Live price unavailable — please try again in a moment"); e.code = "feed_unavailable"; throw e; }

    // Bind the position to the REAL current price (not the stale signal entry) so
    // barriers/settlement are internally consistent. Keep the signal's TP3/SL as
    // the barriers, but stamp entry at the live fill.
    const fillEntry = String(livePx);

    // one open position per (user, signal)
    const { rows: dup } = await cx.query(
      `SELECT id FROM quantoption_signal_positions WHERE user_id=$1 AND signal_ext_id=$2 AND status='open' LIMIT 1`,
      [String(userId), extId]);
    if (dup.length) { const e = new Error("you already have a position on this signal"); e.code = "has_open"; throw e; }

    if (!(await exposureOk(cx, stake))) { const e = new Error("Quant Option is at capacity — try a smaller stake"); e.code = "capacity"; throw e; }

    const expiresAt = timeLimit ? new Date(Date.now() + timeLimit * 1000) : null;
    const uwId = await userWalletId(userId, cx);
    const { rows: pr } = await cx.query(
      `INSERT INTO quantoption_signal_positions
         (user_id, signal_ext_id, symbol, direction, stake, entry_price, target_price, stop_price, tier, time_limit_sec, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [String(userId), extId, signal.symbol, signal.direction, stake,
       fillEntry, signal.tp3, signal.sl, DEFAULT_TIER, timeLimit, expiresAt]);
    const p = pr[0];
    const txn = await postTransaction({
      type: "tournament_entry", amount: stake,
      movements: [
        { walletId: uwId, direction: "debit", amount: stake, description: "Quant Option signal stake" },
        { walletId: _poolWalletId, direction: "credit", amount: stake, description: "Quant Option signal stake" },
      ],
      initiatorUserId: String(userId),
      reference: { type: "quantoption_signal_position", id: p.id },
      idempotencyKey: "qo:sigstake:" + p.id,
      metadata: { app: "quantoption", kind: "signal_stake", extId, symbol: signal.symbol },
    }, cx);
    await cx.query(`UPDATE quantoption_signal_positions SET stake_txn=$2 WHERE id=$1`, [p.id, txn.public_id]);
    return signalPositionView({ ...p, stake_txn: txn.public_id }, signal);
  }).catch((err) => {
    if (/insufficient/i.test(err.message) || err.code === "insufficient_funds") {
      const e = new Error("Not enough QNTM in your wallet"); e.code = "insufficient"; throw e;
    }
    throw err;
  });
}

async function getSignalPosition(userId, id) {
  await init();
  const { rows } = await pool.query(`SELECT * FROM quantoption_signal_positions WHERE id=$1 AND user_id=$2`, [id, String(userId)]);
  if (!rows.length) return null;
  const p = rows[0];
  // lazy settle: bound signal already resolved, or the optional time limit passed
  if (p.status === "open") {
    const { rows: srows } = await pool.query(`SELECT * FROM quantoption_signals WHERE ext_id=$1`, [p.signal_ext_id]);
    const signal = srows[0];
    if (signal && (signal.status === "won" || signal.status === "lost")) {
      await settleSignal(p.signal_ext_id, signal.status === "won" ? "win" : "lose", signal.last_price);
      return reread(userId, id);
    }
    if (p.expires_at && new Date(p.expires_at).getTime() <= Date.now()) {
      await refundExpired(p.id);
      return reread(userId, id);
    }
  }
  const { rows: srows2 } = await pool.query(`SELECT * FROM quantoption_signals WHERE ext_id=$1`, [p.signal_ext_id]);
  return signalPositionView(p, srows2[0] || null);
}
async function reread(userId, id) {
  const { rows } = await pool.query(`SELECT * FROM quantoption_signal_positions WHERE id=$1 AND user_id=$2`, [id, String(userId)]);
  if (!rows.length) return null;
  const { rows: s } = await pool.query(`SELECT * FROM quantoption_signals WHERE ext_id=$1`, [rows[0].signal_ext_id]);
  return signalPositionView(rows[0], s[0] || null);
}

// The user's current OPEN signal position (if any) so the UI can resume an
// in-progress trade after the app was closed. Lazily settles like getSignalPosition.
async function getOpenSignalPosition(userId) {
  await init();
  const { rows } = await pool.query(
    `SELECT * FROM quantoption_signal_positions WHERE user_id=$1 AND status='open' ORDER BY id DESC LIMIT 1`,
    [String(userId)]);
  if (!rows.length) return null;
  const p = rows[0];
  const { rows: srows } = await pool.query(`SELECT * FROM quantoption_signals WHERE ext_id=$1`, [p.signal_ext_id]);
  const signal = srows[0];
  if (signal && (signal.status === "won" || signal.status === "lost")) {
    await settleSignal(p.signal_ext_id, signal.status === "won" ? "win" : "lose", signal.last_price);
    return reread(userId, p.id);
  }
  if (p.expires_at && new Date(p.expires_at).getTime() <= Date.now()) {
    await refundExpired(p.id);
    return reread(userId, p.id);
  }
  const lp = await livePriceFor(signal || { symbol: p.symbol, last_price: null });
  return signalPositionView(p, signal || null, lp);
}

// All of the user's currently OPEN signal positions (multiple allowed - one per
// signal). Lazily settles any whose bound signal already resolved or whose time
// limit lapsed (those drop out of the list), then returns the live remainder,
// newest first. Mirrors getOpenSignalPosition but returns every open position.
async function listOpenSignalPositions(userId) {
  await init();
  const { rows } = await pool.query(
    `SELECT * FROM quantoption_signal_positions WHERE user_id=$1 AND status='open' ORDER BY id DESC`,
    [String(userId)]);
  if (!rows.length) return { positions: [] };
  const sigCache = {};
  async function sigFor(extId) {
    if (extId in sigCache) return sigCache[extId];
    const { rows: s } = await pool.query(`SELECT * FROM quantoption_signals WHERE ext_id=$1`, [extId]);
    return (sigCache[extId] = s[0] || null);
  }
  const out = [];
  const priceCache = {};
  async function livePx(sym, signal) {
    if (sym in priceCache) return priceCache[sym];
    let lp = await priceFeed.getSpot(sym).catch(() => null);
    if (!(Number.isFinite(Number(lp)) && Number(lp) > 0)) lp = (signal && signal.last_price != null ? Number(signal.last_price) : null);
    return (priceCache[sym] = (Number.isFinite(Number(lp)) && Number(lp) > 0) ? Number(lp) : null);
  }
  for (const p of rows) {
    const signal = await sigFor(p.signal_ext_id);
    if (signal && (signal.status === "won" || signal.status === "lost")) {
      await settleSignal(p.signal_ext_id, signal.status === "won" ? "win" : "lose", signal.last_price);
      continue;   // just settled -> no longer open
    }
    if (p.expires_at && new Date(p.expires_at).getTime() <= Date.now()) {
      await refundExpired(p.id);
      continue;   // time limit lapsed -> refunded (draw), drops out of open list
    }
    const lp = await livePx(p.symbol, signal);
    out.push(signalPositionView(p, signal, lp));
  }
  return { positions: out };
}

// time-limit expiry with no real outcome → refund the stake (draw)
async function refundExpired(positionId) {
  return withTransaction(async (cx) => {
    const { rows } = await cx.query(`SELECT * FROM quantoption_signal_positions WHERE id=$1 FOR UPDATE`, [positionId]);
    const p = rows[0];
    if (!p || p.status !== "open") return { ok: true, already: true };
    await settleOnePosition(cx, p, "draw", p.entry_price);
    return { ok: true, refunded: true };
  });
}

// ── keeper: settle bound positions whose signal resolved, and refund any whose
//    optional time limit elapsed without a real outcome ───────────────────────
async function sweepExpired(limitInput) {
  await init();
  const limit = Math.min(500, Math.max(1, Math.floor(Number(limitInput) || 200)));
  // (0) price-driven invalidation: any LIVE signal whose real price has already
  // reached its 2nd target or its stop is dead even if the webhook never fired —
  // mark it closed so it leaves the list. Any positions bound to it are handled by
  // the normal barrier settlement in liveView (real mode) or the passes below.
  let invalidated = 0;
  const { rows: liveSigs } = await pool.query(
    `SELECT * FROM quantoption_signals WHERE status='live' AND entry IS NOT NULL AND sl IS NOT NULL ORDER BY id DESC LIMIT $1`, [limit]);
  const swpCache = {};
  for (const sig of liveSigs) {
    try {
      let lp = swpCache[sig.symbol];
      if (lp === undefined) { lp = await livePriceFor(sig); swpCache[sig.symbol] = lp; }
      const v = signalValidity(sig, lp);
      if (!v.valid && (v.reason === "stopped" || v.reason === "target_reached")) {
        await invalidateSignal(sig, lp, v.reason);
        invalidated++;
      }
    } catch (e) { /* best-effort per signal */ }
  }
  // (1) positions whose bound signal already terminally resolved but are still open
  const { rows: resolved } = await pool.query(
    `SELECT p.id, p.signal_ext_id, s.status AS sig_status, s.last_price
       FROM quantoption_signal_positions p JOIN quantoption_signals s ON s.ext_id = p.signal_ext_id
      WHERE p.status='open' AND s.status IN ('won','lost') ORDER BY p.id LIMIT $1`, [limit]);
  let settled = 0;
  const seenSignals = new Set();
  for (const r of resolved) {
    if (seenSignals.has(r.signal_ext_id)) continue;
    seenSignals.add(r.signal_ext_id);
    try { const out = await settleSignal(r.signal_ext_id, r.sig_status === "won" ? "win" : "lose", r.last_price); if (out && out.ok) settled += (out.won || 0) + (out.lost || 0); }
    catch (e) { console.warn("[quantoption-signals] settle bound failed:", e.message); }
  }
  // (2) time-limit expiries with no real outcome yet → refund
  const { rows: expired } = await pool.query(
    `SELECT id FROM quantoption_signal_positions WHERE status='open' AND expires_at IS NOT NULL AND expires_at < now() ORDER BY id LIMIT $1`, [limit]);
  let refunded = 0;
  for (const r of expired) { try { const x = await refundExpired(r.id); if (x && x.refunded) refunded++; } catch (e) { console.warn("[quantoption-signals] refund failed:", e.message); } }
  return { settled, refunded, invalidated };
}

// ── reads for the UI ────────────────────────────────────────────────────────
async function listLiveSignals(limitInput) {
  await init();
  const limit = Math.min(100, Math.max(1, Math.floor(Number(limitInput) || 30)));
  const { rows } = await pool.query(
    `SELECT * FROM quantoption_signals WHERE status='live' AND entry IS NOT NULL AND tp1 IS NOT NULL AND sl IS NOT NULL
      ORDER BY id DESC LIMIT $1`, [limit]);
  // Live-price validity gate: a signal whose price has already reached TP2/TP3 or
  // SL is dead — drop it from the list AND invalidate it in the DB so it's removed
  // for everyone, even if the terminating webhook never arrived.
  const out = [];
  const priceCache = {};
  for (const s of rows) {
    let lp = priceCache[s.symbol];
    if (lp === undefined) { lp = await livePriceFor(s); priceCache[s.symbol] = lp; }
    const v = signalValidity(s, lp);
    if (v.valid) { out.push(signalView(s)); }
    else if (v.reason === "stopped" || v.reason === "target_reached") {
      try { await invalidateSignal(s, lp, v.reason); } catch (e) { /* best-effort */ }
    }
  }
  return { signals: out };
}
async function getSignalByExt(extId) {
  await init();
  const { rows } = await pool.query(`SELECT * FROM quantoption_signals WHERE ext_id=$1`, [String(extId)]);
  return rows[0] ? signalView(rows[0]) : null;
}
async function history(userId, limitInput, offsetInput) {
  await init();
  const limit = Math.min(100, Math.max(1, Math.floor(Number(limitInput) || 30)));
  const offset = Math.max(0, Math.floor(Number(offsetInput) || 0));
  const { rows } = await pool.query(
    `SELECT * FROM quantoption_signal_positions WHERE user_id=$1 ORDER BY id DESC LIMIT $2 OFFSET $3`, [String(userId), limit, offset]);
  return { items: rows.map((p) => signalPositionView(p, null)), count: rows.length, limit, offset };
}

// ── shaping ─────────────────────────────────────────────────────────────────
function signalView(s) {
  return {
    extId: s.ext_id, symbol: s.symbol, direction: s.direction,
    entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3, tf: s.tf,
    status: s.status, maxTp: Number(s.max_tp || 0), lastPrice: s.last_price,
    createdAt: s.created_at,
  };
}
function signalPositionView(p, signal, livePrice) {
  // Indicative progress from entry (0) toward the winning target/TP3 (1), going
  // negative toward the stop (-1). These positions settle as a FIXED payout on a
  // win (target before stop) rather than linearly, so this is a visual gauge of
  // how close the trade is to winning vs stopping out - not a mark-to-market P/L.
  const entryN = p.entry_price != null ? Number(p.entry_price) : null;
  const targetN = p.target_price != null ? Number(p.target_price) : null;
  const stopN = p.stop_price != null ? Number(p.stop_price) : null;
  const lpRaw = (livePrice != null && Number.isFinite(Number(livePrice)) && Number(livePrice) > 0)
    ? Number(livePrice)
    : (signal && signal.last_price != null ? Number(signal.last_price) : null);
  let progress = null, winning = null;
  if (lpRaw != null && entryN != null && targetN != null && targetN !== entryN) {
    progress = (lpRaw - entryN) / (targetN - entryN); // 1 at target, 0 at entry, <0 toward stop
    if (progress > 1.5) progress = 1.5; if (progress < -1.5) progress = -1.5;
    winning = progress >= 0; // price is on the target side of entry
  }
  return {
    id: p.id, kind: "signal", signalExtId: p.signal_ext_id,
    symbol: p.symbol, dir: p.direction, stake: p.stake, status: p.status, outcome: p.outcome,
    entry: p.entry_price, target: p.target_price, stop: p.stop_price, tier: Number(p.tier || 1),
    tp1: signal && signal.tp1 != null ? String(signal.tp1) : null,
    tp2: signal && signal.tp2 != null ? String(signal.tp2) : null,
    tp3: signal && signal.tp3 != null ? String(signal.tp3) : (p.target_price != null ? String(p.target_price) : null),
    timeLimitSec: p.time_limit_sec, expiresAt: p.expires_at,
    exitPrice: p.exit_price, payout: p.payout,
    openedAt: p.opened_at, settledAt: p.settled_at,
    potentialWin: decimal.add(p.stake, engine.profitOf(p.stake)),
    livePrice: lpRaw != null ? String(lpRaw) : null,
    progress: progress,       // number | null  (1 = at target, 0 = entry, <0 = toward stop)
    winning: winning,         // bool | null    (price currently on the winning side)
    signal: signal ? signalView(signal) : null,
  };
}

// ── admin ────────────────────────────────────────────────────────────────────
function webhookConfigured() {
  return !!(process.env.QUANTOPTION_WEBHOOK_SECRET || process.env.EASYTRADE_WEBHOOK_SECRET || process.env.TRADINGVIEW_WEBHOOK_SECRET);
}

// early cash-out for a signal position (mirrors services/quantoption.js cashOut):
// settle NOW at the live spot, pool-funded by engine.cashoutMultiplier()*stake.
async function cashOutSignal(userId, id) {
  await init();
  return withTransaction(async (cx) => {
    const { rows } = await cx.query(`SELECT * FROM quantoption_signal_positions WHERE id=$1 AND user_id=$2 FOR UPDATE`, [id, String(userId)]);
    if (!rows.length) { const e = new Error("position not found"); e.code = "not_found"; throw e; }
    const p = rows[0];
    if (p.status !== "open") { const e = new Error("position already settled"); e.code = "not_open"; throw e; }
    if (p.entry_price == null || p.target_price == null || p.stop_price == null) { const e = new Error("this position can't be cashed out"); e.code = "bad_signal"; throw e; }
    let live = await priceFeed.getSpot(p.symbol).catch(() => null);
    if (!Number.isFinite(Number(live))) { const e = new Error("Live price unavailable — try again in a moment"); e.code = "feed_unavailable"; throw e; }
    live = Number(live);
    const m = engine.cashoutMultiplier(p.entry_price, p.target_price, p.stop_price, live);
    if (m == null) { const e = new Error("Live price unavailable — try again in a moment"); e.code = "feed_unavailable"; throw e; }
    const credit = engine.cashoutCredit(p.stake, m);
    const c = decimal.cmp(credit, String(p.stake));
    const status = c > 0 ? "won" : c === 0 ? "draw" : "lost";
    const outcome = c > 0 ? "win" : c === 0 ? "draw" : "lose";
    let payoutTxnId = null;
    if (decimal.isPositive(credit)) {
      const txn = await postTransaction({
        type: "refund", amount: credit,
        movements: [
          { walletId: _poolWalletId, direction: "debit", amount: credit, description: "Quant Option signal cash-out" },
          { walletId: await userWalletId(p.user_id, cx), direction: "credit", amount: credit, description: "Quant Option signal cash-out" },
        ],
        initiatorUserId: p.user_id,
        reference: { type: "quantoption_signal_position", id: p.id },
        idempotencyKey: "qo:sigcashout:" + p.id,
        metadata: { app: "quantoption", kind: "signal_cashout", multiplierBps: Math.round(m * 10000) },
      }, cx);
      payoutTxnId = txn.public_id;
    }
    await cx.query(
      `UPDATE quantoption_signal_positions SET status=$2, outcome=$3, exit_price=$4, payout=$5, payout_txn=$6, settled_at=now() WHERE id=$1`,
      [p.id, status, outcome, String(live), credit, payoutTxnId]);
    const { rows: srows } = await cx.query(`SELECT * FROM quantoption_signals WHERE ext_id=$1`, [p.signal_ext_id]);
    const view = signalPositionView({ ...p, status, outcome, exit_price: String(live), payout: credit, payout_txn: payoutTxnId, settled_at: new Date().toISOString() }, srows[0] || null);
    view.cashedOut = true; view.cashoutMult = m;
    return view;
  });
}

module.exports = {
  init, ingestSignalEvent, openSignalPosition, getSignalPosition, getOpenSignalPosition, cashOutSignal, sweepExpired,
  listLiveSignals, getSignalByExt, history, webhookConfigured, listOpenSignalPositions,
  MIN_STAKE, MAX_STAKE, MIN_TIME_LIMIT, MAX_TIME_LIMIT,
};
