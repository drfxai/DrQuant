require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const { pool, initDB } = require("./database");
const { setupQntmSchema, mountQntmEconomy } = require("./qntm-ledger/integrate");
const { applySecurity, corsOptions, globalLimiter, makeLimiter, ALLOWED } = require("./middleware/security");
const scoreboard = require("./services/signal-scoreboard");
const priceBinance = require("./services/price-binance");
const easytrade = require("./services/easytrade");
const easytradeAutopilot = require("./services/easytrade-autopilot");
const babypick = require("./services/babypick");
const quantoption = require("./services/quantoption");

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
// Easy Trade dedicated webhook — also BEFORE express.json() so it can capture
// its own raw body (TradingView's Content-Type is inconsistent; a text alert
// labelled application/json would otherwise make the global parser 400).
app.use("/api/easytrade/webhook", require("./routes/easytrade-webhook"));
// Quant Option dedicated webhook — also BEFORE express.json() so it captures its
// own raw body (Pine alert text). Wrapped so a fault here can never crash boot.
try { app.use("/api/quantoption/webhook", require("./routes/quantoption-webhook")); } catch (e) { console.error("Quant Option webhook disabled:", e.message); }

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
// QNTM Control Deck (admin instrument panel) - served as a static shell. The HTML
// carries no secrets; every figure and action requires an admin token that the
// /api/qntm/admin* routes enforce, so serving the shell openly is safe.
app.use("/control-deck", express.static(path.join(__dirname, "qntm-ledger", "control-deck")));

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
// Public, privacy-aware share landing for channel/group posts (no auth). Wrapped
// so any problem here can never crash boot; must precede the SPA catch-all.
try { app.use("/m", require("./routes/share")); } catch (e) { console.error("Share route disabled:", e.message); }
// Public, privacy-aware share landing for Market/Explore posts (no auth). Same
// boot-protection as /m; must precede the SPA catch-all.
try { app.use("/p", require("./routes/share-post")); } catch (e) { console.error("Post share route disabled:", e.message); }
app.use("/api/admin", require("./routes/admin"));
app.use("/api/payment", require("./routes/payment"));
app.use("/api/upload", require("./routes/upload"));
app.use("/api/manage", require("./routes/manage")); // admin/manager console (RBAC matrix)
app.use("/api/live", require("./routes/live"));   // live-trading sessions + ICE/TURN credentials
app.use("/api/market", require("./routes/market")); // Market: Explore feed, creators/companies, products, follows/likes
app.use("/api/signals", require("./routes/signals")); // read-only signals feed (published table + derived auto-detected)
app.use("/api/easytrade", require("./routes/easytrade")); // Easy Trade (Baby Trader): wallet-connected prediction game + dedicated webhook
try { app.use("/api/babypick", require("./routes/babypick")); } catch (e) { console.error("Baby Pick route disabled:", e.message); } // Baby Pick: games half of Easy Trade (provably-fair Quick Signal)
try { app.use("/api/quantoption", require("./routes/quantoption")); } catch (e) { console.error("Quant Option route disabled:", e.message); } // Quant Option: server-authoritative, wallet-connected options simulation
app.use("/api/translate", require("./routes/translate")); // chat translation (provider-agnostic; degrades to no-op if unconfigured)
app.use("/api/wizard", require("./routes/wizard")); // wizard ("guard") panel: scoped moderation over regular users only
try { app.use("/api/leagues", require("./routes/leagues")); } catch (e) { console.error("Leagues route disabled:", e.message); } // QNTM Leagues + League Unlock Ritual
try { app.use("/api/push", require("./routes/push")); } catch (e) { console.error("Push route disabled:", e.message); } // Web Push: message notifications when the app is closed
try { app.use("/api/link-preview", require("./routes/link-preview")); } catch (e) { console.error("Link-preview route disabled:", e.message); } // Link previews: OpenGraph unfurl for chat (e.g. TradingView charts)

// QNTM economy — internal ledger/wallet admin routes (mounts at /api/qntm/admin),
// guarded by the host's auth + admin middleware so it shares one RBAC path.
mountQntmEconomy(app, { authMiddleware, adminMiddleware });

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

// ── Message auto-expiry cleaner ──
// Per-channel retention: any chat with expire_hours > 0 has messages older than
// that window permanently deleted (reactions cascade). Runs every 10 minutes and
// once shortly after boot. Keeps the DB small for high-volume signal channels.
// Each deleted batch notifies open clients so their view stays in sync.
async function runMessageExpiry() {
  try {
    const { rows: chats } = await pool.query("SELECT id, expire_hours FROM chats WHERE expire_hours IS NOT NULL AND expire_hours > 0");
    for (const c of chats) {
      const hrs = parseInt(c.expire_hours, 10);
      if (!hrs || hrs < 1) continue;
      const { rows: gone } = await pool.query(
        "DELETE FROM messages WHERE chat_id=$1 AND created_at < NOW() - ($2 * INTERVAL '1 hour') RETURNING id",
        [c.id, hrs]
      );
      if (gone.length) {
        const ids = gone.map((g) => g.id);
        try {
          const { rows: members } = await pool.query("SELECT user_id FROM chat_members WHERE chat_id=$1", [c.id]);
          members.forEach((m) => io.to(`user_${m.user_id}`).emit("messages_expired", { chat_id: c.id, ids }));
        } catch (e) {}
        console.log(`\uD83E\uDDF9 Expiry: removed ${gone.length} message(s) older than ${hrs}h from chat ${c.id}`);
      }
    }
  } catch (e) { console.error("Message expiry sweep:", e.message); }
}
function startMessageExpiryCleaner() {
  setTimeout(runMessageExpiry, 30 * 1000);          // shortly after boot
  setInterval(runMessageExpiry, 10 * 60 * 1000);    // then every 10 minutes
}

// ── Signal scoreboard (in-memory) ──
// Rebuild the rolling detected-signal set from recent PUBLIC-channel messages on
// boot and every few minutes, and expire stale open signals. Prices arrive live
// via the TradingView webhook + POST /api/webhooks/price; the optional free
// crypto poller (PRICE_FEED_BINANCE=on) adds Binance prices for tracked coins.
function startSignalScoreboard() {
  const run = () => scoreboard.rebuildFromMessages(pool)
    .then((r) => { if (r && r.ingested) console.log(`\uD83C\uDFC1 Scoreboard: ingested ${r.ingested} signal(s) from ${r.scanned} message(s)`); })
    .catch((e) => console.error("Scoreboard rebuild:", e.message));
  setTimeout(run, 8 * 1000);                 // shortly after boot
  setInterval(run, 5 * 60 * 1000);           // refresh every 5 minutes
  setInterval(() => scoreboard.expireStale(), 10 * 60 * 1000);
  if (String(process.env.PRICE_FEED_BINANCE || "").toLowerCase() === "on") {
    try { priceBinance.start(scoreboard); } catch (e) { console.error("price-binance start:", e.message); }
  }
}

(async () => {
  try {
    await initDB();
    startMessageExpiryCleaner();
    startSignalScoreboard();
    // ── League Unlock Ritual sweeper ──
    // Auto-settle matured 7-day rituals: return locked QNTM, permanently unlock the
    // league, and push a realtime "league_unlocked" event so the client shows the
    // welcome pop-up. Runs ~20s after boot, then every minute (like the other sweeps).
    try {
      const leagueRituals = require("./services/league-rituals");
      const sweepRituals = () => leagueRituals.sweepMatured()
        .then((done) => {
          for (const u of (done || [])) io.to(`user_${u.userId}`).emit("league_unlocked", u);
          if (done && done.length) console.log(`[leagues] auto-unlocked ${done.length} ritual(s)`);
        })
        .catch((e) => console.error("League ritual sweep:", e.message));
      setTimeout(sweepRituals, 20 * 1000);
      setInterval(sweepRituals, 60 * 1000);
    } catch (e) { console.error("League ritual sweeper disabled:", e.message); }
    await setupQntmSchema().catch((e) => console.error("[qntm] schema setup failed:", e.message));
    easytrade.init()
      .then(() => {
        setInterval(() => easytrade.sweepStale().catch(() => {}), 5 * 60 * 1000);
        // Auto-replenish the reward pool to a floor (treasury -> pool). Set
        // EASYTRADE_POOL_FLOOR=1000000 to keep the pool at 1,000,000 QNTM; unset
        // or 0 disables it. Runs shortly after boot, then on an interval.
        const poolFloor = Math.floor(Number(process.env.EASYTRADE_POOL_FLOOR) || 0);
        if (poolFloor > 0) {
          const everyMs = Math.max(15, Number(process.env.EASYTRADE_POOL_TOPUP_INTERVAL_SEC) || 60) * 1000;
          const runTopup = () => easytrade.topUpPool(poolFloor, null).catch((e) => console.error("[easytrade] pool top-up:", e.message));
          setTimeout(runTopup, 12 * 1000);
          setInterval(runTopup, everyMs);
          console.log(`[easytrade] pool auto-topup ON - floor ${poolFloor} QNTM every ${Math.round(everyMs / 1000)}s`);
        }
        if (String(process.env.EASYTRADE_AUTOPILOT || "").toLowerCase() === "on") {
          try { easytradeAutopilot.start(); } catch (e) { console.error("[easytrade-autopilot] start:", e.message); }
        }
      })
      .catch((e) => console.error("[easytrade] init failed:", e.message));
    // ── Baby Pick keeper ──
    // Settle matured Quick Signal rounds so winners are paid even if they closed
    // the app mid-round. Lazy settlement (on /me + poll) already covers active
    // players; this is the backstop. ~15s after boot, then every 30s.
    babypick.init()
      .then(() => {
        const sweepBp = () => babypick.sweepQuick(200).catch((e) => console.error("[babypick] sweep:", e.message));
        setTimeout(sweepBp, 15 * 1000);
        setInterval(sweepBp, 30 * 1000);
        console.log("[babypick] Quick Signal keeper ON (matured rounds settle every 30s)");
      })
      .catch((e) => console.error("[babypick] init failed:", e.message));
    // ── Quant Option keeper ──
    // Settle matured option positions so winners are paid even if they closed the
    // app mid-position (lazy settlement on /me + poll already covers active
    // players; this is the backstop). ~18s after boot, then every 20s. Also
    // auto-replenishes the dedicated pool to QUANTOPTION_POOL_FLOOR (treasury →
    // pool), mirroring EASYTRADE_POOL_FLOOR; unset or 0 disables top-ups.
    quantoption.init()
      .then(() => {
        const sweepQo = () => quantoption.sweepMatured(200).catch((e) => console.error("[quantoption] sweep:", e.message));
        setTimeout(sweepQo, 18 * 1000);
        setInterval(sweepQo, 20 * 1000);
        console.log("[quantoption] matured-position keeper ON (settles every 20s)");
        const qoFloor = Math.floor(Number(process.env.QUANTOPTION_POOL_FLOOR) || 0);
        if (qoFloor > 0) {
          const everyMs = Math.max(15, Number(process.env.QUANTOPTION_POOL_TOPUP_INTERVAL_SEC) || 60) * 1000;
          const runTopup = () => quantoption.topUpPool(qoFloor, null).catch((e) => console.error("[quantoption] pool top-up:", e.message));
          setTimeout(runTopup, 14 * 1000);
          setInterval(runTopup, everyMs);
          console.log(`[quantoption] pool auto-topup ON - floor ${qoFloor} QNTM every ${Math.round(everyMs / 1000)}s`);
        }
      })
      .catch((e) => console.error("[quantoption] init failed:", e.message));
    // ── Quant Option SIGNAL keeper ──
    // Settle signal-bound positions whose God Mode trade resolved, and refund any
    // whose optional time limit elapsed with no real outcome. Wrapped so a fault
    // in the signals module can never crash boot. ~22s after boot, then every 30s.
    try {
      const quantoptionSignals = require("./services/quantoption-signals");
      quantoptionSignals.init()
        .then(() => {
          const sweepSig = () => quantoptionSignals.sweepExpired(200).catch((e) => console.error("[quantoption-signals] sweep:", e.message));
          setTimeout(sweepSig, 22 * 1000);
          setInterval(sweepSig, 30 * 1000);
          console.log("[quantoption-signals] signal-position keeper ON (settles every 30s)");
        })
        .catch((e) => console.error("[quantoption-signals] init failed:", e.message));
    } catch (e) { console.error("[quantoption-signals] disabled:", e.message); }
    server.listen(PORT, () => {
      console.log(`\n  ╔════════════════════════════════════════╗`);
      console.log(`  ║  📈 DrFX Quant v5.2 on port ${PORT}         ║`);
      console.log(`  ║  PostgreSQL ✅ · Telegram-style         ║`);
      console.log(`  ╚════════════════════════════════════════╝\n`);
    });
  } catch (err) { console.error("❌ Start failed:", err); process.exit(1); }
})();
