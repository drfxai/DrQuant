/* ============================================================================
 * DrFX Quant — native admin Control Deck
 * ----------------------------------------------------------------------------
 * Loaded by public/index.html (as /control-deck.js). Renders INSIDE the
 * full-screen #dq-cd-overlay shell that openControlDeck() builds. Admin-only:
 * the overlay guards on S.user.role === "admin" and the API enforces it
 * server-side (non-admins get 403 at the mount).
 *
 * Page globals reused (classic scripts share one global scope):
 *   api(path,opts) -> fetch "/api"+path with the bearer token; throws the
 *                     parsed JSON body on !ok.
 *   S, t, esc, ce, showToast
 *
 * Endpoints (all mounted by server.js -> mountQntmEconomy):
 *   GET  /qntm/admin/economy/summary
 *   GET  /qntm/admin/economy/ledger?type=&wallet=&userId=&limit=
 *   POST /qntm/admin/economy/grant         { toUserId, amount, reason }
 *   POST /qntm/admin/economy/reclaim       { fromUserId, amount, reason }
 *   POST /qntm/admin/economy/transfer-pool { fromPool, toPool, amount, reason }
 *   GET  /qntm/admin/economy/user/:id?limit=                 (wallet inspector)
 *   GET  /qntm/admin/payment-orders?status=&userId=&limit=   (top-up orders)
 *   POST /qntm/admin/payment-orders/:id/recredit             (no balance dup)
 *   POST /qntm/admin/payment-orders/:id/fail   { reason }
 * Writes that need it carry an Idempotency-Key and are gated by a "type
 * CONFIRM" modal. The ledger is the only source of truth; nothing reads a
 * cached balance.
 *
 * Layout: a single injected <style> (rebuilt each render so it tracks the
 * active theme) drives a fluid fr-based grid that collapses to a single column
 * on mobile. Combined with overflow-x:hidden there is no horizontal scrolling
 * at any width — only vertical.
 * ==========================================================================*/
(function () {
  "use strict";

  var POOLS = ["treasury", "reward_pool", "ecosystem", "community_reserve"];
  var POOL_ORDER = ["reward_pool", "treasury", "ecosystem", "team_vesting",
    "community_reserve", "burn", "escrow", "fee", "staking",
    "tournament_pool", "subscription_settlement", "genesis"];
  var ORDER_STATUSES = ["pending", "awaiting_webhook", "paid_pending_credit", "completed", "failed", "cancelled"];

  function amtq(a) { return (a && a.qntm != null) ? a.qntm : (a != null ? String(a) : "-"); }
  function num(s) { if (s == null || s === "") return "-"; var n = Number(s); return isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 6 }) : String(s); }
  function key(p) { return p + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8); }
  function when(d) { if (!d) return "-"; var x = new Date(d); return isNaN(x) ? String(d) : x.toLocaleString(); }
  function short(s) { s = String(s || ""); return s.length > 18 ? s.slice(0, 8) + "\u2026" + s.slice(-5) : s; }
  function sCol(s) {
    if (s === "healthy" || s === "active" || s === "completed") return "#34d27a";
    if (s === "low" || s === "not_configured" || s === "paid_pending_credit" || s === "awaiting_webhook" || s === "pending") return "#f59e0b";
    if (s === "critical" || s === "frozen" || s === "closed" || s === "failed" || s === "cancelled") return "#ef4444";
    return t.t3;
  }
  function errMsg(e) { var m = (e && e.error && (e.error.message || e.error)) || (e && e.message) || "Action failed"; return typeof m === "string" ? m : JSON.stringify(m); }
  function toast(title, msg) { try { if (window.showToast) showToast(title, msg); } catch (_) {} }
  function loading() { return '<div style="padding:20px;text-align:center;color:' + t.t4 + ';font-size:12px">Loading\u2026</div>'; }
  function empty(msg) { return '<div style="padding:18px;text-align:center;color:' + t.t4 + ';font-size:12px">' + esc(msg) + '</div>'; }
  function fail(msg) { return '<div style="padding:16px;color:#ef4444;font-size:12.5px;word-break:break-word">' + esc(msg) + '</div>'; }

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
      go.disabled = true; go.textContent = "Working\u2026";
      try { await opts.onConfirm(); sc.remove(); }
      catch (e) { go.disabled = false; go.textContent = "Execute"; alert(errMsg(e)); }
    };
  }

  // ---- scoped stylesheet: rebuilt each render so theme colours stay current --
  // Every grid is fr-based and collapses to 1-2 columns on mobile; combined
  // with overflow-x:hidden this guarantees vertical-only scrolling.
  function cdStyle() {
    return '<style>' +
      '#dq-cd-content{overflow-x:hidden}' +
      '.dqcd,.dqcd *{box-sizing:border-box;min-width:0}' +
      '.dqcd{max-width:1040px;margin:0 auto;padding:16px 14px 64px;width:100%}' +
      '.dqcd-intro{color:' + t.t3 + ';font-size:12px;line-height:1.5;margin-bottom:8px}' +
      '.dqcd-h{color:' + t.t2 + ';font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin:22px 2px 10px}' +
      '.dqcd-grid{display:grid;gap:10px}' +
      '.dqcd-pool{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}' +
      '.dqcd-mini{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}' +
      '.dqcd-emis{grid-template-columns:repeat(auto-fill,minmax(112px,1fr))}' +
      '.dqcd-ops{grid-template-columns:repeat(auto-fill,minmax(255px,1fr))}' +
      '.dqcd-filt{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px;align-items:end}' +
      '.dqcd-card{background:' + t.cd + ';border:1px solid ' + t.bd + ';border-radius:14px;padding:12px 13px}' +
      '.dqcd-op{background:' + t.cd + ';border:1px solid ' + t.bd + ';border-radius:16px;padding:14px}' +
      '.dqcd-cap{color:' + t.t3 + ';font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.dqcd-val{color:' + t.t1 + ';font-size:18px;font-weight:800;margin-top:5px;font-family:ui-monospace,monospace;word-break:break-all}' +
      '.dqcd-list{background:' + t.cd + ';border:1px solid ' + t.bd + ';border-radius:14px;overflow:hidden;margin-bottom:12px}' +
      '.dqcd-fl{background:' + t.cd + ';border:1px solid ' + t.bd + ';border-radius:14px;padding:12px;margin-bottom:12px}' +
      '.dqcd-bt{width:100%;margin-top:4px;padding:11px;border-radius:12px;border:none;color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:Outfit,sans-serif}' +
      '.dqcd .gi{width:100%}' +
      '.dqcd-ttl{font-weight:800;color:' + t.t1 + ';font-size:14px;margin-bottom:3px}' +
      '.dqcd-hint{color:' + t.t3 + ';font-size:11.5px;margin-bottom:10px}' +
      '.dqcd-flbl{color:' + t.t3 + ';font-size:11px;margin-bottom:4px}' +
      '@media (max-width:560px){' +
        '.dqcd{padding:12px 10px 54px}' +
        '.dqcd-h{margin:18px 2px 8px}' +
        '.dqcd-pool,.dqcd-mini,.dqcd-emis{grid-template-columns:1fr 1fr}' +
        '.dqcd-ops{grid-template-columns:1fr}' +
        '.dqcd-filt{grid-template-columns:1fr 1fr}' +
        '.dqcd-op{padding:12px}' +
        '.dqcd-card{padding:10px 11px}' +
        '.dqcd-val{font-size:16px}' +
      '}' +
    '</style>';
  }

  // ---- small view builders --------------------------------------------------
  function poolCard(name, w) {
    var configured = w && w.configured !== false;
    var bal = configured ? num(amtq(w.balance)) : "\u2014";
    var status = configured ? (w.status || "-") : "not configured";
    var col = sCol(status);
    var pct = (w && w.percentRemaining != null) ? (" \u00b7 " + w.percentRemaining + "%") : "";
    var hi = (name === "reward_pool" || name === "treasury");
    return '<div class="dqcd-card"' + (hi ? ' style="border-color:' + t.bl + '"' : '') + '>' +
      '<div class="dqcd-cap">' + esc(name) + '</div>' +
      '<div class="dqcd-val">' + esc(bal) + '</div>' +
      '<div style="margin-top:7px;display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:50%;background:' + col + ';flex-shrink:0"></span>' +
      '<span style="color:' + col + ';font-size:11px;font-weight:600;word-break:break-word">' + esc(status + pct) + '</span></div></div>';
  }
  function miniCard(label, val) {
    return '<div class="dqcd-card"><div class="dqcd-cap">' + esc(label) + '</div>' +
      '<div class="dqcd-val" style="font-size:15px">' + esc(num(val)) + '</div></div>';
  }
  function field(label, id, ph, mono) {
    return '<div style="margin-bottom:9px"><div class="dqcd-flbl">' + esc(label) + '</div>' +
      '<input id="' + id + '" class="gi" placeholder="' + esc(ph || "") + '" style="font-size:14px' + (mono ? ";font-family:ui-monospace,monospace" : "") + '"/></div>';
  }
  function poolSelect(id, def) {
    return '<select id="' + id + '" class="gi" style="font-size:14px">' +
      POOLS.map(function (p) { return '<option' + (p === def ? ' selected' : '') + '>' + p + '</option>'; }).join("") + '</select>';
  }
  function btn(id, label, danger) {
    return '<button id="' + id + '" type="button" class="dqcd-bt" style="background:' + (danger ? "#ef4444" : t.pg) + ';box-shadow:0 4px 16px ' + (danger ? "rgba(239,68,68,.32)" : t.pgw) + '">' + esc(label) + '</button>';
  }
  function actBtn(label, color, fn) {
    var b = ce("button"); b.type = "button"; b.textContent = label;
    b.style.cssText = "padding:6px 11px;border-radius:9px;border:1px solid " + color + "66;background:" + color + "1a;color:" + color + ";font-size:11.5px;font-weight:700;cursor:pointer;font-family:Outfit,sans-serif";
    b.onclick = fn; return b;
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
        '<div style="color:' + t.t4 + ';font-size:10px;margin-top:2px">' + esc(when(m.createdAt)) + (m.actorId ? (' \u00b7 by #' + esc(m.actorId)) : '') + (m.reason ? (' \u00b7 ' + esc(m.reason)) : '') + '</div></div>' +
      '<div style="text-align:right;font-family:ui-monospace,monospace;font-weight:800;color:' + t.t1 + ';font-size:14px;white-space:nowrap">' + esc(num(amtq(m.amount))) + ' <span style="color:' + t.t4 + ';font-size:10px">QNTM</span></div></div>';
  }
  function orderCard(o) {
    var st = o.status || "-", col = sCol(st);
    return '<div style="padding:11px 12px;border-bottom:1px solid ' + t.bd + '">' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<span style="font-size:11px;color:' + t.t4 + ';font-family:ui-monospace,monospace">' + esc(short(o.public_id)) + '</span>' +
        '<span style="font-size:11px;color:' + col + ';font-weight:700">' + esc(st) + '</span>' +
        '<span style="flex:1"></span>' +
        '<span style="font-family:ui-monospace,monospace;font-weight:800;color:' + t.t1 + ';font-size:14px;white-space:nowrap">' + esc(num(o.qntm_amount)) + ' <span style="color:' + t.t4 + ';font-size:10px">QNTM</span></span>' +
      '</div>' +
      '<div style="color:' + t.t3 + ';font-size:11px;margin-top:4px;word-break:break-word">user #' + esc(o.user_id) + ' \u00b7 $' + esc(num(o.fiat_amount_usd)) + ' \u00b7 ' + esc(o.pay_currency || "-") + ' \u00b7 ' + esc(when(o.created_at)) + '</div>' +
      (o.error ? '<div style="color:#ef9b94;font-size:10.5px;margin-top:3px;word-break:break-word">' + esc(o.error) + '</div>' : '') +
      '<div class="dqcd-oacts" data-oid="' + esc(o.public_id) + '" style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap"></div>' +
    '</div>';
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
        ? '<div style="background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.32);border-radius:12px;padding:10px 13px;color:#e7c889;font-size:12.5px;margin-bottom:4px"><b>Warnings:</b> ' + warns.map(esc).join(" \u00b7 ") + '</div>'
        : "";
      var sw = d.systemWallets || {}, seen = {}, html = "";
      POOL_ORDER.forEach(function (k) { if (sw[k]) { html += poolCard(k, sw[k]); seen[k] = 1; } });
      Object.keys(sw).forEach(function (k) { if (!seen[k]) html += poolCard(k, sw[k]); });
      pools.innerHTML = html || empty("No system wallets.");
      var ci = d.circulation || {};
      circ.innerHTML = miniCard("Held by users", amtq(ci.userBalancesTotal)) + miniCard("From reward_pool", amtq(ci.distributedFromRewardPool)) +
        miniCard("Treasury collected", amtq(ci.treasuryCollected)) + miniCard("Marketplace volume", amtq(ci.marketplaceVolume));
      var em = d.emissions || {};
      emis.innerHTML = miniCard("Signup", amtq(em.signupRewardsTotal)) + miniCard("PRO", amtq(em.proRewardsTotal)) +
        miniCard("Creator", amtq(em.creatorRewardsTotal)) + miniCard("Airdrops", amtq(em.airdropsTotal)) +
        miniCard("Manual grants", amtq(em.manualGrantsTotal)) + miniCard("Reclaimed", amtq(em.reclaimedTotal));
    } catch (e) {
      warnBox.innerHTML = fail("Could not load summary: " + errMsg(e));
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
    host.innerHTML = loading();
    try {
      var d = await api("/qntm/admin/economy/ledger?" + qs.join("&"));
      var rows = d.movements || [];
      host.innerHTML = rows.length ? rows.map(ledgerRow).join("") : empty("No movements.");
    } catch (e) {
      host.innerHTML = fail(errMsg(e));
    }
  }
  async function loadOrders(root) {
    var host = root.querySelector("#cd-orders");
    if (!host) return;
    var status = root.querySelector("#cd-o-status").value;
    var user = root.querySelector("#cd-o-user").value.trim();
    var qs = ["limit=100"];
    if (status) qs.push("status=" + encodeURIComponent(status));
    if (user) qs.push("userId=" + encodeURIComponent(user));
    host.innerHTML = loading();
    try {
      var d = await api("/qntm/admin/payment-orders?" + qs.join("&"));
      var list = d.orders || [];
      if (!list.length) { host.innerHTML = empty("No payment orders."); return; }
      host.innerHTML = list.map(orderCard).join("");
      host.querySelectorAll(".dqcd-oacts").forEach(function (box) {
        var o = list.find(function (x) { return String(x.public_id) === box.dataset.oid; });
        if (!o) return;
        var st = o.status;
        if (st === "paid_pending_credit" || st === "awaiting_webhook") {
          box.appendChild(actBtn("Re-credit", "#34d27a", function () {
            confirmGate({
              title: "Re-credit " + short(o.public_id),
              lines: [{ k: "Order", v: o.public_id }, { k: "Credit", v: num(o.qntm_amount) + " QNTM" }, { k: "To user", v: "#" + o.user_id }],
              onConfirm: async function () {
                await api("/qntm/admin/payment-orders/" + encodeURIComponent(o.public_id) + "/recredit", { method: "POST" });
                toast("Re-credited", short(o.public_id));
                loadOrders(root); loadSummary(root);
              }
            });
          }));
        }
        if (st !== "completed" && st !== "failed") {
          box.appendChild(actBtn("Mark failed", "#ef4444", function () {
            confirmGate({
              title: "Mark order failed", danger: true,
              lines: [{ k: "Order", v: o.public_id }, { k: "New status", v: "failed" }, { k: "Balance change", v: "none" }],
              onConfirm: async function () {
                await api("/qntm/admin/payment-orders/" + encodeURIComponent(o.public_id) + "/fail", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "manual override via Control Deck" }) });
                toast("Marked failed", short(o.public_id));
                loadOrders(root);
              }
            });
          }));
        }
        if (!box.children.length) {
          var none = ce("span"); none.textContent = "no actions"; none.style.cssText = "color:" + t.t4 + ";font-size:10.5px"; box.appendChild(none);
        }
      });
    } catch (e) {
      host.innerHTML = fail(errMsg(e));
    }
  }
  async function loadUserInspect(root) {
    var host = root.querySelector("#cd-ui-out");
    var id = root.querySelector("#cd-ui-user").value.trim();
    if (!id) { alert("Enter a user id"); return; }
    host.innerHTML = loading();
    try {
      var d = await api("/qntm/admin/economy/user/" + encodeURIComponent(id) + "?limit=50");
      var w = d.wallet, html = "";
      if (w) {
        html += '<div class="dqcd-grid dqcd-mini" style="margin-bottom:10px">' +
          miniCard("Available", amtq(w.available)) +
          miniCard("Pending", amtq(w.pending)) +
          miniCard("Locked", amtq(w.locked)) +
          '<div class="dqcd-card"><div class="dqcd-cap">Wallet</div><div class="dqcd-val" style="font-size:14px">#' + esc(w.walletId) + '</div><div style="color:' + sCol(w.status) + ';font-size:11px;margin-top:4px">' + esc(w.status || "-") + '</div></div>' +
        '</div>';
      } else {
        html += '<div class="dqcd-card" style="margin-bottom:10px;color:' + t.t3 + ';font-size:12.5px">No QNTM wallet for user #' + esc(id) + ' yet.</div>';
      }
      var mv = d.movements || [];
      html += '<div class="dqcd-list" style="margin-bottom:0">' + (mv.length ? mv.map(ledgerRow).join("") : empty("No movements.")) + '</div>';
      host.innerHTML = html;
    } catch (e) {
      host.innerHTML = fail(errMsg(e));
    }
  }

  // ---- main renderer --------------------------------------------------------
  function cdRenderDeck(container) {
    container.style.overflowX = "hidden"; // belt-and-suspenders: no sideways scroll
    container.innerHTML =
      cdStyle() +
      '<div class="dqcd">' +
        '<div class="dqcd-intro">Every figure is derived live from the ledger \u2014 the single source of truth. Actions are double-entry, audited, and never mint.</div>' +
        '<div id="cd-warn"></div>' +

        '<div class="dqcd-h">System pools (main wallet)</div>' +
        '<div id="cd-pools" class="dqcd-grid dqcd-pool"></div>' +

        '<div class="dqcd-h">Circulation</div>' +
        '<div id="cd-circ" class="dqcd-grid dqcd-mini"></div>' +

        '<div class="dqcd-h">Emissions</div>' +
        '<div id="cd-emis" class="dqcd-grid dqcd-emis"></div>' +

        '<div class="dqcd-h">Operations</div>' +
        '<div class="dqcd-grid dqcd-ops">' +
          '<div class="dqcd-op"><div class="dqcd-ttl">Grant from reward_pool</div><div class="dqcd-hint">reward_pool &rarr; user</div>' +
            field("User id", "cd-g-user", "recipient user id", true) + field("Amount (QNTM)", "cd-g-amt", "e.g. 100", true) + field("Reason", "cd-g-reason", "why") + btn("cd-g-btn", "Grant from pool") + '</div>' +
          '<div class="dqcd-op"><div class="dqcd-ttl">Reclaim to reward_pool</div><div class="dqcd-hint">user &rarr; reward_pool</div>' +
            field("User id", "cd-r-user", "from user id", true) + field("Amount (QNTM)", "cd-r-amt", "e.g. 100", true) + field("Reason", "cd-r-reason", "why") + btn("cd-r-btn", "Reclaim to pool", true) + '</div>' +
          '<div class="dqcd-op"><div class="dqcd-ttl">Transfer between pools</div><div class="dqcd-hint">system pool &rarr; system pool</div>' +
            '<div style="display:flex;gap:8px;margin-bottom:9px"><div style="flex:1"><div class="dqcd-flbl">From</div>' + poolSelect("cd-x-from", "treasury") + '</div><div style="flex:1"><div class="dqcd-flbl">To</div>' + poolSelect("cd-x-to", "reward_pool") + '</div></div>' +
            field("Amount (QNTM)", "cd-x-amt", "e.g. 1000", true) + field("Reason", "cd-x-reason", "why you're rebalancing") + btn("cd-x-btn", "Transfer pool") + '</div>' +
        '</div>' +

        '<div class="dqcd-h">Payment orders (top-ups)</div>' +
        '<div class="dqcd-fl">' +
          '<div class="dqcd-filt">' +
            '<div><div class="dqcd-flbl">Status</div><select id="cd-o-status" class="gi" style="font-size:13px"><option value="">Any status</option>' + ORDER_STATUSES.map(function (s) { return '<option>' + s + '</option>'; }).join("") + '</select></div>' +
            '<div><div class="dqcd-flbl">User id</div><input id="cd-o-user" class="gi" placeholder="user id" style="font-size:13px;font-family:ui-monospace,monospace"/></div>' +
            '<div><button id="cd-o-run" type="button" class="pb" style="width:100%;padding:11px">Load</button></div>' +
          '</div></div>' +
        '<div class="dqcd-list"><div id="cd-orders"></div></div>' +

        '<div class="dqcd-h">User wallet inspector</div>' +
        '<div class="dqcd-fl">' +
          '<div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap"><div style="flex:1;min-width:140px"><div class="dqcd-flbl">User id</div><input id="cd-ui-user" class="gi" placeholder="user id" style="font-size:14px;font-family:ui-monospace,monospace"/></div>' +
          '<button id="cd-ui-run" type="button" class="pb" style="padding:11px 18px">Inspect</button></div></div>' +
        '<div id="cd-ui-out"></div>' +

        '<div class="dqcd-h">All transactions</div>' +
        '<div class="dqcd-fl">' +
          '<div class="dqcd-filt">' +
            '<div><div class="dqcd-flbl">Type</div><input id="cd-f-type" class="gi" placeholder="e.g. admin_manual_grant" style="font-size:13px;font-family:ui-monospace,monospace"/></div>' +
            '<div><div class="dqcd-flbl">Wallet type</div><input id="cd-f-wallet" class="gi" placeholder="e.g. reward_pool" style="font-size:13px;font-family:ui-monospace,monospace"/></div>' +
            '<div><div class="dqcd-flbl">User id</div><input id="cd-f-user" class="gi" placeholder="user id" style="font-size:13px;font-family:ui-monospace,monospace"/></div>' +
            '<div><button id="cd-f-run" type="button" class="pb" style="width:100%;padding:11px">Search</button></div>' +
          '</div></div>' +
        '<div class="dqcd-list"><div id="cd-ledger"></div></div>' +
      '</div>';

    loadSummary(container);
    loadLedger(container);
    loadOrders(container);

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
          toast("Transferred", a + " QNTM " + f + " \u2192 " + to);
          loadSummary(container); loadLedger(container);
        }
      });
    };
    container.querySelector("#cd-f-run").onclick = function () { loadLedger(container); };
    container.querySelector("#cd-o-run").onclick = function () { loadOrders(container); };
    container.querySelector("#cd-ui-run").onclick = function () { loadUserInspect(container); };
    var uiu = container.querySelector("#cd-ui-user");
    if (uiu) uiu.addEventListener("keydown", function (e) { if (e.key === "Enter") loadUserInspect(container); });
  }

  window.cdRenderDeck = cdRenderDeck;
})();
