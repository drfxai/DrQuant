/* ===========================================================================
 * easytrade-hub.js - Easy Trade launcher hub + shared app bottom nav
 * ---------------------------------------------------------------------------
 * (1) window.dqAppNav - a shared bottom navigation bar (Chat / Market /
 *     Signals / Easy Trade / Profile) that mirrors the main app nav. Other
 *     full-screen sections (Signals, this hub, Profile) render it so they get
 *     the same persistent navigation. Each button closes the current screen
 *     (via the supplied closeFn) and then opens the target, so overlays never
 *     stack. The active item is highlighted.
 *
 * (2) The Easy Trade hub itself: tapping the "Easy Trade" nav tab opens a hub
 *     with three cards, each routing onward:
 *       - Legendary League card -> Leagues   (window.dqLeagues.open)
 *       - Baby Trader card      -> the original Easy Trade game (captured)
 *       - Baby Pick card        -> Baby Pick (window.dqBabyPick.open)
 *
 * Load LAST, before </body> (after babypick.js). Cards are drawn in code (SVG/CSS).
 * All targets are resolved at click time, so load order is forgiving.
 * =========================================================================== */
(function () {
  "use strict";

  /* ----------------------------------------------------------------------- */
  /* Shared bottom nav: window.dqAppNav                                       */
  /* ----------------------------------------------------------------------- */
  if (!window.dqAppNav) {
    var ITEMS = [
      ["chat", "Chat", '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'],
      ["market", "Market", '<line x1="6" y1="3" x2="6" y2="6"/><rect x="4" y="6" width="4" height="7" rx="1"/><line x1="6" y1="13" x2="6" y2="17"/><line x1="12" y1="6" x2="12" y2="9"/><rect x="10" y="9" width="4" height="8" rx="1"/><line x1="12" y1="17" x2="12" y2="20"/><line x1="18" y1="4" x2="18" y2="7"/><rect x="16" y="7" width="4" height="6" rx="1"/><line x1="18" y1="13" x2="18" y2="16"/>'],
      ["signals", "Signals", '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'],
      ["easytrade", "Easy Trade", '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'],
      ["quant", "Options", '<line x1="8" y1="20" x2="8" y2="5"/><polyline points="4 9 8 5 12 9"/><line x1="16" y1="4" x2="16" y2="19"/><polyline points="12 15 16 19 20 15"/>'],
      ["profile", "Profile", '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>']
    ];
    function theme() {
      var T = (typeof t !== "undefined" && t) ? t : {};
      return {
        ch: T.ch || "rgba(9,15,28,.92)",
        bl: T.bl || "rgba(120,160,255,.14)",
        pr: T.pr || "#3b82f6",
        t4: T.t4 || "#6b7a90",
        pgw: T.pgw || "rgba(59,130,246,.5)"
      };
    }
    function navHtml(active) {
      var c = theme();
      var btns = ITEMS.map(function (n) {
        var on = n[0] === active;
        var col = on ? c.pr : c.t4;
        return '<button class="dqnav-tab" type="button" data-dqnav="' + n[0] + '" style="flex:1;background:none;border:none;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:9px 0 8px;position:relative;color:' + col + ';-webkit-tap-highlight-color:transparent">' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + n[2] + '</svg>' +
          '<span style="font-size:10px;font-weight:' + (on ? "700" : "500") + ';white-space:nowrap">' + n[1] + '</span>' +
          (on ? '<div style="position:absolute;bottom:3px;width:22px;height:2px;border-radius:2px;background:' + c.pr + ';box-shadow:0 0 8px ' + c.pgw + '"></div>' : '') +
          '</button>';
      }).join("");
      return '<div class="dqnav-bar" style="display:flex;align-items:stretch;flex-shrink:0;background:' + c.ch + ';-webkit-backdrop-filter:blur(26px) saturate(180%);backdrop-filter:blur(26px) saturate(180%);border-top:1px solid ' + c.bl + ';padding-bottom:var(--sab)">' + btns + '</div>';
    }
    function navigate(active, target, closeFn) {
      if (target === active) return;
      if (typeof closeFn === "function") { try { closeFn(); } catch (e) {} }
      setTimeout(function () {
        try {
          if (target === "chat") return; // home is revealed once the screen closes
          if (target === "market") { if (window.openMarket) window.openMarket(); }
          else if (target === "signals") { if (window.openSignalsFeed) window.openSignalsFeed(); else if (window.openLiveTrading) window.openLiveTrading(); }
          else if (target === "easytrade") { if (window.openEasyTrade) window.openEasyTrade(); }
          else if (target === "profile") { if (window.openProfile) window.openProfile(); }
          else if (target === "quant") { if (window.openQuantOption) window.openQuantOption(); }
        } catch (e) {}
      }, 0);
    }
    function navWire(scopeEl, active, closeFn) {
      if (!scopeEl || !scopeEl.querySelectorAll) return;
      scopeEl.querySelectorAll(".dqnav-tab").forEach(function (b) {
        b.onclick = function () { navigate(active, b.dataset.dqnav, closeFn); };
      });
    }
    window.dqAppNav = { html: navHtml, wire: navWire };
  }

  /* ----------------------------------------------------------------------- */
  /* Easy Trade hub                                                          */
  /* ----------------------------------------------------------------------- */
  if (window.__dqEzHub) return;
  window.__dqEzHub = true;

  // Card art is drawn in code (SVG + CSS) below - no external images.

  // Capture the original Easy Trade (Baby Trader) opener before we override it.
  var babyTraderOpen = (typeof window.openEasyTrade === "function") ? window.openEasyTrade : null;

  var OV_ID = "dq-ezhub-ov";

  function closeHub() {
    var o = document.getElementById(OV_ID);
    if (o && o.parentNode) o.parentNode.removeChild(o);
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) { if (e.key === "Escape") closeHub(); }
  var _routed = false;
  // Resolve the target opener FIRST; only close the hub once we actually have one,
  // so a not-yet-ready module (or a tap that lands off a card) can never drop the
  // user onto the chat home screen underneath.
  function route(resolve, label) {
    if (_routed) return;
    var fn = (typeof resolve === "function") ? resolve() : null;
    if (typeof fn !== "function") {
      try { console.warn("[EasyHub] opener for '" + (label || "section") + "' is not available"); } catch (e) {}
      try { if (typeof showToast === "function") showToast(label || "Easy Trade", "Still loading - please reload the app and try again."); } catch (e) {}
      return;
    }
    _routed = true;
    try { fn(); closeHub(); }
    catch (err) {
      _routed = false;
      try { console.error("[EasyHub] failed to open '" + (label || "section") + "'", err); } catch (e) {}
      try { if (typeof showToast === "function") showToast(label || "Easy Trade", "Couldn't open this - please try again."); } catch (e) {}
    }
  }

  function goLeagues() { return (window.dqLeagues && typeof window.dqLeagues.open === "function") ? function () { window.dqLeagues.open(); } : null; }
  function goBabyTrader() {
    if (typeof window.dqEasyTradeGame === "function") return window.dqEasyTradeGame;
    if (typeof babyTraderOpen === "function") return babyTraderOpen;
    if (typeof window.openEasyTrade === "function" && window.openEasyTrade !== openHub) return window.openEasyTrade;
    return null;
  }
  function goBabyPick() { return (window.dqBabyPick && typeof window.dqBabyPick.open === "function") ? function () { window.dqBabyPick.open(); } : null; }

  function openHub() {
    closeHub();
    _routed = false;
    var ov = document.createElement("div");
    ov.id = OV_ID;
    ov.style.cssText = "position:fixed;inset:0;z-index:5000;display:flex;flex-direction:column;background:rgba(4,7,18,.93);-webkit-backdrop-filter:blur(9px);backdrop-filter:blur(9px);padding-top:var(--sat)";
    var bar = (window.dqAppNav ? window.dqAppNav.html("easytrade") : "");
    ov.innerHTML =
      '<style>' +
        '@keyframes ezhIn{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}' +
        '@keyframes ezhGlow{0%,100%{opacity:.72}50%{opacity:1}}' +
        '.ezh-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;align-items:center;justify-content:center;padding:16px;-webkit-overflow-scrolling:touch}' +
        '.ezh-col{width:min(430px,94vw);display:flex;flex-direction:column;gap:12px;padding:2px;animation:ezhIn .3s ease}' +
        '.ezh-card{position:relative;cursor:pointer;border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.07);border:1px solid rgba(150,180,255,.18);transition:transform .16s ease,box-shadow .2s ease,border-color .2s ease}' +
        '.ezh-card:hover{transform:translateY(-3px)}' +
        '.ezh-card:active{transform:translateY(-1px) scale(.992)}' +
        '.ezh-card *{pointer-events:none}' +
        '.ezh-glow{position:absolute;inset:0;z-index:1;animation:ezhGlow 3.6s ease-in-out infinite}' +
        '.ezh-in{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;text-align:center}' +
        '.ezh-ic{display:block;margin-bottom:11px;filter:drop-shadow(0 4px 10px rgba(0,0,0,.35))}' +
        '.ezh-ttl{font-weight:800;letter-spacing:.5px;line-height:1.08}' +
        '.ezh-sub{font-weight:700;opacity:.92}' +
        '.ezh-cta{display:inline-flex;align-items:center;justify-content:center;gap:7px;font-weight:800;border-radius:999px;white-space:nowrap}' +
        '.ezh-cta svg{width:15px;height:15px}' +
        '.ezh-league{background:linear-gradient(160deg,#1b1505 0%,#2f2207 52%,#0c0a02 100%);border-color:rgba(245,200,90,.4)}' +
        '.ezh-league:hover{border-color:rgba(245,200,90,.9);box-shadow:0 16px 42px rgba(220,170,40,.45)}' +
        '.ezh-league .ezh-glow{background:radial-gradient(120% 82% at 50% -6%,rgba(245,200,90,.34),transparent 60%)}' +
        '.ezh-league .ezh-in{padding:26px 18px 23px}' +
        '.ezh-league .ezh-ttl{font-size:27px;background:linear-gradient(180deg,#ffeaa6,#f1b539);-webkit-background-clip:text;background-clip:text;color:transparent}' +
        '.ezh-league .ezh-sub{color:#f6d68c;font-size:11px;letter-spacing:2.6px;margin-top:9px}' +
        '.ezh-league .ezh-cta{margin-top:17px;background:linear-gradient(180deg,#ffd76a,#e0a92e);color:#3a2706;padding:11px 30px;font-size:15px;box-shadow:0 7px 18px rgba(224,169,46,.5)}' +
        '.ezh-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}' +
        '.ezh-row .ezh-in{padding:18px 12px 16px}' +
        '.ezh-row .ezh-ttl{font-size:18px}' +
        '.ezh-row .ezh-sub{font-size:9.5px;margin-top:6px;letter-spacing:.6px}' +
        '.ezh-row .ezh-cta{margin-top:14px;padding:9px 0;width:82%;font-size:12.5px;letter-spacing:.6px}' +
        '.ezh-trader{background:linear-gradient(160deg,#0a1838 0%,#112c60 58%,#070f24 100%);border-color:rgba(96,170,255,.32)}' +
        '.ezh-trader:hover{border-color:rgba(96,170,255,.95);box-shadow:0 16px 42px rgba(60,140,255,.45)}' +
        '.ezh-trader .ezh-glow{background:radial-gradient(130% 92% at 50% -4%,rgba(70,140,255,.32),transparent 62%)}' +
        '.ezh-trader .ezh-ttl{color:#d5e6ff}' +
        '.ezh-trader .ezh-sub{color:#8fb6ee}' +
        '.ezh-trader .ezh-cta{background:linear-gradient(180deg,#4ea0ff,#2563eb);color:#fff;box-shadow:0 6px 16px rgba(37,99,235,.5)}' +
        '.ezh-pick{background:linear-gradient(160deg,#2a1605 0%,#5a2f0a 58%,#1a0d02 100%);border-color:rgba(255,170,60,.32)}' +
        '.ezh-pick:hover{border-color:rgba(255,170,60,.95);box-shadow:0 16px 42px rgba(255,150,40,.45)}' +
        '.ezh-pick .ezh-glow{background:radial-gradient(130% 92% at 50% -4%,rgba(255,150,50,.32),transparent 62%)}' +
        '.ezh-pick .ezh-ttl{color:#ffe2bb}' +
        '.ezh-pick .ezh-sub{color:#f0b07a}' +
        '.ezh-pick .ezh-cta{background:linear-gradient(180deg,#ffb04e,#f97316);color:#3a1d05;box-shadow:0 6px 16px rgba(249,115,22,.5)}' +
      '</style>' +
      '<button id="ezh-x" type="button" title="Close" style="position:absolute;top:calc(14px + var(--sat));right:14px;z-index:5001;width:38px;height:38px;border-radius:50%;border:1px solid rgba(255,255,255,.25);background:rgba(6,10,24,.6);color:#dce8ff;cursor:pointer;display:flex;align-items:center;justify-content:center;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>' +
      '<div class="ezh-scroll">' +
        '<div class="ezh-col">' +
          '<div id="ezh-league" class="ezh-card ezh-league" role="button" tabindex="0" title="Enter the League">' +
            '<div class="ezh-glow"></div>' +
            '<div class="ezh-in">' +
              '<svg class="ezh-ic" viewBox="0 0 64 54" width="60" height="50" fill="none"><defs><linearGradient id="ezLg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffeaa6"/><stop offset="1" stop-color="#e6a92e"/></linearGradient></defs><path d="M6 40 L10 15 L23 29 L32 9 L41 29 L54 15 L58 40 Z" fill="url(#ezLg)" stroke="#8a6516" stroke-width="2" stroke-linejoin="round"/><rect x="8" y="40" width="48" height="9" rx="2.5" fill="url(#ezLg)" stroke="#8a6516" stroke-width="2"/><circle cx="32" cy="23" r="3" fill="#fff6d8"/><circle cx="14.5" cy="44.5" r="2.3" fill="#7a5512"/><circle cx="32" cy="44.5" r="2.3" fill="#7a5512"/><circle cx="49.5" cy="44.5" r="2.3" fill="#7a5512"/></svg>' +
              '<div class="ezh-ttl">LEGENDARY<br>LEAGUE</div>' +
              '<div class="ezh-sub">RULE THE MARKETS</div>' +
              '<span class="ezh-cta">ENTER <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg></span>' +
            '</div>' +
          '</div>' +
          '<div class="ezh-row">' +
            '<div id="ezh-baby" class="ezh-card ezh-trader" role="button" tabindex="0" title="Baby Trader">' +
              '<div class="ezh-glow"></div>' +
              '<div class="ezh-in">' +
                '<svg class="ezh-ic" viewBox="0 0 64 58" width="48" height="44" fill="none"><defs><linearGradient id="ezBt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d5e6ff"/><stop offset="1" stop-color="#3b82f6"/></linearGradient></defs><path d="M32 11 L59 24 L32 37 L5 24 Z" fill="url(#ezBt)" stroke="#1e3a6e" stroke-width="2" stroke-linejoin="round"/><path d="M15 29 V41 C15 45.5 23 49 32 49 C41 49 49 45.5 49 41 V29" fill="none" stroke="#7fb0ff" stroke-width="3" stroke-linecap="round"/><line x1="59" y1="24" x2="59" y2="40" stroke="#7fb0ff" stroke-width="2.6" stroke-linecap="round"/><circle cx="59" cy="42.5" r="3" fill="#7fb0ff"/></svg>' +
                '<div class="ezh-ttl">Baby Trader</div>' +
                '<div class="ezh-sub">LEARN &amp; TRADE</div>' +
                '<span class="ezh-cta">START</span>' +
              '</div>' +
            '</div>' +
            '<div id="ezh-pick" class="ezh-card ezh-pick" role="button" tabindex="0" title="Baby Pick">' +
              '<div class="ezh-glow"></div>' +
              '<div class="ezh-in">' +
                '<svg class="ezh-ic" viewBox="0 0 64 58" width="50" height="44" fill="none"><path d="M23 37 V20 M23 20 L16 27 M23 20 L30 27" stroke="#2fcf8e" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M41 21 V38 M41 38 L34 31 M41 38 L48 31" stroke="#ff5d5d" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
                '<div class="ezh-ttl">Baby Pick</div>' +
                '<div class="ezh-sub">MAKE YOUR CHOICE</div>' +
                '<span class="ezh-cta">PLAY</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      bar;
    document.body.appendChild(ov);
    ov.addEventListener("click", function (e) { if (e.target === ov) closeHub(); });
    document.addEventListener("keydown", onKey);

    function wireCard(id, fn, label) {
      var el = ov.querySelector(id);
      if (!el) return;
      el.onclick = function () { route(fn, label); };
      el.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); route(fn, label); } };
    }
    var x = ov.querySelector("#ezh-x"); if (x) x.onclick = closeHub;
    wireCard("#ezh-league", goLeagues, "Legendary League");
    wireCard("#ezh-baby", goBabyTrader, "Baby Trader");
    wireCard("#ezh-pick", goBabyPick, "Baby Pick");
    if (window.dqAppNav) window.dqAppNav.wire(ov, "easytrade", closeHub);
  }

  window.dqEasyHub = { open: openHub };
  // The "Easy Trade" nav tab calls window.openEasyTrade(); point it at the hub.
  window.openEasyTrade = openHub;
})();
