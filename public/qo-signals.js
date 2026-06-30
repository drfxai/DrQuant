/* ===========================================================================
 * qo-signals.js — Quant Option SIGNAL trading UI (real God Mode trades)
 * ---------------------------------------------------------------------------
 * A SEPARATE IIFE from quant-option.js on purpose: this drives the signal side
 * (list live signals → confirm with stake + optional time limit → open a real,
 * God-Mode-bound position → watch it on a REAL-price chart → settle on the real
 * TP/SL). Because it is its own script, a fault here cannot break the validated
 * quick-trade terminal — the worst case is the signal feature is unavailable.
 *
 * Safety: a position always opens from the TRUSTED server signal store (by its
 * extId), never from chat message text. The chat "Trade on Quant Option" button
 * (wired separately) only matches a message to a live stored signal; the open
 * itself goes through POST /api/quantoption/open-signal {extId,...}.
 *
 * Real prices: crypto (BTC/ETH/SOL/BNB-USDT) render on TradingView Lightweight
 * Charts via window.dqQOChart fed by window.dqQORealPrice (Binance). FX/metals
 * have no free feed, so they show a clean levels panel instead — by design.
 *
 * Backend (all built in Stage 3):
 *   GET  /api/quantoption/signals               live signals (trusted store)
 *   GET  /api/quantoption/me                    wallet balance + pool
 *   POST /api/quantoption/open-signal           { extId, stake, timeLimitSec? }
 *   GET  /api/quantoption/signal-position/:id   poll a signal position
 *   GET  /api/quantoption/admin/webhook         admin: webhook URL to copy
 *
 * Globals reused (with fallbacks): t, esc, ic, api, S, showToast, hexA, dqAppNav.
 * Exposes: window.dqQOSignals = { open, openForSignal, tradeButtonHTML, refresh }.
 * Load after quant-option.js + qo-realprice.js + qo-chart.js.
 * =========================================================================== */
(function () {
  "use strict";
  if (window.dqQOSignals) return;

  var OV_ID = "qs-ov";
  var POLL_MS = 2000;            // signal positions track a real trade — slow cadence is fine
  var PAYOUT_MULT = 1.85;        // display only; server is source of truth
  var PROFIT_PCT = 85;

  /* ── safe accessors (this IIFE shares page globals but not QO internals) ── */
  var FALLBACK_T = { pr: "#3b82f6", pgw: "rgba(59,130,246,.5)", t1: "#e9f0fc", t2: "#9fb0cc", t3: "#6f819e" };
  function TG() { return (typeof t !== "undefined" && t) ? t : FALLBACK_T; }
  function ICO(p, s) { return (typeof ic === "function") ? ic(p, s) : '<svg width="' + (s || 18) + '" height="' + (s || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'; }
  function ESC(x) { return (typeof esc === "function") ? esc(x) : String(x == null ? "" : x).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function toast(a, b) { if (typeof showToast === "function") showToast(a, b); }
  function API(path, opts) { if (typeof api !== "function") return Promise.reject(new Error("offline")); return api(path, opts); }
  function meUser() { return (typeof S !== "undefined" && S && S.user) ? S.user : null; }
  function isAdmin() { var u = meUser(); return !!(u && (u.role === "admin" || u.role === "superadmin")); }
  function hexA(hex, a) {
    if (typeof window.hexA === "function") return window.hexA(hex, a);
    var h = String(hex || "").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16); if (isNaN(n)) return hex;
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }
  function TH() {
    var x = TG();
    return {
      bg: "#070b16", panel: "#0d1525", panel2: "#101a2c", panel3: "#0a1120",
      bd: "rgba(120,150,200,.16)", bdSoft: "rgba(120,150,200,.09)",
      t1: "#eaf1fc", t2: "#9fb0cc", t3: "#6f819e", t4: "#54658a",
      blue: x.pr || "#3b82f6", green: "#22c55e", greenD: "#16a34a",
      red: "#f43f5e", redD: "#e11d48", gold: "#ffcf5a",
    };
  }
  function fmtQ(n) { n = Number(n); if (!isFinite(n)) n = 0; return n.toLocaleString("en-US", { maximumFractionDigits: n < 1000 ? 2 : 0 }); }
  function fmtP(v) { v = Number(v); if (!isFinite(v)) return "—"; var dp = Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 4 : 5; return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }); }
  function fmtSigned(n) { n = Number(n) || 0; return (n > 0 ? "+" : "") + n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 1000 ? 2 : 0 }); }
  function mmss(ms) { ms = Math.max(0, ms | 0); var s = Math.round(ms / 1000); var h = (s / 3600) | 0; var m = ((s % 3600) / 60) | 0; s = s % 60; return (h > 0 ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (s < 10 ? "0" : "") + s; }
  function tfLabel(tf) { return tf ? String(tf) : ""; }

  /* ── state ──────────────────────────────────────────────────────────────── */
  var SG = {
    screen: "list",        // list | confirm | position
    signals: [],           // live signals from the trusted store
    balance: "0",
    sel: null,             // selected signal for the confirm sheet
    stake: 100,
    tlOn: false, tlSec: 900,
    pos: null,             // open/most-recent signal position
    pollTimer: null,
    chart: null, realStop: null, chartTried: false,
    chartMode: "candle",   // user-selectable chart style: "candle" | "line" (both real prices)
    openPos: null,         // the user's current open signal position (for resume after exit)
    overlayOpen: false, busy: false,
    tpHit: {},             // fired TP-cross celebrations (per signal position id)
  };
  var TL_OPTS = [["5m", 300], ["15m", 900], ["1h", 3600], ["4h", 14400]];

  /* ── styles (own, prefixed qs-) ─────────────────────────────────────────── */
  function injectCSS() {
    if (document.getElementById("qs-css")) return;
    var c = TH();
    var css =
      '#qs-ov{position:fixed;inset:0;z-index:5200;display:flex;flex-direction:column;background:' + c.bg + ';font-family:Outfit,system-ui,sans-serif;padding-top:var(--sat);padding-left:var(--sal);padding-right:var(--sar);animation:qsIn .2s ease}' +
      '#qs-ov *{box-sizing:border-box}' +
      '.qs-hd{display:flex;align-items:center;gap:11px;padding:11px 14px;border-bottom:1px solid ' + c.bd + ';background:' + c.panel3 + ';flex-shrink:0}' +
      '.qs-ib{width:36px;height:36px;border-radius:9px;border:1px solid ' + c.bd + ';background:' + c.panel2 + ';color:' + c.t1 + ';cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:border-color .15s,transform .12s}' +
      '.qs-ib:hover{border-color:' + hexA(c.blue, .4) + '}' +
      '.qs-ib:active{transform:scale(.92)}' +
      '.qs-stage{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;padding:13px}' +
      '.qs-card{border-radius:10px;background:' + c.panel + ';border:1px solid ' + c.bd + ';padding:13px;margin-bottom:12px}' +
      '.qs-lab{font-size:9.5px;letter-spacing:1px;text-transform:uppercase;font-weight:800;color:' + c.t3 + ';margin-bottom:8px}' +
      '.qs-sigcard{border-radius:10px;background:' + c.panel + ';border:1px solid ' + c.bd + ';padding:12px 13px;margin-bottom:10px;cursor:pointer;transition:border-color .15s,transform .1s}' +
      '.qs-sigcard:hover{border-color:' + hexA(c.blue, .35) + '}' +
      '.qs-sigcard:active{transform:scale(.99)}' +
      '.qs-badge{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.3px}' +
      '.qs-lv{display:flex;gap:8px;margin-top:10px}' +
      '.qs-lvc{flex:1;border-radius:8px;background:' + c.panel3 + ';border:1px solid ' + c.bdSoft + ';padding:8px;text-align:center}' +
      '.qs-lvc .k{font-size:8.5px;letter-spacing:.6px;text-transform:uppercase;font-weight:800;margin-bottom:4px}' +
      '.qs-lvc .v{font-size:13px;font-weight:800;font-variant-numeric:tabular-nums;color:' + c.t1 + '}' +
      '.qs-inp{width:100%;padding:11px 13px;border-radius:8px;background:' + c.panel3 + ';border:1px solid ' + c.bd + ';color:' + c.t1 + ';font-size:18px;font-weight:800;font-family:inherit;outline:none;font-variant-numeric:tabular-nums;transition:border-color .15s,box-shadow .15s}' +
      '.qs-inp:focus{border-color:' + c.blue + ';box-shadow:0 0 0 3px ' + hexA(c.blue, .14) + '}' +
      '.qs-chips{display:flex;gap:6px;margin-top:9px}' +
      '.qs-chip{flex:1;padding:8px 0;border-radius:7px;border:1px solid ' + c.bd + ';background:' + c.panel3 + ';color:' + c.t2 + ';font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;transition:border-color .15s,color .15s,transform .1s}' +
      '.qs-chip:hover{border-color:' + hexA(c.blue, .35) + ';color:' + c.t1 + '}' +
      '.qs-chip:active{transform:scale(.95)}' +
      '.qs-tl{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:9px}' +
      '.qs-tlb{padding:9px 0;border-radius:8px;border:1px solid ' + c.bd + ';background:' + c.panel3 + ';color:' + c.t2 + ';font-size:12.5px;font-weight:800;cursor:pointer;font-family:inherit;text-align:center;transition:border-color .14s,background .14s,color .14s}' +
      '.qs-tlb:hover{border-color:' + hexA(c.blue, .35) + ';color:' + c.t1 + '}' +
      '.qs-tlb.on{border-color:' + hexA(c.blue, .55) + ';background:' + hexA(c.blue, .12) + ';color:' + c.blue + '}' +
      '.qs-cta{width:100%;padding:15px;border:none;border-radius:9px;font-weight:800;font-size:15px;letter-spacing:.2px;cursor:pointer;font-family:inherit;color:#fff;display:flex;align-items:center;justify-content:center;gap:9px;transition:transform .14s,opacity .2s,filter .15s}' +
      '.qs-cta:hover{filter:brightness(1.06)}' +
      '.qs-cta:active{transform:scale(.985)}' +
      '.qs-cta:disabled{opacity:.45;cursor:not-allowed}' +
      '.qs-chart{width:100%;height:340px;border-radius:10px;overflow:hidden;border:1px solid ' + c.bd + ';background:' + c.panel3 + ';margin-bottom:12px;box-shadow:0 1px 12px rgba(0,0,0,.22)}' +
      '.qs-cmodes{display:flex;gap:6px;margin-bottom:7px}' +
      '.qs-cmode{display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:6px 13px;border-radius:7px;border:1px solid ' + c.bd + ';background:' + c.panel3 + ';color:' + c.t2 + ';font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;transition:border-color .15s,color .15s}' +
      '.qs-cmode:hover{border-color:' + hexA(c.blue, .35) + ';color:' + c.t1 + '}' +
      '.qs-cmode.on{border-color:' + hexA(c.blue, .55) + ';background:' + hexA(c.blue, .12) + ';color:' + c.blue + '}' +
      '.qs-cmode:active{transform:scale(.96)}' +
      '.qs-toggle{width:44px;height:26px;border-radius:999px;border:none;cursor:pointer;position:relative;transition:background .18s;flex-shrink:0}' +
      '.qs-toggle .dot{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .18s}' +
      '.qs-empty{text-align:center;padding:40px 16px;color:' + c.t4 + ';font-size:12.5px}' +
      '.qs-row{display:flex;align-items:center;justify-content:space-between;gap:10px}' +
      '@keyframes qsIn{from{opacity:0}to{opacity:1}}' +
      '@keyframes qsPop{from{opacity:0;transform:translateY(14px) scale(.96)}to{opacity:1;transform:none}}' +
      '@keyframes qsPulse{0%,100%{opacity:1}50%{opacity:.4}}';
    var el = document.createElement("style"); el.id = "qs-css"; el.textContent = css; document.head.appendChild(el);
  }

  /* ── data ───────────────────────────────────────────────────────────────── */
  function loadList() {
    return Promise.all([
      API("/quantoption/signals").catch(function () { return { signals: [] }; }),
      API("/quantoption/me").catch(function () { return null; }),
    ]).then(function (res) {
      SG.signals = (res[0] && Array.isArray(res[0].signals)) ? res[0].signals : [];
      if (res[1] && res[1].balance != null) SG.balance = res[1].balance;
      return SG.signals;
    });
  }
  function refresh() { return API("/quantoption/signals").then(function (r) { SG.signals = (r && r.signals) || []; return SG.signals; }).catch(function () { return SG.signals; }); }
  function balNum() { return Number(SG.balance) || 0; }

  /* ── HTML: list ─────────────────────────────────────────────────────────── */
  function dirBadge(direction, c) {
    var up = direction === "long";
    return '<span class="qs-badge" style="background:' + hexA(up ? c.green : c.red, .15) + ';color:' + (up ? c.green : c.red) + '">' +
      ICO(up ? '<path d="M3 17l6-6 4 4 8-8"/><path d="M21 7v6h-6"/>' : '<path d="M3 7l6 6 4-4 8 8"/><path d="M21 17v-6h-6"/>', 13) +
      (up ? "LONG" : "SHORT") + '</span>';
  }
  function listHTML() {
    var c = TH();
    var adminBtn = isAdmin()
      ? '<div class="qs-card" style="display:flex;align-items:center;justify-content:space-between;gap:10px">' +
          '<div><div style="font-size:13px;font-weight:800;color:' + c.t1 + '">God Mode webhook</div>' +
          '<div style="font-size:11px;color:' + c.t3 + ';margin-top:2px">Copy the URL into a TradingView alert</div></div>' +
          '<button id="qs-webhook" class="qs-cta" type="button" style="width:auto;padding:11px 14px;background:' + hexA(c.blue, .16) + ';color:' + c.blue + '">' + ICO('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 16) + 'Copy</button>' +
        '</div>'
      : "";
    var live = SG.signals.filter(function (s) { return s.status === "live" && s.entry != null && s.tp1 != null && s.sl != null; });
    var list = live.length ? live.map(function (s) {
      return '<div class="qs-sigcard" data-ext="' + ESC(s.extId) + '">' +
        '<div class="qs-row">' +
          '<div style="display:flex;align-items:center;gap:9px">' + dirBadge(s.direction, c) +
            '<span style="font-size:14px;font-weight:800;color:' + c.t1 + '">' + ESC(s.symbol) + '</span>' +
            (s.tf ? '<span style="font-size:10.5px;color:' + c.t4 + ';font-weight:700">' + ESC(tfLabel(s.tf)) + '</span>' : '') +
          '</div>' +
          '<span style="font-size:11px;font-weight:800;color:' + c.blue + '">Trade ' + ICO('<path d="M5 12h14M12 5l7 7-7 7"/>', 13) + '</span>' +
        '</div>' +
        '<div class="qs-lv">' +
          '<div class="qs-lvc"><div class="k" style="color:' + c.gold + '">Entry</div><div class="v">' + fmtP(s.entry) + '</div></div>' +
          '<div class="qs-lvc"><div class="k" style="color:' + c.green + '">Target</div><div class="v" style="color:' + c.green + '">' + fmtP(s.tp1) + '</div></div>' +
          '<div class="qs-lvc"><div class="k" style="color:' + c.red + '">Stop</div><div class="v" style="color:' + c.red + '">' + fmtP(s.sl) + '</div></div>' +
        '</div>' +
      '</div>';
    }).join("") : '<div class="qs-empty">No live signals right now.<br>God Mode signals appear here once the webhook is set up.</div>';
    var resume = "";
    if (SG.openPos && SG.openPos.status === "open") {
      var op = SG.openPos; var oup = op.dir === "long";
      resume = '<div class="qs-resume qs-card" style="display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;border-color:' + hexA(c.blue, .5) + ';background:' + hexA(c.blue, .08) + '">' +
        '<div style="display:flex;align-items:center;gap:9px;min-width:0">' +
          '<span style="width:9px;height:9px;border-radius:50%;flex-shrink:0;background:' + (oup ? c.green : c.red) + ';box-shadow:0 0 8px ' + hexA(oup ? c.green : c.red, .7) + ';animation:qsPulse 1.4s infinite"></span>' +
          '<div style="min-width:0"><div style="font-size:13px;font-weight:800;color:' + c.t1 + '">Open trade \u00b7 ' + ESC(op.symbol) + ' ' + (oup ? "Long" : "Short") + '</div>' +
          '<div style="font-size:11px;color:' + c.t3 + '">Staked ' + fmtQ(op.stake) + ' QNTM \u00b7 tap to manage</div></div>' +
        '</div>' +
        '<span style="font-size:11px;font-weight:800;color:' + c.blue + ';flex-shrink:0">Resume ' + ICO('<path d="M5 12h14M12 5l7 7-7 7"/>', 13) + '</span>' +
      '</div>';
    }
    return resume + adminBtn +
      '<div class="qs-lab" style="margin:2px 2px 9px">Live signals</div>' +
      list;
  }

  /* ── HTML: confirm ──────────────────────────────────────────────────────── */
  function confirmHTML() {
    var c = TH(); var s = SG.sel; if (!s) return listHTML();
    var up = s.direction === "long";
    var payout = (Number(SG.stake) || 0) * PAYOUT_MULT;
    var enough = balNum() >= Number(SG.stake) && Number(SG.stake) >= 10;
    return '<button id="qs-back" class="qs-ib" type="button" style="width:auto;padding:0 12px;gap:7px;margin-bottom:12px;font-size:13px;font-weight:700">' + ICO('<path d="M15 18l-6-6 6-6"/>', 16) + 'Signals</button>' +
      '<div class="qs-card">' +
        '<div class="qs-row" style="margin-bottom:4px">' +
          '<div style="display:flex;align-items:center;gap:9px">' + dirBadge(s.direction, c) +
            '<span style="font-size:16px;font-weight:800;color:' + c.t1 + '">' + ESC(s.symbol) + '</span></div>' +
          (s.tf ? '<span style="font-size:11px;color:' + c.t4 + ';font-weight:700">' + ESC(tfLabel(s.tf)) + '</span>' : '') +
        '</div>' +
        '<div class="qs-lv">' +
          '<div class="qs-lvc"><div class="k" style="color:' + c.gold + '">Entry</div><div class="v">' + fmtP(s.entry) + '</div></div>' +
          '<div class="qs-lvc"><div class="k" style="color:' + c.green + '">Target</div><div class="v" style="color:' + c.green + '">' + fmtP(s.tp1) + '</div></div>' +
          '<div class="qs-lvc"><div class="k" style="color:' + c.red + '">Stop</div><div class="v" style="color:' + c.red + '">' + fmtP(s.sl) + '</div></div>' +
        '</div>' +
        '<div style="font-size:11px;color:' + c.t3 + ';margin-top:10px;line-height:1.5">You take the <b style="color:' + (up ? c.green : c.red) + '">' + (up ? "long" : "short") + '</b> side. Win if it reaches the target before the stop — settles on the real trade.</div>' +
      '</div>' +
      '<div class="qs-card">' +
        '<div class="qs-lab">Stake · min 10 · balance ' + fmtQ(SG.balance) + ' QNTM</div>' +
        '<input class="qs-inp" id="qs-stake" type="number" inputmode="numeric" value="' + (Number(SG.stake) || 0) + '" min="10">' +
        '<div class="qs-chips">' + ["10", "50", "100", "500"].map(function (v) { return '<button class="qs-chip" data-v="' + v + '" type="button">' + v + '</button>'; }).join("") +
          '<button class="qs-chip" data-v="max" type="button">MAX</button></div>' +
      '</div>' +
      '<div class="qs-card">' +
        '<div class="qs-row"><div><div style="font-size:13px;font-weight:800;color:' + c.t1 + '">Auto-close time limit</div>' +
          '<div style="font-size:11px;color:' + c.t3 + ';margin-top:2px">Optional — refunds your stake if the trade hasn\'t resolved by then</div></div>' +
          '<button id="qs-tl-toggle" class="qs-toggle" type="button" style="background:' + (SG.tlOn ? c.blue : c.panel3) + '"><span class="dot" style="transform:translateX(' + (SG.tlOn ? "18px" : "0") + ')"></span></button>' +
        '</div>' +
        (SG.tlOn ? '<div class="qs-tl">' + TL_OPTS.map(function (o) { return '<button class="qs-tlb ' + (SG.tlSec === o[1] ? "on" : "") + '" data-sec="' + o[1] + '" type="button">' + o[0] + '</button>'; }).join("") + '</div>' : "") +
      '</div>' +
      '<div class="qs-card" style="display:flex;justify-content:space-between;align-items:center">' +
        '<div><div class="qs-lab" style="margin:0">Potential payout</div><div style="font-size:20px;font-weight:800;color:' + c.green + ';margin-top:3px">' + fmtQ(payout) + ' <span style="font-size:12px;color:' + c.t3 + '">QNTM</span></div></div>' +
        '<div style="text-align:right"><div class="qs-lab" style="margin:0">Profit</div><div style="font-size:16px;font-weight:800;color:' + c.green + ';margin-top:3px">+' + PROFIT_PCT + '%</div></div>' +
      '</div>' +
      '<button class="qs-cta" id="qs-open" type="button" ' + (enough ? "" : "disabled") + ' style="background:linear-gradient(180deg,' + (up ? c.green : c.red) + ',' + (up ? c.greenD : c.redD) + ')">' +
        ICO('<path d="M5 12h14M12 5l7 7-7 7"/>', 18) + (enough ? ("Open " + (up ? "Long" : "Short")) : (Number(SG.stake) < 10 ? "Increase stake" : "Insufficient balance")) +
      '</button>';
  }

  /* ── HTML: position ─────────────────────────────────────────────────────── */
  function positionHTML() {
    var c = TH(); var p = SG.pos; if (!p) return listHTML();
    var up = p.dir === "long";
    var dirCol = up ? c.green : c.red;
    var hasTL = p.timeLimitSec != null && p.expiresAt;
    var cryptoReal = window.dqQORealPrice && window.dqQORealPrice.isReal(p.symbol);
    var chartBlock = cryptoReal
      ? '<div class="qs-chartwrap"><div class="qs-cmodes">' +
          '<button class="qs-cmode' + (SG.chartMode === "candle" ? " on" : "") + '" data-cmode="candle" type="button">Candles</button>' +
          '<button class="qs-cmode' + (SG.chartMode === "line" ? " on" : "") + '" data-cmode="line" type="button">Line</button>' +
        '</div><div class="qs-chart" id="qs-chart"></div></div>'
      : '<div class="qs-card" style="text-align:center"><div style="font-size:11px;color:' + c.t3 + ';line-height:1.5">' + ICO('<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>', 16) + '<br>Live chart is available for crypto symbols.<br>This signal settles on the real God Mode trade.</div></div>';
    return '<div class="qs-row" style="margin-bottom:12px">' +
        '<div style="display:flex;align-items:center;gap:9px">' +
          '<span style="width:9px;height:9px;border-radius:50%;background:' + dirCol + ';box-shadow:0 0 8px ' + hexA(dirCol, .7) + ';animation:qsPulse 1.4s infinite"></span>' +
          '<div><div style="font-size:14px;font-weight:800;color:' + c.t1 + '">' + ESC(p.symbol) + ' · ' + (up ? "Long" : "Short") + '</div>' +
          '<div style="font-size:10.5px;color:' + c.t3 + '">' + (p.status === "open" ? "Live · bound to the real trade" : "Settled") + '</div></div>' +
        '</div>' +
        (hasTL && p.status === "open" ? '<div style="text-align:right"><div style="font-size:9px;letter-spacing:.6px;text-transform:uppercase;font-weight:800;color:' + c.t4 + '">Auto-close</div><div id="qs-count" style="font-size:17px;font-weight:800;color:' + c.t1 + ';font-variant-numeric:tabular-nums">—</div></div>' : '') +
      '</div>' +
      chartBlock +
      '<div class="qs-lv" style="margin-top:0;margin-bottom:11px">' +
        '<div class="qs-lvc"><div class="k" style="color:' + c.gold + '">Entry</div><div class="v">' + fmtP(p.entry) + '</div></div>' +
        '<div class="qs-lvc"><div class="k" style="color:' + c.green + '">Target</div><div class="v" style="color:' + c.green + '">' + fmtP(p.target) + '</div></div>' +
        '<div class="qs-lvc"><div class="k" style="color:' + c.red + '">Stop</div><div class="v" style="color:' + c.red + '">' + fmtP(p.stop) + '</div></div>' +
      '</div>' +
      '<div class="qs-card qs-row">' +
        '<div><div class="qs-lab" style="margin:0">Staked</div><div style="font-size:16px;font-weight:800;color:' + c.t1 + ';margin-top:3px">' + fmtQ(p.stake) + ' QNTM</div></div>' +
        '<div style="text-align:right"><div class="qs-lab" style="margin:0">Win pays</div><div style="font-size:16px;font-weight:800;color:' + c.green + ';margin-top:3px">' + fmtQ(p.potentialWin != null ? p.potentialWin : Number(p.stake) * PAYOUT_MULT) + ' QNTM</div></div>' +
      '</div>' +
      '<button id="qs-back2" class="qs-cta" type="button" style="background:' + c.panel2 + ';color:' + c.t2 + ';border:1px solid ' + c.bd + '">Back to signals</button>';
  }

  /* ── stage render ───────────────────────────────────────────────────────── */
  function stageHTML() {
    if (SG.screen === "confirm") return confirmHTML();
    if (SG.screen === "position") return positionHTML();
    return listHTML();
  }
  function rerender() {
    var st = document.getElementById("qs-stage"); if (!st) return;
    teardownChart();
    st.innerHTML = stageHTML();
    wire();
    if (SG.screen === "position") setupChart();
  }

  function wire() {
    var st = document.getElementById("qs-stage"); if (!st) return;
    var T = function (id) { return st.querySelector(id); };

    if (SG.screen === "list") {
      var wb = T("#qs-webhook"); if (wb) wb.onclick = showWebhook;
      var rb = T(".qs-resume"); if (rb && SG.openPos) rb.onclick = function () { SG.pos = SG.openPos; SG.screen = "position"; rerender(); startPoll(); };
      st.querySelectorAll(".qs-sigcard").forEach(function (card) {
        card.onclick = function () {
          var ext = card.getAttribute("data-ext");
          var sig = SG.signals.filter(function (s) { return String(s.extId) === String(ext); })[0];
          if (sig) { SG.sel = sig; SG.screen = "confirm"; rerender(); }
        };
      });
    } else if (SG.screen === "confirm") {
      var back = T("#qs-back"); if (back) back.onclick = function () { SG.screen = "list"; SG.sel = null; rerender(); };
      var stake = T("#qs-stake");
      if (stake) stake.oninput = function () { SG.stake = Math.max(0, Math.floor(+stake.value || 0)); syncConfirm(); };
      st.querySelectorAll(".qs-chip").forEach(function (b) {
        b.onclick = function () { var v = b.getAttribute("data-v"); SG.stake = v === "max" ? Math.max(10, Math.floor(balNum())) : Math.max(10, +v); if (stake) stake.value = SG.stake; syncConfirm(); };
      });
      var tg = T("#qs-tl-toggle"); if (tg) tg.onclick = function () { SG.tlOn = !SG.tlOn; rerender(); };
      st.querySelectorAll(".qs-tlb").forEach(function (b) {
        b.onclick = function () { SG.tlSec = +b.getAttribute("data-sec"); rerender(); };
      });
      var open = T("#qs-open"); if (open) open.onclick = doOpen;
    } else if (SG.screen === "position") {
      var b2 = T("#qs-back2"); if (b2) b2.onclick = function () { stopPoll(); SG.pos = null; SG.screen = "list"; refresh().then(rerender).catch(rerender); };
      st.querySelectorAll(".qs-cmode").forEach(function (b) {
        b.onclick = function () {
          var m = b.getAttribute("data-cmode"); if (m !== "candle" && m !== "line") return;
          if (m === SG.chartMode) return;
          SG.chartMode = m;
          st.querySelectorAll(".qs-cmode").forEach(function (x) { x.classList.toggle("on", x.getAttribute("data-cmode") === m); });
          if (SG.chart) SG.chart.setMode(m);
        };
      });
    }
  }
  function syncConfirm() {
    var open = document.getElementById("qs-open"); if (!open) return;
    var enough = balNum() >= Number(SG.stake) && Number(SG.stake) >= 10;
    open.disabled = !enough;
  }

  /* ── open a signal position ─────────────────────────────────────────────── */
  function doOpen() {
    if (SG.busy || !SG.sel) return;
    var stake = Math.floor(Number(SG.stake) || 0);
    if (stake < 10) { toast("Minimum stake is 10 QNTM", "error"); return; }
    if (balNum() < stake) { toast("Not enough QNTM in your wallet", "error"); return; }
    SG.busy = true;
    var btn = document.getElementById("qs-open"); if (btn) { btn.disabled = true; btn.style.opacity = ".6"; }
    var body = { extId: SG.sel.extId, stake: stake };
    if (SG.tlOn && SG.tlSec) body.timeLimitSec = SG.tlSec;
    API("/quantoption/open-signal", { method: "POST", body: body })
      .then(function (r) {
        SG.busy = false;
        var p = r && r.position; if (!p) { toast("Could not open position", "error"); return; }
        SG.pos = p; SG.openPos = p; SG.screen = "position";
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }
        if (window.dqQOFx && window.dqQOFx.opened) { try { window.dqQOFx.opened((p && p.symbol) || (SG.sel && SG.sel.symbol), (SG.sel && SG.sel.direction) || (p && (p.direction || p.dir))); } catch (e) {} }
        rerender(); startPoll();
      })
      .catch(function (e) {
        SG.busy = false;
        toast((e && e.error && (e.error.message || e.error)) || (e && e.message) || "Could not open position", "error");
        rerender();
      });
  }

  /* ── poll the position ──────────────────────────────────────────────────── */
  function startPoll() {
    stopPoll();
    if (!SG.pos || SG.pos.status !== "open") return;
    var id = SG.pos.id;
    var tick = function () {
      API("/quantoption/signal-position/" + id).then(function (r) {
        var p = r && r.position; if (!p) return;
        SG.pos = p;
        if (p.status !== "open") { stopPoll(); onResolved(p); return; }
        updateCountdown();
      }).catch(function () {});
    };
    SG.pollTimer = setInterval(tick, POLL_MS);
    updateCountdown();
  }
  function stopPoll() { if (SG.pollTimer) { clearInterval(SG.pollTimer); SG.pollTimer = null; } }
  function updateCountdown() {
    var p = SG.pos; var el = document.getElementById("qs-count");
    if (!el || !p || !p.expiresAt) return;
    var ms = new Date(p.expiresAt).getTime() - Date.now();
    el.textContent = mmss(ms);
  }
  function onResolved(p) {
    SG.openPos = null;
    teardownChart();
    if (navigator.vibrate) { try { navigator.vibrate(p.status === "won" ? [10, 40, 10] : 22); } catch (e) {} }
    showResult(p);
    // refresh balance + list quietly
    API("/quantoption/me").then(function (r) { if (r && r.balance != null) SG.balance = r.balance; }).catch(function () {});
  }

  /* ── real-price chart (crypto) ──────────────────────────────────────────── */
  function setupChart() {
    var p = SG.pos; if (!p) return;
    var el = document.getElementById("qs-chart"); if (!el) return;
    if (!(window.dqQORealPrice && window.dqQORealPrice.isReal(p.symbol))) return;
    if (!window.dqQOChart) return;
    SG.chartTried = true;
    var c = TH();
    var colors = { text: c.t2, grid: "rgba(120,150,200,.07)", border: c.bd, cross: "rgba(140,165,210,.42)", crossBg: c.panel2, up: c.green, down: c.red, entry: c.gold, target: c.green, stop: c.red };
    window.dqQOChart.ensureLib().then(function () {
      if (SG.screen !== "position" || !document.getElementById("qs-chart")) return;
      var ch = window.dqQOChart.create(el, { colors: colors, mode: SG.chartMode || "candle" });
      if (!ch) return;
      SG.chart = ch;
      var nsym = String(p.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      var sig = (SG.sel && String(SG.sel.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "") === nsym) ? SG.sel : null;
      ch.setLevels({ entry: p.entry, target: p.target, stop: p.stop, tp1: (sig ? sig.tp1 : p.target), tp2: (sig ? sig.tp2 : null), tp3: (sig ? sig.tp3 : null), symbol: p.symbol, direction: p.dir });
      window.dqQORealPrice.klines(p.symbol, { interval: "1m", limit: 200 }).then(function (data) {
        if (!SG.chart) return;
        if (data && data.length) {
          ch.setData(data); ch.fit();
          try {
            var up = p.dir === "long";
            var t0 = data[0].time, t1 = data[data.length - 1].time, mk = [];
            if (p.openedAt) {
              var ot = Math.floor(new Date(p.openedAt).getTime() / 60000) * 60;
              if (ot >= t0 && ot <= t1) mk.push({ time: ot, position: up ? "belowBar" : "aboveBar", color: up ? "#22c55e" : "#f43f5e", shape: up ? "arrowUp" : "arrowDown", text: up ? "BUY" : "SELL" });
            }
            if (p.status !== "open" && p.settledAt) {
              var st = Math.floor(new Date(p.settledAt).getTime() / 60000) * 60;
              if (st >= t0 && st <= t1) mk.push({ time: st, position: up ? "aboveBar" : "belowBar", color: (p.outcome === "win") ? "#22c55e" : "#f43f5e", shape: up ? "arrowDown" : "arrowUp", text: "EXIT" });
            }
            if (mk.length && SG.chart) SG.chart.setMarkers(mk);
          } catch (e) {}
        }
        SG.realStop = window.dqQORealPrice.subscribe(p.symbol, "1m", function (candle) {
          if (SG.chart) SG.chart.update(candle);
          if (window.dqQOFx && candle && SG.pos && SG.pos.status === "open") {
            var live = Number(candle.close);
            if (isFinite(live)) {
              var up2 = p.dir === "long";
              var tps = [["TP1", sig ? sig.tp1 : p.target], ["HALF", sig ? (Number(sig.tp1) + Number(sig.tp2)) / 2 : null], ["TP2", sig ? sig.tp2 : null], ["TP3", sig ? sig.tp3 : null]];
              var first = !SG.tpHit[p.id + ":seen"]; SG.tpHit[p.id + ":seen"] = 1;
              for (var k2 = 0; k2 < tps.length; k2++) {
                var nm = tps[k2][0], lv = Number(tps[k2][1]); if (!isFinite(lv)) continue;
                var hit = up2 ? live >= lv : live <= lv, key = p.id + ":" + nm;
                if (hit && !SG.tpHit[key]) { SG.tpHit[key] = 1; if (!first) window.dqQOFx.target(nm); }
              }
            }
          }
        });
      }).catch(function () {});
    }).catch(function () { /* lib blocked → levels panel already shows */ });
  }
  function teardownChart() {
    if (SG.realStop) { try { SG.realStop(); } catch (e) {} SG.realStop = null; }
    if (SG.chart) { try { SG.chart.destroy(); } catch (e) {} SG.chart = null; }
  }

  /* ── admin: copy webhook ────────────────────────────────────────────────── */
  function showWebhook() {
    API("/quantoption/admin/webhook").then(function (r) {
      var c = TH();
      var url = (r && (r.urlWithSecret || r.url)) || "";
      var configured = r && r.configured;
      var ov = document.createElement("div");
      ov.id = "qs-webhook-modal";
      ov.style.cssText = "position:fixed;inset:0;z-index:6400;display:flex;align-items:center;justify-content:center;padding:22px;background:rgba(3,6,14,.76);-webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px)";
      ov.innerHTML =
        '<div style="width:min(420px,94vw);border-radius:20px;background:' + c.panel + ';border:1px solid ' + c.bd + ';box-shadow:0 24px 70px rgba(0,0,0,.6);animation:qsPop .26s cubic-bezier(.2,.8,.3,1);overflow:hidden">' +
          '<div style="padding:18px 18px 14px">' +
            '<div style="font-size:16px;font-weight:800;color:' + c.t1 + '">Quant Option webhook</div>' +
            '<div style="font-size:12px;color:' + c.t3 + ';margin-top:4px;line-height:1.5">Paste this URL into a God Mode TradingView alert. The alert message must contain the <b>[[DRFX]]</b> tag (entry/tp/sl) or send clean JSON.</div>' +
            (configured
              ? '<div style="margin-top:12px;padding:11px;border-radius:11px;background:' + c.panel3 + ';border:1px solid ' + c.bdSoft + ';font-family:ui-monospace,monospace;font-size:10.5px;color:' + c.t2 + ';word-break:break-all;line-height:1.5">' + ESC(url) + '</div>' +
                '<button id="qs-copy" class="qs-cta" type="button" style="margin-top:12px;background:linear-gradient(180deg,' + c.blue + ',#2456d8)">Copy URL</button>'
              : '<div style="margin-top:12px;padding:11px;border-radius:11px;background:' + hexA(c.red, .12) + ';border:1px solid ' + hexA(c.red, .3) + ';font-size:12px;color:' + c.t1 + '">Set <b>QUANTOPTION_WEBHOOK_SECRET</b> in the server .env, then restart, to enable the webhook.</div>') +
            '<button id="qs-wh-close" class="qs-cta" type="button" style="margin-top:9px;background:' + c.panel2 + ';color:' + c.t2 + ';border:1px solid ' + c.bd + '">Close</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);
      function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
      ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
      var cl = ov.querySelector("#qs-wh-close"); if (cl) cl.onclick = close;
      var cp = ov.querySelector("#qs-copy");
      if (cp) cp.onclick = function () {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(function () { toast("Webhook URL copied", "success"); }, function () { fallbackCopy(url); });
          else fallbackCopy(url);
        } catch (e) { fallbackCopy(url); }
      };
    }).catch(function (e) { toast((e && e.message) || "Could not load webhook", "error"); });
  }
  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
      toast("Webhook URL copied", "success");
    } catch (e) { toast("Copy failed — select and copy manually", "error"); }
  }

  /* ── result popup ───────────────────────────────────────────────────────── */
  function showResult(p) {
    var c = TH();
    var win = p.status === "won", draw = p.status === "draw";
    if (win && window.dqQOFx) { try { window.dqQOFx.burst(); } catch (e) {} }
    var col = win ? c.green : draw ? c.gold : c.red;
    var title = win ? "WIN" : draw ? "DRAW" : "LOSS";
    var profit = win ? (Number(p.payout) - Number(p.stake)) : draw ? 0 : -Number(p.stake);
    var icon = win ? '<path d="M20 6L9 17l-5-5"/>' : draw ? '<path d="M5 12h14"/>' : '<path d="M18 6 6 18M6 6l12 12"/>';
    var sub = draw ? "Time limit reached — stake refunded" : win ? "The trade reached its target" : "The trade hit its stop";
    var ov = document.createElement("div");
    ov.id = "qs-result";
    ov.style.cssText = "position:fixed;inset:0;z-index:6400;display:flex;align-items:center;justify-content:center;padding:22px;background:rgba(3,6,14,.76);-webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px)";
    ov.innerHTML =
      '<div style="width:min(360px,92vw);border-radius:22px;background:' + c.panel + ';border:1px solid ' + c.bd + ';box-shadow:0 24px 70px rgba(0,0,0,.6);animation:qsPop .26s cubic-bezier(.2,.8,.3,1);overflow:hidden">' +
        '<div style="padding:26px 22px 18px;text-align:center;background:radial-gradient(120% 100% at 50% 0%,' + hexA(col, .22) + ',transparent)">' +
          '<div style="width:56px;height:56px;border-radius:50%;margin:0 auto;display:flex;align-items:center;justify-content:center;background:' + hexA(col, .16) + '">' +
            '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="' + col + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' + icon + '</svg></div>' +
          '<div style="font-size:28px;font-weight:900;letter-spacing:2px;color:' + col + ';margin-top:10px">' + title + '</div>' +
          '<div style="font-size:23px;font-weight:800;color:' + c.t1 + ';margin-top:4px;font-variant-numeric:tabular-nums">' + fmtSigned(profit) + ' <span style="font-size:13px;color:' + c.t3 + '">QNTM</span></div>' +
          '<div style="font-size:11px;color:' + c.t3 + ';margin-top:5px">' + sub + '</div>' +
        '</div>' +
        '<div style="padding:14px 18px 18px">' +
          '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid ' + c.bdSoft + '"><span style="font-size:12px;color:' + c.t3 + '">' + ESC(p.symbol) + ' · ' + (p.dir === "long" ? "Long" : "Short") + '</span><span style="font-size:12px;font-weight:700;color:' + c.t1 + '">' + fmtQ(p.stake) + ' QNTM</span></div>' +
          '<div style="display:flex;justify-content:space-between;padding:7px 0"><span style="font-size:12px;color:' + c.t3 + '">Payout</span><span style="font-size:12px;font-weight:700;color:' + c.t1 + '">' + fmtQ(p.payout) + ' QNTM</span></div>' +
          '<button type="button" id="qs-result-x" style="width:100%;margin-top:10px;padding:13px 0;border-radius:13px;border:none;cursor:pointer;font-size:14px;font-weight:800;color:#fff;background:linear-gradient(180deg,' + c.blue + ',#2456d8)">Back to signals</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); SG.pos = null; SG.screen = "list"; refresh().then(rerender).catch(rerender); }
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    var b = ov.querySelector("#qs-result-x"); if (b) b.onclick = close;
  }

  /* ── chat button helpers ────────────────────────────────────────────────── */
  // Return a "Trade on Quant Option" button for a chat message IF a live stored
  // signal matches it. Matching is by symbol+direction against the trusted list
  // (refreshed on open); the open always uses the stored extId, never the text.
  function matchForMessage(m) {
    if (!m || !m.content || !window.DQSignal) return null;
    var sig; try { sig = (window.DQSignal.extractOfficial && window.DQSignal.extractOfficial(m.content)) || window.DQSignal.extract(m.content); } catch (e) { return null; }
    if (!sig || !sig.symbol || !sig.direction) return null;
    var sym = String(sig.symbol).toUpperCase().replace(/[^A-Z0-9]/g, "");
    var live = SG.signals.filter(function (s) {
      if (s.status !== "live") return false;
      var ssym = String(s.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      return ssym === sym && s.direction === sig.direction;
    });
    return live.length ? live[0] : null;
  }
  function officialSignalContext(m) {
    if (m && (m.sender_role === "admin" || m.sender_role === "superadmin")) return true;
    if (typeof S !== "undefined" && S && S.chatInfo && S.chatInfo.type === "channel") return true;
    return false;
  }
  function tradeButtonHTML(m) {
    if (!m || !m.content || !window.DQSignal) return "";
    if (!officialSignalContext(m)) return "";
    var sig; try { sig = (window.DQSignal.extractOfficial && window.DQSignal.extractOfficial(m.content)) || window.DQSignal.extract(m.content); } catch (e) { return ""; }
    if (!sig || !sig.symbol || !sig.direction) return "";
    var c = TH();
    return '<button class="qs-trade-btn" data-sym="' + ESC(String(sig.symbol).toUpperCase()) + '" data-dir="' + ESC(sig.direction) + '" type="button" style="margin-top:5px;width:100%;padding:9px;border:none;border-radius:10px;cursor:pointer;font-family:inherit;font-size:12px;font-weight:800;color:#fff;display:flex;align-items:center;justify-content:center;gap:7px;background:linear-gradient(180deg,' + c.blue + ',#2456d8)">' +
      ICO('<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>', 14) + 'Trade on Quant Option</button>';
  }
  // Open the confirm sheet by matching a chat signal to a live STORED signal
  // (symbol+direction), always re-fetched — so the position opens from the
  // trusted store, never the message text.
  function openForSignalByMatch(sym, dir) {
    var nsym = String(sym || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    var go = function () {
      var live = SG.signals.filter(function (s) {
        if (s.status !== "live") return false;
        var ssym = String(s.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        return ssym === nsym && s.direction === dir;
      });
      if (!live.length) {
        toast("No live Quant Option signal for this yet", "error");
        if (document.getElementById(OV_ID)) { SG.screen = "list"; rerender(); }
        return;
      }
      SG.sel = live[0]; SG.screen = "confirm"; rerender();
    };
    if (document.getElementById(OV_ID)) { refresh().then(go).catch(go); return; }
    SG.screen = "list"; SG.sel = null; SG.pos = null;
    buildOverlay();
    loadList().then(go).catch(go);
  }
  // Delegated click for chat trade buttons (rendered under signal messages).
  if (typeof document !== "undefined" && !window.__qsTradeBtnBound) {
    window.__qsTradeBtnBound = true;
    document.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest(".qs-trade-btn") : null;
      if (!btn) return;
      e.preventDefault(); e.stopPropagation();
      openForSignalByMatch(btn.getAttribute("data-sym"), btn.getAttribute("data-dir"));
    });
  }

  /* ── open / close overlay ───────────────────────────────────────────────── */
  function onKey(e) {
    if (e.key !== "Escape") return;
    var r = document.getElementById("qs-result") || document.getElementById("qs-webhook-modal");
    if (r) { if (r.parentNode) r.parentNode.removeChild(r); return; }
    closeOverlay();
  }
  function closeOverlay() {
    stopPoll(); teardownChart();
    var o = document.getElementById(OV_ID); if (o && o.parentNode) o.parentNode.removeChild(o);
    SG.overlayOpen = false;
    document.removeEventListener("keydown", onKey);
  }
  function buildOverlay() {
    injectCSS();
    var ov = document.createElement("div");
    ov.id = OV_ID;
    var c = TH();
    var bar = (window.dqAppNav ? window.dqAppNav.html("quant") : "");
    ov.innerHTML =
      '<div class="qs-hd">' +
        '<button class="qs-ib" id="qs-x" type="button" aria-label="Back">' + ICO('<path d="M15 18l-6-6 6-6"/>', 19) + '</button>' +
        '<div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:800;color:' + c.t1 + ';line-height:1.1">Signal Trading</div>' +
        '<div style="font-size:10.5px;color:' + c.t3 + '">Real God Mode trades · Quant Option</div></div>' +
        '<button class="qs-ib" id="qs-refresh" type="button" aria-label="Refresh">' + ICO('<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>', 18) + '</button>' +
      '</div>' +
      '<div class="qs-stage" id="qs-stage"><div class="qs-empty">Loading…</div></div>' + bar;
    document.body.appendChild(ov);
    SG.overlayOpen = true;
    var x = ov.querySelector("#qs-x"); if (x) x.onclick = closeOverlay;
    var rf = ov.querySelector("#qs-refresh"); if (rf) rf.onclick = function () { loadList().then(function () { if (SG.screen === "list") rerender(); }); };
    if (window.dqAppNav) window.dqAppNav.wire(ov, "quant", closeOverlay);
    document.addEventListener("keydown", onKey);
  }

  function open() {
    if (document.getElementById(OV_ID)) { return; }
    SG.screen = "list"; SG.sel = null; SG.pos = null;
    buildOverlay();
    loadList().then(function () {
      // Resume an in-progress trade if one exists (like Easy Trade), so an open
      // position can be viewed/managed again after leaving and reopening.
      return API("/quantoption/signal-open").then(function (r) {
        var p = r && r.position;
        SG.openPos = (p && p.status === "open") ? p : null;
        if (SG.openPos && SG.screen === "list" && !SG.sel) {
          SG.pos = SG.openPos; SG.screen = "position"; rerender(); startPoll();
        } else { rerender(); }
      }).catch(function () { rerender(); });
    }).catch(function () {
      var st = document.getElementById("qs-stage"); if (st) st.innerHTML = '<div class="qs-empty">Could not load signals.</div>';
    });
  }
  // Open straight into the confirm sheet for a specific stored signal (chat button).
  function openForSignal(extId) {
    var go = function () {
      var sig = SG.signals.filter(function (s) { return String(s.extId) === String(extId); })[0];
      if (!sig) { toast("This signal is no longer live", "error"); SG.screen = "list"; rerender(); return; }
      SG.sel = sig; SG.screen = "confirm"; rerender();
    };
    if (document.getElementById(OV_ID)) { refresh().then(go).catch(go); return; }
    SG.screen = "list"; SG.sel = null; SG.pos = null;
    buildOverlay();
    loadList().then(go).catch(go);
  }

  window.dqQOSignals = {
    open: open,
    openForSignal: openForSignal,
    tradeButtonHTML: tradeButtonHTML,
    matchForMessage: matchForMessage,
    refresh: function () { return loadList(); },
  };
})();
