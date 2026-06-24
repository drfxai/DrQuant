// services/signal-scoreboard.js
// ----------------------------------------------------------------------------
// In-memory signal scoreboard (NO database — "temporary memory" by design).
//
// Holds a rolling set of recently DETECTED signals (from chat messages) and
// STRUCTURED webhook signals, resolves each to win / loss / open by comparing
// its TP / SL against a live price fed in from outside (TradingView webhook
// prices + an optional free crypto poller), and rolls everything up into
// leaderboard tables:
//
//   • channels        — ranked best→worst by win rate  ("most/least positive")
//   • symbols         — win rate + targets per symbol
//   • timeframes      — win rate + targets per timeframe
//   • symbol×timeframe— the combos with the highest success %
//
// Everything lives in process memory: it is rebuilt from the last N hours of
// messages on boot and on a timer, and it is wiped on restart. Nothing here is
// persisted, so the authoritative `signals` table never fills with guesses.
//
// Outcome model (single last-price, no tick history):
//   long  → price >= tp ⇒ WIN ; price <= sl ⇒ LOSS
//   short → price <= tp ⇒ WIN ; price >= sl ⇒ LOSS
// A signal only counts toward a win rate once it is RESOLVED. Unresolved ones
// are "open"; ones that sit open past EXPIRE_HOURS become "expired" (never
// counted as a win or a loss — we simply never learned the outcome).
//
// IMPORTANT HONESTY NOTE: outcomes are only as good as the price feed. Symbols
// with no incoming price (e.g. a forex/metal pair with no heartbeat alert and
// no poller) stay "open" forever and contribute 0 resolved signals. The tables
// say so via each row's open/resolved counts.
// ----------------------------------------------------------------------------

"use strict";

let DQSignal;
try {
  DQSignal = require("../public/signal-extract.js");
} catch (e) {
  console.error("[scoreboard] could not load extractor:", e.message);
  DQSignal = { extract: () => null };
}

// ── tunables ────────────────────────────────────────────────────────────────
const MAX_SIGNALS = 4000;      // hard cap on stored signals (oldest trimmed)
const WINDOW_HOURS = 48;       // how far back the message rebuild scans
const SCAN_CAP = 1200;         // max messages inspected per rebuild
const EXPIRE_HOURS = 24;       // open signals older than this → "expired"
const PRICE_TTL_MS = 30 * 60 * 1000; // a price older than this is considered stale

// ── state (module singleton) ────────────────────────────────────────────────
const signals = new Map();     // id -> sig
const prices = new Map();      // SYMBOL -> { price, at:ms }
const chatNames = new Map();   // chatId -> display name
let lastRebuildAt = null;

// A signal can only be resolved if it has a direction, an entry, and at least
// one of TP/SL that sits on the correct side of the entry (sane bounds only).
function sane(sig) {
  if (!sig || !sig.direction || sig.entry == null) return false;
  const e = Number(sig.entry);
  if (!isFinite(e)) return false;
  let okTp = false, okSl = false;
  if (sig.tp != null && isFinite(sig.tp)) {
    okTp = sig.direction === "long" ? sig.tp > e : sig.tp < e;
  }
  if (sig.sl != null && isFinite(sig.sl)) {
    okSl = sig.direction === "long" ? sig.sl < e : sig.sl > e;
  }
  return okTp || okSl;
}

function trimIfNeeded() {
  if (signals.size <= MAX_SIGNALS) return;
  // delete oldest by createdAt until back under the cap
  const arr = Array.from(signals.values()).sort((a, b) => a.createdAt - b.createdAt);
  const remove = signals.size - MAX_SIGNALS;
  for (let i = 0; i < remove; i++) signals.delete(arr[i].id);
}

// Try to resolve one signal against the latest known price for its symbol.
function resolveOne(sig) {
  if (sig.status !== "open") return;
  const p = prices.get(sig.symbol);
  if (!p) return;
  const price = p.price;
  if (price == null || !isFinite(price)) return;
  let outcome = null;
  if (sig.direction === "long") {
    if (sig.tp != null && price >= sig.tp) outcome = "win";
    else if (sig.sl != null && price <= sig.sl) outcome = "loss";
  } else { // short
    if (sig.tp != null && price <= sig.tp) outcome = "win";
    else if (sig.sl != null && price >= sig.sl) outcome = "loss";
  }
  if (outcome) {
    sig.status = outcome;
    sig.resolvedAt = Date.now();
    sig.resolvedPrice = price;
  }
}

function resolveSymbol(symbol) {
  for (const sig of signals.values()) {
    if (sig.symbol === symbol && sig.status === "open") resolveOne(sig);
  }
}

// ── ingest ──────────────────────────────────────────────────────────────────

// Add (or skip-if-present) a normalized signal record. Shape is built by the
// helpers below so callers don't construct it directly.
function add(sig) {
  if (!sig || !sig.id || signals.has(sig.id)) return false;
  if (!sig.symbol || !sig.direction) return false;
  sig.status = "open";
  sig.resolvedAt = null;
  sig.resolvedPrice = null;
  sig.resolvable = sane(sig);
  signals.set(sig.id, sig);
  resolveOne(sig); // a price may already be known
  trimIfNeeded();
  return true;
}

// From the extractor output + message metadata (a DETECTED, in-chat signal).
function ingestDetected(ex, meta) {
  if (!ex || !meta) return false;
  if (meta.chatName) chatNames.set(meta.chatId, meta.chatName);
  return add({
    id: "msg:" + meta.chatId + ":" + meta.messageId,
    source: "auto",
    chatId: meta.chatId,
    chatName: meta.chatName || chatNames.get(meta.chatId) || ("Channel #" + meta.chatId),
    symbol: ex.symbol,
    direction: ex.direction,
    entry: ex.entry,
    sl: ex.sl,
    tp: ex.tp,
    timeframe: ex.timeframe || null,
    confidence: ex.confidence != null ? ex.confidence : null,
    createdAt: meta.createdAt ? new Date(meta.createdAt).getTime() : Date.now(),
  });
}

// From a normalized TradingView webhook signal (operator-issued).
function ingestWebhook(n, meta) {
  if (!n) return false;
  const dir = (n.side === "buy" || n.side === "long") ? "long"
    : (n.side === "sell" || n.side === "short") ? "short" : null;
  if (!dir) return false; // close/alert carry no direction → price-only
  meta = meta || {};
  if (meta.chatId != null && meta.chatName) chatNames.set(meta.chatId, meta.chatName);
  const sigId = meta.signalId != null ? ("wh:" + meta.signalId)
    : ("wh:" + n.symbol + ":" + dir + ":" + (n.price == null ? "" : n.price) + ":" + Math.floor(Date.now() / 60000));
  return add({
    id: sigId,
    source: "webhook",
    chatId: meta.chatId != null ? meta.chatId : null,
    chatName: meta.chatId != null ? (meta.chatName || chatNames.get(meta.chatId) || ("Channel #" + meta.chatId)) : "TradingView",
    symbol: n.symbol,
    direction: dir,
    entry: n.price,
    sl: n.stop_loss,
    tp: n.take_profit,
    timeframe: n.timeframe || null,
    confidence: 1,
    createdAt: Date.now(),
  });
}

// ── prices ──────────────────────────────────────────────────────────────────
function setPrice(symbol, price) {
  if (!symbol) return 0;
  const sym = String(symbol).toUpperCase().slice(0, 32);
  const px = Number(price);
  if (!isFinite(px) || px <= 0) return 0;
  prices.set(sym, { price: px, at: Date.now() });
  const before = countOpen(sym);
  resolveSymbol(sym);
  return before - countOpen(sym); // how many resolved on this tick
}
function setPrices(list) {
  let n = 0;
  if (Array.isArray(list)) for (const it of list) { if (it && it.symbol != null) n += setPrice(it.symbol, it.price); }
  return n;
}
function countOpen(symbol) {
  let c = 0;
  for (const s of signals.values()) if (s.symbol === symbol && s.status === "open") c++;
  return c;
}

// Mark long-open signals as expired (outcome never learned).
function expireStale() {
  const cutoff = Date.now() - EXPIRE_HOURS * 3600 * 1000;
  let n = 0;
  for (const s of signals.values()) {
    if (s.status === "open" && s.createdAt < cutoff) { s.status = "expired"; n++; }
  }
  return n;
}

// ── rebuild from messages (boot + timer) ─────────────────────────────────────
// Scans recent messages in PUBLIC groups/channels only (private-channel activity
// is never folded into a shared leaderboard), runs the extractor, and ingests
// every hit. Dedup is automatic via the deterministic per-message id.
async function rebuildFromMessages(pool) {
  if (!pool) return { ingested: 0, scanned: 0 };
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.chat_id, m.content, m.created_at,
              c.name AS chat_name, c.username AS chat_username
         FROM messages m
         JOIN chats c ON c.id = m.chat_id
        WHERE m.created_at > NOW() - INTERVAL '${WINDOW_HOURS} hours'
          AND m.deleted_at IS NULL
          AND m.content IS NOT NULL AND m.content <> ''
          AND c.type IN ('group','channel')
          AND c.visibility = 'public'
        ORDER BY m.created_at DESC
        LIMIT ${SCAN_CAP}`
    );
    let ingested = 0;
    for (const r of rows) {
      const ex = DQSignal.extract(r.content);
      if (!ex) continue;
      const ok = ingestDetected(ex, {
        chatId: r.chat_id,
        chatName: r.chat_name || (r.chat_username ? "@" + r.chat_username : null),
        messageId: r.id,
        createdAt: r.created_at,
      });
      if (ok) ingested++;
    }
    expireStale();
    lastRebuildAt = Date.now();
    return { ingested, scanned: rows.length };
  } catch (e) {
    console.error("[scoreboard] rebuild error:", e.message);
    return { ingested: 0, scanned: 0, error: e.message };
  }
}

// ── aggregation / tables ─────────────────────────────────────────────────────
function blankAgg() {
  return { total: 0, resolvable: 0, wins: 0, losses: 0, open: 0, expired: 0, confSum: 0, confN: 0 };
}
function bump(agg, s) {
  agg.total++;
  if (s.resolvable) agg.resolvable++;
  if (s.status === "win") agg.wins++;
  else if (s.status === "loss") agg.losses++;
  else if (s.status === "expired") agg.expired++;
  else agg.open++;
  if (s.confidence != null) { agg.confSum += s.confidence; agg.confN++; }
}
function finalize(agg, extra) {
  const decided = agg.wins + agg.losses;
  const out = {
    total: agg.total,
    wins: agg.wins,
    losses: agg.losses,
    open: agg.open,
    expired: agg.expired,
    decided,
    win_rate: decided ? Math.round((agg.wins / decided) * 1000) / 10 : null, // %, 1dp, null if nothing decided
    avg_confidence: agg.confN ? Math.round((agg.confSum / agg.confN) * 100) / 100 : null,
  };
  return Object.assign(out, extra || {});
}

// Sort: rows with decided outcomes first, by win rate desc, then more wins, then
// more total. Rows with nothing decided sink to the bottom (they're unranked).
function rankSort(a, b) {
  const ad = a.decided > 0, bd = b.decided > 0;
  if (ad !== bd) return ad ? -1 : 1;
  if (b.win_rate !== a.win_rate) return (b.win_rate || 0) - (a.win_rate || 0);
  if (b.wins !== a.wins) return b.wins - a.wins;
  return b.total - a.total;
}

function groupBy(keyFn, labelFn) {
  const m = new Map();
  for (const s of signals.values()) {
    const k = keyFn(s);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, { _agg: blankAgg(), _label: labelFn ? labelFn(s) : k });
    bump(m.get(k)._agg, s);
  }
  const rows = [];
  for (const [k, v] of m.entries()) rows.push(finalize(v._agg, { key: String(k), label: v._label }));
  rows.sort(rankSort);
  return rows;
}

function tables() {
  const channels = groupBy(
    (s) => (s.chatId != null ? s.chatId : "tv"),
    (s) => s.chatName || (s.chatId != null ? "Channel #" + s.chatId : "TradingView")
  ).map((r) => Object.assign(r, { channel_id: r.key === "tv" ? null : Number(r.key) }));

  const symbols = groupBy((s) => s.symbol, (s) => s.symbol);
  const timeframes = groupBy(
    (s) => s.timeframe || "—",
    (s) => s.timeframe || "Unspecified"
  );
  const symbolTimeframe = groupBy(
    (s) => s.symbol + " · " + (s.timeframe || "—"),
    (s) => s.symbol + " · " + (s.timeframe || "—")
  );

  return {
    generated_at: new Date().toISOString(),
    channels,
    symbols,
    timeframes,
    symbol_timeframe: symbolTimeframe,
    best_channels: channels.filter((c) => c.decided > 0).slice(0, 5),
    worst_channels: channels.filter((c) => c.decided > 0).slice(-5).reverse(),
    stats: stats(),
  };
}

function stats() {
  let win = 0, loss = 0, open = 0, exp = 0;
  for (const s of signals.values()) {
    if (s.status === "win") win++;
    else if (s.status === "loss") loss++;
    else if (s.status === "expired") exp++;
    else open++;
  }
  const fresh = [];
  const now = Date.now();
  for (const [sym, p] of prices.entries()) if (now - p.at <= PRICE_TTL_MS) fresh.push(sym);
  return {
    total_signals: signals.size,
    wins: win, losses: loss, open, expired: exp,
    decided: win + loss,
    symbols_priced: fresh.length,
    prices_known: prices.size,
    last_rebuild_at: lastRebuildAt ? new Date(lastRebuildAt).toISOString() : null,
    window_hours: WINDOW_HOURS,
    expire_hours: EXPIRE_HOURS,
  };
}

// Recent signals (for an optional detail/debug view).
function recent(limit) {
  const arr = Array.from(signals.values()).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit || 50);
  return arr.map((s) => ({
    id: s.id, source: s.source, chat: s.chatName, symbol: s.symbol, direction: s.direction,
    entry: s.entry, sl: s.sl, tp: s.tp, timeframe: s.timeframe, confidence: s.confidence,
    status: s.status, created_at: new Date(s.createdAt).toISOString(),
    resolved_price: s.resolvedPrice, resolved_at: s.resolvedAt ? new Date(s.resolvedAt).toISOString() : null,
  }));
}

module.exports = {
  ingestDetected,
  ingestWebhook,
  setPrice,
  setPrices,
  rebuildFromMessages,
  expireStale,
  tables,
  stats,
  recent,
  _config: { MAX_SIGNALS, WINDOW_HOURS, SCAN_CAP, EXPIRE_HOURS },
};
