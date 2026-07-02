/* ===========================================================================
 * quant-option.js — "Quant Option" exchange-style options terminal (v2)
 * ---------------------------------------------------------------------------
 * Server-authoritative, wallet-connected. The balance shown IS the user's main
 * QNTM wallet; stakes/payouts are real double-entry ledger transactions. The
 * price path + win/lose/draw verdict are decided SERVER-SIDE and provably fair
 * (the server commits a seed hash at open and reveals the seed at settlement).
 *
 * This client only DISPLAYS:
 *   - pre-trade: an ambient chart drawn locally from the public clockPrice()
 *     curve (identical formula to the server, fed by per-symbol `wave` params
 *     from /me) — no per-symbol polling needed.
 *   - in-trade : the AUTHORITATIVE price path, polled from
 *     GET /api/quantoption/position/:id every ~700ms and rendered as-is.
 *
 * Features: professional exchange layout, candle + line chart modes, and a full
 * on-chart position overlay (entry / target / stop lines + filled zones, live
 * price marker, countdown, progress, P/L) — like a real position on a chart.
 *
 * Backend:  routes/quantoption.js + services/quantoption.js (+ -engine.js)
 * Globals reused (with fallbacks): t, esc, ic, api, S, showToast, hexA.
 * Exposes: window.openQuantOption(), window.dqQuantOption = { open, _pure }.
 * Load after easytrade-hub.js (uses window.dqAppNav for the bottom bar).
 * =========================================================================== */
(function () {
  "use strict";
  if (window.__dqQuantOptionV2) return;
  window.__dqQuantOptionV2 = true;

  var OV_ID = "qo-ov";
  var POLL_MS = 700;          // in-trade poll cadence
  var AMB_MS = 320;           // pre-trade ambient redraw cadence
  var CHART_DT = 500;         // ms between ambient samples
  var AMB_POINTS = 200;       // ambient rolling-buffer length (~100s window)
  var CANDLE_TICKS = 4;       // raw points per candle

  /* ── safe accessors ─────────────────────────────────────────────────────── */
  var FALLBACK_T = {
    pr: "#3b82f6", pgw: "rgba(59,130,246,.5)", t1: "#e9f0fc", t2: "#9fb0cc", t3: "#6f819e"
  };
  function TG() { return (typeof t !== "undefined" && t) ? t : FALLBACK_T; }
  function ICO(p, s) { return (typeof ic === "function") ? ic(p, s) : '<svg width="' + (s || 18) + '" height="' + (s || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'; }
  function ESC(x) { return (typeof esc === "function") ? esc(x) : String(x == null ? "" : x).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function toast(a, b) { if (typeof showToast === "function") showToast(a, b); }
  function API(path, opts) { if (typeof api !== "function") return Promise.reject(new Error("offline")); return api(path, opts); }
  function hexA(hex, a) {
    if (typeof window.hexA === "function") return window.hexA(hex, a);
    var h = String(hex || "").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16); if (isNaN(n)) return hex;
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  /* ── palette (exchange dark; folds in app `t` accent) ───────────────────── */
  function TH() {
    var x = TG();
    if (x && x.n === "light") {
      return {
        bg: "#eef2f8", panel: "#ffffff", panel2: "#f6f8fc", panel3: "#eef3fa",
        bd: "rgba(70,100,160,.2)", bdSoft: "rgba(70,100,160,.1)",
        t1: "#141a26", t2: "#42536f", t3: "#6b7d9a", t4: "#93a2bd",
        blue: x.pr || "#2f6fe0", blueGlow: x.pgw || "rgba(47,111,224,.4)",
        green: "#15a34a", greenD: "#0f7e39", greenGlow: "rgba(21,163,74,.35)",
        red: "#e23a5c", redD: "#c41e44", redGlow: "rgba(226,58,92,.35)",
        gold: "#c68f22", goldGlow: "rgba(198,143,34,.4)",
        grid: "rgba(70,100,160,.12)"
      };
    }
    return {
      bg: "#070b16", panel: "#0d1525", panel2: "#101a2c", panel3: "#0a1120",
      bd: "rgba(120,150,200,.16)", bdSoft: "rgba(120,150,200,.09)",
      t1: "#eaf1fc", t2: "#9fb0cc", t3: "#6f819e", t4: "#54658a",
      blue: x.pr || "#3b82f6", blueGlow: x.pgw || "rgba(59,130,246,.5)",
      green: "#22c55e", greenD: "#16a34a", greenGlow: "rgba(34,197,94,.5)",
      red: "#f43f5e", redD: "#e11d48", redGlow: "rgba(244,63,94,.5)",
      gold: "#ffcf5a", goldGlow: "rgba(255,207,90,.45)",
      grid: "rgba(120,150,200,.07)"
    };
  }

  /* ── numbers ────────────────────────────────────────────────────────────── */
  function fmtQ(n) { n = Number(n); if (!isFinite(n)) n = 0; return n.toLocaleString("en-US", { maximumFractionDigits: n < 1000 ? 2 : 0 }); }
  function fmtP(v, dp) { v = Number(v); if (!isFinite(v)) v = 0; return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }); }
  function fmtSigned(n) { n = Number(n) || 0; var s = n > 0 ? "+" : ""; return s + n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 1000 ? 2 : 0 }); }
  function mmss(ms) { ms = Math.max(0, ms | 0); var s = Math.round(ms / 1000); var m = (s / 60) | 0; s = s % 60; return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s; }

  /* ── engine mirror: ambient price (IDENTICAL formula to the server) ─────── */
  function clockPrice(base, wave, tMs) {
    var s = tMs / 1000;
    var x =
      wave.a1 * Math.sin((2 * Math.PI * s) / wave.p1 + wave.ph1) +
      wave.a2 * Math.sin((2 * Math.PI * s) / wave.p2 + wave.ph2) +
      wave.a3 * Math.sin((2 * Math.PI * s) / wave.p3 + wave.ph3);
    return base * Math.exp(x);
  }
  function toCandles(points, per) {
    var out = [];
    for (var i = 0; i < points.length; i += per) {
      var sl = points.slice(i, i + per);
      if (!sl.length) continue;
      var o = sl[0].price, c = sl[sl.length - 1].price, hi = o, lo = o;
      for (var j = 0; j < sl.length; j++) { var p = sl[j].price; if (p > hi) hi = p; if (p < lo) lo = p; }
      out.push({ t: sl[0].t, o: o, h: hi, l: lo, c: c });
    }
    return out;
  }

  /* ── state ──────────────────────────────────────────────────────────────── */
  var QO = {
    loaded: false,
    min: 10, max: 1000000, payoutBps: 8500, payoutMult: 1.85, stepMs: 220,
    expiries: [30, 60, 120, 180, 300, 600, 900],
    timeLimits: [300, 900, 3600, 14400], // optional auto-close: 5m | 15m | 1h | 4h
    symbols: [],            // [{symbol,label,base,dp,vol,stepMs,price,wave}]
    balance: "0", pool: "0",
    symIdx: 0, dir: "long", stake: 100,
    chartMode: "candle",    // 'candle' | 'line'
    view: "trade",          // 'trade' | 'history'
    pos: null,              // open/most-recent position view (focused, in real mode)
    amb: {},                // symbol -> rolling [{t,price}]  (simulated mode only)
    ambTimer: null, pollTimer: null, symTimer: null, overlayOpen: false, busy: false,
    history: null,
    // -- real-price mode (QUANTOPTION_REAL_PRICES=true on the server) --
    realPrices: false,        // server settles on real market prices
    openPositions: [],        // all open positions (real mode can stack)
    focusId: null,            // id of the position whose levels overlay the chart
    manualTP: "", manualSL: "", // optional user-entered TP(=TP3)/SL for the Trade tab (blank = auto)
    voidOnTimeout: false,     // opt-in auto-close time limit ON/OFF (OFF => open-ended, settles only on TP/SL)
    timeLimitIdx: 1,          // selected duration index into timeLimits (5m|15m|1h|4h); used only when voidOnTimeout is on
    tpHit: {},                // fired TP-cross celebrations (per position id) so each pops once
    realCandles: {},          // symbol -> [{t,o,h,l,c}] from /quantoption/chart
    chartProvider: null,      // 'binance' | 'twelvedata' (from /chart)
    chartErr: null,           // last /chart failure reason, shown in the empty chart
    chartTimer: null, posTimer: null, countTimer: null, chartBusy: false
  };
  function curSym() { return QO.symbols[QO.symIdx] || null; }
  function curTimeLimit() { return QO.voidOnTimeout ? (QO.timeLimits[QO.timeLimitIdx] != null ? QO.timeLimits[QO.timeLimitIdx] : 900) : null; }
  function balNum() { return Number(QO.balance) || 0; }

  /* ── scoped stylesheet (once) ───────────────────────────────────────────── */
  function injectCSS() {
    if (document.getElementById("qo-css")) return;
    var c = TH();
    var css =
      '#qo-ov{position:fixed;inset:0;z-index:5000;display:flex;flex-direction:column;background:' + c.bg + ';font-family:Outfit,system-ui,sans-serif;padding-top:var(--sat);padding-left:var(--sal);padding-right:var(--sar);animation:qoIn .2s ease}' +
      '#qo-ov *{box-sizing:border-box}' +
      '.qo-hd{display:flex;align-items:center;gap:11px;padding:11px 14px;border-bottom:1px solid ' + c.bd + ';background:' + c.panel3 + ';flex-shrink:0}' +
      '.qo-ib{width:36px;height:36px;border-radius:9px;border:1px solid ' + c.bd + ';background:' + c.panel2 + ';color:' + c.t1 + ';cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:transform .12s,border-color .15s}' +
      '.qo-ib:hover{border-color:' + hexA(c.blue, .4) + '}' +
      '.qo-ib:active{transform:scale(.92)}' +
      '.qo-stage{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;padding-bottom:8px}' +
      '.qo-pad{padding:12px 13px 0}' +
      '.qo-stats{display:flex;gap:10px;margin-bottom:12px}' +
      '.qo-stat{flex:1;border-radius:9px;padding:11px 13px;background:' + c.panel + ';border:1px solid ' + c.bd + ';position:relative;overflow:hidden}' +
      '.qo-stat .lab{font-size:9px;letter-spacing:1.1px;text-transform:uppercase;font-weight:800;margin-bottom:5px;color:' + c.t3 + '}' +
      '.qo-stat .val{font-size:20px;font-weight:800;letter-spacing:-.4px;line-height:1;color:' + c.t1 + ';font-variant-numeric:tabular-nums}' +
      '.qo-stat .q{font-size:11px;font-weight:700;margin-left:4px}' +
      '.qo-syms{display:flex;gap:7px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding:1px 0 10px;scrollbar-width:none}' +
      '.qo-syms::-webkit-scrollbar{display:none}' +
      '.qo-sym{flex-shrink:0;border-radius:8px;padding:7px 11px;border:1px solid ' + c.bd + ';background:' + c.panel + ';cursor:pointer;min-width:90px;transition:border-color .15s,background .15s}' +
      '.qo-sym:hover{border-color:' + hexA(c.blue, .38) + '}' +
      '.qo-sym .nm{font-size:12px;font-weight:800;color:' + c.t1 + ';letter-spacing:.2px}' +
      '.qo-sym .px{font-size:11px;font-weight:600;color:' + c.t3 + ';margin-top:2px;font-variant-numeric:tabular-nums}' +
      '.qo-sym.on{border-color:' + hexA(c.blue, .6) + ';background:' + hexA(c.blue, .1) + '}' +
      '.qo-sym.on .nm{color:' + c.blue + '}' +
      '.qo-chartwrap{position:relative;border-radius:10px;border:1px solid ' + c.bd + ';background:' + c.panel3 + ';overflow:hidden;margin-bottom:12px;box-shadow:0 1px 12px rgba(0,0,0,.22)}' +
      '.qo-chartbar{display:flex;align-items:center;gap:9px;padding:10px 12px;border-bottom:1px solid ' + c.bdSoft + '}' +
      '.qo-px{font-size:21px;font-weight:800;letter-spacing:-.5px;color:' + c.t1 + ';font-variant-numeric:tabular-nums;line-height:1}' +
      '.qo-pxsub{font-size:10.5px;font-weight:700;color:' + c.t3 + ';letter-spacing:.2px}' +
      '.qo-modes{display:flex;gap:4px;background:' + c.panel + ';border:1px solid ' + c.bd + ';border-radius:8px;padding:3px}' +
      '.qo-mode{width:30px;height:26px;border-radius:6px;border:none;background:transparent;color:' + c.t3 + ';cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .14s,color .14s}' +
      '.qo-mode:hover{color:' + c.t2 + '}' +
      '.qo-mode.on{background:' + hexA(c.blue, .16) + ';color:' + c.blue + '}' +
      '.qo-canvas{display:block;width:100%;height:340px;touch-action:pan-y}' +
      '.qo-seg{display:flex;gap:9px;margin-bottom:12px}' +
      '.qo-dir{flex:1;border-radius:10px;padding:13px 10px;border:1px solid ' + c.bd + ';background:' + c.panel + ';cursor:pointer;text-align:center;transition:border-color .15s,background .15s,transform .12s;position:relative;overflow:hidden}' +
      '.qo-dir:hover{border-color:' + hexA(c.blue, .35) + '}' +
      '.qo-dir:active{transform:scale(.98)}' +
      '.qo-dir .dt{font-size:15px;font-weight:800;letter-spacing:.4px}' +
      '.qo-dir .ds{font-size:10px;font-weight:600;color:' + c.t3 + ';margin-top:2px}' +
      '.qo-card{border-radius:10px;background:' + c.panel + ';border:1px solid ' + c.bd + ';padding:13px;margin-bottom:12px}' +
      '.qo-lab{font-size:9.5px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + c.t3 + ';margin-bottom:8px}' +
      '.qo-stakebox{display:flex;align-items:center;gap:10px}' +
      '.qo-inp{flex:1;width:100%;padding:11px 13px;border-radius:8px;background:' + c.panel3 + ';border:1px solid ' + c.bd + ';color:' + c.t1 + ';font-size:18px;font-weight:800;font-family:inherit;outline:none;text-align:left;font-variant-numeric:tabular-nums;transition:border-color .15s,box-shadow .15s}' +
      '.qo-inp:focus{border-color:' + c.blue + ';box-shadow:0 0 0 3px ' + hexA(c.blue, .14) + '}' +
      '.qo-range{-webkit-appearance:none;appearance:none;width:100%;height:5px;border-radius:4px;outline:none;margin:13px 0 3px;background:' + c.panel3 + '}' +
      '.qo-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:18px;height:18px;border-radius:50%;background:' + c.blue + ';border:2px solid ' + c.panel3 + ';cursor:pointer;box-shadow:0 0 0 3px ' + hexA(c.blue, .18) + '}' +
      '.qo-range::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:' + c.blue + ';border:2px solid ' + c.panel3 + ';cursor:pointer}' +
      '.qo-chips{display:flex;gap:6px;margin-top:9px}' +
      '.qo-chip{flex:1;padding:8px 0;border-radius:7px;border:1px solid ' + c.bd + ';background:' + c.panel3 + ';color:' + c.t2 + ';font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;transition:transform .1s,border-color .15s,color .15s}' +
      '.qo-chip:hover{border-color:' + hexA(c.blue, .35) + ';color:' + c.t1 + '}' +
      '.qo-chip:active{transform:scale(.95)}' +
      '.qo-exps{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}' +
      '.qo-exp{padding:10px 0;border-radius:8px;border:1px solid ' + c.bd + ';background:' + c.panel3 + ';color:' + c.t2 + ';font-size:12.5px;font-weight:800;cursor:pointer;font-family:inherit;text-align:center;transition:border-color .14s,background .14s,color .14s}' +
      '.qo-exp:hover{border-color:' + hexA(c.blue, .35) + ';color:' + c.t1 + '}' +
      '.qo-exp.on{border-color:' + hexA(c.blue, .55) + ';background:' + hexA(c.blue, .12) + ';color:' + c.blue + '}' +
      '.qo-switch{position:relative;width:46px;height:27px;border-radius:14px;border:1px solid ' + c.bd + ';background:' + c.panel3 + ';cursor:pointer;flex-shrink:0;padding:0;transition:background .16s,border-color .16s}' +
      '.qo-switch .qo-switch-knob{position:absolute;top:2px;left:2px;width:21px;height:21px;border-radius:50%;background:' + c.t4 + ';transition:transform .18s,background .18s}' +
      '.qo-switch.on{background:' + hexA(c.blue, .85) + ';border-color:' + c.blue + '}' +
      '.qo-switch.on .qo-switch-knob{transform:translateX(19px);background:#fff}' +
      '.qo-pre{display:flex;gap:9px;margin-bottom:12px}' +
      '.qo-pre .b{flex:1;border-radius:8px;background:' + c.panel + ';border:1px solid ' + c.bd + ';padding:10px 11px}' +
      '.qo-pre .k{font-size:9px;letter-spacing:.8px;text-transform:uppercase;font-weight:800;color:' + c.t4 + ';margin-bottom:4px}' +
      '.qo-pre .v{font-size:14px;font-weight:800;font-variant-numeric:tabular-nums}' +
      '.qo-cta{width:100%;padding:15px;border:none;border-radius:9px;font-weight:800;font-size:15px;letter-spacing:.2px;cursor:pointer;font-family:inherit;color:#fff;display:flex;align-items:center;justify-content:center;gap:9px;transition:transform .14s,box-shadow .2s,opacity .2s,filter .15s}' +
      '.qo-cta:hover{filter:brightness(1.06)}' +
      '.qo-cta:active{transform:scale(.985)}' +
      '.qo-cta:disabled{opacity:.45;cursor:not-allowed;filter:grayscale(.3)}' +
      '.qo-posrow{display:flex;gap:9px;margin-bottom:11px}' +
      '.qo-poscell{flex:1;border-radius:8px;background:' + c.panel + ';border:1px solid ' + c.bd + ';padding:10px;text-align:center}' +
      '.qo-poscell .k{font-size:9px;letter-spacing:.7px;text-transform:uppercase;font-weight:800;margin-bottom:5px}' +
      '.qo-poscell .v{font-size:14.5px;font-weight:800;font-variant-numeric:tabular-nums;color:' + c.t1 + '}' +
      '.qo-bartrack{height:6px;border-radius:4px;background:' + c.panel3 + ';overflow:hidden;margin:4px 0 0}' +
      '.qo-barfill{height:100%;border-radius:4px;transition:width .3s ease,background .3s}' +
      '.qo-hl{display:flex;align-items:center;justify-content:space-between;padding:11px 13px;border-radius:9px;background:' + c.panel + ';border:1px solid ' + c.bd + ';margin-bottom:8px}' +
      '.qo-badge{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.3px}' +
      '.qo-tabs{display:flex;gap:7px;margin-bottom:12px}' +
      '.qo-tab{flex:1;padding:9px 0;border-radius:8px;border:1px solid ' + c.bd + ';background:' + c.panel + ';color:' + c.t3 + ';font-size:12.5px;font-weight:800;cursor:pointer;font-family:inherit;text-align:center;transition:border-color .14s,background .14s,color .14s}' +
      '.qo-tab:hover{border-color:' + hexA(c.blue, .35) + ';color:' + c.t2 + '}' +
      '.qo-tab.on{border-color:' + hexA(c.blue, .55) + ';background:' + hexA(c.blue, .12) + ';color:' + c.blue + '}' +
      '.qo-empty{text-align:center;padding:34px 16px;color:' + c.t4 + ';font-size:12.5px}' +
      '.qo-fair{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:700;color:' + c.t4 + '}' +
      '@keyframes qoIn{from{opacity:0}to{opacity:1}}' +
      '@keyframes qoPop{from{opacity:0;transform:translateY(14px) scale(.96)}to{opacity:1;transform:none}}' +
      '@keyframes qoPulse{0%,100%{opacity:1}50%{opacity:.4}}' +
      '@keyframes qoStamp{0%{transform:scale(.4) rotate(-10deg);opacity:0}60%{transform:scale(1.1) rotate(3deg)}100%{transform:scale(1) rotate(0);opacity:1}}';
    var el = document.createElement("style"); el.id = "qo-css"; el.textContent = css; document.head.appendChild(el);
  }

  // Lets the app rebuild QuantOption's stylesheet when the global light/dark
  // theme changes (all QO colours come from TH(), which follows the app theme).
  window.qoApplyTheme = function () { try { var e = document.getElementById("qo-css"); if (e) { e.remove(); injectCSS(); } } catch (_) {} };

  /* ── data loaders ───────────────────────────────────────────────────────── */
  function loadMe() {
    return API("/quantoption/me").then(function (r) {
      if (!r) return r;
      QO.loaded = true;
      if (r.min != null) QO.min = Number(r.min);
      if (r.max != null) QO.max = Number(r.max);
      if (r.payoutBps != null) QO.payoutBps = Number(r.payoutBps);
      if (r.payoutMult != null) QO.payoutMult = Number(r.payoutMult);
      if (r.stepMs != null) QO.stepMs = Number(r.stepMs);
      if (Array.isArray(r.expiries) && r.expiries.length) QO.expiries = r.expiries.map(Number);
      if (Array.isArray(r.symbols) && r.symbols.length) QO.symbols = r.symbols;
      QO.balance = r.balance != null ? r.balance : QO.balance;
      QO.pool = r.pool != null ? r.pool : QO.pool;
      if (QO.symIdx >= QO.symbols.length) QO.symIdx = 0;
      if (QO.stake < QO.min) QO.stake = QO.min;
      QO.realPrices = !!r.realPrices;
      if (QO.realPrices) {
        QO.openPositions = Array.isArray(r.openPositions) ? r.openPositions
          : (r.open && r.open.status === "open" ? [r.open] : []);
        syncFocus();
      } else {
        QO.pos = (r.open && r.open.status === "open") ? r.open : (r.open || QO.pos);
      }
      return r;
    });
  }
  // keep QO.focusId valid and mirror the focused position into QO.pos so the
  // shared position-card / chart-overlay code reads one place in both modes
  function syncFocus() {
    var list = QO.openPositions || [];
    if (!list.length) { QO.focusId = null; QO.pos = null; return; }
    var f = null, i;
    for (i = 0; i < list.length; i++) { if (list[i].id === QO.focusId) { f = list[i]; break; } }
    if (!f) { f = list[0]; QO.focusId = f.id; }
    QO.pos = f;
  }
  function focusPos() {
    if (!QO.realPrices) return (QO.pos && QO.pos.status === "open") ? QO.pos : null;
    var list = QO.openPositions || [], i;
    for (i = 0; i < list.length; i++) { if (list[i].id === QO.focusId) return list[i]; }
    return list[0] || null;
  }

  /* ── ambient buffer (deterministic; rebuilt instantly on demand) ────────── */
  function buildAmbient(sym) {
    if (!sym || !sym.wave) return [];
    var now = Date.now(), arr = [];
    for (var k = AMB_POINTS - 1; k >= 0; k--) {
      var tt = now - k * CHART_DT;
      arr.push({ t: tt, price: clockPrice(sym.base, sym.wave, tt) });
    }
    return arr;
  }
  function tickAmbient() {
    if (QO.realPrices) return;
    var sym = curSym(); if (!sym || !sym.wave) return;
    var buf = QO.amb[sym.symbol] || (QO.amb[sym.symbol] = buildAmbient(sym));
    var now = Date.now(), last = buf[buf.length - 1];
    if (!last || now - last.t >= CHART_DT) {
      buf.push({ t: now, price: clockPrice(sym.base, sym.wave, now) });
      while (buf.length > AMB_POINTS) buf.shift();
    }
    // update the headline price live
    var px = clockPrice(sym.base, sym.wave, now);
    var pxEl = document.getElementById("qo-px"); if (pxEl) pxEl.textContent = fmtP(px, sym.dp);
    var nmEls = document.querySelectorAll(".qo-symp");
    for (var i = 0; i < nmEls.length; i++) {
      var idx = +nmEls[i].getAttribute("data-i"); var s2 = QO.symbols[idx];
      if (s2 && s2.wave) nmEls[i].textContent = fmtP(clockPrice(s2.base, s2.wave, now), s2.dp);
    }
    drawChart();
  }

  /* ── chart ──────────────────────────────────────────────────────────────── */
  function layoutCanvas() {
    var cv = document.getElementById("qo-canvas"); if (!cv) return null;
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || cv.parentNode.clientWidth || 320;
    var h = cv.clientHeight || 340;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    var ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }
  function seriesPoints() {
    // in-trade: the authoritative path from the server; else the ambient buffer
    if (QO.pos && QO.pos.status === "open" && QO.pos.ticks && QO.pos.ticks.length) {
      return QO.pos.ticks.map(function (k) { return { t: k.t, price: Number(k.price) }; });
    }
    if (QO.pos && QO.pos.status !== "open" && QO.pos.ticks && QO.pos.ticks.length) {
      return QO.pos.ticks.map(function (k) { return { t: k.t, price: Number(k.price) }; });
    }
    var sym = curSym(); if (!sym) return [];
    return (QO.amb[sym.symbol] || buildAmbient(sym)).slice();
  }
  function drawChart() {
    var L = layoutCanvas(); if (!L) return;
    var ctx = L.ctx, W = L.w, H = L.h, c = TH();
    ctx.clearRect(0, 0, W, H);
    var D = chartSeries();
    var candles = D.candles, line = D.line, dp = D.dp;
    if (line.length < 2 && candles.length < 1) {
      ctx.fillStyle = c.t3; ctx.font = "12px Outfit, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(QO.chartErr || "Loading chart\u2026", W / 2, H / 2);
      ctx.textAlign = "left";
      return;
    }

    var pos = overlayPos();
    var hasLevels = !!pos;
    var padL = 3, padR = hasLevels ? 92 : 66, padT = 4, padB = 16;
    var plotW = W - padL - padR, plotH = H - padT - padB;

    // y-range over what is drawn, widened to include levels + the live price
    var lo = Infinity, hi = -Infinity, i, p;
    if (QO.chartMode === "candle" && candles.length) {
      for (i = 0; i < candles.length; i++) { if (candles[i].l < lo) lo = candles[i].l; if (candles[i].h > hi) hi = candles[i].h; }
    } else {
      for (i = 0; i < line.length; i++) { p = line[i].price; if (p < lo) lo = p; if (p > hi) hi = p; }
    }
    if (D.live != null) { if (D.live < lo) lo = D.live; if (D.live > hi) hi = D.live; }
    if (hasLevels) {
      var ts = [Number(pos.entry), Number(pos.stop), Number(pos.tp1), Number(pos.tp2), Number(pos.tp3)].filter(Number.isFinite);
      for (i = 0; i < ts.length; i++) { if (ts[i] < lo) lo = ts[i]; if (ts[i] > hi) hi = ts[i]; }
    }
    if (!(hi > lo)) { hi = lo + 1; }
    var pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    function Y(v) { return padT + plotH - ((v - lo) / (hi - lo)) * plotH; }
    function Xl(idx, n) { return padL + (n <= 1 ? 0 : (idx / (n - 1)) * plotW); }

    // grid: vertical time columns + horizontal price rows + a right price-axis (charting-first)
    var gridSeries = (QO.chartMode === "candle" && candles.length) ? candles : line;
    var gsn = gridSeries.length;
    var tAt = function (f) { if (!gsn) return null; var it = gridSeries[Math.round(f * (gsn - 1))]; return it ? it.t : null; };
    ctx.lineWidth = 1; ctx.textBaseline = "middle";
    ctx.font = "600 9px Outfit, sans-serif";
    for (var vc = 1; vc < 4; vc++) {
      var fx = vc / 4, vx = padL + plotW * fx;
      ctx.strokeStyle = c.grid; ctx.beginPath(); ctx.moveTo(vx, padT); ctx.lineTo(vx, padT + plotH); ctx.stroke();
      var tt = tAt(fx);
      if (tt != null) { ctx.fillStyle = c.t4; ctx.textAlign = "center"; ctx.fillText(hhmm(tt), vx, padT + plotH + 10); }
    }
    ctx.font = "600 9.5px Outfit, sans-serif";
    var lvlYs = [];
    if (hasLevels) {
      var lps = [Number(pos.entry), Number(pos.stop), Number(pos.tp1), Number(pos.tp2), Number(pos.tp3)];
      for (i = 0; i < lps.length; i++) { if (Number.isFinite(lps[i])) lvlYs.push(Math.max(padT + 8, Math.min(padT + plotH - 8, Y(lps[i])))); }
    } else if (D.live != null) {
      lvlYs.push(Math.max(padT + 8, Math.min(padT + plotH - 8, Y(D.live))));
    }
    for (var g = 0; g <= 4; g++) {
      var yy = padT + (plotH * g) / 4;
      ctx.strokeStyle = c.grid; ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      if (g > 0 && g < 4) {
        var clash = false;
        for (var li = 0; li < lvlYs.length; li++) { if (Math.abs(yy - lvlYs[li]) < 12) { clash = true; break; } }
        if (!clash) { var pv = lo + (hi - lo) * (1 - g / 4); ctx.fillStyle = c.t3; if (hasLevels) { ctx.textAlign = "left"; ctx.fillText(fmtP(pv, dp), padL + plotW + 7, yy); } else { ctx.textAlign = "right"; ctx.fillText(fmtP(pv, dp), W - 5, yy); } }
      }
    }
    ctx.strokeStyle = c.bdSoft; ctx.beginPath(); ctx.moveTo(padL + plotW + 0.5, padT); ctx.lineTo(padL + plotW + 0.5, padT + plotH); ctx.stroke();

    // position zones + levels: profit band entry->TP3 (green), loss band entry->SL
    // (red), with TP1 / TP2 / TP3 / ENTRY / SL lines (TP3 = the settlement target)
    if (hasLevels) {
      var nE = Number(pos.entry), nS = Number(pos.stop);
      var n1 = Number(pos.tp1), n2 = Number(pos.tp2);
      var n3 = Number.isFinite(Number(pos.tp3)) ? Number(pos.tp3) : Number(pos.target);
      var plotR = padL + plotW;
      var lvl = function (price, col, label) {
        if (!Number.isFinite(price)) return;
        var y = Y(price);
        ctx.font = "700 8.5px Outfit, sans-serif"; ctx.textBaseline = "middle";
        var pw = ctx.measureText(label).width + 12, ph = 16, rr = 4;
        var pillR = W - 3, pillL = pillR - pw;
        var lineR = Math.max(padL, pillL - 2);
        ctx.strokeStyle = hexA(col, .5); ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(lineR, y); ctx.stroke(); ctx.setLineDash([]);
        var cy = Math.max(padT + ph / 2, Math.min(padT + plotH - ph / 2, y));
        ctx.fillStyle = col; roundRect(ctx, pillL, cy - ph / 2, pw, ph, rr); ctx.fill();
        ctx.fillStyle = lum(col) > 150 ? "#06101f" : "#ffffff"; ctx.textAlign = "left";
        ctx.fillText(label, pillL + 6, cy);
      };
      lvl(n1, c.blue, "TP1 " + fmtP(n1, dp));
      lvl(n2, c.blue, "TP2 " + fmtP(n2, dp));
      lvl(n3, c.blue, "TP3 " + fmtP(n3, dp));
      lvl(nE, c.gold, "ENTRY " + fmtP(nE, dp));
      lvl(nS, c.red, "SL " + fmtP(nS, dp));
    }

    // the price series
    var up = (line.length ? line[line.length - 1].price >= line[0].price : true);
    var lineCol = hasLevels ? c.blue : (up ? c.green : c.red);
    if (QO.chartMode === "candle" && candles.length) {
      drawCandleArray(ctx, candles, padL, plotW, Y, c);
    } else if (line.length >= 2) {
      ctx.beginPath();
      for (i = 0; i < line.length; i++) { var xx = Xl(i, line.length), y2 = Y(line[i].price); if (i === 0) ctx.moveTo(xx, y2); else ctx.lineTo(xx, y2); }
      ctx.lineTo(Xl(line.length - 1, line.length), padT + plotH); ctx.lineTo(Xl(0, line.length), padT + plotH); ctx.closePath();
      var grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, hexA(lineCol, .22)); grad.addColorStop(1, hexA(lineCol, 0));
      ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath();
      for (i = 0; i < line.length; i++) { var x3 = Xl(i, line.length), y3 = Y(line[i].price); if (i === 0) ctx.moveTo(x3, y3); else ctx.lineTo(x3, y3); }
      ctx.strokeStyle = lineCol; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
    }

    // live price marker at the right edge
    var lastP = (D.live != null) ? D.live : (line.length ? line[line.length - 1].price : (candles.length ? candles[candles.length - 1].c : null));
    if (lastP != null && !hasLevels) {
      var yL = Y(lastP);
      var markCol = lineCol;
      ctx.strokeStyle = hexA(markCol, .5); ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, yL); ctx.lineTo(padL + plotW, yL); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = markCol; ctx.beginPath(); ctx.arc(padL + plotW, yL, 3.4, 0, Math.PI * 2); ctx.fill();
      var tag = fmtP(lastP, dp); ctx.font = "700 10px Outfit, sans-serif"; var tw = ctx.measureText(tag).width;
      var lpw = tw + 10, lpL = W - 3 - lpw;
      ctx.fillStyle = markCol; var ty = Math.max(padT + 8, Math.min(padT + plotH - 8, yL));
      roundRect(ctx, lpL, ty - 8, lpw, 16, 4); ctx.fill();
      ctx.fillStyle = "#06101f"; ctx.textAlign = "left"; ctx.fillText(tag, lpL + 5, ty);
    }
  }
  function drawLevel(ctx, x0, w, y, col, label, c) {
    ctx.strokeStyle = hexA(col, .5); ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = "700 8.5px Outfit, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    var tw = ctx.measureText(label).width;
    // delicate label: faint tinted pill with colored text (not a solid block)
    ctx.fillStyle = hexA(col, .15); roundRect(ctx, x0 + 4, y - 7, tw + 8, 14, 3); ctx.fill();
    ctx.fillStyle = hexA(col, .95); ctx.fillText(label, x0 + 8, y);
  }
  function drawCandleArray(ctx, candles, padL, plotW, Y, c) {
    var n = candles.length; if (!n) return;
    var slot = plotW / n, bw = Math.max(1.4, Math.min(9, slot * 0.62));
    for (var i = 0; i < n; i++) {
      var cd = candles[i], cx = padL + slot * (i + 0.5);
      var up = cd.c >= cd.o, col = up ? c.green : c.red;
      var yo = Y(cd.o), yc = Y(cd.c), yh = Y(cd.h), yl = Y(cd.l);
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(cx, yh); ctx.lineTo(cx, yl); ctx.stroke();
      var top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
      ctx.fillStyle = col; ctx.fillRect(cx - bw / 2, top, bw, bh);
    }
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function hhmm(ms) { var d = new Date(Number(ms) || 0); var h = d.getHours(), m = d.getMinutes(); return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m; }
  function lum(hex) { hex = String(hex || ""); if (hex.charAt(0) !== "#") return 0; var h = hex.slice(1); if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2); var n = parseInt(h, 16); return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); }

  /* ── HTML builders ──────────────────────────────────────────────────────── */
  function headerHTML() {
    var c = TH();
    return '<div class="qo-hd">' +
      '<button class="qo-ib" id="qo-x" type="button" aria-label="Back">' + ICO('<path d="M15 18l-6-6 6-6"/>', 19) + '</button>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:15px;font-weight:800;color:' + c.t1 + ';line-height:1.1">Quant Option</div>' +
        '<div class="qo-fair">' + ICO('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', 11) + '<span>Provably fair · server-settled</span></div>' +
      '</div>' +
      '<div class="qo-badge" style="background:' + hexA(c.blue, .14) + ';color:' + c.blue + '">' + ICO('<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>', 13) + 'x' + (QO.payoutMult || 1.85) + '</div>' +
    '</div>';
  }
  function statsHTML() {
    var c = TH();
    return '<div class="qo-stats">' +
      '<div class="qo-stat"><div style="position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,' + c.blue + ',transparent)"></div>' +
        '<div class="lab" style="color:' + c.blue + '">Your Wallet</div>' +
        '<div class="val" id="qo-bal">' + fmtQ(QO.balance) + '<span class="q" style="color:' + c.blue + '">QNTM</span></div></div>' +
      '<div class="qo-stat"><div style="position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,' + c.gold + ',transparent)"></div>' +
        '<div class="lab" style="color:' + c.gold + '">Reward Pool</div>' +
        '<div class="val" id="qo-pool">' + fmtQ(QO.pool) + '<span class="q" style="color:' + c.gold + '">QNTM</span></div></div>' +
    '</div>';
  }
  function symsHTML() {
    return '<div class="qo-syms">' + QO.symbols.map(function (s, i) {
      return '<div class="qo-sym ' + (i === QO.symIdx ? "on" : "") + '" data-i="' + i + '">' +
        '<div class="nm">' + ESC(s.label || s.symbol) + '</div>' +
        '<div class="px qo-symp" data-i="' + i + '">' + fmtP(s.price != null ? s.price : s.base, s.dp) + '</div></div>';
    }).join("") + '</div>';
  }
  function chartHTML() {
    var c = TH(); var sym = curSym();
    var candIc = '<rect x="4" y="8" width="3" height="9" rx="1"/><path d="M5.5 5v3M5.5 17v2"/><rect x="11" y="6" width="3" height="12" rx="1"/><path d="M12.5 4v2M12.5 18v2"/><rect x="18" y="9" width="3" height="7" rx="1"/><path d="M19.5 6v3M19.5 16v2"/>';
    var lineIc = '<path d="M3 17l5-6 4 3 6-8"/><circle cx="8" cy="11" r="1.3"/><circle cx="12" cy="14" r="1.3"/>';
    return '<div class="qo-chartwrap">' +
      '<div class="qo-chartbar">' +
        '<div style="flex:1;min-width:0"><div class="qo-px" id="qo-px">' + fmtP(headlinePrice(sym), sym ? sym.dp : 2) + '</div>' +
        '<div class="qo-pxsub" id="qo-pxsub">' + ESC(sym ? (sym.label || sym.symbol) : "") + ' · ' + feedLabel() + '</div></div>' +
        '<div class="qo-modes">' +
          '<button class="qo-mode ' + (QO.chartMode === "candle" ? "on" : "") + '" id="qo-m-candle" type="button" aria-label="Candles">' + ICO(candIc, 16) + '</button>' +
          '<button class="qo-mode ' + (QO.chartMode === "line" ? "on" : "") + '" id="qo-m-line" type="button" aria-label="Line">' + ICO(lineIc, 16) + '</button>' +
        '</div>' +
      '</div>' +
      '<canvas class="qo-canvas" id="qo-canvas"></canvas>' +
    '</div>';
  }
  function orderHTML() {
    var c = TH(); var sym = curSym();
    var payout = (Number(QO.stake) || 0) * (QO.payoutMult || 1.85);
    var enough = balNum() >= Number(QO.stake) && Number(QO.stake) >= QO.min;
    var dirLong = QO.dir === "long";
    return '<div class="qo-seg">' +
      '<div class="qo-dir" id="qo-long" style="border-color:' + (dirLong ? c.green : c.bd) + ';background:' + (dirLong ? hexA(c.green, .14) : c.panel) + '">' +
        '<div class="dt" style="color:' + (dirLong ? c.green : c.t2) + '">' + ICO('<path d="M3 17l6-6 4 4 8-8"/><path d="M21 7v6h-6"/>', 17) + ' Long</div>' +
        '<div class="ds">Price goes up</div></div>' +
      '<div class="qo-dir" id="qo-short" style="border-color:' + (!dirLong ? c.red : c.bd) + ';background:' + (!dirLong ? hexA(c.red, .14) : c.panel) + '">' +
        '<div class="dt" style="color:' + (!dirLong ? c.red : c.t2) + '">' + ICO('<path d="M3 7l6 6 4-4 8 8"/><path d="M21 17v-6h-6"/>', 17) + ' Short</div>' +
        '<div class="ds">Price goes down</div></div>' +
    '</div>' +
    '<div class="qo-card">' +
      '<div class="qo-lab">Stake · min ' + fmtQ(QO.min) + ' · max ' + fmtQ(QO.max) + '</div>' +
      '<div class="qo-stakebox"><input class="qo-inp" id="qo-stake" type="number" inputmode="numeric" value="' + (Number(QO.stake) || 0) + '" min="' + QO.min + '" max="' + QO.max + '">' +
        '<div style="font-size:13px;font-weight:800;color:' + c.blue + '">QNTM</div></div>' +
      '<input class="qo-range" id="qo-range" type="range" min="' + QO.min + '" max="' + Math.max(QO.min, Math.min(QO.max, Math.max(1000, Math.floor(balNum())))) + '" value="' + Math.min(Number(QO.stake) || QO.min, Math.max(QO.min, Math.floor(balNum()))) + '">' +
      '<div class="qo-chips">' +
        ['10', '50', '100', '500'].map(function (v) { return '<button class="qo-chip" data-v="' + v + '" type="button">' + v + '</button>'; }).join("") +
        '<button class="qo-chip" data-v="max" type="button">MAX</button>' +
      '</div>' +
    '</div>' +
    '<div class="qo-card">' +
      '<div class="qo-lab">' + (QO.voidOnTimeout ? "TP / SL price · optional (auto if blank)" : "TP / SL price · required") + '</div>' +
      '<div style="display:flex;gap:8px">' +
        '<input class="qo-inp" id="qo-tp" type="number" inputmode="decimal" step="any" placeholder="TP (target)" value="' + (QO.manualTP != null ? QO.manualTP : "") + '" style="flex:1;min-width:0">' +
        '<input class="qo-inp" id="qo-sl" type="number" inputmode="decimal" step="any" placeholder="SL (stop)" value="' + (QO.manualSL != null ? QO.manualSL : "") + '" style="flex:1;min-width:0">' +
      '</div>' +
    '</div>' +
    '<div class="qo-card" id="qo-void-card">' +
      '<div style="display:flex;align-items:center;gap:12px">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:13.5px;font-weight:800;color:' + c.t1 + '">Auto-close time limit</div>' +
          '<div style="font-size:11px;color:' + c.t3 + ';margin-top:2px;line-height:1.35">Optional — refunds your stake if the trade hasn’t resolved by then</div>' +
        '</div>' +
        '<button type="button" id="qo-void-tog" role="switch" aria-checked="' + (QO.voidOnTimeout ? 'true' : 'false') + '" class="qo-switch' + (QO.voidOnTimeout ? ' on' : '') + '"><span class="qo-switch-knob"></span></button>' +
      '</div>' +
      (QO.voidOnTimeout
        ? '<div class="qo-exps" style="margin-top:12px">' + QO.timeLimits.map(function (s, i) {
            return '<button class="qo-exp ' + (i === QO.timeLimitIdx ? "on" : "") + '" data-tl="' + i + '" type="button">' + expLabel(s) + '</button>';
          }).join("") + '</div>'
        : '') +
    '</div>' +

    '<div class="qo-pre">' +
      '<div class="b"><div class="k">Potential payout</div><div class="v" id="qo-payout" style="color:' + c.green + '">' + fmtQ(payout) + '</div></div>' +
      '<div class="b"><div class="k">Profit</div><div class="v" style="color:' + c.green + '">+' + Math.round((QO.payoutBps || 8500) / 100) + '%</div></div>' +
    '</div>' +
    '<div style="padding:0 0 16px">' +
      '<button class="qo-cta" id="qo-open" type="button" ' + (enough ? "" : "disabled") + ' style="background:linear-gradient(180deg,' + (dirLong ? c.green : c.red) + ',' + (dirLong ? c.greenD : c.redD) + ');box-shadow:0 10px 26px ' + hexA(dirLong ? c.green : c.red, .3) + '">' +
        ICO('<path d="M5 12h14M12 5l7 7-7 7"/>', 18) + (enough ? ('Open ' + (dirLong ? "Long" : "Short")) : (Number(QO.stake) < QO.min ? "Increase stake" : "Insufficient balance")) +
      '</button>' +
    '</div>';
  }
  function positionHTML() {
    var c = TH(); var p = QO.pos; if (!p) return "";
    var dirLong = p.dir === "long";
    var dirCol = dirLong ? c.green : c.red;
    var prog = Number(p.progress) || 0;
    var profitPct = Math.round((QO.payoutBps || 8500) / 100);
    return '<div class="qo-hl" style="border-color:' + hexA(dirCol, .4) + ';background:' + hexA(dirCol, .08) + '">' +
        '<div style="display:flex;align-items:center;gap:9px">' +
          '<span style="width:9px;height:9px;border-radius:50%;background:' + dirCol + ';box-shadow:0 0 8px ' + hexA(dirCol, .7) + ';animation:qoPulse 1.4s infinite"></span>' +
          '<div><div style="font-size:13.5px;font-weight:800;color:' + c.t1 + '">' + ESC(p.label || p.symbol) + ' · ' + (dirLong ? "Long" : "Short") + '</div>' +
          '<div style="font-size:10.5px;color:' + c.t3 + '">Live position · ' + fmtQ(p.stake) + ' QNTM staked</div></div>' +
        '</div>' +
        '<div style="text-align:right"><div style="font-size:9px;letter-spacing:.6px;text-transform:uppercase;font-weight:800;color:' + c.t4 + '">Expires in</div>' +
        '<div id="qo-count" style="font-size:18px;font-weight:800;color:' + c.t1 + ';font-variant-numeric:tabular-nums">' + mmss((p.countdownMs != null ? p.countdownMs : 0)) + '</div></div>' +
    '</div>' +
    '<div class="qo-posrow">' +
      '<div class="qo-poscell"><div class="k" style="color:' + c.gold + '">Entry</div><div class="v">' + fmtP(Number(p.entry), p.dp) + '</div></div>' +
      '<div class="qo-poscell"><div class="k" style="color:' + c.blue + '">TP3</div><div class="v" style="color:' + c.blue + '">' + fmtP(Number(p.target), p.dp) + '</div></div>' +
      '<div class="qo-poscell"><div class="k" style="color:' + c.red + '">SL</div><div class="v" style="color:' + c.red + '">' + fmtP(Number(p.stop), p.dp) + '</div></div>' +
    '</div>' +
    '<div class="qo-card">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px">' +
        '<span class="qo-lab" style="margin:0">Live price</span>' +
        '<span id="qo-live" style="font-size:18px;font-weight:800;color:' + c.t1 + ';font-variant-numeric:tabular-nums">' + fmtP(Number(p.livePrice != null ? p.livePrice : p.entry), p.dp) + '</span>' +
      '</div>' +
      '<div class="qo-bartrack"><div class="qo-barfill" id="qo-prog" style="width:' + progWidth(prog) + '%;background:' + (prog >= 0 ? c.blue : c.red) + '"></div></div>' +
      '<div style="display:flex;justify-content:space-between;margin-top:6px;font-size:10px;font-weight:700">' +
        '<span style="color:' + c.red + '">SL</span>' +
        '<span id="qo-prog-lab" style="color:' + c.t3 + '">' + progLabel(prog) + '</span>' +
        '<span style="color:' + c.blue + '">TP3</span>' +
      '</div>' +
    '</div>' +
    '<div class="qo-pre">' +
      '<div class="b"><div class="k">If TP3 hit</div><div class="v" style="color:' + c.green + '">+' + fmtQ((Number(p.stake) || 0) * ((QO.payoutBps || 8500) / 10000)) + '</div></div>' +
      '<div class="b"><div class="k">Win pays</div><div class="v" style="color:' + c.t1 + '">' + fmtQ(p.potentialWin != null ? p.potentialWin : (Number(p.stake) * (QO.payoutMult || 1.85))) + '</div></div>' +
    '</div>' +
    '<div style="padding:2px 0 12px">' +
      '<button class="qo-cta" id="qo-exit" type="button" style="background:linear-gradient(180deg,' + c.gold + ',' + (c.goldD || c.gold) + ');box-shadow:0 8px 22px ' + hexA(c.gold, .28) + '">' +
        ICO('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>', 18) + 'Exit now \u00b7 cash out' +
      '</button>' +
    '</div>' +
    (QO.realPrices
      ? '<div class="qo-fair" style="justify-content:center;padding:4px 0 14px;gap:7px">' +
          ICO('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', 12) +
          '<span>settled on ' + realFeedWord() + ' market prices</span>' +
        '</div>'
      : '<div class="qo-fair" style="justify-content:center;padding:4px 0 14px;gap:7px">' +
          ICO('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', 12) +
          '<span style="font-family:ui-monospace,monospace;font-size:9.5px">commit ' + ESC(String(p.seedHash || "").slice(0, 18)) + '…</span>' +
        '</div>');
  }
  function historyHTML() {
    var c = TH(); var h = QO.history;
    if (!h) return '<div class="qo-empty">Loading…</div>';
    var s = h.summary || {};
    var head = '<div class="qo-posrow">' +
      '<div class="qo-poscell"><div class="k" style="color:' + c.t3 + '">Win rate</div><div class="v">' + (s.winRate == null ? "—" : s.winRate + "%") + '</div></div>' +
      '<div class="qo-poscell"><div class="k" style="color:' + c.t3 + '">Settled</div><div class="v">' + (s.settled || 0) + '</div></div>' +
      '<div class="qo-poscell"><div class="k" style="color:' + c.t3 + '">Net P/L</div><div class="v" style="color:' + (Number(s.net) >= 0 ? c.green : c.red) + '">' + fmtSigned(s.net) + '</div></div>' +
    '</div>';
    if (!h.items || !h.items.length) return head + '<div class="qo-empty">No positions yet. Open your first trade.</div>';
    var rows = h.items.map(function (p) {
      var win = p.status === "won", draw = p.status === "draw", voidR = p.status === "void", open = p.status === "open";
      var col = win ? c.green : draw ? c.gold : voidR ? c.t3 : open ? c.blue : c.red;
      var tag = win ? "WIN" : draw ? "DRAW" : voidR ? "VOID" : open ? "LIVE" : "LOSS";
      var prof = win ? "+" + fmtQ(Number(p.payout) - Number(p.stake)) : (draw || voidR) ? "0" : open ? "—" : "-" + fmtQ(p.stake);
      return '<div style="display:flex;align-items:center;gap:11px;padding:11px 12px;border-radius:8px;background:' + c.panel + ';border:1px solid ' + c.bd + ';margin-bottom:7px">' +
        '<span class="qo-badge" style="background:' + hexA(col, .14) + ';color:' + col + ';flex-shrink:0">' + tag + '</span>' +
        '<div style="flex:1;min-width:0"><div style="font-size:12.5px;font-weight:800;color:' + c.t1 + '">' + ESC(p.label || p.symbol) + ' · ' + (p.dir === "long" ? "Long" : "Short") + '</div>' +
        '<div style="font-size:10px;color:' + c.t4 + '">' + fmtQ(p.stake) + ' QNTM · ' + expLabel(p.expirySec) + '</div></div>' +
        '<div style="font-size:13px;font-weight:800;color:' + col + ';font-variant-numeric:tabular-nums">' + prof + '</div>' +
      '</div>';
    }).join("");
    return head + rows;
  }
  function expLabel(sec) { sec = Number(sec); if (sec < 60) return sec + "s"; if (sec < 3600) return (sec / 60) + "m"; return (sec / 3600) + "h"; }
  function progWidth(prog) { var v = (prog + 1) / 2; return Math.max(0, Math.min(100, v * 100)); }
  function progLabel(prog) { if (prog >= 1) return "at TP3"; if (prog <= -1) return "at SL"; return Math.round(prog * 100) + "% to TP3"; }

  function stageHTML() {
    var tabs =
      '<div class="qo-tabs">' +
        '<button class="qo-tab ' + (QO.view === "trade" ? "on" : "") + '" id="qo-tab-trade" type="button">Trade</button>' +
        '<button class="qo-tab" id="qo-tab-signals" type="button">Signals</button>' +
        '<button class="qo-tab ' + (QO.view === "history" ? "on" : "") + '" id="qo-tab-history" type="button">History</button>' +
      '</div>';
    var body;
    if (QO.view === "history") body = historyHTML();
    else if (QO.realPrices) {
      var hasOpen = !!(QO.openPositions && QO.openPositions.length);
      body = statsHTML() + symsHTML() + chartHTML() +
             (hasOpen ? (openSwitcherHTML() + positionHTML()) : "") +
             orderHTML();
    }
    else body = statsHTML() + symsHTML() + chartHTML() + (QO.pos && QO.pos.status === "open" ? positionHTML() : orderHTML());
    return '<div class="qo-pad">' + tabs + body + '</div>';
  }

  /* ── render + wire ──────────────────────────────────────────────────────── */
  function rerender() {
    var st = document.getElementById("qo-stage"); if (!st) return;
    st.innerHTML = stageHTML();
    wireStage();
    drawChart();
  }
  // Tap handler for an open-position chip: focus that position + switch the chart to
  // its symbol so its candles and entry/TP/SL levels show. Shared by the delegated
  // listener below.
  function selectOpenChip(id) {
    id = +id; if (!id) return;
    QO.focusId = id;
    var fp = null, list = QO.openPositions || [], k;
    for (k = 0; k < list.length; k++) { if (list[k].id === id) { fp = list[k]; break; } }
    if (fp) { for (k = 0; k < QO.symbols.length; k++) { if (QO.symbols[k].symbol === fp.symbol) { QO.symIdx = k; break; } } }
    syncFocus(); rerender();
    if (QO.realPrices) fetchChart(true);
  }
  function wireStage() {
    var st = document.getElementById("qo-stage"); if (!st) return;
    var T = function (id) { return st.querySelector(id); };
    // Bind the open-chip delegation exactly once for this stage element. Delegation
    // means the listener lives on the stable #qo-stage container and keeps working
    // across every st.innerHTML re-render, so a chip tap is never dropped.
    if (!st.__qoChipDelegated) {
      st.__qoChipDelegated = true;
      st.addEventListener("click", function (e) {
        var chip = e.target && e.target.closest ? e.target.closest(".qo-openchip") : null;
        if (!chip || !st.contains(chip)) return;
        var id = chip.getAttribute("data-id");
        if (id) selectOpenChip(id);
      });
    }
    var tt = T("#qo-tab-trade"); if (tt) tt.onclick = function () { if (QO.view !== "trade") { QO.view = "trade"; rerender(); } };
    var tsig = T("#qo-tab-signals"); if (tsig) tsig.onclick = function () { if (window.dqQOSignals) window.dqQOSignals.open(); else toast("Signal trading is loading — try again", "error"); };
    var th = T("#qo-tab-history"); if (th) th.onclick = function () { QO.view = "history"; rerender(); loadHistory(); };

    st.querySelectorAll(".qo-sym:not(.qo-openchip)").forEach(function (b) {
      b.onclick = function () {
        var i = +b.getAttribute("data-i"); if (isNaN(i) || i === QO.symIdx) return;
        if (!QO.realPrices && QO.pos && QO.pos.status === "open") return; // simulated: symbol locked while a position is open
        QO.symIdx = i;
        // If an open position exists on the newly-selected symbol, focus it so its
        // entry/TP/SL levels overlay this chart (real mode can hold several at once,
        // one per symbol). Without this, switching to e.g. BTC while ETH is focused
        // would show the BTC chart with no overlay.
        if (QO.realPrices) {
          var sm2 = curSym(), list = QO.openPositions || [], k;
          for (k = 0; k < list.length; k++) {
            if (sm2 && list[k].symbol === sm2.symbol && (list[k].status === "open" || list[k].exitPrice != null)) { QO.focusId = list[k].id; break; }
          }
          syncFocus();
          rerender(); fetchChart(true);
        }
        else { var sm = curSym(); if (sm) QO.amb[sm.symbol] = buildAmbient(sm); rerender(); }
      };
    });
    // Open-position chips use ONE delegated listener bound to #qo-stage exactly once
    // (see the delegation block at the top of wireStage), so taps survive every
    // innerHTML re-render.
    var mc = T("#qo-m-candle"); if (mc) mc.onclick = function () { QO.chartMode = "candle"; rerender(); };
    var ml = T("#qo-m-line"); if (ml) ml.onclick = function () { QO.chartMode = "line"; rerender(); };

    if (QO.view === "trade" && (QO.realPrices || !(QO.pos && QO.pos.status === "open"))) {
      var lo = T("#qo-long"); if (lo) lo.onclick = function () { if (QO.dir !== "long") { QO.dir = "long"; rerender(); } };
      var sh = T("#qo-short"); if (sh) sh.onclick = function () { if (QO.dir !== "short") { QO.dir = "short"; rerender(); } };
      var stake = T("#qo-stake"), range = T("#qo-range");
      if (stake) stake.oninput = function () { QO.stake = Math.max(0, Math.floor(+stake.value || 0)); if (range && QO.stake <= +range.max) range.value = QO.stake; syncPayout(); };
      if (range) range.oninput = function () { QO.stake = Math.floor(+range.value); if (stake) stake.value = QO.stake; syncPayout(); };
      st.querySelectorAll(".qo-chip").forEach(function (b) {
        b.onclick = function () { var v = b.getAttribute("data-v"); QO.stake = v === "max" ? Math.max(QO.min, Math.floor(balNum())) : Math.max(QO.min, +v); if (stake) stake.value = QO.stake; if (range) range.value = Math.min(QO.stake, +range.max); syncPayout(); };
      });
      st.querySelectorAll(".qo-exp[data-tl]").forEach(function (b) {
        b.onclick = function () { var i = +b.getAttribute("data-tl"); if (i !== QO.timeLimitIdx) { QO.timeLimitIdx = i; rerender(); } };
      });
      var vtog = T("#qo-void-tog"); if (vtog) vtog.onclick = function () { QO.voidOnTimeout = !QO.voidOnTimeout; rerender(); };
      var tpI = T("#qo-tp"); if (tpI) tpI.oninput = function () { QO.manualTP = tpI.value; };
      var slI = T("#qo-sl"); if (slI) slI.oninput = function () { QO.manualSL = slI.value; };
      var open = T("#qo-open"); if (open) open.onclick = openPosition;
    }
    var exitBtn = T("#qo-exit"); if (exitBtn) exitBtn.onclick = cashOutPosition;
  }
  function syncPayout() {
    var el = document.getElementById("qo-payout");
    if (el) el.textContent = fmtQ((Number(QO.stake) || 0) * (QO.payoutMult || 1.85));
    var open = document.getElementById("qo-open");
    if (open) {
      var enough = balNum() >= Number(QO.stake) && Number(QO.stake) >= QO.min;
      open.disabled = !enough;
    }
  }

  /* ── per-tick live refresh of the open position card ────────────────────── */
  function refreshPositionCard() {
    var p = QO.pos; if (!p || p.status !== "open") return;
    var live = document.getElementById("qo-live"); if (live) live.textContent = fmtP(Number(p.livePrice != null ? p.livePrice : p.entry), p.dp);
    var cnt = document.getElementById("qo-count"); if (cnt) cnt.textContent = mmss(p.countdownMs != null ? p.countdownMs : 0);
    var prog = Number(p.progress) || 0;
    var bar = document.getElementById("qo-prog"); if (bar) { bar.style.width = progWidth(prog) + "%"; bar.style.background = prog >= 0 ? TH().green : TH().red; }
    var lab = document.getElementById("qo-prog-lab"); if (lab) lab.textContent = progLabel(prog);
  }

  /* ── open a position (server-authoritative) ─────────────────────────────── */
  function openPosition() {
    if (QO.busy) return;
    var sym = curSym(); if (!sym) return;
    var stake = Math.floor(Number(QO.stake) || 0);
    if (stake < QO.min) { toast("Minimum stake is " + fmtQ(QO.min) + " QNTM", "error"); return; }
    if (balNum() < stake) { toast("Not enough QNTM in your wallet", "error"); return; }
    QO.busy = true;
    var btn = document.getElementById("qo-open"); if (btn) { btn.disabled = true; btn.style.opacity = ".6"; }
    API("/quantoption/open", { method: "POST", body: { symbol: sym.symbol, direction: QO.dir, timeLimitSec: curTimeLimit(), stake: stake, target: QO.manualTP, stop: QO.manualSL } })
      .then(function (r) {
        QO.busy = false;
        var p = r && r.position; if (!p) { toast("Could not open position", "error"); rerender(); return; }
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
        if (window.dqQOFx && window.dqQOFx.opened) { try { window.dqQOFx.opened(sym.label || sym.symbol, QO.dir); } catch (e) {} }
        QO.manualTP = ""; QO.manualSL = "";
        if (QO.realPrices) {
          QO.focusId = p.id;
          return loadMe().catch(function () {}).then(function () { QO.focusId = p.id; syncFocus(); QO.view = "trade"; rerender(); startRealEngine(); });
        }
        QO.pos = p;
        return loadMe().catch(function () {}).then(function () { QO.pos = p; QO.view = "trade"; rerender(); startPoll(); });
      })
      .catch(function (e) {
        QO.busy = false;
        toast((e && e.error && (e.error.message || e.error)) || (e && e.message) || "Could not open position", "error");
        rerender();
      });
  }

  /* ── poll an open position; settle → result popup ───────────────────────── */
  function cashOutPosition() {
    var p = QO.pos; if (!p || p.status !== "open" || QO.busy) return;
    if (typeof confirm === "function" && !confirm("Exit this position now at the current market price?")) return;
    QO.busy = true;
    var btn = document.getElementById("qo-exit"); if (btn) { btn.disabled = true; btn.style.opacity = ".6"; }
    API("/quantoption/cashout/" + p.id, { method: "POST" }).then(function (r) {
      QO.busy = false;
      var sp = r && r.position; if (!sp) { toast("Could not exit position", "error"); rerender(); return; }
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
      return loadMe().catch(function () {}).then(function () {
        if (QO.realPrices) { QO.focusId = null; syncFocus(); stopRealEngine(); }
        else { QO.pos = null; stopPoll(); }
        showResult(sp);
        rerender();
        if (QO.realPrices && QO.openPositions && QO.openPositions.length) startRealEngine();
      });
    }).catch(function (e) {
      QO.busy = false;
      toast((e && e.error && (e.error.message || e.error)) || (e && e.message) || "Could not exit position", "error");
      rerender();
    });
  }
  function startPoll() {
    stopAmbient(); stopPoll();
    if (!QO.pos || QO.pos.status !== "open") return;
    var id = QO.pos.id;
    var tick = function () {
      API("/quantoption/position/" + id).then(function (r) {
        var p = r && r.position; if (!p) return;
        QO.pos = p;
        if (p.status !== "open") { stopPoll(); onResolved(p); return; }
        if (document.getElementById("qo-stage") && QO.view === "trade") { drawChart(); refreshPositionCard(); }
      }).catch(function () {});
    };
    QO.pollTimer = setInterval(tick, POLL_MS);
    tick();
  }
  function stopPoll() { if (QO.pollTimer) { clearInterval(QO.pollTimer); QO.pollTimer = null; } }

  function onResolved(p) {
    if (navigator.vibrate) { try { navigator.vibrate(p.status === "won" ? [10, 40, 10] : 22); } catch (e) {} }
    showResult(p);
    loadMe().then(function () { QO.pos = null; if (document.getElementById(OV_ID)) { rerender(); startAmbient(); } }).catch(function () {});
  }

  function showResult(p) {
    var c = TH();
    var win = p.status === "won", draw = p.status === "draw", voidR = p.status === "void";
    if (win && window.dqQOFx) { try { window.dqQOFx.burst(); } catch (e) {} }
    var col = win ? c.green : draw ? c.gold : voidR ? c.t3 : c.red;
    var title = win ? "WIN" : draw ? "DRAW" : voidR ? "VOID" : "LOSS";
    var profit = win ? (Number(p.payout) - Number(p.stake)) : (draw || voidR) ? 0 : -Number(p.stake);
    var icon = win ? '<path d="M20 6L9 17l-5-5"/>' : draw ? '<path d="M5 12h14"/>' : voidR ? '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>' : '<path d="M18 6 6 18M6 6l12 12"/>';
    var ov = document.createElement("div");
    ov.id = "qo-result";
    ov.style.cssText = "position:fixed;inset:0;z-index:6300;display:flex;align-items:center;justify-content:center;padding:22px;background:rgba(3,6,14,.76);-webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px)";
    ov.innerHTML =
      '<div style="width:min(370px,93vw);max-height:90vh;overflow-y:auto;border-radius:16px;background:' + c.panel + ';border:1px solid ' + c.bd + ';box-shadow:0 24px 70px rgba(0,0,0,.6);animation:qoPop .26s cubic-bezier(.2,.8,.3,1)">' +
        '<div style="padding:26px 22px 16px;text-align:center;background:radial-gradient(120% 100% at 50% 0%,' + hexA(col, .22) + ',transparent)">' +
          '<div style="width:58px;height:58px;border-radius:50%;margin:0 auto;display:flex;align-items:center;justify-content:center;background:' + hexA(col, .16) + ';animation:qoStamp .5s cubic-bezier(.2,1.2,.3,1)">' +
            '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="' + col + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' + icon + '</svg></div>' +
          '<div style="font-size:30px;font-weight:900;letter-spacing:2px;color:' + col + ';margin-top:10px">' + title + '</div>' +
          '<div style="font-size:24px;font-weight:800;color:' + c.t1 + ';margin-top:4px;font-variant-numeric:tabular-nums">' + fmtSigned(profit) + ' <span style="font-size:13px;color:' + c.t3 + '">QNTM</span></div>' + (voidR ? '<div style="font-size:11.5px;color:' + c.t3 + ';margin-top:7px;line-height:1.4">Stake refunded — the trade didn’t reach TP or SL before the time limit.</div>' : '') +
        '</div>' +
        '<div style="padding:14px 18px 4px">' +
          kv("Symbol", ESC((p.label || p.symbol) + " · " + (p.dir === "long" ? "Long" : "Short")), c) +
          kv("Entry", fmtP(Number(p.entry), p.dp), c) +
          kv("Exit", fmtP(Number(p.exitPrice != null ? p.exitPrice : p.entry), p.dp), c) +
          kv("TP3 / SL", fmtP(Number(p.target), p.dp) + " / " + fmtP(Number(p.stop), p.dp), c) +
          kv("Stake", fmtQ(p.stake) + " QNTM", c) +
          kv("Payout", fmtQ(p.payout) + " QNTM", c) +
          kv("New balance", fmtQ(QO.balance) + " QNTM", c) +
        '</div>' +
        (QO.realPrices
          ? '<div style="margin:8px 18px 0;padding:11px 12px;border-radius:8px;background:' + c.panel3 + ';border:1px solid ' + c.bdSoft + '">' +
              '<div class="qo-fair"><span>Settled on real ' + realFeedWord() + ' market prices — exit ' + fmtP(Number(p.exitPrice != null ? p.exitPrice : p.entry), p.dp) + '</span></div>' +
            '</div>'
          : '<div style="margin:8px 18px 0;padding:11px 12px;border-radius:8px;background:' + c.panel3 + ';border:1px solid ' + c.bdSoft + '">' +
              '<div class="qo-fair" style="margin-bottom:6px">' + ICO('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', 12) + '<span>Provably fair — verify the path</span></div>' +
              '<div style="font-family:ui-monospace,monospace;font-size:9px;color:' + c.t3 + ';word-break:break-all;line-height:1.5"><b style="color:' + c.t4 + '">hash</b> ' + ESC(p.seedHash || "") + '<br><b style="color:' + c.t4 + '">seed</b> ' + ESC(p.serverSeed || "(revealed at settle)") + '</div>' +
            '</div>') +
        '<div style="padding:14px 18px 18px"><button type="button" id="qo-result-x" style="width:100%;padding:13px 0;border-radius:9px;border:none;cursor:pointer;font-size:14px;font-weight:800;color:#fff;background:linear-gradient(180deg,' + c.blue + ',#2456d8)">Back to Trade</button></div>' +
      '</div>';
    document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    var b = ov.querySelector("#qo-result-x"); if (b) b.onclick = close;
  }
  function kv(k, v, c) {
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid ' + c.bdSoft + '"><span style="font-size:12px;color:' + c.t3 + '">' + k + '</span><span style="font-size:12px;font-weight:700;color:' + c.t1 + ';font-variant-numeric:tabular-nums">' + v + '</span></div>';
  }

  function loadHistory() {
    API("/quantoption/history?limit=40").then(function (r) { QO.history = r || { items: [], summary: {} }; if (QO.view === "history") rerender(); })
      .catch(function () { QO.history = { items: [], summary: {} }; if (QO.view === "history") rerender(); });
  }

  /* ── ambient ticker control ─────────────────────────────────────────────── */
  function startAmbient() {
    stopAmbient();
    if (QO.realPrices) return;                       // real mode uses the chart/positions pollers
    if (QO.pos && QO.pos.status === "open") return;  // poll drives the chart instead
    QO.ambTimer = setInterval(tickAmbient, AMB_MS);
  }
  function stopAmbient() { if (QO.ambTimer) { clearInterval(QO.ambTimer); QO.ambTimer = null; } }

  /* ── open / close overlay ───────────────────────────────────────────────── */
  function onKey(e) {
    if (e.key !== "Escape") return;
    var r = document.getElementById("qo-result");
    if (r) { if (r.parentNode) r.parentNode.removeChild(r); return; }
    closeQO();
  }
  function onResize() { drawChart(); }

  function closeQO() {
    stopAmbient(); stopPoll(); stopRealEngine();
    var o = document.getElementById(OV_ID); if (o && o.parentNode) o.parentNode.removeChild(o);
    QO.overlayOpen = false;
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
  }

  function openQO() {
    if (document.getElementById(OV_ID)) return;
    injectCSS();
    var c = TH();
    var ov = document.createElement("div");
    ov.id = OV_ID;
    var bar = (window.dqAppNav ? window.dqAppNav.html("quant") : "");
    ov.innerHTML = headerHTML() +
      '<div class="qo-stage" id="qo-stage"><div class="qo-empty">Loading…</div></div>' + bar;
    document.body.appendChild(ov);
    QO.overlayOpen = true;
    var x = ov.querySelector("#qo-x"); if (x) x.onclick = closeQO;
    if (window.dqAppNav) window.dqAppNav.wire(ov, "quant", closeQO);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);

    loadMe().then(function () {
      if (QO.realPrices) {
        rerender();
        fetchChart(true).then(function () { rerender(); startRealEngine(); });
      } else {
        var sm = curSym(); if (sm) QO.amb[sm.symbol] = buildAmbient(sm);
        rerender();
        if (QO.pos && QO.pos.status === "open") { startPoll(); } else { startAmbient(); }
      }
    }).catch(function (e) {
      var st = document.getElementById("qo-stage");
      if (st) st.innerHTML = '<div class="qo-empty">Could not load Quant Option.<br>' + ESC((e && e.message) || "Please try again.") + '</div>';
    });
  }

  /* ── public API ─────────────────────────────────────────────────────────── */
  /* -- real-price helpers + engine (active when QO.realPrices) -- */
  function feedLabel() {
    if (!QO.realPrices) return "simulated feed";
    var p = QO.chartProvider;
    return p === "binance" ? "live · Binance" : p === "twelvedata" ? "live · TwelveData" : "live feed";
  }
  function realFeedWord() {
    return QO.chartProvider === "binance" ? "Binance" : QO.chartProvider === "twelvedata" ? "TwelveData" : "live";
  }
  function headlinePrice(sym) {
    if (!sym) return 0;
    if (QO.realPrices) {
      var rc = QO.realCandles[sym.symbol];
      if (rc && rc.length) return rc[rc.length - 1].c;
      var fp = focusPos(); if (fp && fp.livePriceRaw != null && fp.symbol === sym.symbol) return Number(fp.livePriceRaw);
      return sym.price != null ? sym.price : sym.base; // placeholder until /chart arrives
    }
    return sym.price != null ? sym.price : sym.base;
  }
  function overlayPos() {
    var p;
    if (QO.realPrices) { var fp = focusPos(); p = (fp && (fp.status === "open" || fp.exitPrice != null)) ? fp : null; }
    else { p = (QO.pos && (QO.pos.status === "open" || QO.pos.exitPrice != null)) ? QO.pos : null; }
    if (!p) return null;
    var cs = curSym();
    if (cs && p.symbol && cs.symbol !== p.symbol) return null;  // levels belong to another symbol's chart
    return p;
  }
  // unified chart series: {candles:[{t,o,h,l,c}], line:[{t,price}], live, dp}
  function chartSeries() {
    var sym = curSym(), fp = focusPos();
    var fpOnChart = !!(fp && sym && fp.symbol === sym.symbol);  // focused position is the charted symbol
    var dp = (fpOnChart && fp.dp != null) ? fp.dp : (sym ? sym.dp : 2);
    if (QO.realPrices) {
      var rc = (sym && QO.realCandles[sym.symbol]) ? QO.realCandles[sym.symbol] : [];
      var candles = rc.slice();
      var line = candles.map(function (k) { return { t: k.t, price: k.c }; });
      var live = null;
      if (fpOnChart && fp.status === "open" && fp.livePriceRaw != null) live = Number(fp.livePriceRaw);
      else if (candles.length) live = candles[candles.length - 1].c;
      return { candles: candles, line: line, live: live, dp: dp };
    }
    var pts = seriesPoints();
    return { candles: toCandles(pts, CANDLE_TICKS), line: pts, live: pts.length ? pts[pts.length - 1].price : null, dp: dp };
  }
  // compact switcher row of all open positions (shown when more than one)
  function openSwitcherHTML() {
    var c = TH(); var list = QO.openPositions || [];
    return '<div class="qo-lab" style="padding:0 1px 6px">Open positions · ' + list.length + '</div>' +
      '<div class="qo-syms" style="margin-bottom:11px">' + list.map(function (p) {
        var on = p.id === QO.focusId, dirCol = p.dir === "long" ? c.green : c.red;
        return '<div class="qo-sym qo-openchip ' + (on ? "on" : "") + '" data-id="' + p.id + '" style="min-width:108px' + (on ? (";border-color:" + hexA(dirCol, .6) + ";background:" + hexA(dirCol, .12)) : "") + '">' +
          '<div class="nm" style="' + (on ? ("color:" + dirCol) : "") + '">' + ESC(p.label || p.symbol) + ' ' + (p.dir === "long" ? "▲" : "▼") + '</div>' +
          '<div class="px">' + fmtQ(p.stake) + ' · ' + mmss(p.countdownMs != null ? p.countdownMs : 0) + '</div></div>';
      }).join("") + '</div>';
  }
  function refreshOpenChips() {
    var list = QO.openPositions || [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i], chip = document.querySelector('.qo-openchip[data-id="' + p.id + '"]');
      if (chip) { var px = chip.querySelector(".px"); if (px) px.textContent = fmtQ(p.stake) + " · " + mmss(p.countdownMs != null ? p.countdownMs : 0); }
    }
  }
  function chartCadence() { return QO.chartProvider === "twelvedata" ? 30000 : 5000; }
  function fetchChart(force) {
    var sym = curSym(); if (!sym || !QO.realPrices) return Promise.resolve();
    if (QO.chartBusy && !force) return Promise.resolve();
    QO.chartBusy = true;
    return API("/quantoption/chart?symbol=" + encodeURIComponent(sym.symbol) + "&limit=200").then(function (r) {
      QO.chartBusy = false;
      if (!r || !Array.isArray(r.candles)) return;
      QO.chartErr = null;
      if (r.provider) QO.chartProvider = r.provider;
      QO.realCandles[sym.symbol] = r.candles.map(function (k) {
        return { t: (Number(k.time) || 0) * 1000, o: Number(k.open), h: Number(k.high), l: Number(k.low), c: Number(k.close) };
      });
      if (document.getElementById("qo-stage") && QO.view === "trade") {
        var sub = document.getElementById("qo-pxsub"); if (sub) sub.textContent = (sym.label || sym.symbol) + " · " + feedLabel();
        var pxEl = document.getElementById("qo-px"); if (pxEl) pxEl.textContent = fmtP(headlinePrice(sym), sym.dp);
        drawChart();
      }
    }).catch(function (e) {
      QO.chartBusy = false;
      var blob = (((e && e.code) || (e && e.error && e.error.code) || "") + " " +
                  ((e && e.error && (e.error.message || e.error)) || (e && e.message) || ""));
      QO.chartErr =
        /run out|credit|rate|limit|429|too many/i.test(blob) ? "FX feed hit its rate limit \u2014 try again shortly" :
        /feed_unconfigured|not set|api[_ ]?key|not configured/i.test(blob) ? "FX chart feed isn\u2019t configured on the server" :
        /feed_unavailable|no real feed/i.test(blob) ? "No live chart feed for this symbol" :
        "Chart temporarily unavailable \u2014 retrying";
      if (document.getElementById("qo-stage") && QO.view === "trade") drawChart();
    });
  }
  function startChartPoll() { stopChartPoll(); if (!QO.realPrices) return; QO.chartTimer = setInterval(function () { fetchChart(false); }, chartCadence()); }
  function stopChartPoll() { if (QO.chartTimer) { clearInterval(QO.chartTimer); QO.chartTimer = null; } }
  /* real-mode: keep the symbol-picker strip prices live (real spots, server-cached) */
  function updateStripPrices() {
    var els = document.querySelectorAll(".qo-symp");
    for (var i = 0; i < els.length; i++) {
      var idx = +els[i].getAttribute("data-i"); var s2 = QO.symbols[idx];
      if (s2 && s2.price != null) els[i].textContent = fmtP(s2.price, s2.dp);
    }
  }
  function fetchPrices() {
    return API("/quantoption/prices").then(function (r) {
      if (!r || !Array.isArray(r.symbols) || !r.symbols.length) return;
      QO.symbols = r.symbols;                       // same order as SYMBOLS, indices stay valid
      if (document.getElementById("qo-stage") && QO.view === "trade") updateStripPrices();
    }).catch(function () {});
  }
  function startSymPoll() { stopSymPoll(); if (!QO.realPrices) return; fetchPrices(); QO.symTimer = setInterval(fetchPrices, 5000); }
  function stopSymPoll() { if (QO.symTimer) { clearInterval(QO.symTimer); QO.symTimer = null; } }
  // celebratory pop as the live price crosses each TP (once per position+level)
  function checkTpCross(list) {
    if (!window.dqQOFx || !list || !list.length) return;
    var c = TH();
    for (var i = 0; i < list.length; i++) {
      var p = list[i]; if (!p || p.status !== "open") continue;
      var live = Number(p.livePrice != null ? p.livePrice : p.livePriceRaw); if (!isFinite(live)) continue;
      var up = p.dir === "long";
      var first = !QO.tpHit[p.id + ":seen"]; QO.tpHit[p.id + ":seen"] = 1;
      var tps = [["TP1", p.tp1], ["HALF", (Number(p.tp1) + Number(p.tp2)) / 2], ["TP2", p.tp2], ["TP3", p.tp3]];
      for (var k = 0; k < tps.length; k++) {
        var nm = tps[k][0], lv = Number(tps[k][1]); if (!isFinite(lv)) continue;
        var hit = up ? live >= lv : live <= lv, key = p.id + ":" + nm;
        if (hit && !QO.tpHit[key]) { QO.tpHit[key] = 1; if (!first) window.dqQOFx.target(nm); }
      }
    }
  }
  function startPosPoll() {
    stopPosPoll(); if (!QO.realPrices) return;
    var tick = function () {
      if (!QO.openPositions || !QO.openPositions.length) { stopPosPoll(); return; }
      var prev = {}; QO.openPositions.forEach(function (p) { prev[p.id] = 1; });
      API("/quantoption/positions").then(function (r) {
        var list = (r && Array.isArray(r.positions)) ? r.positions : [];
        var liveIds = {}; list.forEach(function (p) { liveIds[p.id] = 1; });
        Object.keys(prev).forEach(function (id) { if (!liveIds[id]) resolveSettled(Number(id)); });
        QO.openPositions = list; syncFocus(); checkTpCross(list);
        if (document.getElementById("qo-stage") && QO.view === "trade") { drawChart(); refreshPositionCard(); refreshOpenChips(); }
        if (!list.length) stopPosPoll();
      }).catch(function () {});
    };
    QO.posTimer = setInterval(tick, 5000);
    tick();
  }
  function stopPosPoll() { if (QO.posTimer) { clearInterval(QO.posTimer); QO.posTimer = null; } }
  function resolveSettled(id) {
    API("/quantoption/position/" + id).then(function (r) {
      var p = r && r.position; if (!p || p.status === "open") return;
      if (navigator.vibrate) { try { navigator.vibrate(p.status === "won" ? [10, 40, 10] : 22); } catch (e) {} }
      showResult(p);
      loadMe().then(function () { if (document.getElementById(OV_ID) && QO.view === "trade") rerender(); }).catch(function () {});
    }).catch(function () {});
  }
  // local countdown so timers tick smoothly between position polls
  function startCountdown() {
    stopCountdown(); if (!QO.realPrices) return;
    QO.countTimer = setInterval(function () {
      var list = QO.openPositions || [], changed = false, i;
      for (i = 0; i < list.length; i++) { if (list[i].countdownMs != null) { list[i].countdownMs = Math.max(0, list[i].countdownMs - 250); changed = true; } }
      if (changed && document.getElementById("qo-stage") && QO.view === "trade") { refreshPositionCard(); refreshOpenChips(); }
    }, 250);
  }
  function stopCountdown() { if (QO.countTimer) { clearInterval(QO.countTimer); QO.countTimer = null; } }
  function startRealEngine() {
    if (!QO.realPrices) return;
    startChartPoll();
    startSymPoll();
    if (QO.openPositions && QO.openPositions.length) { startPosPoll(); startCountdown(); }
  }
  function stopRealEngine() { stopChartPoll(); stopSymPoll(); stopPosPoll(); stopCountdown(); }

  window.openQuantOption = openQO;
  window.dqQuantOption = {
    open: openQO,
    _pure: { clockPrice: clockPrice, toCandles: toCandles, progWidth: progWidth, expLabel: expLabel }
  };
})();

/* celebratory FX, shared with the signals module via window.dqQOFx */
(function () {
  if (window.dqQOFx && window.dqQOFx.v2) return;
  try {
    var s = document.getElementById("qo-fx-kf") || document.createElement("style");
    s.id = "qo-fx-kf";
    s.textContent =
      "@keyframes qoFxRise{0%{opacity:0;transform:translate(-50%,10px) scale(.82)}16%{opacity:1;transform:translate(-50%,0) scale(1.08)}32%{transform:translate(-50%,0) scale(1)}100%{opacity:0;transform:translate(-50%,-48px) scale(1)}}" +
      "@keyframes qoFxConfetti{0%{opacity:1;transform:translateY(0) rotate(0deg)}100%{opacity:0;transform:translateY(240px) rotate(560deg)}}" +
      "@keyframes qoFxFlash{0%{opacity:.55;transform:translate(-50%,-50%) scale(.4)}100%{opacity:0;transform:translate(-50%,-50%) scale(2.6)}}" +
      "@keyframes qoMsIn{0%{transform:translateX(-50%) translateY(-26px);opacity:0}100%{transform:translateX(-50%) translateY(0);opacity:1}}" +
      "@keyframes qoMsBar{from{transform:scaleX(1)}to{transform:scaleX(0)}}" +
      "@keyframes qoConf{0%{transform:translateY(0) rotate(0deg);opacity:1}100%{transform:translateY(112vh) rotate(680deg);opacity:.14}}";
    if (!s.parentNode) document.head.appendChild(s);
  } catch (e) {}
  function esc(x) { return String(x == null ? "" : x).replace(/[&<>"]/g, function (m) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]; }); }
  function hexA(hex, a) { hex = String(hex || "#1c84ff"); if (hex.charAt(0) !== "#") return hex; var h = hex.slice(1); if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2); var n = parseInt(h, 16); return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")"; }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function ring(pct, color) {
    var r = 18, cc = 2 * Math.PI * r, off = cc * (1 - Math.max(0, Math.min(100, pct)) / 100);
    return '<svg width="46" height="46" viewBox="0 0 46 46" style="flex-shrink:0">' +
      '<circle cx="23" cy="23" r="' + r + '" fill="none" stroke="' + hexA(color, .18) + '" stroke-width="4"/>' +
      '<circle cx="23" cy="23" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="4" stroke-linecap="round" stroke-dasharray="' + cc.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" transform="rotate(-90 23 23)"/>' +
      '<text x="23" y="27" text-anchor="middle" font-size="12" font-weight="800" fill="' + color + '" font-family="Outfit,sans-serif">' + Math.round(pct) + '%</text></svg>';
  }
  function milestone(opts) {
    try {
      opts = opts || {};
      var color = opts.color || "#1c84ff", ttl = opts.ttl || 3600;
      var ex = document.getElementById("qo-ms"); if (ex) ex.remove();
      var wrap = document.createElement("div");
      wrap.id = "qo-ms";
      wrap.style.cssText = "position:fixed;top:calc(14px + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);z-index:6600;width:calc(100% - 26px);max-width:430px;cursor:pointer";
      wrap.innerHTML =
        '<div style="display:flex;align-items:center;gap:13px;padding:13px 15px;border-radius:14px;background:linear-gradient(135deg,' + hexA(color, .26) + ',' + hexA(color, .07) + '),rgba(13,21,37,.94);border:1px solid ' + hexA(color, .55) + ';box-shadow:0 16px 44px ' + hexA(color, .32) + ';-webkit-backdrop-filter:blur(20px) saturate(160%);backdrop-filter:blur(20px) saturate(160%);animation:qoMsIn .5s cubic-bezier(.2,1.2,.3,1)">' +
          (opts.pct != null ? ring(opts.pct, color) : "") +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:15px;font-weight:900;color:' + color + ';letter-spacing:.2px">' + (opts.emoji ? opts.emoji + " " : "") + esc(opts.title || "") + '</div>' +
            (opts.line ? '<div style="font-size:12px;color:#9fb0cc;margin-top:2px;line-height:1.4">' + esc(opts.line) + '</div>' : "") +
          '</div>' +
        '</div>' +
        '<div style="height:3px;border-radius:3px;margin:5px 14px 0;transform-origin:left;background:' + color + ';animation:qoMsBar ' + ttl + 'ms linear forwards"></div>';
      document.body.appendChild(wrap);
      wrap.onclick = function () { wrap.remove(); };
      setTimeout(function () {
        if (!wrap.parentNode) return;
        wrap.style.transition = "opacity .3s,transform .3s";
        wrap.style.opacity = "0"; wrap.style.transform = "translateX(-50%) translateY(-14px)";
        setTimeout(function () { if (wrap.parentNode) wrap.remove(); }, 300);
      }, ttl);
    } catch (e) {}
  }
  function MS_TP1() { return { pct: 33, color: "#22c55e", emoji: "\uD83C\uDFAF", title: "Target 1 hit!", line: pick(["You\u2019re 33% of the way \u2014 momentum\u2019s on your side!", "First target smashed \u2014 the win is heating up.", "Great start \u2014 33% locked in, keep riding it!"]) }; }
  function MS_TP2() { return { pct: 66, color: "#22c55e", emoji: "\uD83D\uDD25", title: "Target 2 hit!", line: pick(["66% there \u2014 you can almost taste the win!", "On fire \u2014 two targets down, one to go.", "So close \u2014 66% done, hold the line!"]) }; }
  function MS_TP3() { return { pct: 100, color: "#ffcf5a", emoji: "\uD83D\uDE80", title: "Final target hit!", line: pick(["Bullseye \u2014 the settlement target is in!", "Full distance \u2014 that\u2019s the maximum run!", "Nailed it \u2014 every target cleared!"]) }; }
  function MS_HALF() { return { pct: 50, color: "#1c84ff", emoji: "\uD83D\uDCC8", title: "Halfway there!", line: pick(["50% of the way to target \u2014 keep it going!", "Past the midpoint \u2014 the target\u2019s in sight!", "Halfway home \u2014 momentum\u2019s building!"]) }; }
  function target(name) {
    var n = String(name || "").toUpperCase();
    if (n === "TP1") return milestone(MS_TP1());
    if (n === "TP2") return milestone(MS_TP2());
    if (n === "TP3") return milestone(MS_TP3());
    if (n === "HALF") return milestone(MS_HALF());
    return milestone({ pct: 100, color: "#22c55e", emoji: "\uD83C\uDFAF", title: name + " reached" });
  }
  function opened(label, dir) {
    var d = String(dir || "").toLowerCase();
    var side = d === "short" ? "Short" : d === "long" ? "Long" : "";
    var lab = label ? String(label) : "";
    var line = lab ? (lab + (side ? " \u00b7 " + side : "")) : side;
    line = line ? (line + " is running \u2014 targets are set.") : "Your position is live \u2014 targets are set.";
    return milestone({ color: "#1c84ff", emoji: "\u26A1", title: "Trade live!", line: line, ttl: 2800 });
  }
  function pop(text, color) {
    color = color || "#1c84ff";
    var el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = "position:fixed;left:50%;top:33%;z-index:6400;pointer-events:none;font-family:Outfit,system-ui,sans-serif;font-weight:800;font-size:15px;letter-spacing:.3px;color:#fff;padding:8px 16px;border-radius:999px;white-space:nowrap;background:" + color + ";box-shadow:0 12px 32px " + color + "66;animation:qoFxRise 1.5s cubic-bezier(.2,.8,.3,1) forwards";
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 1650);
  }
  function burst() {
    var wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;z-index:6650;pointer-events:none;overflow:hidden";
    var fl = document.createElement("div");
    fl.style.cssText = "position:absolute;left:50%;top:40%;width:200px;height:200px;border-radius:50%;background:radial-gradient(circle,rgba(34,197,94,.5),transparent 70%);animation:qoFxFlash .7s ease-out forwards";
    wrap.appendChild(fl);
    var cols = ["#22c55e", "#1c84ff", "#5aa9ff", "#ffcf5a", "#ff5c8a", "#ffffff"];
    for (var i = 0; i < 48; i++) {
      var p = document.createElement("span");
      var sz = 6 + Math.round(Math.random() * 7);
      p.style.cssText = "position:absolute;top:-16px;left:" + (Math.random() * 100) + "%;width:" + sz + "px;height:" + Math.round(sz * 0.55) + "px;background:" + cols[i % cols.length] + ";opacity:.95;border-radius:2px;transform:rotate(" + Math.round(Math.random() * 360) + "deg);animation:qoConf " + (1.5 + Math.random() * 1.3).toFixed(2) + "s " + (Math.random() * 0.45).toFixed(2) + "s cubic-bezier(.25,.6,.4,1) forwards";
      wrap.appendChild(p);
    }
    document.body.appendChild(wrap);
    setTimeout(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 3500);
  }
  window.dqQOFx = { v2: true, pop: pop, burst: burst, milestone: milestone, target: target, opened: opened, MS_TP1: MS_TP1, MS_TP2: MS_TP2, MS_TP3: MS_TP3, MS_HALF: MS_HALF };
})();
