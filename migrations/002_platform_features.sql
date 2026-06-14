-- ============================================================================
-- DrFX Quantum — Platform Features Migration 002
-- ----------------------------------------------------------------------------
-- ADDITIVE + IDEMPOTENT. Safe to run repeatedly and against a live v5.x DB that
-- already has migration 001 applied. No user data is dropped; the only DROPs are
-- on CHECK constraints that are immediately recreated wider.
--
-- Adds the genuine gaps from the platform directive that 001 did not cover:
--   - per-channel TradingView signal secrets (signal_channels)
--   - message edit history (message_edits)
--   - message reactions (message_reactions)
--   - moderation / flagged-message queue (message_flags)
--   - admin->user broadcast history (broadcasts)
--   - a 'manager' role + explicit soft/hard delete metadata on messages
--   - reconciliation of the reply_to -> parent_message_id drift
--
-- Apply:  psql "$DATABASE_URL" -1 -f migrations/002_platform_features.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. ROLE: add 'manager' (scoped operator between admin and user).
--    001 set the check to ('user','admin','superadmin','bot'); widen it.
-- ---------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('user','manager','admin','superadmin','bot'));

-- ---------------------------------------------------------------------------
-- 2. MESSAGE DELETE METADATA + THREADING RECONCILIATION
--    001 added messages.parent_message_id and messages.deleted_at but the app
--    still uses reply_to and hard-deletes. Make soft/hard explicit and backfill
--    threading so new code can standardise on parent_message_id.
-- ---------------------------------------------------------------------------
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delete_mode TEXT;        -- 'soft' | 'hard' (null = live)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_delete_mode_check;
ALTER TABLE messages ADD CONSTRAINT messages_delete_mode_check
  CHECK (delete_mode IN ('soft','hard')) NOT VALID;                    -- new rows only

-- Backfill threading from the legacy column where it exists and is unset.
-- (reply_to is created by the base schema in database.js.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'reply_to'
  ) THEN
    UPDATE messages
       SET parent_message_id = reply_to
     WHERE parent_message_id IS NULL AND reply_to IS NOT NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. MESSAGE EDIT HISTORY (the directive's "Edit with history tracking").
--    Every edit snapshots the PRIOR text before overwrite.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_edits (
  id            BIGSERIAL PRIMARY KEY,
  message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  prior_content TEXT NOT NULL,
  edited_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  edited_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_message_edits_msg ON message_edits(message_id, edited_at DESC);

-- ---------------------------------------------------------------------------
-- 4. MESSAGE REACTIONS (toggle; one (message,user,emoji) tuple).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  emoji       TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions(message_id);

-- ---------------------------------------------------------------------------
-- 5. MODERATION: flagged-message queue.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_flags (
  id           BIGSERIAL PRIMARY KEY,
  message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reporter_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','reviewing','resolved','dismissed')),
  resolver_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution   TEXT,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_flags_status ON message_flags(status, created_at DESC);
-- One open flag per (message, reporter) so a user can't spam the queue.
CREATE UNIQUE INDEX IF NOT EXISTS idx_flags_unique_open
  ON message_flags(message_id, reporter_id) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- 6. SIGNAL CHANNELS: per-channel secrets + routing + visibility.
--    secret_hash stores sha256(secret); the raw token lives only in the
--    TradingView alert config, never in the DB.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signal_channels (
  id          BIGSERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,                          -- referenced as payload.channel
  chat_id     INTEGER REFERENCES chats(id) ON DELETE SET NULL,
  secret_hash TEXT,                                          -- sha256(secret); null => fall back to global secret
  visibility  TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_signal_channels_active ON signal_channels(active);

-- Seed a default channel bound to the existing 'signals' chat channel if present
-- (secret_hash left null => the global TRADINGVIEW_WEBHOOK_SECRET still applies).
INSERT INTO signal_channels (slug, chat_id, visibility)
SELECT 'signals', id, 'public' FROM chats
 WHERE username = 'signals' AND type = 'channel'
ON CONFLICT (slug) DO NOTHING;

-- Link signals -> its channel (in addition to the existing channel_id -> chats).
ALTER TABLE signals ADD COLUMN IF NOT EXISTS signal_channel_id BIGINT REFERENCES signal_channels(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 7. BROADCASTS: admin -> user announcement history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS broadcasts (
  id              BIGSERIAL PRIMARY KEY,
  sender_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title           TEXT,
  body            TEXT NOT NULL,
  level           TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warning','critical')),
  audience        TEXT NOT NULL DEFAULT 'all'  CHECK (audience IN ('all','subscribers','role')),
  audience_filter TEXT,                                      -- e.g. role name when audience='role'
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_broadcasts_created ON broadcasts(created_at DESC);

COMMIT;

-- ============================================================================
-- POST-MIGRATION NOTES
--   * To promote a manager:   UPDATE users SET role='manager' WHERE email='...';
--   * Per-channel secret:     store sha256(secret) in signal_channels.secret_hash;
--     compute it the same way the webhook does (crypto.createHash('sha256')).
--   * NOT VALID constraints apply to new/updated rows only, so legacy rows with
--     a NULL delete_mode remain valid.
-- ============================================================================
