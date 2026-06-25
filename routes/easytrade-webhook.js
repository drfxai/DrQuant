// routes/easytrade-webhook.js
// ----------------------------------------------------------------------------
// Easy Trade dedicated webhook — mounted BEFORE express.json() in server.js:
//     app.use("/api/easytrade/webhook", require("./routes/easytrade-webhook"));
//
// It captures its OWN raw body (like routes/webhooks.js) so the global JSON
// parser never sees it. That matters because TradingView is inconsistent about
// the Content-Type it sends: a plain-text GOD MODE alert body labelled
// application/json would make the global parser throw a 400 before this handler
// ever ran. Capturing the body here sidesteps that entirely.
//
//   POST /api/easytrade/webhook/:houseId
//   Accepts EITHER:
//     • clean JSON:  { secret, signal_id, event, symbol, direction, entry, sl, tp1, tp2, tp3, price, result, tf }
//     • GOD MODE tag-in-text: any text body containing [[DRFX]]{...}[[/DRFX]]
//       (the v0.7.7 indicator's hidden tag — same field names, so it maps 1:1)
//   Secret may be in the body (`secret`), the URL (`?s=` / `?secret=` / `?key=`),
//   or an `X-Webhook-Secret` header — so an alert that fires the indicator's
//   formatted text (which carries no secret) can authenticate via the URL.
// ----------------------------------------------------------------------------
"use strict";

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const easytrade = require("../services/easytrade");

const WEBHOOK_SECRET = process.env.EASYTRADE_WEBHOOK_SECRET || process.env.TRADINGVIEW_WEBHOOK_SECRET || "";

// Capture the body as raw text for any content type (this router owns it).
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
  // clean JSON first (works whether sent as application/json or text/plain)…
  try { const o = JSON.parse(s); if (o && typeof o === "object") return o; } catch (e) {}
  // …otherwise pull the GOD MODE [[DRFX]] tag out of the formatted alert text.
  return parseTag(s);
}

router.post("/:houseId", async (req, res) => {
  try {
    if (!WEBHOOK_SECRET) return res.status(503).json({ error: "Easy Trade webhook not configured" });
    const payload = extractPayload(typeof req.body === "string" ? req.body : "") || {};
    const secret = payload.secret || req.query.s || req.query.secret || req.query.key || req.get("X-Webhook-Secret") || "";
    if (!secret || !timingSafeEqual(secret, WEBHOOK_SECRET)) return res.status(401).json({ error: "bad secret" });
    if (!payload.event) return res.status(400).json({ error: "no event — send clean JSON or a [[DRFX]] tag" });
    const out = await easytrade.ingestEvent(String(req.params.houseId), payload);
    res.json(out || { ok: true });
  } catch (e) {
    console.error("[easytrade] webhook:", e.message);
    res.status(500).json({ error: "webhook error" });
  }
});

module.exports = router;
