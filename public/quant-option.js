/* ===========================================================================
 * quant-option.js - "Quant Option" internal options-simulation sandbox (v1)
 * ---------------------------------------------------------------------------
 * A new in-app section in DrFX Quant (mounted like Easy Trade). Mobile-first.
 *
 * v1 SCOPE (this file): the core trade loop, fully end-to-end on a SIMULATED
 * price feed (random-walk candles). No real money, no backend, no brokerage.
 *   - OptionTicket: symbol / direction (Long|Short) / stake / expiry
 *   - live price + lightweight chart, target & stop preview
 *   - open position -> live countdown + live PnL
 *   - resolution: Target hit (Win) / Stop hit (Lose) / Expiry (distance rule:
 *       closer to target = Win, closer to stop = Lose, equal = Draw/refund)
 *   - token balance update (LOCAL simulated balance, persisted in localStorage)
 *   - result popup (Win / Lose / Draw) + compact trade history
 *
 * LATER (not here): real price feed + TradingView God Mode, server token
 * ledger, leaderboard/journal/greeks. The feed and balance are deliberately
 * isolated behind small seams so they can be swapped without touching the UI.
 *
 * Exposes: window.openQuantOption(), window.dqQuantOption = { open, _pure }.
 * Load after easytrade-hub.js (uses window.dqAppNav for the bottom bar).
 * =========================================================================== */
(function () {
  "use strict";
  if (window.__dqQuantOption) return;
  window.__dqQuantOption = true;

  /* ----------------------------------------------------------------------- */
  /* Config                                                                  */
  /* ----------------------------------------------------------------------- */
  var SYMBOLS = [
    { s: "BTC/USDT", p: 67000, vol: 0.0009, dp: 1 },
    { s: "ETH/USDT", p: 3500, vol: 0.0011, dp: 2 },
    { s: "SOL/USDT", p: 165, vol: 0.0016, dp: 2 },
    { s: "BNB/USDT", p: 600, vol: 0.0012, dp: 2 },
    { s: "XAU/USD", p: 2350, vol: 0.0004, dp: 2 },
    { s: "EUR/USD", p: 1.085, vol: 0.0003, dp: 5 }
  ];
  var EXPIRIES = [
    { l: "30s", s: 30 }, { l: "1m", s: 60 }, { l: "2m", s: 120 },
    { l: "3m", s: 180 }, { l: "5m", s: 300 }, { l: "10m", s: 600 }, { l: "15m", s: 900 }
  ];
  var PAYOUT = 0.85;        // a Win returns stake*(1+PAYOUT); profit = stake*PAYOUT
  var STEP = 220;          // ms per simulated tick
  var HIST_MAX = 240;      // points kept per symbol for the chart
  var START_BALANCE = 10000;
  var BAL_KEY = "dqqo_bal";
  var HIST_KEY = "dqqo_hist";
  var OV_ID = "qo-ov";

  /* ----------------------------------------------------------------------- */
  /* Theme (cohesive dark palette; reads app `t` where useful)               */
  /* ----------------------------------------------------------------------- */
  function TH() {
    var x = (typeof t !== "undefined" && t) ? t : {};
    return {
      bg: "#070b16",
      panel: "#0e1626",
      panel2: "#111b2e",
      bd: "rgba(120,150,200,.16)",
      bdSoft: "rgba(120,150,200,.10)",
      t1: "#e9f0fc",
      t2: "#9fb0cc",
      t3: "#6f819e",
      blue: x.pr || "#3b82f6",
      blueGlow: x.pgw || "rgba(59,130,246,.5)",
      green: "#22c55e",
      greenD: "#16a34a",
      red: "#f43f5e",
      redD: "#e11d48",
      gold: "#ffcf5a"
    };
  }

  /* ----------------------------------------------------------------------- */
  /* Pure engine helpers (testable; no DOM)                                  */
  /* ----------------------------------------------------------------------- */
  function gauss() {
    var u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  // Symmetric target/stop offset ~ expected move over the expiry (slightly inside,
  // so outcomes are lively but roughly fair).
  function computeOffset(entry, vol, expSec, stepMs) {
    var steps = (expSec * 1000) / (stepMs || STEP);
    var expMove = entry * vol * Math.sqrt(Math.max(1, steps));
    return expMove * 0.9;
  }
  // Early hit while live: returns "win" (target) | "lose" (stop) | null.
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
  // At expiry with no hit: distance rule.
  function expiryOutcome(price, target, stop) {
    var dT = Math.abs(price - target), dS = Math.abs(price - stop);
    var eps = Math.abs(target - stop) * 1e-9;
    if (Math.abs(dT - dS) <= eps) return "draw";
    return dT < dS ? "win" : "lose";
  }
  // Token settlement for an outcome (stake already deducted at open).
  function settle(outcome, stake, payout) {
    if (outcome === "win") return { credit: stake * (1 + payout), profit: stake * payout };
    if (outcome === "draw") return { credit: stake, profit: 0 };
    return { credit: 0, profit: -stake };
  }

  /* ----------------------------------------------------------------------- */
  /* State                                                                   */
  /* ----------------------------------------------------------------------- */
  var ST = {
    symIdx: 0, dir: "long", stake: 100, expIdx: 1,
    prices: {}, hist: {},
    pos: null,
    overlayOpen: false,
    ticker: null,
    tab: "trade"   // "trade" | "history"
  };

  function curSym() { return SYMBOLS[ST.symIdx]; }
  function getBal() {
    try { var v = parseFloat(localStorage.getItem(BAL_KEY)); if (isFinite(v)) return v; } catch (e) {}
    return START_BALANCE;
  }
  function setBal(v) { try { localStorage.setItem(BAL_KEY, String(v)); } catch (e) {} }
  function getHistory() {
    try { var a = JSON.parse(localStorage.getItem(HIST_KEY)); if (a && a.length) return a; } catch (e) {}
    return [];
  }
  function pushHistory(rec) {
    var a = getHistory(); a.unshift(rec); if (a.length > 40) a = a.slice(0, 40);
    try { localStorage.setItem(HIST_KEY, JSON.stringify(a)); } catch (e) {}
  }

  /* ----------------------------------------------------------------------- */
  /* Simulated price feed                                                    */
  /* ----------------------------------------------------------------------- */
  function initPrices() {
    SYMBOLS.forEach(function (sy) {
      if (ST.prices[sy.s] == null) {
        var x = sy.p, arr = [];
        for (var i = 0; i < HIST_MAX; i++) { x = x * (1 + gauss() * sy.vol); arr.push(x); }
        ST.prices[sy.s] = x;
        ST.hist[sy.s] = arr;
      }
    });
  }
  function startTicker() { if (!ST.ticker) ST.ticker = setInterval(tick, STEP); }
  function stopTicker() { if (ST.ticker) { clearInterval(ST.ticker); ST.ticker = null; } }
  function tick() {
    for (var i = 0; i < SYMBOLS.length; i++) {
      var sy = SYMBOLS[i], cur = ST.prices[sy.s] * (1 + gauss() * sy.vol);
      ST.prices[sy.s] = cur;
      var h = ST.hist[sy.s]; h.push(cur); if (h.length > HIST_MAX) h.shift();
    }
    if (ST.pos) checkResolve();
    if (ST.overlayOpen) renderLive();
    if (!ST.overlayOpen && !ST.pos) stopTicker();
  }

  /* ----------------------------------------------------------------------- */
  /* Trade lifecycle                                                         */
  /* ----------------------------------------------------------------------- */
  function openPosition() {
    if (ST.pos) return;
    var sy = curSym(), entry = ST.prices[sy.s], stake = +ST.stake, bal = getBal();
    if (!(stake > 0)) { flash("Enter a stake"); return; }
    if (stake > bal) { flash("Not enough tokens"); return; }
    var expS = EXPIRIES[ST.expIdx].s;
    var offset = computeOffset(entry, sy.vol, expS, STEP);
    var dir = ST.dir;
    var target = dir === "long" ? entry + offset : entry - offset;
    var stop = dir === "long" ? entry - offset : entry + offset;
    setBal(bal - stake);
    ST.pos = {
      sy: sy.s, dp: sy.dp, dir: dir, entry: entry, target: target, stop: stop, offset: offset,
      stake: stake, payout: PAYOUT, openAt: Date.now(), expAt: Date.now() + expS * 1000, expS: expS
    };
    startTicker();
    ST.tab = "trade";
    rebuildStage();
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) {} }
  }

  function checkResolve() {
    var p = ST.pos; if (!p) return;
    var price = ST.prices[p.sy];
    var oc = hitOutcome(p.dir, price, p.target, p.stop);
    if (oc) return resolve(oc, price, oc === "win" ? "Target hit" : "Stop hit");
    if (Date.now() >= p.expAt) {
      var eo = expiryOutcome(price, p.target, p.stop);
      var reason = eo === "draw" ? "Expiry - equal distance" : (eo === "win" ? "Expiry - closer to target" : "Expiry - closer to stop");
      return resolve(eo, price, reason);
    }
  }

  function resolve(outcome, price, reason) {
    var p = ST.pos; if (!p) return;
    ST.pos = null;
    var s = settle(outcome, p.stake, p.payout);
    setBal(getBal() + s.credit);
    var rec = {
      outcome: outcome, reason: reason, sy: p.sy, dp: p.dp, dir: p.dir,
      entry: p.entry, exit: price, target: p.target, stop: p.stop,
      stake: p.stake, profit: s.profit, at: Date.now(), dur: Math.max(1, Math.round((Date.now() - p.openAt) / 1000))
    };
    pushHistory(rec);
    if (ST.overlayOpen) { showResult(rec); rebuildStage(); }
    else { toastResult(rec); }
    if (!ST.overlayOpen && !ST.pos) stopTicker();
  }

  /* ----------------------------------------------------------------------- */
  /* Formatting helpers                                                      */
  /* ----------------------------------------------------------------------- */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function fmtP(v, dp) { if (!isFinite(v)) return "-"; return Number(v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }); }
  function fmtTok(v) { var n = Math.round(Number(v) || 0); return n.toLocaleString(); }
  function fmtSigned(v) { var n = Number(v) || 0; return (n >= 0 ? "+" : "-") + fmtTok(Math.abs(n)); }
  function mmss(ms) { var s = Math.max(0, Math.ceil(ms / 1000)); var m = Math.floor(s / 60); var r = s % 60; return m + ":" + (r < 10 ? "0" : "") + r; }

  function flash(msg) {
    if (window.showToast) { try { window.showToast("Quant Option", msg); return; } catch (e) {} }
    var n = document.getElementById("qo-flash");
    if (!n) {
      n = document.createElement("div"); n.id = "qo-flash";
      n.style.cssText = "position:fixed;left:50%;bottom:calc(86px + var(--sab));transform:translateX(-50%);z-index:6200;padding:9px 16px;border-radius:12px;background:rgba(20,28,46,.96);color:#fff;font-size:13px;font-weight:600;border:1px solid rgba(120,150,200,.3);box-shadow:0 8px 26px rgba(0,0,0,.5);pointer-events:none";
      document.body.appendChild(n);
    }
    n.textContent = msg; n.style.opacity = "1";
    clearTimeout(n._t); n._t = setTimeout(function () { n.style.transition = "opacity .3s"; n.style.opacity = "0"; }, 1600);
  }
  function toastResult(rec) {
    var label = rec.outcome === "win" ? "WIN" : rec.outcome === "draw" ? "DRAW" : "LOSE";
    flash(rec.sy + " - " + label + " " + fmtSigned(rec.profit) + " tokens");
  }

  /* ----------------------------------------------------------------------- */
  /* Chart (live sparkline + target/stop lines)                              */
  /* ----------------------------------------------------------------------- */
  function drawChart() {
    var cv = document.getElementById("qo-chart"); if (!cv) return;
    var sy = curSym(), data = ST.hist[sy.s] || [];
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || 320, h = cv.clientHeight || 150;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    var ctx = cv.getContext("2d"); if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    var TC = TH();
    var view = data.slice(-Math.min(data.length, 160));
    if (view.length < 2) return;
    var lo = Math.min.apply(null, view), hi = Math.max.apply(null, view);
    var p = ST.pos;
    if (p && p.sy === sy.s) { lo = Math.min(lo, p.target, p.stop); hi = Math.max(hi, p.target, p.stop); }
    var pad = (hi - lo) * 0.12 || hi * 0.001 || 1; lo -= pad; hi += pad;
    var span = (hi - lo) || 1;
    var X = function (i) { return (i / (view.length - 1)) * w; };
    var Y = function (v) { return h - ((v - lo) / span) * h; };

    // target / stop guide lines
    if (p && p.sy === sy.s) {
      [[p.target, TC.green], [p.stop, TC.red], [p.entry, "rgba(180,200,235,.5)"]].forEach(function (g) {
        var y = Y(g[0]); ctx.strokeStyle = g[1]; ctx.lineWidth = 1; ctx.setLineDash([5, 5]);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); ctx.setLineDash([]);
      });
    }
    // area + line
    var up = view[view.length - 1] >= view[0];
    var line = up ? TC.green : TC.red;
    var grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, up ? "rgba(34,197,94,.28)" : "rgba(244,63,94,.26)");
    grad.addColorStop(1, "rgba(10,16,30,0)");
    ctx.beginPath(); ctx.moveTo(0, Y(view[0]));
    for (var i = 1; i < view.length; i++) ctx.lineTo(X(i), Y(view[i]));
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, Y(view[0]));
    for (var j = 1; j < view.length; j++) ctx.lineTo(X(j), Y(view[j]));
    ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
    // last dot
    var lx = X(view.length - 1), ly = Y(view[view.length - 1]);
    ctx.beginPath(); ctx.arc(lx, ly, 3.2, 0, Math.PI * 2); ctx.fillStyle = line; ctx.fill();
    ctx.beginPath(); ctx.arc(lx, ly, 6.5, 0, Math.PI * 2); ctx.fillStyle = up ? "rgba(34,197,94,.18)" : "rgba(244,63,94,.18)"; ctx.fill();
  }

  /* ----------------------------------------------------------------------- */
  /* Rendering: shell + stage                                                */
  /* ----------------------------------------------------------------------- */
  function headerHTML() {
    var TC = TH();
    return '' +
      '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px 8px;flex-shrink:0">' +
        '<button id="qo-x" type="button" title="Close" style="width:36px;height:36px;border-radius:11px;border:1px solid ' + TC.bd + ';background:' + TC.panel + ';color:' + TC.t2 + ';cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;-webkit-tap-highlight-color:transparent"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="15" y1="6" x2="9" y2="12"/><line x1="9" y1="12" x2="15" y2="18"/></svg></button>' +
        '<div style="flex:1;min-width:0;line-height:1.1"><div style="font-size:16px;font-weight:800;color:' + TC.t1 + ';letter-spacing:.2px">Quant<span style="color:' + TC.blue + '"> Option</span></div><div style="font-size:10px;color:' + TC.t3 + '">Learn. Simulate. Analyze.</div></div>' +
        '<div style="display:flex;align-items:center;gap:7px;padding:7px 11px;border-radius:13px;background:' + TC.panel + ';border:1px solid ' + TC.bd + ';flex-shrink:0">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" fill="' + TC.gold + '" opacity=".18"/><circle cx="12" cy="12" r="9" stroke="' + TC.gold + '" stroke-width="1.4"/><path d="M12 7v10M9 9.5h4.2a1.8 1.8 0 0 1 0 3.5H10a1.8 1.8 0 0 0 0 3.5H15" stroke="' + TC.gold + '" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>' +
          '<div style="line-height:1.05"><div style="font-size:8px;letter-spacing:.5px;color:' + TC.t3 + ';font-weight:700">TOKENS</div><div id="qo-bal" style="font-size:13px;font-weight:800;color:' + TC.t1 + '">' + fmtTok(getBal()) + '</div></div>' +
        '</div>' +
      '</div>' +
      '<div style="margin:0 12px 8px;display:flex;align-items:center;gap:7px;padding:6px 11px;border-radius:11px;background:rgba(255,196,64,.08);border:1px solid rgba(255,196,64,.28);flex-shrink:0">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="' + TC.gold + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>' +
        '<div style="font-size:10.5px;color:' + TC.gold + ';font-weight:600">PAPER MODE - simulation only. No real money. Tokens are not redeemable.</div>' +
      '</div>';
  }

  function symbolRowHTML() {
    var TC = TH();
    var chips = SYMBOLS.map(function (sy, i) {
      var on = i === ST.symIdx;
      return '<button type="button" class="qo-sym" data-i="' + i + '" style="flex-shrink:0;display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:7px 11px;border-radius:11px;cursor:pointer;border:1px solid ' + (on ? TC.blue : TC.bd) + ';background:' + (on ? "rgba(59,130,246,.14)" : TC.panel) + ';-webkit-tap-highlight-color:transparent">' +
        '<span style="font-size:11.5px;font-weight:700;color:' + (on ? TC.t1 : TC.t2) + ';white-space:nowrap">' + esc(sy.s) + '</span>' +
        '<span class="qo-symp" data-i="' + i + '" style="font-size:10px;font-weight:600;color:' + TC.t3 + '">' + fmtP(ST.prices[sy.s], sy.dp) + '</span>' +
      '</button>';
    }).join("");
    return '<div style="display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding:0 12px 10px;flex-shrink:0">' + chips + '</div>';
  }

  function chartHTML() {
    var TC = TH(), sy = curSym();
    return '<div style="margin:0 12px 10px;border-radius:16px;background:' + TC.panel + ';border:1px solid ' + TC.bd + ';overflow:hidden;flex-shrink:0">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px 4px"><div style="font-size:12px;font-weight:700;color:' + TC.t2 + '">' + esc(sy.s) + '</div><div id="qo-price" style="font-size:15px;font-weight:800;color:' + TC.t1 + '">' + fmtP(ST.prices[sy.s], sy.dp) + '</div></div>' +
      '<canvas id="qo-chart" style="display:block;width:100%;height:140px"></canvas>' +
    '</div>';
  }

  function ticketHTML() {
    var TC = TH(), sy = curSym(), bal = getBal();
    var entry = ST.prices[sy.s];
    var offset = computeOffset(entry, sy.vol, EXPIRIES[ST.expIdx].s, STEP);
    var tgt = ST.dir === "long" ? entry + offset : entry - offset;
    var stp = ST.dir === "long" ? entry - offset : entry + offset;
    var longOn = ST.dir === "long";
    var maxStake = Math.max(100, Math.floor(bal));
    var stakeChips = [10, 50, 100, 500].map(function (v) {
      return '<button type="button" class="qo-stk" data-v="' + v + '" style="flex:1;padding:8px 0;border-radius:10px;border:1px solid ' + TC.bd + ';background:' + TC.panel + ';color:' + TC.t2 + ';font-size:12px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent">' + v + '</button>';
    }).join("") + '<button type="button" class="qo-stk" data-v="max" style="flex:1;padding:8px 0;border-radius:10px;border:1px solid ' + TC.bd + ';background:' + TC.panel + ';color:' + TC.blue + ';font-size:12px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent">MAX</button>';
    var expChips = EXPIRIES.map(function (e, i) {
      var on = i === ST.expIdx;
      return '<button type="button" class="qo-exp" data-i="' + i + '" style="flex-shrink:0;padding:7px 13px;border-radius:10px;border:1px solid ' + (on ? TC.blue : TC.bd) + ';background:' + (on ? "rgba(59,130,246,.16)" : TC.panel) + ';color:' + (on ? TC.t1 : TC.t2) + ';font-size:12px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent">' + e.l + '</button>';
    }).join("");
    var payout = ST.stake * (1 + PAYOUT);

    return '<div style="padding:0 12px 14px">' +
      '<div style="display:flex;gap:8px;margin-bottom:11px">' +
        '<button type="button" id="qo-long" style="flex:1;padding:13px 0;border-radius:13px;border:1px solid ' + (longOn ? TC.green : TC.bd) + ';background:' + (longOn ? "linear-gradient(180deg," + TC.green + "," + TC.greenD + ")" : TC.panel) + ';color:' + (longOn ? "#04140c" : TC.t2) + ';font-size:14px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;-webkit-tap-highlight-color:transparent"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 14 12 8 18 14"/></svg>LONG</button>' +
        '<button type="button" id="qo-short" style="flex:1;padding:13px 0;border-radius:13px;border:1px solid ' + (!longOn ? TC.red : TC.bd) + ';background:' + (!longOn ? "linear-gradient(180deg," + TC.red + "," + TC.redD + ")" : TC.panel) + ';color:' + (!longOn ? "#1a0408" : TC.t2) + ';font-size:14px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;-webkit-tap-highlight-color:transparent"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 10 12 16 18 10"/></svg>SHORT</button>' +
      '</div>' +
      '<div style="font-size:11px;color:' + TC.t3 + ';font-weight:600;margin-bottom:6px">STAKE (tokens)</div>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
        '<input id="qo-stake" type="number" inputmode="numeric" min="1" step="1" value="' + ST.stake + '" style="flex:1;padding:11px 12px;border-radius:11px;border:1px solid ' + TC.bd + ';background:' + TC.panel2 + ';color:' + TC.t1 + ';font-size:15px;font-weight:700;outline:none;-webkit-appearance:none"/>' +
      '</div>' +
      '<input id="qo-stake-range" type="range" min="1" max="' + maxStake + '" value="' + Math.min(ST.stake, maxStake) + '" style="width:100%;margin:2px 0 9px;accent-color:' + TC.blue + '"/>' +
      '<div style="display:flex;gap:7px;margin-bottom:13px">' + stakeChips + '</div>' +
      '<div style="font-size:11px;color:' + TC.t3 + ';font-weight:600;margin-bottom:6px">EXPIRY</div>' +
      '<div style="display:flex;gap:7px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:3px;margin-bottom:13px">' + expChips + '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px">' +
        previewCell("ENTRY", fmtP(entry, sy.dp), TC.t1, TC) +
        previewCell("TARGET", fmtP(tgt, sy.dp), TC.green, TC) +
        previewCell("STOP", fmtP(stp, sy.dp), TC.red, TC) +
      '</div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:11px 13px;border-radius:12px;background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.22);margin-bottom:13px">' +
        '<span style="font-size:12px;color:' + TC.t2 + '">Potential payout</span>' +
        '<span id="qo-payout" style="font-size:15px;font-weight:800;color:' + TC.blue + '">' + fmtTok(payout) + ' <span style="font-size:11px;color:' + TC.t3 + ';font-weight:600">(+' + Math.round(PAYOUT * 100) + '%)</span></span>' +
      '</div>' +
      '<button type="button" id="qo-open" style="width:100%;padding:15px 0;border-radius:14px;border:none;cursor:pointer;font-size:15px;font-weight:800;color:#fff;background:linear-gradient(180deg,' + TC.blue + ',#2456d8);box-shadow:0 8px 24px ' + TC.blueGlow + ';-webkit-tap-highlight-color:transparent">Open ' + (longOn ? "Long" : "Short") + ' Position</button>' +
    '</div>';
  }

  function previewCell(label, val, color, TC) {
    return '<div style="padding:9px 10px;border-radius:11px;background:' + TC.panel + ';border:1px solid ' + TC.bd + '"><div style="font-size:9px;color:' + TC.t3 + ';font-weight:700;letter-spacing:.4px;margin-bottom:2px">' + label + '</div><div style="font-size:13px;font-weight:800;color:' + color + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + val + '</div></div>';
  }

  function livePositionHTML() {
    var TC = TH(), p = ST.pos;
    var dirCol = p.dir === "long" ? TC.green : TC.red;
    return '<div style="padding:0 12px 14px">' +
      '<div style="border-radius:16px;background:' + TC.panel + ';border:1px solid ' + TC.bd + ';overflow:hidden">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid ' + TC.bdSoft + '">' +
          '<div style="display:flex;align-items:center;gap:8px"><span style="padding:3px 9px;border-radius:8px;font-size:11px;font-weight:800;color:' + (p.dir === "long" ? "#04140c" : "#1a0408") + ';background:' + dirCol + '">' + (p.dir === "long" ? "LONG" : "SHORT") + '</span><span style="font-size:13px;font-weight:700;color:' + TC.t1 + '">' + esc(p.sy) + '</span></div>' +
          '<div style="text-align:right;line-height:1.05"><div style="font-size:9px;color:' + TC.t3 + ';font-weight:700">TIME LEFT</div><div id="qo-count" style="font-size:18px;font-weight:800;color:' + TC.gold + ';font-variant-numeric:tabular-nums">' + mmss(p.expAt - Date.now()) + '</div></div>' +
        '</div>' +
        '<div style="height:4px;background:' + TC.bdSoft + '"><div id="qo-progress" style="height:100%;width:0%;background:' + TC.gold + '"></div></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;background:' + TC.bdSoft + '">' +
          liveCell("ENTRY", fmtP(p.entry, p.dp), TC.t1, TC, "") +
          liveCell("LIVE", fmtP(ST.prices[p.sy], p.dp), TC.t1, TC, "qo-live-price") +
          liveCell("TARGET", fmtP(p.target, p.dp), TC.green, TC, "") +
          liveCell("STOP", fmtP(p.stop, p.dp), TC.red, TC, "") +
        '</div>' +
        '<div style="padding:13px 14px;text-align:center;background:' + TC.panel2 + '">' +
          '<div style="font-size:10px;color:' + TC.t3 + ';font-weight:700;letter-spacing:.5px;margin-bottom:3px">UNREALIZED</div>' +
          '<div id="qo-upnl" style="font-size:22px;font-weight:800;color:' + TC.t2 + '">' + fmtSigned(0) + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="margin-top:11px;font-size:11px;color:' + TC.t3 + ';text-align:center;line-height:1.5">Resolves on Target hit, Stop hit, or at expiry<br>(closest of target/stop wins; exact tie refunds).</div>' +
    '</div>';
  }
  function liveCell(label, val, color, TC, id) {
    return '<div style="padding:11px 13px;background:' + TC.panel + '"><div style="font-size:9px;color:' + TC.t3 + ';font-weight:700;letter-spacing:.4px;margin-bottom:2px">' + label + '</div><div ' + (id ? 'id="' + id + '" ' : "") + 'style="font-size:14px;font-weight:800;color:' + color + ';font-variant-numeric:tabular-nums">' + val + '</div></div>';
  }

  function historyHTML() {
    var TC = TH(), list = getHistory();
    if (!list.length) return '<div style="padding:30px 20px;text-align:center;color:' + TC.t3 + ';font-size:13px">No trades yet. Open a position to get started.</div>';
    var rows = list.map(function (r) {
      var col = r.outcome === "win" ? TC.green : r.outcome === "draw" ? TC.gold : TC.red;
      var lbl = r.outcome === "win" ? "WIN" : r.outcome === "draw" ? "DRAW" : "LOSE";
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;background:' + TC.panel + ';border:1px solid ' + TC.bd + ';margin-bottom:7px">' +
        '<div style="width:6px;height:34px;border-radius:3px;background:' + col + ';flex-shrink:0"></div>' +
        '<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;color:' + TC.t1 + '">' + esc(r.sy) + ' <span style="font-size:10px;font-weight:700;color:' + (r.dir === "long" ? TC.green : TC.red) + '">' + (r.dir === "long" ? "LONG" : "SHORT") + '</span></div><div style="font-size:10.5px;color:' + TC.t3 + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(r.reason) + ' - ' + r.dur + 's</div></div>' +
        '<div style="text-align:right"><div style="font-size:11px;font-weight:800;color:' + col + '">' + lbl + '</div><div style="font-size:12px;font-weight:700;color:' + col + '">' + fmtSigned(r.profit) + '</div></div>' +
      '</div>';
    }).join("");
    return '<div style="padding:0 12px 14px">' + rows + '</div>';
  }

  function tabsHTML() {
    var TC = TH();
    function tb(id, label) {
      var on = ST.tab === id;
      return '<button type="button" class="qo-tab" data-tab="' + id + '" style="flex:1;padding:9px 0;background:none;border:none;border-bottom:2px solid ' + (on ? TC.blue : "transparent") + ';color:' + (on ? TC.t1 : TC.t3) + ';font-size:13px;font-weight:700;cursor:pointer;-webkit-tap-highlight-color:transparent">' + label + '</button>';
    }
    return '<div style="display:flex;margin:0 12px 10px;border-bottom:1px solid ' + TC.bdSoft + ';flex-shrink:0">' + tb("trade", ST.pos ? "Position" : "Trade") + tb("history", "History") + '</div>';
  }

  // The scrollable stage (everything between header and bottom nav). Rebuilt on
  // state changes (symbol/dir/expiry/open/resolve/tab); per-tick updates are
  // done in-place by renderLive() to stay smooth.
  function stageHTML() {
    var body;
    if (ST.tab === "history") body = historyHTML();
    else body = (ST.pos ? livePositionHTML() : ticketHTML());
    return symbolRowHTML() + chartHTML() + tabsHTML() + '<div id="qo-stagebody">' + body + '</div>';
  }

  function rebuildStage() {
    var st = document.getElementById("qo-stage"); if (!st) return;
    st.innerHTML = stageHTML();
    wireStage();
    drawChart();
  }

  /* ----------------------------------------------------------------------- */
  /* Result popup                                                            */
  /* ----------------------------------------------------------------------- */
  function showResult(rec) {
    var TC = TH();
    var win = rec.outcome === "win", draw = rec.outcome === "draw";
    var col = win ? TC.green : draw ? TC.gold : TC.red;
    var title = win ? "WIN" : draw ? "DRAW" : "LOSE";
    var icon = win
      ? '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'
      : draw ? '<path d="M3 12h18M3 6h18M3 18h18"/>'
      : '<circle cx="12" cy="12" r="9"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>';
    var ov = document.createElement("div");
    ov.id = "qo-result";
    ov.style.cssText = "position:fixed;inset:0;z-index:6300;display:flex;align-items:center;justify-content:center;padding:22px;background:rgba(3,6,14,.74);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)";
    ov.innerHTML =
      '<div style="width:min(360px,92vw);border-radius:22px;background:' + TC.panel + ';border:1px solid ' + TC.bd + ';box-shadow:0 24px 70px rgba(0,0,0,.6);overflow:hidden;animation:qoPop .26s cubic-bezier(.2,.8,.3,1)">' +
        '<div style="padding:26px 22px 18px;text-align:center;background:radial-gradient(120% 100% at 50% 0%,' + (win ? "rgba(34,197,94,.22)" : draw ? "rgba(255,207,90,.18)" : "rgba(244,63,94,.20)") + ',transparent)">' +
          '<svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="' + col + '" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="filter:drop-shadow(0 0 14px ' + col + '88)">' + icon + '</svg>' +
          '<div style="font-size:30px;font-weight:900;letter-spacing:2px;color:' + col + ';margin-top:8px">' + title + '</div>' +
          '<div style="font-size:24px;font-weight:800;color:' + TC.t1 + ';margin-top:6px">' + fmtSigned(rec.profit) + ' <span style="font-size:13px;color:' + TC.t3 + '">tokens</span></div>' +
          '<div style="font-size:11px;color:' + TC.t3 + ';margin-top:3px">' + esc(rec.reason) + '</div>' +
        '</div>' +
        '<div style="padding:14px 18px 4px">' +
          rowKV("Symbol", esc(rec.sy), TC) +
          rowKV("Direction", (rec.dir === "long" ? "Long" : "Short"), TC) +
          rowKV("Entry", fmtP(rec.entry, rec.dp), TC) +
          rowKV("Exit", fmtP(rec.exit, rec.dp), TC) +
          rowKV("Stake", fmtTok(rec.stake) + " tokens", TC) +
          rowKV("New balance", fmtTok(getBal()) + " tokens", TC) +
        '</div>' +
        '<div style="padding:14px 18px 18px"><button type="button" id="qo-result-x" style="width:100%;padding:13px 0;border-radius:13px;border:none;cursor:pointer;font-size:14px;font-weight:800;color:#fff;background:linear-gradient(180deg,' + TC.blue + ',#2456d8)">Back to Trade</button></div>' +
      '</div>';
    document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    var b = ov.querySelector("#qo-result-x"); if (b) b.onclick = close;
    if (navigator.vibrate) { try { navigator.vibrate(win ? [10, 40, 10] : 20); } catch (e) {} }
  }
  function rowKV(k, v, TC) {
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid ' + TC.bdSoft + '"><span style="font-size:12.5px;color:' + TC.t3 + '">' + k + '</span><span style="font-size:12.5px;font-weight:700;color:' + TC.t1 + '">' + v + '</span></div>';
  }

  /* ----------------------------------------------------------------------- */
  /* Per-tick live updates (in place)                                        */
  /* ----------------------------------------------------------------------- */
  function renderLive() {
    var sy = curSym();
    var balEl = document.getElementById("qo-bal"); if (balEl) balEl.textContent = fmtTok(getBal());
    var priceEl = document.getElementById("qo-price"); if (priceEl) priceEl.textContent = fmtP(ST.prices[sy.s], sy.dp);
    var chips = document.querySelectorAll(".qo-symp");
    for (var i = 0; i < chips.length; i++) { var idx = +chips[i].getAttribute("data-i"); chips[i].textContent = fmtP(ST.prices[SYMBOLS[idx].s], SYMBOLS[idx].dp); }
    drawChart();
    var p = ST.pos;
    if (p) {
      var TC = TH();
      var price = ST.prices[p.sy];
      var lp = document.getElementById("qo-live-price"); if (lp) lp.textContent = fmtP(price, p.dp);
      var cnt = document.getElementById("qo-count"); if (cnt) cnt.textContent = mmss(p.expAt - Date.now());
      var pr = document.getElementById("qo-progress");
      if (pr) { var pct = Math.min(100, Math.max(0, (1 - (p.expAt - Date.now()) / (p.expS * 1000)) * 100)); pr.style.width = pct + "%"; }
      var up = document.getElementById("qo-upnl");
      if (up) {
        var prog = (price - p.entry) / (p.target - p.entry); // 1 at target, -1 at stop (symmetric)
        var u;
        if (prog >= 0) u = Math.min(1, prog) * (p.stake * p.payout);
        else u = Math.max(-1, prog) * p.stake;
        up.textContent = fmtSigned(u);
        up.style.color = u > 0.5 ? TC.green : u < -0.5 ? TC.red : TC.t2;
      }
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Wiring                                                                  */
  /* ----------------------------------------------------------------------- */
  function wireStage() {
    var st = document.getElementById("qo-stage"); if (!st) return;
    st.querySelectorAll(".qo-sym").forEach(function (b) {
      b.onclick = function () { var i = +b.getAttribute("data-i"); if (i !== ST.symIdx) { ST.symIdx = i; rebuildStage(); } };
    });
    st.querySelectorAll(".qo-tab").forEach(function (b) {
      b.onclick = function () { var tb = b.getAttribute("data-tab"); if (tb !== ST.tab) { ST.tab = tb; rebuildStage(); } };
    });
    if (ST.tab === "trade" && !ST.pos) {
      var lo = st.querySelector("#qo-long"), sh = st.querySelector("#qo-short");
      if (lo) lo.onclick = function () { if (ST.dir !== "long") { ST.dir = "long"; rebuildStage(); } };
      if (sh) sh.onclick = function () { if (ST.dir !== "short") { ST.dir = "short"; rebuildStage(); } };
      var stake = st.querySelector("#qo-stake"), range = st.querySelector("#qo-stake-range");
      if (stake) stake.oninput = function () { ST.stake = Math.max(0, Math.floor(+stake.value || 0)); if (range && ST.stake <= +range.max) range.value = ST.stake; syncPayout(); };
      if (range) range.oninput = function () { ST.stake = Math.floor(+range.value); if (stake) stake.value = ST.stake; syncPayout(); };
      st.querySelectorAll(".qo-stk").forEach(function (b) {
        b.onclick = function () { var v = b.getAttribute("data-v"); ST.stake = v === "max" ? Math.max(1, Math.floor(getBal())) : +v; if (stake) stake.value = ST.stake; if (range) range.value = Math.min(ST.stake, +range.max); syncPayout(); };
      });
      st.querySelectorAll(".qo-exp").forEach(function (b) {
        b.onclick = function () { var i = +b.getAttribute("data-i"); if (i !== ST.expIdx) { ST.expIdx = i; rebuildStage(); } };
      });
      var open = st.querySelector("#qo-open");
      if (open) open.onclick = openPosition;
    }
  }
  // Update just the payout number while typing the stake (keeps input smooth;
  // entry/target/stop refresh on the next state rebuild).
  function syncPayout() {
    var el = document.getElementById("qo-payout");
    if (!el) return;
    var payout = (+ST.stake || 0) * (1 + PAYOUT);
    el.innerHTML = fmtTok(payout) + ' <span style="font-size:11px;color:' + TH().t3 + ';font-weight:600">(+' + Math.round(PAYOUT * 100) + '%)</span>';
  }

  /* ----------------------------------------------------------------------- */
  /* Open / close                                                            */
  /* ----------------------------------------------------------------------- */
  function ensureKeyframes() {
    if (document.getElementById("qo-kf")) return;
    var st = document.createElement("style"); st.id = "qo-kf";
    st.textContent = "@keyframes qoPop{from{opacity:0;transform:translateY(14px) scale(.96)}to{opacity:1;transform:none}}@keyframes qoIn{from{opacity:0}to{opacity:1}}";
    document.head.appendChild(st);
  }

  function closeQO() {
    var o = document.getElementById(OV_ID);
    if (o && o.parentNode) o.parentNode.removeChild(o);
    ST.overlayOpen = false;
    document.removeEventListener("keydown", onKey);
    if (!ST.pos) stopTicker();
  }
  function onKey(e) {
    if (e.key !== "Escape") return;
    var r = document.getElementById("qo-result");
    if (r) { if (r.parentNode) r.parentNode.removeChild(r); }
    else closeQO();
  }

  function openQO() {
    initPrices();
    var existing = document.getElementById(OV_ID);
    if (existing) { ST.overlayOpen = true; startTicker(); rebuildStage(); renderLive(); return; }
    ensureKeyframes();
    var TC = TH();
    var ov = document.createElement("div");
    ov.id = OV_ID;
    ov.style.cssText = "position:fixed;inset:0;z-index:5000;display:flex;flex-direction:column;background:" + TC.bg + ";padding-top:var(--sat);animation:qoIn .2s ease";
    var bar = (window.dqAppNav ? window.dqAppNav.html("quant") : "");
    ov.innerHTML = headerHTML() +
      '<div id="qo-stage" style="flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch">' + stageHTML() + '</div>' +
      bar;
    document.body.appendChild(ov);
    ST.overlayOpen = true;
    var x = ov.querySelector("#qo-x"); if (x) x.onclick = closeQO;
    wireStage();
    if (window.dqAppNav) window.dqAppNav.wire(ov, "quant", closeQO);
    document.addEventListener("keydown", onKey);
    startTicker();
    drawChart();
    renderLive();
  }

  /* ----------------------------------------------------------------------- */
  /* Public API                                                              */
  /* ----------------------------------------------------------------------- */
  window.openQuantOption = openQO;
  window.dqQuantOption = {
    open: openQO,
    _pure: { gauss: gauss, computeOffset: computeOffset, hitOutcome: hitOutcome, expiryOutcome: expiryOutcome, settle: settle }
  };
})();
