'use strict';
/* ============================================================================
   market-desktop.js — DrFX Quant
   Desktop (>=1024px) "Quantum Market" skin for the Market Explore overlay.

   This module WRAPS the mobile window.mkExplore defined in market-ui.js. On a
   wide screen it paints the image-matched 3-column dashboard (left nav rail +
   center feed + right info rail) into #mk-body; on narrow screens it defers to
   the original mobile renderer, untouched. It loads AFTER market-ui.js so it
   captures that override and re-wraps it.

   SKIN ONLY (per request): the center feed and Trending Creators use LIVE data
   (/market/explore, /market/creators). The QNTM Token chart, Featured Products
   and gamification (LVL / XP) are presentational PLACEHOLDERS pending backends.
   Every functional .mk-* class + data-* attribute is preserved, so the existing
   delegated handlers (follow / like / comment / open creator / open product /
   type chips / sort) keep working with no changes. If this file fails to load,
   the marketplace degrades gracefully to the mobile design on every screen.
   ========================================================================== */
(function () {
  if (typeof window === 'undefined') return;
  var _mobileExplore = window.mkExplore;

  function isDesk() { try { return window.matchMedia('(min-width:1024px)').matches; } catch (e) { return window.innerWidth >= 1024; } }

  var D = {
    bg: '#0a0e1a', panel: '#10142a', card: '#121731', panel2: '#0c1020',
    bd: 'rgba(255,255,255,.06)', bd2: 'rgba(124,108,255,.28)',
    t1: '#eef1fb', t2: '#9aa3c0', t3: '#5f6a8c',
    ind: '#6366f1', pur: '#a855f7', cyan: '#22d3ee', green: '#34d399',
    grad: 'linear-gradient(135deg,#5b6bff 0%,#a855f7 100%)',
    glow: 'rgba(99,102,241,.45)', pglow: 'rgba(168,85,247,.4)'
  };

  function mkxPrice(v) { return (Number(v) || 0).toLocaleString('en-US') + ' QNTM'; }
  function ringAv(av, size) { return `<span class='mkx-rav'>${avatar(av, size)}</span>`; }

  function injectCSS() {
    if (document.getElementById('mkx-desk-css')) return;
    var s = document.createElement('style'); s.id = 'mkx-desk-css';
    s.textContent = [
      `.mkx-desk{position:fixed;inset:0;z-index:60;background:${D.bg};display:flex;font-family:'Outfit',sans-serif;color:${D.t1};overflow:hidden;-webkit-font-smoothing:antialiased}`,
      `.mkx-desk *{box-sizing:border-box}`,
      `.mkx-desk ::-webkit-scrollbar{width:8px;height:8px}.mkx-desk ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.09);border-radius:8px}.mkx-desk ::-webkit-scrollbar-track{background:transparent}`,
      `.mkx-side{width:258px;flex-shrink:0;background:${D.panel2};border-right:1px solid ${D.bd};display:flex;flex-direction:column;padding:22px 16px;overflow-y:auto}`,
      `.mkx-brand{display:flex;align-items:center;gap:11px;padding:0 6px 22px;cursor:pointer}`,
      `.mkx-navi{display:flex;align-items:center;gap:13px;padding:12px 14px;border-radius:13px;cursor:pointer;color:${D.t2};font-size:14.5px;font-weight:600;border:none;background:none;width:100%;text-align:left;font-family:inherit;margin-bottom:3px;transition:background .15s,color .15s}`,
      `.mkx-navi:hover{background:rgba(255,255,255,.04);color:${D.t1}}`,
      `.mkx-navi.on{background:${D.grad};color:#fff;box-shadow:0 8px 22px ${D.glow}}`,
      `.mkx-main{flex:1;min-width:0;overflow-y:auto;padding:20px 30px 34px}`,
      `.mkx-mainwrap{max-width:1180px;margin:0 auto;width:100%}`,
      `.mkx-search{flex:1;display:flex;align-items:center;gap:11px;padding:13px 18px;border-radius:14px;background:${D.panel};border:1px solid ${D.bd};color:${D.t2};font-size:14px;min-width:0}`,
      `.mkx-bell{width:46px;height:46px;flex-shrink:0;border-radius:13px;background:${D.panel};border:1px solid ${D.bd};display:flex;align-items:center;justify-content:center;color:${D.t2};cursor:pointer;position:relative}`,
      `.mkx-tab{flex-shrink:0;padding:10px 20px;border-radius:12px;border:1px solid ${D.bd};background:${D.panel};color:${D.t2};font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap}`,
      `.mkx-tab.on{background:${D.grad};color:#fff;border-color:transparent;box-shadow:0 8px 20px ${D.glow}}`,
      `.mkx-feedgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-top:18px}`,
      `.mkx-card{border:1px solid ${D.bd};border-radius:18px;background:${D.card};overflow:hidden;display:flex;flex-direction:column;transition:border-color .2s,transform .2s}`,
      `.mkx-card:hover{border-color:${D.bd2};transform:translateY(-2px)}`,
      `.mkx-foll{padding:7px 17px;border-radius:10px;border:1px solid ${D.ind};background:rgba(99,102,241,.1);color:#aeb8ff;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;flex-shrink:0}`,
      `.mkx-foll.on{background:transparent;color:${D.t2};border-color:${D.bd}}`,
      `.mkx-pill{font-size:9px;font-weight:800;letter-spacing:.5px;padding:3px 8px;border-radius:7px;text-transform:uppercase}`,
      `.mkx-act{display:flex;align-items:center;gap:7px;background:none;border:none;cursor:pointer;font-family:inherit;font-size:13.5px;font-weight:700;padding:0}`,
      `.mkx-rail{width:330px;flex-shrink:0;overflow-y:auto;padding:18px 18px 24px;background:${D.panel2};border-left:1px solid ${D.bd};display:flex;flex-direction:column;gap:16px}`,
      `.mkx-rcard{border:1px solid ${D.bd};border-radius:18px;background:${D.card};padding:17px;display:flex;flex-direction:column;flex:0 0 auto;min-height:0}`,
      `.mkx-rscroll{overflow-y:auto;overflow-x:hidden;max-height:420px;margin:0 -4px;padding:0 4px}`,
      `.mkx-rscroll::-webkit-scrollbar{width:6px}.mkx-rscroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:6px}`,
      `.mkx-vall{background:none;border:none;color:${D.pur};font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit}`,
      `.mkx-rfoll{padding:6px 15px;border-radius:9px;border:1px solid ${D.ind};background:rgba(99,102,241,.08);color:#aeb8ff;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;flex-shrink:0}`,
      `.mkx-rav{display:inline-block;border-radius:50%;padding:2px;line-height:0;flex-shrink:0;background:linear-gradient(135deg,#5b6bff,#a855f7 52%,#22d3ee);box-shadow:0 0 10px rgba(124,108,255,.32)}`,
      `.mkx-prof{margin-top:14px;padding:12px 10px 11px;border-top:1px solid ${D.bd};border-radius:0 0 12px 12px;cursor:pointer;transition:background .15s}`,
      `.mkx-prof:hover{background:rgba(255,255,255,.05)}`,
      `@media (max-width:1200px){.mkx-feedgrid{grid-template-columns:1fr}}`,
      `@media (max-width:1023px){.mkx-rail{display:none}}`
    ].join('');
    document.head.appendChild(s);
  }

  /* ---- left sidebar ---- */
  function sidebar() {
    var nav = [
      ['dashboard', 'Dashboard', `<rect x='3' y='3' width='18' height='18' rx='2'/><line x1='3' y1='9' x2='21' y2='9'/><line x1='9' y1='21' x2='9' y2='9'/>`],
      ['explore', 'Explore', `<rect x='3' y='3' width='7' height='7' rx='1.5'/><rect x='14' y='3' width='7' height='7' rx='1.5'/><rect x='14' y='14' width='7' height='7' rx='1.5'/><rect x='3' y='14' width='7' height='7' rx='1.5'/>`],
      ['companies', 'Companies', `<path d='M3 21h18'/><path d='M5 21V7l8-4v18'/><path d='M19 21V11l-6-4'/><line x1='9' y1='9' x2='9' y2='9.01'/><line x1='9' y1='13' x2='9' y2='13.01'/>`],
      ['create', 'Create', `<circle cx='12' cy='12' r='9'/><line x1='12' y1='8' x2='12' y2='16'/><line x1='8' y1='12' x2='16' y2='12'/>`],
      ['store', 'My Store', `<path d='M3 9l1-5h16l1 5'/><path d='M5 9v11h14V9'/><path d='M9 22V12h6v10'/>`],
      ['wallet', 'Wallet', `<rect x='2' y='6' width='20' height='13' rx='3'/><path d='M2 10h20'/><circle cx='17' cy='13' r='1.3'/>`],
      ['profile', 'Profile', `<circle cx='12' cy='8' r='4'/><path d='M4 21c0-3.6 3.6-6.5 8-6.5s8 2.9 8 6.5'/>`]
    ];
    var items = nav.map(function (n) {
      var on = n[0] === 'explore';
      return `<button class='mkx-navi${on ? ' on' : ''}' data-nav='${n[0]}' type='button'>${ic(n[2], 20)}<span>${n[1]}</span></button>`;
    }).join('');

    var brand =
      `<div class='mkx-brand' data-nav='home'>` +
        `<svg width='38' height='38' viewBox='0 0 24 24' fill='none' style='filter:drop-shadow(0 0 8px rgba(22,226,154,.55))'>` +
          `<defs><linearGradient id='mkxvolt' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#0fd98a'/><stop offset='.5' stop-color='#36e36b'/><stop offset='1' stop-color='#f5c451'/></linearGradient></defs>` +
          `<path d='M12 2.6l8 4.6v9.2l-8 4.6-8-4.6V7.2z' fill='none' stroke='url(#mkxvolt)' stroke-width='1.5'/>` +
          `<path d='M12 6l4.5 2.6v5.8L12 17l-4.5-2.6V8.6z' fill='url(#mkxvolt)' opacity='.34'/>` +
          `<circle cx='12' cy='12' r='2.5' fill='url(#mkxvolt)'/>` +
        `</svg>` +
        `<div style='line-height:1.04'><div style='font-size:16px;font-weight:800;letter-spacing:.6px;color:#eafff5;text-shadow:0 0 10px rgba(22,226,154,.5)'>QUANTUM</div><div style='font-size:16px;font-weight:800;letter-spacing:.6px;background:linear-gradient(95deg,#0fd98a 0%,#36e36b 45%,#f5c451 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent'>MARKET</div><div style='font-size:10px;color:#f5c451;font-weight:700;margin-top:1px;letter-spacing:.3px'>by DrFX</div></div>` +
      `</div>`;

    var elite =
      `<div style='border:1px solid ${D.bd};border-radius:16px;background:linear-gradient(160deg,rgba(99,102,241,.12),rgba(168,85,247,.05));padding:15px'>` +
        `<div style='display:flex;align-items:center;gap:8px;margin-bottom:8px'><svg width='18' height='18' viewBox='0 0 24 24' fill='${D.pur}'><path d='M6 3h12l4 6-10 12L2 9z'/></svg><span style='font-weight:800;font-size:14px;color:${D.t1}'>Quantum Elite</span></div>` +
        `<div style='color:${D.t2};font-size:11.5px;line-height:1.5;margin-bottom:12px'>Unlock premium tools, advanced analytics and exclusive insights.</div>` +
        `<button data-nav='upgrade' type='button' style='width:100%;padding:11px;border-radius:11px;border:none;background:${D.grad};color:#fff;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;box-shadow:0 8px 20px ${D.glow}'>Upgrade Now</button>` +
      `</div>`;

    var u = (typeof S !== 'undefined' && S.user) || {};
    var prof =
      `<div class='mkx-prof' data-nav='store' title='Open My Store'>` +
        `<div style='display:flex;align-items:center;gap:11px'>` +
          ringAv(u.avatar || '\uD83E\uDDD1\u200D\uD83D\uDCBB', 42) +
          `<div style='flex:1;min-width:0'><div style='display:flex;align-items:center;gap:4px;color:${D.t1};font-weight:700;font-size:14px'>${esc(u.name || u.username || 'You')}${u.verified ? goldSeal(14) : ''}</div><div style='color:${D.pur};font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'>@${esc(u.username || '')}</div></div>` +
          `<span style='color:${D.t3};display:flex;flex-shrink:0'>${ic(`<polyline points='9 18 15 12 9 6'/>`, 16)}</span>` +
        `</div>` +
        `<div style='display:flex;align-items:center;gap:9px;margin-top:11px'>` +
          `<span id='mkx-lvl' style='font-size:9px;font-weight:800;color:#fff;background:${D.grad};padding:3px 8px;border-radius:7px;flex-shrink:0'>LVL 1</span>` +
          `<div style='flex:1'><div style='height:6px;border-radius:6px;background:rgba(255,255,255,.08);overflow:hidden'><div id='mkx-xpbar' style='height:100%;width:10%;background:${D.grad};transition:width .6s cubic-bezier(.22,.61,.36,1)'></div></div></div>` +
        `</div>` +
        `<div id='mkx-xptxt' style='text-align:right;color:${D.t3};font-size:9.5px;margin-top:4px'>1,000 / 10,000 XP</div>` +
      `</div>`;

    return `<aside class='mkx-side'>${brand}<div>${items}</div><div style='flex:1'></div>${elite}${prof}</aside>`;
  }

  /* ---- center: tabs + sort ---- */
  function tabs() {
    var list = [['', 'Explore']].concat(typeof MK_TYPES !== 'undefined' ? MK_TYPES : []);
    var ts = list.map(function (p) {
      var on = MK.type === p[0];
      return `<button class='mk-chip mkx-tab${on ? ' on' : ''}' data-type='${p[0]}' type='button'>${p[1]}</button>`;
    }).join('');
    var label = MK.sort === 'new' ? 'Newest posts' : 'Top liked posts';
    var sort =
      `<button class='mk-sortbtn' data-sort='${MK.sort === 'new' ? 'likes' : 'new'}' type='button' style='flex-shrink:0;display:flex;align-items:center;gap:9px;padding:10px 16px;border-radius:12px;border:1px solid ${D.bd};background:${D.panel};color:${D.t1};font-size:13px;font-weight:700;cursor:pointer;font-family:inherit'><span style='color:#ff8a3d'>\uD83D\uDD25</span>${label}${ic(`<polyline points='6 9 12 15 18 9'/>`, 16)}</button>`;
    return `<div style='display:flex;align-items:center;gap:10px;overflow-x:auto'>${ts}<div style='flex:1;min-width:8px'></div>${sort}</div>`;
  }

  /* ---- center: a post card ---- */
  function card(p) {
    var a = p.author || {}, pr = p.product, liked = !!p.liked_by_me;
    var media;
    if (p.media_type === 'image' && p.media_url) {
      media = `<img src='${esc(p.media_url)}' loading='lazy' style='width:100%;height:200px;object-fit:cover;display:block'/>`;
    } else if (p.media_type === 'video' && p.media_url) {
      media = `<video src='${esc(p.media_url)}' ${p.thumb_url ? `poster='${esc(p.thumb_url)}' ` : ''}controls playsinline preload='metadata' style='width:100%;height:200px;object-fit:cover;display:block;background:#000'></video>`;
    } else {
      media = `<div style='height:200px;background:linear-gradient(135deg,${D.ind}22,${D.pur}11);display:flex;align-items:center;justify-content:center;color:${D.t3}'>${ic(`<path d='M3 3v18h18'/><path d='M7 14l3-3 3 3 4-5'/>`, 38)}</div>`;
    }
    var isVid = p.media_type === 'video' && p.media_url;
    var pill = pr ? `<div style='position:absolute;top:10px;left:10px'><span class='mkx-pill' style='color:#fff;background:${D.grad}'>${mkTypeLabel(pr.type)}</span></div>` : '';
    var pillClick = pr ? `<div class='mk-openp' data-pid='${pr.id}' style='position:absolute;top:10px;left:10px;cursor:pointer'><span class='mkx-pill' style='color:#fff;background:${D.grad}'>${mkTypeLabel(pr.type)}</span></div>` : '';
    var mediaWrap;
    if (pr && isVid) {
      // video keeps native controls; only the product pill opens the product
      mediaWrap = `<div style='position:relative'>${media}${pillClick}</div>`;
    } else if (pr) {
      mediaWrap = `<div class='mk-openp' data-pid='${pr.id}' style='position:relative;cursor:pointer'>${media}${pill}</div>`;
    } else {
      mediaWrap = `<div style='position:relative'>${media}</div>`;
    }
    var foll = (typeof S !== 'undefined' && S.user && a.id === S.user.id)
      ? `<button class='mk-editpost mkx-foll on' data-pid='${p.id}' type='button'>Edit</button>`
      : `<button class='mk-foll mkx-foll${a.is_following ? ' on' : ''}' data-uid='${a.id}' data-on='${a.is_following ? 1 : 0}' type='button'>${a.is_following ? 'Following' : 'Follow'}</button>`;
    var price = pr ? `<div style='flex-shrink:0;text-align:right'><span style='color:${D.cyan};font-weight:800;font-size:15px'>${mkxPrice(pr.price_qntm)}</span></div>` : '';
    return `<article class='mkx-card'>` +
      `<header style='display:flex;align-items:center;gap:11px;padding:14px 15px 12px'>` +
        `<div class='mk-openc' data-h='${esc(a.username)}' style='cursor:pointer'>${ringAv(a.avatar || '\uD83E\uDDD1\u200D\uD83D\uDCBB', 38, D.ind, D.glow)}</div>` +
        `<div class='mk-openc' data-h='${esc(a.username)}' style='flex:1;min-width:0;cursor:pointer'><div style='display:flex;align-items:center;gap:4px;color:${D.t1};font-weight:700;font-size:14px'>${esc(a.name || a.username || 'User')}${a.verified ? goldSeal(14) : ''}</div><div style='color:${D.t3};font-size:12px'>@${esc(a.username || '')}</div></div>` +
        foll +
      `</header>` +
      (p.title ? `<div style='padding:0 15px 11px;color:${D.t1};font-weight:700;font-size:15.5px;line-height:1.3'>${esc(p.title)}</div>` : '') +
      mediaWrap +
      `<div style='display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:13px 15px 6px'>` +
        `<div style='color:${D.t2};font-size:13px;line-height:1.5;flex:1;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden'>${esc(p.caption || p.title || '')}</div>` +
        price +
      `</div>` +
      `<div style='display:flex;align-items:center;gap:22px;padding:8px 15px 15px'>` +
        `<button class='mk-like mkx-act' data-pid='${p.id}' data-on='${liked ? 1 : 0}' type='button' style='color:${liked ? '#ff4d6d' : D.t2}'>${mkHeart(liked)}<span class='mk-like-n'>${mkNum(p.like_count || 0)}</span></button>` +
        `<button class='mk-cmt mkx-act' data-pid='${p.id}' type='button' style='color:${D.t2}'>${ic(`<path d='M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z'/>`, 19)}<span>${mkNum(p.comment_count || 0)}</span></button>` +
        `<div style='flex:1'></div>` +
        `<span style='color:${D.t3};cursor:pointer'>${ic(`<path d='M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'/>`, 19)}</span>` +
      `</div>` +
    `</article>`;
  }

  /* ---- center: search + heading + grid + footer (reusable pieces) ---- */
  function searchBar() {
    return `<div style='display:flex;align-items:center;gap:14px;margin-bottom:22px'>` +
        `<label class='mkx-search' style='cursor:text'>${ic(`<circle cx='11' cy='11' r='7'/><line x1='21' y1='21' x2='16.65' y2='16.65'/>`, 18)}<input id='mkx-search-input' type='text' autocomplete='off' placeholder='Search for products, creators and posts...' value='${esc((typeof MK !== 'undefined' && MK.q) || '')}' style='flex:1;min-width:0;background:none;border:none;outline:none;color:${D.t1};font-size:14px;font-family:inherit'/></label>` +
        `<button class='mkx-bell' id='mkx-bell' type='button' title='Notifications'>${ic(`<path d='M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9'/><path d='M13.73 21a2 2 0 0 1-3.46 0'/>`, 20)}<span style='position:absolute;top:11px;right:13px;width:7px;height:7px;border-radius:50%;background:${D.pur};box-shadow:0 0 8px ${D.pglow}'></span></button>` +
      `</div>`;
  }
  function exploreHead() {
    return `<div style='font-size:30px;font-weight:800;color:${D.t1};letter-spacing:-.5px'>Market Explore</div>` +
      `<div style='color:${D.t2};font-size:14px;margin-top:4px;margin-bottom:18px'>Discover top trading indicators, strategies and tools from the community.</div>`;
  }
  function exploreFoot() {
    return `<div style='text-align:center;color:${D.t3};font-size:11.5px;margin-top:30px;line-height:1.6'>Trading involves risk. Past performance is not indicative of future results. Quantum Market is a community-driven platform for educational and informational purposes only.</div>`;
  }
  // The inner content of the Explore center column (everything inside .mkx-mainwrap).
  function exploreCenterHTML(gridHTML) {
    return `${searchBar()}${exploreHead()}${tabs()}<div class='mkx-feedgrid'>${gridHTML}</div>${exploreFoot()}`;
  }
  function mainShell(gridHTML) {
    return `<main class='mkx-main'><div class='mkx-mainwrap'>${exploreCenterHTML(gridHTML)}</div></main>`;
  }

  /* ---- right rail: trending creators (live) ---- */
  function trending(creators) {
    var list = (creators || []).slice(0, 20);
    var rows = list.map(function (c, i) {
      var foll = c.is_me
        ? `<span style='font-size:11px;font-weight:700;color:${D.t3};flex-shrink:0'>You</span>`
        : `<button class='mk-foll mkx-rfoll${c.is_following ? ' on' : ''}' data-uid='${c.id}' data-on='${c.is_following ? 1 : 0}' type='button'>${c.is_following ? 'Following' : 'Follow'}</button>`;
      var sep = i === list.length - 1 ? '' : ';border-bottom:1px solid rgba(255,255,255,.055)';
      return `<div style='display:flex;align-items:center;gap:12px;padding:12px 0${sep}'>` +
        `<span style='color:${D.t3};font-size:13px;font-weight:800;width:14px;text-align:center;flex-shrink:0'>${i + 1}</span>` +
        `<div class='mk-openc' data-h='${esc(c.username)}' style='cursor:pointer;flex-shrink:0'>${ringAv(c.avatar || '\uD83E\uDDD1\u200D\uD83D\uDCBB', 40)}</div>` +
        `<div class='mk-openc' data-h='${esc(c.username)}' style='flex:1;min-width:0;cursor:pointer'>` +
          `<div style='display:flex;align-items:center;gap:4px;color:${D.t1};font-weight:700;font-size:13.5px;line-height:1.25'>${esc(c.name || c.username)}${c.verified ? goldSeal(13) : ''}</div>` +
          `<div style='color:${D.t3};font-size:11.5px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'>@${esc(c.username)}</div>` +
          `<div style='color:${D.t2};font-size:11px;margin-top:2px'>${mkNum(c.follower_count || 0)} followers</div>` +
        `</div>` +
        foll +
      `</div>`;
    }).join('');
    if (!rows) rows = `<div style='color:${D.t3};font-size:13px;padding:16px 2px;text-align:center'>No creators yet.</div>`;
    return `<div class='mkx-rcard'><div style='display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;flex-shrink:0'><span style='font-weight:800;font-size:15.5px;color:${D.t1}'>Trending Creators</span><button class='mkx-vall' data-nav='creators' type='button'>View all</button></div><div class='mkx-rscroll'>${rows}</div></div>`;
  }

  /* ---- right rail: QNTM token (placeholder chart, pending backend) ---- */
  function token() {
    function row(id, label, last) {
      var bb = last ? '' : ';border-bottom:1px solid rgba(255,255,255,.055)';
      return `<div style='display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0${bb}'>` +
        `<span style='color:${D.t2};font-size:12.5px'>${label}</span>` +
        `<div style='text-align:right'><div id='${id}' style='color:${D.t1};font-weight:800;font-size:13.5px'>\u2014</div><div id='${id}-usd' style='color:${D.t3};font-size:10.5px;margin-top:1px'>\u2014</div></div>` +
      `</div>`;
    }
    return `<div class='mkx-rcard'>` +
      `<div style='display:flex;align-items:center;justify-content:space-between;margin-bottom:10px'>` +
        `<span style='font-weight:800;font-size:15px;color:${D.t1}'>QNTM Token</span>` +
        `<span style='font-size:9.5px;font-weight:800;letter-spacing:.5px;color:${D.green};background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.3);padding:2px 8px;border-radius:7px'>LIVE</span>` +
      `</div>` +
      `<div style='display:flex;align-items:baseline;gap:7px'><span style='font-size:29px;font-weight:800;color:${D.t1}'>$0.01</span><span style='color:${D.t3};font-weight:600;font-size:13px'>/ QNTM</span></div>` +
      `<div style='color:${D.t3};font-size:11px;margin:3px 0 8px'>Fixed internal price \u00b7 1 QNTM = $0.01</div>` +
      row('mkx-tok-pool', 'Reward Pool', false) +
      row('mkx-tok-held', 'Held by Users', false) +
      row('mkx-tok-dist', 'From Reward Pool', true) +
    `</div>`;
  }

  /* ---- right rail: featured products (placeholder, pending backend) ---- */
  function featured() {
    var data = [
      ['Quantum Reversal Indicator', '@everalKing', '4.9', '200'],
      ['Supply & Demand Zones', '@ZoneTrader', '4.8', '180'],
      ['AI News Sentiment Bot', '@NewsAlgo', '4.9', '500']
    ];
    var rows = data.map(function (p, i) {
      var sep = i === data.length - 1 ? '' : ';border-bottom:1px solid rgba(255,255,255,.055)';
      return `<div style='display:flex;align-items:center;gap:12px;padding:12px 0${sep}'>` +
        `<div style='width:44px;height:44px;border-radius:12px;flex-shrink:0;background:linear-gradient(135deg,${D.ind}33,${D.pur}22);border:1px solid ${D.bd};display:flex;align-items:center;justify-content:center;color:${D.t2}'>${ic(`<path d='M3 3v18h18'/><path d='M7 13l3-3 3 3 4-5'/>`, 22)}</div>` +
        `<div style='flex:1;min-width:0'><div style='color:${D.t1};font-weight:700;font-size:13px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'>${p[0]}</div><div style='color:${D.t3};font-size:11.5px;margin-top:2px'>${p[1]}</div></div>` +
        `<div style='text-align:right;flex-shrink:0'><div style='color:#fbbf24;font-size:12px;font-weight:800'>\u2605 ${p[2]}</div><div style='color:${D.cyan};font-size:12px;font-weight:700;margin-top:3px'>${p[3]} QNTM</div></div>` +
      `</div>`;
    }).join('');
    return `<div class='mkx-rcard'><div style='display:flex;align-items:center;justify-content:space-between;margin-bottom:4px'><span style='font-weight:800;font-size:15.5px;color:${D.t1}'>Featured Products</span><button class='mkx-vall' data-nav='featured' type='button'>View all</button></div>${rows}</div>`;
  }

  /* ---- right rail: create & earn ---- */
  function createEarn() {
    return `<div style='position:relative;overflow:hidden;border-radius:18px;background:${D.grad};padding:18px;color:#fff'>` +
      `<div style='font-weight:800;font-size:17px'>Create &amp; Earn</div>` +
      `<div style='font-size:12.5px;opacity:.92;line-height:1.5;margin:6px 0 14px;max-width:190px'>Monetize your strategies and tools with the Quantum Market.</div>` +
      `<button data-nav='publish' type='button' style='padding:10px 18px;border-radius:11px;border:none;background:#fff;color:#3b2c7a;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit'>Start Publishing</button>` +
      `<svg width='90' height='90' viewBox='0 0 24 24' fill='none' style='position:absolute;right:-4px;bottom:-8px;opacity:.92'><ellipse cx='12' cy='17' rx='8' ry='2.8' fill='rgba(255,255,255,.22)'/><ellipse cx='12' cy='13' rx='8' ry='2.8' fill='rgba(255,255,255,.34)'/><ellipse cx='12' cy='9' rx='8' ry='2.8' fill='#fff'/><text x='12' y='10.8' font-size='5' font-weight='800' fill='#6d28d9' text-anchor='middle' font-family='Outfit'>Q</text></svg>` +
    `</div>`;
  }

  function rail(creators) {
    return `<aside class='mkx-rail'>${trending(creators)}${token()}${featured()}${createEarn()}</aside>`;
  }

  function feedLoading() {
    var one = `<div class='mkx-card' style='height:360px;animation:pu 1.5s infinite'></div>`;
    return one + one + one + one;
  }
  function emptyGrid(msg) {
    return `<div style='grid-column:1/-1;text-align:center;padding:50px 20px;color:${D.t3}'><div style='font-size:15px;font-weight:700;color:${D.t2}'>${msg ? esc(msg) : 'Nothing here yet'}</div><div style='font-size:13px;margin-top:6px'>Be the first to share a chart, idea, or product.</div></div>`;
  }

  /* ---- navigation / close (skin: real where it exists, otherwise leaves Market) ---- */
  function closeMarket() {
    try {
      var ov = document.getElementById('mk-overlay');
      var bk = ov && ov.querySelector('[id$="-back"]');
      if (bk) { bk.click(); return; }
      if (ov) ov.remove();
    } catch (e) {}
  }
  function wireNavScope(scope) {
    if (!scope) return;
    scope.querySelectorAll('[data-nav]').forEach(function (b) {
      b.addEventListener('click', function () {
        var n = b.getAttribute('data-nav');
        // sidebar tabs mirror the mobile bottom nav exactly, via the same mkSetTab()
        if (n === 'explore' || n === 'companies' || n === 'create' || n === 'store') {
          if (typeof mkSetTab === 'function') { try { return mkSetTab(n); } catch (e) {} }
          return;
        }
        if (n === 'wallet') { if (window.openWallet) openWallet(); return; }
        if (n === 'profile') { if (window.openProfile) openProfile(); return; }
        if (n === 'upgrade' || n === 'publish') { if (window.openSub) openSub(); return; }
        if (n === 'creators' || n === 'featured') { return; }
        // dashboard (-> first page / chats) and home (brand logo) both leave Market
        closeMarket();
      });
    });
  }
  function wireNav(body) { wireNavScope(body); }

  // Populate the right rail, parsing each card in ISOLATION so a quirk in one
  // section can never swallow the others (the prior single-innerHTML concat was
  // the bug that blanked QNTM Token / Featured / Create & Earn).
  function setRail(railEl, creators) {
    if (!railEl) return;
    railEl.innerHTML = '';
    [trending(creators), token(), featured()].forEach(function (html) {
      try {
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        while (tmp.firstChild) railEl.appendChild(tmp.firstChild);
      } catch (e) {}
    });
    wireNavScope(railEl);
    loadToken();
  }

  // Load real XP/level for the signed-in user and fill the sidebar badge + bar.
  // XP/level are computed server-side (GET /market/me/stats) from the user's
  // posts and the likes their posts have received.
  async function loadXP() {
    try {
      var d = await api('/market/me/stats');
      if (!d) return;
      var lvlEl = document.getElementById('mkx-lvl');
      var barEl = document.getElementById('mkx-xpbar');
      var txtEl = document.getElementById('mkx-xptxt');
      var xp = d.xp || 1000, level = d.level || 1, xpMax = d.xp_max || 10000;
      if (lvlEl) lvlEl.textContent = 'LVL ' + level;
      if (barEl) barEl.style.width = Math.max(0, Math.min(100, Math.round(xp / xpMax * 100))) + '%';
      if (txtEl) txtEl.textContent = xp.toLocaleString('en-US') + ' / ' + xpMax.toLocaleString('en-US') + ' XP';
    } catch (e) {}
  }

  // Load the live QNTM economy figures (GET /qntm/wallets/supply) and fill the
  // rail token card with the reward pool / held by users / from reward pool,
  // each shown in QNTM and USD (fixed 1 QNTM = $0.01).
  async function loadToken() {
    try {
      var d = await api('/qntm/wallets/supply');
      if (!d) return;
      var price = Number(d.priceUsd) || 0.01;
      var fmtUsd = function (n) {
        if (!isFinite(n)) return "$0";
        return "$" + (typeof mkNum === 'function' ? mkNum(n) : Math.round(n).toLocaleString('en-US'));
      };
      var fmtQ = function (n) { return (typeof mkNum === 'function' ? mkNum(n) : Math.round(n).toLocaleString('en-US')) + ' QNTM'; };
      var put = function (id, qobj) {
        var n = Number((qobj && qobj.qntm) || 0) || 0;
        var el = document.getElementById(id); if (el) el.textContent = fmtQ(n);
        var us = document.getElementById(id + '-usd'); if (us) us.textContent = fmtUsd(n * price);
      };
      put('mkx-tok-pool', d.rewardPool);
      put('mkx-tok-held', d.heldByUsers);
      put('mkx-tok-dist', d.fromRewardPool);
    } catch (e) {}
  }

  /* ---- persistent desktop frame: left sidebar + center + right rail ----
     Built ONCE into #mk-body. The sidebar and rail stay fixed across tabs; only
     the center (#mkx-center) re-renders. Companies / Create / My Store / creator
     profiles are produced by the ORIGINAL mobile renderers, redirected into the
     center via a transient id swap (safe: each captures #mk-body once,
     synchronously, then writes to that node or to a child by id). */

  var _railCreators = null;

  function frameShell() {
    return `<div class='mkx-desk'>${sidebar()}<main class='mkx-main'><div class='mkx-mainwrap' id='mkx-center'></div></main><aside class='mkx-rail'></aside></div>`;
  }

  function highlightNav(scope) {
    if (!scope) return;
    var tab = (typeof MK !== 'undefined' && !MK.handle) ? MK.tab : null;
    scope.querySelectorAll('.mkx-navi').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-nav') === tab);
    });
  }

  // Trending Creators for the rail — fetched once when the frame is built, then
  // reused so the rail stays put while the center changes.
  async function refreshRail() {
    var creators;
    try {
      var d = await api('/market/creators?sort=followers&limit=20');
      creators = ((d && d.creators) || []).filter(function (c) { return !c.is_me; });
    } catch (e) { return; }
    _railCreators = creators;
    try {
      var body = document.getElementById('mk-body');
      var railEl = body && body.querySelector('.mkx-rail');
      if (railEl) setRail(railEl, creators);
    } catch (e) {}
  }

  // Build the frame if absent; always (re)apply the nav highlight. Returns the
  // center element (#mkx-center) that tab content renders into.
  function ensureFrame() {
    var body = document.getElementById('mk-body');
    if (!body) return null;
    injectCSS();
    if (!body.querySelector('.mkx-desk')) {
      body.innerHTML = frameShell();
      wireNav(body);
      setRail(body.querySelector('.mkx-rail'), _railCreators);
      loadXP();
      refreshRail();
    }
    highlightNav(body);
    return body.querySelector('#mkx-center');
  }

  var _searchTimer = null;

  // Fetch the Explore feed and fill ONLY the grid (so the search box keeps focus
  // while typing). Called on first render and on every search keystroke / chip.
  async function loadFeed(center) {
    if (!center) return;
    var grid = center.querySelector('.mkx-feedgrid');
    if (!grid) return;
    grid.innerHTML = feedLoading();
    try {
      var qs = 'sort=' + MK.sort + '&type=' + encodeURIComponent(MK.type) + '&q=' + encodeURIComponent((typeof MK !== 'undefined' && MK.q) || '') + '&limit=30';
      var d = await api('/market/explore?' + qs);
      var posts = (d && d.posts) || [];
      grid.innerHTML = posts.length ? posts.map(card).join('') : emptyGrid();
    } catch (e) {
      grid.innerHTML = emptyGrid(typeof mkErrMsg === 'function' ? mkErrMsg(e) : 'Could not load feed');
    }
  }

  // Notifications: there is no notification system yet, so the bell opens a
  // simple empty-state panel ("No notifications yet").
  function openNotifications() {
    if (typeof modal !== 'function') return;
    modal('Notifications', function (body) {
      body.innerHTML =
        `<div style='text-align:center;padding:26px 14px 10px'>` +
          `<div style='display:flex;justify-content:center;margin-bottom:14px;color:${t.t3}'><svg width='46' height='46' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'><path d='M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9'/><path d='M13.73 21a2 2 0 0 1-3.46 0'/></svg></div>` +
          `<div style='color:${t.t1};font-weight:700;font-size:16px'>No notifications yet</div>` +
          `<div style='color:${t.t3};font-size:13px;margin-top:6px;line-height:1.5'>You are all caught up. New activity will appear here.</div>` +
        `</div>`;
    });
  }

  // Wire the live search input (debounced; updates only the feed grid to keep
  // focus) and the notifications bell inside the Explore center.
  function wireExploreCenter(center) {
    if (!center) return;
    var input = center.querySelector('#mkx-search-input');
    if (input) {
      input.oninput = function () {
        if (typeof MK !== 'undefined') MK.q = input.value;
        clearTimeout(_searchTimer);
        _searchTimer = setTimeout(function () { loadFeed(center); }, 280);
      };
      input.onkeydown = function (e) {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(_searchTimer); loadFeed(center); }
      };
    }
    var bell = center.querySelector('#mkx-bell');
    if (bell) bell.onclick = function () { openNotifications(); };
  }

  // Render the Explore feed into the center (search + heading + tabs + grid).
  async function renderExploreCenter(center) {
    if (!center) return;
    center.innerHTML = exploreCenterHTML(feedLoading());
    wireExploreCenter(center);
    await loadFeed(center);
  }

  /* ---- wrap the mobile renderers ---- */
  window.mkExplore = function () {
    var body = document.getElementById('mk-body');
    if (body && isDesk()) {
      var center = ensureFrame();
      if (center) renderExploreCenter(center);
      return;
    }
    if (typeof _mobileExplore === 'function') { return _mobileExplore.apply(this, arguments); }
  };

  var _mkRenderOrig = window.mkRender;
  window.mkRender = function () {
    if (!isDesk()) {
      if (typeof _mkRenderOrig === 'function') return _mkRenderOrig.apply(this, arguments);
      return;
    }
    var center = ensureFrame();
    if (!center) {
      if (typeof _mkRenderOrig === 'function') return _mkRenderOrig.apply(this, arguments);
      return;
    }
    // Explore: render the feed center directly (don't rebuild the frame).
    if (typeof MK !== 'undefined' && !MK.handle && MK.tab === 'explore') {
      renderExploreCenter(center);
      return;
    }
    // Companies / Create / My Store / creator profile: let the ORIGINAL renderer
    // fill the CENTER by transiently swapping ids so getElementById('mk-body')
    // resolves to #mkx-center for the (synchronous) duration of the call.
    var body = document.getElementById('mk-body');
    var prevId = body.id;
    body.id = '__mkx_outer__';
    center.id = 'mk-body';
    try {
      if (typeof _mkRenderOrig === 'function') _mkRenderOrig.apply(this, arguments);
    } finally {
      center.id = 'mkx-center';
      body.id = prevId || 'mk-body';
    }
  };

  // Some in-overlay controls call a tab renderer DIRECTLY (e.g. the Companies/
  // Creators/All sub-tabs call mkCompanies; store edits call mkCreator / mkMyStore)
  // instead of going through mkRender. On desktop those bare calls would paint the
  // mobile view straight into #mk-body and wipe the frame. Wrap each so a direct
  // call redirects into #mkx-center, while calls made *during* an active mkRender
  // id-swap (when #mkx-center is momentarily renamed to mk-body) run unchanged.
  function wrapTabRenderer(orig) {
    if (typeof orig !== 'function') return orig;
    return function () {
      if (!isDesk()) return orig.apply(this, arguments);
      var center = document.getElementById('mkx-center');
      if (!center) return orig.apply(this, arguments); // mid-swap, or no frame yet
      var body = document.getElementById('mk-body');
      if (!body) return orig.apply(this, arguments);
      var prevId = body.id;
      body.id = '__mkx_outer__';
      center.id = 'mk-body';
      try { return orig.apply(this, arguments); }
      finally { center.id = 'mkx-center'; body.id = prevId || 'mk-body'; }
    };
  }
  window.mkCompanies = wrapTabRenderer(window.mkCompanies);
  window.mkCreator = wrapTabRenderer(window.mkCreator);
  window.mkMyStore = wrapTabRenderer(window.mkMyStore);

  // If the viewport crosses the desktop/mobile boundary while Market is open,
  // re-render so the right layout takes over (mobile<->desktop).
  var _wasDesk = isDesk();
  window.addEventListener('resize', function () {
    var now = isDesk();
    if (now === _wasDesk) return;
    _wasDesk = now;
    try {
      if (document.getElementById('mk-overlay') && typeof MK !== 'undefined' && typeof mkRender === 'function') mkRender();
    } catch (e) {}
  });
})();
