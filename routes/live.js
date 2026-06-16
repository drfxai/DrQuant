// routes/live.js
// ----------------------------------------------------------------------------
// Live Trading session lifecycle + ICE (STUN/TURN) credentials for the WebRTC
// SFU path (see realtime/sfu.js and docs/LIVE-SFU-PLAN.md).
//
// SAFE TO SHIP BEFORE THE INFRASTRUCTURE EXISTS:
//   * In relay mode (LIVE_SFU not active) these endpoints are simply unused by
//     the client, which keeps talking to the existing socket frame-relay path.
//   * /ice degrades to a public STUN server when TURN_HOST/TURN_SECRET are unset,
//     so nothing 500s before coturn is configured.
//
// The authoritative "is the SFU actually running" flag is set by server.js as
// app.set("sfuEnabled", <bool>) from setupSfu()'s return value — that reflects
// BOTH `LIVE_SFU=on` AND mediasoup being installed, so the client is never told
// to use a media plane that isn't there.
// ----------------------------------------------------------------------------

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

// Every route requires a valid, non-blocked account (same guard as the rest of
// the API; it also re-checks the DB each request).
router.use((req, res, next) => req.app.get("authMiddleware")(req, res, next));

// 'sfu' when the media plane is genuinely up, else 'relay'. The client branches
// on this to pick WebRTC-SFU vs the legacy frame relay.
function liveMode(req) {
  return req.app.get("sfuEnabled") ? "sfu" : "relay";
}

// Broadcasting is an operator action. adminMiddleware is an exact-'admin' check;
// here we also allow 'superadmin' (who outranks admin) to go live. The SFU
// separately ties production to live_sessions.host_id, so only the account that
// started a session can actually push media to it.
function canBroadcast(req, res, next) {
  if (!req.user || !["admin", "superadmin"].includes(req.user.role)) {
    return res.status(403).json({ error: "Admin required" });
  }
  next();
}

// ── POST /api/live/start ────────────────────────────────────────────────────
// Operator opens a broadcast. Creates the live_sessions row the SFU authorizes
// against and returns its id. Any stale 'live' row owned by the same host is
// closed first so a crashed/abandoned session can't block a clean restart.
router.post("/start", canBroadcast, async (req, res) => {
  const pool = req.app.get("pool");
  const title = (req.body && req.body.title ? String(req.body.title) : "").slice(0, 200);
  try {
    await pool.query(
      "UPDATE live_sessions SET status='ended', ended_at=NOW() WHERE host_id=$1 AND status='live'",
      [req.user.id]
    );
    const { rows: [s] } = await pool.query(
      `INSERT INTO live_sessions (host_id, title, status)
       VALUES ($1, $2, 'live')
       RETURNING id, host_id, title, status, started_at`,
      [req.user.id, title]
    );
    // Tell everyone a broadcast is available so viewers already on the Live page
    // begin consuming immediately (no refresh). Carries the mode so relay-mode
    // clients ignore it and keep using the frame-relay path.
    const io = req.app.get("io");
    if (io) io.emit("live:available", { sessionId: s.id, mode: liveMode(req) });
    res.json({ sessionId: s.id, session: s, mode: liveMode(req) });
  } catch (e) {
    console.error("[live] start:", e.message);
    res.status(500).json({ error: "Could not start session" });
  }
});

// ── POST /api/live/stop ─────────────────────────────────────────────────────
// Ends a broadcast. The host can end their own; an admin/superadmin can end any.
// Also notifies the SFU room so viewers tear down promptly.
router.post("/stop", canBroadcast, async (req, res) => {
  const pool = req.app.get("pool");
  const sessionId = parseInt(req.body && req.body.sessionId, 10);
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  try {
    const { rows: [s] } = await pool.query("SELECT host_id, status FROM live_sessions WHERE id=$1", [sessionId]);
    if (!s) return res.status(404).json({ error: "No such session" });
    const isOwner = s.host_id === req.user.id;
    const isPrivileged = ["admin", "superadmin"].includes(req.user.role);
    if (!isOwner && !isPrivileged) return res.status(403).json({ error: "Not allowed" });

    await pool.query(
      "UPDATE live_sessions SET status='ended', ended_at=NOW() WHERE id=$1 AND status='live'",
      [sessionId]
    );
    const io = req.app.get("io");
    if (io) io.to(`live_${sessionId}`).emit("live:ended");
    res.json({ ok: true });
  } catch (e) {
    console.error("[live] stop:", e.message);
    res.status(500).json({ error: "Could not stop session" });
  }
});

// ── GET /api/live/active ────────────────────────────────────────────────────
// The current live broadcast (if any), for the viewer UI to discover the
// sessionId it should join. Live viewer counts come over the socket
// (`live:viewers` from the SFU, or `live_status` from the relay), not here.
router.get("/active", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const { rows: [s] } = await pool.query(
      `SELECT ls.id, ls.title, ls.host_id, ls.started_at, u.name AS host_name
         FROM live_sessions ls
         JOIN users u ON u.id = ls.host_id
        WHERE ls.status = 'live'
        ORDER BY ls.started_at DESC
        LIMIT 1`
    );
    if (!s) return res.json({ active: false, mode: liveMode(req) });
    res.json({ active: true, mode: liveMode(req), session: s });
  } catch (e) {
    console.error("[live] active:", e.message);
    res.status(500).json({ error: "error" });
  }
});

// ── GET /api/live/ice ───────────────────────────────────────────────────────
// ICE servers for the browser RTCPeerConnection. TURN credentials use coturn's
// `use-auth-secret` (TURN REST) scheme: a short-lived username of the form
// "<unix-expiry>:live" with credential = base64(HMAC-SHA1(secret, username)).
// No per-user TURN passwords are stored anywhere.
router.get("/ice", (req, res) => {
  const turnHost = process.env.TURN_HOST;
  const turnSecret = process.env.TURN_SECRET;
  const iceServers = [];

  if (turnHost) {
    iceServers.push({ urls: `stun:${turnHost}:3478` });
    if (turnSecret) {
      const ttlSeconds = 6 * 60 * 60; // 6 hours
      const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
      const username = `${expiry}:live`;
      const credential = crypto.createHmac("sha1", turnSecret).update(username).digest("base64");
      iceServers.push({
        urls: [
          `turn:${turnHost}:3478?transport=udp`,
          `turn:${turnHost}:3478?transport=tcp`,
          `turns:${turnHost}:5349?transport=tcp`, // TLS/443-style fallback for UDP-blocked networks
        ],
        username,
        credential,
      });
    }
  } else {
    // Dev / pre-coturn fallback: a public STUN server gives basic reflexive
    // candidates. Strict-NAT viewers will still need TURN to connect.
    iceServers.push({ urls: "stun:stun.l.google.com:19302" });
  }

  res.json({ iceServers, mode: liveMode(req) });
});

module.exports = router;
