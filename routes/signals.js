// routes/signals.js
// ----------------------------------------------------------------------------
// Read-only signals feed API. Mounted in server.js:
//
//   app.use("/api/signals", require("./routes/signals"));
//
// Two endpoints, both authenticated (any logged-in user):
//
//   GET /api/signals            -> recent PUBLISHED signals from the signals
//                                  table (operator-issued + TradingView webhook).
//                                  This table is the authoritative store; we only
//                                  read it here.
//
//   GET /api/signals/detected   -> DERIVED, NON-PERSISTENT auto-detected signals.
//                                  We scan recent messages in chats the requester
//                                  is a MEMBER of (privacy-safe), run the shared
//                                  deterministic extractor over each, and return
//                                  the hits. Nothing is written to any table — the
//                                  signals table stays free of algorithmic guesses.
//                                  (See the project brief: derive, don't persist.)
//
// Requires migration 001 (signals table + messages.deleted_at). Same prerequisite
// as the webhook ingest and the Console, so no new dependency is introduced.
// ----------------------------------------------------------------------------

const express = require("express");
const router = express.Router();
const scoreboard = require("../services/signal-scoreboard");

// Shared single-source-of-truth extractor (same file the browser loads for the
// in-chat advisory cards, so server-derived and client-shown signals match).
let DQSignal;
try {
  DQSignal = require("../public/signal-extract.js");
} catch (e) {
  console.error("[signals] could not load extractor:", e.message);
  DQSignal = { extract: () => null };
}

// Auth for every route here (mirrors routes/manage.js).
router.use((req, res, next) => req.app.get("authMiddleware")(req, res, next));

const clampLimit = (v, def, max) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n <= 0) return def;
  return Math.min(n, max);
};

// ── GET /api/signals — published signals from the table ───────────────────
router.get("/", async (req, res) => {
  const pool = req.app.get("pool");
  const limit = clampLimit(req.query.limit, 50, 100);
  const symbol = typeof req.query.symbol === "string" && req.query.symbol.trim()
    ? req.query.symbol.trim().toUpperCase().slice(0, 32)
    : null;
  try {
    const params = [req.user.id];
    let where = "s.status = 'published'";
    if (symbol) { params.push(symbol); where += ` AND s.symbol = $${params.length}`; }
    params.push(limit);

    const { rows } = await pool.query(
      `SELECT s.id, s.symbol, s.side, s.price, s.stop_loss, s.take_profit,
              s.timeframe, s.strategy, s.note, s.status, s.channel_id, s.created_by, s.created_at,
              c.name AS channel_name, c.username AS channel_username,
              c.type AS channel_type, c.visibility AS channel_visibility,
              u.name AS author_name, u.username AS author_username, u.avatar AS author_avatar,
              EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = s.channel_id AND cm.user_id = $1) AS is_member
         FROM signals s
         LEFT JOIN chats c ON c.id = s.channel_id
         LEFT JOIN users u ON u.id = s.created_by
        WHERE ${where}
        ORDER BY s.created_at DESC
        LIMIT $${params.length}`,
      params
    );

    const signals = rows.map((r) => ({
      id: r.id,
      source: r.created_by ? "manual" : "webhook", // null created_by = TradingView webhook
      symbol: r.symbol,
      side: r.side,
      price: r.price != null ? Number(r.price) : null,
      stop_loss: r.stop_loss != null ? Number(r.stop_loss) : null,
      take_profit: r.take_profit != null ? Number(r.take_profit) : null,
      timeframe: r.timeframe,
      strategy: r.strategy,
      note: r.note,
      created_at: r.created_at,
      channel: r.channel_id
        ? { id: r.channel_id, name: r.channel_name, username: r.channel_username, type: r.channel_type, is_member: !!r.is_member }
        : null,
      author: r.created_by
        ? { id: r.created_by, name: r.author_name, username: r.author_username, avatar: r.author_avatar }
        : null,
    }));

    res.json({ signals });
  } catch (e) {
    console.error("[signals] list error:", e.message);
    res.status(500).json({ error: "Could not load signals" });
  }
});

// ── GET /api/signals/detected — derived, non-persistent ───────────────────
router.get("/detected", async (req, res) => {
  const pool = req.app.get("pool");
  const windowHours = 48;
  const scanCap = 600; // messages to inspect (regex over ~600 short strings is trivial)
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.chat_id, m.content, m.created_at, m.user_id,
              u.name AS author_name, u.username AS author_username, u.avatar AS author_avatar,
              c.name AS chat_name, c.username AS chat_username, c.type AS chat_type
         FROM messages m
         JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1
         JOIN chats c ON c.id = m.chat_id
         JOIN users u ON u.id = m.user_id
        WHERE m.created_at > NOW() - INTERVAL '${windowHours} hours'
          AND m.deleted_at IS NULL
          AND m.content IS NOT NULL AND m.content <> ''
          AND c.type IN ('group','channel')
        ORDER BY m.created_at DESC
        LIMIT ${scanCap}`,
      [req.user.id]
    );

    const seen = new Set();
    const detected = [];
    for (const r of rows) {
      const sig = DQSignal.extract(r.content);
      if (!sig) continue;
      // light dedupe: collapse repeats of the same call in the same chat
      const key = r.chat_id + "|" + sig.symbol + "|" + sig.direction + "|" + (sig.entry == null ? "" : sig.entry);
      if (seen.has(key)) continue;
      seen.add(key);
      detected.push({
        source: "auto",
        message_id: r.id,
        chat_id: r.chat_id,
        chat: { id: r.chat_id, name: r.chat_name, username: r.chat_username, type: r.chat_type },
        author: { id: r.user_id, name: r.author_name, username: r.author_username, avatar: r.author_avatar },
        created_at: r.created_at,
        text: r.content.length > 280 ? r.content.slice(0, 280) : r.content,
        signal: {
          symbol: sig.symbol,
          direction: sig.direction,
          entry: sig.entry,
          sl: sig.sl,
          tp: sig.tp,
          confidence: sig.confidence,
          level: sig.level,
          label: sig.label,
        },
      });
      if (detected.length >= 40) break;
    }

    // strongest first, then newest
    detected.sort((a, b) =>
      (b.signal.confidence - a.signal.confidence) ||
      (new Date(b.created_at) - new Date(a.created_at))
    );

    res.json({ detected, scanned: rows.length, window_hours: windowHours, advisory: true });
  } catch (e) {
    console.error("[signals] detected error:", e.message);
    res.status(500).json({ error: "Could not derive signals" });
  }
});

// ── GET /api/signals/scoreboard — in-memory leaderboard tables ──
// Channels (best→worst by win rate), symbols, timeframes, and symbol×timeframe,
// all derived from the in-memory scoreboard (auto-resolved against the live
// price feed). Non-persistent: reflects only what's currently in memory.
router.get("/scoreboard", (req, res) => {
  try { res.json(scoreboard.tables()); }
  catch (e) { console.error("[signals] scoreboard:", e.message); res.status(500).json({ error: "Could not build scoreboard" }); }
});

// ── GET /api/signals/scoreboard/recent — recent tracked signals (detail) ──
router.get("/scoreboard/recent", (req, res) => {
  const limit = clampLimit(req.query.limit, 50, 200);
  try { res.json({ signals: scoreboard.recent(limit), stats: scoreboard.stats() }); }
  catch (e) { res.status(500).json({ error: "Could not load recent signals" }); }
});

module.exports = router;
