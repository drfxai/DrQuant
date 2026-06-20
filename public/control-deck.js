/* ============================================================================
 * DrFX Quant — native admin Control Deck
 * ----------------------------------------------------------------------------
 * Loaded by public/index.html (as /control-deck.js). Renders INSIDE the
 * full-screen #dq-cd-overlay shell that openControlDeck() builds, replacing the
 * old iframe. Admin-only: the overlay guards on S.user.role === "admin" and the
 * API enforces it server-side (non-admins get 403 at the mount).
 *
 * It reuses the page globals (classic scripts share one global scope):
 *   api(path,opts)  -> fetch "/api"+path with the bearer token; throws the
 *                      parsed JSON body on !ok.
 *   S, t, esc, ce, showToast
 *
 * It talks ONLY to endpoints the host actually mounts (server.js ->
 * mountQntmEconomy):
 *   GET  /qntm/admin/economy/summary
 *   GET  /qntm/admin/economy/ledger?type=&wallet=&userId=&limit=
 *   POST /qntm/admin/economy/grant         { toUserId, amount, reason }
 *   POST /qntm/admin/economy/reclaim       { fromUserId, amount, reason }
 *   POST /qntm/admin/economy/transfer-pool { fromPool, toPool, amount, reason }
 * Every write carries an Idempotency-Key and is gated by a "type CONFIRM" modal.
 * The ledger is the only source of truth; nothing here reads a cached balance.
 * ==========================================================================*/
(function () {
  "use strict";

  var POOLS = ["treasury", "reward_pool", "ecosystem", "community_reserve"];
  var POOL_ORDER = ["reward_pool", "treasury", "ecosystem", "team_vesting",
    "community_reserve", "burn", "escrow", "fee", "staking",
    "tournament_pool", "subscription_settlement", "genesis"];

  function amtq(a) { return (a && a.qntm != null) ? a.qntm : (a != null ? String(a) : "-"); }
  function num(s) { if (s == null || s === "") return "-"; var n = Number(s); return isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 6 }) : String(s); }
  function key(p) { return p + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8); }
  function when(d) { if (!d) return "-"; var x = new Date(d); return isNaN(x) ? String(d) : x.toLocaleString(); }
  function short(s) { s = String(s || ""); return s.length > 18 ? s.slice(0, 8) + "…" + s.slice(-5) : s; }
  function sCol(s) {
    if (s === "healthy" || s === "active") return "#34d27a";
    if (s === "low" || s === "not_configured") return "#f59e0b";
    if (s === "critical" || s === "frozen" || s === "closed") return "#ef4444";
    return t.t3;
  }
  function errMsg(e) { var m = (e && e.error && (e.error.message || e.error)) || (e && e.message) || "Action failed"; return typeof m === "string" ? m : JSON.stringify(m); }
  function toast(title, msg) { try { if (window.showToast) showToast(title, msg); } catch (_) {} }

  // ---- "type CONFIRM" gate, layered above the deck overlay (z 10002) --------
  function confirmGate(opts) {
    var sc = ce("div");
    sc.style.cssText = "position:fixed;inset:0;z-index:10002;background:rgba(2,5,16,.72);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:18px";
    var lines = (opts.lines || []).map(function (l) {
      return '<div style="display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:13px"><span style="color:' + t.t3 + '">' + esc(l.k) + '</span><span style="color:' + t.t1 + ';font-weight:700;font-family:ui-monospace,monospace;word-break:break-all;text-align:right">' + esc(l.v) + '</span></div>';
    }).join("");
    sc.innerHTML =
      '<div style="width:min(460px,100%);background:' + t.mod + ';border:1px solid ' + t.ba + ';border-radius:18px;box-shadow:' + t.sh + ';overflow:hidden">' +
        '<div style="padding:15px 18px;border-bottom:1px solid ' + t.bd + ';font-size:15px;font-weight:800;color:' + t.t1 + '">' + esc(opts.title || "Confirm") + '</div>' +
        '<div style="padding:16px 18px"><div style="background:' + t.inp + ';border:1px solid ' + t.bd + ';border-radius:12px;padding:12px;margin-bottom:14px">' + lines + '</div>' +
          '<div style="color:' + (opts.danger ? "#ff9b94" : t.t2) + ';font-size:12px;margin-bottom:6px">High-risk action. Type <b>CONFIRM</b> to proceed.</div>' +
          '<input id="cdcf" class="gi" placeholder="CONFIRM" autocomplete="off" style="font-family:ui-monospace,monospace"/></div>' +
        '<div style="padding:13px 18px;border-top:1px solid ' + t.bd + ';display:flex;justify-content:flex-end;gap:10px">' +
          '<button id="cdx" type="button" style="padding:9px 16px;border-radius:11px;border:1px solid ' + t.bd + ';background:transparent;color:' + t.t2 + ';font-weight:600;cursor:pointer;font-family:Outfit,sans-serif">Cancel</button>' +
          '<button id="cdgo" type="button" disabled style="padding:9px 16px;border-radius:11px;border:none;background:' + (opts.danger ? "#ef4444" : t.pr) + ';color:#fff;font-weight:700;cursor:pointer;opacity:.5;font-family:Outfit,sans-serif">Execute</button>' +
        '</div></div>';
    document.body.appendChild(sc);
    var inp = sc.querySelector("#cdcf"), go = sc.querySelector("#cdgo");
    setTimeout(function () { inp.focus(); }, 30);
    inp.oninput = function () { var ok = inp.value.trim().toUpperCase() === "CONFIRM"; go.disabled = !ok; go.style.opacity = ok ? "1" : ".5"; };
    sc.querySelector("#cdx").onclick = function () { sc.remove(); };
    go.onclick = async function () {
      go.disabled = true; go.textContent = "Working…";
      try { await opts.onConfirm(); sc.remove(); }
      catch (e) { go.disabled = false; go.textContent = "Execute"; alert(errMsg(e)); }
    };
  }

  // ---- small view builders --------------------------------------------------
  function sectionLabel(txt) {
    return '<div style="color:' + t.t2 + ';font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin:22px 2px 10px">' + esc(txt) + '</div>';
  }
  function poolCard(name, w) {
    var configured = w && w.configured !== false;
    var bal = configured ? num(amtq(w.balance)) : "—";
    var status = configured ? (w.status || "-") : "not configured";
    var col = sCol(status);
    var pct = (w && w.percentRemaining != null) ? (" · " + w.percentRemaining + "%") : "";
    var hi = (name === "reward_pool" || name === "treasury");
    return '<div style="background:' + t.cd + ';border:1px solid ' + (hi ? t.bl : t.bd) + ';border-radius:14px;padding:12px 13px;min-width:0">' +
      '<div style="color:' + t.t3 + ';font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(name) + '</div>' +
      '<div style="color:' + t.t1 + ';font-size:18px;font-weight:800;margin-top:5px;font-family:ui-monospace,monospace;word-break:break-all">' + esc(bal) + '</div>' +
      '<div style="margin-top:7px;display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:50%;background:' + col + ';flex-shrink:0"></span>' +
      '<span style="color:' + col + ';font-size:11px;font-weight:600">' + esc(status + pct) + '</span></div></div>';
  }
  function miniCard(label, val) {
    return '<div style="background:' + t.cd + ';border:1px solid ' + t.bd + ';border-radius:12px;padding:10px 12px">' +
      '<div style="color:' + t.t3 + ';font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.3px">' + esc(label) + '</div>' +
      '<div style="color:' + t.t1 + ';font-size:15px;font-weight:800;margin-top:3px;font-family:ui-monospace,monospace;word-break:break-all">' + esc(num(val)) + '</div></div>';
  }
  function opCard(inner) {
    return '<div style="background:' + t.cd + ';border:1px solid ' + t.bd + ';border-radius:16px;padding:14px">' + inner + '</div>';
  }
  function field(label, id, ph, mono) {
    return '<div style="margin-bottom:9px"><div style="color:' + t.t3 + ';font-size:11px;margin-bottom:4px">' + esc(label) + '</div>' +
      '<input id="' + id + '" class="gi" placeholder="' + esc(ph || "") + '" style="font-size:14px' + (mono ? ";font-family:ui-monospace,monospace" : "") + '"/></div>';
  }
  function poolSelect(id, def) {
    return '<select id="' + id + '" class="gi" style="font-size:14px">' +
      POOLS.map(function (p) { return '<option' + (p === def ? ' selected' : '') + '>' + p + '</option>'; }).join("") + '</select>';
  }
  function btn(id, label, danger) {
    return '<button id="' + id + '" type="button" style="width:100%;margin-top:4px;padding:11px;border-radius:12px;border:none;background:' + (danger ? "#ef4444" : t.pg) + ';color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:Outfit,sans-serif;box-shadow:0 4px 16px ' + (danger ? "rgba(239,68,68,.32)" : t.pgw) + '">' + esc(label) + '</button>';
  }
  function ledgerRow(m) {
    var src = m.source; if (src && src.length != null) src = src.length ? src[0] : null;
    var dst = (m.destinations && m.destinations.length) ? m.destinations[0] : null;
    var st = src ? (src.walletType + (src.ownerId ? (" #" + src.ownerId) : "")) : "-";
    var dt = dst ? (dst.walletType + (dst.ownerId ? (" #" + dst.ownerId) : "")) : "-";
    if (m.destinations && m.destinations.length > 1) dt += " (+" + (m.destinations.length - 1) + ")";
    return '<div style="padding:10px 12px;border-bottom:1px solid ' + t.bd + ';display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:140px"><div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">' +
        '<span style="font-size:11px;font-weight:700;color:' + t.ac + ';font-family:ui-monospace,monospace">' + esc(m.type) + '</span>' +
        '<span style="font-size:10px;color:' + t.t4 + '">' + esc(short(m.publicId)) + '</span></div>' +
        '<div style="color:' + t.t3 + ';font-size:11px;margin-top:3px">' + esc(st) + ' &rarr; ' + esc(dt) + '</div>' +
        '<div style="color:' + t.t4 + ';font-size:10px;margin-top:2px">' + esc(when(m.createdAt)) + (m.actorId ? (' · by #' + esc(m.actorId)) : '') + (m.reason ? (' · ' + esc(m.reason)) : '') + '</div></div>' +
      '<div style="text-align:right;font-family:ui-monospace,monospace;font-weight:800;color:' + t.t1 + ';font-size:14px;white-space:nowrap">' + esc(num(amtq(m.amount))) + ' <span style="color:' + t.t4 + ';font-size:10px">QNTM</span></div></div>';
  }

  // ---- loaders --------------------------------------------------------------
  async function loadSummary(root) {
    var warnBox = root.querySelector("#cd-warn");
    var pools = root.querySelector("#cd-pools");
    var circ = root.querySelector("#cd-circ");
    var emis = root.querySelector("#cd-emis");
    try {
      var d = await api("/qntm/admin/economy/summary");
      var warns = (d.health && d.health.warnings) || [];
      warnBox.innerHTML = warns.length
        ? '<div style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.32);border-radius:12px;padding:10px 13px;color:#e7c889;font-size:12.5px;margin-bottom:4px"><b>Warnings:</b> ' + warns.map(esc).join(" · ") + '</div>'
        : "";
      var sw = d.systemWallets || {}, seen = {}, html = "";
      POOL_ORDER.forEach(function (k) { if (sw[k]) { html += poolCard(k, sw[k]); seen[k] = 1; } });
      Object.keys(sw).forEach(function (k) { if (!seen[k]) html += poolCard(k, sw[k]); });
      pools.innerHTML = html || '<div style="color:' + t.t4 + ';font-size:12px;padding:8px">No system wallets.</div>';
      var ci = d.circulation || {};
      circ.innerHTML = miniCard("Held by users", amtq(ci.userBalancesTotal)) + miniCard("From reward_pool", amtq(ci.distributedFromRewardPool)) +
        miniCard("Treasury collected", amtq(ci.treasuryCollected)) + miniCard("Marketplace volume", amtq(ci.marketplaceVolume));
      var em = d.emissions || {};
      emis.innerHTML = miniCard("Signup", amtq(em.signupRewardsTotal)) + miniCard("PRO", amtq(em.proRewardsTotal)) +
        miniCard("Creator", amtq(em.creatorRewardsTotal)) + miniCard("Airdrops", amtq(em.airdropsTotal)) +
        miniCard("Manual grants", amtq(em.manualGrantsTotal)) + miniCard("Reclaimed", amtq(em.reclaimedTotal));
    } catch (e) {
      warnBox.innerHTML = '<div style="color:#ef4444;font-size:12.5px">Could not load summary: ' + esc(errMsg(e)) + '</div>';
    }
  }
  async function loadLedger(root) {
    var host = root.querySelector("#cd-ledger");
    var qs = [];
    var ty = root.querySelector("#cd-f-type").value.trim();
    var wa = root.querySelector("#cd-f-wallet").value.trim();
    var us = root.querySelector("#cd-f-user").value.trim();
    if (ty) qs.push("type=" + encodeURIComponent(ty));
    if (wa) qs.push("wallet=" + encodeURIComponent(wa));
    if (us) qs.push("userId=" + encodeURIComponent(us));
    qs.push("limit=100");
    host.innerHTML = '<div style="padding:20px;text-align:center;color:' + t.t4 + ';font-size:12px">Loading…</div>';
    try {
      var d = await api("/qntm/admin/economy/ledger?" + qs.join("&"));
      var rows = d.movements || [];
      host.innerHTML = rows.length ? rows.map(ledgerRow).join("") : '<div style="padding:20px;text-align:center;color:' + t.t4 + ';font-size:12px">No movements.</div>';
    } catch (e) {
      host.innerHTML = '<div style="padding:16px;color:#ef4444;font-size:12.5px">' + esc(errMsg(e)) + '</div>';
    }
  }

  // ---- main renderer --------------------------------------------------------
  function cdRenderDeck(container) {
    container.innerHTML =
      '<div style="max-width:1040px;margin:0 auto;padding:18px 16px 60px">' +
        '<div style="color:' + t.t3 + ';font-size:12px;margin-bottom:8px">Every figure is derived live from the ledger — the single source of truth. Actions are double-entry, audited, and never mint.</div>' +
        '<div id="cd-warn"></div>' +
        sectionLabel("System pools (main wallet)") +
        '<div id="cd-pools" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px"></div>' +
        sectionLabel("Circulation") +
        '<div id="cd-circ" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px"></div>' +
        sectionLabel("Emissions") +
        '<div id="cd-emis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px"></div>' +
        sectionLabel("Operations") +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">' +
          opCard('<div style="font-weight:800;color:' + t.t1 + ';font-size:14px;margin-bottom:3px">Grant from reward_pool</div><div style="color:' + t.t3 + ';font-size:11.5px;margin-bottom:10px">reward_pool &rarr; user</div>' +
            field("User id", "cd-g-user", "recipient user id", true) + field("Amount (QNTM)", "cd-g-amt", "e.g. 100", true) + field("Reason", "cd-g-reason", "why") + btn("cd-g-btn", "Grant from pool")) +
          opCard('<div style="font-weight:800;color:' + t.t1 + ';font-size:14px;margin-bottom:3px">Reclaim to reward_pool</div><div style="color:' + t.t3 + ';font-size:11.5px;margin-bottom:10px">user &rarr; reward_pool</div>' +
            field("User id", "cd-r-user", "from user id", true) + field("Amount (QNTM)", "cd-r-amt", "e.g. 100", true) + field("Reason", "cd-r-reason", "why") + btn("cd-r-btn", "Reclaim to pool", true)) +
          opCard('<div style="font-weight:800;color:' + t.t1 + ';font-size:14px;margin-bottom:3px">Transfer between pools</div><div style="color:' + t.t3 + ';font-size:11.5px;margin-bottom:10px">system pool &rarr; system pool</div>' +
            '<div style="display:flex;gap:8px;margin-bottom:9px"><div style="flex:1"><div style="color:' + t.t3 + ';font-size:11px;margin-bottom:4px">From</div>' + poolSelect("cd-x-from", "treasury") + '</div><div style="flex:1"><div style="color:' + t.t3 + ';font-size:11px;margin-bottom:4px">To</div>' + poolSelect("cd-x-to", "reward_pool") + '</div></div>' +
            field("Amount (QNTM)", "cd-x-amt", "e.g. 1000", true) + field("Reason", "cd-x-reason", "why you're rebalancing") + btn("cd-x-btn", "Transfer pool")) +
        '</div>' +
        sectionLabel("All transactions") +
        '<div style="background:' + t.cd + ';border:1px solid ' + t.bd + ';border-radius:14px;padding:12px;margin-bottom:12px">' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;align-items:end">' +
            '<div><div style="color:' + t.t3 + ';font-size:11px;margin-bottom:4px">Type</div><input id="cd-f-type" class="gi" placeholder="e.g. admin_manual_grant" style="font-size:13px;font-family:ui-monospace,monospace"/></div>' +
            '<div><div style="color:' + t.t3 + ';font-size:11px;margin-bottom:4px">Wallet type</div><input id="cd-f-wallet" class="gi" placeholder="e.g. reward_pool" style="font-size:13px;font-family:ui-monospace,monospace"/></div>' +
            '<div><div style="color:' + t.t3 + ';font-size:11px;margin-bottom:4px">User id</div><input id="cd-f-user" class="gi" placeholder="user id" style="font-size:13px;font-family:ui-monospace,monospace"/></div>' +
            '<div><button id="cd-f-run" type="button" class="pb" style="width:100%;padding:11px">Search</button></div>' +
          '</div></div>' +
        '<div style="background:' + t.cd + ';border:1px solid ' + t.bd + ';border-radius:14px;overflow:hidden"><div id="cd-ledger"></div></div>' +
      '</div>';

    loadSummary(container);
    loadLedger(container);

    // ---- wire operations ----
    container.querySelector("#cd-g-btn").onclick = function () {
      var u = container.querySelector("#cd-g-user").value.trim(),
          a = container.querySelector("#cd-g-amt").value.trim(),
          r = container.querySelector("#cd-g-reason").value.trim();
      if (!u || !a) { alert("User id and amount are required"); return; }
      confirmGate({
        title: "Grant " + a + " QNTM from reward_pool",
        lines: [{ k: "From", v: "reward_pool" }, { k: "To user", v: u }, { k: "Amount", v: a + " QNTM" }],
        onConfirm: async function () {
          await api("/qntm/admin/economy/grant", { method: "POST", headers: { "Idempotency-Key": key("cd-grant") }, body: JSON.stringify({ toUserId: u, amount: a, reason: r || "admin grant" }) });
          container.querySelector("#cd-g-amt").value = "";
          toast("Granted", a + " QNTM to #" + u);
          loadSummary(container); loadLedger(container);
        }
      });
    };
    container.querySelector("#cd-r-btn").onclick = function () {
      var u = container.querySelector("#cd-r-user").value.trim(),
          a = container.querySelector("#cd-r-amt").value.trim(),
          r = container.querySelector("#cd-r-reason").value.trim();
      if (!u || !a) { alert("User id and amount are required"); return; }
      confirmGate({
        title: "Reclaim " + a + " QNTM to reward_pool", danger: true,
        lines: [{ k: "From user", v: u }, { k: "To", v: "reward_pool" }, { k: "Amount", v: a + " QNTM" }],
        onConfirm: async function () {
          await api("/qntm/admin/economy/reclaim", { method: "POST", headers: { "Idempotency-Key": key("cd-reclaim") }, body: JSON.stringify({ fromUserId: u, amount: a, reason: r || "admin reclaim" }) });
          container.querySelector("#cd-r-amt").value = "";
          toast("Reclaimed", a + " QNTM from #" + u);
          loadSummary(container); loadLedger(container);
        }
      });
    };
    container.querySelector("#cd-x-btn").onclick = function () {
      var f = container.querySelector("#cd-x-from").value,
          to = container.querySelector("#cd-x-to").value,
          a = container.querySelector("#cd-x-amt").value.trim(),
          r = container.querySelector("#cd-x-reason").value.trim();
      if (!a) { alert("Enter an amount"); return; }
      if (f === to) { alert("From and To pools must differ"); return; }
      confirmGate({
        title: "Transfer " + a + " QNTM", 
        lines: [{ k: "From pool", v: f }, { k: "To pool", v: to }, { k: "Amount", v: a + " QNTM" }],
        onConfirm: async function () {
          await api("/qntm/admin/economy/transfer-pool", { method: "POST", headers: { "Idempotency-Key": key("cd-xfer") }, body: JSON.stringify({ fromPool: f, toPool: to, amount: a, reason: r || "pool rebalance" }) });
          container.querySelector("#cd-x-amt").value = "";
          toast("Transferred", a + " QNTM " + f + " → " + to);
          loadSummary(container); loadLedger(container);
        }
      });
    };
    container.querySelector("#cd-f-run").onclick = function () { loadLedger(container); };
  }

  window.cdRenderDeck = cdRenderDeck;
})();
