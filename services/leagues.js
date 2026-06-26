// services/leagues.js
// ----------------------------------------------------------------------------
// QNTM Leagues — "earn to unlock, stake to activate."
//
// Model (threshold-only; NO win/loss demotion):
//   * total_earned_qntm  — a MONOTONIC lifetime counter of QNTM a user has been
//                          rewarded (loyalty/engagement emissions). Crossing a
//                          league's earned_threshold UNLOCKS it  -> "Qualified".
//   * staked_qntm        — the user's CURRENTLY locked stake (a cached snapshot
//                          of the ledger). Crossing a league's stake_threshold
//                          while also qualified ACTIVATES it     -> "Active".
//
// A user's current_league_id is the strongest league where BOTH thresholds are
// met; highest_qualified_id is the strongest league where earned alone is met.
// Nothing here ever demotes a user: earned never decreases and stake changes are
// pushed in via syncStakeFromLedger(). If win/loss streaks are ever wired, they
// must drive a SEPARATE competitive rank — never this qualification tier.
//
// Units: thresholds and both counters are WHOLE QNTM (BIGINT). The ledger stores
// 18-decimal base units, but leagues gate only on whole-token thresholds, so we
// floor at the boundary. Rewards are already whole, so this is exact for them.
//
// This module owns NO schema — league_definitions / user_league_status are
// created + seeded idempotently in database.js initDB (mirroring
// migrations/005_leagues.sql). All WRITE paths are best-effort + non-throwing so
// a league failure can never break a reward, a bet settlement, or a request.
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

// Recompute current/highest league + status from the row's current counters, on
// the supplied client (so it can share the transaction that triggered it).
// League thresholds ascend with id, so the first earned miss ends the climb.
async function _recalc(db, userId) {
  const { rows: srows } = await db.query(
    "SELECT total_earned_qntm, staked_qntm FROM user_league_status WHERE user_id=$1",
    [userId]
  );
  if (!srows.length) return null;
  const earned = BigInt(srows[0].total_earned_qntm);
  const staked = BigInt(srows[0].staked_qntm);

  const { rows: defs } = await db.query(
    "SELECT id, earned_threshold_qntm, stake_threshold_qntm FROM league_definitions ORDER BY id ASC"
  );

  let highestQualified = null; // strongest league met by earned alone
  let currentActive = null;    // strongest league met by BOTH earned and stake
  for (const d of defs) {
    if (earned < BigInt(d.earned_threshold_qntm)) break; // higher leagues need more earned
    highestQualified = d.id;
    if (staked >= BigInt(d.stake_threshold_qntm)) currentActive = d.id;
  }

  const status = currentActive != null ? "Active"
               : highestQualified != null ? "Qualified"
               : "Locked";

  await db.query(
    `UPDATE user_league_status
        SET current_league_id = $2,
            highest_qualified_id = $3,
            current_league_status = $4,
            updated_at = now()
      WHERE user_id = $1`,
    [userId, currentActive, highestQualified, status]
  );
  return { currentActive, highestQualified, status };
}

// Public recalc (own connection).
async function recalcUserLeague(userId) {
  const client = await pool.connect();
  try { await ensureRow(client, userId); return await _recalc(client, userId); }
  finally { client.release(); }
}

// EARN HOOK — call once per FIRST-TIME reward event with the WHOLE-QNTM amount.
// Monotonic: increments lifetime earned and re-evaluates qualification, atomically.
// Wrapped so it never throws into the caller. Idempotency is the caller's job
// (rewards.grant() pays each milestone at most once; Easy Trade settles each
// ticket once) — this function does not dedupe.
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

// STAKE HOOK — refresh the cached locked-stake snapshot from the ledger and
// re-evaluate. Call after any stake/unstake settles. Inert today (staking is not
// mounted), and tolerant of the ledger tables being absent. Non-throwing.
async function syncStakeFromLedger(userId) {
  if (!userId) return { ok: false, skipped: "noop" };
  try {
    // Resolve the user's personal QNTM wallet via the canonical accessor, then
    // sum LOCKED stake (active + cooldown). amount is an 18-dp NUMERIC string;
    // floor to whole QNTM for the threshold comparison.
    const wallets = require("../qntm-ledger/src/wallets");
    const w = await wallets.getOrCreateWallet("user", String(userId), "personal", "QNTM");
    const { rows } = await pool.query(
      "SELECT COALESCE(SUM(amount),0) AS s FROM stakes WHERE wallet_id = $1 AND status IN ('active','cooldown')",
      [w.id]
    );
    const staked = toWholeQntm(rows[0].s);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await ensureRow(client, userId);
      await client.query(
        "UPDATE user_league_status SET staked_qntm = $2 WHERE user_id = $1",
        [userId, staked]
      );
      const r = await _recalc(client, userId);
      await client.query("COMMIT");
      return { ok: true, staked, ...r };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("[leagues] syncStakeFromLedger failed for user " + userId + ": " + (e && e.message));
    return { ok: false, error: (e && e.message) || "error" };
  }
}

// READ — full status for the ID card / profile. Creates a default row on first
// view so a brand-new user reads back as Locked rather than 404. The per-league
// breakdown is computed live from the counters, so it is always self-consistent.
async function getStatus(userId) {
  await ensureRow(pool, userId);
  const { rows: srows } = await pool.query(
    "SELECT total_earned_qntm, staked_qntm FROM user_league_status WHERE user_id = $1",
    [userId]
  );
  const s = srows[0] || { total_earned_qntm: "0", staked_qntm: "0" };
  const earned = BigInt(s.total_earned_qntm);
  const staked = BigInt(s.staked_qntm);

  const defs = await listDefinitions();
  const leaguesView = defs.map((d) => {
    const earnedOk = earned >= BigInt(d.earned_threshold_qntm);
    const stakeOk = staked >= BigInt(d.stake_threshold_qntm);
    const state = earnedOk && stakeOk ? "Active" : earnedOk ? "Qualified" : "Locked";
    return {
      id: d.id, name: d.name,
      earnedThreshold: Number(d.earned_threshold_qntm),
      stakeThreshold: Number(d.stake_threshold_qntm),
      earnedOk, stakeOk, state,
    };
  });

  // defs ascend by id/threshold, so the last qualified/active entry is the highest.
  const qualified = leaguesView.filter((l) => l.earnedOk);
  const active = leaguesView.filter((l) => l.state === "Active");
  const highestQualified = qualified.length ? qualified[qualified.length - 1] : null;
  const current = active.length ? active[active.length - 1] : null;
  const status = current ? "Active" : highestQualified ? "Qualified" : "Locked";

  return {
    earned: Number(earned),
    staked: Number(staked),
    status,
    currentLeagueId: current ? current.id : null,
    currentLeagueName: current ? current.name : null,
    highestQualifiedId: highestQualified ? highestQualified.id : null,
    highestQualifiedName: highestQualified ? highestQualified.name : null,
    leagues: leaguesView,
  };
}

async function listDefinitions() {
  const { rows } = await pool.query(
    "SELECT id, name, earned_threshold_qntm, stake_threshold_qntm FROM league_definitions ORDER BY id ASC"
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
