require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const { pool, initDB } = require("./database");
const { applySecurity, corsOptions, globalLimiter, makeLimiter, ALLOWED } = require("./middleware/security");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
// Fail fast on a missing/placeholder secret rather than silently signing tokens
// with a guessable key — that would let anyone forge admin sessions.
if (!JWT_SECRET || JWT_SECRET.length < 16 || JWT_SECRET === "change_me") {
  console.error("\n❌ FATAL: JWT_SECRET is unset, too short, or still the placeholder.");
  console.error("   Set a long random value in .env (e.g. `openssl rand -hex 32`).\n");
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
// Socket.io: restrict the handshake Origin to the same allowlist as the REST
// API. The JWT in handshake.auth is still the real gate; this is one more layer.
const io = new Server(server, {
  cors: { origin: ALLOWED.length ? ALLOWED : true, methods: ["GET", "POST"] },
  maxHttpBufferSize: 4e6, // was 15e6 — live frames are < ~300KB; cap abuse headroom
});

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── HTTP hardening: helmet (CSP, HSTS, nosniff, frame-deny…), strict-but-
//    graceful CORS, and rate limiting. Replaces the old wide-open cors()/no-
//    headers setup. applySecurity() also sets `trust proxy`.
applySecurity(app);
app.use(cors(corsOptions));

// TradingView webhook — mounted BEFORE express.json() because it parses its own
// raw body for signature verification. It self-protects (token + dedupe + flood
// cap), so it sits ahead of the global API rate limiter.
app.use("/api/webhooks", require("./routes/webhooks"));

app.use(express.json({ limit: "12mb" }));
// Uploaded files are user-controlled: force the browser to honor the declared
// type (no MIME sniffing) and sandbox anything navigated to directly, so a file
// that slips through the filter can't execute as a document (stored-XSS guard).
app.use("/uploads", express.static(UPLOAD_DIR, {
  setHeaders: (res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; sandbox");
  },
}));
app.use(express.static(path.join(__dirname, "public")));
// Quantum Chat browser client — served for the in-app /quantum-chat.html panel.
// The canonical module lives in quantum-chat/web/ (deployed by install.sh).
app.use("/qc", express.static(path.join(__dirname, "quantum-chat", "web")));

// Global API rate limit + stricter limits on the auth endpoints (brute force).
app.use("/api", globalLimiter);
app.use("/api/auth/login", makeLimiter({ windowMs: 15 * 60 * 1000, max: 10 }));
app.use("/api/auth/register", makeLimiter({ windowMs: 60 * 60 * 1000, max: 20 }));

async function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return res.status(401).json({ error: "No token" });
  let payload;
  try { payload = jwt.verify(h.split(" ")[1], JWT_SECRET); }
  catch { return res.status(401).json({ error: "Invalid token" }); }
  // Re-check the account on EVERY request so bans and role changes take effect
  // immediately instead of lingering until the 30-day token expires. The DB
  // role is authoritative — the token's embedded role may be stale.
  try {
    const { rows: [u] } = await pool.query("SELECT role, blocked FROM users WHERE id=$1", [payload.id]);
    if (!u) return res.status(401).json({ error: "Invalid token" });
    if (u.blocked) return res.status(403).json({ error: "Account suspended" });
    req.user = { id: payload.id, email: payload.email, role: u.role };
    next();
  } catch { return res.status(503).json({ error: "Auth unavailable" }); }
}
function adminMiddleware(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "Admin required" });
  next();
}

app.set("pool", pool);
app.set("io", io);
app.set("jwt_secret", JWT_SECRET);
app.set("authMiddleware", authMiddleware);
app.set("adminMiddleware", adminMiddleware);

app.use("/api/auth", require("./routes/auth"));
app.use("/api/chats", require("./routes/chats"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/payment", require("./routes/payment"));
app.use("/api/upload", require("./routes/upload"));
app.use("/api/manage", require("./routes/manage")); // admin/manager console (RBAC matrix)
app.use("/api/live", require("./routes/live"));   // live-trading sessions + ICE/TURN credentials
app.use("/api/market", require("./routes/market")); // Market: Explore feed, creators/companies, products, follows/likes

// ── Socket.io ──
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Auth required"));
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { return next(new Error("Invalid token")); }
  // Same per-connection re-check as the REST guard: reject blocked accounts and
  // pull the live role/name from the DB rather than trusting the token.
  try {
    const { rows: [u] } = await pool.query("SELECT role, blocked, name FROM users WHERE id=$1", [payload.id]);
    if (!u || u.blocked) return next(new Error("Unauthorized"));
    socket.user = { id: payload.id, email: payload.email, role: u.role, name: u.name };
    next();
  } catch { next(new Error("Auth unavailable")); }
});

// Additive realtime layer: reactions, delivered/read receipts, chat rooms,
// debounced typing, and optional Redis fan-out (see realtime/messaging.js).
// Registers its own connection listener; the existing one below is unchanged.
require("./realtime/messaging").setupRealtime(io, pool);

// Optional SFU live streaming. Inert unless LIVE_SFU=on AND mediasoup is
// installed; when disabled, the frame-relay path below remains the mechanism.
// The returned .enabled reflects BOTH the env flag and mediasoup being present;
// /api/live/* exposes it as `mode` so the client never picks a dead media plane.
const sfuResult = require("./realtime/sfu").setupSfu(io, pool);
app.set("sfuEnabled", !!(sfuResult && sfuResult.enabled));

const onlineUsers = new Map();
// Live Trading state
let liveStream = { active: false, adminId: null, adminName: "", startedAt: null, viewers: new Set() };

io.on("connection", (socket) => {
  const uid = socket.user.id;
  onlineUsers.set(uid, socket.id);
  io.emit("online_users", Array.from(onlineUsers.keys()));
  socket.join(`user_${uid}`);
  socket.join("signals"); // receive TradingView signal broadcasts

  socket.on("typing", (data) => {
    if (data.chatId) {
      pool.query("SELECT user_id FROM chat_members WHERE chat_id=$1 AND user_id!=$2", [data.chatId, uid])
        .then(({ rows }) => rows.forEach(r => io.to(`user_${r.user_id}`).emit("typing", { chatId: data.chatId, userId: uid, name: socket.user.email })))
        .catch(() => {});
    }
  });

  // ── Live Trading — Server-relayed frame streaming ──
  socket.on("live_start", () => {
    if (socket.user.role !== "admin") return;
    liveStream = { active: true, adminId: uid, adminName: socket.user.name || socket.user.email, startedAt: Date.now(), viewers: new Set() };
    io.emit("live_status", { active: true, adminName: liveStream.adminName, startedAt: liveStream.startedAt, viewerCount: 0 });
  });

  socket.on("live_stop", () => {
    if (socket.user.role !== "admin" || liveStream.adminId !== uid) return;
    liveStream = { active: false, adminId: null, adminName: "", startedAt: null, viewers: new Set() };
    io.emit("live_status", { active: false });
    io.to("live_viewers").emit("live_ended");
  });

  socket.on("live_get_status", () => {
    socket.emit("live_status", { active: liveStream.active, adminName: liveStream.adminName, startedAt: liveStream.startedAt, viewerCount: liveStream.viewers.size });
  });

  socket.on("live_join", () => {
    if (!liveStream.active) return;
    liveStream.viewers.add(uid);
    socket.join("live_viewers");
    io.emit("live_status", { active: true, adminName: liveStream.adminName, startedAt: liveStream.startedAt, viewerCount: liveStream.viewers.size });
  });

  socket.on("live_leave", () => {
    liveStream.viewers.delete(uid);
    socket.leave("live_viewers");
    if (liveStream.active) {
      io.emit("live_status", { active: liveStream.active, adminName: liveStream.adminName, startedAt: liveStream.startedAt, viewerCount: liveStream.viewers.size });
    }
  });

  // Admin sends captured frame → relay to all viewers
  socket.on("live_frame", (frameData) => {
    if (socket.user.role !== "admin" || !liveStream.active || liveStream.adminId !== uid) return;
    socket.to("live_viewers").emit("live_frame", frameData);
  });

  socket.on("disconnect", () => {
    onlineUsers.delete(uid);
    if (liveStream.active && liveStream.adminId === uid) {
      liveStream = { active: false, adminId: null, adminName: "", startedAt: null, viewers: new Set() };
      io.emit("live_status", { active: false });
      io.to("live_viewers").emit("live_ended");
    }
    liveStream.viewers.delete(uid);
    if (liveStream.active) {
      io.emit("live_status", { active: true, adminName: liveStream.adminName, startedAt: liveStream.startedAt, viewerCount: liveStream.viewers.size });
    }
    io.emit("online_users", Array.from(onlineUsers.keys()));
  });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

(async () => {
  try {
    await initDB();
    server.listen(PORT, () => {
      console.log(`\n  ╔════════════════════════════════════════╗`);
      console.log(`  ║  📈 DrFX Quant v5.2 on port ${PORT}         ║`);
      console.log(`  ║  PostgreSQL ✅ · Telegram-style         ║`);
      console.log(`  ╚════════════════════════════════════════╝\n`);
    });
  } catch (err) { console.error("❌ Start failed:", err); process.exit(1); }
})();
