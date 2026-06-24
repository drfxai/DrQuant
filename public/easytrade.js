/* ============================================================================
   DrFX Quant — Easy Trade (Baby Trader)   →  window.openEasyTrade
   ----------------------------------------------------------------------------
   A signal-PREDICTION game that lives on the bottom-nav slot previously used by
   the "VPN" tab. The trader:
     1. picks a signal house (company); signals come only from that house,
     2. stakes QNTM (min 10, max 1,000,000) from their wallet,
     3. predicts the outcome of the next signal: TP (hits target) or SL (hits stop),
     4. when that house's indicator fires entry → target/stop (via the TradingView
        webhook we already consume), the round settles:
            prediction == outcome  → pays 2× the stake
            prediction != outcome  → stake goes to the Reward Pool

   ── STATUS: PREVIEW / PRACTICE MODE ────────────────────────────────────────
   EASY_TRADE.live === false  →  nothing touches the real ledger. The wallet
   number is seeded from the authoritative balance for realism, but staking,
   the reward pool and signal resolution are SIMULATED locally so the whole
   flow is clickable before the backend + compliance sign-off exist. Every place
   the real server plugs in is marked  // LIVE-HOOK.

   When the backend is ready, set EASY_TRADE.live = true and implement:
     GET  /api/easytrade/houses                  -> { houses:[...] , pool }
     GET  /api/easytrade/me                       -> { wallet, pool, openTicket }
     POST /api/easytrade/bet  {houseId,stake,pick}-> { ticket }      (escrows stake)
     GET  /api/easytrade/ticket/:id               -> { ticket }      (poll until settled)
   Settlement is driven by the signal's terminal webhook event (the same one the
   scoreboard consumes): a "win" verdict resolves TP, a "loss" verdict resolves SL.

   Page globals reused (with fallbacks): t, esc, ic, api, S, showToast.
   ========================================================================== */
(function () {
  "use strict";

  var EASY_TRADE = {
    live: false,                 // ← flip to true once the backend exists (see header)
    MIN: 10,
    MAX: 1000000,
    payoutMult: 2,               // fixed-2× "house mode"; parimutuel handled server-side
    // practice-only local state
    demoPool: 48250,
    demoBal: null,               // seeded from real wallet on first open
    ticket: null                 // the single open round, if any
  };

  // ── safe accessors so the module never throws if a global is missing ──────
  var FALLBACK_T = {
    bg: "#070b14", ch: "rgba(12,18,32,.72)", cd: "rgba(16,24,40,.66)", bd: "rgba(90,120,170,.16)",
    btn: "rgba(28,40,66,.6)", inp: "rgba(10,16,28,.7)",
    t1: "#eaf1ff", t2: "#aebcd6", t3: "#7e8db0", t4: "#5a6a8c",
    pr: "#1c84ff", ac: "#1c84ff", act: "rgba(28,132,255,.14)", ba: "rgba(28,132,255,.4)",
    pg: "#34d27a", pgw: "rgba(52,210,122,.45)", bl: "rgba(90,120,170,.16)"
  };
  function TT() { return (typeof t !== "undefined" && t) ? t : FALLBACK_T; }
  function ICO(p, s) { return (typeof ic === "function") ? ic(p, s) : '<svg width="' + (s || 18) + '" height="' + (s || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>'; }
  function ESC(x) { return (typeof esc === "function") ? esc(x) : String(x == null ? "" : x).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function toast(a, b) { if (typeof showToast === "function") showToast(a, b); }

  var GREEN = "#34d27a", GREEN_G = "rgba(52,210,122,.5)";
  var RED = "#ef4444", RED_G = "rgba(239,68,68,.5)";
  var GOLD = "#f5b54a", GOLD_G = "rgba(245,181,74,.45)";

  // ── demo signal houses (LIVE-HOOK: replace with GET /api/easytrade/houses) ─
  var HOUSES = [
    { id: "godmode", name: "DrFX GOD MODE", tag: "Quad-consensus", accent: "#1c84ff", products: ["XAUUSD", "BTCUSDT", "EURUSD"], win: 63, live: 4 },
    { id: "aurora",  name: "Aurora Capital", tag: "Index momentum", accent: "#8b5cf6", products: ["NAS100", "US30", "SPX500"], win: 58, live: 3 },
    { id: "apex",    name: "Apex Signals",   tag: "Crypto breakout", accent: "#16e29a", products: ["ETHUSDT", "SOLUSDT", "BNBUSDT"], win: 61, live: 5 },
    { id: "titan",   name: "Titan FX",       tag: "Major pairs",    accent: "#f5b54a", products: ["GBPUSD", "USDJPY", "AUDUSD"], win: 54, live: 2 },
    { id: "quantum", name: "Quantum Edge",   tag: "Mean reversion", accent: "#22d3ee", products: ["BTCUSDT", "XAUUSD"], win: 66, live: 3 },
    { id: "nova",    name: "Nova Markets",   tag: "Commodities",    accent: "#ec4899", products: ["WTIUSD", "NAS100"], win: 56, live: 2 }
  ];
  function houseById(id) { for (var i = 0; i < HOUSES.length; i++) if (HOUSES[i].id === id) return HOUSES[i]; return HOUSES[0]; }

  // ── number helpers ────────────────────────────────────────────────────────
  function fmtQ(n) { n = Number(n); if (!isFinite(n)) n = 0; return n.toLocaleString("en-US", { maximumFractionDigits: n < 1000 ? 2 : 0 }); }
  function clampStake(v) { v = Math.floor(Number(v) || 0); return Math.max(0, Math.min(EASY_TRADE.MAX, v)); }
  // log slider: pos 0..1000  ↔  value 10..1,000,000
  function posToVal(pos) { var v = Math.pow(10, 1 + 5 * (pos / 1000)); var step = v < 100 ? 1 : v < 1000 ? 10 : v < 10000 ? 50 : v < 100000 ? 500 : 5000; return clampStake(Math.round(v / step) * step); }
  function valToPos(v) { v = Math.max(EASY_TRADE.MIN, Math.min(EASY_TRADE.MAX, Number(v) || EASY_TRADE.MIN)); return Math.round(1000 * (Math.log10(v) - 1) / 5); }

  // ── scoped stylesheet (injected once) ─────────────────────────────────────
  function injectCSS() {
    if (document.getElementById("et-css")) return;
    var t = TT();
    var css =
      '#et-ov{position:fixed;inset:0;z-index:5200;background:' + t.bg + ';display:flex;flex-direction:column;animation:etFade .22s ease;padding-top:var(--sat);padding-bottom:var(--sab);padding-left:var(--sal);padding-right:var(--sar);font-family:Outfit,sans-serif}' +
      '#et-ov *{box-sizing:border-box}' +
      '.et-hd{display:flex;align-items:center;gap:11px;padding:11px 14px;background:' + t.ch + ';-webkit-backdrop-filter:blur(22px) saturate(160%);backdrop-filter:blur(22px) saturate(160%);border-bottom:1px solid ' + t.bd + ';flex-shrink:0}' +
      '.et-ibtn{width:36px;height:36px;border-radius:10px;border:1px solid ' + t.bd + ';background:' + t.btn + ';color:' + t.t1 + ';cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:transform .12s}' +
      '.et-ibtn:active{transform:scale(.92)}' +
      '.et-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px 14px 26px}' +
      // ambient glow
      '.et-amb{position:fixed;border-radius:50%;filter:blur(58px);pointer-events:none;opacity:.42;z-index:0}' +
      // stat cards
      '.et-stats{display:flex;gap:11px;margin-bottom:16px;position:relative;z-index:1}' +
      '.et-stat{flex:1;border-radius:16px;padding:13px 14px;background:' + t.cd + ';border:1px solid ' + t.bd + ';position:relative;overflow:hidden;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}' +
      '.et-stat .lab{font-size:9.5px;letter-spacing:1.2px;text-transform:uppercase;font-weight:800;margin-bottom:5px}' +
      '.et-stat .val{font-size:23px;font-weight:800;letter-spacing:-.5px;line-height:1;color:' + t.t1 + '}' +
      '.et-stat .q{font-size:12px;font-weight:700;margin-left:5px}' +
      // section title
      '.et-h{font-size:13px;font-weight:800;color:' + t.t1 + ';letter-spacing:.2px;margin:4px 2px 12px;display:flex;align-items:center;gap:8px}' +
      // house grid
      '.et-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px;position:relative;z-index:1}' +
      '.et-house{border-radius:17px;padding:14px;background:' + t.cd + ';border:1px solid ' + t.bd + ';cursor:pointer;position:relative;overflow:hidden;transition:transform .14s,border-color .2s,box-shadow .2s}' +
      '.et-house:active{transform:scale(.975)}' +
      '.et-mono{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff;margin-bottom:10px;box-shadow:0 6px 18px rgba(0,0,0,.35)}' +
      '.et-chip{display:inline-block;font-size:9.5px;font-weight:700;color:' + t.t3 + ';background:' + t.inp + ';border:1px solid ' + t.bd + ';border-radius:7px;padding:2px 6px;margin:3px 4px 0 0}' +
      '.et-dot{width:6px;height:6px;border-radius:50%;background:' + GREEN + ';box-shadow:0 0 7px ' + GREEN_G + ';display:inline-block;animation:etPulse 1.6s infinite}' +
      // sheet
      '.et-scrim{position:fixed;inset:0;z-index:5300;background:rgba(3,6,14,.62);-webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px);display:flex;align-items:flex-end;justify-content:center;animation:etFade .18s ease}' +
      '.et-sheet{width:100%;max-width:520px;max-height:92vh;overflow-y:auto;-webkit-overflow-scrolling:touch;background:' + t.bg + ';border:1px solid ' + t.bd + ';border-bottom:none;border-radius:22px 22px 0 0;padding:8px 16px calc(20px + var(--sab));animation:etUp .26s cubic-bezier(.2,.8,.2,1);box-shadow:0 -20px 60px rgba(0,0,0,.6)}' +
      '.et-grab{width:38px;height:4px;border-radius:3px;background:' + t.bd + ';margin:6px auto 12px}' +
      // stake display + slider
      '.et-stakebox{text-align:center;padding:14px 0 6px}' +
      '.et-stakeval{font-size:42px;font-weight:800;letter-spacing:-1px;color:' + t.t1 + ';line-height:1}' +
      '.et-stakeq{font-size:15px;font-weight:700;color:' + t.pr + ';margin-left:6px}' +
      '.et-slider{-webkit-appearance:none;appearance:none;width:100%;height:6px;border-radius:5px;outline:none;margin:16px 0 6px;background:' + t.inp + '}' +
      '.et-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:24px;height:24px;border-radius:50%;background:' + t.pr + ';border:3px solid #fff2;cursor:pointer;box-shadow:0 0 0 4px ' + t.act + ',0 4px 12px rgba(0,0,0,.4)}' +
      '.et-slider::-moz-range-thumb{width:22px;height:22px;border-radius:50%;background:' + t.pr + ';border:3px solid #fff2;cursor:pointer}' +
      '.et-qp{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0 4px}' +
      '.et-qpb{flex:1;min-width:54px;padding:9px 0;border-radius:10px;border:1px solid ' + t.bd + ';background:' + t.btn + ';color:' + t.t2 + ';font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;transition:transform .1s,border-color .15s}' +
      '.et-qpb:active{transform:scale(.95)}' +
      '.et-inp{width:100%;padding:13px 15px;border-radius:12px;background:' + t.inp + ';border:1px solid ' + t.bd + ';color:' + t.t1 + ';font-size:16px;font-weight:700;text-align:center;font-family:inherit;outline:none;transition:border-color .2s,box-shadow .2s}' +
      '.et-inp:focus{border-color:' + t.pr + ';box-shadow:0 0 0 3px ' + t.act + '}' +
      // TP / SL toggle
      '.et-pick{display:flex;gap:11px;margin:14px 0 6px}' +
      '.et-pk{flex:1;border-radius:15px;padding:15px 10px;border:1.5px solid ' + t.bd + ';background:' + t.cd + ';cursor:pointer;text-align:center;transition:all .16s;font-family:inherit;position:relative;overflow:hidden}' +
      '.et-pk:active{transform:scale(.97)}' +
      '.et-pk .pkt{font-size:18px;font-weight:800;letter-spacing:.5px}' +
      '.et-pk .pks{font-size:11px;font-weight:600;color:' + t.t3 + ';margin-top:2px}' +
      // primary CTA
      '.et-cta{width:100%;padding:16px;border:none;border-radius:14px;font-weight:800;font-size:15.5px;cursor:pointer;font-family:inherit;color:#fff;margin-top:14px;transition:transform .14s,box-shadow .2s,opacity .2s;display:flex;align-items:center;justify-content:center;gap:9px}' +
      '.et-cta:active{transform:scale(.985)}' +
      '.et-cta:disabled{opacity:.45;cursor:not-allowed;filter:grayscale(.4)}' +
      // waiting / radar
      '.et-radar{width:128px;height:128px;margin:8px auto 18px;border-radius:50%;position:relative;display:flex;align-items:center;justify-content:center}' +
      '.et-radar .ring{position:absolute;inset:0;border-radius:50%;border:2px solid ' + t.ba + ';animation:etRing 2s ease-out infinite}' +
      '.et-radar .ring2{animation-delay:1s}' +
      '.et-badge{display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:999px;font-size:12px;font-weight:800;letter-spacing:.3px}' +
      // result stamp
      '.et-stamp{font-size:54px;font-weight:900;letter-spacing:2px;text-align:center;line-height:1;margin:6px 0;animation:etStamp .5s cubic-bezier(.2,1.2,.3,1)}' +
      '.et-mini{display:inline-flex;align-items:center;gap:5px;font-size:9px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;padding:3px 8px;border-radius:999px;border:1px solid ' + GOLD_G + ';color:' + GOLD + ';background:rgba(245,181,74,.1)}' +
      // keyframes
      '@keyframes etFade{from{opacity:0}to{opacity:1}}' +
      '@keyframes etUp{from{transform:translateY(40px);opacity:.4}to{transform:translateY(0);opacity:1}}' +
      '@keyframes etPulse{0%,100%{opacity:1}50%{opacity:.35}}' +
      '@keyframes etRing{0%{transform:scale(.55);opacity:.9}100%{transform:scale(1);opacity:0}}' +
      '@keyframes etStamp{0%{transform:scale(.3) rotate(-12deg);opacity:0}60%{transform:scale(1.12) rotate(3deg)}100%{transform:scale(1) rotate(0);opacity:1}}' +
      '@keyframes etSpin{to{transform:rotate(360deg)}}';
    var el = document.createElement("style"); el.id = "et-css"; el.textContent = css; document.head.appendChild(el);
  }

  // ── wallet balance (LIVE-HOOK: read-only, authoritative) ──────────────────
  function fetchBalance() {
    if (typeof api !== "function") return Promise.resolve(null);
    return api("/qntm/wallets/me").then(function (r) {
      return r && r.wallet ? Number(r.wallet.available_balance) : null;
    }).catch(function () { return null; });
  }
  function bal() { return EASY_TRADE.demoBal == null ? 0 : EASY_TRADE.demoBal; }

  // ── HOME view (stats + house grid) ────────────────────────────────────────
  function renderHome(ov) {
    var t = TT();
    var body = ov.querySelector("#et-body"); if (!body) return;

    var stat =
      '<div class="et-stats">' +
        '<div class="et-stat"><div style="position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,' + t.pr + ',transparent)"></div>' +
          '<div class="lab" style="color:' + t.pr + '">Your Wallet</div>' +
          '<div class="val">' + fmtQ(bal()) + '<span class="q" style="color:' + t.pr + '">QNTM</span></div>' +
        '</div>' +
        '<div class="et-stat"><div style="position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,' + GOLD + ',transparent)"></div>' +
          '<div class="lab" style="color:' + GOLD + '">Reward Pool</div>' +
          '<div class="val">' + fmtQ(EASY_TRADE.demoPool) + '<span class="q" style="color:' + GOLD + '">QNTM</span></div>' +
        '</div>' +
      '</div>';

    var grid = HOUSES.map(function (h) {
      var prods = h.products.slice(0, 3).map(function (p) { return '<span class="et-chip">' + ESC(p) + '</span>'; }).join("");
      return '<div class="et-house" data-house="' + h.id + '" style="box-shadow:inset 0 0 0 1px ' + hexA(h.accent, .04) + '">' +
        '<div style="position:absolute;top:-30px;right:-30px;width:90px;height:90px;border-radius:50%;background:radial-gradient(circle,' + hexA(h.accent, .22) + ',transparent 70%)"></div>' +
        '<div class="et-mono" style="background:linear-gradient(135deg,' + h.accent + ',' + hexA(h.accent, .55) + ')">' + ESC(h.name[0]) + '</div>' +
        '<div style="font-size:14.5px;font-weight:800;color:' + t.t1 + ';line-height:1.15">' + ESC(h.name) + '</div>' +
        '<div style="font-size:11px;color:' + t.t3 + ';margin-top:2px">' + ESC(h.tag) + '</div>' +
        '<div style="margin-top:7px;min-height:22px">' + prods + '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-top:11px;padding-top:10px;border-top:1px solid ' + t.bd + '">' +
          '<span class="et-dot"></span><span style="font-size:10.5px;color:' + t.t3 + '">' + h.live + ' live</span>' +
          '<span style="flex:1"></span>' +
          '<span style="font-size:10.5px;color:' + t.t4 + '">win</span><span style="font-size:13px;font-weight:800;color:' + (h.win >= 60 ? GREEN : h.win >= 50 ? GOLD : t.t2) + '">' + h.win + '%</span>' +
        '</div>' +
      '</div>';
    }).join("");

    body.innerHTML = stat +
      '<div class="et-h">' + ICO('<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>', 16) + 'Choose a signal house</div>' +
      '<div style="font-size:11.5px;color:' + t.t4 + ';margin:-6px 2px 13px;line-height:1.5">Pick a house, stake QNTM, then predict whether its next signal hits its <b style="color:' + GREEN + '">target</b> or its <b style="color:' + RED + '">stop</b>. Guess right, win double.</div>' +
      '<div class="et-grid">' + grid + '</div>' +
      '<div style="text-align:center;margin-top:22px;font-size:10.5px;color:' + t.t4 + ';line-height:1.6">Outcomes are decided by each house\u2019s live indicator via TradingView.<br>Predict responsibly \u2014 you can lose your entire stake.</div>';

    body.querySelectorAll(".et-house").forEach(function (c) {
      c.onclick = function () { openBetSheet(ov, houseById(c.dataset.house)); };
    });
  }

  // ── BET sheet ─────────────────────────────────────────────────────────────
  function openBetSheet(ov, house) {
    var t = TT();
    closeSheet();
    var stake = Math.max(EASY_TRADE.MIN, Math.min(100, bal()));
    var pick = null;

    var scrim = document.createElement("div");
    scrim.className = "et-scrim"; scrim.id = "et-scrim";
    scrim.innerHTML =
      '<div class="et-sheet" id="et-sheet">' +
        '<div class="et-grab"></div>' +
        '<div style="display:flex;align-items:center;gap:11px;margin-bottom:6px">' +
          '<div class="et-mono" style="width:38px;height:38px;font-size:16px;margin:0;background:linear-gradient(135deg,' + house.accent + ',' + hexA(house.accent, .55) + ')">' + ESC(house.name[0]) + '</div>' +
          '<div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:800;color:' + t.t1 + '">' + ESC(house.name) + '</div><div style="font-size:11px;color:' + t.t3 + '">' + ESC(house.products.join(" \u00b7 ")) + '</div></div>' +
          '<button class="et-ibtn" id="et-x" type="button">' + ICO('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 18) + '</button>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:' + t.t3 + ';margin:4px 2px 0"><span>Balance</span><span style="color:' + t.t1 + ';font-weight:700">' + fmtQ(bal()) + ' QNTM</span></div>' +

        '<div class="et-stakebox"><span class="et-stakeval" id="et-sv">' + fmtQ(stake) + '</span><span class="et-stakeq">QNTM</span></div>' +
        '<input class="et-slider" id="et-sl" type="range" min="0" max="1000" value="' + valToPos(stake) + '"/>' +
        '<div style="display:flex;justify-content:space-between;font-size:10px;color:' + t.t4 + ';margin-top:-2px"><span>' + EASY_TRADE.MIN + '</span><span>1,000,000</span></div>' +
        '<div class="et-qp" id="et-qp">' +
          ['10', '100', '1K', '10K', '100K', 'MAX'].map(function (l) { return '<button class="et-qpb" data-qp="' + l + '" type="button">' + l + '</button>'; }).join("") +
        '</div>' +
        '<input class="et-inp" id="et-num" inputmode="numeric" value="' + stake + '" style="margin-top:8px"/>' +

        '<div style="font-size:11.5px;color:' + t.t3 + ';font-weight:700;margin:16px 2px 0;letter-spacing:.3px">YOUR PREDICTION</div>' +
        '<div class="et-pick" id="et-pick">' +
          '<button class="et-pk" data-pick="TP" type="button"><div class="pkt" style="color:' + GREEN + '">TP</div><div class="pks">Hits target</div></button>' +
          '<button class="et-pk" data-pick="SL" type="button"><div class="pkt" style="color:' + RED + '">SL</div><div class="pks">Hits stop</div></button>' +
        '</div>' +

        '<div style="display:flex;justify-content:space-between;align-items:center;margin:14px 2px 0;font-size:12px"><span style="color:' + t.t3 + '">Potential payout</span><span id="et-payout" style="color:' + GREEN + ';font-weight:800;font-size:15px;text-shadow:0 0 12px ' + GREEN_G + '">' + fmtQ(stake * EASY_TRADE.payoutMult) + ' QNTM</span></div>' +
        '<div id="et-warn" style="font-size:11px;color:' + GOLD + ';margin:8px 2px 0;line-height:1.5;display:none"></div>' +

        '<button class="et-cta" id="et-place" type="button" disabled style="background:linear-gradient(135deg,' + t.pr + ',' + hexA(t.pr, .7) + ');box-shadow:0 8px 26px ' + hexA(t.pr, .4) + '">Choose TP or SL</button>' +
        '<div class="et-mini" style="margin:12px auto 2px;display:flex;width:max-content">' + ICO('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>', 11) + 'Practice mode \u2014 no real QNTM is staked yet</div>' +
      '</div>';
    document.body.appendChild(scrim);

    var $ = function (id) { return scrim.querySelector(id); };
    var sv = $("#et-sv"), sl = $("#et-sl"), num = $("#et-num"), payout = $("#et-payout"), place = $("#et-place"), warn = $("#et-warn");

    function refresh() {
      stake = clampStake(stake);
      sv.textContent = fmtQ(stake);
      if (document.activeElement !== num) num.value = stake;
      sl.value = valToPos(stake);
      payout.textContent = fmtQ(stake * EASY_TRADE.payoutMult) + " QNTM";
      var problem = "";
      if (stake < EASY_TRADE.MIN) problem = "Minimum stake is " + EASY_TRADE.MIN + " QNTM.";
      else if (stake > bal()) problem = "That\u2019s more than your balance.";
      else if (stake > EASY_TRADE.MAX) problem = "Maximum stake is " + fmtQ(EASY_TRADE.MAX) + " QNTM.";
      if (problem) { warn.style.display = "block"; warn.textContent = problem; }
      else warn.style.display = "none";
      var ok = !problem && !!pick;
      place.disabled = !ok;
      place.textContent = !pick ? "Choose TP or SL" : (problem ? "Adjust your stake" : ("Predict " + pick + " \u00b7 stake " + fmtQ(stake)));
    }

    sl.oninput = function () { stake = posToVal(Number(sl.value)); refresh(); };
    num.oninput = function () { stake = clampStake(num.value.replace(/[^\d]/g, "")); refresh(); };
    num.onblur = function () { refresh(); };
    $("#et-qp").querySelectorAll(".et-qpb").forEach(function (b) {
      b.onclick = function () {
        var m = { "10": 10, "100": 100, "1K": 1000, "10K": 10000, "100K": 100000, "MAX": Math.min(EASY_TRADE.MAX, bal()) };
        stake = clampStake(m[b.dataset.qp]); refresh();
      };
    });
    $("#et-pick").querySelectorAll(".et-pk").forEach(function (b) {
      b.onclick = function () {
        pick = b.dataset.pick;
        scrim.querySelectorAll(".et-pk").forEach(function (x) {
          var on = x.dataset.pick === pick;
          var col = pick === "TP" ? GREEN : RED, glow = pick === "TP" ? GREEN_G : RED_G;
          x.style.borderColor = on ? col : t.bd;
          x.style.background = on ? hexA(col, .12) : t.cd;
          x.style.boxShadow = on ? ("0 0 0 3px " + hexA(col, .15) + ",0 0 18px " + glow) : "none";
        });
        place.style.background = "linear-gradient(135deg," + (pick === "TP" ? GREEN : RED) + "," + hexA(pick === "TP" ? GREEN : RED, .7) + ")";
        place.style.boxShadow = "0 8px 26px " + (pick === "TP" ? GREEN_G : RED_G);
        refresh();
      };
    });
    $("#et-x").onclick = closeSheet;
    scrim.onclick = function (e) { if (e.target === scrim) closeSheet(); };
    place.onclick = function () { placeBet(ov, house, stake, pick); };

    refresh();
  }

  function closeSheet() { var s = document.getElementById("et-scrim"); if (s) s.remove(); }

  // ── place bet → escrow stake → waiting view ───────────────────────────────
  function placeBet(ov, house, stake, pick) {
    closeSheet();
    // LIVE-HOOK: POST /api/easytrade/bet {houseId:house.id, stake, pick}
    //           server escrows `stake` from the wallet and returns a ticket id.
    EASY_TRADE.demoBal = bal() - stake;                       // (practice) debit/escrow
    var ticket = { id: "demo-" + Date.now(), house: house, stake: stake, pick: pick, status: "waiting", entry: null, outcome: null };
    EASY_TRADE.ticket = ticket;
    renderTicket(ov);

    if (!EASY_TRADE.live) simulateSignal(ov, ticket);
    else pollTicket(ov, ticket);
  }

  // ── waiting / live ticket view ────────────────────────────────────────────
  function renderTicket(ov) {
    var t = TT(); var tk = EASY_TRADE.ticket; if (!tk) { renderHome(ov); return; }
    var body = ov.querySelector("#et-body"); if (!body) return;
    var pickCol = tk.pick === "TP" ? GREEN : RED, pickGlow = tk.pick === "TP" ? GREEN_G : RED_G;

    var entryBlock = "";
    if (tk.entry) {
      var up = tk.entry.dir === "long";
      entryBlock =
        '<div style="margin:18px 0 4px;border:1px solid ' + t.bd + ';border-radius:14px;background:' + t.cd + ';padding:14px">' +
          '<div style="display:flex;align-items:center;gap:9px">' +
            '<span style="font-size:11px;font-weight:800;color:#fff;background:' + (up ? GREEN : RED) + ';padding:3px 9px;border-radius:7px;letter-spacing:.5px">' + (up ? "LONG" : "SHORT") + '</span>' +
            '<span style="font-size:16px;font-weight:800;color:' + t.t1 + ';font-family:ui-monospace,monospace">' + ESC(tk.entry.symbol) + '</span>' +
            '<span style="flex:1"></span>' +
            '<span class="et-badge" style="color:' + t.t3 + ';background:' + t.inp + '"><span style="width:9px;height:9px;border:2px solid ' + t.t3 + ';border-top-color:transparent;border-radius:50%;display:inline-block;animation:etSpin .7s linear infinite"></span>In progress</span>' +
          '</div>' +
          '<div style="font-size:11.5px;color:' + t.t4 + ';margin-top:9px;line-height:1.5">Entry fired. Waiting for the indicator to reach its <b style="color:' + GREEN + '">target</b> or <b style="color:' + RED + '">stop</b>\u2026</div>' +
        '</div>';
    }

    body.innerHTML =
      '<div style="text-align:center;padding:10px 0 0">' +
        '<div class="et-radar"><div class="ring"></div><div class="ring ring2"></div>' +
          '<div style="width:62px;height:62px;border-radius:50%;background:' + hexA(tk.house.accent, .16) + ';border:1px solid ' + hexA(tk.house.accent, .4) + ';display:flex;align-items:center;justify-content:center;color:' + tk.house.accent + '">' + ICO('<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>', 26) + '</div>' +
        '</div>' +
        '<div style="font-size:17px;font-weight:800;color:' + t.t1 + '">' + (tk.entry ? "Signal live" : "Waiting for next signal") + '</div>' +
        '<div style="font-size:12.5px;color:' + t.t3 + ';margin-top:3px">from <b style="color:' + tk.house.accent + '">' + ESC(tk.house.name) + '</b></div>' +
      '</div>' +
      entryBlock +
      '<div style="display:flex;gap:11px;margin-top:18px">' +
        '<div style="flex:1;border:1px solid ' + t.bd + ';border-radius:13px;background:' + t.cd + ';padding:12px;text-align:center"><div style="font-size:10px;letter-spacing:.6px;color:' + t.t4 + ';text-transform:uppercase;font-weight:800">Your pick</div><div style="font-size:22px;font-weight:900;color:' + pickCol + ';text-shadow:0 0 14px ' + pickGlow + ';margin-top:3px">' + tk.pick + '</div></div>' +
        '<div style="flex:1;border:1px solid ' + t.bd + ';border-radius:13px;background:' + t.cd + ';padding:12px;text-align:center"><div style="font-size:10px;letter-spacing:.6px;color:' + t.t4 + ';text-transform:uppercase;font-weight:800">Staked</div><div style="font-size:22px;font-weight:900;color:' + t.t1 + ';margin-top:3px">' + fmtQ(tk.stake) + '</div></div>' +
        '<div style="flex:1;border:1px solid ' + t.bd + ';border-radius:13px;background:' + t.cd + ';padding:12px;text-align:center"><div style="font-size:10px;letter-spacing:.6px;color:' + t.t4 + ';text-transform:uppercase;font-weight:800">To win</div><div style="font-size:22px;font-weight:900;color:' + GREEN + ';margin-top:3px">' + fmtQ(tk.stake * EASY_TRADE.payoutMult) + '</div></div>' +
      '</div>' +
      '<div style="text-align:center;font-size:11px;color:' + t.t4 + ';margin-top:20px;line-height:1.6">Your stake is locked until this round settles.<br>You\u2019ll be paid automatically if your prediction is correct.</div>';
  }

  // ── result view ───────────────────────────────────────────────────────────
  function renderResult(ov, tk) {
    var t = TT(); var body = ov.querySelector("#et-body"); if (!body) return;
    var won = tk.outcome === tk.pick;
    var col = won ? GREEN : RED, glow = won ? GREEN_G : RED_G;
    var outCol = tk.outcome === "TP" ? GREEN : RED;

    body.innerHTML =
      '<div style="text-align:center;padding:18px 0 6px">' +
        '<div style="font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:' + t.t3 + '">' + ESC(tk.house.name) + ' \u00b7 ' + ESC(tk.entry ? tk.entry.symbol : "") + '</div>' +
        '<div class="et-stamp" style="color:' + outCol + ';text-shadow:0 0 30px ' + (tk.outcome === "TP" ? GREEN_G : RED_G) + '">' + tk.outcome + '</div>' +
        '<div style="font-size:13px;color:' + t.t3 + '">the signal hit its ' + (tk.outcome === "TP" ? "target" : "stop") + '</div>' +
      '</div>' +
      '<div style="margin:14px auto 0;max-width:340px;border:1.5px solid ' + hexA(col, .5) + ';border-radius:18px;background:' + hexA(col, .08) + ';padding:20px;text-align:center;box-shadow:0 0 30px ' + hexA(col, .18) + '">' +
        '<div style="font-size:15px;font-weight:800;color:' + col + '">' + (won ? "You won!" : "Not this time") + '</div>' +
        '<div style="font-size:40px;font-weight:900;color:' + col + ';letter-spacing:-1px;margin:6px 0;text-shadow:0 0 22px ' + glow + '">' + (won ? "+" + fmtQ(tk.stake * EASY_TRADE.payoutMult) : "\u2212" + fmtQ(tk.stake)) + '</div>' +
        '<div style="font-size:12px;color:' + t.t3 + '">' + (won
          ? ("You predicted " + tk.pick + " and the signal delivered. " + fmtQ(tk.stake * EASY_TRADE.payoutMult) + " QNTM paid to your wallet.")
          : ("You predicted " + tk.pick + ". Your " + fmtQ(tk.stake) + " QNTM stake went to the reward pool.")) + '</div>' +
      '</div>' +
      '<div class="et-stats" style="margin-top:18px">' +
        '<div class="et-stat"><div class="lab" style="color:' + t.pr + '">Your Wallet</div><div class="val">' + fmtQ(bal()) + '<span class="q" style="color:' + t.pr + '">QNTM</span></div></div>' +
        '<div class="et-stat"><div class="lab" style="color:' + GOLD + '">Reward Pool</div><div class="val">' + fmtQ(EASY_TRADE.demoPool) + '<span class="q" style="color:' + GOLD + '">QNTM</span></div></div>' +
      '</div>' +
      '<button class="et-cta" id="et-again" type="button" style="background:linear-gradient(135deg,' + tk.house.accent + ',' + hexA(tk.house.accent, .7) + ');box-shadow:0 8px 26px ' + hexA(tk.house.accent, .4) + '">Predict again</button>' +
      '<button class="et-cta" id="et-home" type="button" style="background:' + t.btn + ';color:' + t.t2 + ';box-shadow:none;margin-top:9px">Back to houses</button>';

    body.querySelector("#et-again").onclick = function () { EASY_TRADE.ticket = null; renderHome(ov); openBetSheet(ov, tk.house); };
    body.querySelector("#et-home").onclick = function () { EASY_TRADE.ticket = null; renderHome(ov); };
  }

  // ── practice-mode signal simulation (replaced by pollTicket when live) ────
  function simulateSignal(ov, tk) {
    var house = tk.house;
    var sym = house.products[Math.floor(Math.random() * house.products.length)];
    setTimeout(function () {
      if (EASY_TRADE.ticket !== tk) return;
      tk.entry = { dir: Math.random() < 0.5 ? "long" : "short", symbol: sym };
      tk.status = "live";
      if (document.getElementById("et-ov")) renderTicket(ov);
      setTimeout(function () {
        if (EASY_TRADE.ticket !== tk) return;
        tk.outcome = Math.random() < 0.5 ? "TP" : "SL";        // fair coin (EV ≈ 0)
        tk.status = "settled";
        // (practice) settle against local balance + pool
        if (tk.outcome === tk.pick) { EASY_TRADE.demoBal = bal() + tk.stake * EASY_TRADE.payoutMult; EASY_TRADE.demoPool = Math.max(0, EASY_TRADE.demoPool - tk.stake); toast("You won!", "+" + fmtQ(tk.stake * EASY_TRADE.payoutMult) + " QNTM"); }
        else { EASY_TRADE.demoPool += tk.stake; }
        if (document.getElementById("et-ov")) renderResult(ov, tk);
      }, 3400 + Math.random() * 1200);
    }, 2000 + Math.random() * 900);
  }

  // ── live polling (used when EASY_TRADE.live) ──────────────────────────────
  function pollTicket(ov, tk) {
    var tries = 0;
    (function loop() {
      if (EASY_TRADE.ticket !== tk || !document.getElementById("et-ov")) return;
      api("/easytrade/ticket/" + encodeURIComponent(tk.id)).then(function (r) {
        var s = r && r.ticket; if (!s) return;
        if (s.entry && !tk.entry) { tk.entry = s.entry; tk.status = "live"; renderTicket(ov); }
        if (s.status === "settled") {
          tk.outcome = s.outcome;
          return fetchBalance().then(function (b) { if (b != null) EASY_TRADE.demoBal = b; if (typeof s.pool === "number") EASY_TRADE.demoPool = s.pool; renderResult(ov, tk); });
        }
        if (++tries < 600) setTimeout(loop, 2000);
      }).catch(function () { if (++tries < 600) setTimeout(loop, 3000); });
    })();
  }

  // ── rules sheet ───────────────────────────────────────────────────────────
  function openRules() {
    var t = TT(); closeSheet();
    var scrim = document.createElement("div"); scrim.className = "et-scrim"; scrim.id = "et-scrim";
    var step = function (n, txt) { return '<div style="display:flex;gap:11px;margin-bottom:13px"><div style="width:24px;height:24px;border-radius:50%;background:' + t.act + ';color:' + t.pr + ';font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0">' + n + '</div><div style="font-size:13px;color:' + t.t2 + ';line-height:1.5">' + txt + '</div></div>'; };
    scrim.innerHTML =
      '<div class="et-sheet">' +
        '<div class="et-grab"></div>' +
        '<div style="font-size:18px;font-weight:800;color:' + t.t1 + ';margin-bottom:4px">How Easy Trade works</div>' +
        '<div style="font-size:12px;color:' + t.t3 + ';margin-bottom:16px">Baby Trader \u2014 predict the signal, not the price.</div>' +
        step(1, 'Pick a <b style="color:' + t.t1 + '">signal house</b>. You\u2019ll only get signals from that house\u2019s products.') +
        step(2, 'Stake between <b style="color:' + t.t1 + '">' + EASY_TRADE.MIN + '</b> and <b style="color:' + t.t1 + '">' + fmtQ(EASY_TRADE.MAX) + '</b> QNTM from your wallet.') +
        step(3, 'Predict the next signal\u2019s outcome: <b style="color:' + GREEN + '">TP</b> (hits target) or <b style="color:' + RED + '">SL</b> (hits stop).') +
        step(4, 'The house\u2019s indicator fires a <b style="color:' + t.t1 + '">long/short entry</b>, then reaches its <b style="color:' + GREEN + '">target</b> or <b style="color:' + RED + '">stop</b>.') +
        step(5, 'Right prediction \u2192 <b style="color:' + GREEN + '">2\u00d7 your stake</b>. Wrong \u2192 your stake joins the <b style="color:' + GOLD + '">reward pool</b>.') +
        '<div style="font-size:11px;color:' + t.t4 + ';line-height:1.6;background:' + t.inp + ';border:1px solid ' + t.bd + ';border-radius:11px;padding:11px;margin-top:6px">Predictions carry real risk of total loss of your stake. Easy Trade is a game of chance on market outcomes \u2014 it is not investment advice. Availability may be restricted in your region.</div>' +
        '<button class="et-cta" id="et-rx" type="button" style="background:linear-gradient(135deg,' + t.pr + ',' + hexA(t.pr, .7) + ')">Got it</button>' +
      '</div>';
    document.body.appendChild(scrim);
    scrim.querySelector("#et-rx").onclick = closeSheet;
    scrim.onclick = function (e) { if (e.target === scrim) closeSheet(); };
  }

  // ── colour helper: hex (#rrggbb) + alpha → rgba() ─────────────────────────
  function hexA(hex, a) {
    hex = String(hex || "#1c84ff").replace("#", "");
    if (hex.length === 3) hex = hex.split("").map(function (c) { return c + c; }).join("");
    var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  // ── overlay shell + open ──────────────────────────────────────────────────
  function open() {
    injectCSS();
    var t = TT();
    var prev = document.getElementById("et-ov"); if (prev) prev.remove();

    var ov = document.createElement("div"); ov.id = "et-ov";
    ov.innerHTML =
      '<div class="et-amb" style="top:-70px;right:-50px;width:230px;height:230px;background:radial-gradient(circle,' + hexA(t.pr, .5) + ',transparent 70%)"></div>' +
      '<div class="et-amb" style="bottom:-80px;left:-60px;width:230px;height:230px;background:radial-gradient(circle,' + GOLD_G + ',transparent 72%);opacity:.3"></div>' +
      '<div class="et-hd">' +
        '<button class="et-ibtn" id="et-back" type="button">' + ICO('<polyline points="15 18 9 12 15 6"/>', 18) + '</button>' +
        '<div style="display:flex;align-items:center;gap:9px;flex:1;min-width:0">' +
          '<span style="display:inline-flex;color:' + t.pr + '">' + ICO('<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>', 21) + '</span>' +
          '<div style="min-width:0"><div style="color:' + t.t1 + ';font-weight:800;font-size:17px;line-height:1">Easy Trade</div><div style="color:' + t.t4 + ';font-size:10px;font-weight:600;letter-spacing:.4px">BABY TRADER</div></div>' +
        '</div>' +
        '<button class="et-ibtn" id="et-info" type="button">' + ICO('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>', 18) + '</button>' +
      '</div>' +
      '<div class="et-body" id="et-body"></div>';
    document.body.appendChild(ov);

    ov.querySelector("#et-back").onclick = function () { closeSheet(); ov.remove(); };
    ov.querySelector("#et-info").onclick = openRules;

    // seed balance from the authoritative wallet (read-only), then render
    var body = ov.querySelector("#et-body");
    body.innerHTML = '<div style="display:flex;justify-content:center;padding:60px 0"><div style="width:26px;height:26px;border:3px solid ' + t.bd + ';border-top-color:' + t.pr + ';border-radius:50%;animation:etSpin .8s linear infinite"></div></div>';
    fetchBalance().then(function (b) {
      if (EASY_TRADE.demoBal == null) EASY_TRADE.demoBal = (b != null ? b : 1000);  // practice fallback
      if (!document.getElementById("et-ov")) return;
      if (EASY_TRADE.ticket && EASY_TRADE.ticket.status !== "settled") renderTicket(ov);
      else renderHome(ov);
    });
  }

  if (typeof window !== "undefined") window.openEasyTrade = open;
})();
