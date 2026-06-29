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

const MIN_STAKE = 10;
const MAX_STAKE = 1000000;
const POOL_OWNER = ["platform", "quantoption", "reward_pool"]; // SAME pool wallet as services/quantoption.js
const DEFAULT_TIER = 1;                 // win = trade reaches its first target (tp1) before sl
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
    if (signal.entry == null || signal.tp1 == null || signal.sl == null || !signal.direction) {
      const e = new Error("signal is missing entry, target, or stop"); e.code = "bad_signal"; throw e;
    }

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
       signal.entry, signal.tp1, signal.sl, DEFAULT_TIER, timeLimit, expiresAt]);
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
  return signalPositionView(p, signal || null);
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
  return { settled, refunded };
}

// ── reads for the UI ────────────────────────────────────────────────────────
async function listLiveSignals(limitInput) {
  await init();
  const limit = Math.min(100, Math.max(1, Math.floor(Number(limitInput) || 30)));
  const { rows } = await pool.query(
    `SELECT * FROM quantoption_signals WHERE status='live' AND entry IS NOT NULL AND tp1 IS NOT NULL AND sl IS NOT NULL
      ORDER BY id DESC LIMIT $1`, [limit]);
  return { signals: rows.map(signalView) };
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
function signalPositionView(p, signal) {
  return {
    id: p.id, kind: "signal", signalExtId: p.signal_ext_id,
    symbol: p.symbol, dir: p.direction, stake: p.stake, status: p.status, outcome: p.outcome,
    entry: p.entry_price, target: p.target_price, stop: p.stop_price, tier: Number(p.tier || 1),
    timeLimitSec: p.time_limit_sec, expiresAt: p.expires_at,
    exitPrice: p.exit_price, payout: p.payout,
    openedAt: p.opened_at, settledAt: p.settled_at,
    potentialWin: decimal.add(p.stake, engine.profitOf(p.stake)),
    signal: signal ? signalView(signal) : null,
  };
}

// ── admin ────────────────────────────────────────────────────────────────────
function webhookConfigured() {
  return !!(process.env.QUANTOPTION_WEBHOOK_SECRET || process.env.EASYTRADE_WEBHOOK_SECRET || process.env.TRADINGVIEW_WEBHOOK_SECRET);
}

module.exports = {
  init, ingestSignalEvent, openSignalPosition, getSignalPosition, getOpenSignalPosition, sweepExpired,
  listLiveSignals, getSignalByExt, history, webhookConfigured,
  MIN_STAKE, MAX_STAKE, MIN_TIME_LIMIT, MAX_TIME_LIMIT,
};
