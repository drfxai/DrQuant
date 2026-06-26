/* ============================================================================
 * idcard.js — DrFX Quant "Quantum League ID Card" (frontend)
 * ----------------------------------------------------------------------------
 * A self-contained SPA module. Loads as a plain <script> after index.html's
 * main script and reuses its globals (t, S, api, esc, ce, isPro, showToast).
 * It exposes one global and transparently wraps openProfile to add an entry:
 *
 *     window.dqIdCard = { open }
 *     openProfile()  -> injects a "Quantum League ID Card" button in the profile
 *
 * The card is drawn as a pure vector SVG (crisp at any size), in two layouts:
 *   - landscape (desktop, 3:2)   - portrait (mobile, ~9:16, ideal for Telegram)
 * It can be downloaded as a high-res PNG or shared via the Web Share API.
 *
 * Member data: name/username/avatar from S.user; League + Ritual + Tier from
 * GET /api/leagues/me (+ subscription); Member ID / QID derived deterministically
 * from the user id so they are stable per member. The QR ("scan to verify") is
 * generated client-side from a verify URL (qrcode-generator, lazy-loaded; a
 * graceful placeholder is shown if it can't load).
 * ========================================================================== */
(function () {
  "use strict";
  if (window.dqIdCard) return; // singleton

  // ── palette ────────────────────────────────────────────────────────────────
  var COL = {
    blue: "#1f8bff", vio: "#7c5cff", cyan: "#22d3ee", green: "#34d27a",
    violL: "#a78bfa", gold: "#fbbf24", silver: "#cbd5e1",
    ink0: "#0a1330", ink1: "#070d20", ink2: "#05091a",
    t1: "#eaf1ff", t2: "#9fb2d8", t3: "#6f82ab", line: "rgba(140,170,255,.16)"
  };
  // League accent (shield + plaque + LEAGUE value). Keyed on a keyword in the name.
  function leagueColor(name, id) {
    var n = String(name || "").toLowerCase();
    var M = [
      ["legend", { c: "#e879f9", g: ["#a78bfa", "#f472b6", "#22d3ee"] }],
      ["titan", { c: "#fb923c", g: ["#ffb066", "#ea6a0a"] }],
      ["crystal", { c: "#22d3ee", g: ["#6fe8f7", "#0891b2"] }],
      ["champion", { c: "#f472b6", g: ["#fb8ccb", "#db2777"] }],
      ["master", { c: "#a78bfa", g: ["#c4b5fd", "#7c5cff"] }],
      ["gold", { c: "#fbbf24", g: ["#ffd757", "#e0930a"] }],
      ["silver", { c: "#dfe6f2", g: ["#f6f9ff", "#9aa8c2"] }],
      ["bronze", { c: "#d98a4a", g: ["#e8a566", "#a9621f"] }],
      ["top", { c: "#38bdf8", g: ["#62cdff", "#0c84d8"] }],
      ["maker", { c: "#2dd4bf", g: ["#46e6d2", "#0f9e8e"] }],
      ["discov", { c: "#7c9bff", g: ["#9fb6ff", "#4a6bdb"] }]
    ];
    for (var i = 0; i < M.length; i++) if (n.indexOf(M[i][0]) >= 0) return M[i][1];
    var byId = { 1: ["#9fb6ff", "#4a6bdb"], 5: ["#f6f9ff", "#9aa8c2"], 6: ["#ffd757", "#e0930a"] };
    var g = byId[id] || ["#9fb6ff", "#5566cc"];
    return { c: g[0], g: g };
  }

  // ── deterministic IDs (stable per user) ────────────────────────────────────
  function hash32(str) { var h = 0x811c9dc5; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return h >>> 0; }
  function makeIds(seed) {
    var a = hash32("dfx|" + seed), b = hash32("qid|" + seed), c = hash32("ax|" + seed);
    var L = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O
    var d4 = (a % 9000) + 1000;                 // 1000-9999
    var two = L[(c >> 3) % 24] + L[(c >> 9) % 24];
    var d2 = (c % 90) + 10;                      // 10-99
    var q1 = (b % 9000) + 1000, q2 = ((b >> 7) % 9000) + 1000;
    return {
      memberId: "DFX-" + d4 + "-" + two + d2,
      qid: q1 + "-AXQ-" + q2,
      qidCompact: ("" + q1) + "AXQ" + q2
    };
  }
  function initialsOf(name) {
    var p = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!p.length) return "DQ";
    if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
    return (p[0][0] + p[p.length - 1][0]).toUpperCase();
  }
  function fmtJoined(u) {
    var raw = u.created_at || u.createdAt || u.joined || u.joined_at || u.member_since || null;
    var dt = raw ? new Date(raw) : new Date();
    if (isNaN(dt.getTime())) dt = new Date();
    var mm = (dt.getMonth() + 1), dd = dt.getDate();
    return dt.getFullYear() + "-" + (mm < 10 ? "0" : "") + mm + "-" + (dd < 10 ? "0" : "") + dd;
  }
  function ritualLabel(lg) {
    if (lg && lg.activeRitual) return lg.activeRitual.ready ? { txt: "READY", col: COL.green } : { txt: "ASCENDING", col: COL.gold };
    if (lg && lg.currentLeagueId) return { txt: "UNLOCKED", col: COL.violL };
    return { txt: "LOCKED", col: COL.t3 };
  }

  function buildData(lg) {
    var u = (typeof S !== "undefined" && S.user) || {};
    var name = u.name || u.username || "Member";
    var ids = makeIds(String(u.id || u.username || name));
    var league = (lg && lg.currentLeagueName) || "Unranked";
    var lid = (lg && lg.currentLeagueId) || 0;
    var pro = (typeof isPro === "function") ? isPro() : (u.subscription_status === "active");
    return {
      name: name, username: u.username || "", avatar: u.avatar || "",
      memberId: ids.memberId, qid: ids.qid,
      league: league, leagueId: lid, lc: leagueColor(league, lid),
      tier: pro ? "PRO QUANTUM" : "QUANTUM",
      status: { txt: "ACTIVE", col: COL.green },
      ritual: ritualLabel(lg),
      joined: fmtJoined(u),
      initials: initialsOf(name),
      verifyUrl: "https://drfx.io/v/" + ids.qidCompact
    };
  }

  // ── QR (lazy-loaded generator -> module matrix) ────────────────────────────
  var _qrLoad = null;
  function loadQR() {
    if (window.qrcode) return Promise.resolve(true);
    if (_qrLoad) return _qrLoad;
    _qrLoad = new Promise(function (res) {
      var s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";
      s.async = true;
      s.onload = function () { res(!!window.qrcode); };
      s.onerror = function () { res(false); };
      document.head.appendChild(s);
    });
    return _qrLoad;
  }
  function qrMatrix(text) {
    try {
      var qr = window.qrcode(0, "M"); qr.addData(String(text)); qr.make();
      var n = qr.getModuleCount(), m = [];
      for (var r = 0; r < n; r++) { var row = []; for (var c = 0; c < n; c++) row.push(qr.isDark(r, c) ? 1 : 0); m.push(row); }
      return m;
    } catch (e) { return null; }
  }

  // ── avatar -> data URL (so it survives PNG export; emoji/remote -> monogram) ─
  function resolveAvatar(src) {
    return new Promise(function (res) {
      if (!src) return res(null);
      if (src.indexOf("data:") === 0) return res(src);
      var same = src.charAt(0) === "/", http = /^https?:\/\//i.test(src);
      if (!same && !http) return res(null); // emoji etc.
      try {
        fetch(src).then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) {
          if (!b) return res(null);
          var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { res(null); }; fr.readAsDataURL(b);
        }).catch(function () { res(null); });
      } catch (e) { res(null); }
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  //  SVG building blocks (coordinates are absolute unless inside a translate())
  // ════════════════════════════════════════════════════════════════════════
  function esc2(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  function defs(d) {
    var lg = d.lc.g, lgStops = lg.length >= 3
      ? '<stop offset="0" stop-color="' + lg[0] + '"/><stop offset=".5" stop-color="' + lg[1] + '"/><stop offset="1" stop-color="' + lg[2] + '"/>'
      : '<stop offset="0" stop-color="' + lg[0] + '"/><stop offset="1" stop-color="' + lg[1] + '"/>';
    return '<defs>' +
      '<linearGradient id="dqi_bv" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset=".5" stop-color="#4a8cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient>' +
      '<linearGradient id="dqi_bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + COL.ink0 + '"/><stop offset=".5" stop-color="' + COL.ink1 + '"/><stop offset="1" stop-color="' + COL.ink2 + '"/></linearGradient>' +
      '<linearGradient id="dqi_lg" x1="0" y1="0" x2="1" y2="1">' + lgStops + '</linearGradient>' +
      '<linearGradient id="dqi_sil" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f7ff"/><stop offset=".5" stop-color="#aeb9d2"/><stop offset="1" stop-color="#6c7793"/></linearGradient>' +
      '<linearGradient id="dqi_ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4a8cff"/><stop offset="1" stop-color="#7c5cff"/></linearGradient>' +
      '<linearGradient id="dqi_chrome" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#cfdbf5"/><stop offset="1" stop-color="#8aa0cc"/></linearGradient>' +
      '<radialGradient id="dqi_av" cx=".5" cy=".4" r=".75"><stop offset="0" stop-color="#26365f"/><stop offset="1" stop-color="#0b1430"/></radialGradient>' +
      '<filter id="dqi_glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
      '<filter id="dqi_soft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3"/></filter>' +
      '<pattern id="dqi_grid" width="34" height="34" patternUnits="userSpaceOnUse"><path d="M34 0H0V34" fill="none" stroke="rgba(120,160,255,.06)" stroke-width="1"/></pattern>' +
      '</defs>';
  }

  function octa(w, h, cut) {
    return 'M ' + cut + ' 0 L ' + (w - cut) + ' 0 L ' + w + ' ' + cut + ' L ' + w + ' ' + (h - cut) +
      ' L ' + (w - cut) + ' ' + h + ' L ' + cut + ' ' + h + ' L 0 ' + (h - cut) + ' L 0 ' + cut + ' Z';
  }
  function frame(W, H) {
    var m = Math.round(W * 0.017), cut = Math.round(W * 0.026);
    var outer = octa(W, H, cut);
    var ix = m, iy = m, iw = W - m * 2, ih = H - m * 2, icut = cut - Math.round(m * 0.5);
    var inner = 'M ' + (ix + icut) + ' ' + iy + ' L ' + (ix + iw - icut) + ' ' + iy + ' L ' + (ix + iw) + ' ' + (iy + icut) +
      ' L ' + (ix + iw) + ' ' + (iy + ih - icut) + ' L ' + (ix + iw - icut) + ' ' + (iy + ih) + ' L ' + (ix + icut) + ' ' + (iy + ih) +
      ' L ' + ix + ' ' + (iy + ih - icut) + ' L ' + ix + ' ' + (iy + icut) + ' Z';
    return '<path d="' + outer + '" fill="url(#dqi_bg)"/>' +
      '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="url(#dqi_grid)" opacity=".7" style="mix-blend-mode:screen"/>' +
      '<path d="' + outer + '" fill="none" stroke="url(#dqi_bv)" stroke-width="' + Math.max(5, Math.round(W * 0.0045)) + '" filter="url(#dqi_glow)" opacity=".95"/>' +
      '<path d="' + inner + '" fill="none" stroke="rgba(150,180,255,.22)" stroke-width="1.5"/>';
  }

  // brand logo + wordmark + tagline, anchored top-left of the group
  function brand(x, y, s, opts) {
    opts = opts || {};
    var center = opts.center;
    var hx = 0, hy = 4, R = 34 * s;
    // hexagon ring "Q"
    function hexPts(cx, cy, r) { var p = []; for (var i = 0; i < 6; i++) { var a = Math.PI / 180 * (60 * i - 90); p.push((cx + r * Math.cos(a)).toFixed(1) + "," + (cy + r * Math.sin(a)).toFixed(1)); } return p.join(" "); }
    var logo = '<g transform="translate(' + (hx + R) + ',' + (hy + R) + ')">' +
      '<polygon points="' + hexPts(0, 0, R) + '" fill="none" stroke="url(#dqi_bv)" stroke-width="' + (7 * s) + '" stroke-linejoin="round" filter="url(#dqi_glow)"/>' +
      '<polygon points="' + hexPts(0, 0, R * 0.52) + '" fill="url(#dqi_bv)" opacity=".30"/>' +
      '<line x1="' + (R * 0.34) + '" y1="' + (R * 0.34) + '" x2="' + (R * 0.92) + '" y2="' + (R * 0.92) + '" stroke="url(#dqi_bv)" stroke-width="' + (8 * s) + '" stroke-linecap="round"/>' +
      '</g>';
    var tx = hx + R * 2 + 16 * s;
    var word = '<text x="' + tx + '" y="' + (hy + R * 1.18) + '" font-size="' + (44 * s) + '" font-weight="800" letter-spacing="-.5" fill="url(#dqi_chrome)">DrFX<tspan fill="#cfdbf5">Quant</tspan></text>' +
      '<text x="' + (tx + 2) + '" y="' + (hy + R * 1.85) + '" font-size="' + (13.5 * s) + '" font-weight="700" letter-spacing="3.2" fill="' + COL.t3 + '">QUANTUM PRECISION · MARKET DOMINION</text>';
    var g = logo + word;
    if (center) {
      // measure-free centering: wrap and translate by half of an approximate width
      return '<g transform="translate(' + x + ',' + y + ')">' + g + '</g>';
    }
    return '<g transform="translate(' + x + ',' + y + ')">' + g + '</g>';
  }

  function tradePill(x, y, s) {
    s = s || 1;
    var w = 372 * s, h = 40 * s;
    return '<g transform="translate(' + x + ',' + y + ')">' +
      '<rect x="0" y="0" width="' + w + '" height="' + h + '" rx="' + (h / 2) + '" fill="rgba(20,30,64,.5)" stroke="' + COL.line + '"/>' +
      '<text x="' + (w / 2 - 16 * s) + '" y="' + (h * 0.66) + '" text-anchor="middle" font-size="' + (15 * s) + '" font-weight="700" letter-spacing="3" fill="#aebbe0">TRADE · QUANTIZE · CONQUER</text>' +
      '<text x="' + (w - 30 * s) + '" y="' + (h * 0.66) + '" font-size="' + (15 * s) + '" font-weight="800" fill="' + COL.cyan + '">›››</text>' +
      '</g>';
  }

  function title(x, y, s) {
    s = s || 1;
    return '<text x="' + x + '" y="' + y + '" font-size="' + (40 * s) + '" font-weight="800" letter-spacing="1.5">' +
      '<tspan fill="url(#dqi_bv)">QUANTUM LEAGUE</tspan><tspan fill="#cfdbf5"> ID CARD</tspan></text>';
  }

  function avatarDisc(cx, cy, r, d) {
    var inner;
    if (d._avatarData) {
      var cid = "dqi_ac";
      inner = '<clipPath id="' + cid + '"><circle cx="' + cx + '" cy="' + cy + '" r="' + (r - 6) + '"/></clipPath>' +
        '<image href="' + d._avatarData + '" x="' + (cx - r + 6) + '" y="' + (cy - r + 6) + '" width="' + (2 * (r - 6)) + '" height="' + (2 * (r - 6)) + '" preserveAspectRatio="xMidYMid slice" clip-path="url(#' + cid + ')"/>';
    } else {
      // silhouette + monogram
      inner = '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r - 6) + '" fill="url(#dqi_av)"/>' +
        '<g opacity=".5" fill="#0a1228"><circle cx="' + cx + '" cy="' + (cy - r * 0.18) + '" r="' + (r * 0.30) + '"/>' +
        '<path d="M ' + (cx - r * 0.52) + ' ' + (cy + r * 0.62) + ' a ' + (r * 0.52) + ' ' + (r * 0.46) + ' 0 0 1 ' + (r * 1.04) + ' 0 Z"/></g>' +
        '<text x="' + cx + '" y="' + (cy + r * 0.16) + '" text-anchor="middle" font-size="' + (r * 0.62) + '" font-weight="800" fill="rgba(190,210,255,.9)">' + esc2(d.initials) + '</text>';
    }
    return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="url(#dqi_ring)" stroke-width="5" filter="url(#dqi_glow)"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r - 3) + '" fill="#0a1430"/>' + inner;
  }

  function signature(x, y, s) {
    s = s || 1;
    return '<text x="' + x + '" y="' + y + '" font-size="' + (38 * s) + '" font-style="italic" font-family="Segoe Script, \'Brush Script MT\', \'Snell Roundhand\', cursive" fill="#dbe6ff" opacity=".92">DrFXQuant</text>' +
      '<line x1="' + x + '" y1="' + (y + 12 * s) + '" x2="' + (x + 230 * s) + '" y2="' + (y + 12 * s) + '" stroke="rgba(150,180,255,.35)" stroke-width="1.5"/>';
  }
  function verified(x, y, s) {
    s = s || 1;
    return '<text x="' + x + '" y="' + y + '" font-size="' + (15 * s) + '" font-weight="700" letter-spacing="2.5" fill="' + COL.t2 + '">VERIFIED MEMBER</text>' +
      '<g transform="translate(' + (x + 232 * s) + ',' + (y - 14 * s) + ') scale(' + s + ')">' +
      '<path d="M0 4 L9 0 L18 4 V13 C18 19 9 22 9 22 C9 22 0 19 0 13 Z" fill="rgba(28,132,255,.18)" stroke="' + COL.blue + '" stroke-width="1.5"/>' +
      '<path d="M5 10.5 L8 13.5 L13.5 7.5" fill="none" stroke="' + COL.blue + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></g>';
  }

  // hex-badge data row
  function hexIcon(cx, cy, r, inner, color) {
    var p = []; for (var i = 0; i < 6; i++) { var a = Math.PI / 180 * (60 * i); p.push((cx + r * Math.cos(a)).toFixed(1) + "," + (cy + r * Math.sin(a)).toFixed(1)); }
    return '<polygon points="' + p.join(" ") + '" fill="rgba(28,132,255,.08)" stroke="' + color + '" stroke-width="1.4" opacity=".9"/>' +
      '<g transform="translate(' + cx + ',' + cy + ')" stroke="' + color + '" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round">' + inner + '</g>';
  }
  var GI = {
    name: '<path d="M-6 7 a6 6 0 0 1 12 0"/><circle cx="0" cy="-3" r="3.4"/>',
    id: '<rect x="-7" y="-5" width="14" height="10" rx="1.6"/><circle cx="-3" cy="-1" r="1.8"/><line x1="1" y1="-2" x2="5" y2="-2"/><line x1="1" y1="1.5" x2="5" y2="1.5"/>',
    league: '<path d="M-5 -6 h10 v3 a5 5 0 0 1 -10 0 Z"/><path d="M0 -1 V4"/><path d="M-3 7 h6"/>',
    pulse: '<path d="M-7 0 H-3 L-1 -5 L2 5 L4 0 H7"/>',
    tier: '<path d="M-5 1 L0 -4 L5 1"/><path d="M-5 6 L0 1 L5 6"/>',
    cal: '<rect x="-6" y="-5" width="12" height="11" rx="1.6"/><line x1="-6" y1="-1" x2="6" y2="-1"/><line x1="-2" y1="-7" x2="-2" y2="-3"/><line x1="2" y1="-7" x2="2" y2="-3"/>'
  };
  function rowLabel(x, y, s, label, color) { return '<text x="' + x + '" y="' + y + '" font-size="' + (12.5 * s) + '" font-weight="800" letter-spacing="1.6" fill="' + (color || COL.blue) + '">' + label + '</text>'; }
  function rowValue(x, y, s, val, color) { return '<text x="' + x + '" y="' + y + '" font-size="' + (25 * s) + '" font-weight="700" fill="' + (color || COL.t1) + '">' + esc2(val) + '</text>'; }

  // The data block (name/id/league/status+ritual/tier/joined). Anchored at (x,y).
  function dataRows(x, y, w, s, d) {
    var rh = 70 * s, ix = x + 30 * s, tx = x + 64 * s, out = "";
    var rows = [
      ["name", "MEMBER NAME", d.name, COL.t1],
      ["id", "MEMBER ID", d.memberId, COL.t1],
      ["league", "LEAGUE", d.league, COL.t1],
      ["__sr__", "", "", ""],
      ["tier", "TIER", d.tier, COL.t1],
      ["cal", "JOINED", d.joined, COL.t1]
    ];
    var cy = y;
    for (var i = 0; i < rows.length; i++) {
      var R = rows[i];
      if (i > 0) out += '<line x1="' + (x + 18 * s) + '" y1="' + (cy - rh + 18 * s) + '" x2="' + (x + w - 18 * s) + '" y2="' + (cy - rh + 18 * s) + '" stroke="' + COL.line + '" stroke-width="1"/>';
      if (R[0] === "__sr__") {
        // combined STATUS / RITUAL row
        out += hexIcon(ix, cy - 8 * s, 15 * s, GI.pulse, COL.green) +
          rowLabel(tx, cy - 16 * s, s, "STATUS", COL.blue) + rowValue(tx, cy + 9 * s, s, d.status.txt, d.status.col) +
          '<line x1="' + (x + w * 0.52) + '" y1="' + (cy - 26 * s) + '" x2="' + (x + w * 0.52) + '" y2="' + (cy + 12 * s) + '" stroke="' + COL.line + '" stroke-width="1"/>' +
          rowLabel(x + w * 0.56, cy - 16 * s, s, "RITUAL", COL.violL) + rowValue(x + w * 0.56, cy + 9 * s, s, d.ritual.txt, d.ritual.col);
      } else {
        out += hexIcon(ix, cy - 8 * s, 15 * s, GI[R[0]], (R[0] === "league" ? d.lc.c : COL.blue)) +
          rowLabel(tx, cy - 16 * s, s, R[1], (R[0] === "league" ? d.lc.c : COL.blue)) +
          rowValue(tx, cy + 9 * s, s, R[2], R[3]);
      }
      cy += rh;
    }
    var panelH = rh * rows.length + 14 * s;
    return '<rect x="' + x + '" y="' + (y - 44 * s) + '" width="' + w + '" height="' + panelH + '" rx="' + (18 * s) + '" fill="rgba(10,18,42,.45)" stroke="' + COL.line + '"/>' + out;
  }

  // heraldic shield (atom) + crown + laurel + league plaque, centered at (cx,cy)
  function laurel(color) {
    var out = '';
    for (var side = -1; side <= 1; side += 2) {
      var stem = 'M ' + (side * 72) + ' -46 Q ' + (side * 86) + ' 4 ' + (side * 36) + ' 56';
      out += '<path d="' + stem + '" fill="none" stroke="' + color + '" stroke-width="2.4" opacity=".75"/>';
      for (var i = 0; i < 6; i++) {
        var tt = i / 5;
        var lx = side * (74 - tt * 34), ly = -44 + tt * 96, rot = side * 42 + (tt * 10 * side);
        out += '<ellipse cx="' + lx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" rx="6.5" ry="13" transform="rotate(' + rot.toFixed(1) + ' ' + lx.toFixed(1) + ' ' + ly.toFixed(1) + ')" fill="' + color + '" opacity=".85"/>';
      }
    }
    return out;
  }
  function shieldGroup(cx, cy, s, d) {
    var atom = '<g stroke="' + d.lc.c + '" stroke-width="2" fill="none" opacity=".95">' +
      '<ellipse cx="0" cy="-6" rx="27" ry="10.5"/><ellipse cx="0" cy="-6" rx="27" ry="10.5" transform="rotate(60)"/><ellipse cx="0" cy="-6" rx="27" ry="10.5" transform="rotate(120)"/>' +
      '</g><circle cx="0" cy="-6" r="5" fill="' + d.lc.c + '"/><circle cx="0" cy="-6" r="9" fill="' + d.lc.c + '" opacity=".25" filter="url(#dqi_soft)"/>';
    var crown = '<g transform="translate(0,-78)" fill="url(#dqi_sil)" stroke="rgba(255,255,255,.5)" stroke-width="1">' +
      '<path d="M-26 12 L-20 -6 L-9 7 L0 -12 L9 7 L20 -6 L26 12 Z"/>' +
      '<rect x="-27" y="11" width="54" height="7" rx="2"/>' +
      '<circle cx="-20" cy="-8" r="2.6"/><circle cx="0" cy="-14" r="3" fill="' + d.lc.c + '"/><circle cx="20" cy="-8" r="2.6"/></g>';
    var shield = '<path d="M-52 -58 L52 -58 L52 2 C52 40 28 60 0 72 C-28 60 -52 40 -52 2 Z" fill="url(#dqi_sil)" stroke="rgba(255,255,255,.55)" stroke-width="1.6"/>' +
      '<path d="M-52 -58 L0 -58 L0 72 C-28 60 -52 40 -52 2 Z" fill="rgba(255,255,255,.10)"/>' +
      '<path d="M-44 -50 L44 -50 L44 1 C44 34 24 52 0 63 C-24 52 -44 34 -44 1 Z" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="1"/>';
    return '<g transform="translate(' + cx + ',' + cy + ') scale(' + s + ')">' + laurel("#aab6cf") + crown + shield + atom + '</g>';
  }
  function plaque(cx, y, w, s, text, color) {
    var h = 40 * s, x = cx - w / 2;
    return '<g transform="translate(0,0)">' +
      '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + (8 * s) + '" fill="rgba(12,20,44,.7)" stroke="' + color + '" stroke-width="1.4"/>' +
      '<rect x="' + (x + 4 * s) + '" y="' + (y + 4 * s) + '" width="' + (w - 8 * s) + '" height="' + (h - 8 * s) + '" rx="' + (6 * s) + '" fill="none" stroke="rgba(255,255,255,.12)"/>' +
      '<text x="' + cx + '" y="' + (y + h * 0.66) + '" text-anchor="middle" font-size="' + (18 * s) + '" font-weight="800" letter-spacing="2.5" fill="url(#dqi_chrome)">' + esc2(text) + '</text></g>';
  }

  function qrBlock(cx, y, size, s, d) {
    var x = cx - size / 2, pad = size * 0.085;
    var inner = '';
    var mat = d._qr;
    if (mat && mat.length) {
      var n = mat.length, area = size - pad * 2, cell = area / n, rects = '';
      for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (mat[r][c]) {
        rects += '<rect x="' + (x + pad + c * cell).toFixed(2) + '" y="' + (y + pad + r * cell).toFixed(2) + '" width="' + (cell + 0.5).toFixed(2) + '" height="' + (cell + 0.5).toFixed(2) + '"/>';
      }
      inner = '<g fill="#0a1024">' + rects + '</g>';
    } else {
      inner = '<g transform="translate(' + cx + ',' + (y + size / 2) + ')" fill="none" stroke="#0a1024" stroke-width="3" stroke-linecap="round">' +
        '<rect x="-22" y="-10" width="44" height="34" rx="6"/><path d="M-12 -10 V-20 a12 12 0 0 1 24 0 V-10"/></g>';
    }
    return '<rect x="' + x + '" y="' + y + '" width="' + size + '" height="' + size + '" rx="' + (14 * s) + '" fill="#e9eef7" stroke="url(#dqi_ring)" stroke-width="2"/>' +
      '<rect x="' + (x + 4) + '" y="' + (y + 4) + '" width="' + (size - 8) + '" height="' + (size - 8) + '" rx="' + (11 * s) + '" fill="none" stroke="rgba(28,132,255,.3)"/>' + inner +
      '<text x="' + cx + '" y="' + (y + size + 26 * s) + '" text-anchor="middle" font-size="' + (14 * s) + '" font-weight="700" letter-spacing="3" fill="' + COL.t2 + '">SCAN TO VERIFY</text>';
  }

  function sideColumn(x, y, w, h) {
    var rain = '';
    var cols = Math.max(3, Math.floor(w / 16));
    for (var c = 0; c < cols; c++) {
      var cx = x + 8 + c * 16, bits = '';
      for (var r = 0; r < Math.floor(h / 18); r++) bits += ((c * 7 + r * 13) % 2);
      rain += '<text x="' + cx + '" y="' + (y + 14) + '" font-family="monospace" font-size="13" fill="' + COL.cyan + '" opacity="' + (0.10 + (c % 3) * 0.05) + '" writing-mode="tb" letter-spacing="5">' + bits + '</text>';
    }
    var globe = '<g transform="translate(' + (x + w / 2) + ',' + (y + h * 0.36) + ')" fill="none" stroke="' + COL.blue + '" stroke-width="1.6" opacity=".85"><circle r="22"/><ellipse rx="9" ry="22"/><line x1="-22" y1="0" x2="22" y2="0"/><line x1="-19" y1="-11" x2="19" y2="-11"/><line x1="-19" y1="11" x2="19" y2="11"/></g>';
    var lock = '<g transform="translate(' + (x + w / 2 - 11) + ',' + (y + h * 0.62) + ')" fill="none" stroke="' + COL.violL + '" stroke-width="2" stroke-linecap="round"><rect x="0" y="9" width="22" height="16" rx="3"/><path d="M4 9 V4 a7 7 0 0 1 14 0 V9"/></g>';
    var vbrand = '<text x="' + (x + w - 10) + '" y="' + (y + h * 0.5) + '" transform="rotate(90 ' + (x + w - 10) + ' ' + (y + h * 0.5) + ')" text-anchor="middle" font-size="22" font-weight="800" letter-spacing="6" fill="url(#dqi_bv)" opacity=".8">DrFXQUANT</text>';
    return '<g>' + rain + globe + lock + vbrand + '</g>';
  }

  function footer(x, y, w, s, d) {
    var h = 50 * s;
    var pill = 268 * s, px = x + w - pill - 14 * s;
    return '<line x1="' + x + '" y1="' + y + '" x2="' + (x + w) + '" y2="' + y + '" stroke="' + COL.line + '"/>' +
      '<text x="' + (x + 12 * s) + '" y="' + (y + h * 0.62) + '" font-size="' + (14 * s) + '" font-weight="700" letter-spacing="2" fill="' + COL.t3 + '">AQX™ ENCRYPTED · QUANTUM SECURE · ID VERIFIED ON BLOCKCHAIN</text>' +
      '<rect x="' + px + '" y="' + (y + h * 0.16) + '" width="' + pill + '" height="' + (h * 0.62) + '" rx="' + (h * 0.31) + '" fill="rgba(20,30,64,.6)" stroke="' + COL.line + '"/>' +
      '<text x="' + (px + pill / 2) + '" y="' + (y + h * 0.58) + '" text-anchor="middle" font-size="' + (16 * s) + '" font-weight="800" letter-spacing="2" fill="#cfdbf5">QID: ' + esc2(d.qid) + '</text>';
  }

  function sheen(W, H) {
    return '<path d="M0 0 L ' + (W * 0.42) + ' 0 L ' + (W * 0.20) + ' ' + H + ' L 0 ' + H + ' Z" fill="#ffffff" opacity=".03" style="mix-blend-mode:overlay"/>';
  }

  // ── full compositions ──────────────────────────────────────────────────────
  function landscapeBody(W, H, d) {
    return brand(96, 70, 1) +
      tradePill(W - 410, 116, 1) +
      title(96, 286, 1) +
      '<line x1="96" y1="312" x2="' + (W - 470) + '" y2="312" stroke="' + COL.line + '"/>' +
      avatarDisc(250, 486, 138, d) +
      signature(120, 706, 1) +
      verified(120, 792, 1) +
      dataRows(470, 396, 470, 1, d) +
      shieldGroup(1142, 312, 1.18, d) +
      plaque(1142, 452, 224, 1, d.league.toUpperCase(), d.lc.c) +
      qrBlock(1142, 556, 210, 1, d) +
      sideColumn(1356, 96, 96, H - 220) +
      footer(40, H - 96, W - 80, 1, d);
  }
  function portraitBody(W, H, d) {
    var cx = W / 2;
    return brand(cx - 270, 70, 1.06) +
      tradePill(cx - 186, 182, 1) +
      title(cx - 236, 266, 1) +
      '<line x1="' + (cx - 236) + '" y1="294" x2="' + (cx + 236) + '" y2="294" stroke="' + COL.line + '"/>' +
      avatarDisc(cx, 426, 108, d) +
      signature(cx - 116, 570, 0.95) +
      verified(cx - 132, 616, 0.92) +
      shieldGroup(cx, 746, 1.06, d) +
      plaque(cx, 858, 236, 1.02, d.league.toUpperCase(), d.lc.c) +
      dataRows(cx - 470, 972, 940, 1.2, d) +
      qrBlock(cx, 1496, 234, 1.06, d) +
      footer(40, H - 98, W - 80, 1.04, d);
  }

  function cardSVG(d, orient) {
    var land = orient !== "portrait";
    var W = land ? 1536 : 1080, H = land ? 1024 : 1920;
    var body = land ? landscapeBody(W, H, d) : portraitBody(W, H, d);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" ' +
      'font-family="Outfit, \'Trebuchet MS\', system-ui, sans-serif">' + defs(d) + frame(W, H) + body + sheen(W, H) + '</svg>';
  }

  // ── PNG export ─────────────────────────────────────────────────────────────
  function svgToPng(svg, W, H, scale) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
      var img = new Image();
      img.onload = function () {
        try {
          var cv = document.createElement("canvas"); cv.width = Math.round(W * scale); cv.height = Math.round(H * scale);
          var ctx = cv.getContext("2d"); ctx.setTransform(scale, 0, 0, scale, 0, 0);
          ctx.drawImage(img, 0, 0, W, H);
          URL.revokeObjectURL(url);
          cv.toBlob(function (b) { b ? res(b) : rej(new Error("export failed")); }, "image/png");
        } catch (e) { URL.revokeObjectURL(url); rej(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("render failed")); };
      img.src = url;
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  //  Overlay UI
  // ════════════════════════════════════════════════════════════════════════
  var _state = { orient: "landscape", data: null };

  function ensureCSS() {
    if (document.getElementById("dqid-css")) return;
    var s = document.createElement("style"); s.id = "dqid-css";
    s.textContent =
      "@keyframes dqidIn{from{opacity:0;transform:translateY(10px) scale(.99)}to{opacity:1;transform:none}}" +
      "#dqid-ov .dqid-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 16px;border-radius:13px;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit;border:1px solid " + COL.line + ";transition:transform .12s,opacity .2s}" +
      "#dqid-ov .dqid-btn:active{transform:scale(.96)}" +
      "#dqid-ov .dqid-card-wrap{animation:dqidIn .4s ease both}" +
      "#dqid-ov .dqid-seg{display:flex;background:rgba(10,16,40,.6);border:1px solid " + COL.line + ";border-radius:12px;padding:4px;gap:4px}" +
      "#dqid-ov .dqid-seg button{border:none;background:none;color:" + COL.t3 + ";font-weight:700;font-size:13px;padding:8px 14px;border-radius:9px;cursor:pointer;font-family:inherit}" +
      "#dqid-ov .dqid-seg button.on{background:linear-gradient(135deg,#1f8bff,#7c5cff);color:#fff}";
    document.head.appendChild(s);
  }

  function overlay() {
    ensureCSS();
    var ex = document.getElementById("dqid-ov"); if (ex) ex.remove();
    var th = (typeof t !== "undefined" && t) ? t : { bg: "#060d1f", p: "rgba(9,15,34,.9)", cd: "rgba(22,34,68,.5)", bd: COL.line, t1: COL.t1, t2: COL.t2, t3: COL.t3, pr: COL.blue };
    var ov = ce("div"); ov.id = "dqid-ov";
    ov.style.cssText = "position:fixed;inset:0;z-index:10010;display:flex;flex-direction:column;background:radial-gradient(ellipse 120% 90% at 50% -10%,#0c1838,#070d20 60%,#04060f);animation:dqidIn .25s ease";

    var bar = ce("div");
    bar.style.cssText = "display:flex;align-items:center;gap:11px;padding:calc(var(--sat,0px) + 12px) 16px 12px;flex-shrink:0;border-bottom:1px solid " + COL.line + ";background:rgba(7,13,32,.7);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px)";
    bar.innerHTML = '<span style="display:flex;color:' + COL.blue + ';filter:drop-shadow(0 0 8px rgba(28,132,255,.5))"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2.5"/><circle cx="8" cy="11" r="2.6"/><path d="M14 9h5M14 13h5M4.5 16.5a4 4 0 0 1 7 0"/></svg></span>' +
      '<div style="line-height:1.1"><div style="font-weight:800;color:' + COL.t1 + ';font-size:16px">Quantum League ID</div><div style="color:' + COL.t3 + ';font-size:11px">Your verifiable member card</div></div>';
    var sp = ce("div"); sp.style.flex = "1"; bar.appendChild(sp);
    var seg = ce("div"); seg.className = "dqid-seg"; seg.id = "dqid-seg";
    seg.innerHTML = '<button data-o="landscape" type="button">Desktop</button><button data-o="portrait" type="button">Mobile</button>';
    bar.appendChild(seg);
    var cls = ce("button"); cls.type = "button"; cls.className = "dqid-btn"; cls.style.cssText += ";margin-left:6px;width:42px;padding:0;height:42px;border-radius:50%;background:" + COL.cd + ";color:" + COL.t2;
    cls.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    cls.onclick = function () { ov.remove(); };
    bar.appendChild(cls);

    var body = ce("div"); body.id = "dqid-body";
    body.style.cssText = "flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:18px;padding:22px 16px calc(var(--sab,0px) + 26px)";

    var actions = ce("div");
    actions.style.cssText = "display:flex;flex-wrap:wrap;gap:10px;justify-content:center;align-items:center";
    actions.innerHTML =
      '<button id="dqid-dl" type="button" class="dqid-btn" style="background:linear-gradient(135deg,#1f8bff,#7c5cff);color:#fff;border-color:transparent;box-shadow:0 8px 24px rgba(74,108,255,.4)"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download PNG</button>' +
      '<button id="dqid-share" type="button" class="dqid-btn" style="background:' + COL.cd + ';color:' + COL.t1 + '"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>Share</button>' +
      '<button id="dqid-copy" type="button" class="dqid-btn" style="background:transparent;color:' + COL.t2 + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>Copy verify link</button>';

    ov.appendChild(bar); ov.appendChild(body);
    document.body.appendChild(ov);

    // wire segment
    seg.querySelectorAll("button").forEach(function (b) {
      b.onclick = function () { if (_state.orient === b.dataset.o) return; _state.orient = b.dataset.o; paint(); };
    });
    // wire actions (attached once; live across repaints since they read _state)
    actions.querySelector("#dqid-dl").onclick = doDownload;
    actions.querySelector("#dqid-share").onclick = doShare;
    actions.querySelector("#dqid-copy").onclick = doCopy;

    _actions = actions;
    return body;
  }
  var _actions = null;

  function paint() {
    var body = document.getElementById("dqid-body"); if (!body || !_state.data) return;
    var seg = document.getElementById("dqid-seg");
    if (seg) seg.querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b.dataset.o === _state.orient); });
    var land = _state.orient !== "portrait";
    var svg = cardSVG(_state.data, _state.orient);
    var maxW = land ? 920 : 460;
    body.innerHTML = "";
    var wrap = ce("div"); wrap.className = "dqid-card-wrap";
    wrap.style.cssText = "width:100%;max-width:" + maxW + "px;filter:drop-shadow(0 24px 60px rgba(0,0,0,.6))";
    wrap.innerHTML = svg;
    var svgEl = wrap.querySelector("svg"); if (svgEl) { svgEl.removeAttribute("width"); svgEl.removeAttribute("height"); svgEl.style.cssText = "width:100%;height:auto;display:block;border-radius:18px"; }
    body.appendChild(wrap);
    if (_actions) body.appendChild(_actions);
    var hint = ce("div");
    hint.style.cssText = "color:" + COL.t3 + ";font-size:12px;text-align:center;max-width:520px;line-height:1.5";
    hint.textContent = "Tip: “Share” lets you send the card straight to Telegram or save it to your photos. The QR verifies your membership.";
    body.appendChild(hint);
  }

  function filenameBase() {
    var nm = (_state.data && _state.data.memberId) || "card";
    return "DrFX-Quant-ID-" + nm + "-" + _state.orient;
  }
  function curBlob() {
    var land = _state.orient !== "portrait";
    var W = land ? 1536 : 1080, H = land ? 1024 : 1920;
    return svgToPng(cardSVG(_state.data, _state.orient), W, H, 2);
  }
  function doDownload() {
    var btn = document.getElementById("dqid-dl"); if (btn) { btn.style.opacity = ".6"; }
    curBlob().then(function (b) {
      var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = filenameBase() + ".png";
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      if (typeof showToast === "function") showToast("ID card saved", "Check your downloads / photos.");
    }).catch(function () { if (typeof showToast === "function") showToast("Export failed", "Please try again."); })
      .then(function () { if (btn) btn.style.opacity = "1"; });
  }
  function doShare() {
    var btn = document.getElementById("dqid-share"); if (btn) btn.style.opacity = ".6";
    curBlob().then(function (b) {
      var file = new File([b], filenameBase() + ".png", { type: "image/png" });
      var payload = { files: [file], title: "DrFX Quant ID", text: "My DrFX Quant Quantum League ID — " + (_state.data ? _state.data.league : "") };
      if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        navigator.share(payload).catch(function () {});
      } else {
        // fallback: download + nudge
        var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = filenameBase() + ".png";
        document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
        if (typeof showToast === "function") showToast("Card saved", "Sharing isn’t supported here — attach the saved image in Telegram.");
      }
    }).catch(function () { if (typeof showToast === "function") showToast("Couldn’t prepare image", "Please try again."); })
      .then(function () { if (btn) btn.style.opacity = "1"; });
  }
  function doCopy() {
    var url = (_state.data && _state.data.verifyUrl) || "";
    function ok() { if (typeof showToast === "function") showToast("Verify link copied", url); }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(url).then(ok, function () { prompt("Copy this link:", url); }); }
      else prompt("Copy this link:", url);
    } catch (e) { prompt("Copy this link:", url); }
  }

  // ── open ───────────────────────────────────────────────────────────────────
  function open() {
    _state.orient = (window.innerWidth <= 820) ? "portrait" : "landscape";
    var body = overlay();
    body.innerHTML = '<div style="color:' + COL.t3 + ';padding:60px 0;text-align:center">Minting your card…</div>';
    Promise.all([
      loadQR(),
      (typeof api === "function" ? api("/leagues/me").catch(function () { return {}; }) : Promise.resolve({}))
    ]).then(function (r) {
      var lg = r[1] || {};
      var d = buildData(lg);
      return resolveAvatar(d.avatar).then(function (av) {
        d._avatarData = av || null;
        d._qr = window.qrcode ? qrMatrix(d.verifyUrl) : null;
        _state.data = d;
        paint();
      });
    }).catch(function () {
      var b = document.getElementById("dqid-body");
      if (b) b.innerHTML = '<div style="color:#ff6b6b;padding:50px 16px;text-align:center">Could not build your ID card. Please try again.</div>';
    });
  }

  // ── profile entry (wrap openProfile, idempotent) ───────────────────────────
  function profileButton() {
    var th = (typeof t !== "undefined" && t) ? t : { cd: "rgba(22,34,68,.5)", bd: COL.line, t1: COL.t1, t3: COL.t3, pr: COL.blue };
    var card = ce("div"); card.id = "dq-idcard-entry";
    card.style.cssText = "position:relative;overflow:hidden;display:flex;align-items:center;gap:13px;padding:14px;border-radius:18px;background:linear-gradient(135deg,rgba(31,139,255,.12),rgba(124,92,255,.08));border:1px solid rgba(124,92,255,.3);margin-bottom:12px;cursor:pointer";
    card.innerHTML =
      '<span style="width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:rgba(28,132,255,.16);color:' + COL.blue + '"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2.5"/><circle cx="8" cy="11" r="2.6"/><path d="M14 9h5M14 13h5M4.5 16.5a4 4 0 0 1 7 0"/></svg></span>' +
      '<div style="flex:1;min-width:0"><div style="color:' + th.t3 + ';font-size:10px;letter-spacing:1.2px;font-weight:800;text-transform:uppercase">Membership</div>' +
      '<div style="color:' + th.t1 + ';font-size:16px;font-weight:800">Quantum League ID Card</div>' +
      '<div style="color:' + COL.violL + ';font-size:11.5px;font-weight:600">View · download · share to Telegram</div></div>' +
      '<span style="color:' + th.t3 + ';flex-shrink:0"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>';
    card.onclick = function () { open(); };
    return card;
  }
  function wrapHost() {
    if (typeof window.openProfile === "function" && !window.openProfile._dqIdWrapped) {
      var _op = window.openProfile;
      window.openProfile = function () {
        var r = _op.apply(this, arguments);
        setTimeout(function () {
          try {
            var save = document.getElementById("pp-save");
            if (save && save.parentNode && !document.getElementById("dq-idcard-entry")) {
              save.parentNode.insertBefore(profileButton(), save);
            }
          } catch (e) {}
        }, 0);
        return r;
      };
      window.openProfile._dqIdWrapped = true;
    }
  }

  window.dqIdCard = { open: open };
  wrapHost();
  setTimeout(wrapHost, 1200);
})();
