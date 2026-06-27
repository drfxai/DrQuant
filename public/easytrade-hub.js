/* ===========================================================================
 * easytrade-hub.js - Easy Trade launcher hub for DrFX Quant
 * ---------------------------------------------------------------------------
 * Tapping the "Easy Trade" nav tab opens a hub with three cards. Each card is
 * its own image and routes onward:
 *
 *   - Legendary League card -> Leagues      (window.dqLeagues.open)
 *   - Baby Trader card      -> the original Easy Trade game (captured openEasyTrade)
 *   - Baby Pick card        -> Baby Pick     (window.dqBabyPick.open)
 *
 * Load this LAST, right before </body> (after babypick.js), so every target
 * global exists when this file runs:
 *
 *   <script src="/easytrade-hub.js"></script>
 *
 * The three card images are served as normal assets from public/:
 *   /easytrade-league.jpg   /easytrade-baby-trader.jpg   /easytrade-baby-pick.jpg
 * Targets are also resolved at click time, so load order is forgiving.
 * =========================================================================== */
(function () {
  "use strict";
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
    ov.style.cssText = "position:fixed;inset:0;z-index:5000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(4,7,18,.84);-webkit-backdrop-filter:blur(9px);backdrop-filter:blur(9px)";
    ov.innerHTML =
      '<style>' +
        '@keyframes ezhIn{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}' +
        '.ezh-col{width:min(430px,94vw);max-height:94vh;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:12px;padding:2px;animation:ezhIn .3s ease;-webkit-overflow-scrolling:touch}' +
        '.ezh-col::-webkit-scrollbar{width:0;height:0}' +
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
      '<button id="ezh-x" type="button" title="Close" style="position:fixed;top:14px;right:14px;z-index:5001;width:38px;height:38px;border-radius:50%;border:1px solid rgba(255,255,255,.25);background:rgba(6,10,24,.6);color:#dce8ff;cursor:pointer;display:flex;align-items:center;justify-content:center;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>' +
      '<div class="ezh-col">' +
        '<div id="ezh-league" class="ezh-card ezh-league" role="button" tabindex="0" title="Enter the League"><img src="' + IMG_LEAGUE + '" alt="Legendary League" draggable="false"/></div>' +
        '<div class="ezh-row">' +
          '<div id="ezh-baby" class="ezh-card ezh-trader" role="button" tabindex="0" title="Baby Trader"><img src="' + IMG_TRADER + '" alt="Baby Trader" draggable="false"/></div>' +
          '<div id="ezh-pick" class="ezh-card ezh-pick" role="button" tabindex="0" title="Baby Pick"><img src="' + IMG_PICK + '" alt="Baby Pick" draggable="false"/></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener("click", function (e) { if (e.target === ov) closeHub(); });
    document.addEventListener("keydown", onKey);

    function wire(id, fn) {
      var el = ov.querySelector(id);
      if (!el) return;
      el.onclick = function () { route(fn); };
      el.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); route(fn); } };
    }
    var x = ov.querySelector("#ezh-x"); if (x) x.onclick = closeHub;
    wire("#ezh-league", goLeagues);
    wire("#ezh-baby", goBabyTrader);
    wire("#ezh-pick", goBabyPick);
  }

  window.dqEasyHub = { open: openHub };
  // The "Easy Trade" nav tab calls window.openEasyTrade(); point it at the hub.
  window.openEasyTrade = openHub;
})();
