/* ===========================================================================
 * easytrade-hub.js - Easy Trade launcher hub for DrFX Quant
 * ---------------------------------------------------------------------------
 * Tapping the "Easy Trade" nav tab opens a hub that shows the Legendary League
 * art. Three clickable regions route onward:
 *
 *   - top hero panel    -> Leagues       (window.dqLeagues.open)
 *   - Baby Trader card  -> the original Easy Trade game (captured openEasyTrade)
 *   - Baby Pick card    -> Baby Pick      (window.dqBabyPick.open)
 *
 * Load this LAST, right before </body> (after babypick.js), so every target
 * global exists when this file runs:
 *
 *   <script src="/easytrade-hub.js"></script>
 *
 * The art is served as a normal asset at /easytrade-hub.jpg (place the file in
 * public/). Targets are also resolved at click time, so order is forgiving.
 * =========================================================================== */
(function () {
  "use strict";
  if (window.__dqEzHub) return;
  window.__dqEzHub = true;

  var HUB_IMG = "/easytrade-hub.jpg";

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
    ov.style.cssText = "position:fixed;inset:0;z-index:5000;display:flex;align-items:center;justify-content:center;padding:14px;background:rgba(4,7,18,.82);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)";
    ov.innerHTML =
      '<style>' +
        '.ezh-hot{position:absolute;cursor:pointer;border-radius:14px;transition:box-shadow .18s ease,transform .12s ease,background .18s ease}' +
        '.ezh-hot:hover{box-shadow:0 0 0 2px rgba(124,199,255,.7),0 0 26px rgba(96,170,255,.5);background:rgba(124,199,255,.08)}' +
        '.ezh-hot:active{transform:scale(.985)}' +
        '@keyframes ezhIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}' +
      '</style>' +
      '<div style="position:relative;width:min(460px,92vw,92vh);animation:ezhIn .28s ease">' +
        '<img src="' + HUB_IMG + '" alt="Easy Trade" draggable="false" style="width:100%;height:auto;display:block;border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.6);-webkit-user-select:none;user-select:none"/>' +
        '<button id="ezh-x" type="button" title="Close" style="position:absolute;top:8px;right:8px;z-index:4;width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.25);background:rgba(6,10,24,.55);color:#dce8ff;cursor:pointer;display:flex;align-items:center;justify-content:center;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>' +
        '<div id="ezh-league" class="ezh-hot" title="Enter the League" style="top:1.5%;left:1.5%;width:97%;height:59%"></div>' +
        '<div id="ezh-baby" class="ezh-hot" title="Baby Trader" style="top:62.5%;left:1.5%;width:47%;height:36%"></div>' +
        '<div id="ezh-pick" class="ezh-hot" title="Baby Pick" style="top:62.5%;right:1.5%;width:47%;height:36%"></div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener("click", function (e) { if (e.target === ov) closeHub(); });
    document.addEventListener("keydown", onKey);
    var x = ov.querySelector("#ezh-x"); if (x) x.onclick = closeHub;
    var L = ov.querySelector("#ezh-league"); if (L) L.onclick = function () { route(goLeagues); };
    var B = ov.querySelector("#ezh-baby"); if (B) B.onclick = function () { route(goBabyTrader); };
    var P = ov.querySelector("#ezh-pick"); if (P) P.onclick = function () { route(goBabyPick); };
  }

  window.dqEasyHub = { open: openHub };
  // The "Easy Trade" nav tab calls window.openEasyTrade(); point it at the hub.
  window.openEasyTrade = openHub;
})();
