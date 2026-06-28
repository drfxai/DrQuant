// routes/quantoption.js
// ----------------------------------------------------------------------------
// Quant Option — server-authoritative, wallet-connected options simulation.
//
// Mounted in server.js AFTER express.json():
//     app.use("/api/quantoption", require("./routes/quantoption"));
//
// User API (host JWT auth):
//   GET  /api/quantoption/me                wallet + pool + open position + config
//   POST /api/quantoption/open              { symbol, direction, expirySec, stake } → position
//   GET  /api/quantoption/position/:id      poll a position (live price + ticks; settles if matured)
//   GET  /api/quantoption/history           past positions + lifetime P/L
//   GET  /api/quantoption/leaderboard       ranked players (sort=xp|winrate|wins|tokens)
//
// Admin (host JWT auth + admin):
//   POST /api/quantoption/admin/fund        { amount }   treasury → Quant Option pool
//   GET  /api/quantoption/admin/pool        pool balance, exposure, headroom, counts
// ----------------------------------------------------------------------------
"use strict";

const express = require("express");
const router = express.Router();
const quantoption = require("../services/quantoption");

const auth = (req, res, next) => req.app.get("authMiddleware")(req, res, next);
const admin = (req, res, next) => req.app.get("adminMiddleware")(req, res, next);

function fail(res, err) {
  const code = err && err.code;
  const map = {
    bad_symbol: 400, bad_dir: 400, bad_expiry: 400, bad_stake: 400, bad_amount: 400,
    has_open: 409, capacity: 409, insufficient: 402, not_found: 404,
  };
  const status = map[code] || 500;
  if (status === 500) console.error("[quantoption]", err);
  res.status(status).json({ error: (err && err.message) || "Quant Option error", code: code || null });
}

// ── user API ────────────────────────────────────────────────────────────────
router.get("/me", auth, async (req, res) => {
  try { res.json(await quantoption.me(req.user.id)); }
  catch (e) { fail(res, e); }
});

router.post("/open", auth, async (req, res) => {
  try {
    const position = await quantoption.openPosition(req.user.id, req.body || {});
    res.status(201).json({ position });
  } catch (e) { fail(res, e); }
});

router.get("/position/:id", auth, async (req, res) => {
  try {
    const position = await quantoption.getPosition(req.user.id, Number(req.params.id));
    if (!position) return res.status(404).json({ error: "position not found", code: "not_found" });
    res.json({ position });
  } catch (e) { fail(res, e); }
});

router.get("/history", auth, async (req, res) => {
  try { res.json(await quantoption.history(req.user.id, req.query.limit, req.query.offset)); }
  catch (e) { fail(res, e); }
});

router.get("/leaderboard", auth, async (req, res) => {
  try { res.json(await quantoption.leaderboard({ sort: req.query.sort, limit: req.query.limit, viewerId: req.user.id })); }
  catch (e) { fail(res, e); }
});

// ── admin ─────────────────────────────────────────────────────────────────
router.post("/admin/fund", auth, admin, async (req, res) => {
  try {
    const { amount } = req.body || {};
    res.json(await quantoption.fundPool(amount, req.user.id));
  } catch (e) { fail(res, e); }
});

router.get("/admin/pool", auth, admin, async (req, res) => {
  try { res.json(await quantoption.poolStats()); }
  catch (e) { fail(res, e); }
});

module.exports = router;
