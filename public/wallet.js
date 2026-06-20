"use strict";
/* ============================================================================
 * wallet.js — QNTM Wallet UI for DrFX Quant
 *
 * A self-contained wallet section that surfaces the authoritative qntm-ledger
 * balance + history and lets a user send QNTM to another user. It reuses the
 * host SPA's globals (S, api, modal, t, esc, ic, I, showToast, fmtTime), which
 * are reachable here because this is a classic <script> loaded after the main
 * one. Exposes window.openWallet().
 *
 * Endpoints (ledger):
 *   GET  /api/qntm/wallets/me                 -> { wallet }
 *   GET  /api/qntm/wallets/me/transactions    -> { entries }
 *   POST /api/qntm/wallets/transfer           -> { transaction } | { status:'under_review' }
 *
 * Note: this shows the LEDGER balance, which is distinct from the legacy
 * S.user.qntm field still shown on the profile/admin chips and used by /market.
 * ========================================================================== */
(function () {
  // --- helpers -------------------------------------------------------------
  function errMsg(e) {
    return (e && e.error && (e.error.message || e.error.code)) ||
           (e && typeof e.error === "string" && e.error) ||
           (e && e.message) || "Something went wrong";
  }
  // Display a ledger decimal string (18 dp) with 2–6 fraction digits.
  function fmtQ(s) {
    var n = Number(s);
    if (!isFinite(n)) n = 0;
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  }
  function gt0(s) { var n = Number(s); return isFinite(n) && n > 0; }

  var TYPE_LABEL = {
    transfer: "Transfer", reward: "Grant", marketplace_purchase: "Marketplace",
    platform_fee: "Platform fee", refund: "Refund", mint: "Issuance",
    adjustment: "Adjustment", reversal: "Reversal", creator_release: "Payout",
    referral_bonus: "Referral", subscription_payment: "Subscription"
  };
  function typeLabel(x) { return TYPE_LABEL[x] || (x ? String(x).replace(/_/g, " ") : "Transaction"); }

  var ARROW_IN = '<polyline points="19 12 12 19 5 12"/><line x1="12" y1="5" x2="12" y2="19"/>';
  var ARROW_OUT = '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>';
  var SEND_ICON = '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>';

  function loader() {
    return '<div style="text-align:center;color:' + t.t3 + ';padding:34px 0;animation:pu 1.5s infinite">Loading wallet…</div>';
  }
  function errBox(msg) {
    return '<div style="padding:14px;border-radius:12px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);color:#ef4444;font-size:13px;text-align:center">' + esc(msg) + '</div>';
  }

  // --- history row ---------------------------------------------------------
  function rowHTML(e) {
    var credit = e.direction === "credit";
    var sign = credit ? "+" : "\u2212";
    var col = credit ? "#34d27a" : t.t2;
    var sub = (e.description ? esc(e.description) : typeLabel(e.txn_type)) +
              (e.created_at ? (" \u00b7 " + fmtTime(e.created_at)) : "");
    return '<div style="display:flex;align-items:center;gap:12px;padding:11px;border-radius:13px;background:' + t.cd + ';border:1px solid ' + t.bd + ';margin-bottom:7px">' +
      '<div style="width:36px;height:36px;border-radius:11px;background:' + (credit ? 'rgba(52,210,122,.14)' : t.ta) + ';display:flex;align-items:center;justify-content:center;color:' + (credit ? '#34d27a' : t.pr) + ';flex-shrink:0">' + ic(credit ? ARROW_IN : ARROW_OUT, 18) + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="color:' + t.t1 + ';font-size:13.5px;font-weight:600">' + typeLabel(e.txn_type) + '</div>' +
        '<div style="color:' + t.t3 + ';font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + sub + '</div>' +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0">' +
        '<div style="color:' + col + ';font-size:14px;font-weight:700">' + sign + fmtQ(e.amount) + '</div>' +
        '<div style="color:' + t.t4 + ';font-size:10px">' + esc(e.txn_status || "") + '</div>' +
      '</div>' +
    '</div>';
  }

  // --- main wallet view ----------------------------------------------------
  function walletHTML(w, entries) {
    var pend = w.pending_balance, lock = w.locked_balance;
    var extra = "";
    if (gt0(pend) || gt0(lock)) {
      var chips = [];
      if (gt0(pend)) chips.push('<span style="color:' + t.t2 + '">Pending <b style="color:' + t.t1 + '">' + fmtQ(pend) + '</b></span>');
      if (gt0(lock)) chips.push('<span style="color:' + t.t2 + '">Locked <b style="color:' + t.t1 + '">' + fmtQ(lock) + '</b></span>');
      extra = '<div style="display:flex;gap:16px;margin-top:12px;font-size:12px">' + chips.join('') + '</div>';
    }
    var card =
      '<div style="position:relative;overflow:hidden;border-radius:20px;padding:22px;margin-bottom:16px;background:linear-gradient(135deg,rgba(36,48,92,.55),rgba(16,24,52,.5));border:1px solid ' + t.bl + ';box-shadow:0 10px 30px rgba(0,0,0,.3)">' +
        '<div style="position:absolute;top:-34px;right:-22px;width:128px;height:128px;border-radius:50%;background:radial-gradient(circle,rgba(124,92,255,.28),transparent 70%);pointer-events:none"></div>' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
          '<div style="width:34px;height:34px;border-radius:10px;background:' + t.pg + ';display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;font-weight:800;box-shadow:0 4px 14px ' + t.pgw + '">Q</div>' +
          '<div><div style="color:' + t.t3 + ';font-size:10px;letter-spacing:1.2px;font-weight:700">QNTM BALANCE</div><div style="color:' + t.t4 + ';font-size:11px">Internal platform credits</div></div>' +
        '</div>' +
        '<div style="color:' + t.t1 + ';font-size:34px;font-weight:800;letter-spacing:-.5px;line-height:1">' + fmtQ(w.available_balance) + '<span style="font-size:15px;color:' + t.t3 + ';font-weight:600;margin-left:6px">QNTM</span></div>' +
        extra +
      '</div>';

    var actions =
      '<div style="display:flex;gap:10px;margin-bottom:18px">' +
        '<button id="dqw-send" class="pb" type="button" style="flex:1;padding:13px;display:flex;align-items:center;justify-content:center;gap:8px">' + ic(SEND_ICON, 18) + ' Send</button>' +
        '<button id="dqw-recv" type="button" style="flex:1;padding:13px;border-radius:12px;border:1px solid ' + t.bd + ';background:' + t.cd + ';color:' + t.t1 + ';font-weight:600;font-size:14px;cursor:pointer;font-family:\'Outfit\',sans-serif;display:flex;align-items:center;justify-content:center;gap:8px">' + ic(ARROW_IN, 18) + ' Receive</button>' +
      '</div>';

    var hist;
    if (entries && entries.length) {
      hist = '<div style="max-height:42vh;overflow-y:auto;-webkit-overflow-scrolling:touch">' + entries.map(rowHTML).join('') + '</div>';
    } else {
      hist = '<div style="text-align:center;padding:22px 12px;color:' + t.t3 + '">' +
        '<div style="font-size:30px;margin-bottom:8px;opacity:.7">\uD83D\uDCB3</div>' +
        '<div style="font-size:13px;color:' + t.t2 + ';font-weight:600">No transactions yet</div>' +
        '<div style="font-size:11.5px;color:' + t.t4 + ';margin-top:4px;line-height:1.5">QNTM you receive from grants, transfers,<br>or the marketplace will show up here.</div>' +
      '</div>';
    }

    return card + actions +
      '<div style="color:' + t.t2 + ';font-size:12px;font-weight:700;margin-bottom:10px">Recent activity</div>' +
      '<div id="dqw-hist">' + hist + '</div>' +
      '<div style="text-align:center;color:' + t.t4 + ';font-size:10.5px;margin-top:14px;display:flex;align-items:center;justify-content:center;gap:5px">' + ic('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>', 12) + ' Internal credits \u00b7 not redeemable for cash</div>';
  }

  // --- send (transfer) form ------------------------------------------------
  function sendForm(body, reload) {
    var lbl = 'color:' + t.t2 + ';font-size:11px;font-weight:700;letter-spacing:.5px;display:block;margin:12px 2px 6px';
    body.innerHTML =
      '<button id="dqw-back" type="button" style="display:inline-flex;align-items:center;gap:5px;background:none;border:none;color:' + t.ac + ';font-size:13px;cursor:pointer;font-family:\'Outfit\',sans-serif;padding:0;margin-bottom:6px">' + ic('<polyline points="15 18 9 12 15 6"/>', 16) + ' Wallet</button>' +
      '<div style="color:' + t.t1 + ';font-size:16px;font-weight:800;margin-bottom:2px">Send QNTM</div>' +
      '<div style="color:' + t.t3 + ';font-size:12px;margin-bottom:8px">Transfer credits to another member by their user ID.</div>' +
      '<label style="' + lbl + '">Recipient user ID</label>' +
      '<input id="dqw-to" class="gi" placeholder="e.g. 1042" autocomplete="off" style="font-size:15px"/>' +
      '<label style="' + lbl + '">Amount</label>' +
      '<input id="dqw-amt" class="gi" inputmode="decimal" placeholder="0.00" style="font-size:15px"/>' +
      '<label style="' + lbl + '">Note (optional)</label>' +
      '<input id="dqw-note" class="gi" maxlength="140" placeholder="What\'s this for?" style="font-size:15px"/>' +
      '<div id="dqw-msg" style="margin-top:10px"></div>' +
      '<button id="dqw-do" class="pb" type="button" style="width:100%;margin-top:12px;padding:14px;font-size:15px">Send QNTM</button>';

    var msg = function (html) { var m = body.querySelector("#dqw-msg"); if (m) m.innerHTML = html || ""; };
    var back = body.querySelector("#dqw-back");
    if (back) back.onclick = function () { reload(); };

    var btn = body.querySelector("#dqw-do");
    btn.onclick = async function () {
      var to = (body.querySelector("#dqw-to").value || "").trim();
      var amt = (body.querySelector("#dqw-amt").value || "").trim();
      var note = (body.querySelector("#dqw-note").value || "").trim();
      if (!to) { msg(errBox("Enter a recipient user ID.")); return; }
      if (!amt || !/^\d+(\.\d+)?$/.test(amt) || !gt0(amt)) { msg(errBox("Enter a valid positive amount.")); return; }
      msg("");
      btn.disabled = true; btn.textContent = "Sending…";
      try {
        var r = await api("/qntm/wallets/transfer", {
          method: "POST",
          body: JSON.stringify({ toUserId: to, amount: amt, note: note || undefined })
        });
        if (r && r.status === "under_review") {
          if (typeof showToast === "function") showToast("Queued for review", "Your transfer is pending review.");
        } else if (typeof showToast === "function") {
          showToast("Sent", amt + " QNTM sent successfully.");
        }
        reload();
      } catch (e) {
        btn.disabled = false; btn.textContent = "Send QNTM";
        msg(errBox(errMsg(e)));
      }
    };
    setTimeout(function () { var f = body.querySelector("#dqw-to"); if (f) f.focus(); }, 60);
  }

  // --- receive view --------------------------------------------------------
  function receiveView(body, reload) {
    var myId = (typeof S !== "undefined" && S.user && S.user.id != null) ? String(S.user.id) : "";
    body.innerHTML =
      '<button id="dqw-back2" type="button" style="display:inline-flex;align-items:center;gap:5px;background:none;border:none;color:' + t.ac + ';font-size:13px;cursor:pointer;font-family:\'Outfit\',sans-serif;padding:0;margin-bottom:6px">' + ic('<polyline points="15 18 9 12 15 6"/>', 16) + ' Wallet</button>' +
      '<div style="color:' + t.t1 + ';font-size:16px;font-weight:800;margin-bottom:2px">Receive QNTM</div>' +
      '<div style="color:' + t.t3 + ';font-size:12px;margin-bottom:16px">Share your user ID so other members can send you QNTM.</div>' +
      '<div style="text-align:center;padding:20px;border-radius:16px;background:' + t.cd + ';border:1px solid ' + t.bd + '">' +
        '<div style="color:' + t.t3 + ';font-size:11px;letter-spacing:.5px;font-weight:700;margin-bottom:8px">YOUR USER ID</div>' +
        '<div style="color:' + t.t1 + ';font-size:26px;font-weight:800;letter-spacing:.5px;word-break:break-all">' + esc(myId || "—") + '</div>' +
      '</div>' +
      '<button id="dqw-copy" class="pb" type="button" style="width:100%;margin-top:14px;padding:13px">Copy ID</button>';
    var back = body.querySelector("#dqw-back2");
    if (back) back.onclick = function () { reload(); };
    var copy = body.querySelector("#dqw-copy");
    if (copy) copy.onclick = function () {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(myId).then(function () {
            if (typeof showToast === "function") showToast("Copied", "User ID copied to clipboard.");
          }, function () {});
        }
      } catch (e) {}
      copy.textContent = "Copied \u2713";
      setTimeout(function () { copy.textContent = "Copy ID"; }, 1600);
    };
  }

  // --- load + wire ---------------------------------------------------------
  function loadWallet(body) {
    body.innerHTML = loader();
    var reload = function () { loadWallet(body); };
    Promise.all([
      api("/qntm/wallets/me"),
      api("/qntm/wallets/me/transactions?limit=30")
    ]).then(function (res) {
      var w = (res[0] && res[0].wallet) || {};
      var entries = (res[1] && res[1].entries) || [];
      body.innerHTML = walletHTML(w, entries);
      var sb = body.querySelector("#dqw-send"); if (sb) sb.onclick = function () { sendForm(body, reload); };
      var rb = body.querySelector("#dqw-recv"); if (rb) rb.onclick = function () { receiveView(body, reload); };
    }).catch(function (e) {
      body.innerHTML = errBox(errMsg(e)) +
        '<div style="text-align:center;margin-top:12px"><button id="dqw-retry" class="pb" type="button" style="padding:10px 22px">Retry</button></div>';
      var rt = body.querySelector("#dqw-retry"); if (rt) rt.onclick = reload;
    });
  }

  // --- public entry --------------------------------------------------------
  function openWallet() {
    if (typeof modal !== "function") { return; }
    modal("QNTM Wallet", function (body /*, close */) { loadWallet(body); });
  }

  window.openWallet = openWallet;
})();
