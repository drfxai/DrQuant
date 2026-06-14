// realtime/messaging.js
// ----------------------------------------------------------------------------
// Additive realtime layer for the platform messaging system. It implements the
// NET-NEW parts of the Socket.io event map from docs/PLATFORM-ARCHITECTURE.md
// that the existing REST path does not cover:
//
//   - chat:open / chat:close      join/leave a per-chat room (chat_<id>)
//   - message:react               toggle a reaction, broadcast the new count
//   - receipt:delivered           per-recipient "delivered" status
//   - receipt:read                per-recipient "read" status (+ unread watermark)
//   - typing:start / typing:stop  debounced, server-computed fan-out
//
// It DELIBERATELY does not re-implement message send/edit/delete: those already
// exist and broadcast in routes/chats.js (chat_message / message_edited /
// message_deleted). Duplicating them here would double-send. This module adds a
// second io.on("connection") listener — Socket.io supports multiple — so wiring
// is a single call in server.js and nothing existing changes.
//
//   const { setupRealtime } = require("./realtime/messaging");
//   setupRealtime(io, pool);   // after `io` is created and io.use(auth) is set
//
// Auth: relies on the existing io.use() JWT guard in server.js, which sets
// socket.user = { id, email, role, name }.
//
// Horizontal scale: if REDIS_URL is set, the official redis adapter is attached
// so emits fan out across instances. It is optional —
//   npm i @socket.io/redis-adapter redis
// — and a no-op when REDIS_URL is unset (single-instance dev stays zero-config).
// ----------------------------------------------------------------------------

const TYPING_THROTTLE_MS = 3000; // at most one typing fan-out per chat per user per window
const MAX_RECEIPT_IDS = 500;
const MAX_EMOJI_LEN = 16;

function registerHandlers(io, pool, socket) {
  const uid = socket.user.id;
  const displayName = socket.user.name || socket.user.email;
  const lastTyping = new Map(); // chatId -> last emit ms (per socket)

  const isMember = async (chatId) => {
    const { rowCount } = await pool.query(
      "SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2",
      [chatId, uid]
    );
    return rowCount > 0;
  };

  const safeAck = (ack, payload) => {
    if (typeof ack === "function") {
      try { ack(payload); } catch { /* client gone */ }
    }
  };

  // ── chat:open / chat:close ────────────────────────────────────────────
  socket.on("chat:open", async ({ chatId } = {}, ack) => {
    try {
      const cid = Number(chatId);
      if (!cid) return safeAck(ack, { ok: false, error: "bad chatId" });
      const { rows: [mem] } = await pool.query(
        "SELECT last_read_id FROM chat_members WHERE chat_id=$1 AND user_id=$2",
        [cid, uid]
      );
      if (!mem) return safeAck(ack, { ok: false, error: "forbidden" });
      socket.join(`chat_${cid}`);
      safeAck(ack, { ok: true, lastReadId: mem.last_read_id || 0 });
    } catch (e) {
      console.error("[realtime] chat:open", e.message);
      safeAck(ack, { ok: false, error: "server error" });
    }
  });

  socket.on("chat:close", ({ chatId } = {}) => {
    const cid = Number(chatId);
    if (cid) socket.leave(`chat_${cid}`);
  });

  // ── message:react (toggle) ────────────────────────────────────────────
  socket.on("message:react", async ({ messageId, emoji } = {}, ack) => {
    try {
      const mid = Number(messageId);
      const e = String(emoji || "").trim().slice(0, MAX_EMOJI_LEN);
      if (!mid || !e) return safeAck(ack, { ok: false, error: "bad input" });

      const { rows: [msg] } = await pool.query(
        "SELECT chat_id FROM messages WHERE id=$1",
        [mid]
      );
      if (!msg) return safeAck(ack, { ok: false, error: "not found" });
      if (!(await isMember(msg.chat_id))) {
        return safeAck(ack, { ok: false, error: "forbidden" });
      }

      // Toggle: delete if present, else insert.
      const del = await pool.query(
        "DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3",
        [mid, uid, e]
      );
      let reacted;
      if (del.rowCount > 0) {
        reacted = false;
      } else {
        await pool.query(
          "INSERT INTO message_reactions (message_id,user_id,emoji) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
          [mid, uid, e]
        );
        reacted = true;
      }
      const { rows: [{ c }] } = await pool.query(
        "SELECT COUNT(*)::int AS c FROM message_reactions WHERE message_id=$1 AND emoji=$2",
        [mid, e]
      );
      io.to(`chat_${msg.chat_id}`).emit("message:reaction", {
        messageId: mid, emoji: e, userId: uid, count: c, reacted,
      });
      safeAck(ack, { ok: true, count: c, reacted });
    } catch (err) {
      console.error("[realtime] message:react", err.message);
      safeAck(ack, { ok: false, error: "server error" });
    }
  });

  // ── receipt:delivered ─────────────────────────────────────────────────
  socket.on("receipt:delivered", async ({ chatId, messageIds } = {}) => {
    try {
      const cid = Number(chatId);
      if (!cid || !Array.isArray(messageIds) || !messageIds.length) return;
      if (!(await isMember(cid))) return;
      const ids = messageIds.map(Number).filter(Boolean).slice(0, MAX_RECEIPT_IDS);
      if (!ids.length) return;
      // Mark only messages in this chat NOT authored by me. Never downgrade a
      // prior 'read' back to 'delivered'.
      const { rows } = await pool.query(
        `INSERT INTO message_reads (message_id, user_id, status, updated_at)
         SELECT m.id, $2, 'delivered', NOW() FROM messages m
          WHERE m.chat_id=$1 AND m.id = ANY($3::int[]) AND m.user_id <> $2
         ON CONFLICT (message_id, user_id) DO UPDATE
           SET status = CASE WHEN message_reads.status='read' THEN 'read' ELSE 'delivered' END,
               updated_at = NOW()
         RETURNING message_id`,
        [cid, uid, ids]
      );
      if (rows.length) {
        io.to(`chat_${cid}`).emit("receipt:update", {
          chatId: cid, userId: uid, status: "delivered",
          messageIds: rows.map((r) => r.message_id),
        });
      }
    } catch (e) {
      console.error("[realtime] receipt:delivered", e.message);
    }
  });

  // ── receipt:read ──────────────────────────────────────────────────────
  socket.on("receipt:read", async ({ chatId, upToId } = {}) => {
    try {
      const cid = Number(chatId);
      const up = Number(upToId);
      if (!cid || !up) return;
      if (!(await isMember(cid))) return;
      await pool.query(
        `INSERT INTO message_reads (message_id, user_id, status, updated_at)
         SELECT m.id, $2, 'read', NOW() FROM messages m
          WHERE m.chat_id=$1 AND m.id <= $3 AND m.user_id <> $2
         ON CONFLICT (message_id, user_id) DO UPDATE
           SET status='read', updated_at=NOW()`,
        [cid, uid, up]
      );
      // Advance the cheap unread watermark too (COALESCE guards NULL).
      await pool.query(
        "UPDATE chat_members SET last_read_id = GREATEST(COALESCE(last_read_id,0),$1) WHERE chat_id=$2 AND user_id=$3",
        [up, cid, uid]
      );
      io.to(`chat_${cid}`).emit("receipt:update", {
        chatId: cid, userId: uid, status: "read", upToId: up,
      });
    } catch (e) {
      console.error("[realtime] receipt:read", e.message);
    }
  });

  // ── typing:start / typing:stop (server-computed fan-out, throttled) ────
  socket.on("typing:start", async ({ chatId } = {}) => {
    try {
      const cid = Number(chatId);
      if (!cid) return;
      const now = Date.now();
      if (now - (lastTyping.get(cid) || 0) < TYPING_THROTTLE_MS) return;
      lastTyping.set(cid, now);
      const { rows } = await pool.query(
        "SELECT user_id FROM chat_members WHERE chat_id=$1 AND user_id<>$2",
        [cid, uid]
      );
      // emit to other members only; recipients are computed here, never trusted
      // from the client.
      rows.forEach((r) =>
        io.to(`user_${r.user_id}`).emit("typing", { chatId: cid, userId: uid, name: displayName })
      );
    } catch (e) {
      console.error("[realtime] typing:start", e.message);
    }
  });

  socket.on("typing:stop", async ({ chatId } = {}) => {
    try {
      const cid = Number(chatId);
      if (!cid) return;
      lastTyping.delete(cid);
      const { rows } = await pool.query(
        "SELECT user_id FROM chat_members WHERE chat_id=$1 AND user_id<>$2",
        [cid, uid]
      );
      rows.forEach((r) =>
        io.to(`user_${r.user_id}`).emit("typing_stop", { chatId: cid, userId: uid })
      );
    } catch (e) {
      console.error("[realtime] typing:stop", e.message);
    }
  });
}

// Attach the Redis adapter (optional) and register the connection handler.
function setupRealtime(io, pool) {
  // Register handlers synchronously so they are live before any client connects.
  io.on("connection", (socket) => {
    if (!socket.user) return; // io.use auth guard should already enforce this
    registerHandlers(io, pool, socket);
  });

  // Optional multi-instance fan-out.
  const url = process.env.REDIS_URL;
  if (url) {
    (async () => {
      try {
        const { createAdapter } = require("@socket.io/redis-adapter");
        const { createClient } = require("redis");
        const pubClient = createClient({ url });
        const subClient = pubClient.duplicate();
        pubClient.on("error", (e) => console.error("[realtime] redis pub", e.message));
        subClient.on("error", (e) => console.error("[realtime] redis sub", e.message));
        await Promise.all([pubClient.connect(), subClient.connect()]);
        io.adapter(createAdapter(pubClient, subClient));
        console.log("[realtime] Redis adapter enabled (multi-instance fan-out)");
      } catch (e) {
        console.warn(
          "[realtime] REDIS_URL set but adapter not active:",
          e.message,
          "— run `npm i @socket.io/redis-adapter redis` to enable."
        );
      }
    })();
  }

  return io;
}

module.exports = { setupRealtime, registerHandlers };
