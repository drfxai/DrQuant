require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const { pool, initDB } = require("./database");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 15e6 });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change_me";
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.set("trust proxy", 1); // correct client IP behind Nginx (needed for webhook IP logging & rate limiting)
app.use(cors());

// TradingView webhook — mounted BEFORE express.json() because it parses its own
// raw body for signature verification. Router only matches /api/webhooks/*.
app.use("/api/webhooks", require("./routes/webhooks"));

app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));
// Quantum Chat browser client — served for the in-app /quantum-chat.html panel.
// The canonical module lives in quantum-chat/web/ (deployed by install.sh).
app.use("/qc", express.static(path.join(__dirname, "quantum-chat", "web")));

function authMiddleware(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return res.status(401).json({ error: "No token" });
  try { req.user = jwt.verify(h.split(" ")[1], JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: "Invalid token" }); }
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

// ── Socket.io ──
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Auth required"));
  try { socket.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { next(new Error("Invalid token")); }
});

// Additive realtime layer: reactions, delivered/read receipts, chat rooms,
// debounced typing, and optional Redis fan-out (see realtime/messaging.js).
// Registers its own connection listener; the existing one below is unchanged.
require("./realtime/messaging").setupRealtime(io, pool);

// Optional SFU live streaming. Inert unless LIVE_SFU=on AND mediasoup is
// installed; when disabled, the frame-relay path below remains the mechanism.
require("./realtime/sfu").setupSfu(io, pool);

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
