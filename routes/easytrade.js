// routes/easytrade.js
// ----------------------------------------------------------------------------
// Easy Trade (Baby Trader) HTTP surface.
//
// Mounted in server.js AFTER express.json():
//     app.use("/api/easytrade", require("./routes/easytrade"));
//
// User API (host JWT auth):
//   GET  /api/easytrade/houses          list signal houses (+ live stats)
//   GET  /api/easytrade/me              wallet balance + pool + open ticket
//   POST /api/easytrade/bet             { houseId, stake, pick:'TP'|'SL' }  → ticket
//   GET  /api/easytrade/ticket/:id      poll a ticket (+ round + ticks for the chart)
//   POST /api/easytrade/ticket/:id/cancel   refund an unbound pending ticket
//
// Admin (host JWT auth + admin):
//   POST /api/easytrade/admin/fund      { amount }   treasury → Easy Trade pool
//
// Dedicated webhook (NO user auth — a shared secret in the body, house in URL):
//   POST /api/easytrade/webhook/:houseId
//     { secret, signal_id, event, symbol, direction, entry, sl, tp1, tp2, tp3, price, result, tf }
//   `event` ∈ entry | tp1 | tp2 | tp3 | sl | close | price. A round opens on
//   `entry` and settles on a terminal event carrying `result: win|loss`. This is
//   the SAME payload shape as the GOD MODE [[DRFX]] tag, so the v0.7.7 indicator
//   can drive Easy Trade by pointing its webhook at this URL with a house id.
// ----------------------------------------------------------------------------
"use strict";

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const easytrade = require("../services/easytrade");

const WEBHOOK_SECRET = process.env.EASYTRADE_WEBHOOK_SECRET || process.env.TRADINGVIEW_WEBHOOK_SECRET || "";

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
const auth = (req, res, next) => req.app.get("authMiddleware")(req, res, next);
const admin = (req, res, next) => req.app.get("adminMiddleware")(req, res, next);

function fail(res, err) {
  const code = err && err.code;
  const map = { bad_pick: 400, bad_stake: 400, no_house: 404, has_open: 409, capacity: 409,
    insufficient: 402, not_found: 404, locked: 409, bad_amount: 400 };
  const status = map[code] || 500;
  if (status === 500) console.error("[easytrade]", err);
  res.status(status).json({ error: (err && err.message) || "Easy Trade error", code: code || null });
}

// ── dedicated webhook (must be declared before the auth'd routes) ───────────
router.post("/webhook/:houseId", async (req, res) => {
  try {
    if (!WEBHOOK_SECRET) return res.status(503).json({ error: "Easy Trade webhook not configured" });
    const body = req.body || {};
    if (!body.secret || !timingSafeEqual(body.secret, WEBHOOK_SECRET)) {
      return res.status(401).json({ error: "bad secret" });
    }
    const out = await easytrade.ingestEvent(String(req.params.houseId), body);
    res.json(out || { ok: true });
  } catch (e) {
    console.error("[easytrade] webhook:", e.message);
    res.status(500).json({ error: "webhook error" });
  }
});

// ── user API ────────────────────────────────────────────────────────────────
router.get("/houses", auth, async (req, res) => {
  try { res.json({ houses: await easytrade.listHouses() }); }
  catch (e) { fail(res, e); }
});

router.get("/me", auth, async (req, res) => {
  try { res.json(await easytrade.me(req.user.id)); }
  catch (e) { fail(res, e); }
});

router.post("/bet", auth, async (req, res) => {
  try {
    const { houseId, stake, pick } = req.body || {};
    const ticket = await easytrade.placeBet(req.user.id, String(houseId || ""), stake, pick);
    res.status(201).json({ ticket });
  } catch (e) { fail(res, e); }
});

router.get("/ticket/:id", auth, async (req, res) => {
  try {
    const ticket = await easytrade.getTicket(req.user.id, Number(req.params.id));
    if (!ticket) return res.status(404).json({ error: "ticket not found" });
    res.json({ ticket });
  } catch (e) { fail(res, e); }
});

router.post("/ticket/:id/cancel", auth, async (req, res) => {
  try { res.json(await easytrade.cancelTicket(req.user.id, Number(req.params.id))); }
  catch (e) { fail(res, e); }
});

// ── admin ─────────────────────────────────────────────────────────────────
router.post("/admin/fund", auth, admin, async (req, res) => {
  try {
    const { amount } = req.body || {};
    res.json(await easytrade.fundPool(amount, req.user.id));
  } catch (e) { fail(res, e); }
});

module.exports = router;
