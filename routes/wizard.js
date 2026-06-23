// routes/wizard.js
// ----------------------------------------------------------------------------
// Wizard ("guard") panel API.
//
// A WIZARD is a Pro user with LIMITED moderation powers over REGULAR users only
// (role='user'): view, block/unblock, grant/remove Pro, delete, and create
// PRIVATE groups/channels (the create path lives in routes/chats.js). A wizard
// can NEVER act on another wizard, an admin, a superadmin, or a bot, and can
// NEVER grant the wizard role. Only an ADMIN appoints/removes wizards.
//
// Mounted in server.js:  app.use("/api/wizard", require("./routes/wizard"));
//
// Reuses services/pro + services/rewards so a wizard's "make Pro" behaves
// exactly like the admin one (VIP channels + first-upgrade reward). Reduced
// view: usernames + status only, never emails.
// ----------------------------------------------------------------------------

const express = require("express");
const router = express.Router();
const { joinProChannels, leaveProChannels } = require("../services/pro");
const rewards = require("../services/rewards");

router.use((req, res, next) => req.app.get("authMiddleware")(req, res, next));

const isAdminRole = (r) => r === "admin" || r === "superadmin";

// Wizard-panel access. Re-reads the caller's LIVE role from the DB so a freshly
// appointed wizard works immediately (their JWT may still say 'user' until it
// refreshes). Wizards and admins may enter; everyone else is 403.
async function requireWizard(req, res, next) {
  try {
    const { rows: [me] } = await req.app.get("pool").query("SELECT role FROM users WHERE id=$1", [req.user.id]);
    const r = me && me.role;
    if (r) req.user.role = r;
    if (r === "wizard" || isAdminRole(r)) return next();
  } catch (e) {
    console.error("[wizard] guard:", e.message);
  }
  return res.status(403).json({ error: "Wizard access required" });
}

function requireAdmin(req, res, next) {
  if (isAdminRole(req.user && req.user.role)) return next();
  return res.status(403).json({ error: "Admin only" });
}

// Best-effort audit (mirrors routes/manage.js).
async function audit(req, action, targetId, metadata) {
  try {
    await req.app.get("pool").query(
      `INSERT INTO audit_logs (actor_id, actor_role, action, target_type, target_id, ip, metadata)
       VALUES ($1,$2,$3,'user',$4,$5,$6)`,
      [req.user.id, req.user.role, action, targetId != null ? String(targetId) : null, req.ip,
       metadata ? JSON.stringify(metadata) : null]
    );
  } catch (e) { console.error("[wizard] audit:", e.message); }
}

// Load a target the caller may MODERATE. The wizard rule is enforced here: only
// plain users (role='user') can be touched — never a wizard, admin, superadmin,
// bot, or yourself. This is what structurally makes a wizard "not a second admin".
async function loadTarget(req, res) {
  const pool = req.app.get("pool");
  const uid = parseInt(req.params.id, 10);
  if (!Number.isInteger(uid)) { res.status(400).json({ error: "Invalid user id" }); return null; }
  if (uid === req.user.id) { res.status(400).json({ error: "Cannot act on yourself" }); return null; }
  const { rows: [u] } = await pool.query("SELECT id, role, blocked, subscription_status FROM users WHERE id=$1", [uid]);
  if (!u) { res.status(404).json({ error: "User not found" }); return null; }
  if (u.role !== "user") { res.status(403).json({ error: "Wizards can only manage regular and Pro users" }); return null; }
  return u;
}

// ── List users — REDUCED view (no email) ──────────────────────────────────
//   segment=joined  -> regular users (role='user')
//   segment=pro     -> active subscribers (role='user' AND subscription active)
//   segment=wizards -> other wizards (view only; no actions allowed)
router.get("/users", requireWizard, async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const segment = ["joined", "pro", "wizards"].includes(req.query.segment) ? req.query.segment : "joined";
    const q = String(req.query.q || "").trim().toLowerCase();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 30, offset = (page - 1) * limit;

    let where;
    const vals = [];
    if (segment === "wizards") where = "role='wizard'";
    else if (segment === "pro") where = "role='user' AND subscription_status='active'";
    else where = "role='user'";

    if (q.length >= 2) {
      vals.push("%" + q + "%");
      where += " AND (LOWER(name) LIKE $" + vals.length + " OR LOWER(username) LIKE $" + vals.length + ")";
    }

    const { rows: [{ c: total }] } = await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE " + where, vals);
    vals.push(limit, offset);
    const { rows } = await pool.query(
      "SELECT id, username, name, avatar, role, subscription_status, blocked, created_at FROM users WHERE " +
        where + " ORDER BY created_at DESC LIMIT $" + (vals.length - 1) + " OFFSET $" + vals.length,
      vals
    );
    res.json({ users: rows, total, page, pages: Math.ceil(total / limit), segment });
  } catch (e) {
    console.error("[wizard] users:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Block / Unblock ───────────────────────────────────────────────────────
router.post("/users/:id/block", requireWizard, async (req, res) => {
  const u = await loadTarget(req, res); if (!u) return;
  await req.app.get("pool").query("UPDATE users SET blocked=TRUE WHERE id=$1", [u.id]);
  await audit(req, "wizard.user.block", u.id);
  res.json({ ok: true });
});

router.post("/users/:id/unblock", requireWizard, async (req, res) => {
  const u = await loadTarget(req, res); if (!u) return;
  await req.app.get("pool").query("UPDATE users SET blocked=FALSE WHERE id=$1", [u.id]);
  await audit(req, "wizard.user.unblock", u.id);
  res.json({ ok: true });
});

// ── Make Pro / Remove Pro (mirrors admin subscription logic) ──────────────
router.post("/users/:id/subscription", requireWizard, async (req, res) => {
  const pool = req.app.get("pool");
  const u = await loadTarget(req, res); if (!u) return;
  const status = req.body.status === "active" ? "active" : "free";
  try {
    if (status === "active") {
      const days = Math.max(1, Math.min(3650, parseInt(req.body.days, 10) || 30));
      const exp = new Date(Date.now() + days * 86400000).toISOString();
      await pool.query("UPDATE users SET subscription_status='active', subscription_expiry=$1 WHERE id=$2", [exp, u.id]);
      await joinProChannels(pool, u.id);
      await rewards.grantProReward(u.id);
      await audit(req, "wizard.user.pro_grant", u.id, { days });
    } else {
      await pool.query("UPDATE users SET subscription_status='free', subscription_expiry=NULL WHERE id=$1", [u.id]);
      await leaveProChannels(pool, u.id);
      await audit(req, "wizard.user.pro_revoke", u.id);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[wizard] subscription:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Delete user (mirrors admin delete) ────────────────────────────────────
router.delete("/users/:id", requireWizard, async (req, res) => {
  const pool = req.app.get("pool");
  const u = await loadTarget(req, res); if (!u) return;
  try {
    await pool.query("DELETE FROM messages WHERE user_id=$1", [u.id]);
    await pool.query("DELETE FROM chat_members WHERE user_id=$1", [u.id]);
    await pool.query("DELETE FROM payments WHERE user_id=$1", [u.id]);
    await pool.query("DELETE FROM users WHERE id=$1", [u.id]);
    await audit(req, "wizard.user.delete", u.id);
    res.json({ ok: true });
  } catch (e) {
    console.error("[wizard] delete:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Admin only: appoint / remove wizards ──────────────────────────────────
// Grant: target must currently be a plain user. Wizards receive Pro access.
router.post("/grant/:id", requireAdmin, async (req, res) => {
  const pool = req.app.get("pool");
  const uid = parseInt(req.params.id, 10);
  if (!Number.isInteger(uid)) return res.status(400).json({ error: "Invalid user id" });
  if (uid === req.user.id) return res.status(400).json({ error: "Cannot change your own role here" });
  try {
    const { rows: [u] } = await pool.query("SELECT id, role FROM users WHERE id=$1", [uid]);
    if (!u) return res.status(404).json({ error: "User not found" });
    if (u.role !== "user") return res.status(409).json({ error: "Only a regular user can be made a wizard" });
    const exp = new Date(Date.now() + 3650 * 86400000).toISOString(); // Pro access (long-lived)
    await pool.query("UPDATE users SET role='wizard', subscription_status='active', subscription_expiry=$1 WHERE id=$2", [exp, uid]);
    await joinProChannels(pool, uid).catch(() => {});
    await audit(req, "wizard.grant", uid);
    res.json({ ok: true });
  } catch (e) {
    console.error("[wizard] grant:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

// Revoke: wizard -> user. Pro access is left intact (admin can change it
// separately from the admin panel if desired).
router.post("/revoke/:id", requireAdmin, async (req, res) => {
  const pool = req.app.get("pool");
  const uid = parseInt(req.params.id, 10);
  if (!Number.isInteger(uid)) return res.status(400).json({ error: "Invalid user id" });
  try {
    const { rows: [u] } = await pool.query("SELECT id, role FROM users WHERE id=$1", [uid]);
    if (!u) return res.status(404).json({ error: "User not found" });
    if (u.role !== "wizard") return res.status(409).json({ error: "User is not a wizard" });
    await pool.query("UPDATE users SET role='user' WHERE id=$1", [uid]);
    await audit(req, "wizard.revoke", uid);
    res.json({ ok: true });
  } catch (e) {
    console.error("[wizard] revoke:", e.message);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
