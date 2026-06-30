// routes/leagues.js
// ----------------------------------------------------------------------------
// Leagues + League Unlock Ritual API. Mount in server.js WRAPPED (so a problem
// here can never crash boot) and BEFORE the SPA catch-all:
//
//   try { app.use("/api/leagues", require("./routes/leagues")); }
//   catch (e) { console.error("Leagues route disabled:", e.message); }
//
// Endpoints (all require a logged-in user; the admin route also requires admin):
//   GET  /api/leagues                      -> the 11 league definitions + thresholds + stake_for_unlock
//   GET  /api/leagues/me                   -> caller's status (ID-card view) incl. any in-progress ritual
//   POST /api/leagues/:id/unlock           -> start the 7-day unlock ritual for league :id (locks QNTM)
//   POST /api/leagues/ritual/:rid/claim    -> finalize a matured ritual (returns tokens, unlocks league)
//   GET  /api/leagues/admin/rituals        -> ADMIN: full ritual oversight + chart series
//
// League math lives in services/leagues.js; the ritual lifecycle in
// services/league-rituals.js. This router is a thin surface over both.
// ----------------------------------------------------------------------------
"use strict";

const express = require("express");
const router = express.Router();
const leagues = require("../services/leagues");
const rituals = require("../services/league-rituals");

// Auth for every route here (same pattern as routes/signals.js / manage.js).
router.use((req, res, next) => req.app.get("authMiddleware")(req, res, next));

function fail(res, e) {
  const status = (e && e.status) || 500;
  if (status >= 500) console.error("[leagues] route error:", e && e.message);
  res.status(status).json({ error: (e && e.code) || "leagues_error", message: (e && e.message) || "error" });
}

// GET /api/leagues — the fixed league ladder.
router.get("/", async (req, res) => {
  try {
    const defs = await leagues.listDefinitions();
    res.json({
      leagues: defs.map((d) => ({
        id: d.id,
        name: d.name,
        earnedThreshold: Number(d.earned_threshold_qntm),
        stakeForUnlock: Number(d.stake_for_unlock_qntm),
      })),
    });
  } catch (e) { fail(res, e); }
});

// GET /api/leagues/me — the caller's status for the ID card / league screen.
router.get("/me", async (req, res) => {
  try {
    res.json(await leagues.getStatus(req.user.id, req.user.role === "admin"));
  } catch (e) { fail(res, e); }
});

// GET /api/leagues/admin/rituals — ADMIN oversight (totals, per-league, recent, chart).
router.get("/admin/rituals", (req, res, next) => req.app.get("adminMiddleware")(req, res, next), async (req, res) => {
  try {
    res.json(await rituals.adminStats());
  } catch (e) { fail(res, e); }
});

// POST /api/leagues/ritual/:rid/claim — finalize a matured ritual.
router.post("/ritual/:rid/claim", async (req, res) => {
  try {
    const result = await rituals.claimRitual(req.user.id, req.params.rid);
    // Push the celebratory welcome to the user's open clients.
    try { req.app.get("io").to("user_" + result.userId).emit("league_unlocked", result); } catch (_) {}
    res.json({ ok: true, ...result });
  } catch (e) { fail(res, e); }
});

// POST /api/leagues/:id/unlock — start the 7-day unlock ritual for league :id.
router.post("/:id/unlock", async (req, res) => {
  try {
    res.status(201).json(await rituals.startRitual(req.user.id, req.params.id, req.user.role === "admin"));
  } catch (e) { fail(res, e); }
});

module.exports = router;
