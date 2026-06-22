/* ============================================================================
   DrFX Quant — Manager / Moderator Console   (window.dqConsole)
   ----------------------------------------------------------------------------
   A full-screen overlay rendered INSIDE the SPA (same pattern as the QNTM
   Control Deck and the in-app Admin dashboard). It surfaces the RBAC-gated
   /api/manage console that previously had no UI.

   Tabs (rendered only for roles that can use them — the API enforces too):
     Overview   GET  /manage/health
     Reports    GET  /manage/flags?status=&limit=
                POST /manage/flags/:id/resolve   {action, deleteMessage, resolution}
     Signals    POST /manage/signals/manual      {symbol, side, price, stop_loss,
                                                   take_profit, timeframe, strategy,
                                                   note, channelId}
                GET  /manage/signal-channels      (channel picker; admin-only, optional)
     Broadcast  POST /manage/broadcast           {title, body, level, audience,
                                                   audienceFilter}        [admin+]
     Audit      GET  /manage/audit?action=&actorId=&limit=                [admin+]

   Permission map (mirrors middleware/permissions.js):
     manager+  : Overview, Reports, Signals
     admin+    : + Broadcast, Audit, channel picker

   Reuses page globals (classic scripts share one scope): api, S, t, esc, ce,
   showToast.  No external dependencies.
   ========================================================================== */
(function () {
  "use strict";

  /* ----------------------------- role gates ------------------------------ */
  function role() { return (typeof S !== "undefined" && S.user && S.user.role) || "user"; }
  function isManagerUp() { return ["manager", "admin", "superadmin"].indexOf(role()) >= 0; }
  function isAdminUp() { return ["admin", "superadmin"].indexOf(role()) >= 0; }

  /* ------------------------------ utilities ------------------------------ */
  function fmt(n) { return (Number(n) || 0).toLocaleString("en-US"); }
  function esc2(s) { try { return esc(s); } catch (e) { return String(s == null ? "" : s); } }
  function num(v) { if (v === "" || v == null) return ""; var n = Number(v); return isFinite(n) ? String(n) : ""; }
  function when(d) { if (!d) return "—"; var x = new Date(d); return isNaN(x) ? String(d) : x.toLocaleString(); }
  function ago(d) {
    if (!d) return "";
    var s = (Date.now() - new Date(d).getTime()) / 1000;
    if (isNaN(s)) return "";
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  function dur(sec) {
    sec = Math.max(0, sec | 0);
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return d + "d " + h + "h";
    if (h) return h + "h " + m + "m";
    if (m) return m + "m";
    return sec + "s";
  }
  function errMsg(e) {
    var m = (e && e.error && (e.error.message || e.error)) || (e && e.message) || "Action failed";
    if (e && e.need) m += " (needs: " + [].concat(e.need).join(", ") + ")";
    return typeof m === "string" ? m : JSON.stringify(m);
  }
  function toast(a, b) { try { if (window.showToast) showToast(a, b || " "); } catch (_) {} }
  function ce2(tag) { try { return ce(tag); } catch (e) { return document.createElement(tag); } }

  function loadingBox() { return '<div class="dqc-state">' + spinner() + '</div>'; }
  function listSkeleton() { return '<div class="dqc-card"><div class="dqc-skel"></div><div class="dqc-skel"></div><div class="dqc-skel"></div></div>'; }
  function emptyBox(msg) { return '<div class="dqc-state dqc-empty">' + SVG.inbox + '<div>' + esc2(msg) + '</div></div>'; }
  function failBox(msg) { return '<div class="dqc-state dqc-fail">' + SVG.alert + '<div>' + esc2(msg) + '</div></div>'; }
  function spinner() { return '<div class="dqc-spin"></div>'; }

  /* -------------------------------- icons -------------------------------- */
  var ICO = function (d, sw) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 2) + '" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>'; };
  var SVG = {
    shield: ICO('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>', 2.1),
    gauge: ICO('<path d="M12 14l4-4"/><path d="M3 12a9 9 0 1 1 18 0"/><circle cx="12" cy="14" r="1.6" fill="currentColor" stroke="none"/>'),
    flag: ICO('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>'),
    signal: ICO('<path d="M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 20V4"/>'),
    mega: ICO('<path d="M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 8a4 4 0 0 1 0 8"/><path d="M17.5 5.5a8 8 0 0 1 0 13"/>'),
    scroll: ICO('<path d="M8 3h9a2 2 0 0 1 2 2v12a2 2 0 0 0 2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2z"/><line x1="10" y1="8" x2="16" y2="8"/><line x1="10" y1="12" x2="16" y2="12"/>'),
    plug: ICO('<path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0z"/><line x1="12" y1="16" x2="12" y2="22"/>'),
    alert: ICO('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    warn: ICO('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    info: ICO('<circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
    clock: ICO('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>'),
    chip: ICO('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>'),
    inbox: ICO('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
    refresh: ICO('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
    close: ICO('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 2.2),
    trash: ICO('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
    check: ICO('<polyline points="20 6 9 17 4 12"/>', 2.3),
    user: ICO('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    dot: ICO('<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>'),
    arrow: ICO('<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>'),
    radio: ICO('<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49"/>')
  };

  /* --------------------------- theme → CSS vars -------------------------- */
  function applyVars(ov) {
    var map = {
      bg: t.bg, card: t.cd, card2: t.ch, bd: t.bd, bl: t.bl, ba: t.ba,
      t1: t.t1, t2: t.t2, t3: t.t3, t4: t.t4, pri: t.pr, ac: t.ac,
      on: t.on, inp: t.inp, mod: t.mod, ta: t.ta, act: t.act, sh: t.sh,
      pg: t.pg, pgw: t.pgw, warn: "#f59e0b", bad: "#ef4444"
    };
    for (var k in map) ov.style.setProperty("--c-" + k, map[k] == null ? "" : map[k]);
  }

  /* ----------------------- one-time stylesheet --------------------------- */
  function injectCSS() {
    if (document.getElementById("dqc-css")) return;
    var s = ce2("style"); s.id = "dqc-css";
    s.textContent = [
      "#dqc-ov{position:fixed;inset:0;z-index:9600;display:flex;flex-direction:column;overflow:hidden;",
      "background:var(--c-bg);color:var(--c-t1);font-family:'Outfit',system-ui,-apple-system,sans-serif;animation:dqcFade .22s ease}",
      "#dqc-ov *{box-sizing:border-box;min-width:0}",
      "@keyframes dqcFade{from{opacity:0}to{opacity:1}}",
      "@keyframes dqcRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}",
      "@keyframes dqcSpin{to{transform:rotate(360deg)}}",
      ".dqc-spin{width:26px;height:26px;border:3px solid var(--c-bd);border-top-color:var(--c-pri);border-radius:50%;animation:dqcSpin .8s linear infinite}",
      /* top bar */
      ".dqc-bar{display:flex;align-items:center;gap:11px;flex-shrink:0;padding:calc(var(--sat,0px) + 11px) 16px 11px;background:var(--c-card2);border-bottom:1px solid var(--c-bd);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px)}",
      ".dqc-logo{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;flex-shrink:0;background:var(--c-pg);box-shadow:0 6px 16px var(--c-pgw)}",
      ".dqc-logo svg{width:20px;height:20px;color:#fff}",
      ".dqc-id{display:flex;align-items:center;gap:10px;min-width:0;flex:1}",
      ".dqc-ttl{font-size:16px;font-weight:800;line-height:1.05;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dqc-ttl span{color:var(--c-pri)}",
      ".dqc-sub{font-size:11px;color:var(--c-t3);font-weight:500;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dqc-secure{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:9px;background:rgba(52,211,122,.12);border:1px solid rgba(52,211,122,.32);color:#34d27a;font-size:10px;font-weight:800;letter-spacing:.8px;white-space:nowrap;flex-shrink:0}",
      ".dqc-secure svg{width:12px;height:12px}",
      ".dqc-tools{display:flex;align-items:center;gap:8px;flex-shrink:0}",
      ".dqc-ib{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;cursor:pointer;flex-shrink:0;border:1px solid var(--c-bd);background:var(--c-ta);color:var(--c-t2);transition:.15s}",
      ".dqc-ib:hover{color:var(--c-t1);border-color:var(--c-bl)}",
      ".dqc-ib svg{width:18px;height:18px}",
      ".dqc-ib.cl:hover{color:#ff5a76;border-color:rgba(255,90,118,.4)}",
      /* tabs */
      ".dqc-tabs{display:flex;gap:4px;flex-shrink:0;padding:9px 12px;background:var(--c-card2);border-bottom:1px solid var(--c-bd);overflow-x:auto;-webkit-overflow-scrolling:touch}",
      ".dqc-tabs::-webkit-scrollbar{height:0}",
      ".dqc-tab{display:flex;align-items:center;gap:7px;padding:8px 14px;border-radius:11px;border:1px solid transparent;background:transparent;color:var(--c-t3);font-size:13px;font-weight:700;font-family:inherit;cursor:pointer;white-space:nowrap;flex-shrink:0;transition:.15s}",
      ".dqc-tab svg{width:16px;height:16px}",
      ".dqc-tab:hover{color:var(--c-t1)}",
      ".dqc-tab.on{background:var(--c-act);border-color:var(--c-ba);color:var(--c-ac)}",
      ".dqc-tab .pip{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--c-bad);color:#fff;font-size:10px;font-weight:800;display:none;align-items:center;justify-content:center}",
      ".dqc-tab .pip.show{display:inline-flex}",
      /* body */
      ".dqc-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overflow-x:hidden}",
      ".dqc-wrap{max-width:920px;margin:0 auto;width:100%;padding:16px 14px calc(var(--sab,0px) + 56px)}",
      ".dqc-h{color:var(--c-t2);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin:20px 2px 11px;display:flex;align-items:center;gap:8px}",
      ".dqc-h:first-child{margin-top:4px}",
      ".dqc-note{color:var(--c-t4);font-size:11.5px;line-height:1.5;margin-top:12px;padding:0 2px}",
      /* states */
      ".dqc-state{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:48px 24px;text-align:center;color:var(--c-t3);font-size:13px}",
      ".dqc-state svg{width:30px;height:30px}",
      ".dqc-empty{color:var(--c-t3)}.dqc-empty svg{color:var(--c-t4)}",
      ".dqc-fail{color:#ff9b94}.dqc-fail svg{color:#ef4444}",
      ".dqc-skel{height:46px;border-radius:11px;margin:6px 0;background:linear-gradient(90deg,rgba(120,160,255,.05),rgba(120,160,255,.13),rgba(120,160,255,.05));background-size:200% 100%;animation:dqcSh 1.3s infinite}",
      "@keyframes dqcSh{to{background-position:-200% 0}}",
      /* generic card */
      ".dqc-card{background:var(--c-card);border:1px solid var(--c-bd);border-radius:16px;padding:14px 15px;animation:dqcRise .4s ease both}",
      /* KPI grid */
      ".dqc-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:11px}",
      ".dqc-kpi{background:var(--c-card);border:1px solid var(--c-bd);border-radius:15px;padding:13px 14px;display:flex;flex-direction:column;gap:7px;animation:dqcRise .4s ease both}",
      ".dqc-kpi.dqc-clk{cursor:pointer;transition:border-color .15s}.dqc-kpi.dqc-clk:hover{border-color:var(--c-ba)}",
      ".dqc-kpi-ic{width:31px;height:31px;border-radius:9px;display:grid;place-items:center;background:var(--c-ta);color:var(--kc,var(--c-pri))}",
      ".dqc-kpi-ic svg{width:16px;height:16px}",
      ".dqc-kpi-v{font-size:21px;font-weight:800;line-height:1;letter-spacing:.3px;font-family:ui-monospace,monospace}",
      ".dqc-kpi-l{font-size:11px;color:var(--c-t3);font-weight:500}",
      /* live session */
      ".dqc-live{margin-top:12px;display:flex;align-items:center;gap:13px;padding:14px 15px;border-radius:16px;background:var(--c-card);border:1px solid var(--c-bd)}",
      ".dqc-live.on{border-color:rgba(239,68,68,.4);background:rgba(239,68,68,.06)}",
      ".dqc-live-ic{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;flex-shrink:0;background:var(--c-ta);color:var(--c-t3)}",
      ".dqc-live.on .dqc-live-ic{background:rgba(239,68,68,.16);color:#ef4444}",
      ".dqc-live-ic svg{width:20px;height:20px}",
      ".dqc-pulse{animation:dqcPulse 1.4s infinite}@keyframes dqcPulse{0%,100%{opacity:1}50%{opacity:.35}}",
      /* forms */
      ".dqc-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}",
      ".dqc-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}",
      ".dqc-f{margin-bottom:11px}",
      ".dqc-lbl{display:block;color:var(--c-t3);font-size:11px;font-weight:700;letter-spacing:.3px;margin-bottom:5px}",
      "#dqc-ov .gi{width:100%}",
      ".dqc-area{width:100%;min-height:84px;resize:vertical;padding:11px 13px;border-radius:12px;background:var(--c-inp);border:1px solid var(--c-bl);color:var(--c-t1);font-size:14px;font-family:'Outfit',sans-serif;outline:none;line-height:1.5}",
      ".dqc-area:focus{border-color:var(--c-ba)}",
      ".dqc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
      /* segmented control */
      ".dqc-seg{display:flex;gap:6px;flex-wrap:wrap}",
      ".dqc-seg button{flex:1;min-width:84px;padding:9px 10px;border-radius:11px;border:1px solid var(--c-bd);background:transparent;color:var(--c-t3);font-size:12.5px;font-weight:700;font-family:inherit;cursor:pointer;transition:.14s}",
      ".dqc-seg button.on{border-color:var(--sc,var(--c-ba));background:color-mix(in srgb,var(--sc,var(--c-pri)) 16%,transparent);color:var(--sc,var(--c-ac))}",
      /* primary / ghost buttons */
      ".dqc-pri{width:100%;padding:13px;border-radius:13px;border:none;background:var(--c-pg);color:#fff;font-size:14.5px;font-weight:800;font-family:inherit;cursor:pointer;box-shadow:0 6px 18px var(--c-pgw);transition:transform .12s}",
      ".dqc-pri:hover{transform:translateY(-1px)}.dqc-pri:active{transform:scale(.99)}.dqc-pri:disabled{opacity:.55;cursor:wait;transform:none}",
      ".dqc-ghost{padding:9px 14px;border-radius:11px;border:1px solid var(--c-bd);background:transparent;color:var(--c-t2);font-size:12.5px;font-weight:700;font-family:inherit;cursor:pointer}",
      ".dqc-ghost:hover{color:var(--c-t1);border-color:var(--c-bl)}",
      /* filter chips */
      ".dqc-chips{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:13px}",
      ".dqc-chip{padding:7px 14px;border-radius:11px;border:1px solid var(--c-bd);background:transparent;color:var(--c-t3);font-size:12.5px;font-weight:700;font-family:inherit;cursor:pointer;white-space:nowrap;transition:.14s}",
      ".dqc-chip.on{border-color:var(--c-ba);background:var(--c-act);color:var(--c-ac)}",
      ".dqc-fbar{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end;margin-bottom:13px}",
      /* flag card */
      ".dqc-flag{border:1px solid var(--c-bd);border-radius:15px;background:var(--c-card);padding:13px 14px;margin-bottom:11px;animation:dqcRise .35s ease both}",
      ".dqc-flag-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:9px}",
      ".dqc-who{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--c-t2);min-width:0}",
      ".dqc-who b{color:var(--c-t1);font-weight:700}",
      ".dqc-who svg{width:13px;height:13px;color:var(--c-t4);flex-shrink:0}",
      ".dqc-pill{font-size:10px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;padding:3px 8px;border-radius:7px}",
      ".dqc-time{color:var(--c-t4);font-size:11px;margin-left:auto;white-space:nowrap}",
      ".dqc-msg{font-size:13.5px;line-height:1.5;color:var(--c-t1);background:var(--c-inp);border:1px solid var(--c-bd);border-radius:11px;padding:10px 12px;white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto}",
      ".dqc-reason{margin-top:8px;font-size:12px;color:var(--c-t2);border-left:3px solid var(--c-ba);padding:2px 0 2px 10px}",
      ".dqc-reason span{color:var(--c-t4)}",
      ".dqc-acts{display:flex;gap:7px;flex-wrap:wrap;margin-top:11px}",
      ".dqc-act{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:10px;font-size:12px;font-weight:700;font-family:inherit;cursor:pointer;border:1px solid;transition:.14s}",
      ".dqc-act svg{width:13px;height:13px}",
      ".dqc-act.ok{border-color:rgba(52,210,122,.45);background:rgba(52,210,122,.1);color:#34d27a}",
      ".dqc-act.mut{border-color:var(--c-bd);background:var(--c-ta);color:var(--c-t2)}",
      ".dqc-act.bad{border-color:rgba(239,68,68,.45);background:rgba(239,68,68,.1);color:#ef4444}",
      ".dqc-act:hover{filter:brightness(1.12)}",
      ".dqc-badge-del{font-size:9.5px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;padding:2px 7px;border-radius:6px;background:rgba(239,68,68,.16);color:#ef4444}",
      /* preview cards */
      ".dqc-prev{margin-top:6px;border:1px solid var(--c-bl);border-radius:14px;background:var(--c-card2);padding:13px 14px}",
      ".dqc-prev-top{display:flex;align-items:center;gap:9px;margin-bottom:10px}",
      ".dqc-prev-sym{font-size:16px;font-weight:800;letter-spacing:.4px;font-family:ui-monospace,monospace;color:var(--c-t1)}",
      ".dqc-prev-side{font-size:11px;font-weight:800;letter-spacing:.5px;padding:3px 10px;border-radius:8px}",
      ".dqc-prev-rows{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px}",
      ".dqc-prev-row{display:flex;justify-content:space-between;gap:10px;font-size:12.5px}",
      ".dqc-prev-row span{color:var(--c-t3)}.dqc-prev-row b{color:var(--c-t1);font-weight:700;font-family:ui-monospace,monospace}",
      ".dqc-prev-note{margin-top:10px;font-size:12.5px;color:var(--c-t2);line-height:1.5;border-top:1px solid var(--c-bd);padding-top:9px;white-space:pre-wrap;word-break:break-word}",
      ".dqc-bcprev{margin-top:6px;display:flex;gap:12px;align-items:flex-start;border:1px solid;border-radius:14px;padding:13px 14px}",
      ".dqc-bcprev-ic{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;flex-shrink:0}",
      ".dqc-bcprev-ic svg{width:18px;height:18px}",
      ".dqc-bcprev-t{font-size:14px;font-weight:800;color:var(--c-t1);margin-bottom:3px}",
      ".dqc-bcprev-b{font-size:13px;color:var(--c-t2);line-height:1.5;white-space:pre-wrap;word-break:break-word}",
      ".dqc-bcprev-m{font-size:11px;color:var(--c-t4);margin-top:8px}",
      /* audit rows */
      ".dqc-aud{border:1px solid var(--c-bd);border-radius:13px;background:var(--c-card);padding:11px 13px;margin-bottom:9px;animation:dqcRise .3s ease both}",
      ".dqc-aud-top{display:flex;align-items:center;gap:9px;flex-wrap:wrap}",
      ".dqc-aud-act{font-size:12px;font-weight:800;color:var(--c-ac);font-family:ui-monospace,monospace}",
      ".dqc-aud-meta{color:var(--c-t3);font-size:11.5px;margin-top:5px;word-break:break-word}",
      ".dqc-aud-meta b{color:var(--c-t2);font-weight:600}",
      ".dqc-json{margin-top:7px;font-family:ui-monospace,monospace;font-size:11px;color:var(--c-t3);background:var(--c-inp);border:1px solid var(--c-bd);border-radius:9px;padding:8px 10px;white-space:pre-wrap;word-break:break-word;max-height:140px;overflow:auto}",
      /* sheet (modal) */
      ".dqc-sheet-ov{position:fixed;inset:0;z-index:9700;display:grid;place-items:center;padding:20px;background:rgba(2,5,16,.66);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);animation:dqcFade .16s ease}",
      ".dqc-sheet{width:min(440px,100%);background:var(--c-mod);border:1px solid var(--c-ba);border-radius:18px;box-shadow:var(--c-sh);overflow:hidden;animation:dqcRise .2s ease both}",
      ".dqc-sheet-h{padding:15px 18px;border-bottom:1px solid var(--c-bd);font-size:15px;font-weight:800;color:var(--c-t1)}",
      ".dqc-sheet-b{padding:16px 18px}",
      ".dqc-sheet-b p{margin:0 0 12px;font-size:13px;color:var(--c-t2);line-height:1.55}",
      ".dqc-sheet-warn{color:#ff9b94;font-size:12px;margin:2px 0 6px}",
      ".dqc-sheet-warn b{color:#ffb4ad}",
      ".dqc-sheet-f{padding:13px 18px;border-top:1px solid var(--c-bd);display:flex;justify-content:flex-end;gap:10px}",
      ".dqc-sheet-err{color:#ff9b94;font-size:12px;margin-top:8px}",
      ".dqc-btn{padding:9px 16px;border-radius:11px;border:1px solid var(--c-bd);background:transparent;color:var(--c-t2);font-size:13px;font-weight:700;font-family:inherit;cursor:pointer}",
      ".dqc-btn.go{border:none;background:var(--c-pri);color:#fff}",
      ".dqc-btn.go.danger{background:#ef4444}",
      ".dqc-btn:disabled{opacity:.5;cursor:not-allowed}",
      /* responsive */
      "@media (max-width:680px){",
      ".dqc-kpis{grid-template-columns:repeat(2,1fr)}",
      ".dqc-grid3{grid-template-columns:1fr}",
      ".dqc-fbar{grid-template-columns:1fr 1fr}",
      ".dqc-prev-rows{grid-template-columns:1fr}",
      ".dqc-sub{display:none}",
      "}",
      "@media (max-width:420px){.dqc-grid2{grid-template-columns:1fr}.dqc-secure{display:none}}"
    ].join("");
    document.head.appendChild(s);
  }

  /* ============================ state + open ============================= */
  var ST = { ov: null, tab: "overview", timer: null, openFlags: 0 };

  var TABS = [
    { id: "overview", label: "Overview", icon: SVG.gauge, gate: isManagerUp },
    { id: "flags", label: "Reports", icon: SVG.flag, gate: isManagerUp },
    { id: "signals", label: "Signals", icon: SVG.signal, gate: isManagerUp },
    { id: "broadcast", label: "Broadcast", icon: SVG.mega, gate: isAdminUp },
    { id: "audit", label: "Audit log", icon: SVG.scroll, gate: isAdminUp }
  ];

  function open() {
    if (!isManagerUp()) return; // server enforces too
    injectCSS();
    var prev = document.getElementById("dqc-ov"); if (prev) prev.remove();

    var ov = ce2("div"); ov.id = "dqc-ov"; applyVars(ov);
    var tabs = TABS.filter(function (x) { return x.gate(); });

    ov.innerHTML =
      '<div class="dqc-bar">' +
        '<div class="dqc-id">' +
          '<div class="dqc-logo">' + SVG.shield + '</div>' +
          '<div style="min-width:0">' +
            '<div class="dqc-ttl">DrFX Quant <span>Console</span></div>' +
            '<div class="dqc-sub">Moderation · Signals · Broadcast · Audit</div>' +
          '</div>' +
        '</div>' +
        '<span class="dqc-secure">' + SVG.shield + (isAdminUp() ? "ADMIN" : "MANAGER") + '</span>' +
        '<div class="dqc-tools">' +
          '<button class="dqc-ib" id="dqc-refresh" title="Refresh">' + SVG.refresh + '</button>' +
          '<button class="dqc-ib cl" id="dqc-close" title="Close">' + SVG.close + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="dqc-tabs" id="dqc-tabs">' +
        tabs.map(function (x) {
          return '<button class="dqc-tab" data-tab="' + x.id + '">' + x.icon + '<span>' + x.label + '</span>' +
            (x.id === "flags" ? '<span class="pip" id="dqc-pip"></span>' : "") + '</button>';
        }).join("") +
      '</div>' +
      '<div class="dqc-body"><div class="dqc-wrap" id="dqc-content"></div></div>';

    document.body.appendChild(ov);
    ST.ov = ov;

    ov.querySelector("#dqc-close").onclick = close;
    ov.querySelector("#dqc-refresh").onclick = function () { setTab(ST.tab, true); };
    ov.querySelectorAll(".dqc-tab").forEach(function (b) { b.onclick = function () { setTab(b.dataset.tab); }; });
    document.addEventListener("keydown", onKey);

    // default tab + live flag count for the pip
    if (tabs.length && !tabs.some(function (x) { return x.id === ST.tab; })) ST.tab = tabs[0].id;
    setTab(ST.tab, true);
    refreshPip();

    // auto-refresh the overview while it's the active tab
    ST.timer = setInterval(function () {
      if (!document.getElementById("dqc-ov")) return;
      if (ST.tab === "overview") panelOverview(content(), true);
      refreshPip();
    }, 20000);
  }

  function content() { return ST.ov && ST.ov.querySelector("#dqc-content"); }

  function onKey(e) {
    if (e.key !== "Escape") return;
    var sheet = document.querySelector(".dqc-sheet-ov");
    if (sheet) { sheet.remove(); return; }
    close();
  }

  function close() {
    if (ST.timer) { clearInterval(ST.timer); ST.timer = null; }
    document.removeEventListener("keydown", onKey);
    var sh = document.querySelector(".dqc-sheet-ov"); if (sh) sh.remove();
    if (ST.ov) ST.ov.remove();
    ST.ov = null;
  }

  function setTab(id, force) {
    if (!ST.ov) return;
    if (!force && id === ST.tab && content() && content().children.length) return;
    ST.tab = id;
    ST.ov.querySelectorAll(".dqc-tab").forEach(function (b) { b.classList.toggle("on", b.dataset.tab === id); });
    var host = content(); if (!host) return;
    host.innerHTML = loadingBox();
    if (id === "overview") panelOverview(host);
    else if (id === "flags") panelFlags(host);
    else if (id === "signals") panelSignals(host);
    else if (id === "broadcast") panelBroadcast(host);
    else if (id === "audit") panelAudit(host);
  }

  // keep the Reports tab badge in sync with the open-flag count
  function refreshPip() {
    if (!ST.ov || !isManagerUp()) return;
    api("/manage/health").then(function (d) {
      ST.openFlags = d.openFlags || 0;
      var pip = ST.ov && ST.ov.querySelector("#dqc-pip");
      if (pip) { pip.textContent = ST.openFlags > 99 ? "99+" : ST.openFlags; pip.classList.toggle("show", ST.openFlags > 0); }
    }).catch(function () {});
  }

  /* ============================== Overview ============================== */
  function kpi(icon, value, label, color, jump) {
    return '<div class="dqc-kpi' + (jump ? " dqc-clk" : "") + '"' + (jump ? ' data-jump="' + jump + '"' : "") + ' style="--kc:' + color + '">' +
      '<div class="dqc-kpi-ic">' + icon + '</div>' +
      '<div class="dqc-kpi-v">' + esc2(value) + '</div>' +
      '<div class="dqc-kpi-l">' + esc2(label) + '</div></div>';
  }
  function liveCard(s) {
    if (!s) {
      return '<div class="dqc-live"><div class="dqc-live-ic">' + SVG.radio + '</div>' +
        '<div><div style="font-weight:700;color:var(--c-t2);font-size:13.5px">No live session in progress</div>' +
        '<div style="color:var(--c-t4);font-size:12px;margin-top:2px">When an operator goes live it appears here.</div></div></div>';
    }
    return '<div class="dqc-live on"><div class="dqc-live-ic">' + SVG.radio + '</div>' +
      '<div style="flex:1;min-width:0"><div style="display:flex;align-items:center;gap:8px"><span style="color:#ef4444;font-weight:800;font-size:11px;letter-spacing:.5px" class="dqc-pulse">● LIVE</span>' +
      '<span style="font-weight:800;color:var(--c-t1);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc2(s.title || "Live session") + '</span></div>' +
      '<div style="color:var(--c-t3);font-size:12px;margin-top:3px">host #' + esc2(s.host_id) + ' · peak ' + fmt(s.viewer_peak || 0) + ' viewers · started ' + esc2(ago(s.started_at)) + '</div></div></div>';
  }
  function panelOverview(host, silent) {
    if (!silent) host.innerHTML = '<div class="dqc-h">' + SVG.gauge + 'Live system snapshot</div>' + '<div class="dqc-kpis" id="dqc-ovk"></div>';
    api("/manage/health").then(function (d) {
      ST.openFlags = d.openFlags || 0;
      var kpis =
        kpi(SVG.plug, d.socketsConnected == null ? "—" : fmt(d.socketsConnected), "Online sockets", "var(--c-pri)") +
        kpi(SVG.flag, fmt(d.openFlags), "Open reports", d.openFlags ? "var(--c-warn)" : "var(--c-on)", "flags") +
        kpi(SVG.signal, fmt(d.signalsLast24h), "Signals · 24h", "var(--c-ac)") +
        kpi(SVG.alert, fmt(d.rejectedWebhooksLast24h), "Rejected hooks · 24h", d.rejectedWebhooksLast24h ? "var(--c-bad)" : "var(--c-on)") +
        kpi(SVG.clock, dur(d.uptimeSeconds), "Uptime", "var(--c-t2)") +
        kpi(SVG.chip, fmt(d.memoryMB) + " MB", "Memory · RSS", "var(--c-t2)");
      host.innerHTML =
        '<div class="dqc-h">' + SVG.gauge + 'Live system snapshot</div>' +
        '<div class="dqc-kpis">' + kpis + '</div>' +
        liveCard(d.liveSession) +
        '<div class="dqc-note">Operational snapshot from <span class="dqc-mono">/manage/health</span>. Auto-refreshes every 20s while this tab is open.</div>';
      host.querySelectorAll("[data-jump]").forEach(function (el) { el.onclick = function () { setTab(el.dataset.jump); }; });
      refreshPip();
    }).catch(function (e) {
      if (!silent || !host.children.length) host.innerHTML = failBox("Couldn't load health: " + errMsg(e));
    });
  }

  /* =============================== Reports ============================== */
  var FLAG_STATUS = ["open", "reviewing", "resolved", "dismissed"];
  var flagState = { status: "open" };
  function statusColor(s) {
    if (s === "open") return "var(--c-warn)";
    if (s === "reviewing") return "var(--c-pri)";
    if (s === "resolved") return "var(--c-on)";
    return "var(--c-t3)"; // dismissed
  }
  function panelFlags(host) {
    host.innerHTML =
      '<div class="dqc-h">' + SVG.flag + 'Moderation queue</div>' +
      '<div class="dqc-chips" id="dqc-fchips">' +
        FLAG_STATUS.map(function (s) {
          return '<button class="dqc-chip' + (s === flagState.status ? " on" : "") + '" data-s="' + s + '">' +
            s.charAt(0).toUpperCase() + s.slice(1) + '</button>';
        }).join("") +
      '</div>' +
      '<div id="dqc-flist">' + listSkeleton() + '</div>';
    host.querySelectorAll("#dqc-fchips .dqc-chip").forEach(function (b) {
      b.onclick = function () {
        flagState.status = b.dataset.s;
        host.querySelectorAll("#dqc-fchips .dqc-chip").forEach(function (x) { x.classList.toggle("on", x.dataset.s === flagState.status); });
        loadFlags(host);
      };
    });
    loadFlags(host);
  }
  function loadFlags(host) {
    var list = host.querySelector("#dqc-flist"); if (!list) return;
    list.innerHTML = listSkeleton();
    api("/manage/flags?status=" + encodeURIComponent(flagState.status) + "&limit=100").then(function (rows) {
      if (!rows || !rows.length) {
        list.innerHTML = emptyBox(flagState.status === "open" ? "No open reports — you're all caught up." : "No " + flagState.status + " reports.");
        return;
      }
      list.innerHTML = rows.map(flagCard).join("");
      rows.forEach(function (f) {
        var el = list.querySelector('[data-fid="' + f.id + '"]'); if (!el) return;
        var del = el.querySelector('[data-a="del"]'), res = el.querySelector('[data-a="res"]'), dis = el.querySelector('[data-a="dis"]');
        if (del) del.onclick = function () { resolveFlag(host, f, "del"); };
        if (res) res.onclick = function () { resolveFlag(host, f, "res"); };
        if (dis) dis.onclick = function () { resolveFlag(host, f, "dis"); };
      });
      refreshPip();
    }).catch(function (e) { list.innerHTML = failBox(errMsg(e)); });
  }
  function flagCard(f) {
    var col = statusColor(f.status);
    var actionable = f.status === "open" || f.status === "reviewing";
    var msg = (f.message_content == null || f.message_content === "") ? "(no text — media or empty message)" : f.message_content;
    var acts = actionable
      ? '<div class="dqc-acts">' +
          (f.message_deleted ? "" : '<button class="dqc-act bad" data-a="del">' + SVG.trash + 'Delete &amp; resolve</button>') +
          '<button class="dqc-act ok" data-a="res">' + SVG.check + 'Resolve</button>' +
          '<button class="dqc-act mut" data-a="dis">Dismiss</button>' +
        '</div>'
      : '';
    return '<div class="dqc-flag" data-fid="' + f.id + '">' +
      '<div class="dqc-flag-top">' +
        '<span class="dqc-who">' + SVG.user + '<b>' + esc2(f.author_name || ("#" + f.author_id)) + '</b></span>' +
        '<span style="color:var(--c-t4);font-size:11px">reported by ' + esc2(f.reporter_name || ("#" + f.reporter_id)) + ' · chat #' + esc2(f.chat_id) + '</span>' +
        (f.message_deleted ? '<span class="dqc-badge-del">deleted</span>' : '') +
        '<span class="dqc-pill" style="background:color-mix(in srgb,' + col + ' 16%,transparent);color:' + col + '">' + esc2(f.status) + '</span>' +
        '<span class="dqc-time">' + esc2(ago(f.created_at)) + '</span>' +
      '</div>' +
      '<div class="dqc-msg">' + esc2(msg) + '</div>' +
      (f.reason ? '<div class="dqc-reason"><span>reason:</span> ' + esc2(f.reason) + '</div>' : '<div class="dqc-reason"><span>no reason given</span></div>') +
      acts +
    '</div>';
  }
  function resolveFlag(host, f, mode) {
    var del = mode === "del", dismiss = mode === "dis";
    sheet({
      title: del ? "Delete message & resolve" : (dismiss ? "Dismiss report" : "Resolve report"),
      intro: del
        ? "The reported message will be soft-deleted for everyone in the chat, and this report marked resolved."
        : (dismiss ? "The report will be dismissed. The message stays in the chat." : "The report will be marked resolved. The message stays in the chat."),
      noteLabel: "Resolution note (optional)",
      danger: del,
      confirmLabel: del ? "Delete & resolve" : "Confirm",
      onConfirm: function (note) {
        var body = dismiss
          ? { action: "dismiss", resolution: note || undefined }
          : { action: "resolve", deleteMessage: del, resolution: note || undefined };
        return api("/manage/flags/" + f.id + "/resolve", { method: "POST", body: JSON.stringify(body) }).then(function () {
          toast(del ? "Message deleted · report resolved" : (dismiss ? "Report dismissed" : "Report resolved"), "#" + f.id);
          loadFlags(host);
        });
      }
    });
  }

  /* =============================== Signals ============================== */
  var SIDES = ["buy", "sell", "long", "short", "close", "alert"];
  function sideColor(side) {
    side = (side || "").toLowerCase();
    if (side === "buy" || side === "long") return "var(--c-on)";
    if (side === "sell" || side === "short") return "var(--c-bad)";
    return "var(--c-ac)";
  }
  function panelSignals(host) {
    host.innerHTML =
      '<div class="dqc-h">' + SVG.signal + 'Publish a signal</div>' +
      '<div class="dqc-card">' +
        '<div class="dqc-grid2">' +
          '<div class="dqc-f"><label class="dqc-lbl">Symbol *</label><input id="sg-sym" class="gi dqc-mono" placeholder="e.g. XAUUSD" style="font-size:14px" autocomplete="off"/></div>' +
          '<div class="dqc-f"><label class="dqc-lbl">Side *</label><select id="sg-side" class="gi" style="font-size:14px">' +
            SIDES.map(function (s) { return '<option value="' + s + '">' + s.toUpperCase() + '</option>'; }).join("") + '</select></div>' +
        '</div>' +
        '<div class="dqc-grid3">' +
          '<div class="dqc-f"><label class="dqc-lbl">Entry price</label><input id="sg-price" class="gi dqc-mono" type="number" step="any" placeholder="—" style="font-size:14px"/></div>' +
          '<div class="dqc-f"><label class="dqc-lbl">Stop loss</label><input id="sg-sl" class="gi dqc-mono" type="number" step="any" placeholder="—" style="font-size:14px"/></div>' +
          '<div class="dqc-f"><label class="dqc-lbl">Take profit</label><input id="sg-tp" class="gi dqc-mono" type="number" step="any" placeholder="—" style="font-size:14px"/></div>' +
        '</div>' +
        '<div class="dqc-grid2">' +
          '<div class="dqc-f"><label class="dqc-lbl">Timeframe</label><input id="sg-tf" class="gi" placeholder="e.g. 4H" style="font-size:14px" autocomplete="off"/></div>' +
          '<div class="dqc-f"><label class="dqc-lbl">Strategy</label><input id="sg-strat" class="gi" placeholder="e.g. Breakout" style="font-size:14px" autocomplete="off"/></div>' +
        '</div>' +
        '<div class="dqc-f"><label class="dqc-lbl">Note</label><textarea id="sg-note" class="dqc-area" placeholder="Optional context shown with the signal…"></textarea></div>' +
        '<div class="dqc-f"><label class="dqc-lbl">Destination</label><select id="sg-ch" class="gi" style="font-size:14px"><option value="">Global broadcast (all signal subscribers)</option></select></div>' +
      '</div>' +
      '<div class="dqc-h">' + SVG.radio + 'Preview</div>' +
      '<div id="sg-prev"></div>' +
      '<div style="margin-top:14px"><button class="dqc-pri" id="sg-go">Publish signal</button></div>' +
      '<div class="dqc-note">Posts to <span class="dqc-mono">/manage/signals/manual</span>. A channel target also drops it into that chat; “Global broadcast” reaches everyone subscribed to the signals stream.</div>';

    // optional channel picker (needs signals:manage_channels — admins only)
    var sel = host.querySelector("#sg-ch");
    if (isAdminUp()) {
      api("/manage/signal-channels").then(function (rows) {
        var act = (rows || []).filter(function (c) { return c.active; });
        if (!act.length) return;
        var opts = '<option value="">Global broadcast (all signal subscribers)</option>';
        act.forEach(function (c) {
          opts += '<option value="' + c.id + '">#' + esc2(c.slug) + (c.chat_name ? " · " + esc2(c.chat_name) : "") + (c.visibility === "private" ? " (private)" : "") + '</option>';
        });
        sel.innerHTML = opts;
      }).catch(function () { /* leave the single global option */ });
    }

    function read() {
      return {
        symbol: host.querySelector("#sg-sym").value.trim().toUpperCase(),
        side: host.querySelector("#sg-side").value,
        price: host.querySelector("#sg-price").value.trim(),
        sl: host.querySelector("#sg-sl").value.trim(),
        tp: host.querySelector("#sg-tp").value.trim(),
        tf: host.querySelector("#sg-tf").value.trim(),
        strat: host.querySelector("#sg-strat").value.trim(),
        note: host.querySelector("#sg-note").value.trim(),
        ch: host.querySelector("#sg-ch").value
      };
    }
    function paint() { host.querySelector("#sg-prev").innerHTML = sigPreview(read()); }
    ["sg-sym", "sg-side", "sg-price", "sg-sl", "sg-tp", "sg-tf", "sg-strat", "sg-note"].forEach(function (id) {
      var el = host.querySelector("#" + id); if (el) { el.addEventListener("input", paint); el.addEventListener("change", paint); }
    });
    paint();

    host.querySelector("#sg-go").onclick = function () {
      var v = read();
      if (!v.symbol) { toast("Symbol is required"); host.querySelector("#sg-sym").focus(); return; }
      var lines = [{ k: "Symbol", v: v.symbol }, { k: "Side", v: v.side.toUpperCase() }];
      if (v.price) lines.push({ k: "Entry", v: v.price });
      if (v.sl) lines.push({ k: "Stop loss", v: v.sl });
      if (v.tp) lines.push({ k: "Take profit", v: v.tp });
      lines.push({ k: "Destination", v: v.ch ? (host.querySelector("#sg-ch").selectedOptions[0].textContent) : "Global broadcast" });
      sheet({
        title: "Publish " + v.side.toUpperCase() + " " + v.symbol,
        lines: lines,
        confirmLabel: "Publish",
        onConfirm: function () {
          var payload = { symbol: v.symbol, side: v.side };
          if (v.price) payload.price = v.price;
          if (v.sl) payload.stop_loss = v.sl;
          if (v.tp) payload.take_profit = v.tp;
          if (v.tf) payload.timeframe = v.tf;
          if (v.strat) payload.strategy = v.strat;
          if (v.note) payload.note = v.note;
          if (v.ch) payload.channelId = v.ch;
          return api("/manage/signals/manual", { method: "POST", body: JSON.stringify(payload) }).then(function () {
            toast("Signal published", v.side.toUpperCase() + " " + v.symbol);
            ["sg-sym", "sg-price", "sg-sl", "sg-tp", "sg-tf", "sg-strat", "sg-note"].forEach(function (id) { var el = host.querySelector("#" + id); if (el) el.value = ""; });
            paint();
          });
        }
      });
    };
  }
  function sigPreview(v) {
    var col = sideColor(v.side);
    function row(k, val) { return val ? '<div class="dqc-prev-row"><span>' + k + '</span><b>' + esc2(val) + '</b></div>' : ''; }
    var rows = row("Entry", v.price) + row("Stop loss", v.sl) + row("Take profit", v.tp) + row("Timeframe", v.tf) + row("Strategy", v.strat);
    return '<div class="dqc-prev">' +
      '<div class="dqc-prev-top">' +
        '<span class="dqc-prev-sym">' + esc2(v.symbol || "SYMBOL") + '</span>' +
        '<span class="dqc-prev-side" style="background:color-mix(in srgb,' + col + ' 18%,transparent);color:' + col + '">' + esc2((v.side || "side").toUpperCase()) + '</span>' +
      '</div>' +
      (rows ? '<div class="dqc-prev-rows">' + rows + '</div>' : '<div style="color:var(--c-t4);font-size:12.5px">Add price, SL/TP, or context below.</div>') +
      (v.note ? '<div class="dqc-prev-note">' + esc2(v.note) + '</div>' : '') +
    '</div>';
  }

  /* ============================== Broadcast ============================= */
  var bcState = { level: "info", audience: "all", audienceFilter: "user" };
  function levelColor(l) { return l === "critical" ? "var(--c-bad)" : (l === "warning" ? "var(--c-warn)" : "var(--c-pri)"); }
  function audienceLabel() {
    if (bcState.audience === "subscribers") return "PRO subscribers";
    if (bcState.audience === "role") return (bcState.audienceFilter || "user") + "s";
    return "everyone";
  }
  function panelBroadcast(host) {
    host.innerHTML =
      '<div class="dqc-h">' + SVG.mega + 'Send an announcement</div>' +
      '<div class="dqc-card">' +
        '<div class="dqc-f"><label class="dqc-lbl">Title</label><input id="bc-title" class="gi" placeholder="Short headline (optional)" style="font-size:14px" maxlength="120"/></div>' +
        '<div class="dqc-f"><label class="dqc-lbl">Message *</label><textarea id="bc-body" class="dqc-area" placeholder="What do you want to announce?" maxlength="2000"></textarea></div>' +
        '<div class="dqc-f"><label class="dqc-lbl">Severity</label>' +
          seg("bc-level", [["info", "Info", "var(--c-pri)"], ["warning", "Warning", "var(--c-warn)"], ["critical", "Critical", "var(--c-bad)"]], bcState.level) + '</div>' +
        '<div class="dqc-f"><label class="dqc-lbl">Audience</label>' +
          seg("bc-aud", [["all", "Everyone"], ["subscribers", "PRO subscribers"], ["role", "By role"]], bcState.audience) + '</div>' +
        '<div class="dqc-f" id="bc-role-wrap" style="display:none"><label class="dqc-lbl">Role</label>' +
          '<select id="bc-role" class="gi" style="font-size:14px">' +
            ["user", "manager", "admin", "superadmin"].map(function (r) { return '<option value="' + r + '"' + (r === bcState.audienceFilter ? " selected" : "") + '>' + r + '</option>'; }).join("") +
          '</select></div>' +
      '</div>' +
      '<div class="dqc-h">' + SVG.radio + 'Preview</div>' +
      '<div id="bc-prev"></div>' +
      '<div style="margin-top:14px"><button class="dqc-pri" id="bc-go">Send broadcast</button></div>' +
      '<div class="dqc-note">Delivered in real time via <span class="dqc-mono">/manage/broadcast</span>. “Everyone” and “Critical” require a typed confirmation.</div>';

    function paint() {
      host.querySelector("#bc-prev").innerHTML = bcPreview({
        title: host.querySelector("#bc-title").value.trim(),
        body: host.querySelector("#bc-body").value.trim()
      });
    }
    wireSeg(host, "bc-level", function (v) { bcState.level = v; paint(); });
    wireSeg(host, "bc-aud", function (v) {
      bcState.audience = v;
      host.querySelector("#bc-role-wrap").style.display = v === "role" ? "" : "none";
      paint();
    });
    var roleSel = host.querySelector("#bc-role"); if (roleSel) roleSel.onchange = function () { bcState.audienceFilter = roleSel.value; paint(); };
    host.querySelector("#bc-title").addEventListener("input", paint);
    host.querySelector("#bc-body").addEventListener("input", paint);
    if (bcState.audience === "role") host.querySelector("#bc-role-wrap").style.display = "";
    paint();

    host.querySelector("#bc-go").onclick = function () {
      var title = host.querySelector("#bc-title").value.trim();
      var body = host.querySelector("#bc-body").value.trim();
      if (!body) { toast("Message body is required"); host.querySelector("#bc-body").focus(); return; }
      var hard = bcState.audience === "all" || bcState.level === "critical";
      sheet({
        title: "Send " + bcState.level + " broadcast",
        lines: [
          { k: "Audience", v: audienceLabel() },
          { k: "Severity", v: bcState.level },
          { k: "Title", v: title || "—" }
        ],
        intro: "This will push a notification to " + audienceLabel() + " immediately.",
        danger: hard,
        confirmLabel: "Send broadcast",
        onConfirm: function () {
          var payload = { body: body, level: bcState.level, audience: bcState.audience };
          if (title) payload.title = title;
          if (bcState.audience === "role") payload.audienceFilter = bcState.audienceFilter;
          return api("/manage/broadcast", { method: "POST", body: JSON.stringify(payload) }).then(function (r) {
            toast("Broadcast sent", "to " + audienceLabel());
            host.querySelector("#bc-title").value = ""; host.querySelector("#bc-body").value = "";
            paint();
          });
        }
      });
    };
  }
  function bcPreview(v) {
    var col = levelColor(bcState.level);
    var icon = bcState.level === "critical" ? SVG.alert : (bcState.level === "warning" ? SVG.warn : SVG.info);
    return '<div class="dqc-bcprev" style="border-color:color-mix(in srgb,' + col + ' 45%,transparent);background:color-mix(in srgb,' + col + ' 9%,transparent)">' +
      '<div class="dqc-bcprev-ic" style="background:color-mix(in srgb,' + col + ' 18%,transparent);color:' + col + '">' + icon + '</div>' +
      '<div style="flex:1;min-width:0">' +
        (v.title ? '<div class="dqc-bcprev-t">' + esc2(v.title) + '</div>' : '') +
        '<div class="dqc-bcprev-b">' + (v.body ? esc2(v.body) : "Your announcement preview will appear here…") + '</div>' +
        '<div class="dqc-bcprev-m">to ' + esc2(audienceLabel()) + ' · from ' + esc2((S.user && (S.user.name || S.user.email)) || "you") + '</div>' +
      '</div>' +
    '</div>';
  }

  /* ================================ Audit ============================== */
  var auditState = { action: "", actorId: "" };
  function panelAudit(host) {
    host.innerHTML =
      '<div class="dqc-h">' + SVG.scroll + 'Audit log</div>' +
      '<div class="dqc-fbar">' +
        '<div><label class="dqc-lbl">Action</label><input id="au-action" class="gi dqc-mono" placeholder="e.g. broadcast.send" style="font-size:13px" autocomplete="off"/></div>' +
        '<div><label class="dqc-lbl">Actor id</label><input id="au-actor" class="gi dqc-mono" placeholder="user id" style="font-size:13px" autocomplete="off"/></div>' +
        '<div><button class="pb" id="au-go" type="button" style="padding:11px 16px">Search</button></div>' +
      '</div>' +
      '<div id="au-list">' + listSkeleton() + '</div>';
    var go = function () {
      auditState.action = host.querySelector("#au-action").value.trim();
      auditState.actorId = host.querySelector("#au-actor").value.trim();
      loadAudit(host);
    };
    host.querySelector("#au-go").onclick = go;
    host.querySelector("#au-action").addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
    host.querySelector("#au-actor").addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
    loadAudit(host);
  }
  function loadAudit(host) {
    var list = host.querySelector("#au-list"); if (!list) return;
    list.innerHTML = listSkeleton();
    var qs = ["limit=100"];
    if (auditState.action) qs.push("action=" + encodeURIComponent(auditState.action));
    if (auditState.actorId) qs.push("actorId=" + encodeURIComponent(auditState.actorId));
    api("/manage/audit?" + qs.join("&")).then(function (rows) {
      if (!rows || !rows.length) { list.innerHTML = emptyBox("No audit entries match."); return; }
      list.innerHTML = rows.map(auditRow).join("");
    }).catch(function (e) { list.innerHTML = failBox(errMsg(e)); });
  }
  function auditRow(a) {
    var meta = "";
    if (a.metadata != null && a.metadata !== "") {
      var txt = a.metadata;
      try { txt = JSON.stringify(typeof a.metadata === "string" ? JSON.parse(a.metadata) : a.metadata, null, 0); } catch (e) {}
      meta = '<div class="dqc-json">' + esc2(txt) + '</div>';
    }
    var target = (a.target_type || a.target_id != null)
      ? '<b>' + esc2(a.target_type || "target") + '</b>' + (a.target_id != null ? " #" + esc2(a.target_id) : "")
      : '<span style="color:var(--c-t4)">—</span>';
    return '<div class="dqc-aud">' +
      '<div class="dqc-aud-top">' +
        '<span class="dqc-aud-act">' + esc2(a.action) + '</span>' +
        '<span class="dqc-time" style="margin-left:auto">' + esc2(when(a.created_at)) + '</span>' +
      '</div>' +
      '<div class="dqc-aud-meta">by <b>' + esc2(a.actor_name || ("#" + a.actor_id)) + '</b>' +
        (a.actor_role ? ' (' + esc2(a.actor_role) + ')' : '') +
        ' · target ' + target +
        (a.ip ? ' · <span class="dqc-mono">' + esc2(a.ip) + '</span>' : '') + '</div>' +
      meta +
    '</div>';
  }

  /* =========================== shared controls ========================== */
  function seg(name, items, current) {
    return '<div class="dqc-seg" data-seg="' + name + '">' +
      items.map(function (it) {
        return '<button type="button" data-val="' + it[0] + '" class="' + (it[0] === current ? "on" : "") + '"' +
          (it[2] ? ' style="--sc:' + it[2] + '"' : '') + '>' + esc2(it[1]) + '</button>';
      }).join("") + '</div>';
  }
  function wireSeg(host, name, onPick) {
    var box = host.querySelector('[data-seg="' + name + '"]'); if (!box) return;
    box.querySelectorAll("button").forEach(function (b) {
      b.onclick = function () {
        box.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
        onPick(b.dataset.val);
      };
    });
  }

  /* -------- confirmation sheet (optional note + optional CONFIRM) -------- */
  function sheet(opts) {
    var sc = ce2("div"); sc.className = "dqc-sheet-ov";
    var lines = (opts.lines || []).map(function (l) {
      return '<div style="display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:13px">' +
        '<span style="color:var(--c-t3)">' + esc2(l.k) + '</span>' +
        '<span style="color:var(--c-t1);font-weight:700;text-align:right;word-break:break-word">' + esc2(l.v) + '</span></div>';
    }).join("");
    var hasNote = !!opts.noteLabel;
    var danger = !!opts.danger;
    sc.innerHTML =
      '<div class="dqc-sheet">' +
        '<div class="dqc-sheet-h">' + esc2(opts.title || "Confirm") + '</div>' +
        '<div class="dqc-sheet-b">' +
          (opts.intro ? '<p>' + esc2(opts.intro) + '</p>' : '') +
          (lines ? '<div style="background:var(--c-inp);border:1px solid var(--c-bd);border-radius:12px;padding:11px 13px;margin-bottom:13px">' + lines + '</div>' : '') +
          (hasNote ? '<label class="dqc-lbl">' + esc2(opts.noteLabel) + '</label><textarea id="dqc-sheet-note" class="dqc-area" style="min-height:62px;margin-bottom:' + (danger ? "13px" : "2px") + '"></textarea>' : '') +
          (danger ? '<div class="dqc-sheet-warn">High-impact action. Type <b>CONFIRM</b> to proceed.</div><input id="dqc-sheet-cf" class="gi dqc-mono" placeholder="CONFIRM" autocomplete="off" style="font-size:14px"/>' : '') +
          '<div class="dqc-sheet-err" id="dqc-sheet-err" style="display:none"></div>' +
        '</div>' +
        '<div class="dqc-sheet-f">' +
          '<button class="dqc-btn" id="dqc-sheet-x" type="button">Cancel</button>' +
          '<button class="dqc-btn go' + (danger ? " danger" : "") + '" id="dqc-sheet-go" type="button"' + (danger ? " disabled" : "") + '>' + esc2(opts.confirmLabel || "Confirm") + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(sc);
    sc.addEventListener("click", function (e) { if (e.target === sc) sc.remove(); });
    var go = sc.querySelector("#dqc-sheet-go"), cf = sc.querySelector("#dqc-sheet-cf"), note = sc.querySelector("#dqc-sheet-note"), err = sc.querySelector("#dqc-sheet-err");
    sc.querySelector("#dqc-sheet-x").onclick = function () { sc.remove(); };
    if (cf) { cf.oninput = function () { var ok = cf.value.trim().toUpperCase() === "CONFIRM"; go.disabled = !ok; }; setTimeout(function () { cf.focus(); }, 30); }
    else if (note) setTimeout(function () { note.focus(); }, 30);
    go.onclick = function () {
      if (cf && cf.value.trim().toUpperCase() !== "CONFIRM") return;
      go.disabled = true; go.textContent = "Working…"; if (err) err.style.display = "none";
      Promise.resolve(opts.onConfirm(note ? note.value.trim() : "")).then(function () { sc.remove(); })
        .catch(function (e) {
          go.disabled = false; go.textContent = opts.confirmLabel || "Confirm";
          if (err) { err.textContent = errMsg(e); err.style.display = "block"; }
        });
    };
  }

  window.dqConsole = open;
})();
