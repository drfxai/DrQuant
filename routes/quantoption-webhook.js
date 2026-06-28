// routes/quantoption-webhook.js
// ----------------------------------------------------------------------------
// Quant Option DEDICATED webhook — the URL the admin pastes into a God Mode
// TradingView alarm. Mounted BEFORE express.json() in server.js:
//     app.use("/api/quantoption/webhook", require("./routes/quantoption-webhook"));
//
// It captures its OWN raw body (like routes/easytrade-webhook.js) so the global
// JSON parser never sees a plain-text Pine alert. Accepts EITHER:
//   • clean JSON: { secret, signal_id, event, symbol, direction, entry, sl, tp1, tp2, tp3, price, result, tf }
//   • GOD MODE tag-in-text: any body containing [[DRFX]]{...}[[/DRFX]] (same field names → maps 1:1)
//
// Secret may be in the body (`secret`), the URL (`?s=` / `?secret=` / `?key=`),
// or an `X-Webhook-Secret` header — so the indicator's formatted alert text
// (which carries no secret) can still authenticate via the URL token, which is
// what makes the webhook copy-paste friendly.
//
// Secret source (first set wins): QUANTOPTION_WEBHOOK_SECRET, else the existing
// EASYTRADE_WEBHOOK_SECRET / TRADINGVIEW_WEBHOOK_SECRET — so a single God Mode
// alarm can feed BOTH Easy Trade and Quant Option with one secret if desired.
//
// This route only WRITES to the Quant Option signal store; it never settles
// Easy Trade. Settlement of bound positions happens inside ingestSignalEvent.
// ----------------------------------------------------------------------------
"use strict";

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const quantoptionSignals = require("../services/quantoption-signals");

const WEBHOOK_SECRET =
  process.env.QUANTOPTION_WEBHOOK_SECRET ||
  process.env.EASYTRADE_WEBHOOK_SECRET ||
  process.env.TRADINGVIEW_WEBHOOK_SECRET ||
  "";

// This router owns its body: capture it as raw text for any content type.
router.use(express.text({ type: "*/*", limit: "32kb" }));

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const DRFX_TAG = /\[\[DRFX\]\]([\s\S]*?)\[\[\/DRFX\]\]/;
function parseTag(text) {
  const m = String(text || "").match(DRFX_TAG);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}
function extractPayload(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  try { const o = JSON.parse(s); if (o && typeof o === "object") return o; } catch (e) {}
  return parseTag(s);
}

// Accept both /api/quantoption/webhook and /api/quantoption/webhook/:token
// (the token, if present, is just an alternate place to carry the secret).
router.post(["/", "/:token"], async (req, res) => {
  try {
    if (!WEBHOOK_SECRET) return res.status(503).json({ error: "Quant Option webhook not configured (set QUANTOPTION_WEBHOOK_SECRET)" });
    const payload = extractPayload(typeof req.body === "string" ? req.body : "") || {};
    const secret = payload.secret || req.params.token || req.query.s || req.query.secret || req.query.key || req.get("X-Webhook-Secret") || "";
    if (!secret || !timingSafeEqual(secret, WEBHOOK_SECRET)) return res.status(401).json({ error: "bad secret" });
    if (!payload.event) return res.status(400).json({ error: "no event — send clean JSON or a [[DRFX]] tag" });
    const out = await quantoptionSignals.ingestSignalEvent(payload);
    res.json(out || { ok: true });
  } catch (e) {
    console.error("[quantoption] webhook:", e.message);
    res.status(500).json({ error: "webhook error" });
  }
});

module.exports = router;
