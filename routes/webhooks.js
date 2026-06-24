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
const scoreboard = require("../services/signal-scoreboard");

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

// Map common TradingView payload shapes onto our canonical signal fields, so a
// stricter or looser alert message still works: symbol|ticker, side|action,
// price|close, sl|stop_loss, tp|take_profit, timeframe|interval, and so on.
function coerceSignal(p) {
  if (!p || typeof p !== "object") return p;
  const pick = (...keys) => { for (const k of keys) if (p[k] != null && p[k] !== "") return p[k]; return undefined; };
  let side = pick("side", "action", "order_action");
  if (typeof side === "string") {
    const m = { b: "buy", buy: "buy", long: "long", s: "sell", sell: "sell", short: "short", close: "close", exit: "close", flat: "close", alert: "alert" };
    const k = side.toLowerCase().trim();
    side = m[k] || k;
  }
  return {
    symbol: pick("symbol", "ticker"),
    side,
    id: pick("id", "signal_id", "signalId", "ticket", "uuid", "ref"),
    price: pick("price", "close", "entry"),
    stop_loss: pick("stop_loss", "sl", "stop"),
    take_profit: pick("take_profit", "tp", "target"),
    timeframe: pick("timeframe", "interval", "tf"),
    strategy: pick("strategy", "strategy_name"),
    note: pick("note", "comment", "message", "text"),
  };
}

// Format a normalized signal as a readable channel message (markdown + emoji).
function formatSignalMessage(n) {
  const sideEmoji = { buy: "🟢", long: "🟢", sell: "🔴", short: "🔴", close: "⚪", alert: "🔔" }[n.side] || "📊";
  const lines = ["📡 **TradingView Signal**", `${sideEmoji} **${n.side.toUpperCase()}**  ${n.symbol}`];
  const px = [];
  if (n.price != null) px.push(`Entry: ${n.price}`);
  if (n.stop_loss != null) px.push(`SL: ${n.stop_loss}`);
  if (n.take_profit != null) px.push(`TP: ${n.take_profit}`);
  if (px.length) lines.push(px.join("  ·  "));
  const meta = [];
  if (n.timeframe) meta.push(`TF ${n.timeframe}`);
  if (n.strategy) meta.push(n.strategy);
  if (meta.length) lines.push(meta.join("  ·  "));
  if (n.note) lines.push(n.note);
  return lines.join("\n");
}

// Post a signal into a channel as a NORMAL chat message, so members see it in
// the chat UI. The SPA renders `messages` and listens on per-user rooms for
// `chat_message`; it does not render raw `signal` events. Mirrors the broadcast
// shape used by routes/chats.js exactly.
async function postSignalToChannel(pool, io, chatId, n) {
  const { rows: [chat] } = await pool.query("SELECT created_by FROM chats WHERE id=$1", [chatId]);
  let authorId = chat?.created_by || null;
  if (!authorId) {
    const { rows: [adm] } = await pool.query("SELECT id FROM users WHERE role IN ('admin','superadmin') ORDER BY id LIMIT 1");
    authorId = adm?.id || null;
  }
  if (!authorId) return; // no valid author -> skip the message (signal still persisted/emitted)
  const { rows: [msg] } = await pool.query(
    "INSERT INTO messages (chat_id,user_id,content) VALUES ($1,$2,$3) RETURNING *",
    [chatId, authorId, formatSignalMessage(n)]
  );
  const { rows: [sender] } = await pool.query("SELECT name,avatar,role FROM users WHERE id=$1", [authorId]);
  const payload = { ...msg, sender_name: sender?.name || "Dr Signal", sender_avatar: sender?.avatar || "📊", sender_role: sender?.role || "admin" };
  const { rows: members } = await pool.query("SELECT user_id FROM chat_members WHERE chat_id=$1", [chatId]);
  members.forEach((m) => io.to(`user_${m.user_id}`).emit("chat_message", payload));
}

// Post a pre-formatted text body into a channel VERBATIM, as a normal chat
// message. Used for alerts that already carry their own fully-formatted body
// (e.g. Pine alert() output from the GOD MODE indicator), so the channel shows
// EXACTLY what the indicator sent instead of a re-formatted summary. Mirrors
// the broadcast shape used by postSignalToChannel / routes/chats.js.
async function postRawTextToChannel(pool, io, chatId, text) {
  const body = String(text).replace(/\r\n/g, "\n").trim().slice(0, 4000);
  if (!body) return;
  const { rows: [chat] } = await pool.query("SELECT created_by FROM chats WHERE id=$1", [chatId]);
  let authorId = chat?.created_by || null;
  if (!authorId) {
    const { rows: [adm] } = await pool.query("SELECT id FROM users WHERE role IN ('admin','superadmin') ORDER BY id LIMIT 1");
    authorId = adm?.id || null;
  }
  if (!authorId) return;
  const { rows: [msg] } = await pool.query(
    "INSERT INTO messages (chat_id,user_id,content) VALUES ($1,$2,$3) RETURNING *",
    [chatId, authorId, body]
  );
  const { rows: [sender] } = await pool.query("SELECT name,avatar,role FROM users WHERE id=$1", [authorId]);
  const payload = { ...msg, sender_name: sender?.name || "Dr Signal", sender_avatar: sender?.avatar || "📊", sender_role: sender?.role || "admin" };
  const { rows: members } = await pool.query("SELECT user_id FROM chat_members WHERE chat_id=$1", [chatId]);
  members.forEach((m) => io.to(`user_${m.user_id}`).emit("chat_message", payload));
}

// ── DRFX scoreboard tag ──────────────────────────────────────────────────────────
// GOD MODE (and any bot) can append a hidden, machine-readable tag to an alert
// body: [[DRFX]]{...json...}[[/DRFX]]. We parse it to drive the in-memory
// scoreboard, then STRIP it before the text is posted to the channel, so the
// channel/Telegram message is byte-for-byte unchanged.
function extractDrfxTag(text) {
  if (!text) return { clean: text, data: null };
  const m = text.match(/\[\[DRFX\]\]([\s\S]*?)\[\[\/DRFX\]\]/);
  if (!m) return { clean: text, data: null };
  let data = null;
  try { data = JSON.parse(m[1]); } catch { data = null; }
  const clean = text.replace(/\s*\[\[DRFX\]\][\s\S]*?\[\[\/DRFX\]\]\s*/g, "").trim();
  return { clean, data };
}
function feedScoreboardFromTag(data, chatId) {
  if (!data || !data.event) return;
  const ev = String(data.event).toLowerCase();
  if (ev === "entry") {
    scoreboard.ingestWebhook(
      { symbol: data.symbol, side: data.direction, price: data.entry, stop_loss: data.sl, take_profit: data.tp1, timeframe: data.tf },
      { extId: data.signal_id, chatId }
    );
  } else {
    scoreboard.applyEvent({
      signalId: data.signal_id, symbol: data.symbol, direction: data.direction,
      event: data.event, price: data.price, result: data.result,
    });
  }
}

router.post(["/tradingview", "/tradingview/:token"], async (req, res) => {
  const pool = req.app.get("pool");
  const io = req.app.get("io");
  const ip = req.ip;
  const raw = req.rawBody || Buffer.from("");
  const payload = req.json;

  // URL-token routing: /tradingview/<token> binds directly to a channel's chat.
  // Possessing the token authorizes posting to that channel (no body secret),
  // which is what makes it copy-paste friendly for TradingView alerts.
  let tokenChatId = null;
  if (req.params.token) {
    try {
      const { rows: [c] } = await pool.query(
        "SELECT id FROM chats WHERE webhook_token=$1 AND type='channel' LIMIT 1",
        [req.params.token]
      );
      tokenChatId = c?.id ?? null;
    } catch { tokenChatId = null; }
  }
  // A token was supplied but matched no channel -> clear, distinct error so a
  // stale or mistyped webhook URL doesn't look like an auth failure.
  if (req.params.token && !tokenChatId) {
    return res.status(404).json({ error: "Unknown webhook token. Re-copy the URL from the Dr Signal channel info panel." });
  }

  // Canonical signal fields, tolerant of common TradingView key variants.
  const fields = payload ? coerceSignal(payload) : null;

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
    if (status !== "accepted") console.warn(`[webhook] rejected (${status}): ${reason || ""}`);
    try {
      await pool.query(
        `INSERT INTO webhook_logs (source, ip, signature_ok, dedupe_key, status, reason, payload, signal_id)
         VALUES ('tradingview',$1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
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
  if (tokenChatId) {
    authed = true; // the URL token is the credential
  } else if (channel && channel.secret_hash) {
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

  // --- RAW-TEXT PASSTHROUGH (token routes only) ----------------------------
  // Pine indicators (e.g. GOD MODE) fire alert() with a fully-formatted text
  // body, not a JSON signal. When the request is routed by a channel token
  // (the token already authorized it above) and the body is NOT a structured
  // JSON signal, post the text VERBATIM so the channel shows it exactly as the
  // indicator formatted it. Structured JSON (symbol/ticker present) continues
  // through the normalize/validate/format path below, unchanged.
  if (tokenChatId) {
    const looksStructured = !!(payload && (payload.symbol || payload.ticker));
    if (!looksStructured) {
      const msgField = payload ? (payload.message ?? payload.text) : null;
      const ptext = (typeof msgField === "string" && msgField.trim())
        ? msgField
        : raw.toString("utf8");
      if (ptext && ptext.trim()) {
        let claimP;
        try {
          claimP = await pool.query(
            `INSERT INTO webhook_logs (source, ip, signature_ok, dedupe_key, status)
             VALUES ('tradingview',$1,true,$2,'accepted')
             ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
             RETURNING id`,
            [ip, dedupeKey]
          );
        } catch (e) {
          console.error("[webhook] webhook_logs insert failed — are migrations applied?:", e.message);
          return res.status(500).json({ error: "Webhook storage not ready (run migrations)" });
        }
        if (claimP.rowCount === 0) return res.status(202).json({ status: "duplicate_ignored" });
        // Pull the hidden DRFX tag (if any) → feed the scoreboard → strip it so
        // the posted channel message stays clean.
        const drfx = extractDrfxTag(ptext);
        try { feedScoreboardFromTag(drfx.data, tokenChatId); } catch (e) { /* scoreboard non-critical */ }
        const bodyToPost = drfx.clean;
        try {
          if (bodyToPost && bodyToPost.trim()) await postRawTextToChannel(pool, io, tokenChatId, bodyToPost);
          return res.status(201).json({ status: "published", mode: "passthrough", posted: !!(bodyToPost && bodyToPost.trim()), scoreboard: drfx.data ? (drfx.data.event || true) : false });
        } catch (e) {
          console.error("[webhook] passthrough post error:", e.message);
          await pool.query(`UPDATE webhook_logs SET status='error', reason=$2 WHERE id=$1`, [claimP.rows[0].id, e.message]).catch(() => {});
          return res.status(500).json({ error: "Processing failed" });
        }
      }
    }
  }

  // --- SCHEMA --------------------------------------------------------------
  if (!payload) {
    await logHook("rejected_schema", "invalid JSON");
    return res.status(400).json({ error: "Invalid JSON" });
  }
  const verr = validateSignal(fields);
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
  let claim;
  try {
    claim = await pool.query(
      `INSERT INTO webhook_logs (source, ip, signature_ok, dedupe_key, status)
       VALUES ('tradingview',$1,true,$2,'accepted')
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [ip, dedupeKey]
    );
  } catch (e) {
    console.error("[webhook] webhook_logs insert failed — are migrations applied?:", e.message);
    return res.status(500).json({ error: "Webhook storage not ready (run migrations)" });
  }
  if (claim.rowCount === 0) {
    // Already seen this body within the window.
    return res.status(202).json({ status: "duplicate_ignored" });
  }
  const logId = claim.rows[0].id;

  // --- ANTI-SPAM: cap accepted signals per symbol per minute ---------------
  const { rows: [{ c }] } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM signals
      WHERE symbol = $1 AND created_at > NOW() - INTERVAL '1 minute'`,
    [String(fields.symbol).toUpperCase()]
  );
  if (c >= 10) {
    await pool.query(`UPDATE webhook_logs SET status='rate_limited', reason='symbol flood' WHERE id=$1`, [logId]);
    return res.status(429).json({ error: "Too many signals for symbol" });
  }

  // --- PERSIST + BROADCAST -------------------------------------------------
  try {
    const n = normalize(fields);

    // Destination chat + visibility: prefer the resolved per-channel row, else
    // fall back to the legacy username-based lookup. channel_id references
    // chats(id), and a channel's chat_id is exactly that, so it slots in.
    let chatId = tokenChatId ?? channel?.chat_id ?? null;
    const broadcastGlobal = tokenChatId ? false : (channel ? channel.visibility === "public" : true);
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

    // Feed the in-memory scoreboard (best-effort; never blocks the webhook):
    // the signal's own price is a fresh tick, and a buy/sell/long/short with an
    // entry becomes a tracked, auto-resolving signal.
    try {
      if (n.price != null) scoreboard.setPrice(n.symbol, n.price);
      scoreboard.ingestWebhook(n, { signalId: sig.id, chatId, extId: fields.id });
    } catch (e) { /* scoreboard is non-critical */ }

    // Post the signal into the channel as a normal chat message so every member
    // sees it in the chat UI (raw `signal` events are not rendered by the SPA).
    if (chatId) {
      try { await postSignalToChannel(pool, io, chatId, n); }
      catch (e) { console.error("[webhook] channel post error:", e.message); }
    }

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

// ── POST /api/webhooks/price — price-only intake for the scoreboard ──
// Feeds live prices to the in-memory scoreboard so open detected/webhook signals
// auto-resolve to win/loss. Posts NOTHING to any channel and writes NOTHING to
// the database. Point a TradingView "every bar close" alert here, body e.g.:
//   {"secret":"...","symbol":"XAUUSD","price":4013.7}
//   {"secret":"...","prices":[{"symbol":"BTCUSDT","price":64000}]}
router.post("/price", express.json({ limit: "32kb" }), (req, res) => {
  const b = req.body || {};
  let authed = false;
  if (SECRET && typeof b.secret === "string") authed = timingSafeEqual(b.secret, SECRET);
  if (!authed) return res.status(401).json({ error: "Unauthorized" });
  let resolved = 0, accepted = 0;
  try {
    if (Array.isArray(b.prices)) {
      for (const it of b.prices) {
        if (it && it.symbol != null && it.price != null) { resolved += scoreboard.setPrice(it.symbol, it.price); accepted++; }
      }
    } else if (b.symbol != null && b.price != null) {
      resolved += scoreboard.setPrice(b.symbol, b.price); accepted++;
    } else {
      return res.status(400).json({ error: "Provide {symbol,price} or {prices:[...]}" });
    }
  } catch (e) {
    return res.status(500).json({ error: "Price intake failed" });
  }
  return res.json({ ok: true, accepted, resolved });
});

// ── POST /api/webhooks/signal-update — progress events (TP1/TP2/TP3/SL) ──
// The operator's bot calls this as a trade plays out. Updates the in-memory
// scoreboard ONLY (posts nothing, stores nothing). Body e.g.:
//   {"secret":"...","signal_id":"abc123","event":"tp1","price":4020.5}
//   {"secret":"...","symbol":"XAUUSD","direction":"long","event":"sl"}
//   {"secret":"...","events":[{"signal_id":"abc","event":"tp2"}]}
// Match priority: signal_id (the id you sent with the original signal) → most
// recent open signal for that symbol/direction. Events: tp1/tp2/tp3, sl, close.
router.post("/signal-update", express.json({ limit: "32kb" }), (req, res) => {
  const b = req.body || {};
  let authed = false;
  if (SECRET && typeof b.secret === "string") authed = timingSafeEqual(b.secret, SECRET);
  if (!authed) return res.status(401).json({ error: "Unauthorized" });
  const one = (e) => scoreboard.applyEvent({
    signalId: e.signal_id != null ? e.signal_id : (e.signalId != null ? e.signalId : (e.id != null ? e.id : null)),
    symbol: e.symbol,
    direction: e.direction != null ? e.direction : e.side,
    event: e.event != null ? e.event : (e.type != null ? e.type : e.status),
    price: e.price,
    result: e.result,
    ts: e.time != null ? e.time : e.timestamp,
  });
  try {
    if (Array.isArray(b.events)) {
      const results = b.events.map(one);
      const matched = results.filter((r) => r && r.matched).length;
      return res.json({ ok: true, count: results.length, matched, results });
    }
    const r = one(b);
    if (!r.matched) return res.status(404).json({ ok: false, matched: false, reason: r.reason });
    return res.json({ ok: true, matched: true, status: r.status, max_tp: r.max_tp, closed: r.closed, id: r.id, ext_id: r.ext_id });
  } catch (e) {
    return res.status(500).json({ error: "Event intake failed" });
  }
});

module.exports = router;
