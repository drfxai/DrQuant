// services/easytrade-autopilot.js
// ============================================================================
// Easy Trade autonomous signal driver.
//
// Makes a "house" run rounds entirely on its own — no external indicator, no
// admin action — so the game is self-sustaining. For each managed house it:
//   1. opens a round at the LIVE market price with computed SL/TP levels,
//   2. feeds the live price in as the round progresses (so the chart animates),
//   3. settles the round the instant price crosses TP3 (win) or SL (loss),
//   4. immediately opens the next round.
//
// Everything is driven through easytrade.ingestEvent() — the exact same entry
// point the dedicated webhook uses — so there is ONE settlement path and the
// autopilot can never diverge from the manual/indicator flow.
//
// PRICES ARE REAL: it polls Binance's public ticker (no key) for the house's
// crypto products, exactly like services/price-binance.js. Houses are therefore
// driven on crypto symbols only; a house with no crypto product is skipped.
//
// OFF by default. Turn on with EASYTRADE_AUTOPILOT=on. Tunables (all optional):
//   EASYTRADE_AUTOPILOT_HOUSES=apex,godmode      (default: "apex")
//   EASYTRADE_AUTOPILOT_INTERVAL_SEC=20
//   EASYTRADE_AUTOPILOT_SL_PCT=0.5   TP1=0.3  TP2=0.45  TP3=0.6   (% of entry)
//   EASYTRADE_AUTOPILOT_MAX_AGE_MIN=25           (force-settle a stuck round)
//
// Point only AUTONOMOUS houses at the autopilot. Do NOT list a house that is
// also driven by a real indicator/webhook, or the two will fight (a fresh entry
// supersedes the open round and refunds its tickets — safe, but pointless).
//
// Defensive by contract: every tick is wrapped; nothing here throws into the
// event loop or blocks anything.
// ============================================================================
"use strict";

const easytrade = require("./easytrade");

const BINANCE_OK = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT"]);

let timer = null;
let cfg = null;
const ACTIVE = new Map(); // houseId -> { signalId, symbol, dir, entry, sl, tp1, tp2, tp3, openedAt }

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function readConfig() {
  const houses = String(process.env.EASYTRADE_AUTOPILOT_HOUSES || "apex")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    managed: new Set(houses),
    intervalMs: Math.max(5, num(process.env.EASYTRADE_AUTOPILOT_INTERVAL_SEC, 20)) * 1000,
    sl: num(process.env.EASYTRADE_AUTOPILOT_SL_PCT, 0.5) / 100,
    tp1: num(process.env.EASYTRADE_AUTOPILOT_TP1_PCT, 0.3) / 100,
    tp2: num(process.env.EASYTRADE_AUTOPILOT_TP2_PCT, 0.45) / 100,
    tp3: num(process.env.EASYTRADE_AUTOPILOT_TP3_PCT, 0.6) / 100,
    maxAgeMs: Math.max(1, num(process.env.EASYTRADE_AUTOPILOT_MAX_AGE_MIN, 25)) * 60 * 1000,
  };
}

function pickCryptoSymbol(products) {
  const c = (products || []).map((p) => String(p).toUpperCase()).filter((p) => BINANCE_OK.has(p));
  return c.length ? c[Math.floor(Math.random() * c.length)] : null;
}

function levels(price, dir) {
  const { sl, tp1, tp2, tp3 } = cfg;
  return dir === "long"
    ? { sl: price * (1 - sl), tp1: price * (1 + tp1), tp2: price * (1 + tp2), tp3: price * (1 + tp3) }
    : { sl: price * (1 + sl), tp1: price * (1 - tp1), tp2: price * (1 - tp2), tp3: price * (1 - tp3) };
}

async function fetchPrices(symbols) {
  const syms = symbols.filter((s) => BINANCE_OK.has(s));
  if (!syms.length) return {};
  const out = {};
  try {
    const q = encodeURIComponent(JSON.stringify(syms));
    const url = "https://api.binance.com/api/v3/ticker/price?symbols=" + q;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    let res;
    try { res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } }); }
    finally { clearTimeout(to); }
    if (!res || !res.ok) return {};
    const data = await res.json();
    if (Array.isArray(data)) for (const it of data) if (it && it.symbol && it.price != null) out[it.symbol] = Number(it.price);
  } catch (e) {
    if (e && e.name !== "AbortError") console.warn("[easytrade-autopilot] price fetch failed:", e.message);
  }
  return out;
}

async function safeIngest(houseId, payload) {
  try { return await easytrade.ingestEvent(houseId, payload); }
  catch (e) { console.warn("[easytrade-autopilot] ingest failed:", e.message); return false; }
}

async function openNew(house, symbol, price) {
  const dir = Math.random() < 0.5 ? "long" : "short";
  const lv = levels(price, dir);
  const signalId = "auto:" + house.id + ":" + symbol + ":" + Date.now();
  const out = await safeIngest(house.id, {
    event: "entry", signal_id: signalId, symbol, direction: dir,
    entry: price, sl: lv.sl, tp1: lv.tp1, tp2: lv.tp2, tp3: lv.tp3, price, tf: "auto",
  });
  if (out !== false) {
    ACTIVE.set(house.id, { signalId, symbol, dir, entry: price, sl: lv.sl, tp1: lv.tp1, tp2: lv.tp2, tp3: lv.tp3, openedAt: Date.now() });
  }
}

async function manageActive(house, r, price) {
  // feed the live price so the round's chart animates
  await safeIngest(house.id, { event: "price", signal_id: r.signalId, price });

  const long = r.dir === "long";
  let outcome = null;
  if (long) { if (price <= r.sl) outcome = "SL"; else if (price >= r.tp3) outcome = "TP"; }
  else { if (price >= r.sl) outcome = "SL"; else if (price <= r.tp3) outcome = "TP"; }

  // bound the duration: if it hasn't crossed in time, settle by which way it moved
  if (!outcome && Date.now() - r.openedAt > cfg.maxAgeMs) {
    const favorable = long ? price >= r.entry : price <= r.entry;
    outcome = favorable ? "TP" : "SL";
  }
  if (outcome) {
    const r2 = await safeIngest(house.id, {
      event: outcome === "TP" ? "tp3" : "sl", signal_id: r.signalId,
      result: outcome === "TP" ? "win" : "loss", price,
    });
    if (r2 !== false) ACTIVE.delete(house.id); // keep it to retry next tick if settle failed
  }
}

async function tick() {
  if (!cfg) return;
  let houses;
  try { houses = await easytrade.listHouses(); } catch (e) { return; }
  const managed = houses.filter((h) => cfg.managed.has(h.id));
  if (!managed.length) return;

  // decide the target symbol for each house (active round's symbol, or a fresh pick)
  const plan = [];
  for (const h of managed) {
    const active = ACTIVE.get(h.id);
    if (active) plan.push({ house: h, symbol: active.symbol, active });
    else {
      const sym = pickCryptoSymbol(h.products);
      if (sym) plan.push({ house: h, symbol: sym, active: null });
    }
  }
  if (!plan.length) return;

  const prices = await fetchPrices(Array.from(new Set(plan.map((p) => p.symbol))));
  for (const p of plan) {
    const price = prices[p.symbol];
    if (price == null) continue;
    try {
      if (p.active) await manageActive(p.house, p.active, price);
      else await openNew(p.house, p.symbol, price);
    } catch (e) { console.warn("[easytrade-autopilot] step failed:", e.message); }
  }
}

// Rebuild the in-memory map from DB open rounds so a restart keeps managing them.
async function rehydrate() {
  try {
    const rounds = await easytrade.listOpenRounds();
    for (const r of rounds) {
      if (!cfg.managed.has(r.house_id)) continue;
      const entry = Number(r.entry_price), sl = Number(r.sl_price), tp3 = Number(r.tp3_price);
      if (!Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(tp3)) continue;
      ACTIVE.set(r.house_id, {
        signalId: r.ext_id, symbol: r.symbol, dir: r.direction,
        entry, sl, tp1: Number(r.tp1_price), tp2: Number(r.tp2_price), tp3,
        openedAt: r.entered_at ? new Date(r.entered_at).getTime() : Date.now(),
      });
    }
    if (ACTIVE.size) console.log(`[easytrade-autopilot] resumed ${ACTIVE.size} open round(s)`);
  } catch (e) { /* non-critical */ }
}

function start() {
  if (timer) return { enabled: true, already: true };
  if (typeof fetch !== "function") {
    console.warn("[easytrade-autopilot] global fetch unavailable (Node < 18?) — autopilot disabled.");
    return { enabled: false };
  }
  cfg = readConfig();
  rehydrate();
  timer = setInterval(() => { tick().catch(() => {}); }, cfg.intervalMs);
  if (timer.unref) timer.unref();
  setTimeout(() => { tick().catch(() => {}); }, 6000);
  console.log(`[easytrade-autopilot] ON — houses=[${Array.from(cfg.managed).join(",")}] every ${Math.round(cfg.intervalMs / 1000)}s`);
  return { enabled: true };
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop };
