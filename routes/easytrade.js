// routes/easytrade.js
// ----------------------------------------------------------------------------
// Easy Trade (Baby Trader) user + admin API.
//
// Mounted in server.js AFTER express.json():
//     app.use("/api/easytrade", require("./routes/easytrade"));
//
// The dedicated webhook lives in routes/easytrade-webhook.js and is mounted
// BEFORE express.json() (it captures its own raw body). See that file.
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
//   GET  /api/easytrade/admin/pool      pool balance, exposure, headroom, counts
//   GET  /api/easytrade/admin/rounds    currently-open rounds
// ----------------------------------------------------------------------------
"use strict";

const express = require("express");
const router = express.Router();
const easytrade = require("../services/easytrade");

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

router.get("/admin/pool", auth, admin, async (req, res) => {
  try { res.json(await easytrade.poolStats()); }
  catch (e) { fail(res, e); }
});

router.get("/admin/rounds", auth, admin, async (req, res) => {
  try { res.json({ rounds: await easytrade.listOpenRounds() }); }
  catch (e) { fail(res, e); }
});

module.exports = router;
