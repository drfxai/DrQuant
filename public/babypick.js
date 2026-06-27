/* ============================================================================
   DrFX Quant — Baby Pick (the games half of Easy Trade)  →  window.dqBabyPick
   ----------------------------------------------------------------------------
   A provably-fair games hub that sits beside Baby Trader inside the Easy Trade
   section. Ships the first live game — QUICK SIGNAL: predict UP or DOWN on a
   market, settled in 60 seconds, pays 2× on a correct call. The other games
   (Wheel of Fortune, Dice, Crash, Sports, Slots) are previewed as "coming soon".

   WALLET: every figure comes from the authoritative qntm-ledger via
   /api/babypick/* — the balance shown IS the user's main wallet. Stakes and
   payouts are real double-entry transactions; outcomes are provably fair
   (commit→reveal), verifiable from the result screen.

   Backend:  routes/babypick.js + services/babypick.js
   Exposes:  window.dqBabyPick = { open }      open(gameId?) deep-links a game
   Page globals reused (with fallbacks): t, esc, ic, api, S, showToast.
   ========================================================================== */
(function () {
  "use strict";
  if (window.dqBabyPick) return;

  var BP = {
    min: 10, max: 1000000, payoutMult: 2, roundSeconds: 60,
    balance: "0", pool: "0", symbols: [],
    openRoundId: null, round: null, poll: null, tick: null, view: "hub", sym: null
  };

  // ── safe globals ────────────────────────────────────────────────────────────
  var FT = {
    bg: "#070b14", ch: "rgba(12,18,32,.72)", cd: "rgba(16,24,40,.66)", bd: "rgba(90,120,170,.16)",
    btn: "rgba(28,40,66,.6)", inp: "rgba(10,16,28,.7)",
    t1: "#eaf1ff", t2: "#aebcd6", t3: "#7e8db0", t4: "#5a6a8c",
    pr: "#1c84ff", ac: "#1c84ff", act: "rgba(28,132,255,.14)", ba: "rgba(28,132,255,.4)"
  };
  function TT() { return (typeof t !== "undefined" && t) ? t : FT; }
  function ICO(p, s) { return (typeof ic === "function") ? ic(p, s) : '<svg width="' + (s || 18) + '" height="' + (s || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'; }
  function ESC(x) { return (typeof esc === "function") ? esc(x) : String(x == null ? "" : x).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function toast(a, b) { if (typeof showToast === "function") showToast(a, b); }
  function API(p, o) { if (typeof api !== "function") return Promise.reject(new Error("offline")); return api(p, o); }
  function hx(hex, a) { hex = String(hex || "#000").replace("#", ""); if (hex.length === 3) hex = hex.split("").map(function (c) { return c + c; }).join(""); var n = parseInt(hex, 16) || 0; return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + (a == null ? 1 : a) + ")"; }

  var GREEN = "#34d27a", GREENG = "rgba(52,210,122,.5)", RED = "#ef4444", REDG = "rgba(239,68,68,.5)", GOLD = "#f5b54a";

  // ── self-managed BACK handling (independent of backnav.js) ─────────────────
  // Push one sentinel history entry while Baby Pick is open and intercept the
  // Android/edge back gesture (popstate) to peel a layer at a time (fairness
  // sheet → game → hub → close) instead of letting the browser exit the app.
  var BK = { armed: false, selfPop: false, bound: false, lastBtn: 0 };
  function bkArm() { try { if (!BK.armed) { history.pushState({ bpBack: 1 }, ""); BK.armed = true; } } catch (e) {} }
  function bkDisarm() { try { if (BK.armed) { BK.armed = false; BK.selfPop = true; history.back(); } } catch (e) { BK.selfPop = false; } }
  function bkHandler() {
    if (BK.selfPop) { BK.selfPop = false; return; }            // our own rewind
    if (!document.getElementById("bp-ov")) { BK.armed = false; return; }
    if (Date.now() - BK.lastBtn < 60) { if (document.getElementById("bp-ov")) bkArm(); else BK.armed = false; return; } // backnav already handled
    BK.armed = false;
    var handled = false;
    try {
      var sheet = document.getElementById("bp-scrim");
      if (sheet) { sheet.remove(); handled = true; }            // 1) fairness sheet
      else if (BP.view !== "hub") { stopGameTimers(); renderHub(); handled = true; } // 2) game → hub
    } catch (e) { handled = false; }
    if (handled) { bkArm(); return; }
    try { close(); } catch (e) {}                               // 3) hub → close overlay
  }
  function bkBind() { if (BK.bound) return; try { window.addEventListener("popstate", bkHandler); BK.bound = true; } catch (e) {} }

  var GAMES = [
    { id: "quick", name: "Quick Signal", sub: "Predict UP / DOWN · 60s", accent: "#1c84ff", live: true,
      icon: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>' },
    { id: "wheel", name: "Wheel of Fortune", sub: "Spin to multiply", accent: "#f5b54a", live: false,
      icon: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/><line x1="18.4" y1="5.6" x2="5.6" y2="18.4"/><circle cx="12" cy="12" r="2" fill="currentColor"/>' },
    { id: "dice", name: "Dice", sub: "Roll to win", accent: "#a78bfa", live: false,
      icon: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.3" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.3" fill="currentColor"/>' },
    { id: "crash", name: "Crash", sub: "Cash out before the blast", accent: "#ef4444", live: false,
      icon: '<path d="M4.5 16.5c6-1 9-5 11-13 2 8 .5 12-6 13"/><path d="M5 19l3.5-3"/><circle cx="14" cy="9" r="1.4" fill="currentColor"/>' },
    { id: "sports", name: "Sports", sub: "Match predictions", accent: "#34d27a", live: false,
      icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7l3 2-1 4h-4l-1-4z"/><path d="M12 3v4M5 9l3.5 1M19 9l-3.5 1M7 19l2-3M17 19l-2-3"/>' },
    { id: "slots", name: "Slots", sub: "Spin three to win", accent: "#ec4899", live: false,
      icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><line x1="9" y1="5" x2="9" y2="19"/><line x1="15" y1="5" x2="15" y2="19"/><circle cx="6" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18" cy="12" r="1.3" fill="currentColor"/>' }
  ];

  // ── numbers / stake helpers (log slider, matches Baby Trader feel) ──────────
  function fmtQ(n) { n = Number(n); if (!isFinite(n)) n = 0; return n.toLocaleString("en-US", { maximumFractionDigits: n < 1000 ? 2 : 0 }); }
  function fmtP(n) { n = Number(n); if (!isFinite(n)) return "—"; return n.toLocaleString("en-US", { minimumFractionDigits: n < 10 ? 4 : 2, maximumFractionDigits: n < 10 ? 4 : 2 }); }
  function balNum() { return Number(BP.balance) || 0; }
  function clampStake(v) { v = Math.floor(Number(v) || 0); return Math.max(0, Math.min(BP.max, v)); }
  function posToVal(pos) { var lo = Math.log10(BP.min), hi = Math.log10(BP.max); var v = Math.pow(10, lo + (hi - lo) * (pos / 1000)); var step = v < 100 ? 1 : v < 1000 ? 10 : v < 10000 ? 50 : v < 100000 ? 500 : 5000; return clampStake(Math.round(v / step) * step); }
  function valToPos(v) { var lo = Math.log10(BP.min), hi = Math.log10(BP.max); v = Math.max(BP.min, Math.min(BP.max, Number(v) || BP.min)); return Math.round(1000 * (Math.log10(v) - lo) / (hi - lo)); }

  // ── CSS (scoped) ────────────────────────────────────────────────────────────
  function injectCSS() {
    if (document.getElementById("bp-css")) return;
    var t = TT();
    var css =
      '#bp-ov{position:fixed;inset:0;z-index:5400;background-color:#070d20;background-image:radial-gradient(120% 80% at 50% -10%,#0c1838 0%,rgba(7,13,32,0) 60%);display:flex;flex-direction:column;animation:bpFade .22s ease;padding:var(--sat) var(--sar) var(--sab) var(--sal);font-family:Outfit,sans-serif}' +
      '#bp-ov *{box-sizing:border-box}' +
      '.bp-hd{display:flex;align-items:center;gap:11px;padding:11px 14px;background:' + t.ch + ';-webkit-backdrop-filter:blur(22px) saturate(160%);backdrop-filter:blur(22px) saturate(160%);border-bottom:1px solid ' + t.bd + ';flex-shrink:0;width:100%;max-width:620px;margin:0 auto}' +
      '.bp-ib{width:36px;height:36px;border-radius:10px;border:1px solid ' + t.bd + ';background:' + t.btn + ';color:' + t.t1 + ';cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:transform .12s}' +
      '.bp-ib:active{transform:scale(.92)}' +
      '.bp-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px 14px 30px;width:100%;max-width:620px;margin:0 auto}' +
      '.bp-stats{display:flex;gap:11px;margin-bottom:16px}' +
      '.bp-stat{flex:1;border-radius:16px;padding:13px 14px;background:' + t.cd + ';border:1px solid ' + t.bd + ';position:relative;overflow:hidden}' +
      '.bp-stat .lab{font-size:9.5px;letter-spacing:1.2px;text-transform:uppercase;font-weight:800;margin-bottom:5px}' +
      '.bp-stat .val{font-size:23px;font-weight:800;letter-spacing:-.5px;line-height:1;color:' + t.t1 + '}' +
      '.bp-stat .q{font-size:12px;font-weight:700;margin-left:5px}' +
      '.bp-h{font-size:13px;font-weight:800;color:' + t.t1 + ';margin:6px 2px 12px;display:flex;align-items:center;gap:8px}' +
      '.bp-hero{position:relative;overflow:hidden;border-radius:20px;padding:18px;cursor:pointer;border:1px solid ' + hx("#1c84ff", .4) + ';background:linear-gradient(135deg,' + hx("#1c84ff", .16) + ',' + hx("#7c5cff", .08) + ');transition:transform .14s}' +
      '.bp-hero:active{transform:scale(.985)}' +
      '.bp-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px}' +
      '.bp-game{position:relative;overflow:hidden;border-radius:17px;padding:14px;background:' + t.cd + ';border:1px solid ' + t.bd + ';cursor:pointer;transition:transform .14s,border-color .2s}' +
      '.bp-game:active{transform:scale(.97)}' +
      '.bp-gi{width:46px;height:46px;border-radius:13px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;box-shadow:0 6px 18px rgba(0,0,0,.35)}' +
      '.bp-soon{position:absolute;top:10px;right:10px;font-size:8.5px;font-weight:800;letter-spacing:.8px;color:' + t.t3 + ';background:' + t.inp + ';border:1px solid ' + t.bd + ';border-radius:6px;padding:3px 7px}' +
      '.bp-chip{display:inline-flex;align-items:center;gap:6px;padding:9px 13px;border-radius:12px;border:1px solid ' + t.bd + ';background:' + t.cd + ';color:' + t.t2 + ';font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;transition:transform .1s,border-color .15s}' +
      '.bp-chip:active{transform:scale(.95)}' +
      '.bp-slider{-webkit-appearance:none;appearance:none;width:100%;height:6px;border-radius:5px;outline:none;margin:16px 0 6px;background:' + t.inp + '}' +
      '.bp-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:24px;height:24px;border-radius:50%;background:' + t.pr + ';border:3px solid #fff2;cursor:pointer;box-shadow:0 0 0 4px ' + t.act + ',0 4px 12px rgba(0,0,0,.4)}' +
      '.bp-slider::-moz-range-thumb{width:22px;height:22px;border-radius:50%;background:' + t.pr + ';border:3px solid #fff2;cursor:pointer}' +
      '.bp-qp{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0 4px}' +
      '.bp-qpb{flex:1;min-width:54px;padding:9px 0;border-radius:10px;border:1px solid ' + t.bd + ';background:' + t.btn + ';color:' + t.t2 + ';font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;transition:transform .1s}' +
      '.bp-qpb:active{transform:scale(.95)}' +
      '.bp-inp{width:100%;padding:13px 15px;border-radius:12px;background:' + t.inp + ';border:1px solid ' + t.bd + ';color:' + t.t1 + ';font-size:16px;font-weight:700;text-align:center;font-family:inherit;outline:none;margin-top:8px}' +
      '.bp-pick{display:flex;gap:11px;margin:14px 0 6px}' +
      '.bp-pk{flex:1;border-radius:16px;padding:17px 10px;border:1.5px solid ' + t.bd + ';background:' + t.cd + ';cursor:pointer;text-align:center;transition:all .16s;font-family:inherit;position:relative;overflow:hidden}' +
      '.bp-pk:active{transform:scale(.97)}' +
      '.bp-pk .pkt{font-size:19px;font-weight:900;letter-spacing:.5px;display:flex;align-items:center;justify-content:center;gap:7px}' +
      '.bp-pk .pks{font-size:11px;font-weight:600;color:' + t.t3 + ';margin-top:3px}' +
      '.bp-cta{width:100%;padding:16px;border:none;border-radius:14px;font-weight:800;font-size:15.5px;cursor:pointer;font-family:inherit;color:#fff;margin-top:14px;transition:transform .14s,opacity .2s;display:flex;align-items:center;justify-content:center;gap:9px}' +
      '.bp-cta:active{transform:scale(.985)}' +
      '.bp-cta:disabled{opacity:.45;cursor:not-allowed;filter:grayscale(.4)}' +
      '.bp-ring{transform:rotate(-90deg)}' +
      '.bp-ring circle{transition:stroke-dashoffset 1s linear}' +
      '.bp-stamp{font-size:50px;font-weight:900;letter-spacing:2px;text-align:center;line-height:1;margin:8px 0;animation:bpStamp .5s cubic-bezier(.2,1.2,.3,1)}' +
      '.bp-cf{position:fixed;top:-12px;width:9px;height:14px;border-radius:2px;z-index:5600;pointer-events:none;animation:bpConf 2.6s linear forwards}' +
      '.bp-scrim{position:fixed;inset:0;z-index:5500;background:rgba(3,6,14,.66);-webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px);display:flex;align-items:flex-end;justify-content:center;animation:bpFade .18s ease}' +
      '.bp-sheet{width:100%;max-width:520px;max-height:88vh;overflow-y:auto;background:' + t.bg + ';border:1px solid ' + t.bd + ';border-bottom:none;border-radius:22px 22px 0 0;padding:8px 16px calc(20px + var(--sab));animation:bpUp .26s cubic-bezier(.2,.8,.2,1)}' +
      '.bp-grab{width:38px;height:4px;border-radius:3px;background:' + t.bd + ';margin:6px auto 12px}' +
      '@keyframes bpFade{from{opacity:0}to{opacity:1}}' +
      '@keyframes bpUp{from{transform:translateY(40px);opacity:.4}to{transform:translateY(0);opacity:1}}' +
      '@keyframes bpStamp{0%{transform:scale(.3) rotate(-12deg);opacity:0}60%{transform:scale(1.12) rotate(3deg)}100%{transform:scale(1) rotate(0);opacity:1}}' +
      '@keyframes bpConf{0%{transform:translateY(0) rotate(0);opacity:1}100%{transform:translateY(108vh) rotate(680deg);opacity:.12}}' +
      '@keyframes bpPulse{0%,100%{opacity:1}50%{opacity:.4}}' +
      '@keyframes bpSpin{to{transform:rotate(360deg)}}';
    var el = document.createElement("style"); el.id = "bp-css"; el.textContent = css; document.head.appendChild(el);
  }

  // ── data ────────────────────────────────────────────────────────────────────
  function loadMe() {
    return API("/babypick/me").then(function (r) {
      if (!r) return;
      BP.balance = r.balance != null ? r.balance : BP.balance;
      BP.pool = r.pool != null ? r.pool : BP.pool;
      if (r.min != null) BP.min = Number(r.min);
      if (r.max != null) BP.max = Number(r.max);
      if (r.payoutMult != null) BP.payoutMult = Number(r.payoutMult);
      if (r.roundSeconds != null) BP.roundSeconds = Number(r.roundSeconds);
      if (r.symbols && r.symbols.length) BP.symbols = r.symbols;
      BP.openRoundId = r.openRoundId || null;
      return r;
    });
  }

  // ── overlay shell ────────────────────────────────────────────────────────────
  function shell() {
    injectCSS();
    var t = TT();
    var ex = document.getElementById("bp-ov"); if (ex) ex.remove();
    var ov = document.createElement("div"); ov.id = "bp-ov";
    ov.style.zIndex = "5400"; // inline so backnav.js recognizes this as a closeable layer (hardware/edge back)
    ov.innerHTML =
      '<div class="bp-hd">' +
        '<button class="bp-ib" id="bp-back" type="button">' + ICO('<polyline points="15 18 9 12 15 6"/>', 20) + '</button>' +
        '<div style="display:flex;align-items:center;gap:9px;flex:1;min-width:0">' +
          '<span style="width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#7c5cff,#1c84ff);color:#fff;flex-shrink:0">' + ICO('<rect x="2" y="6" width="20" height="12" rx="3"/><circle cx="8" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="1.6" fill="currentColor" stroke="none"/>', 17) + '</span>' +
          '<div style="line-height:1.05;min-width:0"><div id="bp-title" style="font-size:15px;font-weight:800;color:' + t.t1 + '">Baby Pick</div><div id="bp-sub" style="font-size:10.5px;color:' + t.t3 + '">Play · Predict · Win big</div></div>' +
        '</div>' +
        '<button class="bp-ib" id="bp-close" type="button">' + ICO('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 18) + '</button>' +
      '</div>' +
      '<div class="bp-body" id="bp-body"></div>';
    document.body.appendChild(ov);
    bkBind(); bkArm();   // intercept the Android/edge back gesture while open
    ov.querySelector("#bp-close").onclick = function () { BK.lastBtn = Date.now(); bkDisarm(); close(); };
    ov.querySelector("#bp-back").onclick = function () {
      BK.lastBtn = Date.now();
      if (document.getElementById("bp-scrim")) { document.getElementById("bp-scrim").remove(); return; }
      if (BP.view === "hub") { bkDisarm(); close(); } else { stopGameTimers(); renderHub(); }
    };
    return ov;
  }
  function setHead(title, sub) { var a = document.getElementById("bp-title"), b = document.getElementById("bp-sub"); if (a) a.textContent = title; if (b) b.textContent = sub; }
  function stopGameTimers() { if (BP.poll) { clearInterval(BP.poll); BP.poll = null; } if (BP.tick) { clearInterval(BP.tick); BP.tick = null; } }
  function close() { stopGameTimers(); var ov = document.getElementById("bp-ov"); if (ov) ov.remove(); }

  // ── HUB (games grid) ─────────────────────────────────────────────────────────
  function renderHub() {
    BP.view = "hub"; setHead("Baby Pick", "Play · Predict · Win big");
    var t = TT(); var body = document.getElementById("bp-body"); if (!body) return;
    var stats =
      '<div class="bp-stats">' +
        '<div class="bp-stat"><div style="position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,' + t.pr + ',transparent)"></div><div class="lab" style="color:' + t.pr + '">Your Wallet</div><div class="val">' + fmtQ(BP.balance) + '<span class="q" style="color:' + t.pr + '">QNTM</span></div></div>' +
        '<div class="bp-stat"><div style="position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,' + GOLD + ',transparent)"></div><div class="lab" style="color:' + GOLD + '">Prize Pool</div><div class="val">' + fmtQ(BP.pool) + '<span class="q" style="color:' + GOLD + '">QNTM</span></div></div>' +
      '</div>';

    var hero =
      '<div class="bp-hero" id="bp-hero">' +
        '<div style="position:absolute;top:-40px;right:-30px;width:150px;height:150px;border-radius:50%;background:radial-gradient(circle,' + hx("#1c84ff", .3) + ',transparent 70%)"></div>' +
        '<div style="display:flex;align-items:center;gap:13px;position:relative">' +
          '<div style="width:54px;height:54px;border-radius:15px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1c84ff,#7c5cff);color:#fff;flex-shrink:0;box-shadow:0 8px 22px ' + hx("#1c84ff", .5) + '">' + ICO('<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>', 26) + '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:18px;font-weight:800;color:' + t.t1 + '">Quick Signal</span><span style="font-size:9px;font-weight:800;letter-spacing:.6px;color:' + GREEN + ';background:' + hx(GREEN, .14) + ';border:1px solid ' + hx(GREEN, .4) + ';border-radius:6px;padding:2px 7px;display:inline-flex;align-items:center;gap:4px"><span style="width:5px;height:5px;border-radius:50%;background:' + GREEN + ';animation:bpPulse 1.4s infinite"></span>LIVE</span></div>' +
            '<div style="font-size:12px;color:' + t.t2 + ';margin-top:3px">Predict <b style="color:' + GREEN + '">UP</b> or <b style="color:' + RED + '">DOWN</b> — result in 60 seconds. Win <b style="color:' + t.t1 + '">2×</b>.</div>' +
          '</div>' +
          '<span style="color:' + t.pr + ';flex-shrink:0">' + ICO('<polyline points="9 18 15 12 9 6"/>', 22) + '</span>' +
        '</div>' +
      '</div>';

    var grid = GAMES.filter(function (g) { return g.id !== "quick"; }).map(function (g) {
      var soon = g.live ? "" : '<span class="bp-soon">SOON</span>';
      return '<div class="bp-game" data-game="' + g.id + '"' + (g.live ? "" : ' style="opacity:.72"') + '>' + soon +
        '<div style="position:absolute;top:-26px;right:-26px;width:80px;height:80px;border-radius:50%;background:radial-gradient(circle,' + hx(g.accent, .2) + ',transparent 70%)"></div>' +
        '<div class="bp-gi" style="background:linear-gradient(135deg,' + g.accent + ',' + hx(g.accent, .5) + ');color:#fff">' + ICO(g.icon, 24) + '</div>' +
        '<div style="font-size:14.5px;font-weight:800;color:' + t.t1 + '">' + g.name + '</div>' +
        '<div style="font-size:11px;color:' + t.t3 + ';margin-top:2px">' + g.sub + '</div>' +
      '</div>';
    }).join("");

    body.innerHTML = stats +
      '<div class="bp-h">' + ICO('<polygon points="13 2 4 14 10 14 9 22 20 10 13 10 13 2"/>', 16) + 'Featured game</div>' +
      hero +
      '<div class="bp-h" style="margin-top:20px">' + ICO('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>', 16) + 'More games</div>' +
      '<div class="bp-grid">' + grid + '</div>' +
      '<div style="text-align:center;margin-top:22px;font-size:10.5px;color:' + t.t4 + ';line-height:1.6">Baby Pick games are <b style="color:' + t.t3 + '">provably fair</b> — every result is verifiable.<br>Play responsibly — you can lose your entire stake.</div>';

    body.querySelector("#bp-hero").onclick = function () { renderQuickSetup(); };
    body.querySelectorAll(".bp-game").forEach(function (c) {
      c.onclick = function () {
        var g = c.dataset.game;
        if (g === "quick") return renderQuickSetup();
        toast("Coming soon", (GAMES.filter(function (x) { return x.id === g; })[0] || {}).name + " is on the way.");
      };
    });
  }

  // ── QUICK SIGNAL — setup ─────────────────────────────────────────────────────
  function renderQuickSetup() {
    BP.view = "quick"; setHead("Quick Signal", "Predict the next 60 seconds");
    var t = TT(); var body = document.getElementById("bp-body"); if (!body) return;
    if (!BP.symbols.length) BP.symbols = [{ sym: "BTCUSDT", name: "Bitcoin", base: 68000, accent: "#f7931a" }];
    if (!BP.sym) BP.sym = BP.symbols[0].sym;
    var stake = Math.max(BP.min, Math.min(100, balNum() || BP.min));
    var pick = null, busy = false;

    var chips = BP.symbols.map(function (s) {
      return '<button class="bp-chip" data-sym="' + ESC(s.sym) + '" style="flex-shrink:0">' +
        '<span style="width:9px;height:9px;border-radius:3px;background:' + (s.accent || t.pr) + '"></span>' + ESC(s.name || s.sym) +
      '</button>';
    }).join("");

    body.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:' + t.t3 + ';margin:2px 2px 10px"><span>Balance</span><span style="color:' + t.t1 + ';font-weight:700">' + fmtQ(BP.balance) + ' QNTM</span></div>' +
      '<div class="bp-h">' + ICO('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 16) + 'Choose a market</div>' +
      '<div id="bp-syms" style="display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px">' + chips + '</div>' +
      '<div id="bp-price" style="margin:14px 0 2px;border:1px solid ' + t.bd + ';border-radius:14px;background:' + t.cd + ';padding:14px;text-align:center">' +
        '<div style="font-size:10px;letter-spacing:1px;color:' + t.t4 + ';text-transform:uppercase;font-weight:800">Live reference price</div>' +
        '<div id="bp-px" style="font-size:30px;font-weight:800;color:' + t.t1 + ';font-family:ui-monospace,monospace;margin-top:4px;letter-spacing:-.5px">—</div>' +
      '</div>' +
      '<div class="bp-h" style="margin-top:16px">' + ICO('<path d="M12 5v14M5 12h14"/>', 16) + 'Your prediction</div>' +
      '<div class="bp-pick" id="bp-pick">' +
        '<button class="bp-pk" data-pick="UP" type="button"><div class="pkt" style="color:' + GREEN + '">' + ICO('<polyline points="4 17 10 11 14 15 20 7"/><polyline points="15 7 20 7 20 12"/>', 20) + 'UP</div><div class="pks">Price rises</div></button>' +
        '<button class="bp-pk" data-pick="DOWN" type="button"><div class="pkt" style="color:' + RED + '">' + ICO('<polyline points="4 7 10 13 14 9 20 17"/><polyline points="15 17 20 17 20 12"/>', 20) + 'DOWN</div><div class="pks">Price falls</div></button>' +
      '</div>' +
      '<div class="bp-h" style="margin-top:16px">' + ICO('<rect x="2" y="6" width="20" height="12" rx="3"/><circle cx="12" cy="12" r="2.4"/>', 16) + 'Stake</div>' +
      '<div style="text-align:center"><span id="bp-sv" style="font-size:40px;font-weight:800;color:' + t.t1 + ';letter-spacing:-1px">' + fmtQ(stake) + '</span><span style="font-size:15px;font-weight:700;color:' + t.pr + ';margin-left:6px">QNTM</span></div>' +
      '<input class="bp-slider" id="bp-sl" type="range" min="0" max="1000" value="' + valToPos(stake) + '"/>' +
      '<div style="display:flex;justify-content:space-between;font-size:10px;color:' + t.t4 + '"><span>' + fmtQ(BP.min) + '</span><span>' + fmtQ(BP.max) + '</span></div>' +
      '<div class="bp-qp" id="bp-qp">' + ['10', '100', '1K', '10K', 'MAX'].map(function (l) { return '<button class="bp-qpb" data-qp="' + l + '" type="button">' + l + '</button>'; }).join("") + '</div>' +
      '<input class="bp-inp" id="bp-num" inputmode="numeric" value="' + stake + '"/>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin:16px 2px 0;font-size:12px"><span style="color:' + t.t3 + '">Potential payout</span><span id="bp-payout" style="color:' + GREEN + ';font-weight:800;font-size:16px;text-shadow:0 0 12px ' + GREENG + '">' + fmtQ(stake * BP.payoutMult) + ' QNTM</span></div>' +
      '<div id="bp-warn" style="font-size:11px;color:' + GOLD + ';margin:8px 2px 0;line-height:1.5;display:none"></div>' +
      '<button class="bp-cta" id="bp-place" type="button" disabled style="background:linear-gradient(135deg,' + t.pr + ',' + hx(t.pr, .7) + ')">Choose UP or DOWN</button>' +
      '<div style="text-align:center;margin-top:12px;font-size:10px;color:' + t.t4 + ';line-height:1.5">Provably fair · result locked the moment you play · revealed in 60s</div>';

    function curMeta() { for (var i = 0; i < BP.symbols.length; i++) if (BP.symbols[i].sym === BP.sym) return BP.symbols[i]; return BP.symbols[0]; }
    var pxEl = body.querySelector("#bp-px"), priceCard = body.querySelector("#bp-price");
    var basePx = Number(curMeta().base) || 100, shownPx = basePx;
    function paintPx() { pxEl.textContent = fmtP(shownPx); }
    paintPx();
    // gentle illustrative ticker so the market feels alive while choosing
    var pxTimer = setInterval(function () {
      if (!document.getElementById("bp-px")) { clearInterval(pxTimer); return; }
      shownPx = basePx * (1 + (Math.random() - 0.5) * 0.0016);
      paintPx();
    }, 900);

    function setSymUI() {
      body.querySelectorAll("#bp-syms .bp-chip").forEach(function (b) {
        var on = b.dataset.sym === BP.sym, m = curMeta();
        b.style.borderColor = on ? (m.accent || t.pr) : t.bd;
        b.style.background = on ? hx(m.accent || t.pr, .14) : t.cd;
        b.style.color = on ? t.t1 : t.t2;
      });
      var m = curMeta(); basePx = Number(m.base) || basePx; shownPx = basePx; paintPx();
      priceCard.style.borderColor = hx(m.accent || t.pr, .35);
    }

    var sv = body.querySelector("#bp-sv"), sl = body.querySelector("#bp-sl"), num = body.querySelector("#bp-num"), payout = body.querySelector("#bp-payout"), place = body.querySelector("#bp-place"), warn = body.querySelector("#bp-warn");
    function refresh() {
      stake = clampStake(stake);
      sv.textContent = fmtQ(stake);
      if (document.activeElement !== num) num.value = stake;
      sl.value = valToPos(stake);
      payout.textContent = fmtQ(stake * BP.payoutMult) + " QNTM";
      var problem = "";
      if (stake < BP.min) problem = "Minimum stake is " + fmtQ(BP.min) + " QNTM.";
      else if (stake > balNum()) problem = "That\u2019s more than your balance.";
      else if (stake > BP.max) problem = "Maximum stake is " + fmtQ(BP.max) + " QNTM.";
      warn.style.display = problem ? "block" : "none"; if (problem) warn.textContent = problem;
      place.disabled = busy || !!problem || !pick;
      place.textContent = busy ? "Placing\u2026" : (!pick ? "Choose UP or DOWN" : (problem ? "Adjust your stake" : ("Play " + pick + " \u00b7 " + fmtQ(stake) + " QNTM")));
    }

    body.querySelectorAll("#bp-syms .bp-chip").forEach(function (b) { b.onclick = function () { BP.sym = b.dataset.sym; setSymUI(); }; });
    sl.oninput = function () { stake = posToVal(Number(sl.value)); refresh(); };
    num.oninput = function () { stake = clampStake(num.value.replace(/[^\d]/g, "")); refresh(); };
    num.onblur = function () { refresh(); };
    body.querySelectorAll("#bp-qp .bp-qpb").forEach(function (b) {
      b.onclick = function () { var m = { "10": 10, "100": 100, "1K": 1000, "10K": 10000, "MAX": Math.min(BP.max, balNum()) }; stake = clampStake(m[b.dataset.qp]); refresh(); };
    });
    body.querySelectorAll("#bp-pick .bp-pk").forEach(function (b) {
      b.onclick = function () {
        pick = b.dataset.pick;
        body.querySelectorAll("#bp-pick .bp-pk").forEach(function (x) {
          var on = x.dataset.pick === pick, col = pick === "UP" ? GREEN : RED, glow = pick === "UP" ? GREENG : REDG;
          x.style.borderColor = on ? col : t.bd; x.style.background = on ? hx(col, .12) : t.cd;
          x.style.boxShadow = on ? ("0 0 0 3px " + hx(col, .15) + ",0 0 18px " + glow) : "none";
        });
        place.style.background = "linear-gradient(135deg," + (pick === "UP" ? GREEN : RED) + "," + hx(pick === "UP" ? GREEN : RED, .7) + ")";
        refresh();
      };
    });
    place.onclick = function () {
      if (busy || !pick) return;
      busy = true; refresh();
      API("/babypick/quick/bet", { method: "POST", body: JSON.stringify({ symbol: BP.sym, pick: pick, stake: stake }) })
        .then(function (r) {
          clearInterval(pxTimer);
          BP.round = r && r.round; BP.openRoundId = BP.round ? BP.round.id : null;
          loadMe().catch(function () {});
          renderQuickLive();
        })
        .catch(function (e) {
          busy = false; refresh();
          warn.style.display = "block"; warn.textContent = (e && (e.error || e.message)) || "Could not place your prediction.";
        });
    };
    setSymUI(); refresh();
  }

  // ── QUICK SIGNAL — live 60s ──────────────────────────────────────────────────
  function renderQuickLive() {
    BP.view = "quick"; setHead("Quick Signal", "Result incoming…");
    stopGameTimers();
    var t = TT(); var body = document.getElementById("bp-body"); var r = BP.round; if (!body || !r) { renderHub(); return; }
    var meta = null; for (var i = 0; i < BP.symbols.length; i++) if (BP.symbols[i].sym === r.symbol) meta = BP.symbols[i];
    var accent = (meta && meta.accent) || t.pr;
    var pickCol = r.pick === "UP" ? GREEN : RED, pickGlow = r.pick === "UP" ? GREENG : REDG;
    var total = BP.roundSeconds || 60;
    var left = r.secondsRemaining != null ? r.secondsRemaining : total;
    var entry = Number(r.entryPrice) || (meta ? meta.base : 100);
    var C = 2 * Math.PI * 54;

    body.innerHTML =
      '<div style="text-align:center;padding:6px 0 0">' +
        '<div style="font-size:12.5px;color:' + t.t3 + '">' + (meta ? ESC(meta.name) : ESC(r.symbol)) + ' · entry <b style="color:' + t.t1 + '">' + fmtP(entry) + '</b></div>' +
      '</div>' +
      '<div style="position:relative;width:200px;height:200px;margin:14px auto 6px">' +
        '<svg width="200" height="200" class="bp-ring"><circle cx="100" cy="100" r="54" fill="none" stroke="' + t.inp + '" stroke-width="10"/>' +
          '<circle id="bp-arc" cx="100" cy="100" r="54" fill="none" stroke="' + accent + '" stroke-width="10" stroke-linecap="round" stroke-dasharray="' + C + '" stroke-dashoffset="' + (C * (1 - left / total)) + '" style="filter:drop-shadow(0 0 8px ' + hx(accent, .7) + ')"/></svg>' +
        '<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">' +
          '<div id="bp-count" style="font-size:48px;font-weight:800;color:' + t.t1 + ';line-height:1">' + left + '</div>' +
          '<div style="font-size:11px;letter-spacing:1px;color:' + t.t4 + ';text-transform:uppercase;font-weight:800">seconds</div>' +
        '</div>' +
      '</div>' +
      '<div style="border:1px solid ' + t.bd + ';border-radius:14px;background:' + t.cd + ';padding:12px 14px;margin-top:6px">' +
        '<svg id="bp-spark" width="100%" height="62" viewBox="0 0 300 62" preserveAspectRatio="none" style="display:block"><polyline id="bp-sparkline" fill="none" stroke="' + accent + '" stroke-width="2" points=""/></svg>' +
      '</div>' +
      '<div style="display:flex;gap:11px;margin-top:14px">' +
        '<div style="flex:1;border:1px solid ' + t.bd + ';border-radius:13px;background:' + t.cd + ';padding:12px;text-align:center"><div style="font-size:10px;letter-spacing:.6px;color:' + t.t4 + ';text-transform:uppercase;font-weight:800">Your call</div><div style="font-size:22px;font-weight:900;color:' + pickCol + ';text-shadow:0 0 14px ' + pickGlow + ';margin-top:3px;display:flex;align-items:center;justify-content:center;gap:6px">' + (r.pick === "UP" ? ICO('<polyline points="4 17 10 11 14 15 20 7"/><polyline points="15 7 20 7 20 12"/>', 18) : ICO('<polyline points="4 7 10 13 14 9 20 17"/><polyline points="15 17 20 17 20 12"/>', 18)) + r.pick + '</div></div>' +
        '<div style="flex:1;border:1px solid ' + t.bd + ';border-radius:13px;background:' + t.cd + ';padding:12px;text-align:center"><div style="font-size:10px;letter-spacing:.6px;color:' + t.t4 + ';text-transform:uppercase;font-weight:800">Staked</div><div style="font-size:22px;font-weight:900;color:' + t.t1 + ';margin-top:3px">' + fmtQ(r.stake) + '</div></div>' +
        '<div style="flex:1;border:1px solid ' + t.bd + ';border-radius:13px;background:' + t.cd + ';padding:12px;text-align:center"><div style="font-size:10px;letter-spacing:.6px;color:' + t.t4 + ';text-transform:uppercase;font-weight:800">To win</div><div style="font-size:22px;font-weight:900;color:' + GREEN + ';margin-top:3px">' + fmtQ(Number(r.stake) * BP.payoutMult) + '</div></div>' +
      '</div>' +
      '<div style="text-align:center;font-size:11px;color:' + t.t4 + ';margin-top:16px;line-height:1.6">Outcome was sealed when you played (provably fair).<br>You\u2019ll be paid automatically the instant it settles.</div>';

    // local countdown + cosmetic sparkline
    var arc = body.querySelector("#bp-arc"), countEl = body.querySelector("#bp-count"), spark = body.querySelector("#bp-sparkline");
    var pts = [], px = entry, started = Date.now();
    function pushPt() {
      px = px * (1 + (Math.random() - 0.5) * 0.0022);
      pts.push(px); if (pts.length > 60) pts.shift();
      var lo = Math.min.apply(null, pts), hi = Math.max.apply(null, pts), rng = (hi - lo) || 1;
      var n = pts.length, str = pts.map(function (v, idx) { var x = (idx / Math.max(1, n - 1)) * 300; var y = 58 - ((v - lo) / rng) * 54; return x.toFixed(1) + "," + y.toFixed(1); }).join(" ");
      spark.setAttribute("points", str);
    }
    for (var k = 0; k < 8; k++) pushPt();
    BP.tick = setInterval(function () {
      if (!document.getElementById("bp-count")) { stopGameTimers(); return; }
      pushPt();
      var elapsed = (Date.now() - started) / 1000;
      var rem = Math.max(0, Math.ceil(total - elapsed));
      countEl.textContent = rem;
      if (arc) arc.setAttribute("stroke-dashoffset", (C * Math.min(1, elapsed / total)).toFixed(1));
    }, 1000);

    var settledSeen = false;
    BP.poll = setInterval(function () {
      if (!document.getElementById("bp-ov")) { stopGameTimers(); return; }
      API("/babypick/quick/" + encodeURIComponent(r.id)).then(function (res) {
        var rd = res && res.round; if (!rd) return;
        BP.round = rd;
        if (rd.status === "pending") return;
        if (!settledSeen) { settledSeen = true; stopGameTimers(); BP.openRoundId = null; loadMe().then(function () { renderQuickResult(rd); }).catch(function () { renderQuickResult(rd); }); }
      }).catch(function () {});
    }, 1500);
  }

  // ── QUICK SIGNAL — result ────────────────────────────────────────────────────
  function renderQuickResult(r) {
    BP.view = "quick"; var won = r.status === "won";
    setHead("Quick Signal", won ? "You won!" : "Result");
    var t = TT(); var body = document.getElementById("bp-body"); if (!body) return;
    var meta = null; for (var i = 0; i < BP.symbols.length; i++) if (BP.symbols[i].sym === r.symbol) meta = BP.symbols[i];
    var col = won ? GREEN : RED, glow = won ? GREENG : REDG;
    var net = won ? (Number(r.payout) - Number(r.stake)) : -Number(r.stake);
    var outUp = r.outcome === "UP";

    body.innerHTML =
      '<div style="text-align:center;padding:14px 0 4px">' +
        '<div style="width:84px;height:84px;border-radius:50%;margin:0 auto 6px;display:flex;align-items:center;justify-content:center;background:' + hx(col, .14) + ';border:1.5px solid ' + hx(col, .5) + ';color:' + col + ';box-shadow:0 0 32px ' + glow + '">' +
          (won ? ICO('<polyline points="20 6 9 17 4 12"/>', 40) : ICO('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 38)) +
        '</div>' +
        '<div class="bp-stamp" style="color:' + col + ';text-shadow:0 0 22px ' + glow + '">' + (won ? "WON" : "LOST") + '</div>' +
        '<div style="font-size:13px;color:' + t.t2 + '">' + (won ? "Your " : "The market went ") + (won ? ('<b style="color:' + col + '">' + r.pick + '</b> call was correct') : ('<b style="color:' + col + '">' + r.outcome + '</b> — your ' + r.pick + ' missed')) + '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;justify-content:center;gap:10px;margin:14px 0;border:1px solid ' + t.bd + ';border-radius:14px;background:' + t.cd + ';padding:14px">' +
        '<div style="text-align:center"><div style="font-size:10px;color:' + t.t4 + ';text-transform:uppercase;letter-spacing:.6px;font-weight:800">Entry</div><div style="font-size:17px;font-weight:800;color:' + t.t1 + ';font-family:ui-monospace,monospace">' + fmtP(r.entryPrice) + '</div></div>' +
        '<span style="color:' + (outUp ? GREEN : RED) + '">' + (outUp ? ICO('<polyline points="4 17 10 11 14 15 20 7"/><polyline points="15 7 20 7 20 12"/>', 22) : ICO('<polyline points="4 7 10 13 14 9 20 17"/><polyline points="15 17 20 17 20 12"/>', 22)) + '</span>' +
        '<div style="text-align:center"><div style="font-size:10px;color:' + t.t4 + ';text-transform:uppercase;letter-spacing:.6px;font-weight:800">Result</div><div style="font-size:17px;font-weight:800;color:' + (outUp ? GREEN : RED) + ';font-family:ui-monospace,monospace">' + fmtP(r.resultPrice) + '</div></div>' +
      '</div>' +
      '<div style="display:flex;gap:11px">' +
        '<div style="flex:1;border:1px solid ' + t.bd + ';border-radius:13px;background:' + t.cd + ';padding:13px;text-align:center"><div style="font-size:10px;color:' + t.t4 + ';text-transform:uppercase;letter-spacing:.6px;font-weight:800">Stake</div><div style="font-size:20px;font-weight:900;color:' + t.t1 + ';margin-top:2px">' + fmtQ(r.stake) + '</div></div>' +
        '<div style="flex:1;border:1px solid ' + t.bd + ';border-radius:13px;background:' + t.cd + ';padding:13px;text-align:center"><div style="font-size:10px;color:' + t.t4 + ';text-transform:uppercase;letter-spacing:.6px;font-weight:800">Payout</div><div style="font-size:20px;font-weight:900;color:' + (won ? GREEN : t.t3) + ';margin-top:2px">' + fmtQ(won ? r.payout : 0) + '</div></div>' +
        '<div style="flex:1;border:1px solid ' + t.bd + ';border-radius:13px;background:' + t.cd + ';padding:13px;text-align:center"><div style="font-size:10px;color:' + t.t4 + ';text-transform:uppercase;letter-spacing:.6px;font-weight:800">Net</div><div style="font-size:20px;font-weight:900;color:' + (net >= 0 ? GREEN : RED) + ';margin-top:2px">' + (net >= 0 ? "+" : "") + fmtQ(net) + '</div></div>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:' + t.t3 + ';margin:16px 2px 0"><span>New balance</span><span style="color:' + t.t1 + ';font-weight:700">' + fmtQ(BP.balance) + ' QNTM</span></div>' +
      '<button class="bp-cta" id="bp-again" type="button" style="background:linear-gradient(135deg,' + t.pr + ',' + hx(t.pr, .7) + ')">Play again</button>' +
      '<div style="display:flex;gap:10px;margin-top:10px">' +
        '<button id="bp-verify" type="button" style="flex:1;padding:12px;border-radius:12px;border:1px solid ' + t.bd + ';background:' + t.btn + ';color:' + t.t2 + ';font-weight:700;font-size:13px;cursor:pointer;font-family:inherit">Verify fairness</button>' +
        '<button id="bp-hub" type="button" style="flex:1;padding:12px;border-radius:12px;border:1px solid ' + t.bd + ';background:' + t.btn + ';color:' + t.t2 + ';font-weight:700;font-size:13px;cursor:pointer;font-family:inherit">All games</button>' +
      '</div>';

    if (won) burstConfetti();
    body.querySelector("#bp-again").onclick = function () { BP.round = null; renderQuickSetup(); };
    body.querySelector("#bp-hub").onclick = function () { BP.round = null; renderHub(); };
    body.querySelector("#bp-verify").onclick = function () { openFairness(r.id); };
  }

  // ── provably-fair verify sheet ───────────────────────────────────────────────
  function openFairness(id) {
    var t = TT();
    var scrim = document.createElement("div"); scrim.className = "bp-scrim"; scrim.id = "bp-scrim";
    scrim.style.zIndex = "5500"; // inline so backnav.js sees the sheet as the top layer and closes it first
    scrim.innerHTML = '<div class="bp-sheet"><div class="bp-grab"></div>' +
      '<div style="font-size:16px;font-weight:800;color:' + t.t1 + ';margin-bottom:4px">Provably fair</div>' +
      '<div style="font-size:12px;color:' + t.t3 + ';line-height:1.5;margin-bottom:12px">The result was committed before you played. Recompute the roll from the seeds below to confirm it was never altered.</div>' +
      '<div id="bp-fair-body" style="font-size:12px;color:' + t.t2 + '">Loading…</div>' +
      '<button id="bp-fair-x" type="button" class="bp-cta" style="background:' + t.btn + ';color:' + t.t1 + ';margin-top:16px">Close</button></div>';
    document.body.appendChild(scrim);
    scrim.onclick = function (e) { if (e.target === scrim) scrim.remove(); };
    scrim.querySelector("#bp-fair-x").onclick = function () { scrim.remove(); };
    function row(k, v) { return '<div style="display:flex;flex-direction:column;gap:2px;padding:9px 0;border-top:1px solid ' + t.bd + '"><span style="font-size:10px;letter-spacing:.6px;text-transform:uppercase;color:' + t.t4 + ';font-weight:800">' + k + '</span><span style="font-family:ui-monospace,monospace;font-size:11.5px;color:' + t.t1 + ';word-break:break-all">' + ESC(v) + '</span></div>'; }
    API("/babypick/quick/" + encodeURIComponent(id) + "/fairness").then(function (f) {
      var el = scrim.querySelector("#bp-fair-body"); if (!el) return;
      var rollTxt = (f.roll != null ? (Math.round(f.roll * 1e6) / 1e6) + " < " + f.winChance + " → " + (f.won ? "WIN" : "LOSS") : "settles after the round");
      el.innerHTML =
        row("Server seed (revealed)", f.serverSeed || "— revealed after settlement —") +
        row("Server seed hash (committed)", f.serverSeedHash) +
        row("Client seed", f.clientSeed) +
        row("Nonce", f.nonce) +
        row("Roll", rollTxt) +
        '<div style="font-size:10.5px;color:' + t.t4 + ';margin-top:10px;line-height:1.5">' + ESC(f.formula || "") + '</div>';
    }).catch(function () { var el = scrim.querySelector("#bp-fair-body"); if (el) el.textContent = "Could not load fairness data."; });
  }

  function burstConfetti() {
    var cols = ["#34d27a", "#1c84ff", "#f5b54a", "#a78bfa", "#ec4899", "#22d3ee"];
    for (var i = 0; i < 46; i++) {
      var c = document.createElement("div"); c.className = "bp-cf";
      c.style.left = Math.random() * 100 + "vw";
      c.style.background = cols[i % cols.length];
      c.style.animationDelay = (Math.random() * 0.5) + "s";
      c.style.transform = "rotate(" + (Math.random() * 360) + "deg)";
      document.body.appendChild(c);
      (function (el) { setTimeout(function () { if (el && el.parentNode) el.parentNode.removeChild(el); }, 3000); })(c);
    }
  }

  // ── open ─────────────────────────────────────────────────────────────────────
  function open(gameId) {
    shell();
    var body = document.getElementById("bp-body");
    body.innerHTML = '<div style="text-align:center;color:' + TT().t3 + ';padding:60px 0">Loading Baby Pick…</div>';
    loadMe().then(function () {
      if (BP.openRoundId && (!gameId || gameId === "quick")) {
        // resume a live round if one exists
        return API("/babypick/quick/" + encodeURIComponent(BP.openRoundId)).then(function (res) {
          var rd = res && res.round;
          if (rd && rd.status === "pending") { BP.round = rd; renderQuickLive(); }
          else if (rd) { BP.round = rd; renderQuickResult(rd); }
          else if (gameId === "quick") renderQuickSetup();
          else renderHub();
        }).catch(function () { gameId === "quick" ? renderQuickSetup() : renderHub(); });
      }
      if (gameId === "quick") renderQuickSetup(); else renderHub();
    }).catch(function () {
      var b = document.getElementById("bp-body");
      if (b) b.innerHTML = '<div style="text-align:center;color:#ff6b6b;padding:50px 16px">Could not load Baby Pick. Please try again.</div>';
    });
  }

  window.dqBabyPick = { open: open };
})();
