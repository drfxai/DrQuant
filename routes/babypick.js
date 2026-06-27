// routes/babypick.js
// ----------------------------------------------------------------------------
// Baby Pick (the games half of Easy Trade) user + admin API.
//
// Mounted in server.js AFTER express.json():
//     app.use("/api/babypick", require("./routes/babypick"));
//
// User API (host JWT auth):
//   GET  /api/babypick/me                wallet balance + pool + open round + symbols
//   GET  /api/babypick/config            min/max, payout, round length, symbols, fairness
//   POST /api/babypick/quick/bet         { symbol, pick:'UP'|'DOWN', stake, clientSeed? } → round
//   GET  /api/babypick/quick/:id         poll a round (auto-settles once its 60s elapses)
//   GET  /api/babypick/quick/history     a player's Quick Signal history + P/L
//   GET  /api/babypick/quick/:id/fairness  commit + (post-settle) reveal to verify
//
// Admin (host JWT auth + admin):
//   POST /api/babypick/admin/fund        { amount }   treasury → Baby Pick pool
//   GET  /api/babypick/admin/pool        pool balance, exposure, headroom, counts
// ----------------------------------------------------------------------------
"use strict";

const express = require("express");
const router = express.Router();
const babypick = require("../services/babypick");

const auth = (req, res, next) => req.app.get("authMiddleware")(req, res, next);
const admin = (req, res, next) => req.app.get("adminMiddleware")(req, res, next);

function fail(res, err) {
  const code = err && err.code;
  const map = { bad_symbol: 400, bad_pick: 400, bad_stake: 400, has_open: 409, capacity: 409,
    insufficient: 402, not_found: 404, bad_amount: 400 };
  const status = map[code] || 500;
  if (status === 500) console.error("[babypick]", err);
  res.status(status).json({ error: (err && err.message) || "Baby Pick error", code: code || null });
}

// ── user API ────────────────────────────────────────────────────────────────
router.get("/me", auth, async (req, res) => {
  try { res.json(await babypick.me(req.user.id)); }
  catch (e) { fail(res, e); }
});

router.get("/config", auth, async (req, res) => {
  try { res.json(babypick.config()); }
  catch (e) { fail(res, e); }
});

router.post("/quick/bet", auth, async (req, res) => {
  try {
    const { symbol, pick, stake, clientSeed } = req.body || {};
    res.status(201).json({ round: await babypick.placeQuick(req.user.id, { symbol, pick, stake, clientSeed }) });
  } catch (e) { fail(res, e); }
});

// NOTE: /quick/history is declared BEFORE /quick/:id so "history" isn't captured as an :id
router.get("/quick/history", auth, async (req, res) => {
  try { res.json(await babypick.historyQuick(req.user.id, req.query.limit, req.query.offset)); }
  catch (e) { fail(res, e); }
});

router.get("/quick/:id/fairness", auth, async (req, res) => {
  try { res.json(await babypick.fairness(req.user.id, req.params.id)); }
  catch (e) { fail(res, e); }
});

router.get("/quick/:id", auth, async (req, res) => {
  try {
    const round = await babypick.getQuick(req.user.id, req.params.id);
    if (!round) return res.status(404).json({ error: "round not found", code: "not_found" });
    res.json({ round });
  } catch (e) { fail(res, e); }
});

// ── admin ─────────────────────────────────────────────────────────────────
router.post("/admin/fund", auth, admin, async (req, res) => {
  try { res.json(await babypick.fundPool(req.body && req.body.amount, req.user.id)); }
  catch (e) { fail(res, e); }
});
router.get("/admin/pool", auth, admin, async (req, res) => {
  try { res.json(await babypick.poolStats()); }
  catch (e) { fail(res, e); }
});

module.exports = router;
