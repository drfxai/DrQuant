/* ============================================================================
 * leagues-ui.js — QNTM Leagues & the League Unlock Ritual (frontend)
 * ----------------------------------------------------------------------------
 * A self-contained module for the DrFX Quant SPA. Loads as a plain <script>
 * after index.html's main script, so it shares the global scope and reuses the
 * app's helpers (t, S, api, esc, ce, $, avatar, ic, I, goldSeal, showToast,
 * playNotif, isPro). It exposes one global:
 *
 *     window.dqLeagues = { open, openAdmin, onSocket, refresh }
 *
 * It also transparently WRAPS two host globals (both are function declarations,
 * so this needs no edits to the big template):
 *   - openProfile()    -> injects an "Ascension" league card into the profile
 *   - connectSocket()  -> binds the realtime "league_unlocked" welcome event
 *
 * Backend contract (see routes/leagues.js):
 *   GET  /api/leagues/me                  -> status + activeRitual + per-league states
 *   POST /api/leagues/:id/unlock          -> start the 7-day ritual (locks QNTM)
 *   POST /api/leagues/ritual/:rid/claim   -> finalize a matured ritual
 *   GET  /api/leagues/admin/rituals       -> admin oversight + chart series
 *   socket "league_unlocked"              -> {userId,leagueId,leagueName,amount,via}
 * ========================================================================== */
(function () {
  "use strict";
  if (window.dqLeagues) return; // singleton

  // ── tier palette (colours only; names come from the API) ──────────────────
  var LP = {
    1:  { c: "#7c9bff", g: ["#8fb0ff", "#4a6bdb"] },   // Discovery
    2:  { c: "#2dd4bf", g: ["#46e6d2", "#0f9e8e"] },   // Maker
    3:  { c: "#38bdf8", g: ["#62cdff", "#0c84d8"] },   // Top
    4:  { c: "#d98a4a", g: ["#e8a566", "#a9621f"] },   // Bronze
    5:  { c: "#cbd5e1", g: ["#eef2f8", "#94a3b8"] },   // Silver
    6:  { c: "#fbbf24", g: ["#ffd757", "#e0930a"] },   // Gold
    7:  { c: "#a78bfa", g: ["#c4b5fd", "#7c5cff"] },   // Master
    8:  { c: "#f472b6", g: ["#fb8ccb", "#db2777"] },   // Champion
    9:  { c: "#22d3ee", g: ["#6fe8f7", "#0891b2"] },   // Crystal
    10: { c: "#fb923c", g: ["#ffb066", "#ea6a0a"] },   // Titan
    11: { c: "#e879f9", g: ["#a78bfa", "#f472b6", "#22d3ee"] } // Legendary (prismatic)
  };
  function tier(id) { return LP[id] || LP[1]; }

  // ── small helpers ─────────────────────────────────────────────────────────
  function fmtN(n) { n = Number(n) || 0; return n.toLocaleString("en-US"); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function breakdown(secs) {
    secs = Math.max(0, Math.floor(secs));
    var d = Math.floor(secs / 86400); secs -= d * 86400;
    var h = Math.floor(secs / 3600); secs -= h * 3600;
    var m = Math.floor(secs / 60); var s = secs - m * 60;
    return { d: d, h: h, m: m, s: s };
  }
  function remainingMs(unlockAt) { return new Date(unlockAt).getTime() - Date.now(); }

  var _gid = 0;
  // A faceted gem badge for a tier. `dim` toggles a desaturated/locked look.
  function gem(id, size, dim) {
    var T = tier(id), gradId = "dqlg-g-" + (++_gid);
    var stops;
    if (T.g.length >= 3) {
      stops = '<stop offset="0%" stop-color="' + T.g[0] + '"/><stop offset="50%" stop-color="' + T.g[1] + '"/><stop offset="100%" stop-color="' + T.g[2] + '"/>';
    } else {
      stops = '<stop offset="0%" stop-color="' + T.g[0] + '"/><stop offset="100%" stop-color="' + T.g[1] + '"/>';
    }
    var op = dim ? 0.32 : 1;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 48 48" style="display:block;opacity:' + op + ';filter:drop-shadow(0 3px 8px ' + T.c + (dim ? '22' : '55') + ')">' +
      '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="1" y2="1">' + stops + '</linearGradient></defs>' +
      '<polygon points="24,3 40,14 33,43 15,43 8,14" fill="url(#' + gradId + ')" stroke="rgba(255,255,255,.55)" stroke-width="1"/>' +
      '<polygon points="24,3 33,43 24,18" fill="rgba(255,255,255,.16)"/>' +
      '<polygon points="24,3 15,43 24,18" fill="rgba(0,0,0,.10)"/>' +
      '<polyline points="8,14 24,18 40,14" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="1"/>' +
      '</svg>';
  }

  // State-badge pill.
  function stateBadge(state) {
    var map = {
      Unlocked:  ["#34d27a", "rgba(52,210,122,.14)", "Unlocked"],
      Ascending: ["#f5c451", "rgba(245,196,81,.14)", "Ascending"],
      Qualified: ["#5cc8ff", "rgba(92,200,255,.14)", "Qualified"],
      Locked:    ["#7088a8", "rgba(112,136,168,.12)", "Locked"]
    };
    var m = map[state] || map.Locked;
    var dot = state === "Unlocked"
      ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="' + m[0] + '" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : state === "Ascending"
        ? '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + m[0] + ';box-shadow:0 0 7px ' + m[0] + ';animation:dqlgPulse 1.3s ease-in-out infinite"></span>'
        : state === "Locked"
          ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="' + m[0] + '" stroke-width="2.4"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>'
          : '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + m[0] + '"></span>';
    return '<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:9px;background:' + m[1] + ';color:' + m[0] + ';font-size:11px;font-weight:800;letter-spacing:.3px">' + dot + m[2] + '</span>';
  }

  // ── one-time stylesheet (keyframes + confetti) ────────────────────────────
  function ensureCSS() {
    if (document.getElementById("dqlg-css")) return;
    var s = document.createElement("style"); s.id = "dqlg-css";
    s.textContent =
      "@keyframes dqlgPulse{0%,100%{opacity:1}50%{opacity:.35}}" +
      "@keyframes dqlgFadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}" +
      "@keyframes dqlgPop{0%{opacity:0;transform:scale(.86)}60%{transform:scale(1.04)}100%{opacity:1;transform:scale(1)}}" +
      "@keyframes dqlgFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}" +
      "@keyframes dqlgSpin{to{transform:rotate(360deg)}}" +
      "@keyframes dqlgRing{0%{box-shadow:0 0 0 0 rgba(245,196,81,.5)}100%{box-shadow:0 0 0 22px rgba(245,196,81,0)}}" +
      "@keyframes dqlgShine{0%{transform:translateX(-160%) skewX(-14deg)}100%{transform:translateX(320%) skewX(-14deg)}}" +
      "@keyframes dqlgConfFall{0%{transform:translateY(-12vh) rotate(0);opacity:1}100%{transform:translateY(108vh) rotate(720deg);opacity:.9}}" +
      "@keyframes dqlgGrow{from{transform:scaleY(0)}to{transform:scaleY(1)}}" +
      ".dqlg-row{animation:dqlgFadeUp .4s ease both}" +
      ".dqlg-cta{position:relative;overflow:hidden}" +
      ".dqlg-cta>span.sh{position:absolute;top:0;bottom:0;left:0;width:42%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);animation:dqlgShine 3s ease-in-out infinite;pointer-events:none}" +
      ".dqlg-scroll::-webkit-scrollbar{width:6px}.dqlg-scroll::-webkit-scrollbar-thumb{background:rgba(120,160,255,.2);border-radius:3px}";
    document.head.appendChild(s);
  }

  // ── overlay scaffold (Control-Deck style, fully themed) ───────────────────
  var _interval = null;
  function clearTick() { if (_interval) { clearInterval(_interval); _interval = null; } }

  function buildOverlay(opts) {
    ensureCSS();
    var existing = document.getElementById(opts.id);
    if (existing) existing.remove();
    var ov = ce("div"); ov.id = opts.id;
    ov.style.cssText = "position:fixed;inset:0;z-index:10000;background:" + t.bg + ";display:flex;flex-direction:column;animation:dqlgFadeUp .25s ease";
    // top bar
    var bar = ce("div");
    bar.style.cssText = "display:flex;align-items:center;gap:10px;padding:calc(var(--sat,0px) + 11px) 14px 11px;background:" + t.p + ";backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border-bottom:1px solid " + t.bd + ";flex-shrink:0";
    bar.innerHTML = '<span style="display:flex;color:' + t.pr + ';filter:drop-shadow(0 0 8px ' + t.pgw + ')">' +
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 5.4 5.9.5-4.5 3.9 1.4 5.8L12 20l-5.6 3.6 1.4-5.8L3.3 7.9l5.9-.5z"/></svg></span>' +
      '<div style="line-height:1.1"><div style="font-weight:800;color:' + t.t1 + ';font-size:16px;letter-spacing:.2px">' + esc(opts.title) + '</div>' +
      '<div style="color:' + t.t3 + ';font-size:11px">' + esc(opts.subtitle || "") + '</div></div>';
    var sp = ce("div"); sp.style.flex = "1"; bar.appendChild(sp);
    if (opts.rightBtn) {
      var rb = ce("button"); rb.type = "button"; rb.innerHTML = opts.rightBtn.label;
      rb.style.cssText = "display:flex;align-items:center;gap:6px;padding:8px 13px;border-radius:11px;border:1px solid " + t.bd + ";background:" + t.cd + ";color:" + t.t2 + ";font-size:12.5px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif;margin-right:8px";
      rb.onclick = opts.rightBtn.onClick; bar.appendChild(rb);
    }
    var cls = ce("button"); cls.type = "button"; cls.setAttribute("aria-label", "Close");
    cls.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    cls.style.cssText = "width:38px;height:38px;border-radius:50%;border:1px solid " + t.bd + ";background:" + t.cd + ";color:" + t.t2 + ";cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0";
    cls.onclick = function () { clearTick(); ov.remove(); };
    bar.appendChild(cls);
    // scroll body
    var body = ce("div"); body.className = "dqlg-scroll";
    body.style.cssText = "flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:16px 14px calc(var(--sab,0px) + 26px)";
    ov.appendChild(bar); ov.appendChild(body);
    document.body.appendChild(ov);
    return { ov: ov, body: body };
  }

  // ── live countdown ticking (updates every .dq-cd node from data-unlock) ───
  function startTick() {
    clearTick();
    _interval = setInterval(function () {
      var nodes = document.querySelectorAll(".dq-cd");
      if (!nodes.length) return;
      nodes.forEach(function (el) {
        var ms = remainingMs(el.getAttribute("data-unlock"));
        var b = breakdown(ms / 1000);
        var seg = el.querySelectorAll(".dq-cd-seg");
        if (seg.length === 4) {
          seg[0].textContent = b.d; seg[1].textContent = pad(b.h);
          seg[2].textContent = pad(b.m); seg[3].textContent = pad(b.s);
        }
        if (ms <= 0 && el.getAttribute("data-fired") !== "1") {
          el.setAttribute("data-fired", "1");
          // matured while watching — refresh so the Claim CTA appears
          setTimeout(function () { if (_curRender) _curRender(); }, 600);
        }
      });
    }, 1000);
  }

  // ── countdown card markup ─────────────────────────────────────────────────
  function countdownCard(ar) {
    var T = tier(ar.leagueId);
    var b = breakdown((ar.secondsRemaining != null ? ar.secondsRemaining : remainingMs(ar.unlockAt) / 1000));
    var ready = ar.ready || remainingMs(ar.unlockAt) <= 0;
    var seg = function (val, lbl) {
      return '<div style="text-align:center;min-width:54px"><div class="dq-cd-seg" style="font-size:30px;font-weight:800;color:' + t.t1 + ';line-height:1;font-variant-numeric:tabular-nums">' + val + '</div><div style="font-size:9.5px;letter-spacing:1.5px;color:' + t.t3 + ';margin-top:4px;text-transform:uppercase">' + lbl + '</div></div>';
    };
    var sepd = '<div style="font-size:24px;color:' + t.t4 + ';font-weight:300;align-self:flex-start;margin-top:1px">:</div>';
    var inner = ready
      ? '<div style="text-align:center;padding:6px 0"><div style="color:' + T.c + ';font-size:15px;font-weight:800;margin-bottom:3px">The ritual is complete</div><div style="color:' + t.t3 + ';font-size:12.5px">Claim your ascension to ' + esc(ar.leagueName) + '</div></div>'
      : '<div class="dq-cd" data-unlock="' + new Date(ar.unlockAt).toISOString() + '" style="display:flex;align-items:flex-start;justify-content:center;gap:10px;padding:4px 0 2px">' +
        seg(b.d, "Days") + sepd + seg(pad(b.h), "Hrs") + sepd + seg(pad(b.m), "Min") + sepd + seg(pad(b.s), "Sec") + '</div>';

    var btn = ready
      ? '<button class="dqlg-claim dqlg-cta" data-rid="' + ar.ritualId + '" style="width:100%;margin-top:13px;padding:14px;border-radius:13px;border:none;background:linear-gradient(135deg,' + T.g[0] + ',' + T.g[1] + ');color:#06101f;font-weight:800;font-size:15px;cursor:pointer;font-family:\'Outfit\',sans-serif;box-shadow:0 8px 24px ' + T.c + '55"><span class="sh"></span><span style="position:relative">✦ Claim ' + esc(ar.leagueName) + ' League</span></button>'
      : '<div style="margin-top:13px;display:flex;align-items:center;justify-content:center;gap:7px;color:' + t.t3 + ';font-size:12px"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + T.c + ';box-shadow:0 0 8px ' + T.c + ';animation:dqlgPulse 1.3s ease-in-out infinite"></span>' + fmtN(ar.amount) + ' QNTM committed · returned in full on unlock</div>';

    return '<div style="position:relative;overflow:hidden;border-radius:20px;padding:18px;margin-bottom:18px;background:linear-gradient(180deg,' + T.c + '1f,' + t.ch + ');border:1px solid ' + T.c + '55;box-shadow:0 12px 38px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.06)">' +
      '<div style="position:absolute;top:-30px;right:-30px;width:130px;height:130px;border-radius:50%;background:radial-gradient(circle,' + T.c + '33,transparent 70%);pointer-events:none"></div>' +
      '<div style="display:flex;align-items:center;gap:13px;margin-bottom:14px;position:relative">' +
        '<div style="animation:dqlgFloat 3.4s ease-in-out infinite">' + gem(ar.leagueId, 46) + '</div>' +
        '<div style="flex:1;min-width:0"><div style="font-size:10px;letter-spacing:1.6px;color:' + T.c + ';font-weight:800;text-transform:uppercase">Ascending to</div>' +
        '<div style="font-size:20px;font-weight:800;color:' + t.t1 + ';line-height:1.1">' + esc(ar.leagueName) + ' League</div></div>' +
      '</div>' + inner + btn + '</div>';
  }

  // ── league ladder row ─────────────────────────────────────────────────────
  function leagueRow(l, me, idx) {
    var T = tier(l.id);
    var locked = l.state === "Locked";
    var canStart = l.state === "Qualified" && Number(l.stakeForUnlock) > 0;
    var affordable = l.affordable !== false;
    var sub;
    if (l.state === "Unlocked") sub = '<span style="color:' + t.t3 + ';font-size:11.5px">Unlocked · permanent access</span>';
    else if (l.state === "Ascending") sub = '<span style="color:#f5c451;font-size:11.5px">7-day ritual in progress</span>';
    else if (l.id <= 1) sub = '<span style="color:' + t.t3 + ';font-size:11.5px">Base league</span>';
    else sub = '<span style="color:' + t.t3 + ';font-size:11.5px">Earn ' + fmtN(l.earnedThreshold) + ' · stake ' + fmtN(l.stakeForUnlock) + ' QNTM</span>';

    var cta = "";
    if (canStart) {
      cta = affordable
        ? '<button class="dqlg-start dqlg-cta" data-id="' + l.id + '" data-name="' + esc(l.name) + '" data-amt="' + l.stakeForUnlock + '" style="margin-top:9px;width:100%;padding:11px;border-radius:11px;border:none;background:linear-gradient(135deg,' + T.g[0] + ',' + T.g[1] + ');color:#06101f;font-weight:800;font-size:13px;cursor:pointer;font-family:\'Outfit\',sans-serif;box-shadow:0 6px 18px ' + T.c + '44"><span class="sh"></span><span style="position:relative">Commit ' + fmtN(l.stakeForUnlock) + ' QNTM · 7-day ritual</span></button>'
        : '<div style="margin-top:9px;width:100%;padding:11px;border-radius:11px;border:1px dashed ' + t.bd + ';background:' + t.cd + ';color:' + t.t3 + ';font-size:12px;text-align:center">Need ' + fmtN(Math.max(0, l.stakeForUnlock - (me.availableQntm || 0))) + ' more QNTM to begin</div>';
    }

    return '<div class="dqlg-row" style="animation-delay:' + (idx * 0.03) + 's;display:block;padding:13px;border-radius:16px;margin-bottom:9px;background:' + (l.state === "Unlocked" ? "linear-gradient(180deg," + T.c + "14," + t.cd + ")" : t.cd) + ';border:1px solid ' + (l.state === "Ascending" ? "#f5c45155" : (l.state === "Unlocked" ? T.c + "44" : t.bd)) + '">' +
      '<div style="display:flex;align-items:center;gap:12px">' +
        gem(l.id, 38, locked) +
        '<div style="flex:1;min-width:0"><div style="display:flex;align-items:center;gap:7px"><span style="font-size:15px;font-weight:800;color:' + (locked ? t.t3 : t.t1) + '">' + esc(l.name) + '</span></div>' + sub + '</div>' +
        stateBadge(l.state) +
      '</div>' + cta + '</div>';
  }

  // ── main render ───────────────────────────────────────────────────────────
  var _curRender = null;
  function renderInto(body) {
    body.innerHTML = '<div style="text-align:center;color:' + t.t3 + ';padding:40px 0;animation:dqlgPulse 1.4s infinite">Reading the ledger…</div>';
    api("/leagues/me").then(function (me) {
      var cur = me.currentLeagueId, T = tier(cur || 1);
      var hero =
        '<div style="position:relative;overflow:hidden;border-radius:22px;padding:20px;margin-bottom:16px;background:radial-gradient(120% 90% at 50% -10%,' + T.c + '26,' + t.ch + ' 60%);border:1px solid ' + t.bd + ';box-shadow:0 14px 40px rgba(0,0,0,.3)">' +
          '<div style="position:absolute;inset:0;background:radial-gradient(60% 50% at 80% 10%,' + T.c + '22,transparent 70%);pointer-events:none"></div>' +
          '<div style="display:flex;align-items:center;gap:15px;position:relative">' +
            '<div style="animation:dqlgFloat 4s ease-in-out infinite">' + gem(cur || 1, 64) + '</div>' +
            '<div style="flex:1;min-width:0">' +
              '<div style="font-size:10px;letter-spacing:1.8px;color:' + T.c + ';font-weight:800;text-transform:uppercase">Current League</div>' +
              '<div style="font-size:25px;font-weight:800;color:' + t.t1 + ';line-height:1.05">' + esc(me.currentLeagueName || "Unranked") + '</div>' +
              '<div style="color:' + t.t3 + ';font-size:12px;margin-top:3px">' + fmtN(me.earned) + ' QNTM earned · all-time</div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:9px;margin-top:15px;position:relative">' +
            '<div style="flex:1;padding:11px 13px;border-radius:13px;background:' + t.inp + ';border:1px solid ' + t.bd + '"><div style="color:' + t.t3 + ';font-size:10px;letter-spacing:.5px;font-weight:700;text-transform:uppercase">Available</div><div style="color:' + t.t1 + ';font-size:17px;font-weight:800">' + (me.availableQntm == null ? "—" : fmtN(me.availableQntm)) + ' <span style="font-size:11px;color:' + t.t3 + '">QNTM</span></div></div>' +
            '<div style="flex:1;padding:11px 13px;border-radius:13px;background:' + t.inp + ';border:1px solid ' + t.bd + '"><div style="color:' + t.t3 + ';font-size:10px;letter-spacing:.5px;font-weight:700;text-transform:uppercase">Qualified up to</div><div style="color:' + t.t1 + ';font-size:17px;font-weight:800">' + esc(me.highestQualifiedName || "—") + '</div></div>' +
          '</div>' +
        '</div>';

      var ritual = me.activeRitual ? countdownCard(me.activeRitual) : "";

      var intro = me.activeRitual ? "" :
        '<div style="display:flex;align-items:flex-start;gap:9px;padding:12px 14px;border-radius:14px;background:' + t.cd + ';border:1px solid ' + t.bd + ';margin-bottom:14px">' +
        '<span style="display:flex;color:' + t.pr + ';flex-shrink:0;margin-top:1px">' + ic('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>', 17) + '</span>' +
        '<div style="color:' + t.t2 + ';font-size:12.5px;line-height:1.55">Commit QNTM to a higher league and a <b style="color:' + t.t1 + '">7-day ascension ritual</b> begins. When it completes, the league is yours forever and <b style="color:' + t.t1 + '">every token is returned</b> — no fees, no yield.</div></div>';

      var ladderTitle = '<div style="display:flex;align-items:center;gap:8px;margin:4px 2px 11px"><span style="color:' + t.t2 + ';font-size:12px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase">The Ascension Path</span><div style="flex:1;height:1px;background:' + t.bd + '"></div></div>';
      var ladder = (me.leagues || []).map(function (l, i) { return leagueRow(l, me, i); }).join("");

      body.innerHTML = hero + ritual + intro + ladderTitle + ladder +
        '<div style="text-align:center;color:' + t.t4 + ';font-size:10.5px;margin-top:14px;line-height:1.5">A league unlock is a one-time qualification ritual.<br>The stake is non-yield and fully returned. Not financial advice.</div>';

      // wire CTAs
      body.querySelectorAll(".dqlg-start").forEach(function (b) {
        b.onclick = function () { confirmStart(Number(b.dataset.id), b.dataset.name, Number(b.dataset.amt)); };
      });
      body.querySelectorAll(".dqlg-claim").forEach(function (b) {
        b.onclick = function () { doClaim(b.dataset.rid, b); };
      });
      startTick();
    }).catch(function (e) {
      body.innerHTML = '<div style="text-align:center;color:#ff6b6b;padding:30px 12px">' + esc((e && (e.message || e.error)) || "Could not load leagues") + '</div>';
    });
  }

  // ── start ritual (confirm sheet) ──────────────────────────────────────────
  function confirmStart(id, name, amount) {
    var T = tier(id);
    var ov = ce("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:10050;background:" + t.ov + ";backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:center;animation:dqlgFadeUp .2s ease";
    var sheet = ce("div");
    sheet.style.cssText = "width:100%;max-width:460px;background:" + t.mod + ";border:1px solid " + t.ba + ";border-bottom:none;border-radius:24px 24px 0 0;padding:22px 20px calc(var(--sab,0px) + 22px);box-shadow:0 -10px 40px rgba(0,0,0,.4);animation:dqlgPop .28s ease";
    sheet.innerHTML =
      '<div style="text-align:center"><div style="display:inline-block;animation:dqlgFloat 3s ease-in-out infinite">' + gem(id, 58) + '</div>' +
      '<div style="font-size:21px;font-weight:800;color:' + t.t1 + ';margin-top:10px">Begin the ' + esc(name) + ' Ritual</div>' +
      '<div style="color:' + t.t3 + ';font-size:13px;margin-top:5px;line-height:1.5">You will commit <b style="color:' + t.t1 + '">' + fmtN(amount) + ' QNTM</b> for <b style="color:' + t.t1 + '">7 days</b>.<br>It returns in full when ' + esc(name) + ' unlocks.</div></div>' +
      '<div style="display:flex;gap:9px;margin-top:18px;padding:13px;border-radius:14px;background:' + t.cd + ';border:1px solid ' + t.bd + '">' +
        '<div style="flex:1;text-align:center"><div style="color:' + t.t3 + ';font-size:10px;letter-spacing:.5px;font-weight:700;text-transform:uppercase">Commit</div><div style="color:' + t.t1 + ';font-weight:800;font-size:15px;margin-top:2px">' + fmtN(amount) + '</div></div>' +
        '<div style="width:1px;background:' + t.bd + '"></div>' +
        '<div style="flex:1;text-align:center"><div style="color:' + t.t3 + ';font-size:10px;letter-spacing:.5px;font-weight:700;text-transform:uppercase">Duration</div><div style="color:' + t.t1 + ';font-weight:800;font-size:15px;margin-top:2px">7 days</div></div>' +
        '<div style="width:1px;background:' + t.bd + '"></div>' +
        '<div style="flex:1;text-align:center"><div style="color:' + t.t3 + ';font-size:10px;letter-spacing:.5px;font-weight:700;text-transform:uppercase">Returned</div><div style="color:#34d27a;font-weight:800;font-size:15px;margin-top:2px">100%</div></div>' +
      '</div>' +
      '<button class="dqlg-go dqlg-cta" style="width:100%;margin-top:16px;padding:15px;border-radius:14px;border:none;background:linear-gradient(135deg,' + T.g[0] + ',' + T.g[1] + ');color:#06101f;font-weight:800;font-size:15px;cursor:pointer;font-family:\'Outfit\',sans-serif;box-shadow:0 8px 24px ' + T.c + '55"><span class="sh"></span><span style="position:relative">✦ Commit & start the 7-day ritual</span></button>' +
      '<button class="dqlg-cancel" style="width:100%;margin-top:9px;padding:12px;border-radius:13px;border:1px solid ' + t.bd + ';background:transparent;color:' + t.t3 + ';font-weight:700;font-size:13px;cursor:pointer;font-family:\'Outfit\',sans-serif">Not yet</button>';
    ov.appendChild(sheet); document.body.appendChild(ov);
    var done = false;
    var kill = function () { if (done) return; done = true; ov.remove(); };
    sheet.querySelector(".dqlg-cancel").onclick = kill;
    ov.onclick = function (e) { if (e.target === ov) kill(); };
    sheet.querySelector(".dqlg-go").onclick = function () {
      var btn = sheet.querySelector(".dqlg-go");
      btn.disabled = true; btn.style.opacity = ".7";
      btn.querySelector("span:last-child").textContent = "Committing…";
      api("/leagues/" + id + "/unlock", { method: "POST" }).then(function () {
        kill();
        if (typeof showToast === "function") showToast("Ritual begun", name + " unlocks in 7 days");
        if (typeof playNotif === "function") playNotif();
        if (_curRender) _curRender();
      }).catch(function (e) {
        btn.disabled = false; btn.style.opacity = "1";
        btn.querySelector("span:last-child").textContent = "✦ Commit & start the 7-day ritual";
        var msg = (e && (e.message || e.error)) || "Could not start the ritual";
        if (typeof showToast === "function") showToast("Couldn't start", msg);
        else alert(msg);
      });
    };
  }

  // ── claim a matured ritual ────────────────────────────────────────────────
  function doClaim(rid, btn) {
    if (btn) { btn.disabled = true; btn.style.opacity = ".7"; }
    api("/leagues/ritual/" + rid + "/claim", { method: "POST" }).then(function (r) {
      celebrate(r.leagueName, r.leagueId);
      if (_curRender) _curRender();
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.style.opacity = "1"; }
      var msg = (e && (e.message || e.error)) || "Could not claim yet";
      if (typeof showToast === "function") showToast("Not ready", msg); else alert(msg);
      if (/not_ready/.test((e && e.code) || "")) { if (_curRender) _curRender(); }
    });
  }

  // ── celebratory welcome pop-up (confetti) ─────────────────────────────────
  var _celebrating = false;
  function celebrate(name, id) {
    if (_celebrating) return; _celebrating = true;
    ensureCSS();
    var T = tier(id || 1);
    var ov = ce("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:10100;background:radial-gradient(circle at 50% 38%," + T.c + "33,rgba(3,8,18,.92) 60%);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:24px;animation:dqlgFadeUp .3s ease";
    // confetti
    var conf = "";
    var cols = (T.g.length >= 3 ? T.g : [T.g[0], T.g[1], "#fff", "#f5c451"]);
    for (var i = 0; i < 34; i++) {
      var c = cols[i % cols.length];
      var left = Math.random() * 100, delay = Math.random() * 0.5, dur = 2.4 + Math.random() * 1.6, sz = 6 + Math.random() * 7, rnd = Math.random() > .5;
      conf += '<span style="position:absolute;top:-12vh;left:' + left + '%;width:' + sz + 'px;height:' + (sz * (rnd ? 1 : 0.4) + 4) + 'px;background:' + c + ';border-radius:' + (rnd ? '50%' : '2px') + ';opacity:.95;animation:dqlgConfFall ' + dur + 's linear ' + delay + 's forwards"></span>';
    }
    var card = ce("div");
    card.style.cssText = "position:relative;text-align:center;max-width:380px;width:100%;padding:30px 24px;border-radius:26px;background:" + t.mod + ";border:1px solid " + T.c + "66;box-shadow:0 24px 70px rgba(0,0,0,.5),0 0 40px " + T.c + "33;animation:dqlgPop .5s cubic-bezier(.2,.9,.3,1.2)";
    card.innerHTML =
      '<div style="display:inline-flex;align-items:center;justify-content:center;width:96px;height:96px;border-radius:50%;background:radial-gradient(circle,' + T.c + '33,transparent 70%);animation:dqlgRing 1.6s ease-out infinite">' +
        '<div style="animation:dqlgFloat 3s ease-in-out infinite">' + gem(id || 1, 72) + '</div></div>' +
      '<div style="font-size:11px;letter-spacing:2.4px;color:' + T.c + ';font-weight:800;text-transform:uppercase;margin-top:14px">Ascension complete</div>' +
      '<div style="font-size:27px;font-weight:800;color:' + t.t1 + ';line-height:1.1;margin-top:4px">Welcome to<br>' + esc(name) + ' League</div>' +
      '<div style="color:' + t.t3 + ';font-size:13.5px;line-height:1.6;margin-top:12px">Your 7-day commitment has paid off.<br>' + esc(name) + ' is now <b style="color:' + t.t1 + '">permanently active</b>, and your staked QNTM has been returned in full.</div>' +
      '<button class="dqlg-celebrate-x dqlg-cta" style="width:100%;margin-top:20px;padding:14px;border-radius:14px;border:none;background:linear-gradient(135deg,' + T.g[0] + ',' + T.g[1] + ');color:#06101f;font-weight:800;font-size:15px;cursor:pointer;font-family:\'Outfit\',sans-serif;box-shadow:0 8px 24px ' + T.c + '55"><span class="sh"></span><span style="position:relative">Enter ' + esc(name) + '</span></button>';
    ov.innerHTML = conf;
    ov.appendChild(card);
    document.body.appendChild(ov);
    if (typeof playNotif === "function") playNotif();
    var kill = function () { _celebrating = false; ov.style.animation = "dqlgFadeUp .2s ease reverse forwards"; setTimeout(function () { ov.remove(); }, 200); };
    card.querySelector(".dqlg-celebrate-x").onclick = kill;
    ov.onclick = function (e) { if (e.target === ov) kill(); };
    setTimeout(function () { if (document.body.contains(ov)) kill(); }, 9000);
  }

  // ── public: open the ascension screen ─────────────────────────────────────
  function open() {
    var isAdmin = S && S.user && S.user.role === "admin";
    var built = buildOverlay({
      id: "dqlg-overlay",
      title: "Ascension",
      subtitle: "QNTM Leagues · unlock rituals",
      rightBtn: isAdmin ? {
        label: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/></svg> Oversight',
        onClick: function () { openAdmin(); }
      } : null
    });
    _curRender = function () { renderInto(built.body); };
    _curRender();
  }

  // ── admin chart (SVG) ─────────────────────────────────────────────────────
  function barChart(series) {
    var w = 320, h = 120, pad = 6, n = series.length || 1;
    var max = Math.max(1, Math.max.apply(null, series.map(function (d) { return d.unlocks; })));
    var bw = (w - pad * 2) / n;
    var bars = series.map(function (d, i) {
      var bh = Math.round((d.unlocks / max) * (h - 24));
      var x = pad + i * bw, y = h - bh - 14;
      return '<rect x="' + (x + bw * 0.16) + '" y="' + y + '" width="' + (bw * 0.68) + '" height="' + Math.max(1, bh) + '" rx="2" fill="url(#dqlgBar)" style="transform-origin:' + (x + bw * 0.5) + 'px ' + (h - 14) + 'px;animation:dqlgGrow .5s ease ' + (i * 0.03) + 's both"><title>' + d.day + ': ' + d.unlocks + '</title></rect>';
    }).join("");
    var lbls = series.map(function (d, i) {
      if (n > 8 && i % 2) return "";
      var x = pad + i * bw + bw * 0.5;
      return '<text x="' + x + '" y="' + (h - 2) + '" text-anchor="middle" font-size="7.5" fill="' + t.t4 + '">' + d.day.slice(5) + '</text>';
    }).join("");
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" style="display:block"><defs><linearGradient id="dqlgBar" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + t.pr + '"/><stop offset="100%" stop-color="' + t.pr + '88"/></linearGradient></defs>' + bars + lbls + '</svg>';
  }

  function openAdmin() {
    if (!(S && S.user && S.user.role === "admin")) return;
    var built = buildOverlay({ id: "dqlg-admin", title: "Ritual Oversight", subtitle: "league unlocks · locked QNTM" });
    var body = built.body;
    body.innerHTML = '<div style="text-align:center;color:' + t.t3 + ';padding:40px 0;animation:dqlgPulse 1.4s infinite">Loading oversight…</div>';
    api("/leagues/admin/rituals").then(function (d) {
      var T = d.totals || {};
      var statCard = function (val, lbl, col, glyph) {
        return '<div style="flex:1;min-width:0;padding:13px;border-radius:16px;background:' + t.cd + ';border:1px solid ' + t.bd + '"><div style="display:flex;align-items:center;gap:7px;margin-bottom:6px"><span style="display:flex;color:' + col + '">' + glyph + '</span><span style="color:' + t.t3 + ';font-size:10.5px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + lbl + '</span></div><div style="color:' + t.t1 + ';font-size:22px;font-weight:800;line-height:1">' + val + '</div></div>';
      };
      var stats =
        '<div style="display:flex;gap:9px;margin-bottom:10px">' +
        statCard(fmtN(T.activeRituals), "Active rituals", "#f5c451", '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>') +
        statCard(fmtN(T.completedRituals), "Completed", "#34d27a", '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>') +
        '</div>' +
        '<div style="display:flex;gap:9px;margin-bottom:16px">' +
        statCard(fmtN(T.lockedQntm), "QNTM locked", t.pr, '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>') +
        statCard(fmtN(T.activeUsers), "Active users", "#5cc8ff", '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>') +
        '</div>';

      var hasChart = (d.chart || []).some(function (x) { return x.unlocks > 0; });
      var chart =
        '<div style="border-radius:18px;padding:15px;background:' + t.cd + ';border:1px solid ' + t.bd + ';margin-bottom:16px">' +
        '<div style="color:' + t.t2 + ';font-size:12px;font-weight:800;letter-spacing:.4px;margin-bottom:10px">Unlocks · last 14 days</div>' +
        (hasChart ? barChart(d.chart) : '<div style="color:' + t.t4 + ';font-size:12px;text-align:center;padding:24px 0">No completed unlocks yet</div>') +
        '</div>';

      // per-league locked bars
      var maxLocked = Math.max(1, Math.max.apply(null, (d.byLeague || []).map(function (l) { return l.lockedQntm; })));
      var perLeague = (d.byLeague || []).filter(function (l) { return l.active > 0 || l.completed > 0; }).map(function (l) {
        var Tn = tier(l.id), pct = Math.round((l.lockedQntm / maxLocked) * 100);
        return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0">' +
          gem(l.id, 26) +
          '<div style="flex:1;min-width:0"><div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px"><span style="color:' + t.t1 + ';font-size:12.5px;font-weight:700">' + esc(l.name) + '</span><span style="color:' + t.t3 + ';font-size:11px">' + fmtN(l.lockedQntm) + ' QNTM · ' + l.active + ' active</span></div>' +
          '<div style="height:7px;border-radius:4px;background:' + t.inp + ';overflow:hidden"><div style="height:100%;width:' + pct + '%;border-radius:4px;background:linear-gradient(90deg,' + Tn.g[0] + ',' + Tn.g[1] + ');transition:width .6s ease"></div></div></div>' +
          '<span style="color:' + t.t3 + ';font-size:11px;min-width:54px;text-align:right">' + l.completed + ' done</span></div>';
      }).join("");
      var perLeagueBlock = perLeague
        ? '<div style="border-radius:18px;padding:15px;background:' + t.cd + ';border:1px solid ' + t.bd + ';margin-bottom:16px"><div style="color:' + t.t2 + ';font-size:12px;font-weight:800;letter-spacing:.4px;margin-bottom:6px">By league</div>' + perLeague + '</div>'
        : "";

      // recent table
      var rows = (d.recent || []).map(function (r) {
        var Tn = tier(r.leagueId);
        var when = r.status === "completed"
          ? '<span style="color:#34d27a">done' + (r.releasedVia ? " · " + r.releasedVia : "") + '</span>'
          : (r.status === "pending_unlock"
            ? '<span style="color:#f5c451">in ' + Math.max(0, Math.ceil(remainingMs(r.unlockAt) / 86400000)) + 'd</span>'
            : '<span style="color:' + t.t4 + '">' + esc(r.status) + '</span>');
        return '<div style="display:flex;align-items:center;gap:9px;padding:9px 0;border-top:1px solid ' + t.bd + '">' +
          '<div style="width:8px;height:8px;border-radius:50%;background:' + Tn.c + ';flex-shrink:0;box-shadow:0 0 6px ' + Tn.c + '"></div>' +
          '<div style="flex:1;min-width:0"><div style="color:' + t.t1 + ';font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(r.userName || r.username || ("user #" + r.userId)) + '</div><div style="color:' + t.t3 + ';font-size:10.5px">' + esc(r.leagueName) + ' · ' + fmtN(r.amount) + ' QNTM</div></div>' +
          '<div style="font-size:11px;font-weight:700;text-align:right;flex-shrink:0">' + when + '</div></div>';
      }).join("");
      var recentBlock =
        '<div style="border-radius:18px;padding:6px 15px 14px;background:' + t.cd + ';border:1px solid ' + t.bd + '"><div style="color:' + t.t2 + ';font-size:12px;font-weight:800;letter-spacing:.4px;margin:12px 0 2px">Recent rituals</div>' +
        (rows || '<div style="color:' + t.t4 + ';font-size:12px;text-align:center;padding:20px 0">No rituals yet</div>') + '</div>';

      body.innerHTML = stats + chart + perLeagueBlock + recentBlock;
    }).catch(function (e) {
      body.innerHTML = '<div style="text-align:center;color:#ff6b6b;padding:30px 12px">' + esc((e && (e.message || e.error)) || "Could not load oversight") + '</div>';
    });
  }

  // ── realtime: welcome event ───────────────────────────────────────────────
  function onSocket(sock) {
    if (!sock || sock._dqLeaguesBound) return;
    sock._dqLeaguesBound = true;
    sock.on("league_unlocked", function (u) {
      try { celebrate(u.leagueName, u.leagueId); } catch (e) {}
      if (_curRender && document.getElementById("dqlg-overlay")) _curRender();
    });
  }

  // ── profile card (injected into the wrapped openProfile) ──────────────────
  function buildProfileCard() {
    var card = ce("div"); card.id = "dq-lg-card";
    card.style.cssText = "position:relative;overflow:hidden;display:flex;align-items:center;gap:13px;padding:14px;border-radius:18px;background:" + t.cd + ";border:1px solid " + t.bd + ";margin-bottom:12px;cursor:pointer";
    card.innerHTML = '<div id="dq-lg-card-gem">' + gem(1, 44, true) + '</div>' +
      '<div style="flex:1;min-width:0"><div style="color:' + t.t3 + ';font-size:10px;letter-spacing:1.2px;font-weight:800;text-transform:uppercase">League</div>' +
      '<div id="dq-lg-card-name" style="color:' + t.t1 + ';font-size:16px;font-weight:800">Ascension</div>' +
      '<div id="dq-lg-card-sub" style="color:' + t.pr + ';font-size:11.5px;font-weight:600">Tap to view your path</div></div>' +
      '<span style="color:' + t.t4 + ';flex-shrink:0">' + ic('<polyline points="9 18 15 12 9 6"/>', 18) + '</span>';
    card.onclick = function () { open(); };
    // hydrate
    api("/leagues/me").then(function (me) {
      var g = card.querySelector("#dq-lg-card-gem"), nm = card.querySelector("#dq-lg-card-name"), sb = card.querySelector("#dq-lg-card-sub");
      if (g) g.innerHTML = gem(me.currentLeagueId || 1, 44, !me.currentLeagueId);
      if (nm) nm.textContent = me.currentLeagueName || "Unranked";
      if (sb) {
        if (me.activeRitual) {
          var dd = breakdown((me.activeRitual.secondsRemaining || 0));
          sb.innerHTML = '<span style="color:#f5c451">⏳ Ascending · ' + dd.d + 'd ' + pad(dd.h) + 'h left</span>';
        } else {
          sb.textContent = "Tap to begin your ascension";
        }
      }
    }).catch(function () {});
    return card;
  }

  // ── wrap host globals (no template edits needed) ──────────────────────────
  function wrapHostGlobals() {
    if (typeof window.openProfile === "function" && !window.openProfile._dqLeaguesWrapped) {
      var _op = window.openProfile;
      window.openProfile = function () {
        var r = _op.apply(this, arguments);
        setTimeout(function () {
          try {
            var save = document.getElementById("pp-save");
            if (save && save.parentNode && !document.getElementById("dq-lg-card")) {
              save.parentNode.insertBefore(buildProfileCard(), save);
            }
          } catch (e) {}
        }, 0);
        return r;
      };
      window.openProfile._dqLeaguesWrapped = true;
    }
    if (typeof window.connectSocket === "function" && !window.connectSocket._dqLeaguesWrapped) {
      var _cs = window.connectSocket;
      window.connectSocket = function () {
        var r = _cs.apply(this, arguments);
        try { if (typeof S !== "undefined" && S.socket) onSocket(S.socket); } catch (e) {}
        return r;
      };
      window.connectSocket._dqLeaguesWrapped = true;
    }
  }

  // expose + initialise
  window.dqLeagues = { open: open, openAdmin: openAdmin, onSocket: onSocket, refresh: function () { if (_curRender) _curRender(); } };
  wrapHostGlobals();
  // If the socket was already created before this module loaded, bind now.
  try { if (typeof S !== "undefined" && S.socket) onSocket(S.socket); } catch (e) {}
  // Re-attempt the wrap shortly after load in case of ordering quirks.
  setTimeout(wrapHostGlobals, 1200);
})();
