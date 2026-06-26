-- ============================================================================
-- DrFX Quant — QNTM Leagues Migration 005
-- ----------------------------------------------------------------------------
-- ADDITIVE + IDEMPOTENT. Safe to run repeatedly against a live v5.x DB that
-- already has migrations 001-004 applied. No user data is dropped.
--
-- Adds the "League" progression layer — "earn to unlock, stake to activate":
--   - league_definitions : the 11 fixed leagues (Discovery .. Legendary) and
--                          their WHOLE-QNTM earned/stake thresholds.
--   - user_league_status : per-user lifetime-earned counter, cached locked
--                          stake, and the derived current/highest league.
--
-- Thresholds and counters are WHOLE QNTM (BIGINT). The ledger stores 18-decimal
-- base units, but leagues gate only on whole-token thresholds, so the app floors
-- at the boundary (services/leagues.js). The earned and stake thresholds are
-- seeded EQUAL but kept as two independent columns so they can diverge per-league
-- later without a schema change.
--
-- Model is threshold-only: earned (monotonic) unlocks -> "Qualified"; locked
-- stake activates -> "Active". Nothing here demotes a user. Win/loss streaks, if
-- ever added, must drive a SEPARATE competitive rank — never this tier.
--
-- Apply:  psql "$DATABASE_URL" -1 -f migrations/005_leagues.sql
-- (database.js also creates + seeds all of this idempotently on boot, so a normal
--  deploy + restart is sufficient; this file is the documented/transactional twin
--  and is identical in effect.)
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. LEAGUE DEFINITIONS  (1 = Discovery .. 11 = Legendary). Thresholds double.
--    Seeded with ON CONFLICT DO UPDATE so a later change to a name/threshold in
--    this file (and the database.js mirror) propagates on the next deploy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS league_definitions (
  id                    SMALLINT PRIMARY KEY,
  name                  TEXT   NOT NULL,
  earned_threshold_qntm BIGINT NOT NULL,   -- whole QNTM to UNLOCK (Qualified)
  stake_threshold_qntm  BIGINT NOT NULL,   -- whole QNTM to ACTIVATE (Active)
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO league_definitions (id, name, earned_threshold_qntm, stake_threshold_qntm) VALUES
  (1,  'Discovery',    1000,    1000),
  (2,  'Maker',        2000,    2000),
  (3,  'Top',          4000,    4000),
  (4,  'Bronze',       8000,    8000),
  (5,  'Silver',      16000,   16000),
  (6,  'Gold',        32000,   32000),
  (7,  'Master',      64000,   64000),
  (8,  'Champion',   128000,  128000),
  (9,  'Crystal',    256000,  256000),
  (10, 'Titan',      512000,  512000),
  (11, 'Legendary', 1024000, 1024000)
ON CONFLICT (id) DO UPDATE
  SET name                  = EXCLUDED.name,
      earned_threshold_qntm = EXCLUDED.earned_threshold_qntm,
      stake_threshold_qntm  = EXCLUDED.stake_threshold_qntm;

-- ---------------------------------------------------------------------------
-- 2. USER LEAGUE STATUS  (one row per user; created lazily by the app too).
--    total_earned_qntm    : MONOTONIC lifetime counter (never decreases on spend).
--    staked_qntm          : cached snapshot of currently-locked stake (whole QNTM).
--    current_league_id    : strongest league with BOTH thresholds met (Active).
--    highest_qualified_id : strongest league with earned alone met (Qualified).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_league_status (
  user_id               INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_earned_qntm     BIGINT  NOT NULL DEFAULT 0,
  staked_qntm           BIGINT  NOT NULL DEFAULT 0,
  current_league_id     SMALLINT REFERENCES league_definitions(id),
  highest_qualified_id  SMALLINT REFERENCES league_definitions(id),
  current_league_status TEXT NOT NULL DEFAULT 'Locked'
                        CHECK (current_league_status IN ('Locked','Qualified','Active')),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_league_current ON user_league_status(current_league_id);

COMMIT;

-- ============================================================================
-- POST-MIGRATION NOTES
--   * Rows are created on demand by services/leagues.js (ensureRow), so NO
--     backfill is required; existing users read back as Locked until they earn.
--   * EARN fuel today is the milestone reward path (services/rewards.js: signup
--     100 / pro 500 / creator 1000). The Easy Trade and staking hooks are opt-in
--     (services/leagues.js: addEarned / syncStakeFromLedger). Until staking is
--     mounted NO user can reach 'Active' — the ladder tops out at 'Qualified'.
--     This is intended for this phase.
--   * Thresholds are seeded EQUAL but the two columns are independent; change a
--     row's stake_threshold_qntm to decouple earn vs stake for that league.
-- ============================================================================
