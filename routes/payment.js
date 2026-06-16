const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { joinProChannels, leaveProChannels } = require("../services/pro");
const IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
const NP_API_KEY = process.env.NOWPAYMENTS_API_KEY;
const DAYS = 30, PRICE = 56;

router.post("/create", (req, res) => {
  req.app.get("authMiddleware")(req, res, async () => {
    const pool = req.app.get("pool");
    try {
      if (!NP_API_KEY || NP_API_KEY === "your_nowpayments_api_key_here") return res.status(500).json({ error: "Payment not configured" });
      const r = await fetch("https://api.nowpayments.io/v1/invoice", {
        method: "POST", headers: { "x-api-key": NP_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ price_amount: PRICE, price_currency: "usd", order_id: `drfx_${req.user.id}_${Date.now()}`, order_description: "DrFX Quantum Pro 30d", ipn_callback_url: `${req.headers.origin||"https://drfx.com"}/api/payment/webhook`, success_url: `${req.headers.origin||"https://drfx.com"}/#ok`, cancel_url: `${req.headers.origin||"https://drfx.com"}/#cancel` }),
      });
      const d = await r.json();
      await pool.query("INSERT INTO payments (user_id,payment_id,amount,currency,status) VALUES ($1,$2,$3,'usd','pending')", [req.user.id, d.id, PRICE]);
      res.json({ invoice_url: d.invoice_url, payment_id: d.id });
    } catch (err) { res.status(500).json({ error: "Payment failed" }); }
  });
});

router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const pool = req.app.get("pool");
  try {
    // Verified IPN ONLY. Previously, if the signature header was simply omitted
    // the check was skipped entirely — letting anyone POST a "finished" callback
    // and grant themselves a paid subscription. Require the secret AND a
    // matching signature (constant-time compare), parsing the raw body properly.
    if (!IPN_SECRET) {
      console.warn("[payment] webhook hit but NOWPAYMENTS_IPN_SECRET is not set — refusing to grant.");
      return res.status(503).json({ error: "Webhook not configured" });
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8")
      : (typeof req.body === "string" ? req.body : JSON.stringify(req.body));
    {
      const sig = req.headers["x-nowpayments-sig"];
      if (!sig) return res.status(401).json({ error: "Missing signature" });
      let parsed;
      try { parsed = JSON.parse(rawBody); } catch { return res.status(400).json({ error: "Bad body" }); }
      const sorted = Object.keys(parsed).sort().reduce((r, k) => { r[k] = parsed[k]; return r; }, {});
      const hash = crypto.createHmac("sha512", IPN_SECRET).update(JSON.stringify(sorted)).digest("hex");
      const a = Buffer.from(hash, "utf8"), b = Buffer.from(String(sig), "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: "Bad signature" });
    }
    const data = JSON.parse(rawBody);
    const { payment_status, order_id, payment_id } = data;
    if (!order_id?.startsWith("drfx_")) return res.status(400).json({ error: "Bad order" });
    const userId = parseInt(order_id.split("_")[1]);
    await pool.query("UPDATE payments SET status=$1,payment_id=$2 WHERE id=(SELECT id FROM payments WHERE user_id=$3 AND status='pending' ORDER BY created_at DESC LIMIT 1)", [payment_status, payment_id, userId]);
    if (["confirmed", "finished"].includes(payment_status)) {
      const exp = new Date(Date.now() + DAYS * 86400000).toISOString();
      const { rows: [u] } = await pool.query("SELECT subscription_expiry FROM users WHERE id=$1", [userId]);
      const ne = u?.subscription_expiry && new Date(u.subscription_expiry) > new Date() ? new Date(new Date(u.subscription_expiry).getTime() + DAYS * 86400000).toISOString() : exp;
      await pool.query("UPDATE users SET subscription_status='active',subscription_expiry=$1 WHERE id=$2", [ne, userId]);
      // Active subscriber -> auto-join every VIP (pro-only) channel.
      await joinProChannels(pool, userId);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: "Webhook failed" }); }
});

router.get("/status", (req, res) => {
  req.app.get("authMiddleware")(req, res, async () => {
    const pool = req.app.get("pool");
    const { rows: [u] } = await pool.query("SELECT subscription_status,subscription_expiry FROM users WHERE id=$1", [req.user.id]);
    if (!u) return res.status(404).json({ error: "Not found" });
    if (u.subscription_status === "active" && u.subscription_expiry && new Date(u.subscription_expiry) < new Date()) {
      await pool.query("UPDATE users SET subscription_status='free' WHERE id=$1", [req.user.id]);
      u.subscription_status = "free";
      await leaveProChannels(pool, req.user.id); // lapsed -> remove from VIP channels
    } else if (u.subscription_status === "active") {
      await joinProChannels(pool, req.user.id); // self-heal VIP membership for active subs
    }
    const dl = u.subscription_status === "active" && u.subscription_expiry ? Math.max(0, Math.ceil((new Date(u.subscription_expiry) - new Date()) / 86400000)) : 0;
    res.json({ status: u.subscription_status, expiry: u.subscription_expiry, daysLeft: dl, price: PRICE });
  });
});

module.exports = router;
