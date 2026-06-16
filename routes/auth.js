const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const router = express.Router();
const { joinProChannels, leaveProChannels } = require("../services/pro");
const crypto = require("crypto");
const { smtpConfigured, sendOtpEmail } = require("../services/email");

// Shared: create the real user account + AI welcome DM + default/VIP channel
// memberships, then return a signed token. Used by /verify (after the emailed
// code is confirmed) and by /register directly when email confirmation is off.
async function createUserAccount(pool, JWT_SECRET, em, name, passwordHash) {
  const uname = em.split("@")[0].replace(/[^a-z0-9_]/g, "").slice(0, 30) + "_" + Date.now().toString(36).slice(-4);
  const { rows: [u] } = await pool.query(
    "INSERT INTO users (email,username,password_hash,name) VALUES ($1,$2,$3,$4) RETURNING id,email,username,name,bio,avatar,role,subscription_status",
    [em, uname, passwordHash, (name || em.split("@")[0]).slice(0, 50)]
  );
  const { rows: [bot] } = await pool.query("SELECT id FROM users WHERE role='bot' LIMIT 1");
  if (bot) {
    const { rows: [chat] } = await pool.query("INSERT INTO chats (type,created_by) VALUES ('dm',$1) RETURNING id", [u.id]);
    await pool.query("INSERT INTO chat_members (chat_id,user_id,role) VALUES ($1,$2,'member'),($1,$3,'member')", [chat.id, u.id, bot.id]);
    await pool.query("INSERT INTO messages (chat_id,user_id,content) VALUES ($1,$2,$3)", [chat.id, bot.id, "\uD83D\uDC4B Welcome to DrFX Quant!\n\nI'm your AI trading assistant. Ask me about:\n\u2022 Technical analysis & chart patterns\n\u2022 Trading strategies & risk management\n\u2022 Forex, Crypto, Stocks, Gold\n\u2022 Pine Script development\n\nHow can I help?"]);
  }
  // Auto-join the default broadcast channels (DrFX + Dr Signal), like the AI DM.
  try {
    const sigU = (process.env.SIGNAL_CHANNEL_USERNAME || "signals").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 30) || "signals";
    await pool.query(
      "INSERT INTO chat_members (chat_id,user_id) SELECT id, $1 FROM chats WHERE type='channel' AND username = ANY($2::text[]) ON CONFLICT DO NOTHING",
      [u.id, ["drfx", sigU]]
    );
  } catch (e) { console.error("Default channel join:", e.message); }
  // VIP (pro-only) channels are visible to everyone too (gated on open, see routes/chats.js).
  await joinProChannels(pool, u.id);
  const token = jwt.sign({ id: u.id, email: u.email, role: u.role }, JWT_SECRET, { expiresIn: "30d" });
  return { token, user: u };
}

function genCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, "0"); }

// Step 1 of sign-up. If SMTP is configured we email a 6-digit code and create
// NOTHING yet (the pending registration is stored with the password already
// hashed). If SMTP is NOT configured we fall back to instant registration so
// the site keeps working until email is set up.
router.post("/register", async (req, res) => {
  const pool = req.app.get("pool");
  const JWT_SECRET = req.app.get("jwt_secret");
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be 6+ characters" });
    const em = email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).json({ error: "Invalid email format" });
    const { rows: ex } = await pool.query("SELECT id FROM users WHERE email=$1", [em]);
    if (ex.length) return res.status(409).json({ error: "Email already registered" });
    const hash = await bcrypt.hash(password, 10);

    // No email service configured -> keep the original instant sign-up.
    if (!smtpConfigured()) {
      const out = await createUserAccount(pool, JWT_SECRET, em, name, hash);
      return res.status(201).json(out);
    }

    // Email confirmation flow: stash the pending registration + a fresh code.
    const code = genCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await pool.query(
      `INSERT INTO email_verifications (email, code, name, password_hash, attempts, expires_at)
       VALUES ($1,$2,$3,$4,0,$5)
       ON CONFLICT (email) DO UPDATE SET code=$2, name=$3, password_hash=$4, attempts=0, expires_at=$5, created_at=NOW()`,
      [em, code, (name || "").slice(0, 50), hash, expires]
    );
    try {
      await sendOtpEmail(em, code);
    } catch (e) {
      console.error("OTP email:", e.message);
      return res.status(502).json({ error: "Could not send the confirmation email. Please try again shortly." });
    }
    return res.json({ pending: true, email: em });
  } catch (err) { console.error("Register:", err); res.status(500).json({ error: "Server error" }); }
});

// Step 2 of sign-up: confirm the emailed code, then create the account + log in.
router.post("/verify", async (req, res) => {
  const pool = req.app.get("pool");
  const JWT_SECRET = req.app.get("jwt_secret");
  try {
    const em = String(req.body.email || "").toLowerCase().trim();
    const code = String(req.body.code || "").trim();
    if (!em || !code) return res.status(400).json({ error: "Email and code required" });
    const { rows: [v] } = await pool.query("SELECT * FROM email_verifications WHERE email=$1", [em]);
    if (!v) return res.status(400).json({ error: "No pending verification. Please register again." });
    if (new Date(v.expires_at) < new Date()) {
      await pool.query("DELETE FROM email_verifications WHERE email=$1", [em]);
      return res.status(400).json({ error: "Code expired. Please register again." });
    }
    if (v.attempts >= 6) {
      await pool.query("DELETE FROM email_verifications WHERE email=$1", [em]);
      return res.status(429).json({ error: "Too many attempts. Please register again." });
    }
    if (String(code) !== String(v.code)) {
      await pool.query("UPDATE email_verifications SET attempts=attempts+1 WHERE email=$1", [em]);
      return res.status(400).json({ error: "Incorrect code" });
    }
    // Guard a race where the email got registered in the meantime.
    const { rows: exNow } = await pool.query("SELECT id FROM users WHERE email=$1", [em]);
    if (exNow.length) { await pool.query("DELETE FROM email_verifications WHERE email=$1", [em]); return res.status(409).json({ error: "Email already registered" }); }
    const out = await createUserAccount(pool, JWT_SECRET, em, v.name, v.password_hash);
    await pool.query("DELETE FROM email_verifications WHERE email=$1", [em]);
    res.status(201).json(out);
  } catch (err) { console.error("Verify:", err); res.status(500).json({ error: "Server error" }); }
});

// Re-send a fresh confirmation code for a pending registration.
router.post("/resend", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const em = String(req.body.email || "").toLowerCase().trim();
    if (!em) return res.status(400).json({ error: "Email required" });
    if (!smtpConfigured()) return res.status(400).json({ error: "Email service not configured" });
    const { rows: [v] } = await pool.query("SELECT email FROM email_verifications WHERE email=$1", [em]);
    if (!v) return res.status(400).json({ error: "No pending verification. Please register again." });
    const code = genCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await pool.query("UPDATE email_verifications SET code=$1, attempts=0, expires_at=$2, created_at=NOW() WHERE email=$3", [code, expires, em]);
    try { await sendOtpEmail(em, code); }
    catch (e) { console.error("OTP resend:", e.message); return res.status(502).json({ error: "Could not send the confirmation email." }); }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// Login supports username OR email
router.post("/login", async (req, res) => {
  const pool = req.app.get("pool");
  const JWT_SECRET = req.app.get("jwt_secret");
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Credentials required" });
    const input = email.toLowerCase().trim();
    // Try email first, then username
    let user;
    if (input.includes("@")) {
      const { rows: [u] } = await pool.query("SELECT * FROM users WHERE email=$1", [input]);
      user = u;
    } else {
      const { rows: [u] } = await pool.query("SELECT * FROM users WHERE username=$1", [input]);
      user = u;
    }
    // Fallback: try the other field
    if (!user) {
      const { rows: [u] } = await pool.query("SELECT * FROM users WHERE email=$1 OR username=$1", [input]);
      user = u;
    }
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    if (user.blocked) return res.status(403).json({ error: "Account suspended" });
    if (user.role === "bot") return res.status(403).json({ error: "Cannot login as bot" });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });
    if (user.subscription_status === "active" && user.subscription_expiry && new Date(user.subscription_expiry) < new Date()) {
      await pool.query("UPDATE users SET subscription_status='free' WHERE id=$1", [user.id]);
      user.subscription_status = "free";
      await leaveProChannels(pool, user.id);
    } else if (user.subscription_status === "active") {
      await joinProChannels(pool, user.id);
    }
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user.id, email: user.email, username: user.username, name: user.name, bio: user.bio, avatar: user.avatar, role: user.role, subscription_status: user.subscription_status, subscription_expiry: user.subscription_expiry } });
  } catch (err) { console.error("Login:", err); res.status(500).json({ error: "Server error" }); }
});

router.get("/me", async (req, res) => {
  const pool = req.app.get("pool");
  req.app.get("authMiddleware")(req, res, async () => {
    try {
      const { rows: [u] } = await pool.query("SELECT id,email,username,name,bio,avatar,role,subscription_status,subscription_expiry,created_at FROM users WHERE id=$1", [req.user.id]);
      if (!u) return res.status(404).json({ error: "Not found" });
      if (u.subscription_status === "active" && u.subscription_expiry && new Date(u.subscription_expiry) < new Date()) {
        await pool.query("UPDATE users SET subscription_status='free' WHERE id=$1", [u.id]);
        u.subscription_status = "free";
        await leaveProChannels(pool, u.id);
      } else if (u.subscription_status === "active") {
        await joinProChannels(pool, u.id);
      }
      res.json(u);
    } catch (err) { res.status(500).json({ error: "Server error" }); }
  });
});

router.put("/profile", async (req, res) => {
  const pool = req.app.get("pool");
  req.app.get("authMiddleware")(req, res, async () => {
    try {
      const { name, bio, avatar, username } = req.body;
      const updates = [], vals = [];
      let i = 1;
      // Reject avatars carrying markup / inline handlers / script URLs (the
      // client renders avatars safely too — this is defense-in-depth).
      if (avatar !== undefined && (/[<>"'()]/.test(String(avatar)) || /^\s*(javascript|data|vbscript):/i.test(String(avatar)))) return res.status(400).json({ error: "Invalid avatar" });
      if (name !== undefined) { updates.push(`name=$${i++}`); vals.push(String(name).slice(0, 50)); }
      if (bio !== undefined) { updates.push(`bio=$${i++}`); vals.push(String(bio).slice(0, 200)); }
      if (avatar !== undefined) { updates.push(`avatar=$${i++}`); vals.push(String(avatar).slice(0, 500)); }
      if (username !== undefined) {
        const un = String(username).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 30);
        if (un.length < 3) return res.status(400).json({ error: "Username must be 3+ chars (a-z, 0-9, _)" });
        const { rows: ex } = await pool.query("SELECT id FROM users WHERE username=$1 AND id!=$2", [un, req.user.id]);
        if (ex.length) return res.status(409).json({ error: "Username taken" });
        updates.push(`username=$${i++}`); vals.push(un);
      }
      if (!updates.length) return res.status(400).json({ error: "Nothing to update" });
      vals.push(req.user.id);
      const { rows: [u] } = await pool.query(`UPDATE users SET ${updates.join(",")} WHERE id=$${i} RETURNING id,email,username,name,bio,avatar,role,subscription_status`, vals);
      res.json(u);
    } catch (err) { res.status(500).json({ error: err.detail?.includes("username") ? "Username taken" : "Server error" }); }
  });
});

module.exports = router;
