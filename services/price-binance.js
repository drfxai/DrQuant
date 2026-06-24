// services/price-binance.js
// ----------------------------------------------------------------------------
// OPTIONAL free crypto price feed for the scoreboard. OFF unless the env flag
// PRICE_FEED_BINANCE=on is set — nothing here runs (and no external request is
// ever made) otherwise.
//
// Binance's public ticker requires NO API key. We only ask for the crypto
// symbols the scoreboard is actually tracking right now (so we never hammer the
// endpoint for the whole market), and feed each price into scoreboard.setPrice,
// which resolves any open signals that crossed their TP/SL.
//
// Our canonical crypto symbols already match Binance symbols (BTCUSDT, ETHUSDT,
// SOLUSDT, XRPUSDT, BNBUSDT, DOGEUSDT), so no mapping table is needed. Non-crypto
// pairs (XAUUSD, EURUSD, indices, oil) are NOT covered here — feed those via the
// TradingView price heartbeat (POST /api/webhooks/price) or a keyed provider.
//
// Defensive by contract: every failure is caught and logged; the poller never
// throws into the event loop and never blocks anything.
// ----------------------------------------------------------------------------

"use strict";

// Canonical symbols Binance lists as <BASE>USDT spot pairs.
const BINANCE_OK = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT"]);
const DEFAULT_INTERVAL_MS = 45 * 1000;

let timer = null;

// Pull the distinct crypto symbols that currently have at least one OPEN signal.
function openCryptoSymbols(scoreboard) {
  try {
    const rows = scoreboard.recent(scoreboard._config.MAX_SIGNALS);
    const set = new Set();
    for (const r of rows) {
      if (r.status === "open" && BINANCE_OK.has(r.symbol)) set.add(r.symbol);
    }
    return Array.from(set);
  } catch (e) {
    return [];
  }
}

async function pollOnce(scoreboard) {
  const syms = openCryptoSymbols(scoreboard);
  if (!syms.length) return;
  try {
    const q = encodeURIComponent(JSON.stringify(syms));
    const url = "https://api.binance.com/api/v3/ticker/price?symbols=" + q;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal, headers: { "accept": "application/json" } });
    } finally {
      clearTimeout(to);
    }
    if (!res || !res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data)) return;
    let resolved = 0;
    for (const it of data) {
      if (it && it.symbol && it.price != null) resolved += scoreboard.setPrice(it.symbol, it.price);
    }
    if (resolved > 0) console.log(`[price-binance] resolved ${resolved} signal(s) from ${syms.length} symbol price(s)`);
  } catch (e) {
    // Network blips, abort, JSON errors — all swallowed; we just try again next tick.
    if (e && e.name !== "AbortError") console.warn("[price-binance] poll failed:", e.message);
  }
}

function start(scoreboard, opts) {
  if (timer) return { enabled: true, already: true };
  if (typeof fetch !== "function") {
    console.warn("[price-binance] global fetch unavailable (Node < 18?) — crypto feed disabled.");
    return { enabled: false };
  }
  const intervalMs = (opts && opts.intervalMs) || DEFAULT_INTERVAL_MS;
  timer = setInterval(() => { pollOnce(scoreboard); }, intervalMs);
  if (timer.unref) timer.unref();
  setTimeout(() => pollOnce(scoreboard), 5000); // first poll shortly after boot
  console.log(`[price-binance] crypto price feed ON (every ${Math.round(intervalMs / 1000)}s, tracked symbols only)`);
  return { enabled: true };
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop };
