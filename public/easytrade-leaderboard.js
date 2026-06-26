/* ============================================================================
 * easytrade-leaderboard.js — "Top Traders" board for Easy Trade.
 * ----------------------------------------------------------------------------
 * Self-contained SPA module. Loads as a plain <script> after index.html's main
 * script and reuses its globals (t, S, api, esc, ce, avatar, showToast). Exposes:
 *
 *     window.dqEtLeaderboard = { open }
 *
 * Reached from the sidebar ("Top Traders"). Ranks players four ways, switchable
 * by tab, all from the same backend payload:
 *     GET /api/easytrade/leaderboard?sort=xp|winrate|wins|tokens
 *       -> { sort, minSettled, players:[{rank,userId,name,username,avatar,
 *            wins,losses,settled,tokensWon,net,xp,winRate,...}], me|null }
 * ========================================================================== */
(function () {
  "use strict";
  if (window.dqEtLeaderboard) return;

  var TABS = [
    { key: "xp",      label: "XP" },
    { key: "winrate", label: "Win rate" },
    { key: "wins",    label: "Wins" },
    { key: "tokens",  label: "Tokens" }
  ];
  var RANKC = { 1: "#FFD700", 2: "#cdd6e6", 3: "#d98a4a" };

  function fmtN(n) { n = Number(n) || 0; return n.toLocaleString("en-US"); }
  function nameOf(p) { return p.name || (p.username ? "@" + p.username : null) || ("Trader #" + p.userId); }
  function metricRaw(p, sort) {
    return sort === "xp" ? p.xp : sort === "winrate" ? p.winRate : sort === "wins" ? p.wins : p.tokensWon;
  }
  function metricStr(p, sort) { return sort === "winrate" ? (p.winRate + "%") : fmtN(metricRaw(p, sort)); }
  function metricLabel(sort) { return sort === "xp" ? "XP" : sort === "winrate" ? "Win rate" : sort === "wins" ? "Wins" : "QNTM won"; }

  // small inline glyphs
  function glyph(kind, size, col) {
    var s = size || 14, c = col || "currentColor";
    var p = kind === "xp" ? '<path d="M13 2 4 14h6l-1 8 9-12h-6z" fill="' + c + '"/>'
      : kind === "winrate" ? '<circle cx="12" cy="12" r="9" fill="none" stroke="' + c + '" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="' + c + '" stroke-width="2"/><circle cx="12" cy="12" r="1" fill="' + c + '"/>'
      : kind === "wins" ? '<circle cx="12" cy="8" r="6" fill="none" stroke="' + c + '" stroke-width="2"/><path d="M15.5 12.5 17 22l-5-3-5 3 1.5-9.5" fill="none" stroke="' + c + '" stroke-width="2" stroke-linejoin="round"/>'
      : '<circle cx="12" cy="12" r="9" fill="none" stroke="' + c + '" stroke-width="2"/><path d="M9.5 9.5h3.2a2 2 0 0 1 0 4H10m0 0 3.5 4M10 8v9" fill="none" stroke="' + c + '" stroke-width="1.8" stroke-linecap="round"/>';
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24">' + p + '</svg>';
  }

  var _sort = "xp", _bodyRef = null;

  function ensureCSS() {
    if (document.getElementById("dqet-lb-css")) return;
    var s = document.createElement("style"); s.id = "dqet-lb-css";
    s.textContent =
      "@keyframes dqetUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}" +
      "@keyframes dqetPop{0%{opacity:0;transform:scale(.9)}100%{opacity:1;transform:scale(1)}}" +
      "@keyframes dqetGlow{0%,100%{box-shadow:0 0 0 0 rgba(255,215,0,.0)}50%{box-shadow:0 0 22px 2px rgba(255,215,0,.28)}}" +
      ".dqet-row{animation:dqetUp .35s ease both}" +
      ".dqet-scroll::-webkit-scrollbar{width:6px}.dqet-scroll::-webkit-scrollbar-thumb{background:rgba(120,160,255,.2);border-radius:3px}";
    document.head.appendChild(s);
  }

  function overlay() {
    ensureCSS();
    var ex = document.getElementById("dqet-lb"); if (ex) ex.remove();
    var ov = ce("div"); ov.id = "dqet-lb";
    ov.style.cssText = "position:fixed;inset:0;z-index:10000;background:" + t.bg + ";display:flex;flex-direction:column;animation:dqetUp .25s ease";
    var bar = ce("div");
    bar.style.cssText = "display:flex;align-items:center;gap:10px;padding:calc(var(--sat,0px) + 11px) 14px 11px;background:" + t.p + ";backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border-bottom:1px solid " + t.bd + ";flex-shrink:0";
    bar.innerHTML = '<span style="display:flex;color:#FFD700;filter:drop-shadow(0 0 8px rgba(255,215,0,.4))">' +
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg></span>' +
      '<div style="line-height:1.1"><div style="font-weight:800;color:' + t.t1 + ';font-size:16px">Top Traders</div><div style="color:' + t.t3 + ';font-size:11px">Easy Trade leaderboard</div></div>';
    var sp = ce("div"); sp.style.flex = "1"; bar.appendChild(sp);
    var cls = ce("button"); cls.type = "button"; cls.setAttribute("aria-label", "Close");
    cls.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    cls.style.cssText = "width:38px;height:38px;border-radius:50%;border:1px solid " + t.bd + ";background:" + t.cd + ";color:" + t.t2 + ";cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0";
    cls.onclick = function () { ov.remove(); };
    bar.appendChild(cls);

    // sort tabs
    var tabs = ce("div");
    tabs.style.cssText = "display:flex;gap:6px;padding:11px 12px 4px;flex-shrink:0;overflow-x:auto;-webkit-overflow-scrolling:touch";
    TABS.forEach(function (tb) {
      var b = ce("button"); b.type = "button"; b.dataset.k = tb.key;
      var on = tb.key === _sort;
      b.innerHTML = '<span style="display:flex">' + glyph(tb.key, 14) + '</span>' + tb.label;
      b.style.cssText = "display:inline-flex;align-items:center;gap:6px;white-space:nowrap;padding:9px 15px;border-radius:12px;border:1px solid " + (on ? t.ba : t.bd) + ";background:" + (on ? t.act : "transparent") + ";color:" + (on ? t.ac : t.t3) + ";font-size:13px;font-weight:700;cursor:pointer;font-family:'Outfit',sans-serif;flex-shrink:0";
      b.onclick = function () { if (_sort === tb.key) return; _sort = tb.key; renderBody(); };
      tabs.appendChild(b);
    });

    var body = ce("div"); body.className = "dqet-scroll";
    body.style.cssText = "flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:10px 14px calc(var(--sab,0px) + 26px)";
    ov.appendChild(bar); ov.appendChild(tabs); ov.appendChild(body);
    document.body.appendChild(ov);
    _bodyRef = body;
    return body;
  }

  function podium(players, sort) {
    // order for display: 2nd, 1st, 3rd (center elevated)
    var top = players.slice(0, 3);
    var slots = [top[1], top[0], top[2]];
    var heights = [96, 122, 80], av = [58, 72, 52];
    var cells = slots.map(function (p, i) {
      if (!p) return '<div style="flex:1"></div>';
      var place = (i === 0) ? 2 : (i === 1) ? 1 : 3;
      var col = RANKC[place];
      var crown = place === 1 ? '<div style="position:absolute;top:-20px;left:50%;transform:translateX(-50%);color:#FFD700;filter:drop-shadow(0 2px 4px rgba(0,0,0,.4))"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M3 7l4 4 5-7 5 7 4-4-2 13H5z"/></svg></div>' : '';
      return '<div class="dqet-row" style="flex:1;display:flex;flex-direction:column;align-items:center;animation-delay:' + (i * 0.05) + 's">' +
        '<div style="position:relative;margin-bottom:8px' + (place === 1 ? ';animation:dqetGlow 2.4s ease-in-out infinite;border-radius:50%' : '') + '">' + crown +
          '<div style="border-radius:50%;padding:3px;background:linear-gradient(135deg,' + col + ',' + col + '66);box-shadow:0 6px 20px ' + col + '55">' + avatar(p.avatar || "💬", av[i]) + '</div>' +
          '<div style="position:absolute;bottom:-6px;left:50%;transform:translateX(-50%);width:22px;height:22px;border-radius:50%;background:' + col + ';color:#0a1024;font-weight:800;font-size:12px;display:flex;align-items:center;justify-content:center;border:2px solid ' + t.mod + '">' + place + '</div>' +
        '</div>' +
        '<div style="color:' + t.t1 + ';font-size:13px;font-weight:700;max-width:96px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px">' + esc(nameOf(p)) + '</div>' +
        '<div style="color:' + col + ';font-size:16px;font-weight:800;margin-top:1px">' + metricStr(p, sort) + '</div>' +
        '<div style="color:' + t.t4 + ';font-size:10px">' + metricLabel(sort) + '</div>' +
        '<div style="width:74%;height:' + heights[i] / 2 + 'px;margin-top:8px;border-radius:10px 10px 0 0;background:linear-gradient(180deg,' + col + '33,' + col + '08);border:1px solid ' + col + '33;border-bottom:none"></div>' +
      '</div>';
    }).join("");
    return '<div style="display:flex;align-items:flex-end;gap:8px;padding:22px 4px 0;margin-bottom:8px">' + cells + '</div>';
  }

  function statPill(active, kind, value, label) {
    var col = active ? t.ac : t.t3;
    return '<div style="display:flex;flex-direction:column;align-items:center;gap:1px;min-width:46px">' +
      '<div style="display:flex;align-items:center;gap:3px;color:' + col + ';font-size:13px;font-weight:' + (active ? 800 : 600) + '"><span style="display:flex;opacity:.85">' + glyph(kind, 12, col) + '</span>' + value + '</div>' +
      '<div style="color:' + t.t4 + ';font-size:9px;letter-spacing:.3px">' + label + '</div></div>';
  }

  function listRow(p, sort, isMe) {
    var rc = RANKC[p.rank] || null;
    var rankBadge = rc
      ? '<div style="width:26px;height:26px;border-radius:8px;background:' + rc + ';color:#0a1024;font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0">' + p.rank + '</div>'
      : '<div style="width:26px;text-align:center;color:' + t.t3 + ';font-weight:700;font-size:14px;flex-shrink:0">' + p.rank + '</div>';
    return '<div class="dqet-row" style="display:flex;align-items:center;gap:11px;padding:11px 12px;border-radius:15px;margin-bottom:8px;background:' + (isMe ? t.act : t.cd) + ';border:1px solid ' + (isMe ? t.ba : t.bd) + '">' +
      rankBadge + avatar(p.avatar || "💬", 40) +
      '<div style="flex:1;min-width:0"><div style="color:' + t.t1 + ';font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(nameOf(p)) + (isMe ? ' <span style="color:' + t.ac + ';font-size:11px;font-weight:700">· you</span>' : '') + '</div>' +
        '<div style="color:' + t.t4 + ';font-size:11px;margin-top:1px">' + p.settled + ' settled · ' + (p.net >= 0 ? '<span style="color:#34d27a">+' + fmtN(p.net) + '</span>' : '<span style="color:#ff6b6b">' + fmtN(p.net) + '</span>') + ' QNTM net</div></div>' +
      '<div style="display:flex;gap:10px;align-items:center;flex-shrink:0">' +
        statPill(sort === "xp", "xp", fmtN(p.xp), "XP") +
        statPill(sort === "winrate", "winrate", p.winRate + "%", "Win") +
        statPill(sort === "wins", "wins", fmtN(p.wins), "Wins") +
        statPill(sort === "tokens", "tokens", fmtN(p.tokensWon), "QNTM") +
      '</div></div>';
  }

  function renderBody() {
    var body = _bodyRef; if (!body) return;
    // refresh tab styles
    var tabsWrap = body.parentNode.querySelectorAll("button[data-k]");
    tabsWrap.forEach(function (b) {
      var on = b.dataset.k === _sort;
      b.style.border = "1px solid " + (on ? t.ba : t.bd);
      b.style.background = on ? t.act : "transparent";
      b.style.color = on ? t.ac : t.t3;
    });
    body.innerHTML = '<div style="text-align:center;color:' + t.t3 + ';padding:46px 0;animation:dqetUp .4s ease">Tallying the board…</div>';
    api("/easytrade/leaderboard?limit=100&sort=" + _sort).then(function (d) {
      var players = d.players || [];
      if (!players.length) {
        body.innerHTML = '<div style="text-align:center;padding:46px 18px"><div style="font-size:42px;margin-bottom:10px">🏆</div>' +
          '<div style="color:' + t.t1 + ';font-size:17px;font-weight:700">No ranked traders yet</div>' +
          '<div style="color:' + t.t3 + ';font-size:13px;margin-top:6px;line-height:1.5">' + (_sort === "winrate" ? "Win-rate ranking needs at least 5 settled predictions." : "Play a few Easy Trade predictions to claim the top spot.") + '</div></div>' + meCard(d.me, players);
        return;
      }
      var pod = podium(players, _sort);
      var restStart = Math.min(3, players.length);
      var rest = players.slice(restStart);
      var listTitle = rest.length
        ? '<div style="display:flex;align-items:center;gap:8px;margin:14px 2px 10px"><span style="color:' + t.t2 + ';font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase">Ranked by ' + metricLabel(_sort) + '</span><div style="flex:1;height:1px;background:' + t.bd + '"></div></div>'
        : "";
      var myId = (S && S.user) ? S.user.id : null;
      var list = rest.map(function (p) { return listRow(p, _sort, p.userId === myId); }).join("");
      body.innerHTML = pod + listTitle + list + meCard(d.me, players);
    }).catch(function (e) {
      body.innerHTML = '<div style="text-align:center;color:#ff6b6b;padding:36px 14px">' + esc((e && (e.error || e.message)) || "Could not load the leaderboard") + '</div>';
    });
  }

  // "your standing" footer card
  function meCard(me, players) {
    var myId = (S && S.user) ? S.user.id : null;
    if (!me) {
      return '<div style="margin-top:16px;padding:15px;border-radius:16px;background:' + t.cd + ';border:1px dashed ' + t.bd + ';text-align:center">' +
        '<div style="color:' + t.t2 + ';font-size:13px">You haven\'t settled any predictions yet.</div>' +
        '<div style="color:' + t.t4 + ';font-size:11.5px;margin-top:3px">Make a few Easy Trade calls to join the board.</div></div>';
    }
    var myRank = null;
    for (var i = 0; i < players.length; i++) { if (players[i].userId === myId) { myRank = players[i].rank; break; } }
    var rankTxt = myRank ? "#" + myRank : "Unranked";
    return '<div style="position:sticky;bottom:0;margin-top:16px;padding:14px;border-radius:18px;background:linear-gradient(180deg,' + t.act + ',' + t.mod + ');border:1px solid ' + t.ba + ';box-shadow:0 -6px 24px rgba(0,0,0,.3);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)">' +
      '<div style="display:flex;align-items:center;gap:11px">' +
        '<div style="width:40px;text-align:center;color:' + t.ac + ';font-weight:800;font-size:15px">' + rankTxt + '</div>' +
        avatar((S.user && S.user.avatar) || "💬", 40) +
        '<div style="flex:1;min-width:0"><div style="color:' + t.t1 + ';font-size:14px;font-weight:700">Your standing</div><div style="color:' + t.t4 + ';font-size:11px;margin-top:1px">' + me.settled + ' settled · ' + (me.net >= 0 ? '<span style="color:#34d27a">+' + fmtN(me.net) + '</span>' : '<span style="color:#ff6b6b">' + fmtN(me.net) + '</span>') + ' QNTM net</div></div>' +
        '<div style="display:flex;gap:10px;align-items:center;flex-shrink:0">' +
          statPill(_sort === "xp", "xp", fmtN(me.xp), "XP") +
          statPill(_sort === "winrate", "winrate", me.winRate + "%", "Win") +
          statPill(_sort === "wins", "wins", fmtN(me.wins), "Wins") +
          statPill(_sort === "tokens", "tokens", fmtN(me.tokensWon), "QNTM") +
        '</div>' +
      '</div></div>';
  }

  function open() {
    overlay();
    renderBody();
  }

  window.dqEtLeaderboard = { open: open };
})();
