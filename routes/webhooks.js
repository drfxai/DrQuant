// routes/webhooks.js
// ----------------------------------------------------------------------------
// POST /api/webhooks/tradingview
//
// Flow: Alert -> raw-body capture -> HMAC/secret verify -> replay check ->
//       schema validate -> normalize -> persist signal -> log -> broadcast.
//
// MOUNTING (server.js) — MUST be mounted BEFORE express.json(), because this
// router parses its own raw body so the HMAC is computed over the exact bytes:
//
//   app.use("/api/webhooks", require("./routes/webhooks"));   // before express.json()
//
// TradingView's alert sender can't add custom HMAC headers, so the realistic
// path is a shared secret in the JSON body (mode A). If you front the webhook
// with a proxy that CAN sign, send X-Signature: sha256=<hex> (mode B).
// Set TRADINGVIEW_WEBHOOK_SECRET in .env; until then every request is rejected.
// ----------------------------------------------------------------------------

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const SECRET = process.env.TRADINGVIEW_WEBHOOK_SECRET || "";
const SIGNAL_CHANNEL_USERNAME = process.env.SIGNAL_CHANNEL_USERNAME || "signals";

// Capture the raw body for this route only (needed for HMAC mode B).
router.use(
  "/tradingview",
  express.raw({ type: "*/*", limit: "32kb" }),
  (req, _res, next) => {
    req.rawBody = req.body; // Buffer
    try {
      req.json = JSON.parse(req.body.toString("utf8") || "{}");
    } catch {
      req.json = null;
    }
    next();
  }
);

function timingSafeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verifyHmac(rawBuf, headerSig) {
  if (!headerSig || !SECRET) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(rawBuf).digest("hex");
  return timingSafeEqual(expected, headerSig);
}

const sha256hex = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

// Resolve a per-channel config from payload.channel (slug). Returns the row or
// null. Safe if the signal_channels table doesn't exist yet (pre-migration 002).
async function resolveChannel(pool, payload) {
  const raw = payload && typeof payload.channel === "string" ? payload.channel : null;
  if (!raw) return null;
  const slug = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
  if (!slug) return null;
  try {
    const { rows: [ch] } = await pool.query(
      "SELECT id, chat_id, secret_hash, visibility FROM signal_channels WHERE slug=$1 AND active=TRUE",
      [slug]
    );
    return ch || null;
  } catch {
    return null; // table missing -> fall back to the global secret path
  }
}

// Optional timestamp-window check. Only enforced when the payload carries a
// time/timestamp. Accepts unix seconds, unix ms, or an ISO-8601 string.
function timestampSkewMs(payload) {
  const ts = payload && (payload.time ?? payload.timestamp);
  if (ts == null) return null;
  let ms;
  if (typeof ts === "number") ms = ts < 1e12 ? ts * 1000 : ts; // seconds vs ms
  else ms = Date.parse(String(ts));
  if (Number.isNaN(ms)) return null;
  return Math.abs(Date.now() - ms);
}

// ---- strict schema validation (no external deps) --------------------------
const SIDES = new Set(["buy", "sell", "long", "short", "close", "alert"]);
function validateSignal(p) {
  if (!p || typeof p !== "object") return "payload not an object";
  if (typeof p.symbol !== "string" || !p.symbol.trim()) return "symbol required";
  if (p.symbol.length > 32) return "symbol too long";
  if (typeof p.side !== "string" || !SIDES.has(p.side.toLowerCase())) return "invalid side";
  for (const k of ["price", "stop_loss", "take_profit"]) {
    if (p[k] != null && Number.isNaN(Number(p[k]))) return `${k} not numeric`;
  }
  return null;
}

function normalize(p) {
  const num = (v) => (v == null || v === "" ? null : Number(v));
  return {
    symbol: String(p.symbol).trim().toUpperCase().slice(0, 32),
    side: String(p.side).toLowerCase(),
    price: num(p.price),
    stop_loss: num(p.stop_loss ?? p.sl),
    take_profit: num(p.take_profit ?? p.tp),
    timeframe: p.timeframe ? String(p.timeframe).slice(0, 16) : null,
    strategy: p.strategy ? String(p.strategy).slice(0, 64) : null,
    note: p.note ? String(p.note).slice(0, 500) : null,
  };
}

router.post("/tradingview", async (req, res) => {
  const pool = req.app.get("pool");
  const io = req.app.get("io");
  const ip = req.ip;
  const raw = req.rawBody || Buffer.from("");
  const payload = req.json;

  // dedupe/replay key: hash of body + a coarse 60s time bucket so identical
  // alerts fired seconds apart are treated as one. The UNIQUE index on
  // webhook_logs.dedupe_key enforces single-acceptance at the DB layer.
  const bucket = Math.floor(Date.now() / 60000);
  const dedupeKey = crypto
    .createHash("sha256")
    .update(raw)
    .update(String(bucket))
    .digest("hex");

  async function logHook(status, reason, signalId = null) {
    try {
      await pool.query(
        `INSERT INTO webhook_logs (source, ip, signature_ok, dedupe_key, status, reason, payload, signal_id)
         VALUES ('tradingview',$1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [ip, status === "accepted", status === "rejected_replay" ? null : dedupeKey, status, reason || null, payload ? JSON.stringify(payload) : null, signalId]
      );
    } catch (e) {
      console.error("[webhook] log error:", e.message);
    }
  }

  // --- CHANNEL RESOLUTION (per-channel secrets / routing) ------------------
  // payload.channel (slug) selects a signal_channels row. If it carries a
  // secret_hash, that per-channel secret governs; otherwise the global
  // TRADINGVIEW_WEBHOOK_SECRET applies (back-compat / default channel).
  const channel = await resolveChannel(pool, payload);

  // --- AUTH ----------------------------------------------------------------
  const headerSig = req.get("X-Signature");
  let authed = false;
  if (channel && channel.secret_hash) {
    // Per-channel secret: body-secret mode, compared as SHA-256 hashes so the
    // raw token is never stored. (HMAC-header mode needs the raw key and is not
    // offered per-channel; use the global secret for a signing proxy.)
    if (payload && typeof payload.secret === "string") {
      authed = timingSafeEqual(sha256hex(payload.secret), channel.secret_hash);
    }
  } else if (headerSig) {
    authed = verifyHmac(raw, headerSig);
  } else if (SECRET && payload && typeof payload.secret === "string") {
    authed = timingSafeEqual(payload.secret, SECRET);
  }
  if (!authed) {
    await logHook("rejected_signature", "bad or missing secret");
    return res.status(401).json({ error: "Unauthorized" });
  }

  // --- SCHEMA --------------------------------------------------------------
  if (!payload) {
    await logHook("rejected_schema", "invalid JSON");
    return res.status(400).json({ error: "Invalid JSON" });
  }
  const verr = validateSignal(payload);
  if (verr) {
    await logHook("rejected_schema", verr);
    return res.status(400).json({ error: verr });
  }

  // --- TIMESTAMP WINDOW (replay hardening; only when a timestamp is sent) ---
  const skew = timestampSkewMs(payload);
  if (skew != null && skew > 300000) { // +/- 5 minutes
    await logHook("rejected_replay", "timestamp outside window");
    return res.status(401).json({ error: "Stale timestamp" });
  }

  // --- REPLAY: try to claim the dedupe key. If it already exists, drop. ----
  const claim = await pool.query(
    `INSERT INTO webhook_logs (source, ip, signature_ok, dedupe_key, status)
     VALUES ('tradingview',$1,true,$2,'accepted')
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [ip, dedupeKey]
  );
  if (claim.rowCount === 0) {
    // Already seen this body within the window.
    return res.status(202).json({ status: "duplicate_ignored" });
  }
  const logId = claim.rows[0].id;

  // --- ANTI-SPAM: cap accepted signals per symbol per minute ---------------
  const { rows: [{ c }] } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM signals
      WHERE symbol = $1 AND created_at > NOW() - INTERVAL '1 minute'`,
    [String(payload.symbol).toUpperCase()]
  );
  if (c >= 10) {
    await pool.query(`UPDATE webhook_logs SET status='rate_limited', reason='symbol flood' WHERE id=$1`, [logId]);
    return res.status(429).json({ error: "Too many signals for symbol" });
  }

  // --- PERSIST + BROADCAST -------------------------------------------------
  try {
    const n = normalize(payload);

    // Destination chat + visibility: prefer the resolved per-channel row, else
    // fall back to the legacy username-based lookup. channel_id references
    // chats(id), and a channel's chat_id is exactly that, so it slots in.
    let chatId = channel?.chat_id ?? null;
    const broadcastGlobal = channel ? channel.visibility === "public" : true;
    if (!chatId) {
      const { rows: [chan] } = await pool.query(
        `SELECT id FROM chats WHERE username = $1 AND type = 'channel' LIMIT 1`,
        [SIGNAL_CHANNEL_USERNAME]
      );
      chatId = chan?.id ?? null;
    }

    const { rows: [sig] } = await pool.query(
      `INSERT INTO signals (symbol, side, price, stop_loss, take_profit, timeframe, strategy, note, raw_payload, status, channel_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'published',$10) RETURNING *`,
      [n.symbol, n.side, n.price, n.stop_loss, n.take_profit, n.timeframe, n.strategy, n.note, JSON.stringify(payload), chatId]
    );
    await pool.query(`UPDATE webhook_logs SET signal_id=$1 WHERE id=$2`, [sig.id, logId]);

    // Private channels broadcast to members only (chat room); public channels
    // also hit the global signals feed.
    if (chatId) io.to(`chat_${chatId}`).emit("signal", sig);
    if (broadcastGlobal) io.to("signals").emit("signal", sig);

    return res.status(201).json({ status: "published", id: sig.id });
  } catch (e) {
    console.error("[webhook] persist error:", e.message);
    await pool.query(`UPDATE webhook_logs SET status='error', reason=$2 WHERE id=$1`, [logId, e.message]).catch(() => {});
    return res.status(500).json({ error: "Processing failed" });
  }
});

module.exports = router;
