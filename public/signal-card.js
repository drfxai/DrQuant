/* ============================================================================
   DrFX Quant — In-chat "Auto-detected signal" advisory chip
   ----------------------------------------------------------------------------
   Loaded in the browser as /signal-card.js. Exposes window.dqSignalChip(m),
   which msgBubble() calls to render a compact, expandable chip UNDER a chat
   bubble when the message looks like a trade call.

   Hard rules (project brief):
     • Advisory only. The original message stays primary; this is appended, not
       a rewrite. The chip is clearly labeled "Auto-detected … not the author's
       words, and not financial advice."
     • Detection logic lives in /signal-extract.js (window.DQSignal) — the SAME
       module the server uses for the derived feed, so chat and feed agree.

   Page globals reused (classic scripts share one lexical scope): t, esc, ic.
   ========================================================================== */
(function () {
  "use strict";

  function dqSignalChip(m) {
    if (typeof window === "undefined" || !window.DQSignal) return "";
    if (!m || !m.content || m.sender_role === "bot") return "";
    var sig;
    try { sig = window.DQSignal.extract(m.content); } catch (e) { return ""; }
    if (!sig) return "";

    var up = sig.direction === "long";
    var col = up ? "#34d27a" : "#ef4444";
    var dir = up ? "LONG" : "SHORT";
    var det = sig.level === "detected";
    var conf = Math.round((sig.confidence || 0) * 100);

    var rows = [];
    if (sig.entry != null) rows.push(["Entry", sig.entry]);
    if (sig.sl != null) rows.push(["Stop loss", sig.sl]);
    if (sig.tp != null) rows.push(["Take profit", sig.tp]);
    var rowsHtml = rows.length
      ? rows.map(function (r) {
          return '<div style="display:flex;justify-content:space-between;gap:12px;font-size:12px;padding:2px 0">' +
            '<span style="color:' + t.t3 + '">' + r[0] + '</span>' +
            '<span style="color:' + t.t1 + ';font-weight:700;font-family:ui-monospace,monospace">' + esc(String(r[1])) + '</span></div>';
        }).join("")
      : '<div style="color:' + t.t4 + ';font-size:11.5px">Symbol &amp; direction only — no entry/SL/TP parsed.</div>';

    var caret = ic('<polyline points="9 18 15 12 9 6"/>', 13);
    var spark = ic('<path d="M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 20V4"/>', 12);

    return '' +
      '<div class="dqsig" style="margin-top:5px;border:1px solid ' + col + '44;background:' + col + '12;border-radius:11px;padding:8px 10px;max-width:100%;-webkit-user-select:none;user-select:none">' +
        '<div class="dqsig-head" style="display:flex;align-items:center;gap:7px;cursor:pointer">' +
          '<span style="display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center;border-radius:5px;background:' + col + '26;color:' + col + ';flex-shrink:0">' + spark + '</span>' +
          '<span style="font-size:11px;font-weight:800;letter-spacing:.4px;color:' + col + '">' + dir + '</span>' +
          '<span style="font-size:12px;font-weight:700;color:' + t.t1 + ';font-family:ui-monospace,monospace">' + esc(sig.symbol) + '</span>' +
          (sig.entry != null ? '<span style="font-size:11.5px;color:' + t.t2 + ';font-family:ui-monospace,monospace">@ ' + esc(String(sig.entry)) + '</span>' : '') +
          '<span style="flex:1"></span>' +
          '<span style="font-size:9px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;white-space:nowrap;color:' + (det ? col : t.t3) + ';background:' + (det ? col + '1f' : t.ta) + ';padding:2px 6px;border-radius:5px">' + (det ? 'Detected' : 'Possible') + '</span>' +
          '<span class="dqsig-caret" style="display:inline-flex;color:' + t.t4 + ';transition:transform .15s">' + caret + '</span>' +
        '</div>' +
        '<div class="dqsig-body" style="display:none;margin-top:7px;padding-top:7px;border-top:1px solid ' + t.bd + '">' +
          rowsHtml +
          '<div style="color:' + t.t4 + ';font-size:10.5px;margin-top:7px;line-height:1.5">Auto-detected by DrFX from this message · ' + conf + '% match. A platform interpretation — not the author\'s words, and not financial advice.</div>' +
        '</div>' +
      '</div>';
  }

  // One global delegated toggle for every chip (chat now, feed later). Callers
  // render the markup and never wire anything. Guarded against double-binding.
  if (typeof document !== "undefined" && !window.__dqSigChipBound) {
    window.__dqSigChipBound = true;
    document.addEventListener("click", function (e) {
      var head = e.target && e.target.closest ? e.target.closest(".dqsig-head") : null;
      if (!head) return;
      var card = head.parentNode;
      var body = card && card.querySelector ? card.querySelector(".dqsig-body") : null;
      if (!body) return;
      var open = body.style.display !== "none";
      body.style.display = open ? "none" : "block";
      var car = head.querySelector(".dqsig-caret");
      if (car) car.style.transform = open ? "" : "rotate(90deg)";
    });
  }

  if (typeof window !== "undefined") window.dqSignalChip = dqSignalChip;
})();
