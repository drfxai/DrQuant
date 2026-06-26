// routes/leagues.js
// ----------------------------------------------------------------------------
// Read-only Leagues API. Mount in server.js WRAPPED so a problem here can never
// crash boot (same pattern as routes/share), and BEFORE the SPA catch-all:
//
//   try { app.use("/api/leagues", require("./routes/leagues")); }
//   catch (e) { console.error("Leagues route disabled:", e.message); }
//
// Endpoints (any logged-in user):
//   GET /api/leagues      -> the 11 league definitions + thresholds.
//   GET /api/leagues/me   -> the caller's league status (ID-card view): lifetime
//                            earned, locked stake, current/highest league, and a
//                            per-league Locked/Qualified/Active breakdown.
//
// All league math + the user_league_status row live in services/leagues.js;
// this router is a thin read surface over it.
// ----------------------------------------------------------------------------
"use strict";

const express = require("express");
const router = express.Router();
const leagues = require("../services/leagues");

// Auth for every route here (same pattern as routes/signals.js / manage.js).
router.use((req, res, next) => req.app.get("authMiddleware")(req, res, next));

// GET /api/leagues — the fixed league ladder.
router.get("/", async (req, res) => {
  try {
    const defs = await leagues.listDefinitions();
    res.json({
      leagues: defs.map((d) => ({
        id: d.id,
        name: d.name,
        earnedThreshold: Number(d.earned_threshold_qntm),
        stakeThreshold: Number(d.stake_threshold_qntm),
      })),
    });
  } catch (e) {
    console.error("[leagues] GET / failed:", e && e.message);
    res.status(500).json({ error: "leagues_unavailable" });
  }
});

// GET /api/leagues/me — the caller's status for the ID card / profile.
router.get("/me", async (req, res) => {
  try {
    const status = await leagues.getStatus(req.user.id);
    res.json(status);
  } catch (e) {
    console.error("[leagues] GET /me failed:", e && e.message);
    res.status(500).json({ error: "leagues_unavailable" });
  }
});

module.exports = router;
