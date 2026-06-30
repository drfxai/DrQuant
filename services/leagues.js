// services/leagues.js
// ----------------------------------------------------------------------------
// QNTM Leagues — "earn to qualify, complete the 7-day ritual to ascend."
//
// Two factors decide a user's league:
//   * total_earned_qntm  — a MONOTONIC lifetime counter of QNTM a user has been
//                          rewarded. Crossing a league's earned_threshold makes
//                          the user QUALIFIED for it (eligible to start its
//                          unlock ritual).
//   * unlocked_league_id — the strongest league the user has UNLOCKED by
//                          completing its 7-day "League Unlock Ritual" (see
//                          services/league-rituals.js). This is permanent: the
//                          staked QNTM is returned when the ritual completes, but
//                          the league stays unlocked. It is NOT tied to an
//                          ongoing locked balance.
//
// current_league_id = the strongest ACTIVE league:
//   * Discovery (L1) activates by earning alone (earned >= its earned_threshold).
//   * Every higher league activates only by completing its unlock ritual.
//   So current = max( Discovery-if-earned , unlocked_league_id ).
//
// Nothing here demotes a user (earned never decreases; an unlock is permanent).
// Performance-based promotion/demotion, if ever added, is a SEPARATE concern.
//
// Units: thresholds and counters are WHOLE QNTM (BIGINT). The ledger stores
// 18-decimal base units, but leagues gate on whole-token thresholds, so we floor
// at the boundary (rewards are already whole, so this is exact for them).
//
// staked_qntm / syncStakeFromLedger remain from the earlier persistent-stake
// model. They are retained but NO LONGER drive current_league_id (the ritual
// replaced that). They are harmless and reserved for a future, separate,
// profit-bearing staking module.
//
// This module owns NO schema — the tables live in database.js initDB (mirroring
// migrations/005 + 006). All WRITE paths are best-effort + non-throwing so a
// league failure can never break a reward or a request.
// ----------------------------------------------------------------------------
"use strict";

const { pool } = require("../database");

// Floor a decimal amount/string to an integer number of whole QNTM. Returns 0
// for anything non-finite or non-positive.
function toWholeQntm(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Ensure a user_league_status row exists (idempotent). Pass a client to share a
// transaction, else the shared pool.
async function ensureRow(db, userId) {
  await db.query(
    "INSERT INTO user_league_status (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
    [userId]
  );
}

// Compute current/highest league + status from the row's counters, on the
// supplied client. Discovery (the lowest-id league) activates by earned alone;
// higher leagues activate only via a completed unlock ritual (unlocked_league_id).
async function _recalc(db, userId) {
  const { rows: srows } = await db.query(
    "SELECT total_earned_qntm, COALESCE(unlocked_league_id,0) AS unlocked FROM user_league_status WHERE user_id=$1",
    [userId]
  );
  if (!srows.length) return null;
  const earned = BigInt(srows[0].total_earned_qntm);
  const unlocked = Number(srows[0].unlocked) || 0;

  const { rows: defs } = await db.query(
    "SELECT id, earned_threshold_qntm FROM league_definitions ORDER BY id ASC"
  );

  let highestQualified = null;          // strongest league the user is earned-eligible for
  for (const d of defs) {
    if (earned < BigInt(d.earned_threshold_qntm)) break;
    highestQualified = d.id;
  }
  // Discovery (lowest id) auto-activates by earning; higher leagues need a ritual.
  const discoveryActive = (defs.length && earned >= BigInt(defs[0].earned_threshold_qntm)) ? defs[0].id : 0;
  const currentNum = Math.max(discoveryActive, unlocked);
  const current = currentNum >= 1 ? currentNum : null;
  const status = current != null ? "Active" : "Locked";

  await db.query(
    `UPDATE user_league_status
        SET current_league_id = $2,
            highest_qualified_id = $3,
            current_league_status = $4,
            updated_at = now()
      WHERE user_id = $1`,
    [userId, current, highestQualified, status]
  );
  return { current, highestQualified, status };
}

// Public recalc (own connection).
async function recalcUserLeague(userId) {
  const client = await pool.connect();
  try { await ensureRow(client, userId); return await _recalc(client, userId); }
  finally { client.release(); }
}

// EARN HOOK — call once per FIRST-TIME reward event with the WHOLE-QNTM amount.
// Monotonic: increments lifetime earned and re-evaluates qualification, atomically.
// Non-throwing. Idempotency is the caller's job (rewards.grant() pays each
// milestone at most once; Easy Trade settles each ticket once).
async function addEarned(userId, amount, reason) {
  const inc = toWholeQntm(amount);
  if (!userId || inc <= 0) return { ok: false, skipped: "noop" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureRow(client, userId);
    await client.query(
      "UPDATE user_league_status SET total_earned_qntm = total_earned_qntm + $2 WHERE user_id = $1",
      [userId, inc]
    );
    const r = await _recalc(client, userId);
    await client.query("COMMIT");
    return { ok: true, added: inc, reason: reason || null, ...r };
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("[leagues] addEarned failed for user " + userId + ": " + (e && e.message));
    return { ok: false, error: (e && e.message) || "error" };
  } finally {
    client.release();
  }
}

// STAKE HOOK (retained, no longer drives current) — refresh the cached locked
// stake snapshot from the ledger. Inert today; tolerant of missing tables.
async function syncStakeFromLedger(userId) {
  if (!userId) return { ok: false, skipped: "noop" };
  try {
    const wallets = require("../qntm-ledger/src/wallets");
    const w = await wallets.getOrCreateWallet("user", String(userId), "personal", "QNTM");
    const { rows } = await pool.query(
      "SELECT COALESCE(SUM(amount),0) AS s FROM stakes WHERE wallet_id = $1 AND status IN ('active','cooldown')",
      [w.id]
    );
    const staked = toWholeQntm(rows[0].s);
    await ensureRow(pool, userId);
    await pool.query("UPDATE user_league_status SET staked_qntm = $2 WHERE user_id = $1", [userId, staked]);
    return { ok: true, staked };
  } catch (e) {
    console.error("[leagues] syncStakeFromLedger failed for user " + userId + ": " + (e && e.message));
    return { ok: false, error: (e && e.message) || "error" };
  }
}

// Read the user's available QNTM (best-effort; null if the ledger wallet can't
// be read). Used to tell the UI whether a ritual is affordable.
async function _availableQntm(userId) {
  try {
    const wallets = require("../qntm-ledger/src/wallets");
    const w = await wallets.getUserWallet(String(userId), "user", "QNTM");
    if (!w) return 0;
    return toWholeQntm(w.available_balance);
  } catch (_) { return null; }
}

// READ — full status for the ID card / league screen. Creates a default row on
// first view. The per-league breakdown is computed live so it is always
// self-consistent, and includes any in-progress unlock ritual ("Ascending").
async function getStatus(userId, isAdmin) {
  await ensureRow(pool, userId);

  const { rows: srows } = await pool.query(
    "SELECT total_earned_qntm, COALESCE(unlocked_league_id,0) AS unlocked FROM user_league_status WHERE user_id = $1",
    [userId]
  );
  const s = srows[0] || { total_earned_qntm: "0", unlocked: 0 };
  const earned = BigInt(s.total_earned_qntm);
  const unlocked = Number(s.unlocked) || 0;

  const defs = await listDefinitions();
  const discoveryActive = (defs.length && earned >= BigInt(defs[0].earned_threshold_qntm)) ? defs[0].id : 0;
  const currentNum = Math.max(discoveryActive, unlocked);
  const current = currentNum >= 1 ? currentNum : null;

  // In-progress ritual (at most one per user, enforced by a partial unique index).
  const { rows: rrows } = await pool.query(
    `SELECT r.id, r.league_id, r.amount_qntm, r.stake_at, r.unlock_at, d.name AS league_name
       FROM league_unlock_rituals r JOIN league_definitions d ON d.id = r.league_id
      WHERE r.user_id = $1 AND r.status = 'pending_unlock'
      ORDER BY r.id DESC LIMIT 1`,
    [userId]
  );
  let activeRitual = null;
  if (rrows.length) {
    const r = rrows[0];
    const secs = Math.max(0, Math.floor((new Date(r.unlock_at).getTime() - Date.now()) / 1000));
    activeRitual = {
      ritualId: r.id,
      leagueId: r.league_id,
      leagueName: r.league_name,
      amount: Number(r.amount_qntm),
      stakeAt: r.stake_at,
      unlockAt: r.unlock_at,
      secondsRemaining: secs,
      ready: secs === 0,
    };
  }

  const available = await _availableQntm(userId);

  const leaguesView = defs.map((d) => {
    const earnedOk = isAdmin || (earned >= BigInt(d.earned_threshold_qntm));
    const stakeForUnlock = Number(d.stake_for_unlock_qntm);
    let state;
    if (current != null && d.id <= current) state = "Unlocked";
    else if (activeRitual && activeRitual.leagueId === d.id) state = "Ascending";
    else if (earnedOk) state = "Qualified";
    else state = "Locked";
    return {
      id: d.id,
      name: d.name,
      earnedThreshold: Number(d.earned_threshold_qntm),
      stakeForUnlock,
      state,
      earnedOk,
      affordable: available == null ? null : available >= stakeForUnlock,
    };
  });

  const byId = (id) => (id == null ? null : (defs.find((d) => d.id === id) || null));
  const cur = byId(current);
  // highest league the user is earned-eligible for (can ritual up to here)
  let highestQualifiedId = null;
  for (const l of leaguesView) { if (l.earnedOk) highestQualifiedId = l.id; }
  const qual = byId(highestQualifiedId);

  return {
    earned: Number(earned),
    availableQntm: available,
    status: current != null ? "Active" : "Locked",
    currentLeagueId: current,
    currentLeagueName: cur ? cur.name : null,
    highestQualifiedId,
    highestQualifiedName: qual ? qual.name : null,
    activeRitual,
    leagues: leaguesView,
  };
}

async function listDefinitions() {
  const { rows } = await pool.query(
    "SELECT id, name, earned_threshold_qntm, stake_threshold_qntm, stake_for_unlock_qntm FROM league_definitions ORDER BY id ASC"
  );
  return rows;
}

module.exports = {
  addEarned,
  syncStakeFromLedger,
  recalcUserLeague,
  getStatus,
  listDefinitions,
  toWholeQntm,
};
