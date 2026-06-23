/* ============================================================================
   DrFX Quant — In-app Admin Dashboard  (window.dqAdminDashboard)
   ----------------------------------------------------------------------------
   A full-screen overlay rendered INSIDE the SPA (same pattern as the QNTM
   Control Deck). It reuses the app globals: t (theme), S (state), api(), and
   avatar(). Everything else is self-contained. openAdmin() delegates here when
   this file is loaded; if it isn't, the original modal still works.

   Endpoints (admin-guarded server-side):
     GET    /admin/stats
     GET    /admin/users?page=&q=
     POST   /admin/users/:id/block | /unblock
     POST   /admin/users/:id/subscription   {status:'active',days} | {status:'free'}
     DELETE /admin/users/:id
   ========================================================================== */
(function () {
  "use strict";

  /* ---- tiny self-contained helpers (no app coupling) ---- */
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var fmt = function (n) { return (Number(n) || 0).toLocaleString("en-US"); };
  var pct = function (v, tot) { tot = tot || 0; return tot ? Math.round((v / tot) * 100) : 0; };
  var fmtDate = function (d) {
    try { return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
    catch (e) { return ""; }
  };
  var ce = function (tag) { return document.createElement(tag); };

  /* ---- inline SVG icons ---- */
  var SVG = {
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    deck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 4v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    wallet: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2l8 4v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" fill="currentColor" opacity=".22" stroke="currentColor" stroke-width="1.5"/><path d="M9.5 12.5l2 2 3.5-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    chevL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    chevR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    starFill: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l2.9 6.1 6.6.9-4.8 4.6 1.2 6.5L12 17.8 6.1 20.2l1.2-6.5L2.5 9l6.6-.9z"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    ban: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    msg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    wizadd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>'
  };

  /* ---- one-time CSS injection (structure + responsive + animation) ---- */
  function injectCSS() {
    if (document.getElementById("dqa-css")) return;
    var s = ce("style"); s.id = "dqa-css";
    s.textContent = [
      "#dqa-ov{position:fixed;inset:0;z-index:9500;display:flex;flex-direction:column;",
      "background:var(--dqa-bg,#05091c);font-family:'Outfit',system-ui,-apple-system,sans-serif;",
      "color:var(--dqa-t1,#e7eeff);animation:dqaFade .22s ease;overflow:hidden}",
      "#dqa-ov *{box-sizing:border-box}",
      "@keyframes dqaFade{from{opacity:0}to{opacity:1}}",
      "@keyframes dqaRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}",
      "@keyframes dqaSpin{to{transform:rotate(360deg)}}",
      "@keyframes dqaPulse{0%{box-shadow:0 0 0 0 rgba(52,210,122,.5)}70%{box-shadow:0 0 0 7px rgba(52,210,122,0)}100%{box-shadow:0 0 0 0 rgba(52,210,122,0)}}",
      ".dqa-spin{animation:dqaSpin 1s linear infinite}",
      /* topbar */
      ".dqa-bar{display:flex;align-items:center;gap:11px;flex-wrap:wrap;padding:calc(var(--sat,0px) + 11px) 16px 11px;background:var(--dqa-card);border-bottom:1px solid var(--dqa-bd);flex-shrink:0}",
      ".dqa-id{display:flex;align-items:center;gap:10px;flex:0 1 auto;min-width:0;overflow:hidden}",
      ".dqa-brand{flex:0 1 auto;min-width:0;overflow:hidden}",
      ".dqa-tools{display:flex;align-items:center;gap:8px;flex:0 0 auto;margin-left:auto}",
      ".dqa-win{display:flex;align-items:center;gap:8px;flex:0 0 auto}",
      ".dqa-logo{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;flex-shrink:0;background:linear-gradient(135deg,#1f8bff,#2f6bff);box-shadow:0 6px 16px rgba(28,132,255,.42)}",
      ".dqa-logo svg{width:20px;height:20px}",
      ".dqa-ttl{font-size:16px;font-weight:800;line-height:1.05;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dqa-sub{font-size:11px;color:var(--dqa-t3);font-weight:500;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dqa-secure{display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border-radius:9px;background:rgba(52,211,122,.12);border:1px solid rgba(52,211,122,.32);color:#34d27a;font-size:10px;font-weight:800;letter-spacing:.8px;white-space:nowrap;flex-shrink:0}",
      ".dqa-secure svg{width:12px;height:12px}",
      ".dqa-chip{display:flex;align-items:center;gap:9px;padding:7px 12px;border-radius:13px;background:var(--dqa-card);border:1px solid var(--dqa-bl);cursor:pointer;flex-shrink:0;transition:.15s}",
      ".dqa-chip:hover{border-color:var(--dqa-pri)}",
      ".dqa-chip .wi{width:24px;height:24px;color:var(--dqa-pri);flex-shrink:0}",
      ".dqa-chip .wl{font-size:9px;letter-spacing:.5px;font-weight:700;color:var(--dqa-t3)}",
      ".dqa-chip .wv{font-size:13px;font-weight:800;color:var(--dqa-t1)}",
      ".dqa-ib{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;cursor:pointer;flex-shrink:0;border:1px solid var(--dqa-bd);background:var(--dqa-ta);color:var(--dqa-t2);transition:.15s}",
      ".dqa-ib:hover{color:var(--dqa-t1);border-color:var(--dqa-bl)}",
      ".dqa-ib svg{width:18px;height:18px}",
      ".dqa-ib.cl:hover{color:#ff5a76;border-color:rgba(255,90,118,.4)}",
      /* body + grid */
      ".dqa-body{flex:1;min-height:0;overflow:hidden;padding:13px 16px calc(var(--sab,0px) + 13px)}",
      ".dqa-grid{height:100%;display:grid;grid-template-rows:auto 1fr;gap:12px;min-height:0}",
      ".dqa-kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:11px}",
      ".dqa-main{display:grid;grid-template-columns:minmax(290px,.92fr) 1.6fr;gap:12px;min-height:0}",
      ".dqa-charts{display:grid;grid-template-rows:1.05fr .95fr;gap:12px;min-height:0}",
      ".dqa-card{background:var(--dqa-card);border:1px solid var(--dqa-bd);border-radius:16px;padding:14px 15px;display:flex;flex-direction:column;min-height:0;animation:dqaRise .45s ease both}",
      /* kpis */
      ".dqa-kpi{background:var(--dqa-card);border:1px solid var(--dqa-bd);border-radius:15px;padding:12px 14px;display:flex;flex-direction:column;gap:6px;position:relative;overflow:hidden;animation:dqaRise .45s ease both}",
      ".dqa-kpi .ic{width:31px;height:31px;border-radius:9px;display:grid;place-items:center;background:var(--dqa-ta);color:var(--kc,var(--dqa-pri))}",
      ".dqa-kpi .ic svg{width:16px;height:16px}",
      ".dqa-kpi .nm{font-size:23px;font-weight:800;line-height:1;letter-spacing:.3px}",
      ".dqa-kpi .lb{font-size:11px;color:var(--dqa-t2);font-weight:500}",
      ".dqa-kpi .dl{font-size:10.5px;color:var(--dqa-t3);font-weight:600}",
      ".dqa-kpi .dl b{color:#34d27a}",
      /* card heading */
      ".dqa-ch{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}",
      ".dqa-ch h3{font-size:13px;font-weight:800;margin:0;letter-spacing:.3px}",
      ".dqa-ch .hint{font-size:10.5px;color:var(--dqa-t3);font-weight:600}",
      /* donut */
      ".dqa-drow{display:flex;align-items:center;gap:15px;flex:1;min-height:0}",
      ".dqa-dwrap{position:relative;flex-shrink:0;display:grid;place-items:center}",
      ".dqa-dc{position:absolute;text-align:center}",
      ".dqa-dc .n{font-size:25px;font-weight:800;line-height:1}",
      ".dqa-dc .l{font-size:9px;color:var(--dqa-t3);font-weight:700;letter-spacing:.6px;text-transform:uppercase;margin-top:2px}",
      ".dqa-leg{display:flex;flex-direction:column;gap:8px;flex:1;min-width:0}",
      ".dqa-lg{display:flex;align-items:center;gap:9px;font-size:12px}",
      ".dqa-lg .sw{width:10px;height:10px;border-radius:3px;flex-shrink:0}",
      ".dqa-lg .lt{color:var(--dqa-t2);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dqa-lg .lv{font-weight:800;color:var(--dqa-t1)}",
      ".dqa-lg .lp{font-size:10.5px;color:var(--dqa-t3);font-weight:700;min-width:34px;text-align:right}",
      ".dqa-comp{margin-top:12px}",
      ".dqa-cbar{display:flex;height:9px;border-radius:6px;overflow:hidden;background:rgba(120,160,255,.10)}",
      ".dqa-cbar span{transition:width .6s ease}",
      ".dqa-cleg{display:flex;gap:13px;margin-top:9px;flex-wrap:wrap}",
      ".dqa-cleg .ci{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dqa-t2)}",
      ".dqa-cleg .ci .sw{width:8px;height:8px;border-radius:2px}",
      ".dqa-cleg .ci b{color:var(--dqa-t1);font-weight:800}",
      /* bar chart (HTML) */
      ".dqa-bars{flex:1;display:flex;align-items:stretch;gap:8px;min-height:90px;padding-top:4px}",
      ".dqa-bcol{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;min-width:0}",
      ".dqa-btr{flex:1;width:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px;min-height:0}",
      ".dqa-bv{font-size:11px;font-weight:800;color:var(--dqa-t2);line-height:1}",
      ".dqa-bb{width:100%;max-width:30px;min-height:3px;border-radius:5px 5px 3px 3px;background:linear-gradient(to top,var(--dqa-pri),var(--dqa-ac));box-shadow:0 0 12px rgba(28,132,255,.25);transition:height .5s ease}",
      ".dqa-bl{font-size:10px;font-weight:600;color:var(--dqa-t3);line-height:1}",
      /* users */
      ".dqa-uhead{display:flex;align-items:center;gap:11px;margin-bottom:11px}",
      ".dqa-srch{flex:1;position:relative}",
      ".dqa-srch svg{position:absolute;left:12px;top:50%;transform:translateY(-50%);width:16px;height:16px;color:var(--dqa-t3)}",
      ".dqa-srch input{width:100%;background:var(--dqa-inp);border:1px solid var(--dqa-bd);border-radius:12px;color:var(--dqa-t1);font-family:inherit;font-size:13px;padding:10px 12px 10px 36px;outline:none;transition:.15s}",
      ".dqa-srch input:focus{border-color:var(--dqa-pri)}",
      ".dqa-utot{font-size:11.5px;color:var(--dqa-t3);font-weight:700;white-space:nowrap}",
      ".dqa-utot b{color:var(--dqa-t1)}",
      ".dqa-tabs{display:flex;gap:6px;margin-bottom:11px;flex-wrap:wrap}",
      ".dqa-tab{padding:6px 13px;border-radius:10px;border:1px solid var(--dqa-bd);background:transparent;color:var(--dqa-t3);font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;transition:.15s}",
      ".dqa-tab.on{border-color:var(--dqa-ba,var(--dqa-pri));background:var(--dqa-act);color:var(--dqa-ac)}",
      ".dqa-ulist{flex:1;overflow:auto;min-height:0;margin:0 -6px;padding:0 6px}",
      ".dqa-urow{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:11px;padding:9px 10px;border-radius:13px;border:1px solid transparent;transition:.14s;margin-bottom:2px}",
      ".dqa-urow:hover{background:var(--dqa-ta);border-color:var(--dqa-bd)}",
      ".dqa-ui{min-width:0}",
      ".dqa-un{display:flex;align-items:center;gap:7px;font-size:13.5px;font-weight:700;white-space:nowrap;overflow:hidden}",
      ".dqa-un .nm{overflow:hidden;text-overflow:ellipsis}",
      ".dqa-ue{font-size:11.5px;color:var(--dqa-t3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}",
      ".dqa-bdg{font-size:9.5px;font-weight:800;padding:2px 7px;border-radius:6px;letter-spacing:.4px;text-transform:uppercase;flex-shrink:0}",
      ".dqa-b-pro{background:rgba(255,210,74,.16);color:#ffd24a}",
      ".dqa-b-free{background:rgba(120,160,255,.13);color:var(--dqa-t2)}",
      ".dqa-b-adm{background:rgba(167,139,250,.18);color:#a78bfa}",
      ".dqa-b-blk{background:rgba(255,90,118,.16);color:#ff5a76}",
      ".dqa-ua{display:flex;align-items:center;gap:6px;flex-shrink:0}",
      ".dqa-iact{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;cursor:pointer;border:1px solid var(--dqa-bd);background:var(--dqa-ta);color:var(--dqa-t2);transition:.14s}",
      ".dqa-iact svg{width:15px;height:15px}",
      ".dqa-iact.gold:hover{background:rgba(255,210,74,.16);color:#ffd24a;border-color:rgba(255,210,74,.35)}",
      ".dqa-iact.red:hover{background:rgba(255,90,118,.16);color:#ff5a76;border-color:rgba(255,90,118,.35)}",
      ".dqa-iact.green:hover{background:rgba(52,210,122,.16);color:#34d27a;border-color:rgba(52,210,122,.35)}",
      ".dqa-iact[disabled]{opacity:.3;pointer-events:none}",
      ".dqa-ufoot{display:flex;align-items:center;justify-content:space-between;padding-top:11px;margin-top:2px;border-top:1px solid var(--dqa-bd)}",
      ".dqa-pgi{font-size:11.5px;color:var(--dqa-t3);font-weight:700}",
      ".dqa-pgb{display:flex;gap:7px}",
      ".dqa-pg{display:flex;align-items:center;gap:4px;padding:7px 11px;border-radius:10px;border:1px solid var(--dqa-bd);background:var(--dqa-ta);color:var(--dqa-t1);font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}",
      ".dqa-pg svg{width:14px;height:14px}",
      ".dqa-pg[disabled]{opacity:.35;pointer-events:none}",
      ".dqa-empty{flex:1;display:grid;place-items:center;color:var(--dqa-t3);font-size:13px;text-align:center;gap:8px;padding:24px}",
      ".dqa-skel{height:58px;border-radius:13px;margin:5px 4px;background:linear-gradient(90deg,rgba(120,160,255,.05),rgba(120,160,255,.12),rgba(120,160,255,.05));background-size:200% 100%;animation:dqaSh 1.3s infinite}",
      "@keyframes dqaSh{to{background-position:-200% 0}}",
      /* modal + toast */
      ".dqa-mbg{position:fixed;inset:0;z-index:9700;display:grid;place-items:center;padding:24px;background:rgba(2,5,16,.66);backdrop-filter:blur(4px);animation:dqaFade .16s ease}",
      ".dqa-modal{max-width:380px;width:100%;background:var(--dqa-mod,#0b122c);border:1px solid var(--dqa-bl);border-radius:18px;padding:24px;animation:dqaRise .2s ease both}",
      ".dqa-modal h4{margin:0 0 8px;font-size:17px;font-weight:800}",
      ".dqa-modal p{margin:0 0 20px;font-size:13px;color:var(--dqa-t2);line-height:1.5}",
      ".dqa-modal p b{color:var(--dqa-t1)}",
      ".dqa-mact{display:flex;gap:10px;justify-content:flex-end}",
      ".dqa-mbtn{padding:9px 15px;border-radius:11px;border:1px solid var(--dqa-bd);background:var(--dqa-ta);color:var(--dqa-t1);font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}",
      ".dqa-mbtn.dang{background:linear-gradient(135deg,#ff5a76,#e0364f);border-color:transparent;color:#fff}",
      "#dqa-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);z-index:9800;background:var(--dqa-mod,#0b122c);border:1px solid var(--dqa-bl);border-radius:13px;padding:11px 17px;font-size:13px;font-weight:600;opacity:0;pointer-events:none;transition:.28s;display:flex;align-items:center;gap:9px;box-shadow:0 12px 34px rgba(0,0,0,.45)}",
      "#dqa-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}",
      "#dqa-toast.ok{border-color:rgba(52,210,122,.45)}#dqa-toast.ok .ti{color:#34d27a}",
      "#dqa-toast.err{border-color:rgba(255,90,118,.45)}#dqa-toast.err .ti{color:#ff5a76}",
      "#dqa-toast .ti{width:17px;height:17px;flex-shrink:0}",
      /* responsive: desktop = one screen no scroll; tablet/phone = stack + scroll */
      "@media (max-width:980px){",
      "#dqa-ov{overflow:auto}",
      ".dqa-body{overflow:visible;height:auto}",
      ".dqa-grid{height:auto}",
      ".dqa-main{grid-template-columns:1fr}",
      ".dqa-charts{grid-template-rows:none}",
      ".dqa-card.cm{min-height:230px}",
      ".dqa-kpis{grid-template-columns:repeat(3,1fr)}",
      ".dqa-ulist{max-height:62vh}",
      "}",
      "@media (max-width:640px){",
      ".dqa-id{flex:1 1 0%;order:0;overflow:visible}",
      ".dqa-win{order:1;flex:0 0 auto}",
      ".dqa-tools{order:2;flex:1 1 100%;margin-left:0}",
      ".dqa-chip{flex:1 1 auto;min-width:0;justify-content:flex-start}",
      "}",
      "@media (max-width:560px){",
      ".dqa-kpis{grid-template-columns:repeat(2,1fr)}",
      ".dqa-hideS{display:none}",
      ".dqa-sub{display:none}",
      "}"
    ].join("");
    document.head.appendChild(s);
  }

  /* ---- map current theme (t) onto CSS variables on the overlay root ---- */
  function applyVars(ov) {
    var map = {
      bg: t.bg, card: t.cd, card2: t.ch, bd: t.bd, bl: t.bl, ba: t.ba,
      t1: t.t1, t2: t.t2, t3: t.t3, t4: t.t4, pri: t.pr, ac: t.ac,
      ta: t.ta, act: t.act, on: t.on, mod: t.mod, inp: t.inp
    };
    for (var k in map) ov.style.setProperty("--dqa-" + k, map[k] == null ? "" : map[k]);
  }

  /* ---- charts ---- */
  function donutSVG(segs, size, th) {
    size = size || 138; th = th || 19;
    var r = (size - th) / 2, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r;
    var total = segs.reduce(function (a, b) { return a + b.value; }, 0) || 1, off = 0, arcs = "";
    segs.forEach(function (sg) {
      var len = (sg.value / total) * C;
      if (sg.value > 0) arcs += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + sg.color + '" stroke-width="' + th + '" stroke-dasharray="' + len + ' ' + (C - len) + '" stroke-dashoffset="' + (-off) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/>';
      off += len;
    });
    return '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '"><circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="rgba(120,160,255,.10)" stroke-width="' + th + '"/>' + arcs + '</svg>';
  }
  function signupBuckets(users) {
    var lbl = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"], today = new Date(); today.setHours(0, 0, 0, 0);
    var b = [];
    for (var i = 6; i >= 0; i--) { var d = new Date(today); d.setDate(d.getDate() - i); b.push({ t: d.getTime(), label: lbl[d.getDay()], value: 0 }); }
    (users || []).forEach(function (u) {
      var c = new Date(u.created_at); c.setHours(0, 0, 0, 0);
      for (var j = 0; j < b.length; j++) if (b[j].t === c.getTime()) { b[j].value++; break; }
    });
    return b;
  }

  /* ============================ open() ============================ */
  function open() {
    if (!(typeof S !== "undefined" && S.user && S.user.role === "admin")) return; // API enforces too
    injectCSS();
    var prev = document.getElementById("dqa-ov"); if (prev) prev.remove();

    var ov = ce("div"); ov.id = "dqa-ov"; applyVars(ov);
    var bal0 = "0.00";

    ov.innerHTML =
      '<div class="dqa-bar">' +
        '<div class="dqa-id">' +
          '<div class="dqa-logo">' + SVG.logo + '</div>' +
          '<div class="dqa-brand">' +
            '<div class="dqa-ttl">DrFX Quant <span style="color:var(--dqa-pri)">Admin</span></div>' +
            '<div class="dqa-sub">Control dashboard</div>' +
          '</div>' +
          '<span class="dqa-secure dqa-hideS">' + SVG.shield + 'SECURE</span>' +
        '</div>' +
        '<div class="dqa-tools">' +
          '<div class="dqa-chip" id="dqa-wallet" title="Open your QNTM wallet">' +
            '<span class="wi">' + SVG.wallet + '</span>' +
            '<div style="line-height:1.15"><div class="wl">QNTM</div><div class="wv" id="dqa-bal">' + bal0 + '</div></div>' +
          '</div>' +
          '<button class="dqa-ib" id="dqa-deck" title="Control Deck">' + SVG.deck + '</button>' +
          '<button class="dqa-ib" id="dqa-wizadd" title="Add Wizard">' + SVG.wizadd + '</button>' +
          '<button class="dqa-ib" id="dqa-wizpanel" title="Wizard Panel">' + SVG.shield + '</button>' +
          '<button class="dqa-ib" id="dqa-gear" title="Settings">' + SVG.gear + '</button>' +
        '</div>' +
        '<div class="dqa-win">' +
          '<button class="dqa-ib" id="dqa-refresh" title="Refresh">' + SVG.refresh + '</button>' +
          '<button class="dqa-ib cl" id="dqa-close" title="Close">' + SVG.close + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="dqa-body"><div class="dqa-grid">' +
        '<div class="dqa-kpis" id="dqa-kpis"></div>' +
        '<div class="dqa-main">' +
          '<div class="dqa-charts">' +
            '<div class="dqa-card cm">' +
              '<div class="dqa-ch"><h3>Membership</h3><span class="hint" id="dqa-prorate">—</span></div>' +
              '<div class="dqa-drow"><div class="dqa-dwrap" id="dqa-donut"></div><div class="dqa-leg" id="dqa-leg"></div></div>' +
              '<div class="dqa-comp"><div class="dqa-cbar" id="dqa-cbar"></div><div class="dqa-cleg" id="dqa-cleg"></div></div>' +
            '</div>' +
            '<div class="dqa-card cm">' +
              '<div class="dqa-ch"><h3>New members</h3><span class="hint">last 7 days · recent sign-ups</span></div>' +
              '<div class="dqa-bars" id="dqa-bars"></div>' +
            '</div>' +
          '</div>' +
          '<div class="dqa-card">' +
            '<div class="dqa-uhead">' +
              '<div class="dqa-srch">' + SVG.search + '<input id="dqa-q" type="text" placeholder="Search members by name, @username or email…" autocomplete="off"/></div>' +
              '<div class="dqa-utot" id="dqa-utot"></div>' +
            '</div>' +
            '<div class="dqa-tabs" id="dqa-tabs">' +
              '<button class="dqa-tab on" data-tab="all">All</button>' +
              '<button class="dqa-tab" data-tab="pro">Pro</button>' +
              '<button class="dqa-tab" data-tab="free">Free</button>' +
              '<button class="dqa-tab" data-tab="blocked">Blocked</button>' +
            '</div>' +
            '<div class="dqa-ulist" id="dqa-ulist"></div>' +
            '<div class="dqa-ufoot"><div class="dqa-pgi" id="dqa-pgi">—</div><div class="dqa-pgb">' +
              '<button class="dqa-pg" id="dqa-prev">' + SVG.chevL + 'Prev</button>' +
              '<button class="dqa-pg" id="dqa-next">Next' + SVG.chevR + '</button>' +
            '</div></div>' +
          '</div>' +
        '</div>' +
      '</div></div>';

    document.body.appendChild(ov);

    var $ = function (id) { return ov.querySelector(id); };
    var ulist = $("#dqa-ulist");
    var state = { page: 1, q: "", pages: 1, total: 0, users: [], tab: "all", me: S.user, timer: null };

    /* ---- toast ---- */
    var toastEl = null, toastT;
    function toast(msg, kind) {
      if (!toastEl) { toastEl = ce("div"); toastEl.id = "dqa-toast"; document.body.appendChild(toastEl); }
      var ic = kind === "err"
        ? '<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
        : '<svg class="ti" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      toastEl.className = ""; toastEl.classList.add(kind || "ok");
      toastEl.innerHTML = ic + "<span>" + esc(msg) + "</span>";
      void toastEl.offsetWidth; toastEl.classList.add("show");
      clearTimeout(toastT); toastT = setTimeout(function () { if (toastEl) toastEl.classList.remove("show"); }, 2500);
    }

    /* ---- close / lifecycle ---- */
    function onKey(e) { if (e.key === "Escape") { var m = document.getElementById("dqa-mbg"); if (m) m.remove(); else close(); } }
    function close() {
      clearInterval(state.timer);
      document.removeEventListener("keydown", onKey);
      var m = document.getElementById("dqa-mbg"); if (m) m.remove();
      if (toastEl) { toastEl.remove(); toastEl = null; }
      ov.remove();
    }
    document.addEventListener("keydown", onKey);
    $("#dqa-close").onclick = close;

    /* ---- topbar actions ---- */
    $("#dqa-wallet").onclick = function () { if (window.openWallet) { close(); window.openWallet(); } };
    var deckBtn = $("#dqa-deck"); if (deckBtn) deckBtn.onclick = function () { if (window.openControlDeck) { close(); window.openControlDeck(); } };
    var wizAddBtn = $("#dqa-wizadd"); if (wizAddBtn) wizAddBtn.onclick = function () { if (window.openAddWizard) { close(); window.openAddWizard(); } };
    var wizPanelBtn = $("#dqa-wizpanel"); if (wizPanelBtn) wizPanelBtn.onclick = function () { if (window.openWizardPanel) { close(); window.openWizardPanel(); } };
    var gearBtn = $("#dqa-gear"); if (gearBtn) gearBtn.onclick = function () { if (window.openSettings) { close(); window.openSettings(); } };
    $("#dqa-refresh").onclick = function () {
      var ico = $("#dqa-refresh").firstElementChild; ico.classList.add("dqa-spin");
      Promise.all([loadStats(), loadUsers()]).catch(function () {}).then(function () { setTimeout(function () { ico.classList.remove("dqa-spin"); }, 450); });
    };

    /* ---- KPIs ---- */
    function kpi(c) {
      return '<div class="dqa-kpi" style="--kc:' + c.color + '">' +
        '<div class="ic">' + c.icon + '</div>' +
        '<div class="nm">' + fmt(c.value) + '</div>' +
        '<div class="lb">' + c.label + '</div>' +
        '<div class="dl">' + (c.delta || "") + '</div></div>';
    }
    function renderKpis(s) {
      var cards = [
        { icon: SVG.users, color: "#1c84ff", value: s.totalUsers, label: "Total members", delta: "<b>+" + fmt(s.newToday) + "</b> today" },
        { icon: SVG.starFill, color: "#ffd24a", value: s.activeUsers, label: "Pro members", delta: pct(s.activeUsers, s.totalUsers) + "% of base" },
        { icon: SVG.users, color: "#8cc4ff", value: s.freeUsers, label: "Free members", delta: pct(s.freeUsers, s.totalUsers) + "% of base" },
        { icon: SVG.msg, color: "#38bdf8", value: s.totalMessages, label: "Messages", delta: "<b>+" + fmt(s.msgsToday) + "</b> today" },
        { icon: SVG.chat, color: "#a78bfa", value: s.totalChats, label: "Chats", delta: fmt(s.groups) + " grp · " + fmt(s.channels) + " ch" },
        { icon: SVG.shield, color: "#ff5a76", value: s.blockedUsers, label: "Blocked", delta: s.blockedUsers ? "needs review" : "all clear" }
      ];
      $("#dqa-kpis").innerHTML = cards.map(kpi).join("");
    }

    /* ---- membership donut + composition ---- */
    function renderMembership(s) {
      var segs = [
        { label: "Pro members", color: "#ffd24a", value: s.activeUsers },
        { label: "Free members", color: t.pr, value: s.freeUsers }
      ];
      $("#dqa-donut").innerHTML = donutSVG(segs) + '<div class="dqa-dc"><div class="n">' + fmt(s.totalUsers) + '</div><div class="l">Members</div></div>';
      var rows = segs.concat([{ label: "Blocked", color: "#ff5a76", value: s.blockedUsers }]);
      $("#dqa-leg").innerHTML = rows.map(function (sg) {
        return '<div class="dqa-lg"><span class="sw" style="background:' + sg.color + '"></span><span class="lt">' + sg.label + '</span><span class="lv">' + fmt(sg.value) + '</span><span class="lp">' + pct(sg.value, s.totalUsers) + '%</span></div>';
      }).join("");
      $("#dqa-prorate").textContent = pct(s.activeUsers, s.totalUsers) + "% Pro";
      var dms = Math.max(0, s.totalChats - s.groups - s.channels);
      var comp = [
        { label: "Direct", color: "#38bdf8", value: dms },
        { label: "Groups", color: "#a78bfa", value: s.groups },
        { label: "Channels", color: t.pr, value: s.channels }
      ];
      var ct = comp.reduce(function (a, b) { return a + b.value; }, 0) || 1;
      $("#dqa-cbar").innerHTML = comp.map(function (c) { return '<span style="width:' + (c.value / ct * 100) + '%;background:' + c.color + '"></span>'; }).join("");
      $("#dqa-cleg").innerHTML = comp.map(function (c) { return '<div class="ci"><span class="sw" style="background:' + c.color + '"></span>' + c.label + ' <b>' + fmt(c.value) + '</b></div>'; }).join("");
    }

    /* ---- signups bar chart (HTML, responsive, no distortion) ---- */
    function renderSignups(users) {
      var b = signupBuckets(users), max = 1;
      b.forEach(function (x) { if (x.value > max) max = x.value; });
      $("#dqa-bars").innerHTML = b.map(function (x) {
        var h = Math.round(x.value / max * 100);
        return '<div class="dqa-bcol"><div class="dqa-btr">' +
          (x.value > 0 ? '<div class="dqa-bv">' + x.value + '</div>' : '') +
          '<div class="dqa-bb" style="height:' + (x.value > 0 ? h : 0) + '%"></div></div>' +
          '<div class="dqa-bl">' + x.label + '</div></div>';
      }).join("");
    }

    /* ---- user rows ---- */
    function badges(u) {
      var s = "";
      if (u.role === "admin") s += '<span class="dqa-bdg dqa-b-adm">Admin</span>';
      s += u.subscription_status === "active" ? '<span class="dqa-bdg dqa-b-pro">Pro</span>' : '<span class="dqa-bdg dqa-b-free">Free</span>';
      if (u.blocked) s += '<span class="dqa-bdg dqa-b-blk">Blocked</span>';
      return s;
    }
    function avatarHTML(u) {
      try { return avatar(u.avatar || "💬", 40, S.onlineUsers && S.onlineUsers.indexOf(u.id) >= 0); }
      catch (e) {
        var ini = esc((u.name || u.username || u.email || "?").slice(0, 1).toUpperCase());
        return '<div style="width:40px;height:40px;border-radius:11px;display:grid;place-items:center;background:var(--dqa-ta);color:var(--dqa-ac);font-weight:700">' + ini + '</div>';
      }
    }
    function userRow(u) {
      var self = state.me && u.id === state.me.id;
      var isPro = u.subscription_status === "active";
      var days = (isPro && u.subscription_expiry) ? Math.max(0, Math.ceil((new Date(u.subscription_expiry) - Date.now()) / 86400000)) : null;
      return '<div class="dqa-urow" data-id="' + u.id + '">' +
        avatarHTML(u) +
        '<div class="dqa-ui"><div class="dqa-un"><span class="nm">' + esc(u.name || u.username || u.email) + '</span>' + badges(u) + '</div>' +
        '<div class="dqa-ue">' + esc(u.email) + (u.username ? " · @" + esc(u.username) : "") + ' · ' + (isPro && days != null ? days + "d Pro left" : "joined " + fmtDate(u.created_at)) + '</div></div>' +
        '<div class="dqa-ua">' +
          '<button class="dqa-iact gold" data-act="pro" title="' + (isPro ? "Revoke Pro" : "Grant Pro (30d)") + '">' + (isPro ? SVG.x : SVG.starFill) + '</button>' +
          '<button class="dqa-iact ' + (u.blocked ? "green" : "red") + '" data-act="block" title="' + (u.blocked ? "Unblock" : "Block") + '"' + (self ? " disabled" : "") + '>' + (u.blocked ? SVG.check : SVG.ban) + '</button>' +
          '<button class="dqa-iact red" data-act="del" title="Delete"' + (self ? " disabled" : "") + '>' + SVG.trash + '</button>' +
        '</div></div>';
    }
    function filtered() {
      var list = state.users;
      if (state.tab === "pro") list = list.filter(function (u) { return u.subscription_status === "active"; });
      else if (state.tab === "free") list = list.filter(function (u) { return u.subscription_status !== "active"; });
      else if (state.tab === "blocked") list = list.filter(function (u) { return u.blocked; });
      return list;
    }
    function renderUsers() {
      var list = filtered();
      if (!list.length) {
        ulist.innerHTML = '<div class="dqa-empty">' + SVG.search + '<div>' + (state.q ? "No members match “" + esc(state.q) + "”" : "No members in this view") + '</div></div>';
      } else {
        ulist.innerHTML = list.map(userRow).join("");
      }
      $("#dqa-utot").innerHTML = "<b>" + fmt(state.total) + "</b> member" + (state.total === 1 ? "" : "s");
      $("#dqa-pgi").textContent = "Page " + state.page + " of " + (state.pages || 1);
      $("#dqa-prev").disabled = state.page <= 1;
      $("#dqa-next").disabled = state.page >= (state.pages || 1);
    }

    /* ---- loaders ---- */
    function loadStats() {
      return api("/admin/stats").then(function (s) { renderKpis(s); renderMembership(s); });
    }
    function loadUsers() {
      var qs = "?page=" + state.page + (state.q ? "&q=" + encodeURIComponent(state.q) : "");
      return api("/admin/users" + qs).then(function (d) {
        state.users = d.users || []; state.total = d.total || 0; state.pages = d.pages || 1; state.page = d.page || 1;
        renderUsers();
        if (state.page === 1 && !state.q) renderSignups(state.users);
      });
    }
    function reloadAll() { return Promise.all([loadUsers(), loadStats()]); }

    /* ---- delete confirm modal ---- */
    function confirmDelete(u) {
      var bg = ce("div"); bg.id = "dqa-mbg"; bg.className = "dqa-mbg"; applyVars(bg);
      bg.innerHTML = '<div class="dqa-modal"><h4>Delete member?</h4>' +
        '<p>This permanently removes <b>' + esc(u.name || u.email) + '</b> and all of their messages, memberships and payment records. This can’t be undone.</p>' +
        '<div class="dqa-mact"><button class="dqa-mbtn" id="dqa-mc">Cancel</button><button class="dqa-mbtn dang" id="dqa-mok">Delete</button></div></div>';
      document.body.appendChild(bg);
      bg.addEventListener("click", function (e) { if (e.target === bg) bg.remove(); });
      bg.querySelector("#dqa-mc").onclick = function () { bg.remove(); };
      bg.querySelector("#dqa-mok").onclick = function () {
        bg.remove();
        api("/admin/users/" + u.id, { method: "DELETE" })
          .then(function () { toast((u.name || u.email) + " deleted", "ok"); return reloadAll(); })
          .catch(function (e) { toast((e && e.error) || "Delete failed", "err"); });
      };
    }

    /* ---- row actions (event delegation) ---- */
    ulist.addEventListener("click", function (e) {
      var btn = e.target.closest(".dqa-iact"); if (!btn) return;
      var row = e.target.closest(".dqa-urow"); if (!row) return;
      var id = parseInt(row.dataset.id, 10), act = btn.dataset.act;
      var u = state.users.find(function (x) { return x.id === id; }); if (!u) return;
      if (act === "del") { confirmDelete(u); return; }
      var p;
      if (act === "pro") {
        var mk = u.subscription_status !== "active";
        p = api("/admin/users/" + id + "/subscription", { method: "POST", body: JSON.stringify(mk ? { status: "active", days: 30 } : { status: "free" }) })
          .then(function () { toast(mk ? (u.name || u.email) + " upgraded to Pro" : "Pro removed from " + (u.name || u.email), "ok"); });
      } else if (act === "block") {
        p = api("/admin/users/" + id + "/" + (u.blocked ? "unblock" : "block"), { method: "POST" })
          .then(function () { toast(u.blocked ? (u.name || u.email) + " unblocked" : (u.name || u.email) + " blocked", "ok"); });
      }
      if (p) p.then(reloadAll).catch(function (e) { toast((e && e.error) || "Action failed", "err"); });
    });

    /* ---- tabs ---- */
    ov.querySelectorAll(".dqa-tab").forEach(function (b) {
      b.onclick = function () {
        state.tab = b.dataset.tab;
        ov.querySelectorAll(".dqa-tab").forEach(function (x) { x.classList.toggle("on", x.dataset.tab === state.tab); });
        renderUsers();
      };
    });

    /* ---- search (debounced, server-side) ---- */
    var st;
    $("#dqa-q").addEventListener("input", function (e) {
      clearTimeout(st);
      var v = e.target.value.trim();
      st = setTimeout(function () { state.q = v; state.page = 1; loadUsers().catch(function (e) { toast((e && e.error) || "Search failed", "err"); }); }, 350);
    });

    /* ---- pagination ---- */
    $("#dqa-prev").onclick = function () { if (state.page > 1) { state.page--; loadUsers().catch(function () {}); } };
    $("#dqa-next").onclick = function () { if (state.page < state.pages) { state.page++; loadUsers().catch(function () {}); } };

    /* ---- wallet balance chip ---- */
    api("/qntm/wallets/me").then(function (r) {
      var el = $("#dqa-bal");
      if (el && r && r.wallet) el.textContent = Number(r.wallet.available_balance || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }).catch(function () {});

    /* ---- initial load + skeleton ---- */
    ulist.innerHTML = '<div class="dqa-skel"></div><div class="dqa-skel"></div><div class="dqa-skel"></div><div class="dqa-skel"></div><div class="dqa-skel"></div>';
    reloadAll().catch(function (e) { toast((e && e.error) || "Could not load dashboard", "err"); });

    /* ---- auto-refresh stats every 30s ---- */
    state.timer = setInterval(function () { loadStats().catch(function () {}); }, 30000);
  }

  window.dqAdminDashboard = open;
})();
