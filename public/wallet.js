"use strict";
/* ============================================================================
 * wallet.js — QNTM Wallet UI for DrFX Quant
 *
 * A self-contained wallet section that surfaces the authoritative qntm-ledger
 * balance + history and lets a user send QNTM to another user. It reuses the
 * host SPA's globals (S, api, modal, esc, ic, showToast, fmtTime), which are
 * reachable here because this is a classic <script> loaded after the main one.
 * Exposes window.openWallet().
 *
 * THEME: the wallet is SELF-SKINNING. It does not use the global `t` palette;
 * instead it carries its own GenyPick-inspired neon palette `WT`, with a dark
 * variant (near-black emerald, matching the reference) and a light variant
 * (emerald-on-light). It switches off the host app's S.theme so toggling the
 * app theme re-skins the wallet too — without affecting the rest of the app.
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
  // --- self-contained GenyPick neon palette --------------------------------
  // emerald = primary, amber/gold = secondary, exactly like the reference.
  var THEMES = {
    dark: {
      n: "dark",
      bg: "radial-gradient(120% 90% at 50% -10%,#08160f 0%,#040b08 55%,#020604 100%)",
      card: "rgba(10,22,17,.72)",          // glassy dark card
      cardB: "rgba(34,210,140,.16)",        // emerald hairline border
      cardG: "rgba(13,40,28,.5)",           // inner panel
      txt1: "#eafff5",                      // primary text / numbers
      txt2: "#9fc6b4",                      // body text (muted green-grey)
      txt3: "#6f937f",                      // labels
      txt4: "#557a66",                      // faint
      em: "#16e29a",                        // emerald primary (neon)
      emSoft: "rgba(22,226,154,.14)",       // emerald tint fill
      emGlow: "rgba(22,226,154,.55)",       // emerald glow
      gold: "#f5c451",                      // amber secondary
      goldSoft: "rgba(245,196,81,.14)",
      goldGlow: "rgba(245,196,81,.4)",
      grad: "linear-gradient(90deg,#0fd98a 0%,#36e36b 45%,#f5c451 100%)", // CTA
      gradGlow: "rgba(34,220,120,.5)",
      up: "#16e29a",                        // credit (incoming)
      down: "#7fe9c0",                      // debit accent
      shadow: "0 18px 50px rgba(0,0,0,.62)"
    },
    light: {
      n: "light",
      bg: "linear-gradient(160deg,#eafdf4 0%,#def7ec 45%,#d3f3e6 100%)",
      card: "rgba(255,255,255,.86)",
      cardB: "rgba(11,157,106,.22)",
      cardG: "rgba(224,247,236,.9)",
      txt1: "#08311f",
      txt2: "#3f6a55",
      txt3: "#5d8772",
      txt4: "#84a896",
      em: "#0b9d6a",                        // deeper emerald for light contrast
      emSoft: "rgba(11,157,106,.12)",
      emGlow: "rgba(11,157,106,.4)",
      gold: "#d99a18",                      // deeper amber on light
      goldSoft: "rgba(217,154,24,.14)",
      goldGlow: "rgba(217,154,24,.35)",
      grad: "linear-gradient(90deg,#0bbf7e 0%,#3fcf6a 45%,#e9b53f 100%)",
      gradGlow: "rgba(20,180,110,.4)",
      up: "#0b9d6a",
      down: "#0bbf7e",
      shadow: "0 14px 40px rgba(40,120,90,.18)"
    }
  };
  function W() {
    var n = (typeof S !== "undefined" && S.theme === "light") ? "light" : "dark";
    return THEMES[n];
  }

  // --- helpers -------------------------------------------------------------
  function errMsg(e) {
    return (e && e.error && (e.error.message || e.error.code)) ||
           (e && typeof e.error === "string" && e.error) ||
           (e && e.message) || "Something went wrong";
  }
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

  // Inject the wallet's scoped neon stylesheet once. Scoped to #dqw-root so it
  // never leaks into the rest of the app. Re-applied (id-guarded) on each open.
  function injectCSS() {
    var w = W();
    var css =
      '#dqw-root{position:relative;margin:-4px -2px 0;padding:14px 14px 6px;border-radius:20px;background:' + w.bg + ';overflow:hidden;font-family:\'Outfit\',sans-serif}' +
      '#dqw-root *{box-sizing:border-box}' +
      // ambient neon blobs behind everything
      '#dqw-root .dqw-amb{position:absolute;border-radius:50%;filter:blur(46px);pointer-events:none;z-index:0}' +
      '#dqw-root .dqw-amb1{top:-60px;right:-40px;width:200px;height:200px;background:radial-gradient(circle,' + w.emGlow + ',transparent 70%);opacity:.5;animation:dqwFloat 9s ease-in-out infinite}' +
      '#dqw-root .dqw-amb2{bottom:-70px;left:-50px;width:200px;height:200px;background:radial-gradient(circle,' + w.goldGlow + ',transparent 72%);opacity:.32;animation:dqwFloat 12s ease-in-out infinite reverse}' +
      '#dqw-root .dqw-in{position:relative;z-index:1}' +
      // balance card
      '#dqw-root .dqw-card{position:relative;overflow:hidden;border-radius:20px;padding:20px;margin-bottom:15px;background:' + w.card + ';border:1px solid ' + w.cardB + ';box-shadow:' + w.shadow + ',0 0 0 1px ' + w.emSoft + ',inset 0 1px 0 rgba(255,255,255,.05);-webkit-backdrop-filter:blur(16px) saturate(150%);backdrop-filter:blur(16px) saturate(150%);animation:dqwGlow 4.5s ease-in-out infinite}' +
      '#dqw-root .dqw-cardline{position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,' + w.em + ',transparent);opacity:.8}' +
      '#dqw-root .dqw-qbadge{width:38px;height:38px;border-radius:11px;background:' + w.emSoft + ';border:1px solid ' + w.cardB + ';display:flex;align-items:center;justify-content:center;color:' + w.em + ';font-size:17px;font-weight:800;box-shadow:0 0 16px ' + w.emGlow + ',inset 0 0 10px ' + w.emSoft + ';text-shadow:0 0 10px ' + w.emGlow + '}' +
      '#dqw-root .dqw-bal{color:' + w.txt1 + ';font-size:38px;font-weight:800;letter-spacing:-.5px;line-height:1;text-shadow:0 0 22px ' + w.emGlow + '}' +
      '#dqw-root .dqw-balq{font-size:15px;color:' + w.em + ';font-weight:700;margin-left:7px;text-shadow:0 0 12px ' + w.emGlow + '}' +
      // buttons
      '#dqw-root .dqw-send{flex:1;padding:14px;border:none;border-radius:13px;background:' + w.grad + ';color:#04140d;font-weight:800;font-size:14.5px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 8px 26px ' + w.gradGlow + ',0 0 18px ' + w.gradGlow + ';transition:transform .15s,box-shadow .2s}' +
      '#dqw-root .dqw-send:hover{transform:translateY(-1px);box-shadow:0 12px 32px ' + w.gradGlow + ',0 0 26px ' + w.gradGlow + '}' +
      '#dqw-root .dqw-send:active{transform:scale(.98)}' +
      '#dqw-root .dqw-recv{flex:1;padding:14px;border-radius:13px;border:1px solid ' + w.cardB + ';background:' + w.cardG + ';color:' + w.em + ';font-weight:700;font-size:14.5px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:inset 0 0 14px ' + w.emSoft + ';transition:transform .15s,box-shadow .2s,border-color .2s}' +
      '#dqw-root .dqw-recv:hover{transform:translateY(-1px);border-color:' + w.em + ';box-shadow:inset 0 0 14px ' + w.emSoft + ',0 0 16px ' + w.emGlow + '}' +
      '#dqw-root .dqw-recv:active{transform:scale(.98)}' +
      '#dqw-root .dqw-prim{width:100%;padding:15px;border:none;border-radius:13px;background:' + w.grad + ';color:#04140d;font-weight:800;font-size:15px;cursor:pointer;font-family:inherit;box-shadow:0 8px 26px ' + w.gradGlow + ',0 0 18px ' + w.gradGlow + ';transition:transform .15s}' +
      '#dqw-root .dqw-prim:hover{transform:translateY(-1px)}#dqw-root .dqw-prim:active{transform:scale(.98)}#dqw-root .dqw-prim:disabled{opacity:.6;cursor:wait;transform:none}' +
      // history rows
      '#dqw-root .dqw-row{display:flex;align-items:center;gap:12px;padding:11px;border-radius:13px;background:' + w.cardG + ';border:1px solid ' + w.cardB + ';margin-bottom:7px;transition:border-color .2s,box-shadow .2s}' +
      '#dqw-root .dqw-row:hover{border-color:' + w.em + ';box-shadow:0 0 14px ' + w.emSoft + '}' +
      '#dqw-root .dqw-ricon{width:36px;height:36px;border-radius:11px;display:flex;align-items:center;justify-content:center;flex-shrink:0}' +
      '#dqw-root .dqw-in-ic{background:' + w.emSoft + ';color:' + w.em + ';box-shadow:0 0 12px ' + w.emGlow + ',inset 0 0 8px ' + w.emSoft + '}' +
      '#dqw-root .dqw-out-ic{background:' + w.goldSoft + ';color:' + w.gold + ';box-shadow:0 0 12px ' + w.goldGlow + ',inset 0 0 8px ' + w.goldSoft + '}' +
      // inputs
      '#dqw-root .dqw-inp{width:100%;padding:13px 15px;border-radius:12px;background:' + w.cardG + ';border:1px solid ' + w.cardB + ';color:' + w.txt1 + ';font-size:15px;font-family:inherit;outline:none;transition:border-color .2s,box-shadow .2s;-webkit-appearance:none;appearance:none}' +
      '#dqw-root .dqw-inp:focus{border-color:' + w.em + ';box-shadow:0 0 0 3px ' + w.emSoft + ',0 0 16px ' + w.emGlow + '}' +
      '#dqw-root .dqw-inp::placeholder{color:' + w.txt4 + '}' +
      '#dqw-root .dqw-back{display:inline-flex;align-items:center;gap:5px;background:none;border:none;color:' + w.em + ';font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;padding:0;margin-bottom:8px;text-shadow:0 0 10px ' + w.emGlow + '}' +
      '#dqw-root .dqw-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;font-size:11px;font-weight:700;border:1px solid ' + w.cardB + ';background:' + w.emSoft + ';color:' + w.em + ';box-shadow:0 0 12px ' + w.emSoft + '}' +
      // keyframes
      '@keyframes dqwGlow{0%,100%{box-shadow:' + w.shadow + ',0 0 0 1px ' + w.emSoft + ',inset 0 1px 0 rgba(255,255,255,.05)}50%{box-shadow:' + w.shadow + ',0 0 26px ' + w.emGlow + ',inset 0 1px 0 rgba(255,255,255,.05)}}' +
      '@keyframes dqwFloat{0%,100%{transform:translate(0,0)}50%{transform:translate(0,-16px)}}' +
      '@keyframes dqwScan{0%{transform:translateX(-120%)}100%{transform:translateX(120%)}}';

    var el = document.getElementById("dqw-css");
    if (!el) { el = document.createElement("style"); el.id = "dqw-css"; document.head.appendChild(el); }
    el.textContent = css;
  }

  function errBox(msg) {
    return '<div style="padding:14px;border-radius:12px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#ff6b6b;font-size:13px;text-align:center;box-shadow:0 0 16px rgba(239,68,68,.18)">' + esc(msg) + '</div>';
  }
  function loader() {
    var w = W();
    return '<div id="dqw-root"><div class="dqw-amb dqw-amb1"></div><div class="dqw-in" style="text-align:center;color:' + w.em + ';padding:40px 0;animation:pu 1.5s infinite;text-shadow:0 0 12px ' + w.emGlow + '">Loading wallet…</div></div>';
  }

  // --- history row ---------------------------------------------------------
  function rowHTML(e) {
    var w = W();
    var credit = e.direction === "credit";
    var sign = credit ? "+" : "\u2212";
    var col = credit ? w.up : w.gold;
    var sub = (e.description ? esc(e.description) : typeLabel(e.txn_type)) +
              (e.created_at ? (" \u00b7 " + fmtTime(e.created_at)) : "");
    return '<div class="dqw-row">' +
      '<div class="dqw-ricon ' + (credit ? 'dqw-in-ic' : 'dqw-out-ic') + '">' + ic(credit ? ARROW_IN : ARROW_OUT, 18) + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="color:' + w.txt1 + ';font-size:13.5px;font-weight:600">' + typeLabel(e.txn_type) + '</div>' +
        '<div style="color:' + w.txt3 + ';font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + sub + '</div>' +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0">' +
        '<div style="color:' + col + ';font-size:14px;font-weight:700;text-shadow:0 0 10px ' + (credit ? w.emGlow : w.goldGlow) + '">' + sign + fmtQ(e.amount) + '</div>' +
        '<div style="color:' + w.txt4 + ';font-size:10px">' + esc(e.txn_status || "") + '</div>' +
      '</div>' +
    '</div>';
  }

  // --- main wallet view ----------------------------------------------------
  function walletHTML(w_, entries) {
    var w = W();
    var pend = w_.pending_balance, lock = w_.locked_balance;
    var extra = "";
    if (gt0(pend) || gt0(lock)) {
      var chips = [];
      if (gt0(pend)) chips.push('<span style="color:' + w.txt2 + '">Pending <b style="color:' + w.em + ';text-shadow:0 0 10px ' + w.emGlow + '">' + fmtQ(pend) + '</b></span>');
      if (gt0(lock)) chips.push('<span style="color:' + w.txt2 + '">Locked <b style="color:' + w.gold + ';text-shadow:0 0 10px ' + w.goldGlow + '">' + fmtQ(lock) + '</b></span>');
      extra = '<div style="position:relative;display:flex;gap:18px;margin-top:13px;font-size:12px">' + chips.join('') + '</div>';
    }

    var card =
      '<div class="dqw-card">' +
        '<div class="dqw-cardline"></div>' +
        '<div style="position:relative;display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">' +
          '<div style="display:flex;align-items:center;gap:11px">' +
            '<div class="dqw-qbadge">Q</div>' +
            '<div><div style="color:' + w.em + ';font-size:10px;letter-spacing:1.5px;font-weight:800;text-shadow:0 0 10px ' + w.emGlow + '">QNTM BALANCE</div><div style="color:' + w.txt3 + ';font-size:11px;font-weight:500">Internal platform credits</div></div>' +
          '</div>' +
          '<span class="dqw-pill">\u25CF Live</span>' +
        '</div>' +
        '<div style="position:relative" class="dqw-bal">' + fmtQ(w_.available_balance) + '<span class="dqw-balq">QNTM</span></div>' +
        extra +
      '</div>';

    var actions =
      '<div style="display:flex;gap:11px;margin-bottom:18px">' +
        '<button id="dqw-send" class="dqw-send" type="button">' + ic(SEND_ICON, 18) + ' Send</button>' +
        '<button id="dqw-recv" class="dqw-recv" type="button">' + ic(ARROW_IN, 18) + ' Receive</button>' +
      '</div>';

    var hist;
    if (entries && entries.length) {
      hist = '<div style="max-height:40vh;overflow-y:auto;-webkit-overflow-scrolling:touch">' + entries.map(rowHTML).join('') + '</div>';
    } else {
      hist = '<div style="text-align:center;padding:24px 12px;color:' + w.txt3 + '">' +
        '<div style="font-size:32px;margin-bottom:8px;color:' + w.em + ';text-shadow:0 0 18px ' + w.emGlow + '">\u25C8</div>' +
        '<div style="font-size:13px;color:' + w.txt2 + ';font-weight:600">No transactions yet</div>' +
        '<div style="font-size:11.5px;color:' + w.txt4 + ';margin-top:4px;line-height:1.5">QNTM you receive from grants, transfers,<br>or the marketplace will show up here.</div>' +
      '</div>';
    }

    return '<div id="dqw-root">' +
      '<div class="dqw-amb dqw-amb1"></div><div class="dqw-amb dqw-amb2"></div>' +
      '<div class="dqw-in">' +
        card + actions +
        '<div style="color:' + w.txt2 + ';font-size:12px;font-weight:700;margin-bottom:10px;letter-spacing:.3px">Recent activity</div>' +
        '<div id="dqw-hist">' + hist + '</div>' +
        '<div style="text-align:center;margin-top:20px;padding:6px 0 2px">' +
          '<div style="color:' + w.txt3 + ';font-size:12px;font-weight:500">The future of trading starts here.</div>' +
          '<div style="font-size:15px;font-weight:800;letter-spacing:.4px;margin-top:3px;background:' + w.grad + ';-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:' + w.em + ';filter:drop-shadow(0 0 10px ' + w.emGlow + ')">Build. Trade. Win.</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // --- send (transfer) form ------------------------------------------------
  function sendForm(body, reload) {
    var w = W();
    var lbl = 'color:' + w.txt2 + ';font-size:11px;font-weight:700;letter-spacing:.5px;display:block;margin:13px 2px 6px';
    body.innerHTML =
      '<div id="dqw-root"><div class="dqw-amb dqw-amb1"></div><div class="dqw-in">' +
        '<button id="dqw-back" class="dqw-back" type="button">' + ic('<polyline points="15 18 9 12 15 6"/>', 16) + ' Wallet</button>' +
        '<div style="color:' + w.txt1 + ';font-size:17px;font-weight:800;margin-bottom:2px;text-shadow:0 0 14px ' + w.emGlow + '">Send QNTM</div>' +
        '<div style="color:' + w.txt3 + ';font-size:12px;margin-bottom:8px">Transfer credits to another member by their user ID.</div>' +
        '<label style="' + lbl + '">Recipient user ID</label>' +
        '<input id="dqw-to" class="dqw-inp" placeholder="e.g. 1042" autocomplete="off"/>' +
        '<label style="' + lbl + '">Amount</label>' +
        '<input id="dqw-amt" class="dqw-inp" inputmode="decimal" placeholder="0.00"/>' +
        '<label style="' + lbl + '">Note (optional)</label>' +
        '<input id="dqw-note" class="dqw-inp" maxlength="140" placeholder="What\'s this for?"/>' +
        '<div id="dqw-msg" style="margin-top:10px"></div>' +
        '<button id="dqw-do" class="dqw-prim" type="button" style="margin-top:14px">Send QNTM</button>' +
      '</div></div>';

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
    var w = W();
    var myId = (typeof S !== "undefined" && S.user && S.user.id != null) ? String(S.user.id) : "";
    body.innerHTML =
      '<div id="dqw-root"><div class="dqw-amb dqw-amb1"></div><div class="dqw-amb dqw-amb2"></div><div class="dqw-in">' +
        '<button id="dqw-back2" class="dqw-back" type="button">' + ic('<polyline points="15 18 9 12 15 6"/>', 16) + ' Wallet</button>' +
        '<div style="color:' + w.txt1 + ';font-size:17px;font-weight:800;margin-bottom:2px;text-shadow:0 0 14px ' + w.emGlow + '">Receive QNTM</div>' +
        '<div style="color:' + w.txt3 + ';font-size:12px;margin-bottom:16px">Share your user ID so other members can send you QNTM.</div>' +
        '<div style="position:relative;text-align:center;padding:24px 20px;border-radius:16px;background:' + w.card + ';border:1px solid ' + w.cardB + ';box-shadow:0 0 24px ' + w.emSoft + ',inset 0 0 18px ' + w.emSoft + '">' +
          '<div class="dqw-cardline"></div>' +
          '<div style="color:' + w.em + ';font-size:11px;letter-spacing:1px;font-weight:800;margin-bottom:10px;text-shadow:0 0 10px ' + w.emGlow + '">YOUR USER ID</div>' +
          '<div style="color:' + w.txt1 + ';font-size:28px;font-weight:800;letter-spacing:.5px;word-break:break-all;text-shadow:0 0 20px ' + w.emGlow + '">' + esc(myId || "\u2014") + '</div>' +
        '</div>' +
        '<button id="dqw-copy" class="dqw-prim" type="button" style="margin-top:16px">Copy ID</button>' +
      '</div></div>';
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
    injectCSS();
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
      body.innerHTML = '<div id="dqw-root"><div class="dqw-in">' + errBox(errMsg(e)) +
        '<div style="text-align:center;margin-top:12px"><button id="dqw-retry" class="dqw-prim" type="button" style="width:auto;padding:11px 24px">Retry</button></div></div></div>';
      var rt = body.querySelector("#dqw-retry"); if (rt) rt.onclick = reload;
    });
  }

  // --- public entry --------------------------------------------------------
  function openWallet() {
    if (typeof modal !== "function") { return; }
    injectCSS();
    modal("QNTM Wallet", function (body /*, close */) { loadWallet(body); });
  }

  window.openWallet = openWallet;
})();
