// services/push.js — Web Push (VAPID) sender. No-ops safely if web-push isn't
// installed or VAPID keys aren't configured, so the app boots regardless.
let webpush = null;
let enabled = false;
try {
  webpush = require("web-push");
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT || "mailto:admin@drfx.io";
  if (pub && priv) { webpush.setVapidDetails(subj, pub, priv); enabled = true; }
  else console.warn("[push] VAPID keys not set — push disabled (set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)");
} catch (e) { console.warn("[push] web-push not installed — push disabled (npm install web-push):", e.message); }

function isEnabled() { return enabled; }
function publicKey() { return process.env.VAPID_PUBLIC_KEY || null; }

// Send a push to every subscription a user has; prune dead endpoints (404/410).
async function sendToUser(pool, userId, payload) {
  if (!enabled || !pool || !userId) return;
  let subs;
  try { const { rows } = await pool.query("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=$1", [userId]); subs = rows; }
  catch (e) { return; }
  if (!subs || !subs.length) return;
  const body = JSON.stringify(payload || {});
  await Promise.all(subs.map(async (s) => {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 3600 }); }
    catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) { try { await pool.query("DELETE FROM push_subscriptions WHERE id=$1", [s.id]); } catch (_) {} }
    }
  }));
}
module.exports = { isEnabled, publicKey, sendToUser };
