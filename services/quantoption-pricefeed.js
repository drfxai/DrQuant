// services/quantoption-pricefeed.js
// ============================================================================
// Quant Option — REAL market-data feed (server-side, key-safe).
//
// Single source of real prices for the wallet-connected Quant Option engine
// when QUANTOPTION_REAL_PRICES=true. Pure data: no DB, no ledger, no globals
// beyond a tiny spot cache. Every method THROWS on failure so the orchestrator
// can apply its fail-closed rule (refuse the open / settle VOID) — it never
// silently returns a fabricated price.
//
// Routing (symbol → provider):
//   crypto  BTC/ETH/SOL/BNB-USDT  → Binance  public REST (no API key)
//   FX/metal XAU/EUR/GBP-USD      → TwelveData (needs TWELVEDATA_API_KEY)
//
// The TwelveData key lives ONLY here, server-side. The browser must never hold
// it, which is exactly why FX/metal charts have to be proxied through the
// /api/quantoption/chart endpoint rather than fetched client-side.
//
// Candle shape (uniform across providers): { t, o, h, l, c }  (t = ms epoch)
// Settlement uses the finest interval each provider offers: Binance 1s,
// TwelveData 1min. So sub-minute FX/metal windows resolve on the single
// containing 1-min candle (approximate) — prefer >=3min expiries for FX/metal.
// Crypto resolves at 1-second fidelity.
// ============================================================================
"use strict";

// region-resilient Binance hosts; tried in order until one answers
const BINANCE_HOSTS = [
  "https://api.binance.com",
  "https://api-gcp.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
];
const TD_HOST = "https://api.twelvedata.com";
const TD_KEY = process.env.TWELVEDATA_API_KEY || "";

// QO symbol → Binance symbol (crypto only)
const CRYPTO = { BTCUSDT: "BTCUSDT", ETHUSDT: "ETHUSDT", SOLUSDT: "SOLUSDT", BNBUSDT: "BNBUSDT" };
// QO symbol → TwelveData symbol (FX / metals)
const TD_MAP = { XAUUSD: "XAU/USD", EURUSD: "EUR/USD", GBPUSD: "GBP/USD" };

const SPOT_TTL_MS = 1500;       // spot cache window (matches the ~1.5s walk feel)
const HTTP_TIMEOUT_MS = 8000;   // hard per-request timeout

function providerFor(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (CRYPTO[s]) return "binance";
  if (TD_MAP[s]) return "twelvedata";
  return null;
}
function isSupported(symbol) { return providerFor(symbol) != null; }

function badSymbol(symbol) {
  const e = new Error("unsupported symbol: " + symbol);
  e.code = "bad_symbol";
  return e;
}

// ── tiny fetch-JSON with hard timeout ────────────────────────────────────────
async function httpJson(url, timeout) {
  const ctrl = new AbortController();
  const to = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeout || HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!r.ok) { const e = new Error("http " + r.status + " " + url.split("?")[0]); e.status = r.status; throw e; }
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

function fmtUTC(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
    " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
}

// ── Binance (crypto) ─────────────────────────────────────────────────────────
async function binanceSpot(bsym) {
  let lastErr;
  for (const host of BINANCE_HOSTS) {
    try {
      const j = await httpJson(host + "/api/v3/ticker/price?symbol=" + encodeURIComponent(bsym));
      const p = Number(j && j.price);
      if (Number.isFinite(p) && p > 0) return p;
      throw new Error("binance: bad price payload");
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("binance spot failed");
}

async function binanceKlines(bsym, opts) {
  opts = opts || {};
  let qs = "symbol=" + encodeURIComponent(bsym) + "&interval=" + encodeURIComponent(opts.interval || "1s");
  if (opts.startMs != null) qs += "&startTime=" + Math.floor(opts.startMs);
  if (opts.endMs != null) qs += "&endTime=" + Math.floor(opts.endMs);
  qs += "&limit=" + Math.max(1, Math.min(1000, opts.limit || 1000));
  let lastErr;
  for (const host of BINANCE_HOSTS) {
    try {
      const arr = await httpJson(host + "/api/v3/klines?" + qs);
      if (!Array.isArray(arr)) throw new Error("binance: bad klines payload");
      const out = [];
      for (const k of arr) {
        // [ openTime, open, high, low, close, volume, closeTime, ... ]
        const t = Number(k[0]), o = Number(k[1]), h = Number(k[2]), l = Number(k[3]), c = Number(k[4]);
        if ([t, o, h, l, c].every(Number.isFinite)) out.push({ t, o, h, l, c });
      }
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("binance klines failed");
}

// ── TwelveData (FX / metals) ─────────────────────────────────────────────────
function tdRequireKey() {
  if (!TD_KEY) { const e = new Error("TWELVEDATA_API_KEY is not set"); e.code = "feed_unconfigured"; throw e; }
}

async function tdSpot(tdsym) {
  tdRequireKey();
  const j = await httpJson(TD_HOST + "/price?symbol=" + encodeURIComponent(tdsym) + "&apikey=" + encodeURIComponent(TD_KEY));
  const p = Number(j && j.price);
  if (!Number.isFinite(p) || p <= 0) {
    const e = new Error("twelvedata spot: " + ((j && (j.message || j.status)) || "bad payload"));
    throw e;
  }
  return p;
}

async function tdSeries(tdsym, opts) {
  tdRequireKey();
  opts = opts || {};
  let url = TD_HOST + "/time_series?symbol=" + encodeURIComponent(tdsym) +
    "&interval=" + encodeURIComponent(opts.interval || "1min") +
    "&outputsize=" + Math.max(1, Math.min(5000, opts.limit || 500)) +
    "&order=ASC&timezone=UTC&apikey=" + encodeURIComponent(TD_KEY);
  if (opts.startMs != null) url += "&start_date=" + encodeURIComponent(fmtUTC(opts.startMs));
  if (opts.endMs != null) url += "&end_date=" + encodeURIComponent(fmtUTC(opts.endMs));
  const j = await httpJson(url);
  if (!j || j.status === "error" || !Array.isArray(j.values)) {
    const e = new Error("twelvedata series: " + ((j && j.message) || "no values"));
    throw e;
  }
  const out = [];
  for (const v of j.values) {
    const t = Date.parse(String(v.datetime || "").replace(" ", "T") + "Z");
    const o = Number(v.open), h = Number(v.high), l = Number(v.low), c = Number(v.close);
    if ([t, o, h, l, c].every(Number.isFinite)) out.push({ t, o, h, l, c });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// ── public API ───────────────────────────────────────────────────────────────
const _spotCache = new Map(); // SYMBOL -> { p, at }

// latest price as a Number; throws on failure (caller fails closed)
async function getSpot(symbol, opts) {
  opts = opts || {};
  const prov = providerFor(symbol);
  if (!prov) throw badSymbol(symbol);
  const key = String(symbol).toUpperCase();
  const now = Date.now();
  const ttl = (opts.maxAgeMs != null) ? opts.maxAgeMs : SPOT_TTL_MS;
  const cached = _spotCache.get(key);
  if (cached && (now - cached.at) < ttl) return cached.p;
  const p = prov === "binance" ? await binanceSpot(CRYPTO[key]) : await tdSpot(TD_MAP[key]);
  _spotCache.set(key, { p, at: now });
  return p;
}

function fineInterval(prov) { return prov === "binance" ? "1s" : "1min"; }
function leadMs(prov) { return prov === "binance" ? 1000 : 60000; }

// finest-resolution candles overlapping [startMs, endMs], for settlement.
// Includes the single candle that CONTAINS startMs (one lead interval) so short
// FX/metal windows still have a candle to judge. Throws on failure.
async function getRange(symbol, startMs, endMs) {
  const prov = providerFor(symbol);
  if (!prov) throw badSymbol(symbol);
  const key = String(symbol).toUpperCase();
  const interval = fineInterval(prov);
  const candles = prov === "binance"
    ? await binanceKlines(CRYPTO[key], { interval, startMs, endMs, limit: 1000 })
    : await tdSeries(TD_MAP[key], { interval, startMs, endMs, limit: 5000 });
  const lo = startMs - leadMs(prov), hi = endMs + 1;
  return candles.filter((k) => k.t >= lo && k.t <= hi);
}

// recent N candles for charting (server-proxied so the TD key never reaches the
// browser). Throws on failure.
async function getCandles(symbol, opts) {
  opts = opts || {};
  const prov = providerFor(symbol);
  if (!prov) throw badSymbol(symbol);
  const key = String(symbol).toUpperCase();
  const limit = Math.max(10, Math.min(500, opts.limit || 200));
  const interval = opts.interval || (prov === "binance" ? "1m" : "1min");
  return prov === "binance"
    ? await binanceKlines(CRYPTO[key], { interval, limit })
    : await tdSeries(TD_MAP[key], { interval, limit });
}

module.exports = { providerFor, isSupported, getSpot, getRange, getCandles };
