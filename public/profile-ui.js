/* ============================================================================
 * profile-ui.js — DrFX Quant Profile (spec rebuild — VISUAL PREVIEW PASS)
 * ----------------------------------------------------------------------------
 * Self-contained SPA module. Loads as a plain <script> AFTER index.html's main
 * script (and after leagues-ui.js / idcard.js). It REPLACES window.openProfile
 * with a faithful rebuild of the Profile popup that matches the written spec
 * exactly, using flat SVG art (NO 3D / WebGL) for the crown and league crystal.
 *
 * ⚠ THIS PASS IS A VISUAL PREVIEW. Per the request, the layout is built first
 *   with the spec's SAMPLE VALUES hard-coded (QNTM "1,190.00", name "DrFX",
 *   "0 / 1000 XP", "12 / 7 / 58%", UID "QNTM-7X9F-2025", etc.). The live-data
 *   reads are intentionally deferred and centralised in the SAMPLE object +
 *   the (commented) wireLiveData() stub at the bottom. After the design is
 *   approved, flip USE_LIVE_DATA to true (and fill in wireLiveData) to connect:
 *       • QNTM Balance  ← GET /api/qntm/wallets/me  (wallet.available_balance)
 *       • Name/@user/avatar/bio/email/role ← S.user.*
 *       • League / XP   ← GET /api/leagues/me
 *       • Account stats ← GET /api/easytrade/leaderboard?sort=xp  (.me)
 *       • UID / since   ← deterministic from S.user (mirrors idcard.js)
 *
 * Structural hooks kept so the rest of the app keeps working even in preview:
 *   • Save button keeps id "pp-save"  (idcard.js / leagues-ui.js inject before it)
 *   • hidden sentinels "dq-lg-card" + "dq-idcard-entry" suppress duplicate cards
 *   • Save / bio-counter / avatar-picker / wallet-chip / upgrade / view-card
 *     handlers are wired to the existing globals (UI behaviour, not data reads)
 * ========================================================================== */
(function () {
  "use strict";
  if (window.__dqProfileV2) return;
  window.__dqProfileV2 = true;

  // ── flip to true AFTER the design is approved to connect real endpoints ─────
  var USE_LIVE_DATA = false;

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
    xpCur: 0,
    xpMax: 1000,
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

  // ── flat SVG: ice-blue faceted CROWN (no 3D) ────────────────────────────────
  function crownSVG(w) {
    w = w || 150;
    var id = "cr" + Math.random().toString(36).slice(2, 7);
    return '' +
      '<svg width="' + w + '" height="' + Math.round(w * 0.92) + '" viewBox="0 0 150 138" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;filter:drop-shadow(0 6px 26px rgba(70,150,255,.55))">' +
        '<defs>' +
          '<linearGradient id="' + id + 'a" x1="75" y1="6" x2="75" y2="118" gradientUnits="userSpaceOnUse"><stop stop-color="#eaf6ff"/><stop offset=".45" stop-color="#7cc7ff"/><stop offset="1" stop-color="#1c4f8f"/></linearGradient>' +
          '<linearGradient id="' + id + 'b" x1="75" y1="86" x2="75" y2="128" gradientUnits="userSpaceOnUse"><stop stop-color="#2f6bd6"/><stop offset="1" stop-color="#0a1a3a"/></linearGradient>' +
          '<radialGradient id="' + id + 'g" cx="75" cy="84" r="70" gradientUnits="userSpaceOnUse"><stop stop-color="rgba(80,170,255,.55)"/><stop offset="1" stop-color="rgba(80,170,255,0)"/></radialGradient>' +
        '</defs>' +
        '<ellipse cx="75" cy="104" rx="68" ry="20" fill="url(#' + id + 'g)"/>' +
        // base block
        '<path d="M30 92 L75 80 L120 92 L120 104 L75 116 L30 104 Z" fill="url(#' + id + 'b)" stroke="#9fdcff" stroke-width="1.2" stroke-linejoin="round" opacity=".95"/>' +
        '<path d="M30 92 L75 104 L120 92 M75 104 L75 116" stroke="rgba(255,255,255,.5)" stroke-width="1"/>' +
        // pedestal ring
        '<path d="M40 84 L75 75 L110 84 L110 92 L75 100 L40 92 Z" fill="#0c1830" stroke="#7fc4ff" stroke-width="1.1" stroke-linejoin="round"/>' +
        '<path d="M40 84 L75 92 L110 84" stroke="' + 'rgba(150,220,255,.85)' + '" stroke-width="1.4"/>' +
        // five fanned blades
        '<path d="M40 86 L46 46 L54 86 Z" fill="url(#' + id + 'a)" stroke="#dff1ff" stroke-width="1.1" stroke-linejoin="round"/>' +
        '<path d="M56 86 L64 28 L72 86 Z" fill="url(#' + id + 'a)" stroke="#dff1ff" stroke-width="1.1" stroke-linejoin="round"/>' +
        '<path d="M67 88 L75 14 L83 88 Z" fill="url(#' + id + 'a)" stroke="#dff1ff" stroke-width="1.2" stroke-linejoin="round"/>' +
        '<path d="M78 86 L86 28 L94 86 Z" fill="url(#' + id + 'a)" stroke="#dff1ff" stroke-width="1.1" stroke-linejoin="round"/>' +
        '<path d="M96 86 L104 46 L110 86 Z" fill="url(#' + id + 'a)" stroke="#dff1ff" stroke-width="1.1" stroke-linejoin="round"/>' +
        // centre facet highlights
        '<path d="M64 28 L64 86 M86 28 L86 86 M75 14 L75 88" stroke="rgba(255,255,255,.45)" stroke-width="1"/>' +
      '</svg>';
  }

  // ── flat SVG: ice-blue faceted CRYSTAL shard (no 3D) ────────────────────────
  function crystalSVG(w) {
    w = w || 96;
    var id = "cy" + Math.random().toString(36).slice(2, 7);
    return '' +
      '<svg width="' + w + '" height="' + Math.round(w * 1.3) + '" viewBox="0 0 96 125" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;filter:drop-shadow(0 6px 24px rgba(70,150,255,.6))">' +
        '<defs>' +
          '<linearGradient id="' + id + 'a" x1="48" y1="6" x2="48" y2="120" gradientUnits="userSpaceOnUse"><stop stop-color="#eaf6ff"/><stop offset=".5" stop-color="#7cc7ff"/><stop offset="1" stop-color="#1c4f8f"/></linearGradient>' +
          '<radialGradient id="' + id + 'g" cx="48" cy="64" r="56" gradientUnits="userSpaceOnUse"><stop stop-color="rgba(80,170,255,.5)"/><stop offset="1" stop-color="rgba(80,170,255,0)"/></radialGradient>' +
        '</defs>' +
        '<ellipse cx="48" cy="70" rx="42" ry="44" fill="url(#' + id + 'g)"/>' +
        '<polygon points="48,6 78,40 64,116 32,116 18,40" fill="url(#' + id + 'a)" stroke="#dff1ff" stroke-width="1.4" stroke-linejoin="round"/>' +
        '<polygon points="48,6 64,116 48,52" fill="rgba(255,255,255,.22)"/>' +
        '<polygon points="48,6 32,116 48,52" fill="rgba(8,20,46,.28)"/>' +
        '<polyline points="18,40 48,52 78,40" fill="none" stroke="rgba(255,255,255,.6)" stroke-width="1.2"/>' +
        '<polyline points="32,116 48,52 64,116" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1"/>' +
      '</svg>';
  }

  // ── small inline icons ──────────────────────────────────────────────────────
  function svgGear(c) { return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="' + c + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'; }
  function svgCheckCircle() { return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="11" fill="rgba(28,132,255,.18)" stroke="' + BLUE + '" stroke-width="1.6"/><path d="M7.5 12.3l3 3 6-6.5" fill="none" stroke="' + BLUE + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }

  // ════════════════════════════════════════════════════════════════════════════
  function openProfileV2() {
    modal("Profile", function (body, close) {
      // values: sample for this preview pass (live wiring deferred)
      var V = SAMPLE;

      // widen + de-pad the host modal so cards reach the edges like the mockup
      var md = body.closest(".dq-modal-md");
      var wide = window.innerWidth >= 920;
      if (md) {
        md.style.width = wide ? "900px" : "560px";
        md.style.maxWidth = "100%";
        md.style.padding = "0";
        md.style.background = "radial-gradient(130% 90% at 50% -10%,#0d1838,#080f26 55%,#05091c)";
        md.style.border = "1px solid rgba(120,160,255,.14)";
        var hdr = md.firstElementChild;
        if (hdr && hdr.querySelector && hdr.querySelector("#md-cl")) hdr.style.display = "none";
      }

      var cap = "#7d93b8", txt1 = "#eaf2ff", txt2 = "#b8c8e8";
      var cardBg = "rgba(14,24,50,.55)", cardB = "rgba(120,160,255,.16)";

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
          '<div style="flex:1;min-width:0"><div style="color:' + cap + ';font-size:12px">QNTM Balance</div><div id="dq-wc-bal" style="color:#fff;font-size:20px;font-weight:900;line-height:1.15">' + V.qntm + '</div></div>' +
        '</div>';

      // emblem (concentric neon rings + winged DrFX crest), no avatar img by default
      var emblem =
        '<div style="position:relative;width:200px;height:200px;margin:18px auto 0">' +
          '<div class="ppx-ring ppx-r1"></div><div class="ppx-ring ppx-r2"></div><div class="ppx-ring ppx-r3"></div>' +
          '<span class="ppx-node" style="top:-5px;left:50%"></span><span class="ppx-node" style="bottom:-5px;left:50%"></span>' +
          '<span class="ppx-node" style="left:-5px;top:50%"></span><span class="ppx-node" style="right:-5px;top:50%"></span>' +
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
        '<button id="pp-save" type="button" style="position:relative;overflow:hidden;width:100%;margin-top:16px;padding:16px;border-radius:15px;border:none;cursor:pointer;background:' + GREEN_GRAD + ';color:#04140d;font-size:17px;font-weight:900;font-family:\'Outfit\',sans-serif;box-shadow:0 8px 28px ' + GREEN_GLOW + ';display:flex;align-items:center;justify-content:center;gap:10px;-webkit-appearance:none"><span style="display:flex;align-items:center;gap:10px"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#04140d" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Save Changes</span></button>' +
        '<div style="text-align:center;color:' + cap + ';font-size:12px;margin-top:11px;display:flex;align-items:center;justify-content:center;gap:6px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="' + GREEN + '" stroke-width="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Your data is secure with us</div>' +
        '<div id="dq-lg-card" style="display:none"></div><div id="dq-idcard-entry" style="display:none"></div>';

      // bottom mobile nav strip (baked into the design per the spec)
      var navBar =
        '<div style="display:flex;align-items:center;justify-content:space-around;margin-top:20px;padding:12px 8px calc(12px + var(--sab));border-top:1px solid ' + cardB + ';background:rgba(6,12,28,.6)">' +
          navIcon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', BLUE, true) +
          navIcon('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>', cap, false) +
          '<div style="width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:' + GREEN_GRAD + ';box-shadow:0 6px 22px ' + GREEN_GLOW + ',0 0 0 5px rgba(34,226,154,.12)"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#04140d" stroke-width="2.6" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>' +
          navIcon('<line x1="6" y1="20" x2="6" y2="12"/><line x1="12" y1="20" x2="12" y2="6"/><line x1="18" y1="20" x2="18" y2="14"/>', cap, false) +
          navIcon('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>', cap, false) +
        '</div>';

      // ── RIGHT: Premium / League / Membership / Activity ─────────────────────
      var feats = ["Priority Support", "Advanced Analytics", "Early Access Features", "Exclusive Rewards"];
      var checks = feats.map(function (f) {
        return '<div style="display:flex;align-items:center;gap:11px;margin-bottom:13px">' + svgCheckCircle() + '<span style="color:' + txt2 + ';font-size:15px;font-weight:600">' + f + '</span></div>';
      }).join("");
      var premiumCard =
        '<div style="position:relative;overflow:hidden;padding:20px;border-radius:20px;background:linear-gradient(150deg,rgba(20,32,66,.7),rgba(10,18,40,.55));border:1px solid ' + cardB + ';box-shadow:0 12px 40px rgba(0,0,0,.35)">' +
          '<div style="position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,' + BLUE + ',transparent)"></div>' +
          // fractured-marble top-right corner (pure CSS: bright streak + hairline cracks)
          '<div style="position:absolute;top:0;right:0;width:58%;height:48%;pointer-events:none;opacity:.9;background:radial-gradient(120% 90% at 92% 4%,rgba(150,200,255,.22),rgba(150,200,255,0) 60%);-webkit-mask-image:linear-gradient(225deg,#000,transparent 72%);mask-image:linear-gradient(225deg,#000,transparent 72%)"></div>' +
          '<div style="position:absolute;top:-10px;right:-10px;width:62%;height:60%;pointer-events:none;overflow:hidden;-webkit-mask-image:linear-gradient(225deg,#000,transparent 70%);mask-image:linear-gradient(225deg,#000,transparent 70%)">' +
            '<svg width="100%" height="100%" viewBox="0 0 200 130" preserveAspectRatio="none" style="display:block">' +
              '<defs><linearGradient id="ppMarbleStreak" x1="0" y1="0" x2="1" y2="1"><stop stop-color="rgba(210,235,255,.85)"/><stop offset="1" stop-color="rgba(210,235,255,0)"/></linearGradient></defs>' +
              '<path d="M205 -5 L120 95" stroke="url(#ppMarbleStreak)" stroke-width="3" fill="none"/>' +
              '<path d="M200 10 L150 70" stroke="rgba(180,215,255,.35)" stroke-width="1" fill="none"/>' +
              '<path d="M185 -5 L150 40 L168 55" stroke="rgba(180,215,255,.25)" stroke-width="1" fill="none"/>' +
              '<path d="M205 35 L165 80" stroke="rgba(180,215,255,.2)" stroke-width="1" fill="none"/>' +
            '</svg>' +
          '</div>' +
          '<div style="position:relative;display:flex;align-items:flex-start;justify-content:space-between;gap:10px">' +
            '<div><div style="display:flex;align-items:center;gap:10px">' +
              '<span style="display:flex;color:' + BLUE + ';filter:drop-shadow(0 0 8px ' + BLUE_GLOW + ')"><svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M3 8l4.2 3.4L12 5l4.8 6.4L21 8l-1.7 10.4H4.7z"/><rect x="4.7" y="19" width="14.6" height="2.1" rx="1"/></svg></span>' +
              '<div style="font-size:23px;font-weight:900;color:' + txt1 + '">Premium Tier</div></div>' +
            '<div style="color:' + cap + ';font-size:13px;margin-top:6px;line-height:1.45;max-width:220px">Unlock advanced tools and exclusive benefits</div></div>' +
            '<span style="flex-shrink:0;padding:3px 12px;border-radius:9px;border:1px solid rgba(245,196,81,.6);color:#f5c451;font-size:12px;font-weight:800;letter-spacing:.5px">OD</span>' +
          '</div>' +
          '<div style="position:relative;display:flex;align-items:center;gap:6px;margin-top:18px">' +
            '<div style="flex:1;min-width:0">' + checks + '</div>' +
            '<div id="pp-crown3d" style="width:150px;height:138px;flex-shrink:0"></div>' +
          '</div>' +
          '<button id="pp-upgrade" type="button" style="position:relative;width:100%;margin-top:8px;padding:15px;border-radius:14px;border:none;cursor:pointer;background:' + GREEN_GRAD + ';color:#fff;font-size:16px;font-weight:800;font-family:\'Outfit\',sans-serif;box-shadow:0 8px 26px ' + GREEN_GLOW + ';display:flex;align-items:center;justify-content:center;gap:8px;-webkit-appearance:none">Upgrade Now <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></button>' +
        '</div>';

      var pct = Math.max(0, Math.min(100, V.xpMax ? (V.xpCur / V.xpMax) * 100 : 0));
      var leagueCard =
        '<div style="position:relative;overflow:hidden;padding:18px;border-radius:20px;background:linear-gradient(150deg,rgba(16,26,60,.65),rgba(8,14,34,.5));border:1px solid ' + cardB + ';box-shadow:0 10px 32px rgba(0,0,0,.3)">' +
          '<div style="display:flex;align-items:center;justify-content:space-between"><div style="color:' + txt1 + ';font-size:17px;font-weight:900">League Progress</div><button id="pp-league-all" type="button" style="background:none;border:none;color:' + BLUE + ';font-size:14px;font-weight:700;cursor:pointer;font-family:\'Outfit\',sans-serif">View All</button></div>' +
          '<div style="display:flex;align-items:center;gap:16px;margin-top:8px">' +
            '<div style="flex-shrink:0">' + crystalSVG(92) + '</div>' +
            '<div style="flex:1;min-width:0">' +
              '<div style="color:' + txt1 + ';font-size:24px;font-weight:900">' + esc2(V.league) + '</div>' +
              '<div style="margin:6px 0 10px"><span style="color:' + BLUE + ';font-size:15px;font-weight:800">' + V.xpCur + '</span><span style="color:' + cap + ';font-size:15px;font-weight:700"> / ' + V.xpMax + ' XP</span></div>' +
              '<div style="height:12px;border-radius:7px;background:rgba(8,14,34,.8);overflow:hidden;box-shadow:inset 0 1px 3px rgba(0,0,0,.4)"><div style="height:100%;width:' + pct + '%;min-width:8%;border-radius:7px;background:linear-gradient(90deg,#22c55e,#38bdf8 60%,#7c5cff);box-shadow:0 0 14px ' + BLUE_GLOW + '"></div></div>' +
              '<div style="color:' + cap + ';font-size:12.5px;margin-top:9px">Play matches to climb the leaderboard</div>' +
            '</div>' +
          '</div>' +
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

      var statCell = function (n, label, accent) {
        return '<div style="flex:1;min-width:0;text-align:center;padding:14px 6px;border-radius:14px;background:rgba(8,14,34,.5);border:1px solid ' + cardB + '"><div style="font-size:24px;font-weight:900;color:' + (accent || txt1) + '">' + n + '</div><div style="color:' + cap + ';font-size:12.5px;margin-top:3px">' + label + '</div></div>';
      };
      var activityCard =
        '<div style="padding:16px 18px;border-radius:20px;background:' + cardBg + ';border:1px solid ' + cardB + '">' +
          '<div style="display:flex;align-items:center;justify-content:space-between"><div style="color:' + txt1 + ';font-size:16px;font-weight:900">Account Activity</div><div style="color:' + cap + ';font-size:13px;display:flex;align-items:center;gap:5px">This Month <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></div></div>' +
          '<div style="display:flex;gap:11px;margin-top:13px">' + statCell(V.matches, "Matches") + statCell(V.wins, "Wins") + statCell(V.winRate + "%", "Win Rate", GREEN) + '</div>' +
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
        '.ppx-r1{border:2px solid ' + GREEN + ';box-shadow:0 0 26px ' + GREEN_GLOW + ',inset 0 0 26px ' + GREEN_GLOW + ';opacity:.9}' +
        '.ppx-r2{inset:10px;border:1px dashed rgba(34,210,140,.5)}' +
        '.ppx-r3{inset:17px;border:1px solid rgba(34,211,238,.4)}' +
        '.ppx-node{position:absolute;width:10px;height:10px;margin:-5px 0 0 -5px;background:' + GREEN + ';transform:rotate(45deg);box-shadow:0 0 12px ' + GREEN + ';border-radius:2px}' +
        '#pp-body-wrap{padding:18px}' +
        '</style>' +
        '<div id="pp-body-wrap">' + inner + '</div>';

      // ── mount the REAL 3D crown (WebGL) into the Premium Tier card ──────────
      // crystal3d.js paints an SVG fallback first, then upgrades to WebGL when
      // Three.js has loaded; it self-disposes the GL context on disposeAll().
      if (window.dq3DCrystal) {
        var crownEl = body.querySelector("#pp-crown3d");
        if (crownEl) dq3DCrystal.mount(crownEl, { kind: "crown", color: BLUE, height: 138 });
        var ovEl = body.closest(".dq-modal-ov");
        if (ovEl && "MutationObserver" in window) {
          var mo = new MutationObserver(function () {
            if (!document.body.contains(ovEl)) { try { dq3DCrystal.disposeAll(); } catch (e) { } mo.disconnect(); }
          });
          mo.observe(document.body, { childList: true });
        }
      }

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
      var idOpen = body.querySelector("#pp-idcard-open");
      if (idOpen) idOpen.onclick = function () { if (window.dqIdCard) dqIdCard.open(); };

      // avatar picker preview (no upload until live pass)
      var fi = body.querySelector("#pp-fi");
      if (fi) fi.onchange = function () {
        var f = this.files && this.files[0]; if (!f) return;
        if (!/^image\//.test(f.type || "")) { alert("Please choose an image file."); this.value = ""; return; }
        var rd = new FileReader();
        rd.onload = function (ev) {
          var av = body.querySelector("#pp-av");
          if (av) av.innerHTML = '<img src="' + ev.target.result + '" style="width:144px;height:144px;border-radius:50%;object-fit:cover"/>';
        };
        rd.readAsDataURL(f);
        this.value = "";
      };

      // Save: in preview, just acknowledge (no PUT). Live pass restores the API.
      var saveBtn = body.querySelector("#pp-save");
      if (saveBtn) saveBtn.onclick = function () {
        if (USE_LIVE_DATA) return;   // live handler installed in the live pass
        if (typeof showToast === "function") showToast("Preview", "Design preview — saving connects after approval.");
      };

      // ── LIVE DATA (deferred) ────────────────────────────────────────────────
      // After you approve the look, set USE_LIVE_DATA = true and implement this:
      //   - read S.user for name/username/avatar/bio/email/role + subtitle
      //   - api("/qntm/wallets/me") -> #dq-wc-bal
      //   - api("/leagues/me") -> league name + XP bar
      //   - api("/easytrade/leaderboard?sort=xp").me -> matches/wins/winRate
      //   - restore Save -> PUT /api/auth/profile and avatar -> POST /api/upload
      // if (USE_LIVE_DATA) wireLiveData(body, close);
    });
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
        // DFFX/DrFX gold plaque
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
