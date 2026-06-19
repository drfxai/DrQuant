// backnav.js — DrFX Quant
// Makes the phone's hardware BACK button (and the browser/edge back gesture)
// behave like an in-app "Back": it closes the top-most open layer instead of
// leaving the app. Layers, closed in this priority order:
//   1. message context menu
//   2. emoji picker
//   3. a modal (Profile / Settings / Subscription / Admin / editors / …)
//   4. a full-screen tool overlay (Market / Live Trading / Quantum Chat / Manual Trading)
//   5. the slide-out side menu
//   6. a channel/group info panel
//   7. an open chat (mobile) → back to the chat list
// Only a Back press with nothing open exits the app.
//
// It works by keeping a single "sentinel" entry in the browser history whenever
// something is open. Pressing Back consumes that entry (firing popstate) and we
// close the top layer; if more layers remain we re-arm. Closing a layer by other
// means (the X button, a tap) cleans the sentinel up so the next Back isn't wasted.
// Everything is wrapped in try/catch so a hiccup here can never break the app.
(function () {
  "use strict";
  if (!window.history || !history.pushState) return;

  var DEPTH = 0;     // sentinel entries we currently hold (0 or 1)
  var SYNC = false;  // true while we rewind history ourselves (popstate must ignore it)

  function byId(id) { return document.getElementById(id); }

  function emojiOpen() { var e = byId("ep"); return !!(e && e.style && e.style.display === "grid"); }
  function sidebarOpen() { var s = byId("sb-ov"); return !!(s && s.style && s.style.display === "block"); }

  // Top-most full-screen tool overlay: a position:fixed, high z-index direct child
  // of <body> (Market / Live / Quantum Chat / Manual Trading all use z-index:5000).
  function fullscreenOverlay() {
    var skip = { app: 1, "toast-wrap": 1, "sa-top": 1, tcss: 1, "ctx-menu": 1 };
    var kids = document.body.children, found = null;
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (el.id && skip[el.id]) continue;
      var st = el.style;
      if (st && st.position === "fixed" && (parseInt(st.zIndex, 10) || 0) >= 3000 &&
          st.display !== "none" && !(el.classList && el.classList.contains("dq-modal-ov"))) {
        found = el; // last match wins -> the visually top-most overlay
      }
    }
    return found;
  }

  function inMobileChat() {
    try {
      return window.innerWidth <= 768 && typeof S !== "undefined" && S &&
             S.mobileView === "chat" && S.activeChat;
    } catch (e) { return false; }
  }
  function infoPanelOpen() {
    try {
      return typeof S !== "undefined" && S && S.showInfo && S.chatInfo && S.chatInfo.type !== "dm";
    } catch (e) { return false; }
  }

  function anyLayerOpen() {
    try {
      return !!(byId("ctx-menu") || emojiOpen() || document.querySelector(".dq-modal-ov") ||
                fullscreenOverlay() || sidebarOpen() || infoPanelOpen() || inMobileChat());
    } catch (e) { return false; }
  }

  // Close the single top-most layer. Returns true if it closed something.
  function closeTop() {
    try {
      var el = byId("ctx-menu");
      if (el) { el.remove(); return true; }

      el = byId("ep");
      if (el && el.style.display === "grid") { el.style.display = "none"; return true; }

      var mods = document.querySelectorAll(".dq-modal-ov");
      if (mods.length) { mods[mods.length - 1].remove(); return true; }

      var ov = fullscreenOverlay();
      if (ov) {
        // In the Market, a Back press inside a creator/store view returns to the
        // listing first (mirrors the on-screen back), and only then closes Market.
        if (ov.id === "mk-overlay" && typeof MK !== "undefined" && MK && MK.handle) {
          MK.handle = null; MK.cur = null;
          if (typeof mkRender === "function") mkRender();
          return true;
        }
        // Prefer the overlay's own back button so its teardown runs
        // (e.g. Live Trading stops the stream / leaves the socket room).
        var bk = ov.querySelector('[id$="-back"]');
        if (bk) bk.click(); else ov.remove();
        return true;
      }

      el = byId("sb-ov");
      if (el && el.style.display === "block") { el.style.display = "none"; return true; }

      if (infoPanelOpen()) {
        S.showInfo = false;
        if (typeof renderChatView === "function") renderChatView();
        return true;
      }

      if (inMobileChat() && typeof goBack === "function") { goBack(); return true; }
    } catch (e) { /* never let Back handling throw */ }
    return false;
  }

  function arm() {
    if (DEPTH === 0) { try { history.pushState({ dqBack: 1 }, ""); DEPTH = 1; } catch (e) {} }
  }
  function rewindStale() {
    SYNC = true; DEPTH = 0;
    try { history.back(); } catch (e) { SYNC = false; }
  }
  // Keep history armed while any layer is open; clean up a leftover sentinel once
  // the last layer was closed by something other than Back.
  function reconcile() {
    if (anyLayerOpen()) arm();
    else if (DEPTH > 0) rewindStale();
  }

  window.addEventListener("popstate", function () {
    if (SYNC) { SYNC = false; return; }      // our own rewind — ignore
    if (closeTop()) {
      if (anyLayerOpen()) { try { history.pushState({ dqBack: 1 }, ""); } catch (e) {} DEPTH = 1; }
      else DEPTH = 0;
    } else {
      DEPTH = 0;                              // nothing was open -> allow the app to exit
    }
  });

  // Overlays (modals, full-screen tools, menus) get appended/removed as direct
  // children of <body>; observe that to arm / clean up the sentinel.
  try {
    new MutationObserver(reconcile).observe(document.body, { childList: true });
  } catch (e) {}

  // State-only layers (open chat, info panel, side-menu/emoji toggles) change via
  // re-render rather than a body child add/remove, so reconcile right after a tap.
  document.addEventListener("click", function () { setTimeout(reconcile, 0); }, true);
})();
