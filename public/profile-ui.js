/* ============================================================================
 * profile-ui.js — DrFX Quant Profile (high-fidelity faux-3D, LIVE DATA)
 * ----------------------------------------------------------------------------
 * Self-contained SPA module. Loads as a plain <script> AFTER index.html's main
 * script (and after leagues-ui.js / idcard.js / crystal3d.js). It REPLACES
 * window.openProfile with the approved 3D profile and wires every field to its
 * real source:
 *
 *   • QNTM Balance   ← GET /api/qntm/wallets/me               (wallet.available_balance)
 *   • Market XP      ← GET /api/market/me/stats               (.xp = 1000 + 100·like + 100·post)
 *   • Easy Trade XP  ← GET /api/easytrade/leaderboard?sort=xp (.me.xp = w·20 + l·5 + ⌊staked/100⌋)
 *   • TOTAL XP       = Market XP + Easy Trade XP              (shown with breakdown + milestone bar)
 *   • League name    ← GET /api/leagues/me                    (.currentLeagueName | "Unranked")
 *   • Account stats  ← GET /api/easytrade/leaderboard?sort=xp (.me settled / wins / winRate)
 *   • Name/@user/avatar/bio/email/role ← S.user.*
 *   • UID / since    ← deterministic from S.user (mirrors idcard.js)
 *   • Save           → PUT  /api/auth/profile                 (button keeps id "pp-save")
 *   • Avatar upload  → POST /api/upload
 *
 * The Premium-Tier crown and the League crystal are rendered as resolution-
 * independent faux-3D VECTOR ART (rich gradients, multi-facet geometry,
 * specular highlights, pulsing light emission, animated sparkles). Being pure
 * SVG+CSS they stay razor-sharp at any DPI/zoom with zero WebGL weight.
 *
 * Structural hooks kept so the rest of the app keeps working:
 *   • Save button keeps id "pp-save"  (idcard.js / leagues-ui.js inject before it)
 *   • hidden sentinels "dq-lg-card" + "dq-idcard-entry" suppress duplicate cards
 *
 * Set USE_LIVE_DATA = false to fall back to the hard-coded SAMPLE preview.
 * ========================================================================== */
(function () {
  "use strict";
  if (window.__dqProfileV2) return;
  window.__dqProfileV2 = true;

  // ── data source: live endpoints (set to false for the hard-coded preview) ───
  var USE_LIVE_DATA = true;

  // XP milestone step: the League card's progress bar fills toward the next
  // multiple of this (Market + Easy Trade are uncapped together, so a rolling
  // milestone is always meaningful). Tunable in one place.
  var XP_MILESTONE_STEP = 2500;

  // ── spec sample values (used while USE_LIVE_DATA === false) ─────────────────
  var SAMPLE = {
    qntm: "1,190.00",
    name: "DrFX",
    username: "drfx",
    role: "admin",
    roleName: "Admin",
    subtitle: "DrFX Quant Admin",
    email: "drfxai@gmail.com",
    bio: "",
    avatar: "",                  // empty -> emblem only, like the reference
    uid: "QNTM-7X9F-2025",
    memberRole: "Administrator",
    since: "May 24, 2025",
    league: "Unranked",
    marketXp: 1000,
    eztXp: 0,
    matches: 12,
    wins: 7,
    winRate: 58
  };

  // accent palette (spec: neon green + cyan + blue, ice-blue crown/crystal)
  var GREEN = "#16e29a", GREEN_GLOW = "rgba(22,226,154,.5)";
  var GREEN_GRAD = "linear-gradient(90deg,#0fd98a 0%,#36e36b 45%,#22c55e 100%)";
  var BLUE = "#7cc7ff", BLUE_GLOW = "rgba(96,170,255,.55)";
  var CYAN = "#22d3ee", VIOLET = "#a78bfa";

  function esc2(s) { return (typeof esc === "function") ? esc(s) : String(s == null ? "" : s); }

  // ── number formatting + deterministic UID/since (mirrors idcard.js) ─────────
  function num(n) { return Number(n || 0); }
  function fmtN(n) { return num(n).toLocaleString("en-US"); }
  function fmt2(n) { return num(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function hash32(str) { var h = 0x811c9dc5; str = String(str); for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return h >>> 0; }
  function makeUID(seed) {
    var a = hash32("dfx|" + seed), c = hash32("ax|" + seed);
    var L = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    var d4 = (a % 9000) + 1000;
    var two = L[(c >> 3) % 24] + L[(c >> 9) % 24];
    var d2 = (c % 90) + 10;
    return "QNTM-" + d4 + "-" + two + d2;
  }
  function memberSince(u) {
    var raw = u && (u.created_at || u.createdAt || u.joined || u.joined_at || u.member_since);
    var dt = raw ? new Date(raw) : null;
    if (!dt || isNaN(dt.getTime())) return null;
    return dt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  // XP milestone helper → { total, floorXp, nextXp, pct }
  function xpTier(total) {
    total = Math.max(0, num(total));
    var step = XP_MILESTONE_STEP;
    var idx = Math.floor(total / step);
    var floorXp = idx * step, nextXp = floorXp + step;
    var pct = step ? ((total - floorXp) / step) * 100 : 0;
    return { total: total, floorXp: floorXp, nextXp: nextXp, pct: Math.max(0, Math.min(100, pct)) };
  }

  // Build the initial values object. With live data we seed from S.user (sync)
  // and let wireLiveData() fill the async cards; otherwise we use SAMPLE.
  function buildValues() {
    if (!USE_LIVE_DATA) return SAMPLE;
    var u = (typeof S !== "undefined" && S.user) ? S.user : {};
    var role = u.role || "member";
    var roleName = role === "admin" ? "Admin" : role === "wizard" ? "Wizard" : "Member";
    var seed = String(u.id || u.username || u.name || "member");
    return {
      qntm: "\u2026",                                  // filled by wireLiveData
      name: u.name || u.username || "",
      username: u.username || "",
      role: role,
      roleName: roleName,
      subtitle: "DrFX Quant " + roleName,
      email: u.email || "",
      bio: u.bio || "",
      avatar: u.avatar || "",
      uid: makeUID(seed),
      memberRole: role === "admin" ? "Administrator" : roleName,
      since: memberSince(u) || "\u2014",
      league: "\u2026",                                // filled by wireLiveData
      marketXp: 0,                                     // filled by wireLiveData
      eztXp: 0,                                        // filled by wireLiveData
      matches: "\u2026",                               // filled by wireLiveData
      wins: "\u2026",
      winRate: "\u2026"
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // HIGH-DETAIL FAUX-3D VECTOR ART  (crown + crystal)
  // Pure SVG + CSS. Resolution-independent: crisp at any DPI / zoom level.
  // ════════════════════════════════════════════════════════════════════════════

  // reusable 4-point specular star
  function sparkle(cx, cy, r, op, delay) {
    return '<path class="dqca-spark" style="animation-delay:' + (delay || 0) + 'ms" d="M' + cx + ' ' + (cy - r) +
      ' Q' + (cx + r * 0.16) + ' ' + (cy - r * 0.16) + ' ' + (cx + r) + ' ' + cy +
      ' Q' + (cx + r * 0.16) + ' ' + (cy + r * 0.16) + ' ' + cx + ' ' + (cy + r) +
      ' Q' + (cx - r * 0.16) + ' ' + (cy + r * 0.16) + ' ' + (cx - r) + ' ' + cy +
      ' Q' + (cx - r * 0.16) + ' ' + (cy - r * 0.16) + ' ' + cx + ' ' + (cy - r) + ' Z" ' +
      'fill="#fff" opacity="' + (op == null ? 0.95 : op) + '"/>';
  }

  // ── REAL CROWN: jeweled crystalline circlet, 5 faceted spires, gem hearts ───
  function crownArt(w) {
    w = w || 168;
    var h = Math.round(w * (262 / 320));
    var id = "cw" + Math.random().toString(36).slice(2, 7);
    return '' +
      '<div class="dqca-crown" style="width:' + w + 'px;height:' + h + 'px">' +
      '<svg viewBox="0 0 320 262" width="' + w + '" height="' + h + '" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;overflow:visible">' +
        '<defs>' +
          // crystalline ice metal (vertical body)
          '<linearGradient id="' + id + 'ice" x1="160" y1="20" x2="160" y2="210" gradientUnits="userSpaceOnUse"><stop stop-color="#f4fbff"/><stop offset=".28" stop-color="#cfeaff"/><stop offset=".62" stop-color="#74b6ef"/><stop offset="1" stop-color="#1f4f8c"/></linearGradient>' +
          '<linearGradient id="' + id + 'iceD" x1="160" y1="40" x2="160" y2="210" gradientUnits="userSpaceOnUse"><stop stop-color="#5d9bdb"/><stop offset="1" stop-color="#16335f"/></linearGradient>' +
          '<linearGradient id="' + id + 'iceB" x1="160" y1="20" x2="160" y2="150" gradientUnits="userSpaceOnUse"><stop stop-color="#ffffff"/><stop offset="1" stop-color="#d8f1ff"/></linearGradient>' +
          // band
          '<linearGradient id="' + id + 'band" x1="160" y1="168" x2="160" y2="212" gradientUnits="userSpaceOnUse"><stop stop-color="#bfe3ff"/><stop offset=".5" stop-color="#5aa6ec"/><stop offset="1" stop-color="#14376b"/></linearGradient>' +
          '<linearGradient id="' + id + 'bandT" x1="160" y1="160" x2="160" y2="178" gradientUnits="userSpaceOnUse"><stop stop-color="#f2fbff"/><stop offset="1" stop-color="#9fd0ff"/></linearGradient>' +
          // gems
          '<radialGradient id="' + id + 'gemG" cx="160" cy="186" r="26" gradientUnits="userSpaceOnUse"><stop stop-color="#eafff6"/><stop offset=".4" stop-color="#16e29a"/><stop offset="1" stop-color="#0a6f4d"/></radialGradient>' +
          '<radialGradient id="' + id + 'gemB" cx=".4" cy=".34" r=".75"><stop stop-color="#f1f9ff"/><stop offset=".45" stop-color="#7cc7ff"/><stop offset="1" stop-color="#1c4f8f"/></radialGradient>' +
          '<radialGradient id="' + id + 'pearl" cx=".36" cy=".3" r=".78"><stop stop-color="#ffffff"/><stop offset=".5" stop-color="#dcefff"/><stop offset="1" stop-color="#6ea8e0"/></radialGradient>' +
          // ambient halo + ground
          '<radialGradient id="' + id + 'halo" cx="160" cy="135" r="150" gradientUnits="userSpaceOnUse"><stop stop-color="rgba(90,175,255,.42)"/><stop offset="1" stop-color="rgba(90,175,255,0)"/></radialGradient>' +
          '<radialGradient id="' + id + 'grd" cx="160" cy="232" r="120" gradientUnits="userSpaceOnUse"><stop stop-color="rgba(70,150,255,.55)"/><stop offset="1" stop-color="rgba(70,150,255,0)"/></radialGradient>' +
          '<filter id="' + id + 'blur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="6"/></filter>' +
        '</defs>' +

        // ambient glow + cast shadow
        '<rect x="0" y="0" width="320" height="262" fill="url(#' + id + 'halo)"/>' +
        '<ellipse cx="160" cy="234" rx="104" ry="20" fill="url(#' + id + 'grd)"/>' +

        '<g class="dqca-float">' +

          // ── 5 faceted spires (drawn back-to-front: outer, mid, centre) ──────
          // each spire = lit facet (bright) + shade facet (dark) + ridge highlight + tip orb
          // outer-left
          '<path d="M64 176 L80 104 L96 176 Z" fill="url(#' + id + 'iceD)"/>' +
          '<path d="M80 104 L96 176 L88 176 L80 116 Z" fill="url(#' + id + 'ice)"/>' +
          '<path d="M80 104 L80 176 L72 176 L80 116 Z" fill="url(#' + id + 'iceB)" opacity=".9"/>' +
          // outer-right
          '<path d="M224 176 L240 104 L256 176 Z" fill="url(#' + id + 'iceD)"/>' +
          '<path d="M240 104 L240 176 L232 176 L240 116 Z" fill="url(#' + id + 'ice)"/>' +
          '<path d="M240 104 L248 176 L240 176 L240 116 Z" fill="url(#' + id + 'iceB)" opacity=".75"/>' +
          // mid-left
          '<path d="M104 178 L120 64 L136 178 Z" fill="url(#' + id + 'iceD)"/>' +
          '<path d="M120 64 L136 178 L126 178 L120 80 Z" fill="url(#' + id + 'ice)"/>' +
          '<path d="M120 64 L120 178 L110 178 L120 80 Z" fill="url(#' + id + 'iceB)" opacity=".92"/>' +
          // mid-right
          '<path d="M184 178 L200 64 L216 178 Z" fill="url(#' + id + 'iceD)"/>' +
          '<path d="M200 64 L200 178 L190 178 L200 80 Z" fill="url(#' + id + 'ice)"/>' +
          '<path d="M200 64 L210 178 L200 178 L200 80 Z" fill="url(#' + id + 'iceB)" opacity=".75"/>' +
          // centre spire (tallest, trefoil crown)
          '<path d="M138 182 L160 30 L182 182 Z" fill="url(#' + id + 'iceD)"/>' +
          '<path d="M160 30 L182 182 L168 182 L160 52 Z" fill="url(#' + id + 'ice)"/>' +
          '<path d="M160 30 L160 182 L152 182 L160 52 Z" fill="url(#' + id + 'iceB)"/>' +
          // ridge highlights down each spire
          '<path d="M80 110 L80 174 M120 70 L120 176 M160 38 L160 180 M200 70 L200 176 M240 110 L240 174" stroke="rgba(255,255,255,.7)" stroke-width="1.4" stroke-linecap="round"/>' +
          // spire edge glints
          '<path d="M160 30 L182 182 M120 64 L136 178 M200 64 L216 178" stroke="rgba(180,230,255,.5)" stroke-width="1"/>' +

          // ── valleys between spires (small inner points) ─────────────────────
          '<path d="M96 176 L100 150 L104 178 Z M136 178 L138 158 L138 182 Z M182 182 L182 158 L184 178 Z M216 178 L220 150 L224 176 Z" fill="url(#' + id + 'iceD)" opacity=".85"/>' +

          // ── jeweled band (circlet) ──────────────────────────────────────────
          '<path d="M58 168 Q160 150 262 168 L262 200 Q160 222 58 200 Z" fill="url(#' + id + 'band)" stroke="#bfe6ff" stroke-width="1.4" stroke-linejoin="round"/>' +
          '<path d="M58 168 Q160 150 262 168 L262 176 Q160 158 58 176 Z" fill="url(#' + id + 'bandT)"/>' +
          // beaded gold/ice studs along the band edges
          '<g fill="#eaf7ff" opacity=".9">' +
            '<circle cx="80" cy="206" r="2.4"/><circle cx="104" cy="210" r="2.4"/><circle cx="128" cy="212" r="2.4"/><circle cx="160" cy="213" r="2.6"/><circle cx="192" cy="212" r="2.4"/><circle cx="216" cy="210" r="2.4"/><circle cx="240" cy="206" r="2.4"/>' +
          '</g>' +

          // ── band gems: side sapphires + centre emerald (brand green) ────────
          '<g>' +
            '<circle cx="110" cy="190" r="11" fill="url(#' + id + 'gemB)" stroke="#dff1ff" stroke-width="1"/>' +
            '<path d="M110 181 L116 190 L110 199 L104 190 Z" fill="rgba(255,255,255,.45)"/>' +
            '<circle cx="210" cy="190" r="11" fill="url(#' + id + 'gemB)" stroke="#dff1ff" stroke-width="1"/>' +
            '<path d="M210 181 L216 190 L210 199 L204 190 Z" fill="rgba(255,255,255,.45)"/>' +
          '</g>' +
          // centre emerald — emerald-cut, faceted
          '<g>' +
            '<rect x="143" y="172" width="34" height="30" rx="4" transform="rotate(0 160 187)" fill="url(#' + id + 'gemG)" stroke="#d6ffe9" stroke-width="1.4"/>' +
            '<path d="M149 178 H171 L166 196 H154 Z" fill="rgba(255,255,255,.28)"/>' +
            '<path d="M143 172 L149 178 M177 172 L171 178 M143 202 L149 196 M177 202 L171 196" stroke="rgba(255,255,255,.5)" stroke-width="1"/>' +
            '<rect x="148" y="177" width="10" height="8" rx="2" fill="rgba(255,255,255,.35)"/>' +
          '</g>' +

          // ── tip orbs / pearls on each spire ─────────────────────────────────
          '<circle cx="160" cy="30" r="8.5" fill="url(#' + id + 'pearl)" stroke="#eaf7ff" stroke-width="1"/>' +
          '<circle cx="120" cy="64" r="6.5" fill="url(#' + id + 'pearl)" stroke="#eaf7ff" stroke-width=".8"/>' +
          '<circle cx="200" cy="64" r="6.5" fill="url(#' + id + 'pearl)" stroke="#eaf7ff" stroke-width=".8"/>' +
          '<circle cx="80" cy="104" r="5.5" fill="url(#' + id + 'pearl)" stroke="#eaf7ff" stroke-width=".8"/>' +
          '<circle cx="240" cy="104" r="5.5" fill="url(#' + id + 'pearl)" stroke="#eaf7ff" stroke-width=".8"/>' +

        '</g>' +

        // ── specular sparkles (twinkle) ───────────────────────────────────────
        sparkle(160, 26, 9, 0.95, 0) +
        sparkle(120, 60, 6, 0.85, 600) +
        sparkle(110, 186, 5, 0.8, 1100) +
        sparkle(210, 186, 5, 0.8, 300) +
        sparkle(160, 184, 6, 0.9, 1500) +

        // floating motes
        '<g fill="#cfeaff">' +
          '<circle class="dqca-mote" style="animation-delay:0ms" cx="40" cy="120" r="2"/>' +
          '<circle class="dqca-mote" style="animation-delay:900ms" cx="284" cy="96" r="2.4"/>' +
          '<circle class="dqca-mote" style="animation-delay:1700ms" cx="268" cy="150" r="1.8"/>' +
          '<circle class="dqca-mote" style="animation-delay:500ms" cx="52" cy="70" r="1.6"/>' +
        '</g>' +
      '</svg>' +
      '</div>';
  }

  // ── REAL CRYSTAL: faceted brilliant-cut obelisk shard, internal dispersion ──
  function crystalArt(w) {
    w = w || 116;
    var h = Math.round(w * (320 / 240));
    var id = "cy" + Math.random().toString(36).slice(2, 7);
    return '' +
      '<div class="dqca-crystal" style="width:' + w + 'px;height:' + h + 'px">' +
      '<svg viewBox="0 0 240 320" width="' + w + '" height="' + h + '" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;overflow:visible">' +
        '<defs>' +
          // facet gradients (light / medium / dark) for faux-3D faceting
          '<linearGradient id="' + id + 'lit" x1="120" y1="24" x2="170" y2="240" gradientUnits="userSpaceOnUse"><stop stop-color="#ffffff"/><stop offset=".4" stop-color="#bfe6ff"/><stop offset="1" stop-color="#3f8fd6"/></linearGradient>' +
          '<linearGradient id="' + id + 'med" x1="120" y1="24" x2="100" y2="300" gradientUnits="userSpaceOnUse"><stop stop-color="#dff2ff"/><stop offset=".5" stop-color="#7cc0f2"/><stop offset="1" stop-color="#234f88"/></linearGradient>' +
          '<linearGradient id="' + id + 'drk" x1="120" y1="120" x2="120" y2="300" gradientUnits="userSpaceOnUse"><stop stop-color="#5a9bda"/><stop offset="1" stop-color="#102a52"/></linearGradient>' +
          '<linearGradient id="' + id + 'drk2" x1="60" y1="150" x2="120" y2="300" gradientUnits="userSpaceOnUse"><stop stop-color="#3f78bd"/><stop offset="1" stop-color="#0b1e3e"/></linearGradient>' +
          '<radialGradient id="' + id + 'core" cx="120" cy="150" r="90" gradientUnits="userSpaceOnUse"><stop stop-color="rgba(230,248,255,.85)"/><stop offset=".5" stop-color="rgba(124,199,255,.25)"/><stop offset="1" stop-color="rgba(124,199,255,0)"/></radialGradient>' +
          '<radialGradient id="' + id + 'halo" cx="120" cy="160" r="150" gradientUnits="userSpaceOnUse"><stop stop-color="rgba(90,175,255,.4)"/><stop offset="1" stop-color="rgba(90,175,255,0)"/></radialGradient>' +
          '<radialGradient id="' + id + 'grd" cx="120" cy="298" r="96" gradientUnits="userSpaceOnUse"><stop stop-color="rgba(40,220,170,.5)"/><stop offset=".5" stop-color="rgba(70,150,255,.4)"/><stop offset="1" stop-color="rgba(70,150,255,0)"/></radialGradient>' +
        '</defs>' +

        // ambient halo + ground caustic
        '<rect x="0" y="0" width="240" height="320" fill="url(#' + id + 'halo)"/>' +
        '<ellipse cx="120" cy="300" rx="80" ry="16" fill="url(#' + id + 'grd)"/>' +

        '<g class="dqca-float2">' +
          // ── facets (front face split by central ridge T–M–C) ────────────────
          // M = (120,150) centre,  T=(120,24)  girdle L2=(54,150) R2=(186,150)
          // upper-left front
          '<polygon points="120,24 120,150 54,150 88,78" fill="url(#' + id + 'med)"/>' +
          // upper-right front (lit)
          '<polygon points="120,24 152,78 186,150 120,150" fill="url(#' + id + 'lit)"/>' +
          // lower-left front (dark)
          '<polygon points="120,150 54,150 84,238 120,300" fill="url(#' + id + 'drk2)"/>' +
          // lower-right front (medium-dark)
          '<polygon points="120,150 120,300 156,238 186,150" fill="url(#' + id + 'drk)"/>' +
          // narrow outer bevels for thickness
          '<polygon points="120,24 88,78 54,150 54,150" fill="rgba(255,255,255,.10)"/>' +
          '<polygon points="186,150 152,78 120,24" fill="rgba(255,255,255,.18)"/>' +

          // internal core glow
          '<ellipse cx="120" cy="150" rx="58" ry="92" fill="url(#' + id + 'core)"/>' +

          // ── outline + facet edges ───────────────────────────────────────────
          '<polygon points="120,24 152,78 186,150 156,238 120,300 84,238 54,150 88,78" fill="none" stroke="#e6f6ff" stroke-width="1.6" stroke-linejoin="round"/>' +
          '<path d="M120 24 L120 300 M88 78 L120 150 L152 78 M54 150 L120 150 L186 150 M84 238 L120 150 L156 238" stroke="rgba(255,255,255,.45)" stroke-width="1"/>' +
          // bright lit-edge accents
          '<path d="M120 24 L152 78 L186 150" stroke="rgba(255,255,255,.85)" stroke-width="1.6" stroke-linecap="round"/>' +
          // table flash near apex
          '<polygon points="120,30 134,66 120,86 106,66" fill="rgba(255,255,255,.4)"/>' +

          // faint chromatic dispersion along edges (subtle, on-brand)
          '<path d="M89 80 L56 148" stroke="rgba(34,211,238,.5)" stroke-width="1.4" stroke-linecap="round"/>' +
          '<path d="M118 152 L86 236" stroke="rgba(167,139,250,.4)" stroke-width="1.2" stroke-linecap="round"/>' +
          '<path d="M122 152 L120 298" stroke="rgba(22,226,154,.4)" stroke-width="1.2" stroke-linecap="round"/>' +
        '</g>' +

        // specular sparkles
        sparkle(140, 70, 8, 0.95, 0) +
        sparkle(120, 150, 7, 0.85, 800) +
        sparkle(150, 120, 5, 0.8, 1400) +
        sparkle(96, 100, 4, 0.7, 500) +

        // floating motes
        '<g fill="#cfeaff">' +
          '<circle class="dqca-mote" style="animation-delay:200ms" cx="30" cy="120" r="2"/>' +
          '<circle class="dqca-mote" style="animation-delay:1000ms" cx="208" cy="96" r="2.2"/>' +
          '<circle class="dqca-mote" style="animation-delay:1600ms" cx="196" cy="180" r="1.6"/>' +
          '<circle class="dqca-mote" style="animation-delay:600ms" cx="40" cy="60" r="1.6"/>' +
        '</g>' +
      '</svg>' +
      '</div>';
  }

  // ── small inline icons ──────────────────────────────────────────────────────
  function svgGear(c) { return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="' + c + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'; }
  function svgCheckCircle() { return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="11" fill="rgba(28,132,255,.18)" stroke="' + BLUE + '" stroke-width="1.6"/><path d="M7.5 12.3l3 3 6-6.5" fill="none" stroke="' + BLUE + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
  // little inline XP marks for the breakdown chips
  function svgChart(c) { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="' + c + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="20" x2="6" y2="12"/><line x1="12" y1="20" x2="12" y2="5"/><line x1="18" y1="20" x2="18" y2="14"/></svg>'; }
  function svgBolt(c) { return '<svg width="15" height="15" viewBox="0 0 24 24" fill="' + c + '"><path d="M13 2L4 14h6l-1 8 9-12h-6z"/></svg>'; }

  // ════════════════════════════════════════════════════════════════════════════
  function openProfileV2() {
    modal("Profile", function (body, close) {
      // values: live (seeded from S.user) or SAMPLE preview
      var V = buildValues();
      var LIVE_AVATAR = null;   // set if the user uploads a new avatar this session
      var _lt = false; try { _lt = document.documentElement.classList.contains("dq-light"); } catch (e) {}  // follow the app light/dark theme

      // widen + de-pad the host modal so cards reach the edges like the mockup
      var md = body.closest(".dq-modal-md");
      var wide = window.innerWidth >= 920;
      if (md) {
        // full-screen: fill the viewport edge-to-edge (was a centered 560/900px card)
        md.style.width = "100%";
        md.style.maxWidth = "none";
        md.style.borderRadius = "0";
        md.style.margin = "0";
        md.style.padding = "0";
        md.style.border = "none";
        md.style.overflowY = "auto";
        md.style.setProperty("max-height", "none", "important");  // beat the .dq-modal-md CSS cap
        md.style.background = _lt ? "radial-gradient(130% 90% at 50% -10%,#f4f8fd,#e9eff8 55%,#e3ebf6)" : "radial-gradient(130% 90% at 50% -10%,#0d1838,#080f26 55%,#05091c)";
        var _pov = md.parentNode;   // the .dq-modal-ov host: drop the centering pad, stretch full-height
        if (_pov && _pov.classList && _pov.classList.contains("dq-modal-ov")) {
          _pov.style.padding = "0";
          _pov.style.alignItems = "stretch";
        }
        var hdr = md.firstElementChild;
        if (hdr && hdr.querySelector && hdr.querySelector("#md-cl")) hdr.style.display = "none";
      }

      var cap, txt1, txt2, cardBg, cardB;
      if (_lt) {
        cap = "#5c6d8c"; txt1 = "#141a26"; txt2 = "#42536f";
        cardBg = "rgba(255,255,255,.72)"; cardB = "rgba(70,110,180,.22)";
      } else {
        cap = "#7d93b8"; txt1 = "#eaf2ff"; txt2 = "#b8c8e8";
        cardBg = "rgba(14,24,50,.55)"; cardB = "rgba(120,160,255,.16)";
      }

      // ── LEFT: Profile header panel ──────────────────────────────────────────
      var leftHeader =
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">' +
          '<div><div style="font-size:26px;font-weight:900;color:' + txt1 + ';letter-spacing:-.3px">Profile</div>' +
          '<div style="color:' + cap + ';font-size:13px;margin-top:3px;line-height:1.4">Manage your account<br>and preferences</div></div>' +
          '<button id="pp-gear" type="button" title="Settings" style="width:38px;height:38px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:rgba(28,132,255,.14);border:1px solid ' + cardB + ';color:' + BLUE + ';cursor:pointer">' + svgGear(BLUE) + '</button>' +
        '</div>' +
        // QNTM balance compact card
        '<div id="dq-wallet-chip" title="Open your QNTM wallet" style="cursor:pointer;display:flex;align-items:center;gap:12px;margin-top:16px;padding:12px 14px;border-radius:16px;background:' + cardBg + ';border:1px solid ' + cardB + '">' +
          '<div style="width:40px;height:40px;border-radius:11px;background:' + GREEN_GRAD + ';display:flex;align-items:center;justify-content:center;color:#04140d;font-size:19px;font-weight:900;box-shadow:0 4px 14px ' + GREEN_GLOW + '">Q</div>' +
          '<div style="flex:1;min-width:0"><div style="color:' + cap + ';font-size:12px">QNTM Balance</div><div id="dq-wc-bal" style="color:' + txt1 + ';font-size:20px;font-weight:900;line-height:1.15">' + V.qntm + '</div></div>' +
        '</div>';

      // emblem (concentric neon rings + winged DrFX crest), no avatar img by default
      // orbiting ember sparks emitted around the rotating rings
      var ppxSparks = "";
      for (var _si = 0; _si < 12; _si++) ppxSparks += '<div class="ppx-spk-wrap" style="transform:rotate(' + (_si * 30) + 'deg)"><span class="ppx-spk" style="animation-delay:' + ((_si * 210) % 2520) + 'ms"></span></div>';

      var emblem =
        '<div style="position:relative;width:200px;height:200px;margin:18px auto 0">' +
          '<div class="ppx-ring ppx-r1"></div><div class="ppx-ring ppx-r2"></div><div class="ppx-ring ppx-r3"></div>' +
          '<div class="ppx-orbit"><span class="ppx-node" style="top:-5px;left:50%"></span><span class="ppx-node" style="bottom:-5px;left:50%"></span><span class="ppx-node" style="left:-5px;top:50%"></span><span class="ppx-node" style="right:-5px;top:50%"></span></div>' +
          '<div class="ppx-sparks">' + ppxSparks + '</div>' +
          '<div id="pp-av" style="position:absolute;inset:28px;border-radius:50%;cursor:pointer;overflow:hidden;background:radial-gradient(circle at 50% 28%,#12244e,#05091c);display:flex;align-items:center;justify-content:center;box-shadow:inset 0 0 34px rgba(0,0,0,.75),0 0 26px ' + GREEN_GLOW + '">' +
            (V.avatar
              ? ((typeof avatar === "function") ? avatar(V.avatar, 144) : '<img src="' + esc2(V.avatar) + '" style="width:144px;height:144px;border-radius:50%;object-fit:cover"/>')
              : emblemCrest()) +
          '</div>' +
          '<input id="pp-fi" type="file" accept="image/*" style="display:none"/>' +
        '</div>' +
        // ELITE + admin pills, name + verify, subtitle
        '<div style="text-align:center;margin-top:14px"><span style="display:inline-block;padding:7px 26px;border-radius:13px;background:rgba(8,18,36,.85);border:1.5px solid ' + GREEN + ';box-shadow:0 0 18px ' + GREEN_GLOW + ',inset 0 0 10px ' + GREEN_GLOW + ';font-weight:900;letter-spacing:3px;font-size:15px;color:' + GREEN + ';text-shadow:0 0 12px ' + GREEN_GLOW + '">ELITE</span></div>' +
        '<div style="text-align:center;margin-top:10px"><span style="display:inline-block;padding:4px 16px;border-radius:11px;background:rgba(124,92,255,.16);border:1px solid rgba(124,92,255,.45);color:' + VIOLET + ';font-size:12.5px;font-weight:700">' + esc2(V.role) + '</span></div>' +
        '<div style="display:flex;align-items:center;justify-content:center;gap:9px;margin-top:10px">' +
          '<input id="pp-n" value="' + esc2(V.name) + '" style="text-align:center;width:auto;max-width:60%;border:none;background:none;color:' + txt1 + ';font-size:30px;font-weight:900;font-family:\'Outfit\',sans-serif;outline:none"/>' +
          '<svg width="22" height="22" viewBox="0 0 24 24"><path fill="' + BLUE + '" d="M12 1l2.6 1.9 3.2-.2 1 3 2.6 1.8-1 3 1 3-2.6 1.8-1 3-3.2-.2L12 23l-2.6-1.9-3.2.2-1-3L2.6 16.5l1-3-1-3 2.6-1.8 1-3 3.2.2z"/><path d="M8.5 12.3l2.4 2.4 4.6-5" fill="none" stroke="#04140d" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</div>' +
        '<div style="text-align:center;margin-top:6px"><input id="pp-u" value="' + esc2(V.username) + '" placeholder="username" style="text-align:center;width:auto;max-width:70%;padding:3px 14px;border-radius:11px;background:rgba(30,110,240,.18);border:1px solid rgba(120,160,255,.22);color:' + BLUE + ';font-size:12px;font-weight:600;font-family:\'Outfit\',sans-serif;outline:none"/></div>' +
        '<div style="text-align:center;color:' + cap + ';font-size:14px;margin-top:8px">' + esc2(V.subtitle) + '</div>';

      // Bio + Email input-style cards
      var bioEmail =
        '<div style="display:flex;align-items:flex-start;gap:13px;padding:14px 16px;border-radius:18px;background:' + cardBg + ';border:1px solid ' + cardB + ';margin-top:18px">' +
          '<div style="width:42px;height:42px;border-radius:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:rgba(28,132,255,.14);color:' + BLUE + '"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>' +
          '<div style="flex:1;min-width:0"><div style="color:' + cap + ';font-size:13px;margin-bottom:3px">Bio</div><textarea id="pp-b" maxlength="120" rows="2" placeholder="Tell us about yourself..." style="width:100%;resize:none;border:none;background:none;color:' + txt1 + ';font-size:15px;font-weight:600;font-family:\'Outfit\',sans-serif;outline:none;line-height:1.4">' + esc2(V.bio) + '</textarea><div style="text-align:right;color:#56688c;font-size:11px"><span id="pp-bc">' + (V.bio || "").length + '</span>/120</div></div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:13px;padding:14px 16px;border-radius:18px;background:' + cardBg + ';border:1px solid ' + cardB + ';margin-top:13px">' +
          '<div style="width:42px;height:42px;border-radius:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:rgba(28,132,255,.14);color:' + BLUE + '"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg></div>' +
          '<div style="flex:1;min-width:0"><div style="color:' + cap + ';font-size:13px;margin-bottom:1px">Email</div><div style="color:' + txt1 + ';font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc2(V.email) + '</div></div>' +
        '</div>';

      var saveBlock =
        '<button id="pp-save" type="button" style="position:relative;overflow:hidden;width:100%;margin-top:16px;padding:16px;border-radius:15px;border:none;cursor:pointer;background:' + GREEN_GRAD + ';color:#04140d;font-size:17px;font-weight:900;font-family:\'Outfit\',sans-serif;box-shadow:0 8px 28px ' + GREEN_GLOW + ';display:flex;align-items:center;justify-content:center;gap:10px;-webkit-appearance:none"><span class="ppx-save-gloss"></span><span class="ppx-save-shine"></span><span style="position:relative;z-index:2;display:flex;align-items:center;gap:10px"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#04140d" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Save Changes</span></button>' +
        '<div style="text-align:center;color:' + cap + ';font-size:12px;margin-top:11px;display:flex;align-items:center;justify-content:center;gap:6px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="' + GREEN + '" stroke-width="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Your data is secure with us</div>' +
        '<div id="dq-lg-card" style="display:none"></div><div id="dq-idcard-entry" style="display:none"></div>';

      // bottom mobile nav strip (baked into the design per the spec)
      var navBar = (window.dqAppNav ? window.dqAppNav.html("profile") : ""); var _ignoredNav =
        '<div style="display:flex;align-items:center;justify-content:space-around;margin-top:20px;padding:12px 8px calc(12px + var(--sab));border-top:1px solid ' + cardB + ';background:rgba(6,12,28,.6)">' +
          navIcon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', BLUE, true) +
          navIcon('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>', cap, false) +
          '<div style="width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:' + GREEN_GRAD + ';box-shadow:0 6px 22px ' + GREEN_GLOW + ',0 0 0 5px rgba(34,226,154,.12)"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#04140d" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>' +
          navIcon('<line x1="6" y1="20" x2="6" y2="12"/><line x1="12" y1="20" x2="12" y2="6"/><line x1="18" y1="20" x2="18" y2="14"/>', cap, false) +
          navIcon('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>', cap, false) +
        '</div>';

      // ── RIGHT: Premium / League+XP / Membership / Activity ──────────────────
      var feats = ["Priority Support", "Advanced Analytics", "Early Access Features", "Exclusive Rewards"];
      var checks = feats.map(function (f) {
        return '<div style="display:flex;align-items:center;gap:11px;margin-bottom:13px">' + svgCheckCircle() + '<span style="color:' + txt2 + ';font-size:15px;font-weight:600">' + f + '</span></div>';
      }).join("");
      var premiumCard =
        '<div style="position:relative;overflow:hidden;padding:20px;border-radius:20px;background:linear-gradient(150deg,rgba(20,32,66,.7),rgba(10,18,40,.55));border:1px solid ' + cardB + ';box-shadow:0 12px 40px rgba(0,0,0,.35)">' +
          '<div style="position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,' + BLUE + ',transparent)"></div>' +
          '<div style="position:relative;display:flex;align-items:flex-start;justify-content:space-between;gap:10px">' +
            '<div><div style="display:flex;align-items:center;gap:10px">' +
              '<span style="display:flex;color:' + BLUE + ';filter:drop-shadow(0 0 8px ' + BLUE_GLOW + ')"><svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M3 8l4.2 3.4L12 5l4.8 6.4L21 8l-1.7 10.4H4.7z"/><rect x="4.7" y="19" width="14.6" height="2.1" rx="1"/></svg></span>' +
              '<div style="font-size:23px;font-weight:900;color:' + txt1 + '">Premium Tier</div></div>' +
            '<div style="color:' + cap + ';font-size:13px;margin-top:6px;line-height:1.45;max-width:220px">Unlock advanced tools and exclusive benefits</div></div>' +
            '<span style="flex-shrink:0;padding:3px 12px;border-radius:9px;border:1px solid rgba(245,196,81,.6);color:#f5c451;font-size:12px;font-weight:800;letter-spacing:.5px">PRO</span>' +
          '</div>' +
          '<div style="position:relative;display:flex;align-items:center;gap:6px;margin-top:18px">' +
            '<div style="flex:1;min-width:0">' + checks + '</div>' +
            '<div style="flex-shrink:0;display:flex;align-items:center;justify-content:center">' + crownArt(168) + '</div>' +
          '</div>' +
          '<button id="pp-upgrade" type="button" style="position:relative;width:100%;margin-top:8px;padding:15px;border-radius:14px;border:none;cursor:pointer;background:' + GREEN_GRAD + ';color:#fff;font-size:16px;font-weight:800;font-family:\'Outfit\',sans-serif;box-shadow:0 8px 26px ' + GREEN_GLOW + ';display:flex;align-items:center;justify-content:center;gap:8px;-webkit-appearance:none">Upgrade Now <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></button>' +
        '</div>';

      // ── League Progress + combined XP (Market + Easy Trade) ─────────────────
      var t0 = xpTier(USE_LIVE_DATA ? 0 : (SAMPLE.marketXp + SAMPLE.eztXp));
      var initTotal = USE_LIVE_DATA ? "\u2026" : fmtN(SAMPLE.marketXp + SAMPLE.eztXp);
      var initMk = USE_LIVE_DATA ? "\u2026" : fmtN(SAMPLE.marketXp);
      var initEz = USE_LIVE_DATA ? "\u2026" : fmtN(SAMPLE.eztXp);
      var chip = function (icon, label, valId, val, accent) {
        return '<div style="flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:9px 11px;border-radius:12px;background:rgba(8,14,34,.55);border:1px solid ' + cardB + '">' +
          '<span style="display:flex;flex-shrink:0">' + icon + '</span>' +
          '<div style="min-width:0"><div style="color:' + cap + ';font-size:11px;line-height:1.1;white-space:nowrap">' + label + '</div>' +
          '<div id="' + valId + '" style="color:' + (accent || txt1) + ';font-size:15px;font-weight:900;line-height:1.15">' + val + '</div></div>' +
        '</div>';
      };
      var leagueCard =
        '<div style="position:relative;overflow:hidden;padding:18px;border-radius:20px;background:linear-gradient(150deg,rgba(16,26,60,.65),rgba(8,14,34,.5));border:1px solid ' + cardB + ';box-shadow:0 10px 32px rgba(0,0,0,.3)">' +
          '<div style="display:flex;align-items:center;justify-content:space-between"><div style="color:' + txt1 + ';font-size:17px;font-weight:900">League Progress</div><button id="pp-league-all" type="button" style="background:none;border:none;color:' + BLUE + ';font-size:14px;font-weight:700;cursor:pointer;font-family:\'Outfit\',sans-serif">View All</button></div>' +
          '<div style="display:flex;align-items:center;gap:14px;margin-top:10px">' +
            '<div style="flex-shrink:0">' + crystalArt(112) + '</div>' +
            '<div style="flex:1;min-width:0">' +
              '<div id="pp-league-name" style="color:' + txt1 + ';font-size:22px;font-weight:900;line-height:1.1">' + esc2(V.league) + '</div>' +
              // combined total XP headline
              '<div style="margin:7px 0 2px;display:flex;align-items:baseline;gap:7px">' +
                '<span id="pp-xp-total" style="color:' + txt1 + ';font-size:26px;font-weight:900;line-height:1;text-shadow:0 0 14px ' + BLUE_GLOW + '">' + initTotal + '</span>' +
                '<span style="color:' + cap + ';font-size:13px;font-weight:700">/ <span id="pp-xp-max">' + fmtN(t0.nextXp) + '</span> XP</span>' +
              '</div>' +
              '<div style="color:' + cap + ';font-size:11.5px;margin-bottom:8px">Total XP \u2014 Market + Easy Trade combined</div>' +
              // progress bar toward next milestone
              '<div style="height:12px;border-radius:7px;background:rgba(8,14,34,.8);overflow:hidden;box-shadow:inset 0 1px 3px rgba(0,0,0,.4)"><div id="pp-xp-bar" style="height:100%;width:' + (USE_LIVE_DATA ? 0 : t0.pct) + '%;min-width:6px;border-radius:7px;background:linear-gradient(90deg,#22c55e,#38bdf8 60%,#7c5cff);box-shadow:0 0 14px ' + BLUE_GLOW + ';transition:width .9s ease"></div></div>' +
            '</div>' +
          '</div>' +
          // breakdown chips
          '<div style="display:flex;gap:10px;margin-top:13px">' +
            chip(svgChart(GREEN), "Market XP", "pp-xp-market", initMk, GREEN) +
            chip(svgBolt(BLUE), "Easy Trade XP", "pp-xp-ezt", initEz, BLUE) +
          '</div>' +
          '<div style="color:' + cap + ';font-size:12px;margin-top:11px">Earn XP by posting in Market and winning Easy Trade rounds</div>' +
        '</div>';

      var membershipRow =
        '<div style="padding:16px 18px;border-radius:20px;background:' + cardBg + ';border:1px solid ' + cardB + '">' +
          '<div style="color:' + txt1 + ';font-size:16px;font-weight:900">Membership</div>' +
          '<div style="color:' + cap + ';font-size:13px;margin-top:3px">Manage your Quantum League identity</div>' +
          '<div id="pp-idcard-open" style="cursor:pointer;display:flex;align-items:center;gap:13px;margin-top:13px;padding:14px;border-radius:16px;background:rgba(16,28,58,.6);border:1px solid rgba(124,92,255,.25)">' +
            '<span style="width:46px;height:46px;border-radius:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:rgba(28,132,255,.16);color:' + BLUE + '"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2.5"/><circle cx="8" cy="11" r="2.6"/><path d="M14 9h5M14 13h5M4.5 16.5a4 4 0 0 1 7 0"/></svg></span>' +
            '<div style="flex:1;min-width:0"><div style="color:' + txt1 + ';font-size:15px;font-weight:800">Quantum League ID Card</div><div style="color:' + cap + ';font-size:12.5px">Your official QL identity</div><div style="color:' + GREEN + ';font-size:13px;font-weight:700;margin-top:2px">View Card \u2192</div></div>' +
            '<span style="color:' + cap + ';flex-shrink:0"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>' +
          '</div>' +
        '</div>';

      var statCell = function (n, label, accent, id) {
        return '<div style="flex:1;min-width:0;text-align:center;padding:14px 6px;border-radius:14px;background:rgba(8,14,34,.5);border:1px solid ' + cardB + '"><div' + (id ? ' id="' + id + '"' : '') + ' style="font-size:24px;font-weight:900;color:' + (accent || txt1) + '">' + n + '</div><div style="color:' + cap + ';font-size:12.5px;margin-top:3px">' + label + '</div></div>';
      };
      var activityCard =
        '<div style="padding:16px 18px;border-radius:20px;background:' + cardBg + ';border:1px solid ' + cardB + '">' +
          '<div style="display:flex;align-items:center;justify-content:space-between"><div style="color:' + txt1 + ';font-size:16px;font-weight:900">Account Activity</div><div style="color:' + cap + ';font-size:13px;display:flex;align-items:center;gap:5px">This Month <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></div></div>' +
          '<div style="display:flex;gap:11px;margin-top:13px">' + statCell(V.matches, "Matches", null, "pp-st-matches") + statCell(V.wins, "Wins", null, "pp-st-wins") + statCell(V.winRate + (USE_LIVE_DATA ? "" : "%"), "Win Rate", GREEN, "pp-st-wr") + '</div>' +
        '</div>';

      var leftCol = leftHeader + emblem + bioEmail + saveBlock + navBar;
      var rightCol = '<div style="display:flex;flex-direction:column;gap:14px">' + premiumCard + leagueCard + membershipRow + activityCard + '</div>';

      var inner = wide
        ? '<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start"><div>' + leftCol + '</div><div style="padding-top:6px">' + rightCol + '</div></div>'
        : '<div style="display:flex;flex-direction:column;gap:16px">' + leftHeader + emblem + premiumCard + leagueCard + membershipRow + activityCard + bioEmail + saveBlock + navBar + '</div>';

      body.innerHTML =
        '<style>' +
        '@keyframes ppxSpin{to{transform:rotate(360deg)}}@keyframes ppxSpinR{to{transform:rotate(-360deg)}}' +
        '.ppx-ring{position:absolute;border-radius:50%;inset:0}' +
        '.ppx-r1{border:2px dashed ' + GREEN + ';box-shadow:0 0 26px ' + GREEN_GLOW + ',inset 0 0 26px ' + GREEN_GLOW + ';opacity:.95;animation:ppxSpin 16s linear infinite}' +
        '.ppx-r2{inset:10px;border:1px dashed rgba(34,210,140,.6);animation:ppxSpinR 11s linear infinite}' +
        '.ppx-r3{inset:17px;border:1px dotted rgba(34,211,238,.55);box-shadow:0 0 14px rgba(34,211,238,.22);animation:ppxSpin 7s linear infinite}' +
        '.ppx-orbit{position:absolute;inset:0;animation:ppxSpinR 20s linear infinite}' +
        '.ppx-node{position:absolute;width:10px;height:10px;margin:-5px 0 0 -5px;background:' + GREEN + ';transform:rotate(45deg);box-shadow:0 0 12px ' + GREEN + ';border-radius:2px}' +
        '@keyframes ppxSpark{0%{transform:translateY(0) scale(.3);opacity:0}12%{opacity:1}55%{opacity:.8}100%{transform:translateY(-16px) scale(1.15);opacity:0}}' +
        '.ppx-sparks{position:absolute;inset:0;pointer-events:none;animation:ppxSpin 26s linear infinite}' +
        '.ppx-spk-wrap{position:absolute;inset:0}' +
        '.ppx-spk{position:absolute;top:-2px;left:50%;width:5px;height:5px;margin-left:-2.5px;border-radius:50%;background:radial-gradient(circle,#f0fff8 0%,#16e29a 60%,rgba(22,226,154,0) 100%);box-shadow:0 0 8px #16e29a,0 0 14px rgba(22,226,154,.6);animation:ppxSpark 2.6s ease-out infinite}' +
        // crown/crystal art animations
        '@keyframes dqcaFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}' +
        '@keyframes dqcaFloat2{0%,100%{transform:translateY(0) rotate(-.5deg)}50%{transform:translateY(-6px) rotate(.5deg)}}' +
        '@keyframes dqcaTwinkle{0%,100%{transform:scale(.5);opacity:.15}50%{transform:scale(1);opacity:1}}' +
        '@keyframes dqcaDrift{0%{transform:translateY(0);opacity:0}25%{opacity:.9}75%{opacity:.5}100%{transform:translateY(-18px);opacity:0}}' +
        '@keyframes dqcaEmit{0%,100%{filter:drop-shadow(0 8px 22px rgba(70,150,255,.5)) drop-shadow(0 0 12px rgba(124,199,255,.4)) brightness(1)}50%{filter:drop-shadow(0 10px 32px rgba(90,175,255,.85)) drop-shadow(0 0 26px rgba(150,210,255,.8)) brightness(1.14)}}' +
        '.dqca-crown,.dqca-crystal{position:relative;animation:dqcaEmit 3.4s ease-in-out infinite}' +
        '.dqca-crystal{animation-delay:-1.6s}' +
        '.dqca-float{transform-origin:50% 60%;animation:dqcaFloat 5.5s ease-in-out infinite}' +
        '.dqca-float2{transform-origin:50% 55%;animation:dqcaFloat2 6.5s ease-in-out infinite}' +
        '.dqca-spark{transform-origin:center;transform-box:fill-box;animation:dqcaTwinkle 2.6s ease-in-out infinite}' +
        '.dqca-mote{animation:dqcaDrift 4.2s ease-in-out infinite}' +
        '@media (prefers-reduced-motion: reduce){.dqca-float,.dqca-float2,.dqca-spark,.dqca-mote,.dqca-crown,.dqca-crystal,.ppx-r1,.ppx-r2,.ppx-r3,.ppx-orbit,.ppx-sparks,.ppx-spk,.ppx-save-shine{animation:none}}' +
        '@keyframes ppxShine{0%{transform:translateX(-160%) skewX(-18deg)}55%{transform:translateX(170%) skewX(-18deg)}100%{transform:translateX(170%) skewX(-18deg)}}' +
        '.ppx-save-gloss{position:absolute;left:1px;right:1px;top:1px;height:50%;border-radius:14px 14px 0 0;background:linear-gradient(180deg,rgba(255,255,255,.5),rgba(255,255,255,.06) 80%,transparent);pointer-events:none;z-index:1}' +
        '.ppx-save-shine{position:absolute;top:0;bottom:0;left:0;width:42%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.72),transparent);filter:blur(2px);transform:translateX(-160%) skewX(-18deg);animation:ppxShine 3.8s ease-in-out infinite;pointer-events:none;z-index:1}' +
        '#pp-body-wrap{padding:18px}' +
        '</style>' +
        '<div id="pp-body-wrap">' + inner + '</div>';

      // ── handlers (UI behaviour only; data reads deferred to live pass) ───────
      var avEl = body.querySelector("#pp-av");
      if (avEl) avEl.onclick = function () { var fi = body.querySelector("#pp-fi"); if (fi) fi.click(); };
      var gear = body.querySelector("#pp-gear");
      if (gear) gear.onclick = function () { close(); if (window.openSettings) openSettings(); };
      var wc = body.querySelector("#dq-wallet-chip");
      if (wc) wc.onclick = function () { close(); if (window.openWallet) openWallet(); };
      var bb = body.querySelector("#pp-b"), bc = body.querySelector("#pp-bc");
      if (bb && bc) bb.oninput = function () { bc.textContent = bb.value.length; };
      var up = body.querySelector("#pp-upgrade");
      if (up) up.onclick = function () { close(); if (window.openSub) openSub(); };
      var la = body.querySelector("#pp-league-all");
      if (la) la.onclick = function () { close(); if (window.dqLeagues) dqLeagues.open(); };
      if (window.dqAppNav) window.dqAppNav.wire(body, "profile", close);
      var idOpen = body.querySelector("#pp-idcard-open");
      if (idOpen) idOpen.onclick = function () { if (window.dqIdCard) dqIdCard.open(); };

      // avatar picker: live -> upload to /api/upload; preview -> local FileReader
      var fi = body.querySelector("#pp-fi");
      if (fi) fi.onchange = function () {
        var f = this.files && this.files[0]; if (!f) return;
        if (!/^image\//.test(f.type || "")) { alert("Please choose an image file."); this.value = ""; return; }
        if (!USE_LIVE_DATA) {
          var rd = new FileReader();
          rd.onload = function (ev) {
            var av = body.querySelector("#pp-av");
            if (av) av.innerHTML = '<img src="' + ev.target.result + '" style="width:144px;height:144px;border-radius:50%;object-fit:cover"/>';
          };
          rd.readAsDataURL(f);
          this.value = "";
          return;
        }
        var inp = this;
        var av = body.querySelector("#pp-av"), sv = body.querySelector("#pp-save");
        var spin = (typeof ce === "function") ? ce("div") : document.createElement("div");
        spin.style.cssText = "position:absolute;inset:0;border-radius:50%;background:rgba(5,8,20,.62);display:flex;align-items:center;justify-content:center;z-index:5";
        spin.innerHTML = '<div style="width:26px;height:26px;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:ppxSpin .7s linear infinite"></div>';
        if (av) av.appendChild(spin);
        if (sv) sv.disabled = true;
        (async function () {
          try {
            var fd = new FormData(); fd.append("file", f);
            var r = await fetch("/api/upload", { method: "POST", headers: { Authorization: "Bearer " + S.token }, body: fd });
            var d = await r.json().catch(function () { return {}; });
            if (!r.ok || !d.url) throw new Error((d && d.error) || "Upload failed");
            LIVE_AVATAR = d.url;
            if (av) av.innerHTML = ((typeof avatar === "function") ? avatar(d.url, 144) : '<img src="' + d.url + '" style="width:144px;height:144px;border-radius:50%;object-fit:cover"/>');
          } catch (e) { if (spin.parentNode) spin.remove(); alert((e && e.message) || "Upload failed. Please try again."); }
          finally { if (sv) sv.disabled = false; inp.value = ""; }
        })();
      };

      // Save: live -> PUT /api/auth/profile; preview -> toast only
      var saveBtn = body.querySelector("#pp-save");
      if (saveBtn) saveBtn.onclick = function () {
        if (!USE_LIVE_DATA) {
          if (typeof showToast === "function") showToast("Preview", "Design preview \u2014 saving connects after approval.");
          return;
        }
        (async function () {
          try {
            var nEl = body.querySelector("#pp-n"), bEl = body.querySelector("#pp-b"), uEl = body.querySelector("#pp-u");
            var payload = {
              name: nEl ? nEl.value.trim() : (S.user && S.user.name),
              bio: bEl ? bEl.value.trim() : (S.user && S.user.bio),
              username: uEl ? uEl.value.trim() : (S.user && S.user.username)
            };
            if (LIVE_AVATAR) payload.avatar = LIVE_AVATAR;
            var up2 = await api("/auth/profile", { method: "PUT", body: JSON.stringify(payload) });
            S.user = Object.assign({}, S.user, up2);
            try { localStorage.setItem("dq_u", JSON.stringify(S.user)); } catch (e) { }
            close();
            if (typeof renderApp === "function") renderApp();
          } catch (e) { alert((e && (e.error || e.message)) || "Could not save changes."); }
        })();
      };

      // fill the async cards (balance, league, XP total, activity) from endpoints
      if (USE_LIVE_DATA) wireLiveData(body);
    });
  }

  // ── live data: fill the async cards (balance, league/XP, activity) ──────────
  // Called after render when USE_LIVE_DATA is true. Each read is independent and
  // best-effort: a failure leaves that card showing its placeholder.
  function wireLiveData(body) {
    // running totals for the combined XP headline + bar
    var marketXp = null, eztXp = null;

    function paintXp() {
      var mk = num(marketXp), ez = num(eztXp);
      var mkEl = body.querySelector("#pp-xp-market");
      var ezEl = body.querySelector("#pp-xp-ezt");
      if (marketXp != null && mkEl) mkEl.textContent = fmtN(mk);
      if (eztXp != null && ezEl) ezEl.textContent = fmtN(ez);
      // only paint the combined total once BOTH sources have resolved
      if (marketXp == null || eztXp == null) return;
      var tier = xpTier(mk + ez);
      var tEl = body.querySelector("#pp-xp-total");
      var maxEl = body.querySelector("#pp-xp-max");
      var bar = body.querySelector("#pp-xp-bar");
      if (tEl) tEl.textContent = fmtN(tier.total);
      if (maxEl) maxEl.textContent = fmtN(tier.nextXp);
      if (bar) bar.style.width = tier.pct + "%";
    }

    // QNTM balance
    (async function () {
      try {
        var r = await api("/qntm/wallets/me");
        var el = body.querySelector("#dq-wc-bal");
        if (el && r && r.wallet) el.textContent = fmt2(r.wallet.available_balance);
        else if (el) el.textContent = "0.00";
      } catch (e) { var el2 = body.querySelector("#dq-wc-bal"); if (el2) el2.textContent = "0.00"; }
    })();

    // League name (QNTM ladder); XP comes from Market + Easy Trade below
    (async function () {
      try {
        var me = await api("/leagues/me");
        var nm = body.querySelector("#pp-league-name");
        if (nm) nm.textContent = (me && me.currentLeagueName) || "Unranked";
      } catch (e) {
        var nm2 = body.querySelector("#pp-league-name"); if (nm2) nm2.textContent = "Unranked";
      }
    })();

    // Market XP  (1000 base + 100·like + 100·post)
    (async function () {
      try {
        var s = await api("/market/me/stats");
        marketXp = num(s && s.xp);
      } catch (e) { marketXp = 0; }
      paintXp();
    })();

    // Easy Trade XP + Account activity (single leaderboard read powers both)
    (async function () {
      try {
        var d = await api("/easytrade/leaderboard?sort=xp");
        var me = d && d.me;
        eztXp = me ? num(me.xp) : 0;
        var mEl = body.querySelector("#pp-st-matches"), wEl = body.querySelector("#pp-st-wins"), wrEl = body.querySelector("#pp-st-wr");
        if (me) {
          if (mEl) mEl.textContent = fmtN(me.settled != null ? me.settled : (num(me.wins) + num(me.losses)));
          if (wEl) wEl.textContent = fmtN(me.wins);
          if (wrEl) wrEl.textContent = (me.winRate != null ? me.winRate : 0) + "%";
        } else {
          if (mEl) mEl.textContent = "0";
          if (wEl) wEl.textContent = "0";
          if (wrEl) wrEl.textContent = "0%";
        }
      } catch (e) {
        eztXp = 0;
        var mEl2 = body.querySelector("#pp-st-matches"); if (mEl2) mEl2.textContent = "0";
        var wEl2 = body.querySelector("#pp-st-wins"); if (wEl2) wEl2.textContent = "0";
        var wrEl2 = body.querySelector("#pp-st-wr"); if (wrEl2) wrEl2.textContent = "0%";
      }
      paintXp();
    })();
  }

  // winged DrFX crest used inside the emblem when no avatar image is set
  function emblemCrest() {
    return '' +
      '<svg width="150" height="150" viewBox="0 0 150 150" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block">' +
        '<defs><linearGradient id="dqcrestG" x1="40" y1="40" x2="110" y2="120" gradientUnits="userSpaceOnUse"><stop stop-color="#1a2a4e"/><stop offset="1" stop-color="#05091c"/></linearGradient>' +
        '<linearGradient id="dqcrestGold" x1="55" y1="78" x2="95" y2="98" gradientUnits="userSpaceOnUse"><stop stop-color="#ffe08a"/><stop offset="1" stop-color="#caa23a"/></linearGradient></defs>' +
        // wings
        '<path d="M75 64 C58 50 36 50 22 64 C40 60 52 64 62 74 C50 70 40 72 32 80 C48 76 60 80 70 90 Z" fill="#0c1426" stroke="rgba(150,200,255,.35)" stroke-width="1"/>' +
        '<path d="M75 64 C92 50 114 50 128 64 C110 60 98 64 88 74 C100 70 110 72 118 80 C102 76 90 80 80 90 Z" fill="#0c1426" stroke="rgba(150,200,255,.35)" stroke-width="1"/>' +
        // figure silhouette
        '<ellipse cx="75" cy="58" rx="9" ry="10" fill="#0a1326"/>' +
        '<path d="M62 112 C62 88 66 74 75 74 C84 74 88 88 88 112 Z" fill="#0a1326"/>' +
        // DrFX gold plaque
        '<rect x="52" y="80" width="46" height="20" rx="4" fill="url(#dqcrestGold)" stroke="#fff2c0" stroke-width="1"/>' +
        '<text x="75" y="95" text-anchor="middle" font-family="Outfit,sans-serif" font-size="13" font-weight="800" fill="#3a2a08" letter-spacing="1">DrFX</text>' +
        // top glow spark
        '<circle cx="75" cy="40" r="3" fill="#cfe6ff"/>' +
      '</svg>';
  }

  function navIcon(path, color, active) {
    return '<div style="display:flex;flex-direction:column;align-items:center;gap:3px;color:' + color + '"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>' + (active ? '<span style="width:5px;height:5px;border-radius:50%;background:' + color + '"></span>' : '') + '</div>';
  }

  // ── install: replace the host openProfile ──────────────────────────────────
  function install() {
    window.openProfile = openProfileV2;
    window.openProfile._dqProfileV2 = true;
    window.dqProfile = { open: openProfileV2 };
  }
  install();
  setTimeout(function () {
    if (window.openProfile && !window.openProfile._dqProfileV2 && !window.openProfile._dqIdWrapped && !window.openProfile._dqLeaguesWrapped) {
      install();
    }
  }, 60);
})();
