// exit-prompt.js — DrFX Quant
// The animated "exit the app?" confirmation card shown by backnav.js when a Back
// press has nothing left to close. Kept in its own file so the (larger) markup +
// CSS lives outside backnav.js. Exposes window.dqExit = { show, isOpen, close }.
// A web app cannot force-quit an installed PWA, so "Exit" runs the caller's
// onExit callback (which releases the back-lock and best-effort closes the window).
(function () {
  "use strict";
  var EXIT_ID = "dq-exit-ov";
  function byId(id) { return document.getElementById(id); }
  function isOpen() { return !!byId(EXIT_ID); }
  function close() { var e = byId(EXIT_ID); if (e) e.remove(); }

  function ensureCss() {
    if (byId("dq-exit-css")) return;
    var st = document.createElement("style"); st.id = "dq-exit-css";
    st.textContent =
      "@keyframes dqExitIn{from{opacity:0}to{opacity:1}}" +
      "@keyframes dqExitCard{0%{opacity:0;transform:translateY(26px) scale(.9)}60%{transform:translateY(-4px) scale(1.012)}100%{opacity:1;transform:translateY(0) scale(1)}}" +
      "@keyframes dqExitGlow{0%,100%{transform:scale(1);opacity:.5}50%{transform:scale(1.14);opacity:.85}}" +
      "@keyframes dqExitWave{0%,100%{transform:rotate(0)}25%{transform:rotate(16deg)}75%{transform:rotate(-8deg)}}" +
      "#dq-exit-ov{position:fixed;inset:0;z-index:99990;display:flex;align-items:center;justify-content:center;background:rgba(4,8,22,.62);-webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px);animation:dqExitIn .18s ease;padding:24px}" +
      "#dq-exit-ov .dqx-card{position:relative;width:100%;max-width:340px;background:linear-gradient(180deg,#161d33,#0e1425);border:1px solid rgba(120,150,255,.18);border-radius:22px;padding:26px 22px 20px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.6);animation:dqExitCard .36s cubic-bezier(.2,.8,.25,1)}" +
      "#dq-exit-ov .dqx-badge{width:66px;height:66px;margin:0 auto 14px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:30px;background:radial-gradient(circle at 50% 40%,rgba(90,130,255,.35),rgba(40,70,180,.18));position:relative}" +
      "#dq-exit-ov .dqx-badge span{display:block;animation:dqExitWave 2.4s ease-in-out infinite;transform-origin:70% 70%}" +
      "#dq-exit-ov .dqx-badge::before{content:'';position:absolute;inset:-8px;border-radius:50%;background:radial-gradient(circle,rgba(90,130,255,.4),transparent 70%);animation:dqExitGlow 2.2s ease-in-out infinite;z-index:-1}" +
      "#dq-exit-ov h3{margin:0 0 8px;color:#eaf0ff;font-size:16.5px;font-weight:700;font-family:Outfit,system-ui,sans-serif;line-height:1.35}" +
      "#dq-exit-ov p{margin:0 0 20px;color:#9fb0d6;font-size:12.5px;line-height:1.55;font-family:Outfit,system-ui,sans-serif}" +
      "#dq-exit-ov .dqx-btns{display:flex;gap:10px}" +
      "#dq-exit-ov button{flex:1;border:0;border-radius:13px;padding:12px;font-size:13.5px;font-weight:600;font-family:Outfit,system-ui,sans-serif;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:transform .05s ease}" +
      "#dq-exit-ov .dqx-stay{background:linear-gradient(180deg,#3a6cdc,#2f57c4);color:#fff;box-shadow:0 6px 16px rgba(58,108,220,.4)}" +
      "#dq-exit-ov .dqx-exit{background:rgba(150,170,210,.12);color:#c3d0ee}" +
      "#dq-exit-ov button:active{filter:brightness(.92);transform:scale(.97)}";
    document.head.appendChild(st);
  }

  function show(onExit) {
    if (isOpen()) return;
    ensureCss();
    var ov = document.createElement("div"); ov.id = EXIT_ID;
    ov.innerHTML =
      '<div class="dqx-card" role="dialog" aria-modal="true">' +
        '<div class="dqx-badge"><span>👋</span></div>' +
        '<h3>Are you sure you want to exit the application?</h3>' +
        '<p>We are waiting for you to return and continue the journey of the League of Legends.</p>' +
        '<div class="dqx-btns">' +
          '<button type="button" class="dqx-exit">Exit</button>' +
          '<button type="button" class="dqx-stay">Stay</button>' +
        '</div>' +
      '</div>';
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    document.body.appendChild(ov);
    var stay = ov.querySelector(".dqx-stay"); if (stay) stay.onclick = function () { close(); };
    var exit = ov.querySelector(".dqx-exit"); if (exit) exit.onclick = function () { close(); if (typeof onExit === "function") onExit(); };
  }

  window.dqExit = { show: show, isOpen: isOpen, close: close };
})();
