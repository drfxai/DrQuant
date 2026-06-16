const express = require("express");
const router = express.Router();
const { joinProChannels, leaveProChannels } = require("../services/pro");
router.use((req, res, next) => { req.app.get("authMiddleware")(req, res, () => { req.app.get("adminMiddleware")(req, res, next); }); });

router.get("/stats", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const q = async (sql) => (await pool.query(sql)).rows[0].c;
    res.json({
      totalUsers: await q("SELECT COUNT(*)::int AS c FROM users WHERE role!='bot'"),
      activeUsers: await q("SELECT COUNT(*)::int AS c FROM users WHERE subscription_status='active' AND role!='bot'"),
      freeUsers: await q("SELECT COUNT(*)::int AS c FROM users WHERE subscription_status='free'"),
      blockedUsers: await q("SELECT COUNT(*)::int AS c FROM users WHERE blocked=TRUE"),
      totalChats: await q("SELECT COUNT(*)::int AS c FROM chats"),
      totalMessages: await q("SELECT COUNT(*)::int AS c FROM messages"),
      groups: await q("SELECT COUNT(*)::int AS c FROM chats WHERE type='group'"),
      channels: await q("SELECT COUNT(*)::int AS c FROM chats WHERE type='channel'"),
      newToday: await q("SELECT COUNT(*)::int AS c FROM users WHERE created_at>=CURRENT_DATE"),
      msgsToday: await q("SELECT COUNT(*)::int AS c FROM messages WHERE created_at>=CURRENT_DATE"),
    });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

router.get("/users", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const search = (req.query.q || "").trim().toLowerCase();
    const limit = 30, offset = (page - 1) * limit;
    let rows, total;
    if (search.length >= 2) {
      const like = `%${search}%`;
      ({ rows } = await pool.query(
        "SELECT id,email,username,name,avatar,role,subscription_status,blocked,created_at FROM users WHERE role!='bot' AND (LOWER(email) LIKE $1 OR LOWER(name) LIKE $1 OR LOWER(username) LIKE $1) ORDER BY created_at DESC LIMIT $2 OFFSET $3",
        [like, limit, offset]
      ));
      ({ rows: [{ c: total }] } = await pool.query(
        "SELECT COUNT(*)::int AS c FROM users WHERE role!='bot' AND (LOWER(email) LIKE $1 OR LOWER(name) LIKE $1 OR LOWER(username) LIKE $1)", [like]
      ));
    } else {
      ({ rows } = await pool.query(
        "SELECT id,email,username,name,avatar,role,subscription_status,blocked,created_at FROM users WHERE role!='bot' ORDER BY created_at DESC LIMIT $1 OFFSET $2",
        [limit, offset]
      ));
      ({ rows: [{ c: total }] } = await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE role!='bot'"));
    }
    res.json({ users: rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { console.error("Admin users:", err); res.status(500).json({ error: "Server error" }); }
});

router.post("/users/:id/block", async (req, res) => {
  const pool = req.app.get("pool");
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: "Cannot block yourself" });
  await pool.query("UPDATE users SET blocked=TRUE WHERE id=$1", [parseInt(req.params.id)]);
  res.json({ ok: true });
});

router.post("/users/:id/unblock", async (req, res) => {
  await req.app.get("pool").query("UPDATE users SET blocked=FALSE WHERE id=$1", [parseInt(req.params.id)]);
  res.json({ ok: true });
});

router.post("/users/:id/subscription", async (req, res) => {
  const pool = req.app.get("pool");
  const { status, days } = req.body, uid = parseInt(req.params.id);
  if (status === "active") {
    const exp = new Date(Date.now() + (days || 30) * 86400000).toISOString();
    await pool.query("UPDATE users SET subscription_status='active',subscription_expiry=$1 WHERE id=$2", [exp, uid]);
    await joinProChannels(pool, uid); // grant Pro -> add to VIP channels
  } else {
    await pool.query("UPDATE users SET subscription_status='free',subscription_expiry=NULL WHERE id=$1", [uid]);
    await leaveProChannels(pool, uid); // revoke Pro -> remove from VIP channels
  }
  res.json({ ok: true });
});

router.delete("/users/:id", async (req, res) => {
  const pool = req.app.get("pool"), uid = parseInt(req.params.id);
  if (uid === req.user.id) return res.status(400).json({ error: "Cannot delete yourself" });
  await pool.query("DELETE FROM messages WHERE user_id=$1", [uid]);
  await pool.query("DELETE FROM chat_members WHERE user_id=$1", [uid]);
  await pool.query("DELETE FROM payments WHERE user_id=$1", [uid]);
  await pool.query("DELETE FROM users WHERE id=$1", [uid]);
  res.json({ ok: true });
});

module.exports = router;
