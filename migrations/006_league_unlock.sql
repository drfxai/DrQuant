-- ============================================================================
-- DrFX Quant — League Unlock Ritual Migration 006
-- ----------------------------------------------------------------------------
-- ADDITIVE + IDEMPOTENT. Safe to run repeatedly against a live v5.x DB with
-- migrations 001-005 applied. No user data is dropped.
--
-- Adds the "League Unlock Ritual" — a gamified, NON-YIELD 7-day ascension:
--   - league_definitions.stake_for_unlock_qntm : whole-QNTM cost to ritual-unlock
--                                                each league (Discovery/base = 0).
--   - user_league_status.unlocked_league_id    : strongest league the user has
--                                                permanently unlocked via a ritual.
--   - league_unlock_rituals                     : one row per ritual attempt; the
--                                                7-day window + ledger txn refs.
--
-- Token movement is handled by the ledger (staking_lock / staking_unlock txns,
-- tagged reference.type='league_unlock'); this schema only tracks ritual STATE.
-- The stake is returned in full on completion — no yield, no interest. The league
-- stays unlocked after the tokens are returned (it is NOT tied to a locked balance).
--
-- Apply:  psql "$DATABASE_URL" -1 -f migrations/006_league_unlock.sql
-- (database.js also creates all of this idempotently on boot, so a normal deploy
--  + restart is sufficient; this file is the documented/transactional twin.)
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Per-league ritual cost. Discovery (base) = 0 (no ritual). Curve hits the
--    requested anchors: Bronze = 2,000 and Silver = 5,000 QNTM.
-- ---------------------------------------------------------------------------
ALTER TABLE league_definitions ADD COLUMN IF NOT EXISTS stake_for_unlock_qntm BIGINT NOT NULL DEFAULT 0;

INSERT INTO league_definitions (id, name, earned_threshold_qntm, stake_threshold_qntm, stake_for_unlock_qntm) VALUES
  (1,  'Discovery',    1000,    1000,      0),
  (2,  'Maker',        2000,    2000,    500),
  (3,  'Top',          4000,    4000,   1000),
  (4,  'Bronze',       8000,    8000,   2000),
  (5,  'Silver',      16000,   16000,   5000),
  (6,  'Gold',        32000,   32000,  10000),
  (7,  'Master',      64000,   64000,  20000),
  (8,  'Champion',   128000,  128000,  40000),
  (9,  'Crystal',    256000,  256000,  80000),
  (10, 'Titan',      512000,  512000, 160000),
  (11, 'Legendary', 1024000, 1024000, 320000)
ON CONFLICT (id) DO UPDATE SET stake_for_unlock_qntm = EXCLUDED.stake_for_unlock_qntm;

-- ---------------------------------------------------------------------------
-- 2. The permanent unlock pointer on the per-user status row.
-- ---------------------------------------------------------------------------
ALTER TABLE user_league_status ADD COLUMN IF NOT EXISTS unlocked_league_id SMALLINT REFERENCES league_definitions(id);

-- ---------------------------------------------------------------------------
-- 3. The ritual ledger. amount_qntm is WHOLE QNTM (matches the ledger move).
--    A partial unique index enforces AT MOST ONE in-progress ritual per user.
--    lock_txn / release_txn hold the ledger transaction public_ids for audit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS league_unlock_rituals (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  league_id     SMALLINT NOT NULL REFERENCES league_definitions(id),
  amount_qntm   BIGINT   NOT NULL CHECK (amount_qntm > 0),
  status        TEXT     NOT NULL DEFAULT 'pending_unlock'
                CHECK (status IN ('pending_unlock','completed','cancelled')),
  stake_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  unlock_at     TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ,
  released_via  TEXT CHECK (released_via IN ('manual','auto')),
  lock_txn      TEXT,
  release_txn   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lur_user ON league_unlock_rituals(user_id, status);
CREATE INDEX IF NOT EXISTS idx_lur_pending ON league_unlock_rituals(status, unlock_at) WHERE status = 'pending_unlock';
CREATE UNIQUE INDEX IF NOT EXISTS uq_lur_one_active ON league_unlock_rituals(user_id) WHERE status = 'pending_unlock';

COMMIT;

-- ============================================================================
-- POST-MIGRATION NOTES
--   * COMPLIANCE: the league-unlock stake is a 7-day NON-YIELD, NON-INTEREST,
--     fully-returned temporary lock used solely as a gamified qualification
--     ritual for league access. No profit is paid. A separate, independent
--     profit-bearing staking module is planned for the FUTURE and is out of
--     this scope. See qntm-ledger/COMPLIANCE.md.
--   * Settlement: a matured ritual (now >= unlock_at) is finalized either by the
--     user (manual claim) or by the boot sweeper one pass later (auto) — tokens
--     returned, league permanently unlocked, realtime "league_unlocked" emitted.
-- ============================================================================
