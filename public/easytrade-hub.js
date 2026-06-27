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
 * Load LAST, before </body> (after babypick.js). Card images live in public/:
 *   /easytrade-league.jpg  /easytrade-baby-trader.jpg  /easytrade-baby-pick.jpg
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

  var IMG_LEAGUE = "/easytrade-league.jpg";
  var IMG_TRADER = "/easytrade-baby-trader.jpg";
  var IMG_PICK   = "/easytrade-baby-pick.jpg";

  // Capture the original Easy Trade (Baby Trader) opener before we override it.
  var babyTraderOpen = (typeof window.openEasyTrade === "function") ? window.openEasyTrade : null;

  var OV_ID = "dq-ezhub-ov";

  function closeHub() {
    var o = document.getElementById(OV_ID);
    if (o && o.parentNode) o.parentNode.removeChild(o);
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) { if (e.key === "Escape") closeHub(); }
  function route(fn) { closeHub(); setTimeout(function () { try { fn(); } catch (e) {} }, 0); }

  function goLeagues() { if (window.dqLeagues && window.dqLeagues.open) window.dqLeagues.open(); }
  function goBabyTrader() {
    if (typeof babyTraderOpen === "function") babyTraderOpen();
    else if (typeof window.openEasyTrade === "function" && window.openEasyTrade !== openHub) window.openEasyTrade();
  }
  function goBabyPick() { if (window.dqBabyPick && window.dqBabyPick.open) window.dqBabyPick.open(); }

  function openHub() {
    closeHub();
    var ov = document.createElement("div");
    ov.id = OV_ID;
    ov.style.cssText = "position:fixed;inset:0;z-index:5000;display:flex;flex-direction:column;background:rgba(4,7,18,.93);-webkit-backdrop-filter:blur(9px);backdrop-filter:blur(9px);padding-top:var(--sat)";
    var bar = (window.dqAppNav ? window.dqAppNav.html("easytrade") : "");
    ov.innerHTML =
      '<style>' +
        '@keyframes ezhIn{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}' +
        '.ezh-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;align-items:center;justify-content:center;padding:16px;-webkit-overflow-scrolling:touch}' +
        '.ezh-col{width:min(430px,94vw);display:flex;flex-direction:column;gap:12px;padding:2px;animation:ezhIn .3s ease}' +
        '.ezh-card{position:relative;cursor:pointer;border-radius:18px;overflow:hidden;border:1px solid rgba(150,180,255,.18);box-shadow:0 10px 30px rgba(0,0,0,.45);transition:transform .16s ease,box-shadow .2s ease,border-color .2s ease;background:#0a1126}' +
        '.ezh-card img{width:100%;height:auto;display:block;-webkit-user-select:none;user-select:none}' +
        '.ezh-card:hover{transform:translateY(-3px)}' +
        '.ezh-card:active{transform:translateY(-1px) scale(.992)}' +
        '.ezh-league:hover{border-color:rgba(245,200,90,.85);box-shadow:0 16px 42px rgba(220,170,40,.42)}' +
        '.ezh-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}' +
        '.ezh-row .ezh-card img{aspect-ratio:283 / 334;object-fit:cover;height:auto}' +
        '.ezh-trader:hover{border-color:rgba(96,170,255,.9);box-shadow:0 16px 42px rgba(60,140,255,.44)}' +
        '.ezh-pick:hover{border-color:rgba(255,170,60,.9);box-shadow:0 16px 42px rgba(255,150,40,.44)}' +
      '</style>' +
      '<button id="ezh-x" type="button" title="Close" style="position:absolute;top:calc(14px + var(--sat));right:14px;z-index:5001;width:38px;height:38px;border-radius:50%;border:1px solid rgba(255,255,255,.25);background:rgba(6,10,24,.6);color:#dce8ff;cursor:pointer;display:flex;align-items:center;justify-content:center;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>' +
      '<div class="ezh-scroll">' +
        '<div class="ezh-col">' +
          '<div id="ezh-league" class="ezh-card ezh-league" role="button" tabindex="0" title="Enter the League"><img src="' + IMG_LEAGUE + '" alt="Legendary League" draggable="false"/></div>' +
          '<div class="ezh-row">' +
            '<div id="ezh-baby" class="ezh-card ezh-trader" role="button" tabindex="0" title="Baby Trader"><img src="' + IMG_TRADER + '" alt="Baby Trader" draggable="false"/></div>' +
            '<div id="ezh-pick" class="ezh-card ezh-pick" role="button" tabindex="0" title="Baby Pick"><img src="' + IMG_PICK + '" alt="Baby Pick" draggable="false"/></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      bar;
    document.body.appendChild(ov);
    ov.addEventListener("click", function (e) { if (e.target === ov) closeHub(); });
    document.addEventListener("keydown", onKey);

    function wireCard(id, fn) {
      var el = ov.querySelector(id);
      if (!el) return;
      el.onclick = function () { route(fn); };
      el.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); route(fn); } };
    }
    var x = ov.querySelector("#ezh-x"); if (x) x.onclick = closeHub;
    wireCard("#ezh-league", goLeagues);
    wireCard("#ezh-baby", goBabyTrader);
    wireCard("#ezh-pick", goBabyPick);
    if (window.dqAppNav) window.dqAppNav.wire(ov, "easytrade", closeHub);
  }

  window.dqEasyHub = { open: openHub };
  // The "Easy Trade" nav tab calls window.openEasyTrade(); point it at the hub.
  window.openEasyTrade = openHub;
})();
