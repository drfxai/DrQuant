/* ============================================================================
   DrFX Quant — /signals feed overlay  (window.openSignalsFeed)
   ----------------------------------------------------------------------------
   Loaded in the browser as /signals-feed.js. A full-screen overlay (same idiom
   as openMarket / openLiveTrading) with two segments:

     • Published       GET /api/signals           (operator + TradingView webhook,
                                                    read from the authoritative table)
     • Auto-detected   GET /api/signals/detected   (derived, non-persistent, scanned
                                                    from chats you're a member of)

   Wired to the "Signals" bottom-nav tab (previously mis-pointed at Live Trading).

   Page globals reused: api, t, esc, ic, S, fmtTime, openChat, showToast.
   ========================================================================== */
(function () {
  "use strict";

  var ST = { tab: "published", published: null, detected: null, scoreboard: null, sbView: "channels", loading: false };

  function fmtN(v) {
    if (v == null || v === "") return "";
    var n = Number(v);
    return isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 8 }) : String(v);
  }
  function sideColor(side) {
    side = String(side || "").toLowerCase();
    if (side === "buy" || side === "long") return "#34d27a";
    if (side === "sell" || side === "short") return "#ef4444";
    return t.ac; // close / alert / neutral
  }
  function spinner() {
    return '<div style="display:flex;justify-content:center;padding:48px 0"><div style="width:28px;height:28px;border:3px solid ' + t.bd + ';border-top-color:' + t.pr + ';border-radius:50%;animation:dqspin .8s linear infinite"></div></div>';
  }
  function emptyBox(title, sub) {
    return '<div style="text-align:center;padding:54px 24px;color:' + t.t3 + '">' +
      '<div style="opacity:.5;margin-bottom:12px;display:flex;justify-content:center;color:' + t.t4 + '">' + ic('<path d="M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 20V4"/>', 40) + '</div>' +
      '<div style="color:' + t.t1 + ';font-weight:700;font-size:16px">' + esc(title) + '</div>' +
      (sub ? '<div style="color:' + t.t3 + ';font-size:13px;margin-top:6px;max-width:300px;margin-left:auto;margin-right:auto;line-height:1.5">' + esc(sub) + '</div>' : '') +
      '</div>';
  }
  function failBox(msg) {
    return '<div style="text-align:center;padding:48px 24px;color:#ff9b94"><div style="margin-bottom:10px;display:flex;justify-content:center;color:#ef4444">' + ic('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', 28) + '</div><div style="font-size:13.5px">' + esc(msg) + '</div></div>';
  }
  function priceRow(label, val, col) {
    if (val == null) return "";
    return '<div style="display:flex;flex-direction:column;gap:1px"><span style="font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;color:' + t.t4 + '">' + label + '</span>' +
      '<span style="font-size:13px;font-weight:700;font-family:ui-monospace,monospace;color:' + (col || t.t1) + '">' + esc(fmtN(val)) + '</span></div>';
  }

  // ── Published signal card (from the signals table) ────────────────────────
  function publishedCard(s) {
    var col = sideColor(s.side);
    var sideTxt = String(s.side || "").toUpperCase();
    var srcLabel = s.source === "webhook"
      ? "TradingView"
      : (s.author ? (s.author.name || ("@" + (s.author.username || ""))) : "Operator");
    var srcIcon = s.source === "webhook"
      ? ic('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>', 12)
      : ic('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', 12);
    var chan = s.channel
      ? '<span class="sf-openchat" data-cid="' + (s.channel.is_member ? s.channel.id : "") + '" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:' + (s.channel.is_member ? t.ac : t.t4) + ';' + (s.channel.is_member ? 'cursor:pointer' : '') + '">' +
        ic('<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>', 11) +
        esc(s.channel.name || s.channel.username || "channel") + '</span>'
      : '';
    var meta = [];
    if (s.timeframe) meta.push("TF " + esc(s.timeframe));
    if (s.strategy) meta.push(esc(s.strategy));

    return '<div style="border:1px solid ' + t.bd + ';border-radius:15px;background:' + t.cd + ';overflow:hidden;margin-bottom:11px">' +
      '<div style="height:3px;background:' + col + '"></div>' +
      '<div style="padding:12px 14px">' +
        '<div style="display:flex;align-items:center;gap:9px;margin-bottom:10px">' +
          '<span style="font-size:11px;font-weight:800;letter-spacing:.5px;color:#fff;background:' + col + ';padding:3px 9px;border-radius:7px">' + sideTxt + '</span>' +
          '<span style="font-size:16px;font-weight:800;color:' + t.t1 + ';font-family:ui-monospace,monospace">' + esc(s.symbol) + '</span>' +
          '<span style="flex:1"></span>' +
          '<span style="font-size:11px;color:' + t.t4 + '">' + esc(fmtTime(s.created_at)) + '</span>' +
        '</div>' +
        ((s.price != null || s.stop_loss != null || s.take_profit != null)
          ? '<div style="display:flex;gap:22px;flex-wrap:wrap;margin-bottom:10px">' +
              priceRow("Entry", s.price, t.t1) + priceRow("Stop loss", s.stop_loss, "#ef4444") + priceRow("Take profit", s.take_profit, "#34d27a") +
            '</div>'
          : '') +
        (s.note ? '<div style="color:' + t.t2 + ';font-size:12.5px;line-height:1.5;margin-bottom:10px;white-space:pre-wrap;word-break:break-word">' + esc(s.note) + '</div>' : '') +
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:9px;border-top:1px solid ' + t.bd + '">' +
          '<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:' + t.t3 + '"><span style="display:inline-flex;color:' + t.t4 + '">' + srcIcon + '</span>' + esc(srcLabel) + '</span>' +
          chan +
          (meta.length ? '<span style="flex:1"></span><span style="font-size:11px;color:' + t.t4 + '">' + meta.join(" · ") + '</span>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // ── Auto-detected card (derived) ──────────────────────────────────────────
  function detectedCard(d) {
    var s = d.signal || {};
    var up = s.direction === "long";
    var col = up ? "#34d27a" : "#ef4444";
    var det = s.level === "detected";
    var conf = Math.round((s.confidence || 0) * 100);
    return '<div class="sf-openchat" data-cid="' + d.chat_id + '" style="border:1px solid ' + col + '33;border-radius:15px;background:' + t.cd + ';overflow:hidden;margin-bottom:11px;cursor:pointer">' +
      '<div style="padding:12px 14px">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:9px">' +
          '<span style="font-size:11px;font-weight:800;letter-spacing:.4px;color:' + col + '">' + (up ? "LONG" : "SHORT") + '</span>' +
          '<span style="font-size:15px;font-weight:800;color:' + t.t1 + ';font-family:ui-monospace,monospace">' + esc(s.symbol) + '</span>' +
          (s.entry != null ? '<span style="font-size:12px;color:' + t.t2 + ';font-family:ui-monospace,monospace">@ ' + esc(fmtN(s.entry)) + '</span>' : '') +
          '<span style="flex:1"></span>' +
          '<span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;white-space:nowrap;color:' + (det ? col : t.t3) + ';background:' + (det ? col + '1f' : t.ta) + ';padding:2px 7px;border-radius:6px">' + (det ? "Detected" : "Possible") + ' · ' + conf + '%</span>' +
        '</div>' +
        ((s.sl != null || s.tp != null)
          ? '<div style="display:flex;gap:22px;flex-wrap:wrap;margin-bottom:9px">' + priceRow("Stop loss", s.sl, "#ef4444") + priceRow("Take profit", s.tp, "#34d27a") + '</div>'
          : '') +
        '<div style="font-size:12px;color:' + t.t3 + ';line-height:1.5;background:' + t.inp + ';border:1px solid ' + t.bd + ';border-radius:9px;padding:7px 10px;white-space:pre-wrap;word-break:break-word;margin-bottom:9px">' + esc(d.text || "") + '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:' + t.t4 + '">' +
          '<span>' + esc((d.author && (d.author.name || ("@" + (d.author.username || "")))) || "user") + '</span>' +
          '<span>·</span>' +
          '<span style="color:' + t.ac + '">' + esc((d.chat && (d.chat.name || ("@" + (d.chat.username || "")))) || "chat") + '</span>' +
          '<span style="flex:1"></span>' +
          '<span>' + esc(fmtTime(d.created_at)) + '</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function renderBody(ov) {
    var body = ov.querySelector("#sf-body");
    if (!body) return;
    if (ST.tab === "published") {
      if (ST.published == null) { body.innerHTML = spinner(); return; }
      if (!ST.published.length) { body.innerHTML = emptyBox("No published signals yet", "Operator and TradingView signals will appear here."); return; }
      body.innerHTML = '<div style="max-width:640px;margin:0 auto">' + ST.published.map(publishedCard).join("") + '</div>';
    } else if (ST.tab === "scoreboard") {
      if (ST.scoreboard == null) { body.innerHTML = spinner(); return; }
      body.innerHTML = '<div style="max-width:680px;margin:0 auto">' + scoreboardHTML(ST.scoreboard) + '</div>';
      body.querySelectorAll(".sb-chip").forEach(function (el) { el.onclick = function () { ST.sbView = el.dataset.sb; renderBody(ov); }; });
      return;
    } else {
      if (ST.detected == null) { body.innerHTML = spinner(); return; }
      var intro = '<div style="max-width:640px;margin:0 auto 12px;color:' + t.t4 + ';font-size:11.5px;line-height:1.5;display:flex;gap:8px;align-items:flex-start">' +
        '<span style="display:inline-flex;flex-shrink:0;color:' + t.t3 + '">' + ic('<circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>', 14) + '</span>' +
        '<span>Platform-detected from recent messages in chats you\'re in. Advisory only — interpretations, not the authors\' words, and not financial advice.</span></div>';
      if (!ST.detected.length) { body.innerHTML = intro + emptyBox("Nothing detected recently", "When members post trade calls in your channels, they show up here."); return; }
      body.innerHTML = intro + '<div style="max-width:640px;margin:0 auto">' + ST.detected.map(detectedCard).join("") + '</div>';
    }
    // open-source-chat taps
    body.querySelectorAll(".sf-openchat").forEach(function (el) {
      el.onclick = function (e) {
        e.stopPropagation();
        var cid = parseInt(el.dataset.cid, 10);
        if (!cid) return;
        var ov2 = document.getElementById("sigfeed-ov");
        if (ov2) ov2.remove();
        if (typeof openChat === "function") openChat(cid);
      };
    });
  }

  function loadPublished(ov, force) {
    if (ST.published != null && !force) { renderBody(ov); return; }
    renderBody(ov);
    api("/signals?limit=60").then(function (d) {
      ST.published = (d && d.signals) || [];
      if (document.getElementById("sigfeed-ov")) renderBody(ov);
    }).catch(function (e) {
      ST.published = [];
      var body = ov.querySelector("#sf-body"); if (body) body.innerHTML = failBox((e && e.error) || "Could not load signals");
    });
  }
  function loadDetected(ov, force) {
    if (ST.detected != null && !force) { renderBody(ov); return; }
    renderBody(ov);
    api("/signals/detected").then(function (d) {
      ST.detected = (d && d.detected) || [];
      if (document.getElementById("sigfeed-ov")) renderBody(ov);
    }).catch(function (e) {
      ST.detected = [];
      var body = ov.querySelector("#sf-body"); if (body) body.innerHTML = failBox((e && e.error) || "Could not derive signals");
    });
  }
  function winColor(v) { if (v == null) return t.t4; if (v >= 60) return "#34d27a"; if (v >= 40) return "#f5a623"; return "#ef4444"; }

  // One leaderboard table (channels / symbols / timeframes / combos share this).
  function sbTable(rows, nameLabel) {
    if (!rows || !rows.length) return emptyBox("No data yet", "Rows show up here once signals are detected and priced.");
    var head = '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:' + t.t4 + ';border-bottom:1px solid ' + t.bd + '">' +
      '<span style="width:20px;flex-shrink:0">#</span>' +
      '<span style="flex:1;min-width:0">' + esc(nameLabel) + '</span>' +
      '<span style="width:58px;text-align:right">Win%</span>' +
      '<span style="width:54px;text-align:right">W\u2013L</span>' +
      '<span style="width:60px;text-align:right">Signals</span></div>';
    var rowsHtml = rows.map(function (r, i) {
      var wc = winColor(r.win_rate);
      var wr = r.win_rate == null ? "\u2014" : (r.win_rate + "%");
      var bar = r.win_rate == null ? 0 : Math.max(2, Math.min(100, r.win_rate));
      var openTag = r.open ? ' <span style="color:' + t.t4 + ';font-size:10px">(' + r.open + ' open)</span>' : '';
      return '<div style="display:flex;align-items:center;gap:8px;padding:9px 10px;border-bottom:1px solid ' + t.bd + '">' +
        '<span style="width:20px;flex-shrink:0;color:' + t.t4 + ';font-size:12px;font-weight:700">' + (i + 1) + '</span>' +
        '<span style="flex:1;min-width:0">' +
          '<span style="display:block;color:' + t.t1 + ';font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(r.label) + '</span>' +
          '<span style="display:block;height:3px;margin-top:4px;border-radius:2px;background:' + t.bd + '"><span style="display:block;height:3px;border-radius:2px;width:' + bar + '%;background:' + wc + '"></span></span>' +
        '</span>' +
        '<span style="width:58px;text-align:right;color:' + wc + ';font-weight:800;font-size:13px">' + wr + '</span>' +
        '<span style="width:54px;text-align:right;color:' + t.t2 + ';font-size:12px;font-family:ui-monospace,monospace">' + r.wins + '\u2013' + r.losses + '</span>' +
        '<span style="width:60px;text-align:right;color:' + t.t3 + ';font-size:12px">' + r.total + openTag + '</span>' +
      '</div>';
    }).join("");
    return '<div style="border:1px solid ' + t.bd + ';border-radius:13px;background:' + t.cd + ';overflow:hidden">' + head + rowsHtml + '</div>';
  }

  function scoreboardHTML(data) {
    var st = data.stats || {};
    var views = [["channels", "Channels"], ["symbols", "Symbols"], ["timeframes", "Timeframes"], ["combos", "Symbol \u00d7 TF"]];
    var chips = views.map(function (p) {
      var on = ST.sbView === p[0];
      return '<button class="sb-chip" data-sb="' + p[0] + '" style="flex-shrink:0;padding:6px 13px;border-radius:11px;border:1px solid ' + (on ? t.ba : t.bd) + ';background:' + (on ? t.act : "transparent") + ';color:' + (on ? t.ac : t.t3) + ';font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap">' + p[1] + '</button>';
    }).join("");
    var tbl, cap = "";
    if (ST.sbView === "symbols") { tbl = sbTable(data.symbols, "Symbol"); }
    else if (ST.sbView === "timeframes") { tbl = sbTable(data.timeframes, "Timeframe"); }
    else if (ST.sbView === "combos") { tbl = sbTable(data.symbol_timeframe, "Symbol \u00d7 Timeframe"); cap = "Highest target / success rate first."; }
    else { tbl = sbTable(data.channels, "Channel"); cap = "Ranked best \u2192 worst by win rate."; }
    var statLine = '<div style="display:flex;flex-wrap:wrap;gap:10px 16px;font-size:11.5px;color:' + t.t3 + ';margin-bottom:10px">' +
      '<span><b style="color:' + t.t1 + '">' + (st.total_signals || 0) + '</b> signals</span>' +
      '<span style="color:#34d27a"><b>' + (st.wins || 0) + '</b> wins</span>' +
      '<span style="color:#ef4444"><b>' + (st.losses || 0) + '</b> losses</span>' +
      '<span><b style="color:' + t.t1 + '">' + (st.open || 0) + '</b> open</span>' +
      '<span><b style="color:' + t.t1 + '">' + (st.symbols_priced || 0) + '</b> priced</span></div>';
    var warn = (st.decided || 0) === 0
      ? '<div style="font-size:11.5px;line-height:1.5;color:#f5c451;background:rgba(245,166,35,.1);border:1px solid rgba(245,166,35,.25);border-radius:10px;padding:9px 11px;margin-bottom:12px">No outcomes resolved yet. Win rates fill in once live prices cross a signal\u2019s TP or SL \u2014 make sure a price feed is active (a TradingView price alert pointed at /api/webhooks/price, or PRICE_FEED_BINANCE=on for crypto).</div>'
      : '';
    var capHtml = cap ? '<div style="font-size:11px;color:' + t.t4 + ';margin:10px 2px 8px">' + cap + '</div>' : '';
    return statLine + warn + '<div style="display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px">' + chips + '</div>' + capHtml + tbl;
  }

  function loadScoreboard(ov, force) {
    if (ST.scoreboard != null && !force) { renderBody(ov); return; }
    renderBody(ov);
    api("/signals/scoreboard").then(function (d) {
      ST.scoreboard = d || {};
      if (document.getElementById("sigfeed-ov")) renderBody(ov);
    }).catch(function (e) {
      var body = ov.querySelector("#sf-body"); if (body) body.innerHTML = failBox((e && e.error) || "Could not load scoreboard");
    });
  }

  function loadActive(ov, force) {
    if (ST.tab === "published") loadPublished(ov, force);
    else if (ST.tab === "scoreboard") loadScoreboard(ov, force);
    else loadDetected(ov, force);
  }

  function setTab(ov, tab) {
    ST.tab = tab;
    ov.querySelectorAll(".sf-seg").forEach(function (b) {
      var on = b.dataset.seg === tab;
      b.style.background = on ? t.act : "transparent";
      b.style.color = on ? t.ac : t.t3;
      b.style.borderColor = on ? t.ba : t.bd;
    });
    loadActive(ov, false);
  }

  function open() {
    var prev = document.getElementById("sigfeed-ov");
    if (prev) prev.remove();
    // fresh state each open so the feed is current
    ST = { tab: "published", published: null, detected: null, scoreboard: null, sbView: "channels", loading: false };

    var ov = document.createElement("div");
    ov.id = "sigfeed-ov";
    ov.style.cssText = "position:fixed;inset:0;z-index:5000;background:" + t.bg + ";display:flex;flex-direction:column;animation:fi .2s;padding-top:var(--sat);padding-bottom:var(--sab);padding-left:var(--sal);padding-right:var(--sar)";

    var seg = function (id, label) {
      var on = ST.tab === id;
      return '<button class="sf-seg" data-seg="' + id + '" style="flex:1;padding:9px 12px;border-radius:11px;border:1px solid ' + (on ? t.ba : t.bd) + ';background:' + (on ? t.act : "transparent") + ';color:' + (on ? t.ac : t.t3) + ';font-size:13px;font-weight:700;font-family:Outfit,sans-serif;cursor:pointer">' + label + '</button>';
    };

    ov.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:' + t.ch + ';-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);border-bottom:1px solid ' + t.bd + ';flex-shrink:0">' +
        '<button id="sf-back" style="width:36px;height:36px;border-radius:10px;border:1px solid ' + t.bd + ';background:' + t.btn + ';color:' + t.t1 + ';cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px">\u2190</button>' +
        '<div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">' +
          '<span style="display:inline-flex;color:' + t.pr + '">' + ic('<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>', 20) + '</span>' +
          '<span style="color:' + t.t1 + ';font-weight:800;font-size:17px">Signals</span>' +
        '</div>' +
        '<button id="sf-refresh" style="width:36px;height:36px;border-radius:10px;border:1px solid ' + t.bd + ';background:' + t.btn + ';color:' + t.t2 + ';cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0">' + ic('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>', 18) + '</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;padding:10px 14px;background:' + t.ch + ';border-bottom:1px solid ' + t.bd + ';flex-shrink:0">' + seg("published", "Published") + seg("detected", "Auto-detected") + seg("scoreboard", "Scoreboard") + '</div>' +
      '<div id="sf-body" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px"></div>';

    document.body.appendChild(ov);
    ov.querySelector("#sf-back").onclick = function () { ov.remove(); };
    ov.querySelector("#sf-refresh").onclick = function () { loadActive(ov, true); };
    ov.querySelectorAll(".sf-seg").forEach(function (b) { b.onclick = function () { setTab(ov, b.dataset.seg); }; });

    loadActive(ov, false);
  }

  if (typeof window !== "undefined") window.openSignalsFeed = open;
})();
