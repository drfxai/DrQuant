// routes/manage.js
// ----------------------------------------------------------------------------
// Admin / Manager console API (RBAC-gated via middleware/permissions.js).
//
// Mounted in server.js:  app.use("/api/manage", require("./routes/manage"));
//
// Every endpoint is guarded by a specific permission string, so capability is
// enforced by the matrix (not by inline role checks). Sensitive actions write
// an audit_logs row. Requires migration 002 (signal_channels, message_flags,
// broadcasts) and 001 (audit_logs, signals, webhook_logs).
// ----------------------------------------------------------------------------

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { requirePermission } = require("../middleware/permissions");

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

// Populate req.user for all routes here.
router.use((req, res, next) => req.app.get("authMiddleware")(req, res, next));

// Small audit helper — best-effort, never blocks the response on failure.
async function audit(req, action, targetType, targetId, metadata) {
  try {
    await req.app.get("pool").query(
      `INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, ip, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        req.user.id, req.user.role, action,
        targetType || null, targetId != null ? String(targetId) : null,
        req.ip, metadata ? JSON.stringify(metadata) : null,
      ]
    );
  } catch (e) {
    console.error("[manage] audit error:", e.message);
  }
}

// ── System health / live monitoring ──────────────────────────────────────
router.get("/health", requirePermission("system:view_health"), async (req, res) => {
  const pool = req.app.get("pool");
  const io = req.app.get("io");
  try {
    const one = async (sql) => (await pool.query(sql)).rows[0];
    const { c: openFlags } = await one("SELECT COUNT(*)::int AS c FROM message_flags WHERE status='open'");
    const { c: signals24 } = await one("SELECT COUNT(*)::int AS c FROM signals WHERE created_at > NOW() - INTERVAL '24 hours'");
    const { c: rejected24 } = await one("SELECT COUNT(*)::int AS c FROM webhook_logs WHERE status LIKE 'rejected%' AND created_at > NOW() - INTERVAL '24 hours'");
    const live = await one("SELECT id, host_id, title, viewer_peak, started_at FROM live_sessions WHERE status='live' ORDER BY started_at DESC LIMIT 1");
    res.json({
      socketsConnected: io?.engine?.clientsCount ?? null,
      openFlags,
      signalsLast24h: signals24,
      rejectedWebhooksLast24h: rejected24,
      liveSession: live || null,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    });
  } catch (e) {
    console.error("[manage] health:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Signal channels: CRUD + secret rotation ───────────────────────────────
router.get("/signal-channels", requirePermission("signals:manage_channels"), async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const { rows } = await pool.query(
      `SELECT sc.id, sc.slug, sc.chat_id, sc.visibility, sc.active, sc.created_at,
              (sc.secret_hash IS NOT NULL) AS has_secret, c.name AS chat_name
         FROM signal_channels sc
         LEFT JOIN chats c ON c.id = sc.chat_id
        ORDER BY sc.created_at DESC`
    );
    res.json(rows); // secret_hash itself is never returned
  } catch (e) {
    console.error("[manage] list channels:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/signal-channels", requirePermission("signals:manage_channels"), async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const slug = String(req.body.slug || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
    if (slug.length < 2) return res.status(400).json({ error: "slug must be 2+ chars (a-z 0-9 _ -)" });
    const visibility = req.body.visibility === "private" ? "private" : "public";
    const chatId = req.body.chatId ? parseInt(req.body.chatId) : null;
    const secret = req.body.secret ? String(req.body.secret) : null;
    if (secret && secret.length < 16) return res.status(400).json({ error: "secret should be 16+ chars" });
    const { rows: [ch] } = await pool.query(
      `INSERT INTO signal_channels (slug, chat_id, secret_hash, visibility, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, slug, chat_id, visibility, active, created_at, (secret_hash IS NOT NULL) AS has_secret`,
      [slug, chatId, secret ? sha256(secret) : null, visibility, req.user.id]
    );
    await audit(req, "signal_channel.create", "signal_channel", ch.id, { slug, visibility });
    res.status(201).json(ch);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "slug already exists" });
    console.error("[manage] create channel:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

router.patch("/signal-channels/:id", requirePermission("signals:manage_channels"), async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const id = parseInt(req.params.id);
    const sets = [], vals = []; let i = 1;
    if (req.body.visibility !== undefined) { sets.push(`visibility=$${i++}`); vals.push(req.body.visibility === "private" ? "private" : "public"); }
    if (req.body.active !== undefined) { sets.push(`active=$${i++}`); vals.push(Boolean(req.body.active)); }
    if (req.body.chatId !== undefined) { sets.push(`chat_id=$${i++}`); vals.push(req.body.chatId ? parseInt(req.body.chatId) : null); }
    if (req.body.secret !== undefined) {
      const secret = req.body.secret ? String(req.body.secret) : null;
      if (secret && secret.length < 16) return res.status(400).json({ error: "secret should be 16+ chars" });
      sets.push(`secret_hash=$${i++}`); vals.push(secret ? sha256(secret) : null); // null clears -> global fallback
    }
    if (!sets.length) return res.status(400).json({ error: "nothing to update" });
    vals.push(id);
    const { rows: [ch] } = await pool.query(
      `UPDATE signal_channels SET ${sets.join(",")} WHERE id=$${i}
       RETURNING id, slug, chat_id, visibility, active, created_at, (secret_hash IS NOT NULL) AS has_secret`,
      vals
    );
    if (!ch) return res.status(404).json({ error: "not found" });
    await audit(req, "signal_channel.update", "signal_channel", id, { fields: Object.keys(req.body), secretRotated: req.body.secret !== undefined });
    res.json(ch);
  } catch (e) {
    console.error("[manage] update channel:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/signal-channels/:id", requirePermission("signals:manage_channels"), async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const id = parseInt(req.params.id);
    const { rowCount } = await pool.query("DELETE FROM signal_channels WHERE id=$1", [id]);
    if (!rowCount) return res.status(404).json({ error: "not found" });
    await audit(req, "signal_channel.delete", "signal_channel", id);
    res.json({ ok: true });
  } catch (e) {
    console.error("[manage] delete channel:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Webhook / signal logs ─────────────────────────────────────────────────
router.get("/signal-logs", requirePermission("signals:view_logs"), async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const { rows } = await pool.query(
      `SELECT id, source, ip, signature_ok, status, reason, signal_id, created_at
         FROM webhook_logs ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (e) {
    console.error("[manage] signal-logs:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Manual signal publish (operator-originated) ───────────────────────────
router.post("/signals/manual", requirePermission("signals:publish_manual"), async (req, res) => {
  const pool = req.app.get("pool");
  const io = req.app.get("io");
  try {
    const SIDES = new Set(["buy", "sell", "long", "short", "close", "alert"]);
    const symbol = String(req.body.symbol || "").trim().toUpperCase().slice(0, 32);
    const side = String(req.body.side || "").toLowerCase();
    if (!symbol) return res.status(400).json({ error: "symbol required" });
    if (!SIDES.has(side)) return res.status(400).json({ error: "invalid side" });
    const num = (v) => (v == null || v === "" ? null : Number(v));
    const channelId = req.body.channelId ? parseInt(req.body.channelId) : null;

    let chatId = null, broadcastGlobal = true;
    if (channelId) {
      const { rows: [sc] } = await pool.query("SELECT chat_id, visibility FROM signal_channels WHERE id=$1 AND active=TRUE", [channelId]);
      if (!sc) return res.status(404).json({ error: "signal channel not found" });
      chatId = sc.chat_id;
      broadcastGlobal = sc.visibility === "public";
    }

    const payload = req.body;
    const { rows: [sig] } = await pool.query(
      `INSERT INTO signals (symbol, side, price, stop_loss, take_profit, timeframe, strategy, note, raw_payload, status, channel_id, signal_channel_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'published',$10,$11,$12) RETURNING *`,
      [
        symbol, side, num(req.body.price), num(req.body.stop_loss ?? req.body.sl), num(req.body.take_profit ?? req.body.tp),
        req.body.timeframe ? String(req.body.timeframe).slice(0, 16) : null,
        req.body.strategy ? String(req.body.strategy).slice(0, 64) : null,
        req.body.note ? String(req.body.note).slice(0, 500) : null,
        JSON.stringify(payload), chatId, channelId, req.user.id,
      ]
    );
    if (chatId) io.to(`chat_${chatId}`).emit("signal", sig);
    if (broadcastGlobal) io.to("signals").emit("signal", sig);
    await audit(req, "signal.publish_manual", "signal", sig.id, { symbol, side, channelId });
    res.status(201).json(sig);
  } catch (e) {
    console.error("[manage] manual signal:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Moderation: flag queue ────────────────────────────────────────────────
// Create a flag (any authenticated user may report).
router.post("/flags", requirePermission("chat:flag"), async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const messageId = parseInt(req.body.messageId);
    if (!messageId) return res.status(400).json({ error: "messageId required" });
    const { rows: [msg] } = await pool.query("SELECT chat_id FROM messages WHERE id=$1", [messageId]);
    if (!msg) return res.status(404).json({ error: "message not found" });
    const { rowCount } = await pool.query("SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2", [msg.chat_id, req.user.id]);
    if (!rowCount) return res.status(403).json({ error: "not a member" });
    const reason = String(req.body.reason || "").slice(0, 300);
    try {
      const { rows: [flag] } = await pool.query(
        `INSERT INTO message_flags (message_id, reporter_id, reason) VALUES ($1,$2,$3) RETURNING id, status, created_at`,
        [messageId, req.user.id, reason]
      );
      res.status(201).json(flag);
    } catch (e) {
      if (e.code === "23505") return res.json({ ok: true, already: true }); // open flag already exists
      throw e;
    }
  } catch (e) {
    console.error("[manage] flag create:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/flags", requirePermission("moderation:view_flags"), async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const status = ["open", "reviewing", "resolved", "dismissed"].includes(req.query.status) ? req.query.status : "open";
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const { rows } = await pool.query(
      `SELECT f.id, f.message_id, f.reason, f.status, f.created_at,
              f.reporter_id, ru.name AS reporter_name,
              m.content AS message_content, m.chat_id, m.user_id AS author_id, au.name AS author_name,
              (m.deleted_at IS NOT NULL) AS message_deleted
         FROM message_flags f
         JOIN messages m ON m.id = f.message_id
         LEFT JOIN users ru ON ru.id = f.reporter_id
         LEFT JOIN users au ON au.id = m.user_id
        WHERE f.status = $1
        ORDER BY f.created_at DESC LIMIT $2`,
      [status, limit]
    );
    res.json(rows);
  } catch (e) {
    console.error("[manage] flags list:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/flags/:id/resolve", requirePermission("moderation:resolve_flags"), async (req, res) => {
  const pool = req.app.get("pool");
  const io = req.app.get("io");
  try {
    const id = parseInt(req.params.id);
    const dismiss = req.body.action === "dismiss";
    const deleteMessage = Boolean(req.body.deleteMessage);
    const { rows: [flag] } = await pool.query("SELECT message_id FROM message_flags WHERE id=$1", [id]);
    if (!flag) return res.status(404).json({ error: "not found" });

    if (deleteMessage && !dismiss) {
      // Soft-delete the offending message and notify the chat.
      const { rows: [m] } = await pool.query(
        "UPDATE messages SET deleted_at=NOW(), delete_mode='soft', deleted_by=$2 WHERE id=$1 RETURNING chat_id",
        [flag.message_id, req.user.id]
      );
      if (m) {
        io.to(`chat_${m.chat_id}`).emit("message:deleted", { id: flag.message_id, chatId: m.chat_id, mode: "soft" });
        io.to(`chat_${m.chat_id}`).emit("message_deleted", { id: flag.message_id, chat_id: m.chat_id }); // legacy alias
      }
    }
    await pool.query(
      "UPDATE message_flags SET status=$1, resolver_id=$2, resolution=$3, resolved_at=NOW() WHERE id=$4",
      [dismiss ? "dismissed" : "resolved", req.user.id, String(req.body.resolution || "").slice(0, 300) || null, id]
    );
    await audit(req, "moderation.resolve_flag", "message_flag", id, { dismiss, deleteMessage });
    res.json({ ok: true });
  } catch (e) {
    console.error("[manage] flag resolve:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Admin -> user broadcast ───────────────────────────────────────────────
router.post("/broadcast", requirePermission("broadcast:send"), async (req, res) => {
  const pool = req.app.get("pool");
  const io = req.app.get("io");
  try {
    const body = String(req.body.body || "").trim().slice(0, 2000);
    if (!body) return res.status(400).json({ error: "body required" });
    const title = req.body.title ? String(req.body.title).slice(0, 120) : null;
    const level = ["info", "warning", "critical"].includes(req.body.level) ? req.body.level : "info";
    const audience = ["all", "subscribers", "role"].includes(req.body.audience) ? req.body.audience : "all";
    const audienceFilter = req.body.audienceFilter ? String(req.body.audienceFilter).slice(0, 40) : null;

    const { rows: [b] } = await pool.query(
      `INSERT INTO broadcasts (sender_id, title, body, level, audience, audience_filter)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, title, body, level, audience, audienceFilter]
    );
    const payload = { id: b.id, title, body, level, from: req.user.name || req.user.email, at: b.created_at };

    if (audience === "all") {
      io.emit("broadcast", payload);
    } else {
      // Resolve target user ids, emit to their personal rooms.
      let rows;
      if (audience === "subscribers") {
        ({ rows } = await pool.query("SELECT id FROM users WHERE subscription_status='active' AND role!='bot'"));
      } else { // role
        ({ rows } = await pool.query("SELECT id FROM users WHERE role=$1", [audienceFilter || "user"]));
      }
      rows.forEach((u) => io.to(`user_${u.id}`).emit("broadcast", payload));
    }
    await audit(req, "broadcast.send", "broadcast", b.id, { level, audience, audienceFilter });
    res.status(201).json({ ok: true, id: b.id, recipients: audience });
  } catch (e) {
    console.error("[manage] broadcast:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Audit log viewer ──────────────────────────────────────────────────────
router.get("/audit", requirePermission("system:view_audit"), async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const conds = [], vals = []; let i = 1;
    if (req.query.action) { conds.push(`action = $${i++}`); vals.push(String(req.query.action)); }
    if (req.query.actorId) { conds.push(`actor_id = $${i++}`); vals.push(parseInt(req.query.actorId)); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    vals.push(limit);
    const { rows } = await pool.query(
      `SELECT a.id, a.actor_id, au.name AS actor_name, a.actor_role, a.action,
              a.target_type, a.target_id, a.ip, a.metadata, a.created_at
         FROM audit_logs a LEFT JOIN users au ON au.id = a.actor_id
         ${where} ORDER BY a.created_at DESC LIMIT $${i}`,
      vals
    );
    res.json(rows);
  } catch (e) {
    console.error("[manage] audit list:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
