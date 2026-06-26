// services/league-rituals.js
// ----------------------------------------------------------------------------
// League Unlock Ritual — a gamified, NON-YIELD 7-day ascension mechanic.
//
// Flow:
//   start   user commits the league's stake_for_unlock QNTM. The amount is LOCKED
//           (available -> locked, on the real ledger) and a 7-day countdown begins.
//           The target league enters "Ascending" (pending_unlock).
//   wait    for 7 days the user watches the countdown. Tokens stay locked.
//   settle  at unlock_at the locked QNTM is RETURNED (locked -> available) and the
//           league becomes permanently Unlocked/Active. A welcome event fires.
//           Settlement happens either when the user claims (manual) or via the
//           sweeper one pass after unlock_at (auto) — whichever comes first.
//
// The stake is a one-time QUALIFICATION RITUAL, not a permanent lock: the league
// stays unlocked after the tokens are returned. There is NO yield, NO interest,
// NO extra tokens — the user gets back exactly what they committed. See
// qntm-ledger/COMPLIANCE.md.
//
// Token movement goes through the authoritative ledger (postTransaction), reusing
// the staking_lock / staking_unlock transaction types and tagging them with
// reference.type='league_unlock'. Each ritual + its release is one atomic ledger
// transaction; the ledger's non-negative trigger guarantees solvency. Because the
// engine pool and the host pool target the SAME database, the ritual row and the
// user_league_status update are written on the SAME connection/transaction as the
// token movement — fully atomic.
// ----------------------------------------------------------------------------
"use strict";

const { pool: hostPool } = require("../database");
const { withTransaction } = require("../qntm-ledger/src/db");
const { postTransaction } = require("../qntm-ledger/src/ledger");
const wallets = require("../qntm-ledger/src/wallets");

const RITUAL_DAYS = Math.max(1, Number(process.env.LEAGUE_RITUAL_DAYS || 7));

function err(code, message, status) {
  const e = new Error(message || code);
  e.code = code;
  e.status = status || 400;
  return e;
}

// ── START a ritual ───────────────────────────────────────────────────────────
// Validates eligibility, locks the league's stake_for_unlock QNTM, opens the
// 7-day window. Returns the data the UI needs to render the countdown.
async function startRitual(userId, leagueId) {
  leagueId = Number(leagueId);
  if (!userId || !Number.isInteger(leagueId)) throw err("bad_request", "userId and a valid leagueId are required");

  // League must exist and be ritual-eligible (Discovery/base has stake_for_unlock=0).
  const { rows: drows } = await hostPool.query(
    "SELECT id, name, earned_threshold_qntm, stake_for_unlock_qntm FROM league_definitions WHERE id=$1",
    [leagueId]
  );
  if (!drows.length) throw err("no_league", "unknown league");
  const def = drows[0];
  const amount = Number(def.stake_for_unlock_qntm);
  if (!(amount > 0)) throw err("no_ritual_for_league", def.name + " has no unlock ritual (it is the base league)");

  // User status: must be earned-qualified for this league and not already in it.
  await hostPool.query(
    "INSERT INTO user_league_status (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
    [userId]
  );
  const { rows: srows } = await hostPool.query(
    "SELECT total_earned_qntm, COALESCE(current_league_id,0) AS current FROM user_league_status WHERE user_id=$1",
    [userId]
  );
  const earned = BigInt(srows[0].total_earned_qntm);
  const current = Number(srows[0].current) || 0;
  if (earned < BigInt(def.earned_threshold_qntm)) {
    throw err("not_qualified", "you have not earned enough QNTM to qualify for " + def.name);
  }
  if (leagueId <= current) throw err("already_unlocked", def.name + " is already unlocked");

  // Affordability pre-check (the ledger trigger is the hard backstop).
  const w = await wallets.getUserWallet(String(userId), "user", "QNTM");
  const available = w ? Math.floor(Number(w.available_balance)) : 0;
  if (available < amount) {
    throw err("insufficient", "you need " + (amount - available) + " more QNTM to start the " + def.name + " ritual");
  }

  try {
    return await withTransaction(async (cx) => {
      const wallet = await wallets.getOrCreateWallet("user", String(userId), "personal", "QNTM", cx);

      const { rows: ins } = await cx.query(
        `INSERT INTO league_unlock_rituals (user_id, league_id, amount_qntm, status, stake_at, unlock_at)
         VALUES ($1, $2, $3, 'pending_unlock', now(), now() + ($4 * INTERVAL '1 day'))
         RETURNING id, unlock_at, stake_at`,
        [userId, leagueId, amount, RITUAL_DAYS]
      );
      const ritual = ins[0];

      const lockTxn = await postTransaction({
        type: "staking_lock",
        amount: String(amount),
        movements: [
          { walletId: wallet.id, direction: "debit", amount: String(amount), balance: "available", description: "League unlock ritual — lock" },
          { walletId: wallet.id, direction: "credit", amount: String(amount), balance: "locked", description: "League unlock ritual — lock" },
        ],
        initiatorUserId: String(userId),
        reference: { type: "league_unlock", id: ritual.id },
        idempotencyKey: "lr:lock:" + ritual.id,
        metadata: { app: "leagues", kind: "league_unlock_lock", leagueId },
      }, cx);

      await cx.query("UPDATE league_unlock_rituals SET lock_txn=$2 WHERE id=$1", [ritual.id, lockTxn.public_id]);

      return {
        ritualId: ritual.id,
        leagueId,
        leagueName: def.name,
        amount,
        stakeAt: ritual.stake_at,
        unlockAt: ritual.unlock_at,
        ritualDays: RITUAL_DAYS,
      };
    });
  } catch (e) {
    if (e && e.code === "23505") throw err("ritual_in_progress", "you already have an unlock ritual in progress", 409);
    if (e && (e.code === "insufficient_funds" || /insufficient/i.test(e.message || ""))) {
      throw err("insufficient", "not enough QNTM in your wallet to start this ritual");
    }
    throw e;
  }
}

// ── internal: settle one ritual row (already SELECTed FOR UPDATE within cx) ────
// Releases the locked QNTM back to available and unlocks the league permanently.
async function _settle(cx, ritual, via) {
  const wallet = await wallets.getOrCreateWallet("user", String(ritual.user_id), "personal", "QNTM", cx);

  const releaseTxn = await postTransaction({
    type: "staking_unlock",
    amount: String(ritual.amount_qntm),
    movements: [
      { walletId: wallet.id, direction: "debit", amount: String(ritual.amount_qntm), balance: "locked", description: "League unlock ritual — release" },
      { walletId: wallet.id, direction: "credit", amount: String(ritual.amount_qntm), balance: "available", description: "League unlock ritual — release" },
    ],
    initiatorUserId: String(ritual.user_id),
    reference: { type: "league_unlock", id: ritual.id },
    idempotencyKey: "lr:release:" + ritual.id,
    metadata: { app: "leagues", kind: "league_unlock_release", leagueId: ritual.league_id, via },
  }, cx);

  await cx.query(
    "UPDATE league_unlock_rituals SET status='completed', completed_at=now(), released_via=$2, release_txn=$3 WHERE id=$1",
    [ritual.id, via, releaseTxn.public_id]
  );

  // Permanently unlock the league. The unlock is NOT tied to the (now returned)
  // tokens — current/unlocked only ever ratchets upward here.
  await cx.query(
    `UPDATE user_league_status
        SET unlocked_league_id = GREATEST(COALESCE(unlocked_league_id,0), $2),
            current_league_id  = GREATEST(COALESCE(current_league_id,0), $2, 1),
            current_league_status = 'Active',
            updated_at = now()
      WHERE user_id = $1`,
    [ritual.user_id, ritual.league_id]
  );

  const { rows: dn } = await cx.query("SELECT name FROM league_definitions WHERE id=$1", [ritual.league_id]);
  return { userId: ritual.user_id, leagueId: ritual.league_id, leagueName: dn[0] ? dn[0].name : null, amount: Number(ritual.amount_qntm), via };
}

// ── CLAIM (manual) — user finalizes after the countdown reaches zero ──────────
async function claimRitual(userId, ritualId) {
  ritualId = Number(ritualId);
  return withTransaction(async (cx) => {
    const { rows } = await cx.query(
      "SELECT * FROM league_unlock_rituals WHERE id=$1 AND user_id=$2 FOR UPDATE",
      [ritualId, userId]
    );
    if (!rows.length) throw err("not_found", "ritual not found", 404);
    const r = rows[0];
    if (r.status !== "pending_unlock") throw err("already_completed", "this ritual is already complete");
    if (new Date(r.unlock_at) > new Date()) {
      const secs = Math.max(0, Math.floor((new Date(r.unlock_at).getTime() - Date.now()) / 1000));
      throw err("not_ready", "ritual still ascending — " + secs + "s remaining");
    }
    return _settle(cx, r, "manual");
  });
}

// ── SWEEPER — auto-settle every matured ritual one pass after unlock_at ───────
// Returns the completed unlocks so the caller can push realtime welcome events.
async function sweepMatured(limit = 200) {
  const { rows: due } = await hostPool.query(
    "SELECT id FROM league_unlock_rituals WHERE status='pending_unlock' AND now() >= unlock_at ORDER BY unlock_at LIMIT $1",
    [limit]
  );
  const done = [];
  for (const d of due) {
    try {
      const settled = await withTransaction(async (cx) => {
        const { rows } = await cx.query(
          "SELECT * FROM league_unlock_rituals WHERE id=$1 AND status='pending_unlock' AND now() >= unlock_at FOR UPDATE",
          [d.id]
        );
        if (!rows.length) return null; // claimed/handled by another pass
        return _settle(cx, rows[0], "auto");
      });
      if (settled) done.push(settled);
    } catch (e) {
      console.error("[leagues] ritual settle failed for #" + d.id + ": " + (e && e.message));
    }
  }
  return done;
}

// ── ADMIN oversight: totals, per-league breakdown, recent rituals, chart series ─
async function adminStats() {
  const [totals, byLeague, recent, series] = await Promise.all([
    hostPool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='pending_unlock')                       AS active,
         COUNT(*) FILTER (WHERE status='completed')                            AS completed,
         COALESCE(SUM(amount_qntm) FILTER (WHERE status='pending_unlock'),0)   AS locked_qntm,
         COUNT(DISTINCT user_id) FILTER (WHERE status='pending_unlock')        AS active_users
       FROM league_unlock_rituals`
    ),
    hostPool.query(
      `SELECT d.id, d.name, d.stake_for_unlock_qntm,
              COUNT(r.id) FILTER (WHERE r.status='pending_unlock')                     AS active,
              COUNT(r.id) FILTER (WHERE r.status='completed')                          AS completed,
              COALESCE(SUM(r.amount_qntm) FILTER (WHERE r.status='pending_unlock'),0)  AS locked_qntm
         FROM league_definitions d
         LEFT JOIN league_unlock_rituals r ON r.league_id = d.id
        GROUP BY d.id, d.name, d.stake_for_unlock_qntm
        ORDER BY d.id`
    ),
    hostPool.query(
      `SELECT r.id, r.user_id, u.username, u.name AS user_name,
              r.league_id, d.name AS league_name, r.amount_qntm, r.status,
              r.stake_at, r.unlock_at, r.completed_at, r.released_via
         FROM league_unlock_rituals r
         JOIN league_definitions d ON d.id = r.league_id
         LEFT JOIN users u ON u.id = r.user_id
        ORDER BY r.id DESC LIMIT 50`
    ),
    hostPool.query(
      `SELECT to_char(date_trunc('day', completed_at), 'YYYY-MM-DD') AS day,
              COUNT(*) AS unlocks
         FROM league_unlock_rituals
        WHERE status='completed' AND completed_at >= now() - INTERVAL '14 days'
        GROUP BY 1 ORDER BY 1`
    ),
  ]);

  const t = totals.rows[0] || {};
  return {
    totals: {
      activeRituals: Number(t.active || 0),
      completedRituals: Number(t.completed || 0),
      lockedQntm: Number(t.locked_qntm || 0),
      activeUsers: Number(t.active_users || 0),
    },
    byLeague: byLeague.rows.map((r) => ({
      id: r.id, name: r.name,
      stakeForUnlock: Number(r.stake_for_unlock_qntm),
      active: Number(r.active || 0),
      completed: Number(r.completed || 0),
      lockedQntm: Number(r.locked_qntm || 0),
    })),
    recent: recent.rows.map((r) => ({
      id: r.id, userId: r.user_id, username: r.username || null, userName: r.user_name || null,
      leagueId: r.league_id, leagueName: r.league_name, amount: Number(r.amount_qntm),
      status: r.status, stakeAt: r.stake_at, unlockAt: r.unlock_at, completedAt: r.completed_at,
      releasedVia: r.released_via,
    })),
    chart: series.rows.map((r) => ({ day: r.day, unlocks: Number(r.unlocks || 0) })),
    ritualDays: RITUAL_DAYS,
  };
}

module.exports = {
  startRitual,
  claimRitual,
  sweepMatured,
  adminStats,
  RITUAL_DAYS,
};
