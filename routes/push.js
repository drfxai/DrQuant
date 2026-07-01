// routes/push.js — Web Push subscription management for the authenticated user.
const express = require("express");
const router = express.Router();

// Same auth gate the other API routes use (populates req.user).
router.use((req, res, next) => req.app.get("authMiddleware")(req, res, next));

const push = require("../services/push");

// Public VAPID key so the client can build a push subscription.
router.get("/vapid-public-key", (req, res) => {
  const k = push.publicKey();
  if (!k) return res.status(503).json({ error: "Push not configured" });
  res.json({ key: k });
});

// Save (upsert) a subscription for the current user. Keyed on endpoint so the
// same device re-subscribing just refreshes its keys/owner.
router.post("/subscribe", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const sub = req.body && req.body.subscription ? req.body.subscription : req.body;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return res.status(400).json({ error: "Invalid subscription" });
    await pool.query(
      "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4) ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, created_at=NOW()",
      [req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
    );
    res.json({ ok: true });
  } catch (err) { console.error("[push] subscribe:", err.message); res.status(500).json({ error: "Server error" }); }
});

router.post("/unsubscribe", async (req, res) => {
  const pool = req.app.get("pool");
  try { const ep = req.body && req.body.endpoint; if (ep) await pool.query("DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2", [ep, req.user.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: "Server error" }); }
});

module.exports = router;
