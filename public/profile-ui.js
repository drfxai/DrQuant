/* ============================================================================
 * profile-ui.js — DrFX Quant Profile (high-fidelity redesign)
 * ----------------------------------------------------------------------------
 * Self-contained SPA module. Loads as a plain <script> AFTER index.html's main
 * script (and after leagues-ui.js / idcard.js). It REPLACES window.openProfile
 * with a pixel-faithful rebuild of the Profile popup that matches the approved
 * mockups, while keeping every existing data binding and handler:
 *
 *   • QNTM Balance  ← GET /api/qntm/wallets/me  (wallet.available_balance)
 *   • Name / @username / avatar / bio / email / role ← S.user.*
 *   • PRO state     ← isPro(), subDaysLeft()
 *   • League / XP   ← GET /api/leagues/me  (currentLeagueName / currentLeagueId)
 *   • Account stats ← GET /api/easytrade/leaderboard?sort=xp  (.me wins/settled)
 *   • UID / member-since ← deterministic from S.user (mirrors idcard.js)
 *   • Save          → PUT /api/auth/profile        (button keeps id "pp-save")
 *   • Avatar upload → POST /api/upload
 *   • ID card row   → window.dqIdCard.open()
 *   • League card   → window.dqLeagues.open()
 *
 * The League-Progress gem and the Premium-Tier crown are REAL 3D (WebGL) via
 * window.dq3DCrystal (crystal3d.js), with a graceful SVG fallback.
 *
 * It keeps the popup centered (uses the host modal()), just widened, and on
 * desktop lays the cards out in two columns like the wide mockup.
 *
 * To avoid duplicate cards, hidden sentinels with ids "dq-lg-card" and
 * "dq-idcard-entry" are included so the leagues/idcard wrappers skip their own
 * injection (their guards check for those ids) — no edits to those modules.
 * ========================================================================== */
(function () {
  "use strict";
  if (window.__dqProfileV2) return;
  window.__dqProfileV2 = true;

  // Blue crystal palette (matches the mockups). Brand green is used for the
  // ring, ELITE, QNTM and the Save button; blue is the crystal/premium accent.
  var BLUE = "#7cc7ff", BLUE_DEEP = "#2f7bd6", BLUE_GLOW = "rgba(96,170,255,.55)";

  function num(n) { return Number(n || 0); }
  function fmt2(n) { return num(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtN(n) { return num(n).toLocaleString("en-US"); }

  // deterministic UID + QID (mirrors idcard.js makeIds, independent copy) ------
  function hash32(str) { var h = 0x811c9dc5; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return h >>> 0; }
  function makeUID(seed) {
    var a = hash32("dfx|" + seed), c = hash32("ax|" + seed);
    var L = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    var d4 = (a % 9000) + 1000;
    var two = L[(c >> 3) % 24] + L[(c >> 9) % 24];
    var d2 = (c % 90) + 10;
    return { uid: "QNTM-" + d4 + "-" + two + d2, qidCompact: ("" + (((hash32("qid|" + seed)) % 9000) + 1000)) + "AXQ" + (((hash32("qid|" + seed) >> 7) % 9000) + 1000) };
  }
  function memberSince(u) {
    var raw = u.created_at || u.createdAt || u.joined || u.joined_at || u.member_since || null;
    var dt = raw ? new Date(raw) : new Date();
    if (isNaN(dt.getTime())) dt = new Date();
    return dt.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  }

  // small QR (lazy qrcode-generator, same lib idcard.js uses) ------------------
  var _qrLoad = null;
  function loadQR() {
    if (window.qrcode) return Promise.resolve(true);
    if (_qrLoad) return _qrLoad;
    _qrLoad = new Promise(function (res) {
      var s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";
      s.async = true; s.onload = function () { res(!!window.qrcode); }; s.onerror = function () { res(false); };
      document.head.appendChild(s);
    });
    return _qrLoad;
  }
  function qrSVG(text, px, fg) {
    try {
      var qr = window.qrcode(0, "M"); qr.addData(text); qr.make();
      var c = qr.getModuleCount(), cell = px / c, r = "";
      for (var y = 0; y < c; y++) for (var x = 0; x < c; x++) {
        if (qr.isDark(y, x)) r += '<rect x="' + (x * cell).toFixed(2) + '" y="' + (y * cell).toFixed(2) + '" width="' + cell.toFixed(2) + '" height="' + cell.toFixed(2) + '"/>';
      }
      return '<svg width="' + px + '" height="' + px + '" viewBox="0 0 ' + px + ' ' + px + '" style="display:block"><rect width="' + px + '" height="' + px + '" fill="#fff" rx="3"/><g fill="' + (fg || "#5b21b6") + '">' + r + '</g></svg>';
    } catch (e) { return ""; }
  }

  // ── the rebuilt profile ────────────────────────────────────────────────────
  function openProfileV2() {
    modal("Profile", function (body, close) {
      var u = S.user || {};
      var newAv = u.avatar;
      var pro = (typeof isPro === "function") ? isPro() : (u.subscription_status === "active");
      var roleName = u.role === "admin" ? "Admin" : u.role === "wizard" ? "Wizard" : "Member";
      var rolePill = u.role === "admin" ? "admin" : u.role === "wizard" ? "wizard" : "member";
      var ids = makeUID(String(u.id || u.username || u.name || "member"));
      var since = memberSince(u);

      // widen + de-pad the host modal so cards reach the edges like the mockup
      var md = body.closest(".dq-modal-md");
      var wide = window.innerWidth >= 920;
      if (md) {
        md.style.width = wide ? "900px" : "560px";
        md.style.maxWidth = "100%";
        md.style.padding = "0";
        md.style.background = S.theme === "light"
          ? "linear-gradient(180deg,#eef3fb,#e7edf7)"
          : "radial-gradient(120% 80% at 50% -10%,#0d1838,#080f26 55%,#05091c)";
        md.style.border = "1px solid " + t.bd;
        // hide the default modal header (we render our own top bar)
        var hdr = md.firstElementChild;
        if (hdr && hdr.querySelector && hdr.querySelector("#md-cl")) hdr.style.display = "none";
      }

      // theme-aware tokens
      var GREEN = S.theme === "light" ? "#0b9d6a" : "#16e29a";
      var GREEN_GLOW = S.theme === "light" ? "rgba(11,157,106,.4)" : "rgba(22,226,154,.5)";
      var GREEN_GRAD = "linear-gradient(90deg,#0fd98a 0%,#36e36b 45%,#22c55e 100%)";
      var card = S.theme === "light" ? "rgba(255,255,255,.9)" : "rgba(14,24,50,.55)";
      var cardB = t.bd;
      var cap = t.t3, txt1 = t.t1, txt2 = t.t2;

      var avatarBlock =
        '<div style="position:relative;width:188px;height:188px;margin:0 auto">' +
          // outer glow rings
          '<div class="ppx-ring ppx-ring1"></div>' +
          '<div class="ppx-ring ppx-ring2"></div>' +
          '<div class="ppx-ring ppx-ring3"></div>' +
          // diamond nodes (N/E/S/W) on the ring
          '<span class="ppx-node" style="top:-5px;left:50%"></span>' +
          '<span class="ppx-node" style="bottom:-5px;left:50%"></span>' +
          '<span class="ppx-node" style="left:-5px;top:50%"></span>' +
          '<span class="ppx-node" style="right:-5px;top:50%"></span>' +
          // avatar core with the winged DrFX emblem behind the user's avatar
          '<div id="pp-av" style="position:absolute;inset:26px;border-radius:50%;cursor:pointer;overflow:hidden;background:radial-gradient(circle at 50% 30%,#10204a,#040a18);box-shadow:inset 0 0 30px rgba(0,0,0,.7),0 0 30px ' + GREEN_GLOW + '">' +
            '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">' + avatar(u.avatar || "\uD83E\uDDD1\u200D\uD83D\uDCBB", 136) + '</div>' +
          '</div>' +
          '<input id="pp-fi" type="file" accept="image/*" style="display:none"/>' +
        '</div>' +
        // ELITE badge + crown under the ring
        '<div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-top:-6px">' +
          '<div style="position:relative;padding:7px 22px;border-radius:13px;background:' + (S.theme === "light" ? "rgba(255,255,255,.9)" : "rgba(8,18,36,.85)") + ';border:1.5px solid ' + GREEN + ';box-shadow:0 0 18px ' + GREEN_GLOW + ',inset 0 0 10px ' + GREEN_GLOW + ';font-weight:900;letter-spacing:3px;font-size:15px;color:' + GREEN + ';text-shadow:0 0 12px ' + GREEN_GLOW + '">ELITE</div>' +
          '<div style="width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:1.5px solid ' + GREEN + ';box-shadow:0 0 14px ' + GREEN_GLOW + ';color:' + GREEN + '"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3 7l4.5 4L12 4l4.5 7L21 7l-1.8 11H4.8z"/></svg></div>' +
        '</div>' +
        // role pill
        '<div style="text-align:center;margin-top:14px"><span style="display:inline-block;padding:5px 18px;border-radius:13px;background:rgba(124,92,255,.16);border:1px solid rgba(124,92,255,.4);color:#a78bfa;font-size:13px;font-weight:700">' + esc(rolePill) + '</span></div>' +
        // editable name + verified seal
        '<div style="display:flex;align-items:center;justify-content:center;gap:9px;margin-top:8px">' +
          '<input id="pp-n" value="' + esc(u.name || "") + '" placeholder="Name" style="text-align:center;width:auto;max-width:62%;border:none;background:none;color:' + txt1 + ';font-size:30px;font-weight:900;font-family:\'Outfit\',sans-serif;outline:none"/>' +
          '<svg width="24" height="24" viewBox="0 0 24 24" style="flex-shrink:0"><path fill="' + GREEN + '" d="M12 1l2.6 1.9 3.2-.2 1 3 2.6 1.8-1 3 1 3-2.6 1.8-1 3-3.2-.2L12 23l-2.6-1.9-3.2.2-1-3L2.6 16.5l1-3-1-3 2.6-1.8 1-3 3.2.2z"/><path d="M8.5 12.3l2.4 2.4 4.6-5" fill="none" stroke="#04140d" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</div>' +
        // editable @username (kept from old profile)
        '<div style="text-align:center;margin-top:6px"><input id="pp-u" value="' + esc(u.username || "") + '" placeholder="username" style="text-align:center;width:auto;max-width:70%;padding:4px 14px;border-radius:12px;background:' + t.ta + ';border:1px solid ' + t.bl + ';color:' + t.ac + ';font-size:12.5px;font-weight:600;font-family:\'Outfit\',sans-serif;outline:none"/></div>' +
        '<div style="text-align:center;color:' + cap + ';font-size:14px;margin-top:8px">DrFX Quant ' + roleName + '</div>';

      // QNTM balance card (green Q + live balance) --------------------------------
      var qntmCard =
        '<div id="dq-wallet-chip" title="Open your QNTM wallet" style="cursor:pointer;display:flex;align-items:center;gap:13px;padding:15px 17px;border-radius:18px;background:' + card + ';border:1px solid ' + cardB + ';-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)">' +
          '<div style="width:46px;height:46px;border-radius:13px;background:' + GREEN_GRAD + ';display:flex;align-items:center;justify-content:center;color:#04140d;font-size:22px;font-weight:900;box-shadow:0 4px 16px ' + GREEN_GLOW + '">Q</div>' +
          '<div style="flex:1;min-width:0"><div style="color:' + cap + ';font-size:13px">QNTM Balance</div><div id="dq-wc-bal" style="color:' + GREEN + ';font-size:23px;font-weight:900;line-height:1.15;text-shadow:0 0 14px ' + GREEN_GLOW + '">0.00</div></div>' +
          '<div style="color:' + GREEN + ';opacity:.85"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M17 7h4v4"/></svg></div>' +
        '</div>';

      // Premium Tier card (checklist + 3D crown) ----------------------------------
      var feats = ["Priority Support", "Advanced Analytics", "Early Access Features", "Exclusive Rewards"];
      var checks = feats.map(function (f) {
        return '<div style="display:flex;align-items:center;gap:11px;margin-bottom:13px"><span style="width:22px;height:22px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:' + GREEN + ';box-shadow:0 0 10px ' + GREEN_GLOW + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#04140d" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span><span style="color:' + txt2 + ';font-size:15px;font-weight:600">' + f + '</span></div>';
      }).join("");
      var premiumCard =
        '<div style="position:relative;overflow:hidden;padding:20px;border-radius:20px;background:' + (S.theme === "light" ? "rgba(255,255,255,.92)" : "linear-gradient(150deg,rgba(20,32,66,.7),rgba(10,18,40,.55))") + ';border:1px solid ' + cardB + ';box-shadow:0 12px 40px rgba(0,0,0,.35)">' +
          '<div style="position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,' + BLUE + ',transparent)"></div>' +
          '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">' +
            '<div><div style="font-size:24px;font-weight:900;line-height:1;letter-spacing:.3px"><span style="color:' + BLUE + '">PREMIUM</span> <span style="color:' + txt1 + '">TIER</span></div>' +
            '<div style="color:' + cap + ';font-size:13.5px;margin-top:7px;line-height:1.45;max-width:230px">Unlock advanced tools and exclusive benefits</div></div>' +
            '<span style="flex-shrink:0;padding:3px 11px;border-radius:9px;border:1px solid ' + (pro ? GREEN : "rgba(245,196,81,.5)") + ';color:' + (pro ? GREEN : "#f5c451") + ';font-size:12px;font-weight:800;letter-spacing:.5px">' + (pro ? "PRO" : "OD") + '</span>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:6px;margin-top:18px">' +
            '<div style="flex:1;min-width:0">' + checks + '</div>' +
            '<div id="pp-crown3d" style="width:150px;height:138px;flex-shrink:0"></div>' +
          '</div>' +
          (pro
            ? '<div style="margin-top:6px;padding:13px;border-radius:14px;text-align:center;background:rgba(22,226,154,.1);border:1px solid ' + GREEN + ';color:' + GREEN + ';font-weight:800">Active \u00b7 ' + (typeof subDaysLeft === "function" ? subDaysLeft() : 0) + ' days left</div>'
            : '<button id="pp-upgrade" type="button" style="position:relative;overflow:hidden;width:100%;margin-top:6px;padding:15px;border-radius:14px;border:none;cursor:pointer;background:' + GREEN_GRAD + ';color:#04140d;font-size:16px;font-weight:800;font-family:\'Outfit\',sans-serif;box-shadow:0 8px 26px ' + GREEN_GLOW + ';display:flex;align-items:center;justify-content:center;gap:8px;-webkit-appearance:none"><span style="position:absolute;top:0;bottom:0;left:0;width:45%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.5),transparent);animation:ppxShine 3.2s ease-in-out infinite;pointer-events:none"></span><span style="position:relative">Upgrade Now</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#04140d" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="position:relative"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></button>') +
        '</div>';

      // User ID card --------------------------------------------------------------
      var idCard =
        '<div style="position:relative;overflow:hidden;padding:18px;border-radius:20px;background:' + (S.theme === "light" ? "rgba(255,255,255,.9)" : "linear-gradient(150deg,rgba(10,30,26,.6),rgba(8,20,30,.5))") + ';border:1px solid rgba(34,210,140,.28);box-shadow:0 10px 32px rgba(0,0,0,.3)">' +
          '<div style="color:' + GREEN + ';font-size:13px;font-weight:900;letter-spacing:1.6px">USER ID CARD</div>' +
          '<div style="display:flex;gap:16px;margin-top:14px">' +
            '<div style="width:84px;height:84px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:rgba(22,226,154,.12);border:1px solid rgba(34,210,140,.35)"><svg width="44" height="44" viewBox="0 0 24 24" fill="' + GREEN + '"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1z"/></svg></div>' +
            '<div style="flex:1;min-width:0">' +
              '<div style="color:' + cap + ';font-size:12px">UID</div>' +
              '<div style="color:' + GREEN + ';font-size:18px;font-weight:900;letter-spacing:.5px;margin-bottom:8px">' + esc(ids.uid) + '</div>' +
              '<div style="color:' + cap + ';font-size:12px">Role</div>' +
              '<div style="color:' + txt1 + ';font-size:15px;font-weight:700">' + (u.role === "admin" ? "Administrator" : roleName) + '</div>' +
            '</div>' +
            '<div id="pp-qr" style="width:78px;height:78px;flex-shrink:0;border-radius:8px;overflow:hidden;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 0 14px rgba(124,92,255,.4)"><div style="color:#5b21b6;font-size:9px">QR</div></div>' +
          '</div>' +
          '<div style="display:flex;align-items:flex-end;justify-content:space-between;margin-top:12px">' +
            '<div><div style="color:' + cap + ';font-size:12px">Member Since</div><div style="color:' + txt1 + ';font-size:15px;font-weight:700">' + esc(since) + '</div></div>' +
            '<div style="display:flex;align-items:center;gap:7px;color:' + GREEN + ';font-weight:800;font-size:14px"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="' + GREEN + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>Verified</div>' +
          '</div>' +
        '</div>';

      // League progress card (3D crystal + XP bar) --------------------------------
      var leagueCard =
        '<div style="position:relative;overflow:hidden;padding:18px;border-radius:20px;background:' + (S.theme === "light" ? "rgba(255,255,255,.9)" : "linear-gradient(150deg,rgba(16,26,60,.65),rgba(8,14,34,.5))") + ';border:1px solid ' + cardB + ';box-shadow:0 10px 32px rgba(0,0,0,.3)">' +
          '<div style="display:flex;align-items:center;justify-content:space-between"><div style="color:' + txt1 + ';font-size:17px;font-weight:900;letter-spacing:.4px">LEAGUE PROGRESS</div><button id="pp-league-all" type="button" style="background:none;border:none;color:' + BLUE + ';font-size:14px;font-weight:700;cursor:pointer;font-family:\'Outfit\',sans-serif">View All</button></div>' +
          '<div style="display:flex;align-items:center;gap:16px;margin-top:8px">' +
            '<div id="pp-gem3d" style="width:96px;height:124px;flex-shrink:0"></div>' +
            '<div style="flex:1;min-width:0">' +
              '<div id="pp-league-name" style="color:' + txt1 + ';font-size:24px;font-weight:900">Unranked</div>' +
              '<div style="margin:6px 0 10px"><span id="pp-xp-cur" style="color:' + BLUE + ';font-size:15px;font-weight:800">0</span><span style="color:' + cap + ';font-size:15px;font-weight:700"> / <span id="pp-xp-max">1000</span> XP</span></div>' +
              '<div style="height:12px;border-radius:7px;background:' + (S.theme === "light" ? "rgba(0,0,0,.08)" : "rgba(8,14,34,.8)") + ';overflow:hidden;box-shadow:inset 0 1px 3px rgba(0,0,0,.4)"><div id="pp-xp-bar" style="height:100%;width:0%;border-radius:7px;background:linear-gradient(90deg,#22c55e,#38bdf8 60%,#7c5cff);box-shadow:0 0 14px ' + BLUE_GLOW + ';transition:width .8s ease"></div></div>' +
              '<div style="color:' + cap + ';font-size:12.5px;margin-top:9px">Play matches to climb the leaderboard</div>' +
            '</div>' +
          '</div>' +
        '</div>';

      // Membership row (-> ID card overlay) ---------------------------------------
      var membershipRow =
        '<div style="padding:16px 18px;border-radius:20px;background:' + card + ';border:1px solid ' + cardB + '">' +
          '<div style="color:' + txt1 + ';font-size:16px;font-weight:900">MEMBERSHIP</div>' +
          '<div style="color:' + cap + ';font-size:13px;margin-top:3px">Manage your Quantum League identity</div>' +
          '<div id="pp-idcard-open" style="cursor:pointer;display:flex;align-items:center;gap:13px;margin-top:13px;padding:14px;border-radius:16px;background:' + (S.theme === "light" ? "rgba(31,139,255,.06)" : "rgba(16,28,58,.6)") + ';border:1px solid rgba(124,92,255,.25)">' +
            '<span style="width:46px;height:46px;border-radius:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:rgba(28,132,255,.16);color:' + BLUE + '"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2.5"/><circle cx="8" cy="11" r="2.6"/><path d="M14 9h5M14 13h5M4.5 16.5a4 4 0 0 1 7 0"/></svg></span>' +
            '<div style="flex:1;min-width:0"><div style="color:' + txt1 + ';font-size:15px;font-weight:800">Quantum League ID Card</div><div style="color:' + cap + ';font-size:12.5px">Your official QL identity</div><div style="color:' + GREEN + ';font-size:13px;font-weight:700;margin-top:2px">View Card \u2192</div></div>' +
            '<span style="color:' + cap + ';flex-shrink:0"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>' +
          '</div>' +
        '</div>';

      // Account activity ----------------------------------------------------------
      var statCell = function (id, label, accent) {
        return '<div style="flex:1;min-width:0;text-align:center;padding:14px 6px;border-radius:14px;background:' + (S.theme === "light" ? "rgba(0,0,0,.03)" : "rgba(8,14,34,.5)") + ';border:1px solid ' + cardB + '"><div id="' + id + '" style="font-size:24px;font-weight:900;color:' + (accent || txt1) + '">0</div><div style="color:' + cap + ';font-size:12.5px;margin-top:3px">' + label + '</div></div>';
      };
      var activityCard =
        '<div style="padding:16px 18px;border-radius:20px;background:' + card + ';border:1px solid ' + cardB + '">' +
          '<div style="display:flex;align-items:center;justify-content:space-between"><div style="color:' + txt1 + ';font-size:16px;font-weight:900">ACCOUNT ACTIVITY</div><div style="color:' + cap + ';font-size:13px;display:flex;align-items:center;gap:5px">This Month <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></div></div>' +
          '<div style="display:flex;gap:11px;margin-top:13px">' + statCell("pp-st-matches", "Matches") + statCell("pp-st-wins", "Wins") + statCell("pp-st-wr", "Win Rate", GREEN) + '</div>' +
        '</div>';

      // Bio + Email ---------------------------------------------------------------
      var bioEmail =
        '<div style="display:flex;align-items:flex-start;gap:13px;padding:14px 16px;border-radius:18px;background:' + card + ';border:1px solid ' + cardB + '">' +
          '<div style="width:42px;height:42px;border-radius:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:rgba(28,132,255,.14);color:' + BLUE + '"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>' +
          '<div style="flex:1;min-width:0"><div style="color:' + cap + ';font-size:13px;margin-bottom:3px">Bio</div><textarea id="pp-b" maxlength="120" rows="2" placeholder="Tell us about yourself..." style="width:100%;resize:none;border:none;background:none;color:' + txt1 + ';font-size:15px;font-weight:600;font-family:\'Outfit\',sans-serif;outline:none;line-height:1.4">' + esc(u.bio || "") + '</textarea><div style="text-align:right;color:' + t.t4 + ';font-size:11px"><span id="pp-bc">' + (u.bio || "").length + '</span>/120</div></div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:13px;padding:14px 16px;border-radius:18px;background:' + card + ';border:1px solid ' + cardB + '">' +
          '<div style="width:42px;height:42px;border-radius:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:rgba(28,132,255,.14);color:' + BLUE + '"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg></div>' +
          '<div style="flex:1;min-width:0"><div style="color:' + cap + ';font-size:13px;margin-bottom:1px">Email</div><div style="color:' + txt1 + ';font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(u.email || "") + '</div></div>' +
        '</div>';

      // Save button (KEEPS id pp-save — the idcard/leagues anchor) -----------------
      var saveBlock =
        '<button id="pp-save" type="button" style="position:relative;overflow:hidden;width:100%;padding:16px;border-radius:15px;border:none;cursor:pointer;background:' + GREEN_GRAD + ';color:#04140d;font-size:17px;font-weight:900;font-family:\'Outfit\',sans-serif;box-shadow:0 8px 28px ' + GREEN_GLOW + ';display:flex;align-items:center;justify-content:center;gap:10px;-webkit-appearance:none"><span style="position:absolute;top:0;bottom:0;left:0;width:45%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:ppxShine 3.2s ease-in-out infinite;pointer-events:none"></span><span style="position:relative;display:flex;align-items:center;gap:10px"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#04140d" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Save Changes</span></button>' +
        '<div style="text-align:center;color:' + cap + ';font-size:12px;margin-top:11px;display:flex;align-items:center;justify-content:center;gap:6px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="' + GREEN + '" stroke-width="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Your data is secure with us</div>' +
        // hidden sentinels so leagues-ui / idcard wrappers skip their own cards
        '<div id="dq-lg-card" style="display:none"></div><div id="dq-idcard-entry" style="display:none"></div>';

      // ── assemble (two columns on wide screens, stacked on mobile) ─────────────
      var leftCol = avatarBlock + '<div style="display:flex;flex-direction:column;gap:14px;margin-top:18px">' + qntmCard + idCard + bioEmail + saveBlock + '</div>';
      var rightCol = '<div style="display:flex;flex-direction:column;gap:14px">' + premiumCard + leagueCard + membershipRow + activityCard + '</div>';

      var inner = wide
        ? '<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start">' +
            '<div>' + leftCol + '</div><div style="padding-top:6px">' + rightCol + '</div>' +
          '</div>'
        : '<div style="display:flex;flex-direction:column;gap:16px">' + avatarBlock + qntmCard + premiumCard + idCard + leagueCard + membershipRow + activityCard + bioEmail + saveBlock + '</div>';

      body.innerHTML =
        '<style>' +
        '@keyframes ppxSpin{to{transform:rotate(360deg)}}' +
        '@keyframes ppxSpinR{to{transform:rotate(-360deg)}}' +
        '@keyframes ppxPulse{0%,100%{opacity:.85;transform:scale(1)}50%{opacity:1;transform:scale(1.015)}}' +
        '@keyframes ppxShine{0%{transform:translateX(-160%) skewX(-12deg)}100%{transform:translateX(320%) skewX(-12deg)}}' +
        '.ppx-ring{position:absolute;border-radius:50%;inset:0}' +
        '.ppx-ring1{border:2px solid ' + GREEN + ';box-shadow:0 0 26px ' + GREEN_GLOW + ',inset 0 0 26px ' + GREEN_GLOW + ';opacity:.9;animation:ppxPulse 3.4s ease-in-out infinite}' +
        '.ppx-ring2{inset:9px;border:1px dashed rgba(34,210,140,.5);animation:ppxSpin 22s linear infinite}' +
        '.ppx-ring3{inset:16px;border:1px solid rgba(34,210,140,.3);animation:ppxSpinR 32s linear infinite}' +
        '.ppx-node{position:absolute;width:10px;height:10px;margin:-5px 0 0 -5px;background:' + GREEN + ';transform:rotate(45deg);box-shadow:0 0 12px ' + GREEN + ';border-radius:2px}' +
        '#pp-body-wrap{padding:18px 18px calc(18px + var(--sab))}' +
        '</style>' +
        '<div id="pp-body-wrap">' + inner + '</div>';

      // ── wiring (all preserved from the original profile) ──────────────────────
      // avatar -> file picker
      var avEl = body.querySelector("#pp-av");
      if (avEl) avEl.onclick = function () { var fi = body.querySelector("#pp-fi"); if (fi) fi.click(); };

      // wallet chip -> wallet
      var wc = body.querySelector("#dq-wallet-chip");
      if (wc) wc.onclick = function () { close(); if (window.openWallet) openWallet(); };

      // live QNTM balance
      (async function () {
        try {
          var r = await api("/qntm/wallets/me");
          var b = body.querySelector("#dq-wc-bal");
          if (b && r && r.wallet) b.textContent = fmt2(r.wallet.available_balance);
        } catch (e) { }
      })();

      // bio counter
      var bb = body.querySelector("#pp-b"), bc = body.querySelector("#pp-bc");
      if (bb && bc) bb.oninput = function () { bc.textContent = bb.value.length; };

      // upgrade / upsell -> subscription
      var up = body.querySelector("#pp-upgrade");
      if (up) up.onclick = function () { close(); if (window.openSub) openSub(); };

      // league "View All" + crystal -> leagues overlay
      var la = body.querySelector("#pp-league-all");
      if (la) la.onclick = function () { close(); if (window.dqLeagues) dqLeagues.open(); };

      // membership row -> ID card overlay
      var idOpen = body.querySelector("#pp-idcard-open");
      if (idOpen) idOpen.onclick = function () { if (window.dqIdCard) dqIdCard.open(); };

      // live league + XP
      (async function () {
        try {
          var me = await api("/leagues/me");
          var nm = body.querySelector("#pp-league-name");
          if (nm) nm.textContent = (me && me.currentLeagueName) || "Unranked";
          var cur = num(me && (me.xp || me.currentXp || me.points)), max = num(me && (me.nextLevelXp || me.xpToNext)) || 1000;
          var cEl = body.querySelector("#pp-xp-cur"), mEl = body.querySelector("#pp-xp-max"), bar = body.querySelector("#pp-xp-bar");
          if (cEl) cEl.textContent = fmtN(cur);
          if (mEl) mEl.textContent = fmtN(max);
          if (bar) bar.style.width = Math.max(0, Math.min(100, max ? (cur / max) * 100 : 0)) + "%";
        } catch (e) { }
      })();

      // live account activity (Easy Trade leaderboard "me")
      (async function () {
        try {
          var d = await api("/easytrade/leaderboard?sort=xp");
          var me = d && d.me;
          if (me) {
            var m = body.querySelector("#pp-st-matches"), w = body.querySelector("#pp-st-wins"), wr = body.querySelector("#pp-st-wr");
            if (m) m.textContent = fmtN(me.settled != null ? me.settled : (num(me.wins) + num(me.losses)));
            if (w) w.textContent = fmtN(me.wins);
            if (wr) wr.textContent = (me.winRate != null ? me.winRate : 0) + "%";
          }
        } catch (e) { }
      })();

      // QR code for the ID card mini-preview
      loadQR().then(function (ok) {
        if (!ok) return;
        var qel = body.querySelector("#pp-qr");
        if (qel) { var svg = qrSVG("https://drfx.io/v/" + ids.qidCompact, 78, "#5b21b6"); if (svg) qel.innerHTML = svg; }
      });

      // mount the REAL 3D crystals (crown + gem); SVG fallback inside the module
      if (window.dq3DCrystal) {
        var crown = body.querySelector("#pp-crown3d");
        var gem = body.querySelector("#pp-gem3d");
        if (crown) dq3DCrystal.mount(crown, { kind: "crown", color: BLUE, height: 138 });
        if (gem) dq3DCrystal.mount(gem, { kind: "shard", color: BLUE, height: 124 });
        // dispose GL when the modal closes (overlay click / X / Esc all remove .dq-modal-ov)
        var ov = body.closest(".dq-modal-ov");
        if (ov && "MutationObserver" in window) {
          var mo = new MutationObserver(function () {
            if (!document.body.contains(ov)) { try { dq3DCrystal.disposeAll(); } catch (e) { } mo.disconnect(); }
          });
          mo.observe(document.body, { childList: true });
        }
      }

      // avatar upload (POST /api/upload) — same behaviour as before
      var fi = body.querySelector("#pp-fi");
      if (fi) fi.onchange = async function () {
        var inp = this; if (!inp.files[0]) return;
        var f = inp.files[0];
        if (!/^image\//.test(f.type || "")) { alert("Please choose an image file."); inp.value = ""; return; }
        var av = body.querySelector("#pp-av"), sv = body.querySelector("#pp-save");
        var spin = ce("div");
        spin.style.cssText = "position:absolute;inset:0;border-radius:50%;background:rgba(5,8,20,.62);display:flex;align-items:center;justify-content:center;z-index:5";
        spin.innerHTML = '<div style="width:26px;height:26px;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:dqspin .7s linear infinite"></div>';
        if (av) av.appendChild(spin);
        if (sv) sv.disabled = true;
        try {
          var fd = new FormData(); fd.append("file", f);
          var r = await fetch("/api/upload", { method: "POST", headers: { Authorization: "Bearer " + S.token }, body: fd });
          var d = await r.json().catch(function () { return {}; });
          if (!r.ok || !d.url) throw new Error((d && d.error) || "Upload failed");
          newAv = d.url;
          if (av) av.querySelector("div") && (av.querySelector("div").innerHTML = avatar(newAv, 136));
          if (av && spin.parentNode) spin.remove();
        } catch (e) { if (spin.parentNode) spin.remove(); alert((e && e.message) || "Upload failed. Please try again."); }
        finally { if (sv) sv.disabled = false; inp.value = ""; }
      };

      // save profile (PUT /api/auth/profile) — same as before
      var saveBtn = body.querySelector("#pp-save");
      if (saveBtn) saveBtn.onclick = async function () {
        try {
          var nEl = body.querySelector("#pp-n"), bEl = body.querySelector("#pp-b"), uEl = body.querySelector("#pp-u");
          var up2 = await api("/auth/profile", {
            method: "PUT",
            body: JSON.stringify({
              name: nEl ? nEl.value.trim() : u.name,
              bio: bEl ? bEl.value.trim() : u.bio,
              avatar: newAv,
              username: uEl ? uEl.value.trim() : u.username
            })
          });
          S.user = Object.assign({}, S.user, up2);
          localStorage.setItem("dq_u", JSON.stringify(S.user));
          try { if (window.dq3DCrystal) dq3DCrystal.disposeAll(); } catch (e) { }
          close();
          renderApp();
        } catch (e) { alert((e && e.error) || "Error"); }
      };
    });
  }

  // ── install: replace the host openProfile ──────────────────────────────────
  // Keep the property writable and let leagues-ui/idcard re-wrap us on their
  // 1200ms timers (they only append a card before #pp-save; our sentinels make
  // them skip). We expose a marker so we don't double-install.
  function install() {
    window.openProfile = openProfileV2;
    window.openProfile._dqProfileV2 = true;
    window.dqProfile = { open: openProfileV2 };
  }
  install();
  // Re-assert shortly after load in case another module reassigned it without
  // wrapping (defensive; wrappers that DO wrap will preserve our function).
  setTimeout(function () {
    if (window.openProfile && !window.openProfile._dqProfileV2 && !window.openProfile._dqIdWrapped && !window.openProfile._dqLeaguesWrapped) {
      install();
    }
  }, 60);
})();
