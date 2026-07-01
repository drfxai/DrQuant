const express = require("express");
const router = express.Router();
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4";
const FREE_DAILY_LIMIT = 5;
const AI_SYSTEM = `You are DrFX AI, the built-in assistant for the DrFX Quant platform (drfx.io) — a trading community and education app for Forex, Gold, and Crypto, built by the DrFX team. Your job is to help members use the platform and learn to trade. Be concise, friendly, and practical, and use simple language (the user may not be a native English speaker). You are an EDUCATIONAL assistant, not a licensed financial advisor: never guarantee profits, never tell someone exactly how much money to invest, and always remind users that trading carries a real risk of loss.

WHAT THE PLATFORM DOES AND DOES NOT DO: DrFX Quant is for communication, trading signals, and education only. It does NOT execute trades and does NOT hold or custody anyone's trading funds. Members receive signal ideas and learning here, then place trades themselves on their own broker or exchange. QNTM is the platform's internal token used inside the app (Pro subscription, the Market, rewards, and the Easy Trade game) — it is not a deposit for live trading.

THE APP — main sections (bottom navigation):
- Chat: Telegram-style messaging with direct messages, groups, and channels. You (DrFX AI) live in a DM here. The team runs official channels: "DrFX" (announcements), "Dr Signal" (free automated signals from TradingView), plus Pro-only VIP channels — "VIP Forex & Crypto Signals", "VIP Algo", and "VIP Strategies". Messages support replies, emoji reactions, pins, and voice/photo/file attachments.
- Signals: a dedicated feed of trade signals. "Published" signals come from the team and TradingView webhooks; "Auto-detected" signals are pulled from the channels you are in. Each signal shows the symbol, direction (Buy/Long or Sell/Short), entry, stop loss (SL), and take-profit (TP) targets, and a scoreboard tracks performance.
- Market: a marketplace and social feed where creators and companies post and sell indicators, strategies, bots, and courses priced in QNTM. You can follow creators, like and comment, and buy products.
- Easy Trade (Baby Trader): a practice prediction game. Pick a signal "house", stake QNTM, and predict whether its next signal hits its target (TP) or its stop (SL). A correct call pays 2x the stake; a wrong one sends it to the reward pool. It is a low-pressure way to practice reading signals without risking a real broker account.
- Profile: your account, settings, language, Pro subscription, and QNTM wallet (balance and history). Pro is the paid subscription (payable with crypto) that unlocks the VIP channels and unlimited AI chat with you.

HOW TO FOLLOW / ENTER A SIGNAL (walk through step by step when asked):
1. Open the Signals tab or a signal channel and read the FULL signal: symbol, direction, entry, stop loss, and take-profit target(s).
2. Place the trade on your OWN broker/exchange — the app does not do it for you. Enter at or near the given entry; if price has already run far past entry, it is usually better to wait for the next setup than to chase it.
3. ALWAYS set the stop loss from the signal. The stop is what protects your account — never trade a signal without one.
4. Set the take-profit target(s). Many traders take partial profit at the first target and move the stop to break-even to make the rest of the trade risk-free.
5. Log it in Trading Notes (in chat): symbol, direction, and your reasoning, so you can review and improve.

CAPITAL & RISK MANAGEMENT (teach this as the core of survival):
- Risk a small, FIXED percentage of your account per trade — commonly 1-2%. Decide it before you enter.
- Size the position from your stop, not your gut: the money you are risking divided by the distance from entry to stop loss gives your position size. A wider stop means a smaller position, never a bigger risk.
- Never delete or widen a stop loss to avoid taking a loss — that is how a small loss becomes an account-ending one.
- Avoid over-leverage. Leverage magnifies losses as much as gains and is the most common reason new accounts blow up.
- Don't put everything into one trade or one symbol, and avoid stacking several correlated positions.
- Aim for a reward worth the risk (for example, targets at least 1.5-2x the distance to your stop) so you can be profitable without winning every trade.
- Protect your mindset: follow your plan, accept that losing trades are normal, and never revenge-trade to win money back. Consistency beats intensity.

TRADING GUIDANCE: help with technical analysis, trade ideas, market structure, support/resistance, trend, entries and exits, and Pine Script for TradingView. Encourage beginners to practice in Easy Trade and on a broker demo account before risking real money. When asked "should I buy/sell X" or "how much should I invest", do not give an order — explain the factors and the risk, show how to size it, and let the user decide, then briefly remind them to use only money they can afford to lose. Keep answers focused and actionable.`;

router.use((req, res, next) => { req.app.get("authMiddleware")(req, res, next); });

// Avatars may be a short emoji or an uploaded path — never markup, inline event
// handlers, or javascript:/data: URLs. Defense-in-depth alongside client-side
// output encoding.
function badAvatar(a) {
  const s = String(a);
  if (s.length > 500) return true;
  if (/[<>"'()]/.test(s)) return true;
  if (/^\s*(javascript|data|vbscript):/i.test(s)) return true;
  return false;
}

// Attachment (voice / audio / video / file) sent alongside a message. The file
// itself was already validated + stored by /api/upload; here we re-validate the
// client-supplied metadata so a tampered client can't inject a bad path/markup.
const ATT_KINDS = ["voice", "audio", "video", "file", "image"];
function sanitizeAttachment(a) {
  if (!a || typeof a !== "object") return null;
  const url = String(a.url || "");
  // Must be an uploaded path from /api/upload — nothing else.
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return null;
  const kind = ATT_KINDS.includes(a.kind) ? a.kind : "file";
  const name = String(a.name || "file").replace(/[\u0000-\u001f"'<>]/g, "").slice(0, 120) || "file";
  const mime = String(a.mime || "").replace(/[^a-zA-Z0-9._+\/-]/g, "").slice(0, 100);
  const size = Math.max(0, Math.min(100 * 1024 * 1024, parseInt(a.size, 10) || 0));
  const dur = Math.max(0, Math.min(86400, parseInt(a.dur, 10) || 0));
  return { url, kind, name, mime, size, dur };
}

// Pin permission: in a DM either participant may pin; in a group/channel only a
// chat admin (or a global admin/manager/superadmin) may pin/unpin.
async function pinPermission(pool, chatId, user) {
  const { rows: [chat] } = await pool.query("SELECT type FROM chats WHERE id=$1", [chatId]);
  if (!chat) return { ok: false, code: 404, error: "Chat not found" };
  const { rows: [mem] } = await pool.query("SELECT role FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, user.id]);
  if (!mem) return { ok: false, code: 403, error: "Not a member" };
  if (chat.type === "dm") return { ok: true };
  const isAdmin = mem.role === "admin" || ["admin", "manager", "superadmin"].includes(user.role);
  if (!isAdmin) return { ok: false, code: 403, error: "Only admins can pin in groups and channels" };
  return { ok: true };
}

// ── Message reactions ──
// Reaction "emoji" values are short custom KEYS rendered client-side by
// /emoji.js. Only this fixed allow-list is accepted (keep in sync with
// dqEmoji.REACTIONS on the client).
const REACTION_KEYS = ["like", "heart", "fire", "rocket", "hundred", "clap", "chartup", "moneybag", "bull", "bear", "diamond", "star", "trophy"];

// Aggregate reactions for a set of message ids:
//   -> { [messageId]: [ { emoji, count, mine }, ... ] }  (ordered by first use)
async function reactionsFor(pool, messageIds, userId) {
  const map = {};
  if (!messageIds || !messageIds.length) return map;
  const { rows } = await pool.query(
    `SELECT message_id, emoji, COUNT(*)::int AS count, BOOL_OR(user_id = $2) AS mine
       FROM message_reactions
      WHERE message_id = ANY($1::int[])
      GROUP BY message_id, emoji
      ORDER BY message_id, MIN(created_at)`,
    [messageIds, userId]
  );
  for (const r of rows) {
    (map[r.message_id] = map[r.message_id] || []).push({ emoji: r.emoji, count: r.count, mine: r.mine });
  }
  return map;
}

// List chats
router.get("/", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    // Ensure the user has their DrFX AI assistant DM (covers admin + accounts made before bot-DM seeding).
    try {
      const { rows: [bot] } = await pool.query("SELECT id FROM users WHERE role='bot' ORDER BY id ASC LIMIT 1");
      if (bot && bot.id !== req.user.id) {
        const { rows: [hasDm] } = await pool.query("SELECT c.id FROM chats c JOIN chat_members cm1 ON c.id=cm1.chat_id AND cm1.user_id=$1 JOIN chat_members cm2 ON c.id=cm2.chat_id AND cm2.user_id=$2 WHERE c.type='dm' LIMIT 1", [req.user.id, bot.id]);
        if (!hasDm) {
          const { rows: [dm] } = await pool.query("INSERT INTO chats (type,created_by) VALUES ('dm',$1) RETURNING id", [req.user.id]);
          await pool.query("INSERT INTO chat_members (chat_id,user_id,role) VALUES ($1,$2,'member'),($1,$3,'member')", [dm.id, req.user.id, bot.id]);
          await pool.query("INSERT INTO messages (chat_id,user_id,content) VALUES ($1,$2,$3)", [dm.id, bot.id, "👋 Hi! I'm DrFX AI, your built-in assistant. Ask me anything about using the platform or learning to trade Forex, Gold, and Crypto. I'm here to help — I'm not a financial advisor, so always trade carefully."]);
        }
      }
    } catch (e) { console.error("ensure AI DM:", e.message); }

    const { rows: chats } = await pool.query(`
      SELECT c.*, cm.role AS my_role, cm.last_read_id,
        (up.user_id IS NOT NULL) AS pinned,
        (SELECT COUNT(*)::int FROM messages m WHERE m.chat_id=c.id AND m.id > cm.last_read_id) AS unread,
        (SELECT COUNT(*)::int FROM chat_members WHERE chat_id=c.id) AS member_count
      FROM chats c
        JOIN chat_members cm ON c.id=cm.chat_id AND cm.user_id=$1
        LEFT JOIN chat_pins up ON up.chat_id=c.id AND up.user_id=$1
      ORDER BY
        (c.pin_rank IS NULL)::int,
        c.pin_rank ASC,
        (up.user_id IS NULL)::int,
        up.pinned_at DESC NULLS LAST,
        (SELECT MAX(created_at) FROM messages WHERE chat_id=c.id) DESC NULLS LAST,
        c.created_at DESC
    `, [req.user.id]);
    const result = [];
    for (const ch of chats) {
      const { rows: [lastMsg] } = await pool.query("SELECT m.*,u.name AS sender_name FROM messages m JOIN users u ON m.user_id=u.id WHERE m.chat_id=$1 ORDER BY m.created_at DESC LIMIT 1", [ch.id]);
      let partner = null;
      if (ch.type === "dm") {
        const { rows: [p] } = await pool.query("SELECT u.id,u.email,u.username,u.name,u.bio,u.avatar,u.role,u.subscription_status FROM users u JOIN chat_members cm ON u.id=cm.user_id WHERE cm.chat_id=$1 AND cm.user_id!=$2 LIMIT 1", [ch.id, req.user.id]);
        partner = p || null;
      }
      result.push({ ...ch, lastMessage: lastMsg || null, partner });
    }
    res.json(result);
  } catch (err) { console.error("List chats:", err); res.status(500).json({ error: "Server error" }); }
});

// Create chat — groups/channels admin only
router.post("/", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const { type, name, bio, avatar, visibility, members, username } = req.body;
    if (!type || !["dm", "group", "channel"].includes(type)) return res.status(400).json({ error: "Invalid type" });
    if (avatar && badAvatar(avatar)) return res.status(400).json({ error: "Invalid avatar" });
    // Everyone may create groups/channels now. Visibility is forced by role:
    // admins choose freely; wizards are forced PRIVATE; regular users are forced
    // PUBLIC (they cannot create private/hidden channels).
    const _isAdmin = req.user.role === "admin" || req.user.role === "superadmin";
    const _isWizard = req.user.role === "wizard";
    if (type === "dm") {
      const partnerId = parseInt(members?.[0]);
      if (!partnerId) return res.status(400).json({ error: "Partner required" });
      const { rows: existing } = await pool.query(`SELECT c.id FROM chats c JOIN chat_members cm1 ON c.id=cm1.chat_id AND cm1.user_id=$1 JOIN chat_members cm2 ON c.id=cm2.chat_id AND cm2.user_id=$2 WHERE c.type='dm' LIMIT 1`, [req.user.id, partnerId]);
      if (existing.length) return res.json({ chatId: existing[0].id, existing: true });
      const { rows: [chat] } = await pool.query("INSERT INTO chats (type,created_by) VALUES ('dm',$1) RETURNING *", [req.user.id]);
      await pool.query("INSERT INTO chat_members (chat_id,user_id,role) VALUES ($1,$2,'admin'),($1,$3,'member')", [chat.id, req.user.id, partnerId]);
      return res.status(201).json({ chatId: chat.id });
    }
    if (!name?.trim()) return res.status(400).json({ error: "Name required" });
    let uname = null;
    if (username) {
      uname = String(username).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 30);
      if (uname.length < 3) return res.status(400).json({ error: "Username must be 3+ chars" });
      const { rows: ex } = await pool.query("SELECT id FROM chats WHERE username=$1", [uname]);
      if (ex.length) return res.status(409).json({ error: "Username taken" });
    }
    const { rows: [chat] } = await pool.query(
      "INSERT INTO chats (type,username,name,bio,avatar,visibility,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [type, uname, name.trim().slice(0, 100), (bio || "").slice(0, 500), avatar || "", (_isAdmin ? (visibility || "public") : (_isWizard ? "private" : "public")), req.user.id]
    );
    await pool.query("INSERT INTO chat_members (chat_id,user_id,role) VALUES ($1,$2,'admin')", [chat.id, req.user.id]);
    if (Array.isArray(members)) {
      for (const uid of members) {
        if (parseInt(uid) !== req.user.id) await pool.query("INSERT INTO chat_members (chat_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [chat.id, parseInt(uid)]);
      }
    }
    res.status(201).json({ chatId: chat.id });
  } catch (err) { console.error("Create chat:", err); res.status(500).json({ error: "Server error" }); }
});

// Chat details — non-members can view PUBLIC groups/channels
router.get("/:id", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const chatId = parseInt(req.params.id);
    const { rows: [chat] } = await pool.query("SELECT * FROM chats WHERE id=$1", [chatId]);
    if (!chat) return res.status(404).json({ error: "Not found" });
    const { rows: [mem] } = await pool.query("SELECT * FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id]);
    // Non-members can view public groups/channels (limited info)
    if (!mem) {
      if (chat.type !== "dm" && chat.visibility === "public") {
        const { rows: [ct] } = await pool.query("SELECT COUNT(*)::int AS c FROM chat_members WHERE chat_id=$1", [chatId]);
        return res.json({ ...chat, webhook_token: undefined, myRole: null, isMember: false, member_count: ct.c, members: [] });
      }
      return res.status(403).json({ error: "Not a member" });
    }
    let members = [];
    const isAdmin = mem.role === "admin" || req.user.role === "admin";
    // Always compute the true member count so the client never has to infer it
    // from members.length (which is 1 for the privacy-collapsed private view).
    const { rows: [ct] } = await pool.query("SELECT COUNT(*)::int AS c FROM chat_members WHERE chat_id=$1", [chatId]);
    if (chat.visibility === "private" && !isAdmin && chat.type !== "dm") {
      members = [{ count: ct.c }];
    } else {
      const { rows } = await pool.query("SELECT u.id,u.email,u.username,u.name,u.bio,u.avatar,u.role AS user_role,u.subscription_status,cm.role AS chat_role FROM users u JOIN chat_members cm ON u.id=cm.user_id WHERE cm.chat_id=$1 ORDER BY cm.role DESC,cm.joined_at", [chatId]);
      members = rows;
    }
    // VIP gate: a pro_only channel is readable only by active subscribers (and
    // admins). Non-subscribers still receive the channel info (so the client can
    // show an upgrade screen and the list keeps the latest signal) — but never the
    // messages, and the member list is already collapsed for private channels.
    let proLocked = false;
    if (chat.pro_only && !isAdmin) {
      const { rows: [su] } = await pool.query("SELECT subscription_status, subscription_expiry FROM users WHERE id=$1", [req.user.id]);
      proLocked = !(su && su.subscription_status === "active" && (!su.subscription_expiry || new Date(su.subscription_expiry) > new Date()));
    }
    const resp = { ...chat, myRole: mem.role, isMember: true, member_count: ct.c, members, pro_locked: proLocked };
    if (!isAdmin) delete resp.webhook_token;
    res.json(resp);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Update chat
// PUT /api/chats/bot/profile — admins edit the DrFX AI bot's profile
// (name / avatar / bio), the same way they edit a channel. The bot is a
// users row (role='bot'), so this updates the user, not a chat.
router.put("/bot/profile", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    if (req.user.role !== "admin" && req.user.role !== "superadmin") return res.status(403).json({ error: "Admin required" });
    const { name, bio, avatar } = req.body;
    const u = [], v = []; let i = 1;
    if (name !== undefined) { const nm = String(name).trim().slice(0, 100); if (!nm) return res.status(400).json({ error: "Name required" }); u.push("name=$" + (i++)); v.push(nm); }
    if (bio !== undefined) { u.push("bio=$" + (i++)); v.push(String(bio).slice(0, 500)); }
    if (avatar !== undefined) { if (badAvatar(avatar)) return res.status(400).json({ error: "Invalid avatar" }); u.push("avatar=$" + (i++)); v.push(String(avatar).slice(0, 500)); }
    if (!u.length) return res.status(400).json({ error: "Nothing to update" });
    const { rows: [bot] } = await pool.query(`UPDATE users SET ${u.join(",")} WHERE role='bot' RETURNING id,name,avatar,bio,role`, v);
    if (!bot) return res.status(404).json({ error: "Bot not found" });
    res.json(bot);
  } catch (err) { console.error("[chats] bot profile:", err.message); res.status(500).json({ error: "Server error" }); }
});

router.put("/:id", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const chatId = parseInt(req.params.id);
    const { rows: [mem] } = await pool.query("SELECT role FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id]);
    if (!mem || (mem.role !== "admin" && req.user.role !== "admin")) return res.status(403).json({ error: "Admin required" });
    const { name, bio, avatar, visibility, username, expire_hours } = req.body;
    const u = [], v = []; let i = 1;
    if (name !== undefined) { u.push(`name=$${i++}`); v.push(String(name).slice(0, 100)); }
    if (bio !== undefined) { u.push(`bio=$${i++}`); v.push(String(bio).slice(0, 500)); }
    if (avatar !== undefined) { if (badAvatar(avatar)) return res.status(400).json({ error: "Invalid avatar" }); u.push(`avatar=$${i++}`); v.push(String(avatar).slice(0, 500)); }
    if (visibility !== undefined) { u.push(`visibility=$${i++}`); v.push(visibility === "private" ? "private" : "public"); }
    if (expire_hours !== undefined) {
      // 0 / null / "" = keep messages forever; otherwise 1..168 hours (cap 7 days).
      let eh = (expire_hours === null || expire_hours === "" || expire_hours === 0 || expire_hours === "0") ? null : parseInt(expire_hours, 10);
      if (eh !== null && (isNaN(eh) || eh < 1 || eh > 168)) return res.status(400).json({ error: "expire_hours must be 1–168, or 0 to keep forever" });
      u.push(`expire_hours=$${i++}`); v.push(eh);
    }
    if (username !== undefined) {
      const un = String(username).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 30);
      if (un.length < 3) return res.status(400).json({ error: "Username 3+ chars" });
      const { rows: ex } = await pool.query("SELECT id FROM chats WHERE username=$1 AND id!=$2", [un, chatId]);
      if (ex.length) return res.status(409).json({ error: "Username taken" });
      u.push(`username=$${i++}`); v.push(un);
    }
    if (!u.length) return res.status(400).json({ error: "Nothing to update" });
    v.push(chatId);
    const { rows: [chat] } = await pool.query(`UPDATE chats SET ${u.join(",")} WHERE id=$${i} RETURNING *`, v);
    res.json(chat);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Delete chat
router.delete("/:id", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const chatId = parseInt(req.params.id);
    const { rows: [mem] } = await pool.query("SELECT role FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id]);
    if (!mem || (mem.role !== "admin" && req.user.role !== "admin")) return res.status(403).json({ error: "Admin required" });
    await pool.query("DELETE FROM messages WHERE chat_id=$1", [chatId]);
    await pool.query("DELETE FROM chat_members WHERE chat_id=$1", [chatId]);
    await pool.query("DELETE FROM chats WHERE id=$1", [chatId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Add member — self-join allowed for PUBLIC groups/channels, admin-only for private
router.post("/:id/members", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const chatId = parseInt(req.params.id);
    const targetUserId = parseInt(req.body.userId);
    const isSelfJoin = targetUserId === req.user.id;
    const { rows: [chat] } = await pool.query("SELECT type,visibility,pro_only FROM chats WHERE id=$1", [chatId]);
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    if (chat.type === "dm") return res.status(400).json({ error: "Cannot join DM" });
    // NOTE: pro_only (VIP) channels are open to EVERYONE as members — the channel
    // and its latest signal appear in every user's list (users are auto-joined on
    // register and at boot). Reading a VIP channel is gated to active subscribers
    // in the GET messages/pins handlers, so there is intentionally no membership
    // check here.
    // Self-join: allowed for public, blocked for private
    if (isSelfJoin) {
      if (chat.visibility === "private") return res.status(403).json({ error: "This is a private chat. An admin must add you." });
      // Public chat — allow self-join
      const { rows: [already] } = await pool.query("SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, targetUserId]);
      if (already) return res.json({ ok: true, already: true });
      await pool.query("INSERT INTO chat_members (chat_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [chatId, targetUserId]);
      return res.json({ ok: true });
    }
    // Adding someone else — admin only
    const { rows: [mem] } = await pool.query("SELECT role FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id]);
    if (!mem || (mem.role !== "admin" && req.user.role !== "admin")) return res.status(403).json({ error: "Admin required" });
    await pool.query("INSERT INTO chat_members (chat_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [chatId, targetUserId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Remove member
router.delete("/:id/members/:userId", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const chatId = parseInt(req.params.id), targetId = parseInt(req.params.userId);
    if (targetId !== req.user.id) {
      const { rows: [mem] } = await pool.query("SELECT role FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id]);
      if (!mem || (mem.role !== "admin" && req.user.role !== "admin")) return res.status(403).json({ error: "Admin required" });
    }
    await pool.query("DELETE FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, targetId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Get messages
router.get("/:id/messages", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const chatId = parseInt(req.params.id);
    const { rows: [mem] } = await pool.query("SELECT * FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id]);
    if (!mem) return res.status(403).json({ error: "Not a member" });
    // VIP gate: free members can see a pro_only channel and its latest signal in
    // their list, but only active subscribers (and admins) may read the messages.
    {
      const { rows: [pc] } = await pool.query("SELECT pro_only FROM chats WHERE id=$1", [chatId]);
      if (pc && pc.pro_only && mem.role !== "admin" && req.user.role !== "admin") {
        const { rows: [su] } = await pool.query("SELECT subscription_status, subscription_expiry FROM users WHERE id=$1", [req.user.id]);
        const active = !!su && su.subscription_status === "active" && (!su.subscription_expiry || new Date(su.subscription_expiry) > new Date());
        if (!active) return res.status(403).json({ error: "PRO subscription required", pro_locked: true });
      }
    }
    const before = req.query.before ? parseInt(req.query.before) : null;
    let q = `SELECT m.*,u.name AS sender_name,u.avatar AS sender_avatar,u.role AS sender_role,u.subscription_status AS sender_subscription,
      rm.content AS reply_content,rm.user_id AS reply_user_id,ru.name AS reply_sender_name
      FROM messages m JOIN users u ON m.user_id=u.id
      LEFT JOIN messages rm ON m.reply_to=rm.id
      LEFT JOIN users ru ON rm.user_id=ru.id
      WHERE m.chat_id=$1`;
    const params = [chatId];
    if (before) { q += " AND m.id<$2"; params.push(before); }
    q += " ORDER BY m.created_at DESC LIMIT 50";
    const { rows } = await pool.query(q, params);
    const rmap = await reactionsFor(pool, rows.map(r => r.id), req.user.id);
    rows.forEach(r => { r.reactions = rmap[r.id] || []; });
    res.json(rows.reverse());
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Send message
router.post("/:id/messages", async (req, res) => {
  const pool = req.app.get("pool"), io = req.app.get("io");
  try {
    const chatId = parseInt(req.params.id);
    const { content, image, reply_to, attachment } = req.body;
    if (!content?.trim() && !image && !attachment) return res.status(400).json({ error: "Message required" });
    // image must be an uploaded path from /api/upload — reject arbitrary or
    // javascript:/attribute-injection values before they reach other clients.
    if (image && !/^\/uploads\/[A-Za-z0-9._-]+$/.test(String(image))) return res.status(400).json({ error: "Invalid image" });
    const att = sanitizeAttachment(attachment);
    if (attachment && !att) return res.status(400).json({ error: "Invalid attachment" });
    const { rows: [mem] } = await pool.query("SELECT cm.role AS chat_role FROM chat_members cm WHERE cm.chat_id=$1 AND cm.user_id=$2", [chatId, req.user.id]);
    if (!mem) return res.status(403).json({ error: "Not a member" });
    const { rows: [chat] } = await pool.query("SELECT type FROM chats WHERE id=$1", [chatId]);
    if (chat?.type === "channel" && mem.chat_role !== "admin" && req.user.role !== "admin") return res.status(403).json({ error: "Only admins post in channels" });
    const text = (content || "").trim().slice(0, 4000), img = (image || "").slice(0, 500);
    const replyId = reply_to ? parseInt(reply_to) : null;
    const { rows: [msg] } = await pool.query("INSERT INTO messages (chat_id,user_id,content,image,reply_to,attachment) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *", [chatId, req.user.id, text, img, replyId, att ? JSON.stringify(att) : null]);
    const { rows: [sender] } = await pool.query("SELECT name,avatar,role,subscription_status FROM users WHERE id=$1", [req.user.id]);
    let replyInfo = {};
    if (replyId) {
      const { rows: [rm] } = await pool.query("SELECT m.content AS reply_content,m.user_id AS reply_user_id,u.name AS reply_sender_name FROM messages m JOIN users u ON m.user_id=u.id WHERE m.id=$1", [replyId]);
      if (rm) replyInfo = rm;
    }
    const payload = { ...msg, sender_name: sender.name, sender_avatar: sender.avatar, sender_role: sender.role, sender_subscription: sender.subscription_status, ...replyInfo };
    const { rows: members } = await pool.query("SELECT user_id FROM chat_members WHERE chat_id=$1", [chatId]);
    members.forEach(m => io.to(`user_${m.user_id}`).emit("chat_message", payload));
    await pool.query("UPDATE chat_members SET last_read_id=$1 WHERE chat_id=$2 AND user_id=$3", [msg.id, chatId, req.user.id]);
    // AI Bot
    if (chat?.type === "dm" && text) {
      const { rows: [botMem] } = await pool.query("SELECT u.id FROM users u JOIN chat_members cm ON u.id=cm.user_id WHERE cm.chat_id=$1 AND u.role='bot' LIMIT 1", [chatId]);
      if (botMem) {
        const { rows: [usr] } = await pool.query("SELECT subscription_status FROM users WHERE id=$1", [req.user.id]);
        if (usr?.subscription_status !== "active") {
          const { rows: [cnt] } = await pool.query("SELECT COUNT(*)::int AS c FROM messages WHERE chat_id=$1 AND user_id=$2 AND created_at>NOW()-INTERVAL '24 hours'", [chatId, req.user.id]);
          if (cnt.c > FREE_DAILY_LIMIT) {
            const { rows: [lm] } = await pool.query("INSERT INTO messages (chat_id,user_id,content) VALUES ($1,$2,$3) RETURNING *", [chatId, botMem.id, `⚠️ Free limit reached (${FREE_DAILY_LIMIT}/day). Upgrade to Pro for unlimited AI.`]);
            members.forEach(m => io.to(`user_${m.user_id}`).emit("chat_message", { ...lm, sender_name: "DrFX AI", sender_avatar: "🤖", sender_role: "bot" }));
            return res.json(payload);
          }
        }
        const { rows: hist } = await pool.query("SELECT m.content,u.role AS user_role FROM messages m JOIN users u ON m.user_id=u.id WHERE m.chat_id=$1 AND m.content!='' ORDER BY m.created_at DESC LIMIT 10", [chatId]);
        hist.reverse();
        const aiMsgs = [{ role: "system", content: AI_SYSTEM }, ...hist.map(h => ({ role: h.user_role === "bot" ? "assistant" : "user", content: h.content }))];
        setImmediate(async () => {
          try {
            let aiText = "⚠️ AI not configured. Set OPENROUTER_API_KEY in .env";
            if (OPENROUTER_KEY && OPENROUTER_KEY !== "your_openrouter_api_key_here") {
              const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${OPENROUTER_KEY}`,
                  "Content-Type": "application/json",
                  "HTTP-Referer": process.env.PUBLIC_URL || "https://drfx.io",
                  "X-Title": "DrFX Quant",
                },
                body: JSON.stringify({ model: OPENROUTER_MODEL, messages: aiMsgs, max_tokens: 2000 }),
              });
              const d = await r.json().catch(() => null);
              if (!r.ok) {
                const em = (d && d.error && (d.error.message || d.error)) || ("HTTP " + r.status);
                console.error("[AI] OpenRouter", r.status, JSON.stringify((d && d.error) || d || {}));
                aiText = "\u26A0\uFE0F AI error: " + em;
              } else {
                aiText = (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "No AI response.";
              }
            }
            const { rows: [am] } = await pool.query("INSERT INTO messages (chat_id,user_id,content) VALUES ($1,$2,$3) RETURNING *", [chatId, botMem.id, aiText]);
            members.forEach(m => io.to(`user_${m.user_id}`).emit("chat_message", { ...am, sender_name: "DrFX AI", sender_avatar: "🤖", sender_role: "bot" }));
          } catch (e) { console.error("AI:", e.message); }
        });
      }
    }
    res.json(payload);
  } catch (err) { console.error("Send:", err); res.status(500).json({ error: "Server error" }); }
});

// Edit message — any chat member can edit any message
router.put("/:chatId/messages/:msgId", async (req, res) => {
  const pool = req.app.get("pool"), io = req.app.get("io");
  try {
    const chatId = parseInt(req.params.chatId), msgId = parseInt(req.params.msgId);
    const { rows: [mem] } = await pool.query("SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id]);
    if (!mem) return res.status(403).json({ error: "Not a member" });
    const { rows: [msg] } = await pool.query("SELECT * FROM messages WHERE id=$1 AND chat_id=$2", [msgId, chatId]);
    if (!msg) return res.status(404).json({ error: "Not found" });
    // Only the author may edit; admins/managers may edit anyone's message.
    const canModerate = ["admin", "manager", "superadmin"].includes(req.user.role);
    if (msg.user_id !== req.user.id && !canModerate) return res.status(403).json({ error: "You can only edit your own messages" });
    const { content } = req.body;
    const { rows: [updated] } = await pool.query("UPDATE messages SET content=$1,edited_at=NOW() WHERE id=$2 RETURNING *", [String(content).slice(0, 4000), msgId]);
    const { rows: [sender] } = await pool.query("SELECT name,avatar,role,subscription_status FROM users WHERE id=$1", [msg.user_id]);
    const payload = { ...updated, sender_name: sender.name, sender_avatar: sender.avatar, sender_role: sender.role, sender_subscription: sender.subscription_status };
    const { rows: members } = await pool.query("SELECT user_id FROM chat_members WHERE chat_id=$1", [chatId]);
    members.forEach(m => io.to(`user_${m.user_id}`).emit("message_edited", payload));
    res.json(payload);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Delete message — any chat member can delete any message
router.delete("/:chatId/messages/:msgId", async (req, res) => {
  const pool = req.app.get("pool"), io = req.app.get("io");
  try {
    const chatId = parseInt(req.params.chatId), msgId = parseInt(req.params.msgId);
    const { rows: [mem] } = await pool.query("SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id]);
    if (!mem) return res.status(403).json({ error: "Not a member" });
    const { rows: [msg] } = await pool.query("SELECT * FROM messages WHERE id=$1 AND chat_id=$2", [msgId, chatId]);
    if (!msg) return res.status(404).json({ error: "Not found" });
    // Only the author may delete; admins/managers may delete anyone's message.
    const canModerate = ["admin", "manager", "superadmin"].includes(req.user.role);
    if (msg.user_id !== req.user.id && !canModerate) return res.status(403).json({ error: "You can only delete your own messages" });
    await pool.query("DELETE FROM messages WHERE id=$1", [msgId]);
    const { rows: members } = await pool.query("SELECT user_id FROM chat_members WHERE chat_id=$1", [chatId]);
    members.forEach(m => io.to(`user_${m.user_id}`).emit("message_deleted", { id: msgId, chat_id: chatId }));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Pin a message
router.post("/:chatId/messages/:msgId/pin", async (req, res) => {
  const pool = req.app.get("pool"), io = req.app.get("io");
  try {
    const chatId = parseInt(req.params.chatId), msgId = parseInt(req.params.msgId);
    const perm = await pinPermission(pool, chatId, req.user);
    if (!perm.ok) return res.status(perm.code).json({ error: perm.error });
    const { rows: [updated] } = await pool.query(
      "UPDATE messages SET pinned=TRUE, pinned_at=NOW(), pinned_by=$3 WHERE id=$1 AND chat_id=$2 RETURNING *",
      [msgId, chatId, req.user.id]
    );
    if (!updated) return res.status(404).json({ error: "Message not found" });
    const { rows: [s] } = await pool.query("SELECT name,avatar,role FROM users WHERE id=$1", [updated.user_id]);
    const payload = { ...updated, sender_name: s && s.name, sender_avatar: s && s.avatar, sender_role: s && s.role };
    const { rows: members } = await pool.query("SELECT user_id FROM chat_members WHERE chat_id=$1", [chatId]);
    members.forEach(m => io.to(`user_${m.user_id}`).emit("message_pinned", payload));
    res.json(payload);
  } catch (err) { console.error("Pin:", err); res.status(500).json({ error: "Server error" }); }
});

// Unpin a message
router.delete("/:chatId/messages/:msgId/pin", async (req, res) => {
  const pool = req.app.get("pool"), io = req.app.get("io");
  try {
    const chatId = parseInt(req.params.chatId), msgId = parseInt(req.params.msgId);
    const perm = await pinPermission(pool, chatId, req.user);
    if (!perm.ok) return res.status(perm.code).json({ error: perm.error });
    const { rows: [updated] } = await pool.query(
      "UPDATE messages SET pinned=FALSE, pinned_at=NULL, pinned_by=NULL WHERE id=$1 AND chat_id=$2 RETURNING id",
      [msgId, chatId]
    );
    if (!updated) return res.status(404).json({ error: "Message not found" });
    const { rows: members } = await pool.query("SELECT user_id FROM chat_members WHERE chat_id=$1", [chatId]);
    members.forEach(m => io.to(`user_${m.user_id}`).emit("message_unpinned", { id: msgId, chat_id: chatId }));
    res.json({ ok: true });
  } catch (err) { console.error("Unpin:", err); res.status(500).json({ error: "Server error" }); }
});

// React / unreact to a message (toggle). Any chat member may react.
router.post("/:chatId/messages/:msgId/react", async (req, res) => {
  const pool = req.app.get("pool"), io = req.app.get("io");
  try {
    const chatId = parseInt(req.params.chatId), msgId = parseInt(req.params.msgId);
    const emoji = String((req.body && req.body.emoji) || "");
    if (!REACTION_KEYS.includes(emoji)) return res.status(400).json({ error: "Invalid reaction" });
    const { rows: [mem] } = await pool.query("SELECT role FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id]);
    if (!mem) return res.status(403).json({ error: "Not a member" });
    const { rows: [msg] } = await pool.query("SELECT id FROM messages WHERE id=$1 AND chat_id=$2", [msgId, chatId]);
    if (!msg) return res.status(404).json({ error: "Message not found" });
    // VIP gate: reacting needs the same access as reading a pro_only channel.
    {
      const { rows: [pc] } = await pool.query("SELECT pro_only FROM chats WHERE id=$1", [chatId]);
      if (pc && pc.pro_only && mem.role !== "admin" && req.user.role !== "admin") {
        const { rows: [su] } = await pool.query("SELECT subscription_status, subscription_expiry FROM users WHERE id=$1", [req.user.id]);
        const active = !!su && su.subscription_status === "active" && (!su.subscription_expiry || new Date(su.subscription_expiry) > new Date());
        if (!active) return res.status(403).json({ error: "PRO subscription required" });
      }
    }
    // Toggle: remove if present, otherwise add.
    const { rowCount: existed } = await pool.query("DELETE FROM message_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3", [msgId, req.user.id, emoji]);
    if (!existed) {
      await pool.query("INSERT INTO message_reactions (message_id,user_id,emoji) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [msgId, req.user.id, emoji]);
    }
    // Recompute the aggregate for this message.
    const { rows: agg } = await pool.query(
      `SELECT emoji, COUNT(*)::int AS count, BOOL_OR(user_id=$2) AS mine
         FROM message_reactions WHERE message_id=$1 GROUP BY emoji ORDER BY MIN(created_at)`,
      [msgId, req.user.id]
    );
    const mine = agg.map(a => ({ emoji: a.emoji, count: a.count, mine: a.mine }));
    const counts = agg.map(a => ({ emoji: a.emoji, count: a.count }));
    // Broadcast counts-only to everyone in the chat; each client preserves its
    // own `mine` state (the caller also gets `mine` in the REST response).
    const { rows: members } = await pool.query("SELECT user_id FROM chat_members WHERE chat_id=$1", [chatId]);
    members.forEach(m => io.to(`user_${m.user_id}`).emit("reaction_updated", { message_id: msgId, chat_id: chatId, reactions: counts, actor_id: req.user.id, emoji, added: !existed }));
    res.json({ message_id: msgId, reactions: mine });
  } catch (err) { console.error("React:", err); res.status(500).json({ error: "Server error" }); }
});

// Pinned messages for a chat (most-recent first)
router.get("/:id/pins", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const chatId = parseInt(req.params.id);
    const { rows: [mem] } = await pool.query("SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id]);
    if (!mem) return res.status(403).json({ error: "Not a member" });
    {
      const { rows: [pc] } = await pool.query("SELECT pro_only FROM chats WHERE id=$1", [chatId]);
      if (pc && pc.pro_only && req.user.role !== "admin") {
        const { rows: [mr] } = await pool.query("SELECT role FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id]);
        if (!mr || mr.role !== "admin") {
          const { rows: [su] } = await pool.query("SELECT subscription_status, subscription_expiry FROM users WHERE id=$1", [req.user.id]);
          const active = !!su && su.subscription_status === "active" && (!su.subscription_expiry || new Date(su.subscription_expiry) > new Date());
          if (!active) return res.status(403).json({ error: "PRO subscription required", pro_locked: true });
        }
      }
    }
    const { rows } = await pool.query(
      `SELECT m.*,u.name AS sender_name,u.avatar AS sender_avatar,u.role AS sender_role
       FROM messages m JOIN users u ON m.user_id=u.id
       WHERE m.chat_id=$1 AND m.pinned=TRUE ORDER BY m.pinned_at DESC`,
      [chatId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Mark read
router.post("/:id/read", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const chatId = parseInt(req.params.id);
    const { rows: [last] } = await pool.query("SELECT MAX(id) AS mid FROM messages WHERE chat_id=$1", [chatId]);
    if (last?.mid) await pool.query("UPDATE chat_members SET last_read_id=$1 WHERE chat_id=$2 AND user_id=$3", [last.mid, chatId, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Global search: users + groups + channels by username, name, email
router.get("/users/search", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const q = req.query.q;
    if (!q || q.length < 2) return res.json({ users: [], chats: [] });
    const like = `%${q.toLowerCase()}%`;
    const { rows: users } = await pool.query(
      "SELECT id,email,username,name,avatar,role,subscription_status FROM users WHERE (LOWER(email) LIKE $1 OR LOWER(name) LIKE $1 OR LOWER(username) LIKE $1) AND id!=$2 AND role!='bot' LIMIT 15", [like, req.user.id]
    );
    const { rows: chats } = await pool.query(
      "SELECT id,type,username,name,avatar,visibility,(SELECT COUNT(*)::int FROM chat_members WHERE chat_id=chats.id) AS member_count FROM chats WHERE type IN ('group','channel') AND (LOWER(name) LIKE $1 OR LOWER(username) LIKE $1) LIMIT 15", [like]
    );
    res.json({ users, chats });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// ── Trading Notes ──
router.get("/trading-notes", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const { rows } = await pool.query("SELECT * FROM trading_notes WHERE user_id=$1 ORDER BY updated_at DESC", [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

router.get("/trading-notes/:symbol", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const { rows } = await pool.query("SELECT * FROM trading_notes WHERE user_id=$1 AND symbol=$2 ORDER BY updated_at DESC", [req.user.id, req.params.symbol]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

router.post("/trading-notes", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const { symbol, timeframe, direction, note } = req.body;
    if (!note?.trim()) return res.status(400).json({ error: "Note required" });
    const { rows: [n] } = await pool.query(
      "INSERT INTO trading_notes (user_id,symbol,timeframe,direction,note) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [req.user.id, (symbol||"").slice(0,50), (timeframe||"").slice(0,10), (direction||"").slice(0,10), note.trim().slice(0,2000)]
    );
    res.json(n);
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

router.delete("/trading-notes/:id", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    await pool.query("DELETE FROM trading_notes WHERE id=$1 AND user_id=$2", [parseInt(req.params.id), req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// ── Per-user chat pins (favorite a chat to the top of your own list) ──
// These always sort BELOW the fixed system channels (chats.pin_rank). Members
// only. The 5 fixed system channels (pin_rank set) cannot be user-pinned.
router.post("/:id/pin-chat", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const chatId = parseInt(req.params.id);
    const { rows: [mem] } = await pool.query("SELECT 1 FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id]);
    if (!mem) return res.status(403).json({ error: "Not a member" });
    const { rows: [c] } = await pool.query("SELECT pin_rank FROM chats WHERE id=$1", [chatId]);
    if (!c) return res.status(404).json({ error: "Chat not found" });
    if (c.pin_rank != null) return res.status(400).json({ error: "This channel is pinned by the team" });
    await pool.query("INSERT INTO chat_pins (user_id,chat_id) VALUES ($1,$2) ON CONFLICT (user_id,chat_id) DO NOTHING", [req.user.id, chatId]);
    res.json({ ok: true, pinned: true });
  } catch (err) { console.error("Pin chat:", err); res.status(500).json({ error: "Server error" }); }
});
router.delete("/:id/pin-chat", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const chatId = parseInt(req.params.id);
    await pool.query("DELETE FROM chat_pins WHERE user_id=$1 AND chat_id=$2", [req.user.id, chatId]);
    res.json({ ok: true, pinned: false });
  } catch (err) { console.error("Unpin chat:", err); res.status(500).json({ error: "Server error" }); }
});

// ── Admin-only: set/clear a channel's fixed top-of-list rank ──
// Lower rank = higher. Pass { rank: null } to remove from the fixed band. This
// is the ONLY way the order of the 5 system channels can change.
router.put("/:id/pin-rank", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    if (req.user.role !== "admin" && req.user.role !== "superadmin") return res.status(403).json({ error: "Admin required" });
    const chatId = parseInt(req.params.id);
    let rank = req.body ? req.body.rank : null;
    rank = (rank === null || rank === undefined || rank === "") ? null : parseInt(rank);
    if (rank !== null && (isNaN(rank) || rank < 1 || rank > 9999)) return res.status(400).json({ error: "Invalid rank" });
    const { rows: [c] } = await pool.query("UPDATE chats SET pin_rank=$1 WHERE id=$2 RETURNING id, pin_rank", [rank, chatId]);
    if (!c) return res.status(404).json({ error: "Chat not found" });
    res.json({ ok: true, id: c.id, pin_rank: c.pin_rank });
  } catch (err) { console.error("Pin rank:", err); res.status(500).json({ error: "Server error" }); }
});

// ── Clear chat history / delete a conversation ──
// Permanently removes ALL messages in a chat. For groups & channels this is
// admin-only (chat admin or a global admin). For a DM, either participant may
// clear it after a conversation. The chat itself stays; only messages go.
router.delete("/:id/messages", async (req, res) => {
  const pool = req.app.get("pool"), io = req.app.get("io");
  try {
    const chatId = parseInt(req.params.id);
    const { rows: [chat] } = await pool.query("SELECT type FROM chats WHERE id=$1", [chatId]);
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    const { rows: [mem] } = await pool.query("SELECT role FROM chat_members WHERE chat_id=$1 AND user_id=$2", [chatId, req.user.id]);
    if (!mem) return res.status(403).json({ error: "Not a member" });
    // DM: either participant may clear. Group/channel: admins only.
    if (chat.type !== "dm") {
      const isAdmin = mem.role === "admin" || ["admin", "manager", "superadmin"].includes(req.user.role);
      if (!isAdmin) return res.status(403).json({ error: "Only admins can clear history here" });
    }
    const { rowCount } = await pool.query("DELETE FROM messages WHERE chat_id=$1", [chatId]);
    // Reset everyone's read pointer so unread counts don't reference gone rows.
    await pool.query("UPDATE chat_members SET last_read_id=0 WHERE chat_id=$1", [chatId]);
    const { rows: members } = await pool.query("SELECT user_id FROM chat_members WHERE chat_id=$1", [chatId]);
    members.forEach(m => io.to(`user_${m.user_id}`).emit("chat_cleared", { chat_id: chatId }));
    res.json({ ok: true, deleted: rowCount });
  } catch (err) { console.error("Clear history:", err); res.status(500).json({ error: "Server error" }); }
});

module.exports = router;
