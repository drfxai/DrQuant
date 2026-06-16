// services/pro.js
// ----------------------------------------------------------------------------
// Pro (VIP) channel membership lifecycle.
//
// A "Pro channel" is any channel row with pro_only = TRUE (the VIP Signals /
// VIP Algo / VIP Strategies channels seeded in database.js). Membership is tied
// to an ACTIVE subscription:
//   • on payment / admin-grant  -> joinProChannels()  (added to every VIP channel)
//   • on expiry / downgrade      -> leaveProChannels() (removed from every VIP channel)
//
// Channel owners/admins (chat_members.role = 'admin') are NEVER removed, so the
// platform admin keeps access regardless of subscription state.
//
// Every query is wrapped so a transient error here can never break the calling
// request (payment webhook, /auth/me, admin action, ...). The pro_only column is
// created idempotently in database.js initDB(), so it always exists at runtime.
// ----------------------------------------------------------------------------

async function joinProChannels(pool, userId) {
  try {
    await pool.query(
      `INSERT INTO chat_members (chat_id, user_id)
       SELECT id, $1 FROM chats WHERE type='channel' AND pro_only=TRUE
       ON CONFLICT (chat_id, user_id) DO NOTHING`,
      [userId]
    );
  } catch (e) {
    console.error("[pro] joinProChannels:", e.message);
  }
}

async function leaveProChannels(pool, userId) {
  try {
    // Remove the user from every VIP channel, but keep channel owners/admins.
    await pool.query(
      `DELETE FROM chat_members cm
       USING chats c
       WHERE cm.chat_id = c.id
         AND c.type='channel' AND c.pro_only=TRUE
         AND cm.user_id = $1
         AND cm.role <> 'admin'`,
      [userId]
    );
  } catch (e) {
    console.error("[pro] leaveProChannels:", e.message);
  }
}

// Reconcile a single user's VIP membership against their live subscription
// state. Handy where the caller doesn't already know the direction.
async function syncProMembership(pool, userId) {
  try {
    const { rows: [u] } = await pool.query(
      "SELECT subscription_status, subscription_expiry FROM users WHERE id=$1",
      [userId]
    );
    if (!u) return;
    const active =
      u.subscription_status === "active" &&
      (!u.subscription_expiry || new Date(u.subscription_expiry) > new Date());
    if (active) await joinProChannels(pool, userId);
    else await leaveProChannels(pool, userId);
  } catch (e) {
    console.error("[pro] syncProMembership:", e.message);
  }
}

module.exports = { joinProChannels, leaveProChannels, syncProMembership };
