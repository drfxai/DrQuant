/* ============================================================================
   DrFX Quant — Easy Trade (Baby Trader)   →  window.openEasyTrade
   ----------------------------------------------------------------------------
   A wallet-connected signal-PREDICTION game on the bottom-nav slot. The trader:
     1. picks a signal house (company); signals come only from that house,
     2. stakes QNTM (min..max) FROM THEIR REAL WALLET,
     3. predicts the next signal's outcome: TP (hits target) or SL (hits stop),
     4. the house's TradingView indicator fires entry → target/stop via the
        dedicated Easy Trade webhook; the round settles automatically:
            prediction == outcome  → pays 2× the stake
            prediction != outcome  → stake goes to the Reward Pool

   WALLET: every figure here comes from the authoritative qntm-ledger via
   /api/easytrade/me — the balance shown IS the user's main wallet. Stakes and
   payouts are real double-entry ledger transactions; nothing is simulated and
   no shadow balance is ever kept on the client.

   Backend:  routes/easytrade.js + services/easytrade.js
   Page globals reused (with fallbacks): t, esc, ic, api, S, showToast.
   ========================================================================== */
(function () {
  "use strict";

  var ET = {
    min: 10, max: 1000000, payoutMult: 2,   // overwritten by /me
    balance: "0", pool: "0",
    houses: [],
    ticket: null,                            // the open/most-recent ticket
    poll: null,                              // polling timer id
    view: "home"                             // home | history | ticket | result
  };

  // ── safe accessors ─────────────────────────────────────────────────────────
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
  function API(path, opts) {
    if (typeof api !== "function") return Promise.reject(new Error("offline"));
    return api(path, opts);
  }

  var GREEN = "#34d27a", GREEN_G = "rgba(52,210,122,.5)";
  var RED = "#ef4444", RED_G = "rgba(239,68,68,.5)";
  var GOLD = "#f5b54a", GOLD_G = "rgba(245,181,74,.45)";

  // fallback house art (used only until /houses responds; ids match the seed)
  var FALLBACK_HOUSES = [
    { id: "godmode", name: "DrFX GOD MODE", tag: "Quad-consensus", accent: "#1c84ff", products: ["BTCUSDT", "ETHUSDT", "XAUUSD"], live: 0, online: 61, win: 83 },
    { id: "apex", name: "Apex Signals", tag: "Crypto breakout", accent: "#16e29a", products: ["ETHUSDT", "SOLUSDT", "BNBUSDT"], live: 0, online: 52, win: 77 },
    { id: "titan", name: "Titan FX", tag: "Major pairs", accent: "#f5b54a", products: ["GBPUSD", "USDJPY", "AUDUSD"], live: 0, online: 46, win: 71 },
    { id: "aurora", name: "Aurora Capital", tag: "Index momentum", accent: "#8b5cf6", products: ["NAS100", "US30", "SPX500"], live: 0, online: 41, win: 64 },
    { id: "luxalgo", name: "Lux Algo", tag: "Smart-money flow", accent: "#eab308", products: ["BTCUSDT", "SOLUSDT", "XRPUSDT"], live: 0, online: 32, win: 56 },
    { id: "chartprime", name: "Chart Prime", tag: "Order-flow edge", accent: "#ec4899", products: ["ETHUSDT", "DOGEUSDT", "BNBUSDT"], live: 0, online: 30, win: 54 }
  ];
  function houseById(id) { for (var i = 0; i < ET.houses.length; i++) if (ET.houses[i].id === id) return ET.houses[i]; return ET.houses[0] || FALLBACK_HOUSES[0]; }

  // ── numbers ────────────────────────────────────────────────────────────────
  function fmtQ(n) { n = Number(n); if (!isFinite(n)) n = 0; return n.toLocaleString("en-US", { maximumFractionDigits: n < 1000 ? 2 : 0 }); }
  function balNum() { return Number(ET.balance) || 0; }
  function clampStake(v) { v = Math.floor(Number(v) || 0); return Math.max(0, Math.min(ET.max, v)); }
  function posToVal(pos) { var lo = Math.log10(ET.min), hi = Math.log10(ET.max); var v = Math.pow(10, lo + (hi - lo) * (pos / 1000)); var step = v < 100 ? 1 : v < 1000 ? 10 : v < 10000 ? 50 : v < 100000 ? 500 : 5000; return clampStake(Math.round(v / step) * step); }
  function valToPos(v) { var lo = Math.log10(ET.min), hi = Math.log10(ET.max); v = Math.max(ET.min, Math.min(ET.max, Number(v) || ET.min)); return Math.round(1000 * (Math.log10(v) - lo) / (hi - lo)); }

  // ── scoped stylesheet (injected once) ──────────────────────────────────────
  function injectCSS() {
    if (document.getElementById("et-css")) return;
    var t = TT();
    var css =
      '#et-ov{position:fixed;inset:0;z-index:5200;background:' + t.bg + ';display:flex;flex-direction:column;animation:etFade .22s ease;padding-top:var(--sat);padding-bottom:var(--sab);padding-left:var(--sal);padding-right:var(--sar);font-family:Outfit,sans-serif}' +
      '#et-ov *{box-sizing:border-box}' +
      '.et-hd{display:flex;align-items:center;gap:11px;padding:11px 14px;background:' + t.ch + ';-webkit-backdrop-filter:blur(22px) saturate(160%);backdrop-filter:blur(22px) saturate(160%);border-bottom:1px solid ' + t.bd + ';flex-shrink:0;width:100%;max-width:620px;margin-left:auto;margin-right:auto}' +
      '.et-ibtn{width:36px;height:36px;border-radius:10px;border:1px solid ' + t.bd + ';background:' + t.btn + ';color:' + t.t1 + ';cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:transform .12s}' +
      '.et-ibtn:active{transform:scale(.92)}' +
      '.et-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px 14px 26px;width:100%;max-width:620px;margin-left:auto;margin-right:auto}' +
      '.et-amb{position:fixed;border-radius:50%;filter:blur(58px);pointer-events:none;opacity:.42;z-index:0}' +
      '.et-stats{display:flex;gap:11px;margin-bottom:16px;position:relative;z-index:1}' +
      '.et-stat{flex:1;border-radius:16px;padding:13px 14px;background:' + t.cd + ';border:1px solid ' + t.bd + ';position:relative;overflow:hidden;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}' +
      '.et-stat .lab{font-size:9.5px;letter-spacing:1.2px;text-transform:uppercase;font-weight:800;margin-bottom:5px}' +
      '.et-stat .val{font-size:23px;font-weight:800;letter-spacing:-.5px;line-height:1;color:' + t.t1 + '}' +
      '.et-stat .q{font-size:12px;font-weight:700;margin-left:5px}' +
      '.et-h{font-size:13px;font-weight:800;color:' + t.t1 + ';letter-spacing:.2px;margin:4px 2px 12px;display:flex;align-items:center;gap:8px}' +
      '.et-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px;position:relative;z-index:1}' +
      '.et-house{border-radius:17px;padding:14px;background:' + t.cd + ';border:1px solid ' + t.bd + ';cursor:pointer;position:relative;overflow:hidden;transition:transform .14s,border-color .2s,box-shadow .2s}' +
      '.et-house:active{transform:scale(.975)}' +
      '.et-mono{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff;margin-bottom:10px;box-shadow:0 6px 18px rgba(0,0,0,.35)}' +
      '.et-chip{display:inline-block;font-size:9.5px;font-weight:700;color:' + t.t3 + ';background:' + t.inp + ';border:1px solid ' + t.bd + ';border-radius:7px;padding:2px 6px;margin:3px 4px 0 0}' +
      '.et-dot{width:6px;height:6px;border-radius:50%;background:' + GREEN + ';box-shadow:0 0 7px ' + GREEN_G + ';display:inline-block;animation:etPulse 1.6s infinite}' +
      '.et-scrim{position:fixed;inset:0;z-index:5300;background:rgba(3,6,14,.62);-webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px);display:flex;align-items:flex-end;justify-content:center;animation:etFade .18s ease}' +
      '.et-sheet{width:100%;max-width:520px;max-height:92vh;overflow-y:auto;-webkit-overflow-scrolling:touch;background:' + t.bg + ';border:1px solid ' + t.bd + ';border-bottom:none;border-radius:22px 22px 0 0;padding:8px 16px calc(20px + var(--sab));animation:etUp .26s cubic-bezier(.2,.8,.2,1);box-shadow:0 -20px 60px rgba(0,0,0,.6)}' +
      '.et-grab{width:38px;height:4px;border-radius:3px;background:' + t.bd + ';margin:6px auto 12px}' +
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
      '.et-pick{display:flex;gap:11px;margin:14px 0 6px}' +
      '.et-pk{flex:1;border-radius:15px;padding:15px 10px;border:1.5px solid ' + t.bd + ';background:' + t.cd + ';cursor:pointer;text-align:center;transition:all .16s;font-family:inherit;position:relative;overflow:hidden}' +
      '.et-pk:active{transform:scale(.97)}' +
      '.et-pk .pkt{font-size:18px;font-weight:800;letter-spacing:.5px}' +
      '.et-pk .pks{font-size:11px;font-weight:600;color:' + t.t3 + ';margin-top:2px}' +
      '.et-cta{width:100%;padding:16px;border:none;border-radius:14px;font-weight:800;font-size:15.5px;cursor:pointer;font-family:inherit;color:#fff;margin-top:14px;transition:transform .14s,box-shadow .2s,opacity .2s;display:flex;align-items:center;justify-content:center;gap:9px}' +
      '.et-cta:active{transform:scale(.985)}' +
      '.et-cta:disabled{opacity:.45;cursor:not-allowed;filter:grayscale(.4)}' +
      '.et-radar{width:128px;height:128px;margin:8px auto 18px;border-radius:50%;position:relative;display:flex;align-items:center;justify-content:center}' +
      '.et-radar .ring{position:absolute;inset:0;border-radius:50%;border:2px solid ' + t.ba + ';animation:etRing 2s ease-out infinite}' +
      '.et-radar .ring2{animation-delay:1s}' +
      '.et-badge{display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:999px;font-size:12px;font-weight:800;letter-spacing:.3px}' +
      '.et-stamp{font-size:54px;font-weight:900;letter-spacing:2px;text-align:center;line-height:1;margin:6px 0;animation:etStamp .5s cubic-bezier(.2,1.2,.3,1)}' +
      '.et-mini{display:inline-flex;align-items:center;gap:5px;font-size:9px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;padding:3px 8px;border-radius:999px;border:1px solid ' + GOLD_G + ';color:' + GOLD + ';background:rgba(245,181,74,.1)}' +
      '@keyframes etFade{from{opacity:0}to{opacity:1}}' +
      '@keyframes etUp{from{transform:translateY(40px);opacity:.4}to{transform:translateY(0);opacity:1}}' +
      '@keyframes etPulse{0%,100%{opacity:1}50%{opacity:.35}}' +
      '@keyframes etRing{0%{transform:scale(.55);opacity:.9}100%{transform:scale(1);opacity:0}}' +
      '@keyframes etStamp{0%{transform:scale(.3) rotate(-12deg);opacity:0}60%{transform:scale(1.12) rotate(3deg)}100%{transform:scale(1) rotate(0);opacity:1}}' +
      '@keyframes etSpin{to{transform:rotate(360deg)}}' +
      '.et-spark{position:absolute;top:12px;right:12px;width:96px;height:46px;pointer-events:none;z-index:0;opacity:.96}' +
      '.et-spark svg{display:block;width:100%;height:100%;overflow:visible}' +
      '.et-spark .etln{stroke-dasharray:240;stroke-dashoffset:240;animation:etDraw 1.5s ease-out forwards}' +
      '.et-spark .etdot{animation:etDotF 1.1s ease-in-out infinite alternate}' +
      '.et-spark .etrun{opacity:0;animation:etRun 2.6s linear infinite}' +
      '.et-spark .etbar{transform-origin:bottom;transform:scaleY(0);animation:etGrow .6s cubic-bezier(.2,1,.3,1) forwards}' +
      '.et-spark .etwk{animation:etWick .6s ease-out forwards;opacity:0}' +
      '.et-spark .etsh{animation:etShim 2.8s ease-in-out infinite}' +
      '@keyframes etDraw{to{stroke-dashoffset:0}}' +
      '@keyframes etDotF{0%{opacity:.55;r:2.4}100%{opacity:1;r:3.4}}' +
      '@keyframes etRun{0%{opacity:0;transform:translateX(0)}8%{opacity:1}92%{opacity:1}100%{opacity:0;transform:translateX(0)}}' +
      '@keyframes etGrow{to{transform:scaleY(1)}}' +
      '@keyframes etWick{to{opacity:1}}' +
      '@keyframes etShim{0%,100%{opacity:.35}50%{opacity:.9}}' +
      '@keyframes etMsIn{0%{transform:translateX(-50%) translateY(-26px);opacity:0}100%{transform:translateX(-50%) translateY(0);opacity:1}}' +
      '@keyframes etMsBar{from{transform:scaleX(1)}to{transform:scaleX(0)}}' +
      '@keyframes etConf{0%{transform:translateY(0) rotate(0deg);opacity:1}100%{transform:translateY(112vh) rotate(680deg);opacity:.15}}' +
      '@keyframes etPop{0%{transform:scale(.6);opacity:0}55%{transform:scale(1.06)}100%{transform:scale(1);opacity:1}}' +
      '.et-bolt{display:inline-flex;line-height:0}' +
      '.et-bolt .et-bolt-glyph{fill-opacity:.14;transition:fill-opacity .3s ease}' +
      '.et-bolt.et-bolt-live .et-bolt-glyph{animation:etBulb 1.5s ease-in-out infinite}' +
      '.et-bolt.et-bolt-live{animation:etBulbGlow 1.5s ease-in-out infinite}' +
      '@keyframes etBulb{0%,100%{fill-opacity:.1}50%{fill-opacity:1}}' +
      '@keyframes etBulbGlow{0%,100%{filter:drop-shadow(0 0 0 rgba(0,0,0,0))}50%{filter:drop-shadow(0 0 7px ' + hexA(GOLD, .8) + ')}}';
    var el = document.createElement("style"); el.id = "et-css"; el.textContent = css; document.head.appendChild(el);
  }

  // ── data loaders (authoritative; balance always from the ledger) ───────────
  function loadMe() {
    return API("/easytrade/me").then(function (r) {
      if (!r) return;
      ET.balance = r.balance != null ? r.balance : ET.balance;
      ET.pool = r.pool != null ? r.pool : ET.pool;
      if (r.min != null) ET.min = Number(r.min);
      if (r.max != null) ET.max = Number(r.max);
      if (r.payoutMult != null) ET.payoutMult = Number(r.payoutMult);
      ET.openTicketId = r.openTicketId || null;
      return r;
    });
  }
  function loadHouses() {
    return API("/easytrade/houses").then(function (r) {
      ET.houses = (r && r.houses && r.houses.length) ? r.houses : FALLBACK_HOUSES;
    }).catch(function () { ET.houses = FALLBACK_HOUSES; });
  }

  // toggle the header bolt's "light bulb" pulse while a prediction is live
  function setBoltLive(on) { var b = document.getElementById("et-bolt"); if (b) b.classList.toggle("et-bolt-live", !!on); setNavBoltLive(on); }

  // ── bottom-nav "Easy Trade" tab bolt: pulse it app-wide while a forecast is live ──
  // Self-contained + defensive: finds the nav item by its exact label, drives a CSS
  // pulse on its icon, and (since the overlay's own poll stops once it's closed) runs
  // a small bounded check so the tab turns itself off when the round settles.
  var _navBoltEl = null, _navWatch = null;
  function ensureNavCss() {
    try {
      if (document.getElementById("et-navbolt-css")) return;
      var th = TT();
      var css =
        '.et-navbolt.et-navbolt-live{animation:etNavGlow 1.5s ease-in-out infinite}' +
        '.et-navbolt.et-navbolt-live path{animation:etNavFill 1.5s ease-in-out infinite}' +
        '@keyframes etNavFill{0%,100%{fill-opacity:0}50%{fill:' + GOLD + ';fill-opacity:.92}}' +
        '@keyframes etNavGlow{0%,100%{filter:drop-shadow(0 0 0 rgba(0,0,0,0))}50%{filter:drop-shadow(0 0 6px ' + hexA(GOLD, .8) + ')}}';
      var el = document.createElement("style"); el.id = "et-navbolt-css"; el.textContent = css; document.head.appendChild(el);
    } catch (e) {}
  }
  function findNavBolt() {
    try {
      if (_navBoltEl && document.body.contains(_navBoltEl)) return _navBoltEl;
      _navBoltEl = null;
      var all = document.body.getElementsByTagName("*"), best = null, bestArea = Infinity;
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!el.getElementsByTagName || !el.getElementsByTagName("svg").length) continue;
        var txt = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (txt !== "easy trade") continue;
        var r = el.getBoundingClientRect(), area = r.width * r.height;
        if (area > 0 && area < bestArea) { bestArea = area; best = el; }
      }
      if (best) { var svg = best.getElementsByTagName("svg")[0]; if (svg) _navBoltEl = svg; }
    } catch (e) { _navBoltEl = null; }
    return _navBoltEl;
  }
  function setNavBoltLive(on) {
    try {
      ensureNavCss();
      var svg = findNavBolt(); if (!svg) return;
      svg.classList.add("et-navbolt");
      svg.classList.toggle("et-navbolt-live", !!on);
    } catch (e) {}
  }
  function stopNavWatch() { if (_navWatch) { clearInterval(_navWatch); _navWatch = null; } }
  function startNavWatch() {
    if (_navWatch) return;
    _navWatch = setInterval(function () {
      if (document.getElementById("et-ov")) return; // overlay open → its own poll drives the bolt
      syncNavBolt();
    }, 15000);
    if (_navWatch.unref) _navWatch.unref();
  }
  function syncNavBolt() {
    return API("/easytrade/me").then(function (r) {
      var live = !!(r && r.openTicketId);
      ET.openTicketId = (r && r.openTicketId) || null;
      setNavBoltLive(live);
      if (live) startNavWatch(); else stopNavWatch();
      return live;
    }).catch(function () {});
  }

  // ── HOME (stats + house grid) ──────────────────────────────────────────────
  function renderHome(ov) {
    ET.view = "home";
    setBoltLive(!!ET.openTicketId);
    var t = TT();
    var body = ov.querySelector("#et-body"); if (!body) return;
    var liveBanner = ET.openTicketId ? (
      '<button id="et-resume" type="button" style="width:100%;display:flex;align-items:center;gap:10px;border:1px solid ' + hexA(t.pr, .4) + ';background:' + hexA(t.pr, .1) + ';border-radius:14px;padding:12px 14px;margin-bottom:14px;cursor:pointer;font-family:inherit;text-align:left">' +
        '<span class="et-dot" style="background:' + t.pr + ';box-shadow:0 0 7px ' + hexA(t.pr, .6) + '"></span>' +
        '<span style="flex:1;color:' + t.t1 + ';font-weight:700;font-size:13px">You have a live prediction</span>' +
        '<span style="color:' + t.pr + ';font-weight:800;font-size:12px">View &rarr;</span>' +
      '</button>') : "";
    var stat =
      '<div class="et-stats">' +
        '<div class="et-stat"><div style="position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,' + t.pr + ',transparent)"></div>' +
          '<div class="lab" style="color:' + t.pr + '">Your Wallet</div>' +
          '<div class="val">' + fmtQ(ET.balance) + '<span class="q" style="color:' + t.pr + '">QNTM</span></div>' +
        '</div>' +
        '<div class="et-stat"><div style="position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,' + GOLD + ',transparent)"></div>' +
          '<div class="lab" style="color:' + GOLD + '">Reward Pool</div>' +
          '<div class="val">' + fmtQ(ET.pool) + '<span class="q" style="color:' + GOLD + '">QNTM</span></div>' +
        '</div>' +
      '</div>';

    var grid = ET.houses.map(function (h) {
      var prods = (h.products || []).slice(0, 3).map(function (p) { return '<span class="et-chip">' + ESC(p) + '</span>'; }).join("");
      var winTxt = h.win == null ? "—" : (h.win + "%");
      var winCol = h.win == null ? t.t3 : h.win >= 60 ? GREEN : h.win >= 50 ? GOLD : t.t2;
      return '<div class="et-house" data-house="' + ESC(h.id) + '">' +
        '<div style="position:absolute;top:-30px;right:-30px;width:90px;height:90px;border-radius:50%;background:radial-gradient(circle,' + hexA(h.accent, .22) + ',transparent 70%)"></div>' +
        houseChart(h, t) +
        '<div class="et-mono" style="background:linear-gradient(135deg,' + h.accent + ',' + hexA(h.accent, .55) + ')">' + ESC((h.name || "?")[0]) + '</div>' +
        '<div style="font-size:14.5px;font-weight:800;color:' + t.t1 + ';line-height:1.15">' + ESC(h.name) + '</div>' +
        '<div style="font-size:11px;color:' + t.t3 + ';margin-top:2px">' + ESC(h.tag || "") + '</div>' +
        '<div style="margin-top:7px;min-height:22px">' + prods + '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-top:11px;padding-top:10px;border-top:1px solid ' + t.bd + '">' +
          '<span class="et-dot"></span><span style="font-size:10.5px;color:' + t.t3 + '">' + (h.online != null ? h.online : '\u2014') + ' online</span>' +
          '<span style="flex:1"></span>' +
          '<span style="font-size:10.5px;color:' + t.t4 + '">win</span><span style="font-size:13px;font-weight:800;color:' + winCol + '">' + winTxt + '</span>' +
        '</div>' +
      '</div>';
    }).join("");

    body.innerHTML = stat + liveBanner +
      '<div style="display:flex;gap:11px;margin-bottom:16px;position:relative;z-index:1">' +
        '<button id="et-go-top" type="button" style="flex:1;display:flex;align-items:center;gap:9px;border:1px solid ' + hexA(GOLD, .4) + ';background:' + hexA(GOLD, .08) + ';border-radius:14px;padding:11px 12px;cursor:pointer;font-family:inherit;text-align:left">' +
          '<span style="width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:' + hexA(GOLD, .16) + ';color:' + GOLD + ';flex-shrink:0">' + ICO('<path d="M8 21h8M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>', 17) + '</span>' +
          '<span style="min-width:0"><span style="display:block;font-size:13px;font-weight:800;color:' + t.t1 + '">Top Traders</span><span style="display:block;font-size:10px;color:' + t.t3 + '">Leaderboard</span></span>' +
        '</button>' +
        '<button id="et-go-leagues" type="button" style="flex:1;display:flex;align-items:center;gap:9px;border:1px solid ' + hexA(t.pr, .4) + ';background:' + hexA(t.pr, .08) + ';border-radius:14px;padding:11px 12px;cursor:pointer;font-family:inherit;text-align:left">' +
          '<span style="width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:' + hexA(t.pr, .16) + ';color:' + t.pr + ';flex-shrink:0">' + ICO('<circle cx="12" cy="8" r="6"/><path d="M15.5 12.5 17 22l-5-3-5 3 1.5-9.5"/>', 17) + '</span>' +
          '<span style="min-width:0"><span style="display:block;font-size:13px;font-weight:800;color:' + t.t1 + '">Leagues</span><span style="display:block;font-size:10px;color:' + t.t3 + '">Ascension</span></span>' +
        '</button>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin:6px 2px 14px;position:relative;z-index:1">' +
        '<span style="width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:' + hexA(t.pr, .16) + ';color:' + t.pr + ';flex-shrink:0">' + ICO('<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>', 18) + '</span>' +
        '<div style="line-height:1.1"><div style="font-size:16px;font-weight:800;color:' + t.t1 + '">Baby Trader</div><div style="font-size:11px;color:' + t.t3 + '">Trade smart. Grow fast.</div></div>' +
      '</div>' +
      '<div class="et-h">' + ICO('<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>', 16) + 'Choose a signal house</div>' +
      '<div style="font-size:11.5px;color:' + t.t4 + ';margin:-6px 2px 13px;line-height:1.5">Pick a house, stake QNTM, then predict whether its next signal hits its <b style="color:' + GREEN + '">target</b> or its <b style="color:' + RED + '">stop</b>. Guess right, win double.</div>' +
      '<div class="et-grid">' + grid + '</div>' +
      '<div style="text-align:center;margin-top:22px;font-size:10.5px;color:' + t.t4 + ';line-height:1.6">Outcomes are decided by each house\u2019s live TradingView indicator.<br>Predict responsibly \u2014 you can lose your entire stake.</div>' +
      '<div style="height:1px;background:linear-gradient(90deg,transparent,' + t.bd + ',transparent);margin:26px 0 6px"></div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin:16px 2px 12px;position:relative;z-index:1">' +
        '<span style="width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#7c5cff,#1c84ff);color:#fff;flex-shrink:0">' + ICO('<rect x="2" y="6" width="20" height="12" rx="3"/><circle cx="8" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="1.6" fill="currentColor" stroke="none"/>', 18) + '</span>' +
        '<div style="flex:1;line-height:1.1"><div style="font-size:16px;font-weight:800;color:' + t.t1 + '">Baby Pick</div><div style="font-size:11px;color:' + t.t3 + '">Play. Predict. Win big.</div></div>' +
        '<span style="font-size:9px;font-weight:800;letter-spacing:.6px;color:' + GREEN + ';background:' + hexA(GREEN, .14) + ';border:1px solid ' + hexA(GREEN, .4) + ';border-radius:6px;padding:3px 8px;display:inline-flex;align-items:center;gap:4px"><span style="width:5px;height:5px;border-radius:50%;background:' + GREEN + '"></span>NEW</span>' +
      '</div>' +
      '<button id="et-go-pick" type="button" style="width:100%;position:relative;overflow:hidden;border-radius:18px;padding:16px;cursor:pointer;font-family:inherit;text-align:left;border:1px solid ' + hexA(t.pr, .4) + ';background:linear-gradient(135deg,' + hexA(t.pr, .16) + ',' + hexA('#7c5cff', .08) + ');z-index:1">' +
        '<div style="position:absolute;top:-40px;right:-30px;width:140px;height:140px;border-radius:50%;background:radial-gradient(circle,' + hexA(t.pr, .3) + ',transparent 70%)"></div>' +
        '<div style="display:flex;align-items:center;gap:13px;position:relative">' +
          '<div style="width:50px;height:50px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1c84ff,#7c5cff);color:#fff;flex-shrink:0;box-shadow:0 8px 22px ' + hexA(t.pr, .5) + '">' + ICO('<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>', 24) + '</div>' +
          '<div style="flex:1;min-width:0"><div style="font-size:16px;font-weight:800;color:' + t.t1 + '">Quick Signal + more</div><div style="font-size:12px;color:' + t.t2 + ';margin-top:2px">Predict <b style="color:' + GREEN + '">UP</b>/<b style="color:' + RED + '">DOWN</b> in 60s, spin the Wheel of Fortune, and more.</div></div>' +
          '<span style="color:' + t.pr + ';flex-shrink:0">' + ICO('<polyline points="9 18 15 12 9 6"/>', 22) + '</span>' +
        '</div>' +
        '<div style="display:flex;gap:7px;margin-top:13px;position:relative">' +
          [['#1c84ff', 'Quick Signal'], ['#f5b54a', 'Wheel'], ['#a78bfa', 'Dice'], ['#ef4444', 'Crash']].map(function (g) { return '<span style="flex:1;text-align:center;font-size:10px;font-weight:700;color:' + t.t3 + ';background:' + hexA(g[0], .12) + ';border:1px solid ' + hexA(g[0], .3) + ';border-radius:8px;padding:6px 4px">' + g[1] + '</span>'; }).join("") +
        '</div>' +
      '</button>';

    body.querySelectorAll(".et-house").forEach(function (c) { c.onclick = function () { openBetSheet(ov, houseById(c.dataset.house)); }; });
    var _goTop = body.querySelector("#et-go-top"); if (_goTop) _goTop.onclick = function () { if (window.dqEtLeaderboard) dqEtLeaderboard.open(); };
    var _goLg = body.querySelector("#et-go-leagues"); if (_goLg) _goLg.onclick = function () { if (window.dqLeagues) dqLeagues.open(); };
    var _goPick = body.querySelector("#et-go-pick"); if (_goPick) _goPick.onclick = function () { if (window.dqBabyPick) dqBabyPick.open(); };
    var resume = body.querySelector("#et-resume");
    if (resume) resume.onclick = function () {
      API("/easytrade/ticket/" + encodeURIComponent(ET.openTicketId)).then(function (r) {
        var tk = r && r.ticket; if (!tk) { ET.openTicketId = null; renderHome(ov); return; }
        ET.ticket = tk;
        if (tk.status === "pending") { renderTicket(ov); startPolling(ov, tk.id); }
        else renderResult(ov, tk);
      }).catch(function () {});
    };
  }

  // ── BET sheet ───────────────────────────────────────────────────────────────
  function openBetSheet(ov, house) {
    var t = TT();
    closeSheet();
    var stake = Math.max(ET.min, Math.min(100, balNum() || ET.min));
    var pick = null, busy = false;

    var scrim = document.createElement("div");
    scrim.className = "et-scrim"; scrim.id = "et-scrim";
    scrim.innerHTML =
      '<div class="et-sheet" id="et-sheet">' +
        '<div class="et-grab"></div>' +
        '<div style="display:flex;align-items:center;gap:11px;margin-bottom:6px">' +
          '<div class="et-mono" style="width:38px;height:38px;font-size:16px;margin:0;background:linear-gradient(135deg,' + house.accent + ',' + hexA(house.accent, .55) + ')">' + ESC((house.name || "?")[0]) + '</div>' +
          '<div style="flex:1;min-width:0"><div style="font-size:15px;font-weight:800;color:' + t.t1 + '">' + ESC(house.name) + '</div><div style="font-size:11px;color:' + t.t3 + '">' + ESC((house.products || []).join(" \u00b7 ")) + '</div></div>' +
          '<button class="et-ibtn" id="et-x" type="button">' + ICO('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 18) + '</button>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:' + t.t3 + ';margin:4px 2px 0"><span>Balance</span><span style="color:' + t.t1 + ';font-weight:700">' + fmtQ(ET.balance) + ' QNTM</span></div>' +
        '<div class="et-stakebox"><span class="et-stakeval" id="et-sv">' + fmtQ(stake) + '</span><span class="et-stakeq">QNTM</span></div>' +
        '<input class="et-slider" id="et-sl" type="range" min="0" max="1000" value="' + valToPos(stake) + '"/>' +
        '<div style="display:flex;justify-content:space-between;font-size:10px;color:' + t.t4 + ';margin-top:-2px"><span>' + fmtQ(ET.min) + '</span><span>' + fmtQ(ET.max) + '</span></div>' +
        '<div class="et-qp" id="et-qp">' +
          ['10', '100', '1K', '10K', '100K', 'MAX'].map(function (l) { return '<button class="et-qpb" data-qp="' + l + '" type="button">' + l + '</button>'; }).join("") +
        '</div>' +
        '<input class="et-inp" id="et-num" inputmode="numeric" value="' + stake + '" style="margin-top:8px"/>' +
        '<div style="font-size:11.5px;color:' + t.t3 + ';font-weight:700;margin:16px 2px 0;letter-spacing:.3px">YOUR PREDICTION</div>' +
        '<div class="et-pick" id="et-pick">' +
          '<button class="et-pk" data-pick="TP" type="button"><div class="pkt" style="color:' + GREEN + '">TP</div><div class="pks">Hits target</div></button>' +
          '<button class="et-pk" data-pick="SL" type="button"><div class="pkt" style="color:' + RED + '">SL</div><div class="pks">Hits stop</div></button>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin:14px 2px 0;font-size:12px"><span style="color:' + t.t3 + '">Potential payout</span><span id="et-payout" style="color:' + GREEN + ';font-weight:800;font-size:15px;text-shadow:0 0 12px ' + GREEN_G + '">' + fmtQ(stake * ET.payoutMult) + ' QNTM</span></div>' +
        '<div id="et-warn" style="font-size:11px;color:' + GOLD + ';margin:8px 2px 0;line-height:1.5;display:none"></div>' +
        '<button class="et-cta" id="et-place" type="button" disabled style="background:linear-gradient(135deg,' + t.pr + ',' + hexA(t.pr, .7) + ');box-shadow:0 8px 26px ' + hexA(t.pr, .4) + '">Choose TP or SL</button>' +
      '</div>';
    document.body.appendChild(scrim);

    var $ = function (id) { return scrim.querySelector(id); };
    var sv = $("#et-sv"), sl = $("#et-sl"), num = $("#et-num"), payout = $("#et-payout"), place = $("#et-place"), warn = $("#et-warn");

    function refresh() {
      stake = clampStake(stake);
      sv.textContent = fmtQ(stake);
      if (document.activeElement !== num) num.value = stake;
      sl.value = valToPos(stake);
      payout.textContent = fmtQ(stake * ET.payoutMult) + " QNTM";
      var problem = "";
      if (stake < ET.min) problem = "Minimum stake is " + fmtQ(ET.min) + " QNTM.";
      else if (stake > balNum()) problem = "That\u2019s more than your balance.";
      else if (stake > ET.max) problem = "Maximum stake is " + fmtQ(ET.max) + " QNTM.";
      warn.style.display = problem ? "block" : "none"; if (problem) warn.textContent = problem;
      place.disabled = busy || !!problem || !pick;
      place.textContent = busy ? "Placing\u2026" : (!pick ? "Choose TP or SL" : (problem ? "Adjust your stake" : ("Predict " + pick + " \u00b7 stake " + fmtQ(stake))));
    }

    sl.oninput = function () { stake = posToVal(Number(sl.value)); refresh(); };
    num.oninput = function () { stake = clampStake(num.value.replace(/[^\d]/g, "")); refresh(); };
    num.onblur = function () { refresh(); };
    $("#et-qp").querySelectorAll(".et-qpb").forEach(function (b) {
      b.onclick = function () { var m = { "10": 10, "100": 100, "1K": 1000, "10K": 10000, "100K": 100000, "MAX": Math.min(ET.max, balNum()) }; stake = clampStake(m[b.dataset.qp]); refresh(); };
    });
    $("#et-pick").querySelectorAll(".et-pk").forEach(function (b) {
      b.onclick = function () {
        pick = b.dataset.pick;
        scrim.querySelectorAll(".et-pk").forEach(function (x) {
          var on = x.dataset.pick === pick, col = pick === "TP" ? GREEN : RED, glow = pick === "TP" ? GREEN_G : RED_G;
          x.style.borderColor = on ? col : t.bd; x.style.background = on ? hexA(col, .12) : t.cd;
          x.style.boxShadow = on ? ("0 0 0 3px " + hexA(col, .15) + ",0 0 18px " + glow) : "none";
        });
        place.style.background = "linear-gradient(135deg," + (pick === "TP" ? GREEN : RED) + "," + hexA(pick === "TP" ? GREEN : RED, .7) + ")";
        place.style.boxShadow = "0 8px 26px " + (pick === "TP" ? GREEN_G : RED_G);
        refresh();
      };
    });
    $("#et-x").onclick = closeSheet;
    scrim.onclick = function (e) { if (e.target === scrim) closeSheet(); };
    place.onclick = function () {
      if (busy || !pick) return;
      busy = true; refresh();
      API("/easytrade/bet", { method: "POST", body: JSON.stringify({ houseId: house.id, stake: stake, pick: pick }) })
        .then(function (r) {
          closeSheet();
          ET.ticket = r && r.ticket;
          if (ET.ticket) ET.openTicketId = ET.ticket.id;
          ET._ms = {};
          loadMe().catch(function () {});           // balance now reflects the debit
          renderTicket(ov);
          if (ET.ticket) startPolling(ov, ET.ticket.id);
        })
        .catch(function (e) {
          busy = false; refresh();
          warn.style.display = "block";
          warn.textContent = (e && (e.error || e.message)) || "Could not place your prediction.";
        });
    };
    refresh();
  }
  function closeSheet() { var s = document.getElementById("et-scrim"); if (s) s.remove(); }

  // ── polling ──────────────────────────────────────────────────────────────
  function stopPolling() { if (ET.poll) { clearInterval(ET.poll); ET.poll = null; } }
  function startPolling(ov, ticketId) {
    stopPolling();
    var settledSeen = false;
    ET.poll = setInterval(function () {
      if (!document.getElementById("et-ov")) { stopPolling(); return; }
      API("/easytrade/ticket/" + encodeURIComponent(ticketId)).then(function (r) {
        var tk = r && r.ticket; if (!tk) return;
        ET.ticket = tk;
        try { checkMilestones(ov, tk); } catch (e) {}
        if (tk.status === "pending") { if (ET.view === "ticket") renderTicket(ov); return; }
        if (!settledSeen) {
          settledSeen = true; stopPolling(); ET.openTicketId = null;
          loadMe().then(function () { if (ET.view === "ticket") renderResult(ov, tk); }).catch(function () { if (ET.view === "ticket") renderResult(ov, tk); });
        }
      }).catch(function () {});
    }, 2000);
  }

  // ── waiting / live ticket view (with chart once a round exists) ─────────────
  function renderTicket(ov) {
    ET.view = "ticket";
    setBoltLive(true);
    var t = TT(); var tk = ET.ticket; if (!tk) { renderHome(ov); return; }
    var body = ov.querySelector("#et-body"); if (!body) return;
    var house = houseById(tk.houseId);
    var pickCol = tk.pick === "TP" ? GREEN : RED, pickGlow = tk.pick === "TP" ? GREEN_G : RED_G;
    var round = tk.round;

    var live = "";
    if (round) {
      var up = round.direction === "long";
      live =
        '<div style="margin:18px 0 4px;border:1px solid ' + t.bd + ';border-radius:14px;background:' + t.cd + ';padding:14px">' +
          '<div style="display:flex;align-items:center;gap:9px;margin-bottom:10px">' +
            '<span style="font-size:11px;font-weight:800;color:#fff;background:' + (up ? GREEN : RED) + ';padding:3px 9px;border-radius:7px;letter-spacing:.5px">' + (up ? "LONG" : "SHORT") + '</span>' +
            '<span style="font-size:16px;font-weight:800;color:' + t.t1 + ';font-family:ui-monospace,monospace">' + ESC(round.symbol || "") + '</span>' +
            '<span style="flex:1"></span>' +
            '<span class="et-badge" style="color:' + t.t3 + ';background:' + t.inp + '"><span style="width:9px;height:9px;border:2px solid ' + t.t3 + ';border-top-color:transparent;border-radius:50%;display:inline-block;animation:etSpin .7s linear infinite"></span>In progress</span>' +
          '</div>' +
          chartSVG(round, tk.ticks, tk.pick) +
          progressBar(round, tk.pick) +
          '<div style="font-size:11.5px;color:' + t.t4 + ';margin-top:9px;line-height:1.5">Tracking price toward the <b style="color:' + GREEN + '">target</b> and the <b style="color:' + RED + '">stop</b>\u2026</div>' +
        '</div>';
    }

    body.innerHTML =
      '<div style="text-align:center;padding:10px 0 0">' +
        '<div class="et-radar"><div class="ring"></div><div class="ring ring2"></div>' +
          '<div style="width:62px;height:62px;border-radius:50%;background:' + hexA(house.accent, .16) + ';border:1px solid ' + hexA(house.accent, .4) + ';display:flex;align-items:center;justify-content:center;color:' + house.accent + '">' + ICO('<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>', 26) + '</div>' +
        '</div>' +
        '<div style="font-size:17px;font-weight:800;color:' + t.t1 + '">' + (round ? "Signal live" : "Waiting for next signal") + '</div>' +
        '<div style="font-size:12.5px;color:' + t.t3 + ';margin-top:3px">from <b style="color:' + house.accent + '">' + ESC(house.name) + '</b></div>' +
      '</div>' +
      live +
      '<div style="display:flex;gap:11px;margin-top:18px">' +
        '<div style="flex:1;border:1px solid ' + t.bd + ';border-radius:13px;background:' + t.cd + ';padding:12px;text-align:center"><div style="font-size:10px;letter-spacing:.6px;color:' + t.t4 + ';text-transform:uppercase;font-weight:800">Your pick</div><div style="font-size:22px;font-weight:900;color:' + pickCol + ';text-shadow:0 0 14px ' + pickGlow + ';margin-top:3px">' + tk.pick + '</div></div>' +
        '<div style="flex:1;border:1px solid ' + t.bd + ';border-radius:13px;background:' + t.cd + ';padding:12px;text-align:center"><div style="font-size:10px;letter-spacing:.6px;color:' + t.t4 + ';text-transform:uppercase;font-weight:800">Staked</div><div style="font-size:22px;font-weight:900;color:' + t.t1 + ';margin-top:3px">' + fmtQ(tk.stake) + '</div></div>' +
        '<div style="flex:1;border:1px solid ' + t.bd + ';border-radius:13px;background:' + t.cd + ';padding:12px;text-align:center"><div style="font-size:10px;letter-spacing:.6px;color:' + t.t4 + ';text-transform:uppercase;font-weight:800">To win</div><div style="font-size:22px;font-weight:900;color:' + GREEN + ';margin-top:3px">' + fmtQ(Number(tk.stake) * ET.payoutMult) + '</div></div>' +
      '</div>' +
      (round ? "" : '<div style="text-align:center;margin-top:16px"><button id="et-cancel" type="button" style="background:none;border:none;color:' + t.t4 + ';font-size:12px;text-decoration:underline;cursor:pointer;font-family:inherit">Cancel & refund (no signal yet)</button></div>') +
      '<div style="text-align:center;font-size:11px;color:' + t.t4 + ';margin-top:16px;line-height:1.6">Your stake is locked until this round settles.<br>You\u2019ll be paid automatically if your prediction is correct.</div>';

    var cancel = body.querySelector("#et-cancel");
    if (cancel) cancel.onclick = function () {
      cancel.disabled = true; cancel.textContent = "Cancelling\u2026";
      API("/easytrade/ticket/" + encodeURIComponent(tk.id) + "/cancel", { method: "POST" })
        .then(function () { stopPolling(); ET.ticket = null; ET.openTicketId = null; toast("Refunded", "Your stake was returned."); return loadMe(); })
        .then(function () { renderHome(ov); })
        .catch(function (e) { cancel.disabled = false; cancel.textContent = "Cancel & refund (no signal yet)"; toast("Couldn\u2019t cancel", (e && (e.error || e.message)) || "The round may have already started."); });
    };
  }

  // ── result view ────────────────────────────────────────────────────────────
  function renderResult(ov, tk) {
    ET.view = "result";
    setBoltLive(false);
    var t = TT(); var body = ov.querySelector("#et-body"); if (!body) return;
    var house = houseById(tk.houseId);
    var round = tk.round || {};
    if (tk.status === "refunded") {
      body.innerHTML =
        '<div style="text-align:center;padding:40px 0 10px"><div style="font-size:40px">\u21A9\uFE0F</div>' +
        '<div style="font-size:18px;font-weight:800;color:' + t.t1 + ';margin-top:8px">Round cancelled</div>' +
        '<div style="font-size:13px;color:' + t.t3 + ';margin-top:4px">No signal arrived in time \u2014 your ' + fmtQ(tk.stake) + ' QNTM stake was refunded.</div></div>' +
        '<button class="et-cta" id="et-home" type="button" style="background:linear-gradient(135deg,' + t.pr + ',' + hexA(t.pr, .7) + ')">Back to houses</button>';
      body.querySelector("#et-home").onclick = function () { ET.ticket = null; renderHome(ov); };
      return;
    }
    var outcome = round.outcome || (tk.status === "won" ? tk.pick : (tk.pick === "TP" ? "SL" : "TP"));
    var won = tk.status === "won";
    var col = won ? GREEN : RED, glow = won ? GREEN_G : RED_G;
    var outCol = outcome === "TP" ? GREEN : RED;
    var payout = Number(tk.payout) || (Number(tk.stake) * ET.payoutMult);

    // Did the price ACTUALLY reach the settling level, or did the round time out
    // near entry (the autopilot max-age fallback)? Ticks are the same samples the
    // settler saw, so this agrees with how it settled: a real cross shows up in a
    // sample; a timeout does not. Keeps the verdict text honest against the chart.
    var reached = (function () {
      var entry = num(round.entry); if (entry == null) return true;
      var lvl = outcome === "TP" ? num(round.tp3) : num(round.sl);
      if (lvl == null) return true;
      var long = round.direction === "long";
      var ps = (tk.ticks || []).map(function (x) { return num(x.price); }).filter(function (p) { return p != null; });
      if (!ps.length) return true;
      var mn = Math.min.apply(null, ps), mx = Math.max.apply(null, ps);
      if (outcome === "TP") return long ? mx >= lvl : mn <= lvl;
      return long ? mn <= lvl : mx >= lvl;
    })();

    body.innerHTML =
      '<div style="text-align:center;padding:16px 0 6px">' +
        '<div style="font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:' + t.t3 + '">' + ESC(house.name) + (round.symbol ? ' \u00b7 ' + ESC(round.symbol) : '') + '</div>' +
        '<div class="et-stamp" style="color:' + outCol + ';text-shadow:0 0 30px ' + (outcome === "TP" ? GREEN_G : RED_G) + '">' + outcome + '</div>' +
        '<div style="font-size:13px;color:' + t.t3 + '">' + (reached ? ('the signal hit its ' + (outcome === "TP" ? "target" : "stop")) : 'the round closed near entry') + '</div>' +
      '</div>' +
      (round && (round.entry != null) ? '<div style="margin:6px 0 2px;border:1px solid ' + t.bd + ';border-radius:14px;background:' + t.cd + ';padding:12px">' + chartSVG(round, tk.ticks, tk.pick) + '</div>' : '') +
      '<div style="margin:14px auto 0;max-width:340px;border:1.5px solid ' + hexA(col, .5) + ';border-radius:18px;background:' + hexA(col, .08) + ';padding:20px;text-align:center;box-shadow:0 0 30px ' + hexA(col, .18) + ';animation:etPop .5s cubic-bezier(.2,1.2,.3,1)">' +
        (won ? ('<div style="display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:900;letter-spacing:1px;text-transform:uppercase;color:' + GREEN + ';background:' + hexA(GREEN, .14) + ';border:1px solid ' + hexA(GREEN, .4) + ';border-radius:999px;padding:4px 11px;margin-bottom:10px">' + (outcome === "TP" && reached ? "\uD83C\uDFAF All targets hit \u00b7 100%" : (outcome === "SL" ? "Stop hit \u2014 you called it" : "Closed in profit")) + '</div>') : '') +
        '<div style="font-size:15px;font-weight:800;color:' + col + '">' + (won ? (outcome === "TP" && reached ? "\uD83C\uDFC6 Perfect call!" : "\uD83C\uDFC6 You called it!") : "Not this time") + '</div>' +
        '<div style="font-size:40px;font-weight:900;color:' + col + ';letter-spacing:-1px;margin:6px 0;text-shadow:0 0 22px ' + glow + '">' + (won ? "+" + fmtQ(payout) : "\u2212" + fmtQ(tk.stake)) + '</div>' +
        '<div style="font-size:12px;color:' + t.t3 + '">' + (won
          ? ("You called " + tk.pick + " and nailed it! Your " + fmtQ(tk.stake) + " stake came back as " + fmtQ(payout) + " QNTM (a " + fmtQ(payout - Number(tk.stake)) + " profit).")
          : ("You predicted " + tk.pick + ". Your " + fmtQ(tk.stake) + " QNTM stake went to the reward pool.")) + '</div>' +
      '</div>' +
      '<div class="et-stats" style="margin-top:18px">' +
        '<div class="et-stat"><div class="lab" style="color:' + t.pr + '">Your Wallet</div><div class="val">' + fmtQ(ET.balance) + '<span class="q" style="color:' + t.pr + '">QNTM</span></div></div>' +
        '<div class="et-stat"><div class="lab" style="color:' + GOLD + '">Reward Pool</div><div class="val">' + fmtQ(ET.pool) + '<span class="q" style="color:' + GOLD + '">QNTM</span></div></div>' +
      '</div>' +
      '<button class="et-cta" id="et-again" type="button" style="background:linear-gradient(135deg,' + house.accent + ',' + hexA(house.accent, .7) + ');box-shadow:0 8px 26px ' + hexA(house.accent, .4) + '">Predict again</button>' +
      '<button class="et-cta" id="et-home" type="button" style="background:' + t.btn + ';color:' + t.t2 + ';box-shadow:none;margin-top:9px">Back to houses</button>';

    body.querySelector("#et-again").onclick = function () { ET.ticket = null; renderHome(ov); openBetSheet(ov, house); };
    body.querySelector("#et-home").onclick = function () { ET.ticket = null; renderHome(ov); };
    if (won) { try { confettiBurst(); } catch (e) {} }
  }

  // ── history (my predictions) ───────────────────────────────────────────────
  function relTime(ts) {
    if (!ts) return "";
    var d = new Date(ts); if (isNaN(d.getTime())) return "";
    var s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 604800) return Math.floor(s / 86400) + "d ago";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  function historyRow(it) {
    var t = TT();
    var house = houseById(it.houseId);
    var pickCol = it.pick === "TP" ? GREEN : RED;
    var amount, amtCol, sub;
    if (it.status === "won") { amount = "+" + fmtQ(it.payout); amtCol = GREEN; sub = "Won"; }
    else if (it.status === "lost") { amount = "\u2212" + fmtQ(it.stake); amtCol = RED; sub = "Lost"; }
    else if (it.status === "refunded") { amount = "\u00b1" + fmtQ(it.stake); amtCol = t.t3; sub = "Refunded"; }
    else { amount = fmtQ(it.stake); amtCol = t.pr; sub = "Live"; }
    return '<div style="display:flex;align-items:center;gap:11px;padding:12px 13px;border:1px solid ' + t.bd + ';border-radius:13px;background:' + t.cd + ';margin-bottom:9px">' +
      '<div class="et-mono" style="width:36px;height:36px;font-size:15px;margin:0;background:linear-gradient(135deg,' + house.accent + ',' + hexA(house.accent, .55) + ')">' + ESC((house.name || "?")[0]) + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:7px">' +
          '<span style="font-size:13.5px;font-weight:800;color:' + t.t1 + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + ESC(it.symbol || house.name) + '</span>' +
          '<span style="font-size:10px;font-weight:800;color:' + pickCol + ';border:1px solid ' + hexA(pickCol, .4) + ';border-radius:6px;padding:1px 5px;flex-shrink:0">' + ESC(it.pick) + '</span>' +
        '</div>' +
        '<div style="font-size:10.5px;color:' + t.t4 + ';margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + ESC(house.name) + ' \u00b7 ' + relTime(it.settledAt || it.createdAt) + (it.outcome ? (' \u00b7 hit ' + ESC(it.outcome)) : "") + '</div>' +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0">' +
        '<div style="font-size:15px;font-weight:900;color:' + amtCol + '">' + amount + '</div>' +
        '<div style="font-size:9px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:' + amtCol + ';opacity:.85">' + sub + '</div>' +
      '</div>' +
    '</div>';
  }
  function renderHistory(ov) {
    ET.view = "history";
    setBoltLive(!!ET.openTicketId);
    var t = TT();
    var body = ov.querySelector("#et-body"); if (!body) return;
    body.innerHTML = '<div style="display:flex;justify-content:center;padding:50px 0"><div style="width:24px;height:24px;border:3px solid ' + t.bd + ';border-top-color:' + t.pr + ';border-radius:50%;animation:etSpin .8s linear infinite"></div></div>';
    API("/easytrade/history").then(function (r) {
      if (ET.view !== "history" || !document.getElementById("et-ov")) return;
      var s = (r && r.summary) || {}, items = (r && r.items) || [];
      var net = Number(s.net) || 0;
      var netCol = net > 0 ? GREEN : net < 0 ? RED : t.t2;
      var netStr = (net > 0 ? "+" : net < 0 ? "\u2212" : "") + fmtQ(Math.abs(net));
      var summary =
        '<div class="et-stats" style="margin-bottom:14px">' +
          '<div class="et-stat"><div class="lab" style="color:' + t.t3 + '">Settled</div><div class="val">' + (s.settled || 0) + '</div></div>' +
          '<div class="et-stat"><div class="lab" style="color:' + GOLD + '">Win rate</div><div class="val">' + (s.winRate == null ? "\u2014" : (s.winRate + '<span class="q" style="color:' + GOLD + '">%</span>')) + '</div></div>' +
          '<div class="et-stat"><div class="lab" style="color:' + netCol + '">Net P/L</div><div class="val" style="color:' + netCol + '">' + netStr + '<span class="q" style="color:' + netCol + '">QNTM</span></div></div>' +
        '</div>';
      var list = items.length
        ? items.map(historyRow).join("")
        : '<div style="text-align:center;padding:46px 20px;color:' + t.t4 + '"><div style="display:flex;justify-content:center">' + ICO('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>', 30) + '</div><div style="font-size:14px;font-weight:700;color:' + t.t2 + ';margin-top:10px">No predictions yet</div><div style="font-size:12px;margin-top:4px">Your past predictions will appear here.</div></div>';
      body.innerHTML =
        '<div class="et-h" style="margin-top:2px">' + ICO('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>', 16) + 'My predictions</div>' +
        summary +
        (s.open ? '<div style="font-size:11px;color:' + t.pr + ';margin:-4px 2px 12px;font-weight:700">\u25cf ' + s.open + ' live right now</div>' : "") +
        list +
        '<button class="et-cta" id="et-h-home" type="button" style="background:' + t.btn + ';color:' + t.t2 + ';box-shadow:none;margin-top:14px">Back to houses</button>';
      body.querySelector("#et-h-home").onclick = function () { renderHome(ov); };
    }).catch(function () {
      if (ET.view !== "history" || !document.getElementById("et-ov")) return;
      body.innerHTML =
        '<div style="text-align:center;padding:54px 24px">' +
          '<div style="color:' + RED + ';display:flex;justify-content:center;margin-bottom:10px">' + ICO('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', 28) + '</div>' +
          '<div style="font-size:14.5px;font-weight:700;color:' + t.t1 + '">Couldn\u2019t load your history</div>' +
          '<button class="et-cta" id="et-h-retry" type="button" style="background:linear-gradient(135deg,' + t.pr + ',' + hexA(t.pr, .7) + ');max-width:200px;margin:16px auto 0">Retry</button>' +
          '<button class="et-cta" id="et-h-home2" type="button" style="background:' + t.btn + ';color:' + t.t2 + ';box-shadow:none;margin:9px auto 0;max-width:200px">Back to houses</button>' +
        '</div>';
      body.querySelector("#et-h-retry").onclick = function () { renderHistory(ov); };
      body.querySelector("#et-h-home2").onclick = function () { renderHome(ov); };
    });
  }

  // ── milestone progress + celebratory cards ─────────────────────────────────
  function tpProgress(round, pick) {
    var entry = num(round.entry);
    var lp = num(round.lastPrice != null ? round.lastPrice : round.entry);
    if (entry == null || lp == null) return 0;
    var long = round.direction === "long";
    var target = pick === "SL" ? num(round.sl) : num(round.tp3);
    if (target == null || target === entry) return 0;
    var prog = pick === "SL"
      ? (long ? (entry - lp) / (entry - target) : (lp - entry) / (target - entry))
      : (long ? (lp - entry) / (target - entry) : (entry - lp) / (entry - target));
    return Math.max(0, Math.min(100, prog * 100));
  }
  function progressBar(round, pick) {
    var t = TT();
    var prog = tpProgress(round, pick);
    var pcol = pick === "SL" ? GOLD : GREEN;
    var label = pick === "SL" ? "Progress to your target (SL)" : "Progress to target";
    return '<div style="margin-top:11px">' +
      '<div style="display:flex;justify-content:space-between;font-size:10px;color:' + t.t4 + ';margin-bottom:5px"><span>' + label + '</span><span style="color:' + pcol + ';font-weight:800">' + Math.round(prog) + '%</span></div>' +
      '<div style="height:7px;border-radius:5px;background:' + t.inp + ';overflow:hidden"><div style="height:100%;width:' + prog + '%;border-radius:5px;background:linear-gradient(90deg,' + hexA(pcol, .6) + ',' + pcol + ');box-shadow:0 0 10px ' + hexA(pcol, .5) + ';transition:width .6s ease"></div></div>' +
    '</div>';
  }
  function progressRing(pct, color) {
    var r = 18, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
    return '<svg width="46" height="46" viewBox="0 0 46 46" style="flex-shrink:0">' +
      '<circle cx="23" cy="23" r="' + r + '" fill="none" stroke="' + hexA(color, .18) + '" stroke-width="4"/>' +
      '<circle cx="23" cy="23" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="4" stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" transform="rotate(-90 23 23)"/>' +
      '<text x="23" y="27" text-anchor="middle" font-size="12" font-weight="800" fill="' + color + '" font-family="Outfit,sans-serif">' + Math.round(pct) + '%</text>' +
    '</svg>';
  }
  function pickLine(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function MS_TP1() { return { pct: 33, color: GREEN, emoji: "\uD83C\uDFAF", title: "Target 1 hit!", line: pickLine(["You\u2019re 33% of the way \u2014 momentum\u2019s on your side!", "First target smashed! The win is heating up.", "Great start \u2014 33% locked in, keep riding it!"]) }; }
  function MS_TP2() { return { pct: 66, color: GREEN, emoji: "\uD83D\uDD25", title: "Target 2 hit!", line: pickLine(["66% there \u2014 you can almost taste the win!", "On fire! Two targets down, one to go.", "So close \u2014 66% done, hold the line!"]) }; }
  function MS_SL50() { return { pct: 50, color: GOLD, emoji: "\uD83D\uDE80", title: "Halfway to victory!", line: pickLine(["Only 50% left until your win \u2014 stay locked in!", "You\u2019re 50% there and climbing \u2014 victory is near!", "Halfway home! 50% to go for the win."]) }; }
  function etMilestoneToast(opts) {
    try {
      var t = TT();
      var ex = document.getElementById("et-ms"); if (ex) ex.remove();
      var ttl = opts.ttl || 3800;
      var wrap = document.createElement("div");
      wrap.id = "et-ms";
      wrap.style.cssText = "position:fixed;top:calc(12px + var(--sat));left:50%;transform:translateX(-50%);z-index:5400;width:calc(100% - 26px);max-width:440px";
      wrap.innerHTML =
        '<div style="display:flex;align-items:center;gap:13px;padding:13px 15px;border-radius:18px;background:linear-gradient(135deg,' + hexA(opts.color, .24) + ',' + hexA(opts.color, .07) + '),' + t.ch + ';border:1px solid ' + hexA(opts.color, .55) + ';box-shadow:0 16px 44px ' + hexA(opts.color, .32) + ';-webkit-backdrop-filter:blur(20px) saturate(160%);backdrop-filter:blur(20px) saturate(160%);animation:etMsIn .5s cubic-bezier(.2,1.2,.3,1)">' +
          progressRing(opts.pct, opts.color) +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:15px;font-weight:900;color:' + opts.color + ';letter-spacing:.2px">' + opts.emoji + ' ' + ESC(opts.title) + '</div>' +
            '<div style="font-size:12px;color:' + t.t2 + ';margin-top:2px;line-height:1.4">' + ESC(opts.line) + '</div>' +
          '</div>' +
        '</div>' +
        '<div style="height:3px;border-radius:3px;margin:5px 14px 0;transform-origin:left;background:' + opts.color + ';animation:etMsBar ' + ttl + 'ms linear forwards"></div>';
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
  function checkMilestones(ov, tk) {
    if (ET.view !== "ticket") return;
    if (!tk || !tk.round || tk.status !== "pending") return;
    var r = tk.round, lp = num(r.lastPrice), entry = num(r.entry);
    if (lp == null || entry == null) return;
    var long = r.direction === "long";
    ET._ms = ET._ms || {};
    var seen = ET._ms[r.id] || (ET._ms[r.id] = {});
    if (tk.pick === "TP") {
      var hit = function (L) { L = num(L); return L != null && (long ? lp >= L : lp <= L); };
      if (hit(r.tp1) && !seen.t1) { seen.t1 = 1; etMilestoneToast(MS_TP1()); }
      if (hit(r.tp2) && !seen.t2) { seen.t2 = 1; etMilestoneToast(MS_TP2()); }
    } else {
      var sl = num(r.sl);
      if (sl != null && sl !== entry) {
        var prog = long ? (entry - lp) / (entry - sl) : (lp - entry) / (sl - entry);
        if (prog >= 0.5 && !seen.s50) { seen.s50 = 1; etMilestoneToast(MS_SL50()); }
      }
    }
  }
  function confettiBurst() {
    try {
      var ov = document.getElementById("et-ov"); if (!ov) return;
      var colors = [GREEN, GOLD, "#1c84ff", "#ec4899", "#ffffff"];
      var layer = document.createElement("div");
      layer.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:60";
      for (var i = 0; i < 48; i++) {
        var s = document.createElement("span");
        var c = colors[i % colors.length];
        var left = Math.random() * 100, delay = Math.random() * 0.45, dur = 1.5 + Math.random() * 1.3, w = 6 + Math.random() * 7, rot = Math.random() * 360;
        s.style.cssText = "position:absolute;top:-14px;left:" + left + "%;width:" + w + "px;height:" + (w * 0.55) + "px;background:" + c + ";opacity:.95;border-radius:2px;transform:rotate(" + rot + "deg);animation:etConf " + dur + "s " + delay + "s cubic-bezier(.25,.6,.4,1) forwards";
        layer.appendChild(s);
      }
      ov.appendChild(layer);
      setTimeout(function () { if (layer.parentNode) layer.remove(); }, 3400);
    } catch (e) {}
  }

  // ── per-house animated mini-chart (the glow area in each card's top-right) ──
  // Deterministic from the house id so each card is distinct but stable across
  // renders; tinted to the house accent; trend slope nudged by win-rate. Three
  // styles (area / candles / bars) rotate by seed. Pure SVG + CSS animation.
  function houseSeed(id) { var s = 0, str = String(id || "x"); for (var i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) >>> 0; return s; }
  function houseChart(h, t) {
    var W = 96, H = 46, seed = houseSeed(h.id);
    var rnd = (function () { var x = seed || 1; return function () { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; })();
    var accent = h.accent || t.pr;
    var style = seed % 3; // 0 area-line, 1 candles, 2 bars
    var up = (h.win == null ? 60 : h.win) >= 50;
    var trend = ((h.win == null ? 60 : h.win) - 50) / 50; // -1..1 slope bias
    var uid = "etg" + (seed % 100000);
    var N = 24, pts = [], v = 0.5;
    for (var i = 0; i < N; i++) {
      v += (rnd() - 0.5) * 0.34 + trend * 0.05;
      if (v < 0.08) v = 0.08 + rnd() * 0.1; if (v > 0.92) v = 0.92 - rnd() * 0.1;
      pts.push(v);
    }
    var xF = function (i) { return (i / (N - 1)) * W; };
    var yF = function (val) { return H - 4 - val * (H - 9); };
    var grad = '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="' + hexA(accent, .42) + '"/><stop offset="1" stop-color="' + hexA(accent, 0) + '"/></linearGradient>' +
      '<linearGradient id="' + uid + 'l" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0" stop-color="' + hexA(accent, .5) + '"/><stop offset="1" stop-color="' + accent + '"/></linearGradient></defs>';
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + grad;

    if (style === 1) {
      // candlesticks
      var step = W / 7, cw = step * 0.46;
      for (var c = 0; c < 7; c++) {
        var a = pts[c * 3] != null ? pts[c * 3] : 0.5, b = pts[c * 3 + 2] != null ? pts[c * 3 + 2] : a;
        var hi = Math.max(a, b) + 0.08 + rnd() * 0.06, loo = Math.min(a, b) - 0.08 - rnd() * 0.06;
        var bull = b >= a, col = bull ? accent : hexA(accent, .45);
        var cx = step * c + step / 2;
        var oY = yF(a), cY = yF(b), hY = yF(Math.min(1, hi)), lY = yF(Math.max(0, loo));
        var top = Math.min(oY, cY), bh = Math.max(3, Math.abs(cY - oY));
        svg += '<line class="etwk" x1="' + cx.toFixed(1) + '" y1="' + hY.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y2="' + lY.toFixed(1) + '" stroke="' + col + '" stroke-width="1" style="animation-delay:' + (c * 0.07).toFixed(2) + 's"/>';
        svg += '<rect class="etbar" x="' + (cx - cw / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + cw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="1" fill="' + col + '" style="animation-delay:' + (c * 0.07).toFixed(2) + 's"/>';
      }
    } else if (style === 2) {
      // bars
      var bn = 11, bw = W / bn * 0.62, gap = W / bn;
      for (var k = 0; k < bn; k++) {
        var bv = pts[k * 2] != null ? pts[k * 2] : 0.5;
        var bx = gap * k + (gap - bw) / 2, by = yF(bv), bhh = H - 3 - by;
        svg += '<rect class="etbar" x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(2, bhh).toFixed(1) + '" rx="1.5" fill="url(#' + uid + 'l)" style="animation-delay:' + (k * 0.05).toFixed(2) + 's"/>';
      }
      var ly2 = yF(pts[bn * 2 - 2] != null ? pts[bn * 2 - 2] : 0.6);
      svg += '<circle class="etdot" cx="' + (W - 3) + '" cy="' + ly2.toFixed(1) + '" r="3" fill="' + accent + '"/>';
    } else {
      // area + line (glossy, like the live BTC chart)
      var dLine = pts.map(function (p, i) { return (i ? "L" : "M") + xF(i).toFixed(1) + " " + yF(p).toFixed(1); }).join(" ");
      var dArea = dLine + " L" + W + " " + H + " L0 " + H + " Z";
      svg += '<path class="etsh" d="' + dArea + '" fill="url(#' + uid + ')"/>';
      svg += '<path class="etln" d="' + dLine + '" fill="none" stroke="url(#' + uid + 'l)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" style="filter:drop-shadow(0 0 3px ' + hexA(accent, .7) + ')"/>';
      var lx = xF(N - 1), lyy = yF(pts[N - 1]);
      svg += '<circle class="etrun" r="2.5" fill="#fff"><animateMotion dur="2.6s" repeatCount="indefinite" path="' + dLine + '"/></circle>';
      svg += '<circle class="etdot" cx="' + lx.toFixed(1) + '" cy="' + lyy.toFixed(1) + '" r="3" fill="' + accent + '" style="filter:drop-shadow(0 0 5px ' + accent + ')"/>';
    }
    svg += '</svg>';
    return '<div class="et-spark">' + svg + '</div>';
  }

  // ── signal chart (SVG): entry + SL/TP levels + price path ──────────────────
  function chartSVG(round, ticks, pick) {
    var t = TT();
    var W = 320, H = 168, padT = 12, padB = 16, padL = 6, padR = 60;
    var lv = [
      { v: num(round.sl), c: RED, label: "SL" },
      { v: num(round.tp1), c: hexA(GREEN, .55), label: "TP1" },
      { v: num(round.tp2), c: hexA(GREEN, .8), label: "TP2" },
      { v: num(round.tp3), c: GREEN, label: "TP3" },
      { v: num(round.entry), c: t.t3, label: "Entry" }
    ].filter(function (x) { return x.v != null; });

    var prices = [];
    (ticks || []).forEach(function (tk) { var p = num(tk.price); if (p != null) prices.push(p); });
    if (!prices.length && num(round.entry) != null) prices.push(num(round.entry));
    if (num(round.last_price) != null) prices.push(num(round.last_price));

    var all = lv.map(function (x) { return x.v; }).concat(prices);
    if (!all.length) return '<div style="text-align:center;color:' + t.t4 + ';font-size:11.5px;padding:18px 0">Waiting for price\u2026</div>';
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    if (hi === lo) { hi += 1; lo -= 1; }
    var pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    var yFor = function (v) { return padT + (hi - v) / (hi - lo) * (H - padT - padB); };
    var n = Math.max(prices.length, 1);
    var xFor = function (i) { return padL + (n === 1 ? 0.5 : i / (n - 1)) * (W - padL - padR); };

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;width:100%;height:auto;max-width:100%">';
    // level lines + labels
    lv.forEach(function (x) {
      var y = yFor(x.v).toFixed(1);
      svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="' + x.c + '" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>';
      svg += '<text x="' + (W - padR + 4) + '" y="' + (Number(y) + 3.5) + '" fill="' + x.c + '" font-size="9" font-family="ui-monospace,monospace" font-weight="700">' + x.label + '</text>';
    });
    // price path
    if (prices.length > 1) {
      var d = prices.map(function (p, i) { return (i ? "L" : "M") + xFor(i).toFixed(1) + " " + yFor(p).toFixed(1); }).join(" ");
      var pcol = pick === "SL" ? RED : t.pr;
      svg += '<path d="' + d + '" fill="none" stroke="' + pcol + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
      // last dot
      var lx = xFor(prices.length - 1).toFixed(1), ly = yFor(prices[prices.length - 1]).toFixed(1);
      svg += '<circle cx="' + lx + '" cy="' + ly + '" r="3.5" fill="' + pcol + '"/><circle cx="' + lx + '" cy="' + ly + '" r="7" fill="' + hexA(pcol, .25) + '"/>';
    } else {
      var ex = xFor(0).toFixed(1), ey = yFor(prices[0]).toFixed(1);
      svg += '<circle cx="' + ex + '" cy="' + ey + '" r="4" fill="' + t.pr + '"/>';
    }
    svg += '</svg>';
    return svg;
  }

  function hexA(hex, a) {
    hex = String(hex || "#1c84ff").replace("#", "");
    if (hex.length === 3) hex = hex.split("").map(function (c) { return c + c; }).join("");
    var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }
  function num(v) { if (v == null || v === "" || v === "null") return null; var n = Number(v); return isFinite(n) ? n : null; }

  // ── rules sheet ────────────────────────────────────────────────────────────
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
        step(2, 'Stake QNTM from your wallet \u2014 it\u2019s held until the round settles.') +
        step(3, 'Predict the next signal\u2019s outcome: <b style="color:' + GREEN + '">TP</b> (hits target) or <b style="color:' + RED + '">SL</b> (hits stop).') +
        step(4, 'The house\u2019s indicator fires a <b style="color:' + t.t1 + '">long/short entry</b>, then reaches its <b style="color:' + GREEN + '">target</b> or <b style="color:' + RED + '">stop</b> \u2014 you watch it live on the chart.') +
        step(5, 'Right prediction \u2192 <b style="color:' + GREEN + '">2\u00d7 your stake</b>. Wrong \u2192 your stake joins the <b style="color:' + GOLD + '">reward pool</b>.') +
        '<div style="font-size:11px;color:' + t.t4 + ';line-height:1.6;background:' + t.inp + ';border:1px solid ' + t.bd + ';border-radius:11px;padding:11px;margin-top:6px">Predictions carry real risk of total loss of your stake. Easy Trade is a game of chance on market outcomes \u2014 it is not investment advice. Availability may be restricted in your region.</div>' +
        '<button class="et-cta" id="et-rx" type="button" style="background:linear-gradient(135deg,' + t.pr + ',' + hexA(t.pr, .7) + ')">Got it</button>' +
      '</div>';
    document.body.appendChild(scrim);
    scrim.querySelector("#et-rx").onclick = closeSheet;
    scrim.onclick = function (e) { if (e.target === scrim) closeSheet(); };
  }

  function errorState(ov, retry) {
    var t = TT(); var body = ov.querySelector("#et-body"); if (!body) return;
    body.innerHTML = '<div style="text-align:center;padding:60px 24px">' +
      '<div style="color:' + RED + ';display:flex;justify-content:center;margin-bottom:12px">' + ICO('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', 30) + '</div>' +
      '<div style="font-size:15px;font-weight:700;color:' + t.t1 + '">Easy Trade isn\u2019t reachable</div>' +
      '<div style="font-size:12.5px;color:' + t.t3 + ';margin-top:6px;line-height:1.5">Couldn\u2019t load your wallet and houses. Check your connection and try again.</div>' +
      '<button class="et-cta" id="et-retry" type="button" style="background:linear-gradient(135deg,' + t.pr + ',' + hexA(t.pr, .7) + ');max-width:200px;margin:18px auto 0">Retry</button></div>';
    body.querySelector("#et-retry").onclick = retry;
  }

  // ── overlay shell + open ────────────────────────────────────────────────────
  function open() {
    injectCSS();
    var t = TT();
    var prev = document.getElementById("et-ov"); if (prev) prev.remove();
    stopPolling();

    var ov = document.createElement("div"); ov.id = "et-ov";
    ov.innerHTML =
      '<div class="et-amb" style="top:-70px;right:-50px;width:230px;height:230px;background:radial-gradient(circle,' + hexA(t.pr, .5) + ',transparent 70%)"></div>' +
      '<div class="et-amb" style="bottom:-80px;left:-60px;width:230px;height:230px;background:radial-gradient(circle,' + GOLD_G + ',transparent 72%);opacity:.3"></div>' +
      '<div class="et-hd">' +
        '<button class="et-ibtn" id="et-back" type="button">' + ICO('<polyline points="15 18 9 12 15 6"/>', 18) + '</button>' +
        '<div style="display:flex;align-items:center;gap:9px;flex:1;min-width:0">' +
          '<span class="et-bolt" id="et-bolt" style="color:' + GOLD + '"><svg width="21" height="21" viewBox="0 0 24 24" style="display:block"><path class="et-bolt-glyph" d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg></span>' +
          '<div style="min-width:0"><div style="color:' + t.t1 + ';font-weight:800;font-size:17px;line-height:1">Easy Trade</div><div style="color:' + t.t4 + ';font-size:10px;font-weight:600;letter-spacing:.4px">BABY TRADER</div></div>' +
        '</div>' +
        '<button class="et-ibtn" id="et-hist" type="button" title="My predictions">' + ICO('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>', 18) + '</button>' +
        '<button class="et-ibtn" id="et-info" type="button">' + ICO('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>', 18) + '</button>' +
      '</div>' +
      '<div class="et-body" id="et-body"></div>';
    document.body.appendChild(ov);

    ov.querySelector("#et-back").onclick = function () {
      if (ET.view === "history") { closeSheet(); renderHome(ov); return; }
      stopPolling(); closeSheet(); ov.remove();
      if (ET.openTicketId) startNavWatch();  // keep the nav tab honest while the screen is closed
    };
    ov.querySelector("#et-info").onclick = openRules;
    ov.querySelector("#et-hist").onclick = function () { renderHistory(ov); };

    var body = ov.querySelector("#et-body");
    body.innerHTML = '<div style="display:flex;justify-content:center;padding:60px 0"><div style="width:26px;height:26px;border:3px solid ' + t.bd + ';border-top-color:' + t.pr + ';border-radius:50%;animation:etSpin .8s linear infinite"></div></div>';

    var boot = function () {
      Promise.all([loadMe(), loadHouses()]).then(function () {
        if (!document.getElementById("et-ov")) return;
        if (ET.openTicketId) {
          API("/easytrade/ticket/" + encodeURIComponent(ET.openTicketId)).then(function (r) {
            ET.ticket = r && r.ticket;
            if (ET.ticket && ET.ticket.status === "pending") { renderTicket(ov); startPolling(ov, ET.ticket.id); }
            else renderHome(ov);
          }).catch(function () { renderHome(ov); });
        } else renderHome(ov);
      }).catch(function () { errorState(ov, boot); });
    };
    boot();
  }

  // expose + wake the nav-tab bolt on load: light it if a forecast is already live.
  if (typeof window !== "undefined") {
    window.openEasyTrade = open;
    try { ensureNavCss(); } catch (e) {}
    setTimeout(function () { try { syncNavBolt(); } catch (e) {} }, 2500);
  }
})();
