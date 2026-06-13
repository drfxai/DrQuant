-- ============================================================================
-- DrFX Quantum — Ecosystem Schema Migration 001
-- ----------------------------------------------------------------------------
-- ADDITIVE + IDEMPOTENT. Safe to run against an existing v5.x database.
-- Run inside a transaction:  psql "$DATABASE_URL" -1 -f migrations/001_ecosystem_schema.sql
-- Nothing here drops user data. The only DROPs are on CHECK constraints we
-- immediately recreate with a wider value set.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. ROLE UPGRADE: introduce 'superadmin'. Existing inline check is
--    users_role_check from the original CREATE TABLE. Drop + recreate wider.
-- ---------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('user','admin','superadmin','bot'));

-- security/operational columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret      TEXT;          -- nullable; 2FA-ready, not enforced yet
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled     BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip    INET;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at    TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins    INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until     TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at       TIMESTAMPTZ;   -- soft delete

-- ---------------------------------------------------------------------------
-- 2. REFRESH TOKENS (rotation + revocation). We store only a SHA-256 hash of
--    the token, never the raw value. A "family" lets us detect token reuse.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,                 -- sha256(raw token)
  family_id    UUID NOT NULL,                 -- rotation lineage; reuse => revoke family
  user_agent   TEXT,
  ip           INET,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,                   -- non-null = dead
  replaced_by  BIGINT REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_token_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_user   ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);

-- ---------------------------------------------------------------------------
-- 3. MESSAGING UPGRADE (replies, types, status, soft-delete, voice/file)
-- ---------------------------------------------------------------------------
ALTER TABLE messages ADD COLUMN IF NOT EXISTS parent_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS type           TEXT DEFAULT 'text';   -- text|image|voice|file|system
ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_url       TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_name      TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_size      BIGINT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_mime      TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS voice_duration INT;                    -- seconds
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at     TIMESTAMPTZ;            -- soft delete
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check
  CHECK (type IN ('text','image','voice','file','system')) NOT VALID;
-- NOT VALID: applies to new rows only, won't fail on legacy rows with NULL/'' type
UPDATE messages SET type = 'text' WHERE type IS NULL OR type = '';

CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_message_id);

-- Per-recipient delivery/read receipts (Telegram-style sent/delivered/read).
CREATE TABLE IF NOT EXISTS message_reads (
  message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'delivered' CHECK (status IN ('delivered','read')),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_message_reads_user ON message_reads(user_id);

-- ---------------------------------------------------------------------------
-- 4. TRADINGVIEW SIGNALS + WEBHOOK LOG
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signals (
  id            BIGSERIAL PRIMARY KEY,
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL CHECK (side IN ('buy','sell','long','short','close','alert')),
  price         NUMERIC(20,8),
  stop_loss     NUMERIC(20,8),
  take_profit   NUMERIC(20,8),
  timeframe     TEXT,
  strategy      TEXT,
  note          TEXT,
  raw_payload   JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'published'
                CHECK (status IN ('pending','published','rejected')),
  channel_id    INTEGER REFERENCES chats(id) ON DELETE SET NULL,  -- which signal channel it broadcast to
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- null for webhook-origin
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_signals_symbol  ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL DEFAULT 'tradingview',
  ip            INET,
  signature_ok  BOOLEAN,
  dedupe_key    TEXT,                              -- hash for replay detection
  status        TEXT NOT NULL,                     -- accepted|rejected_signature|rejected_replay|rejected_schema|rate_limited|error
  reason        TEXT,
  payload       JSONB,
  signal_id     BIGINT REFERENCES signals(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_dedupe ON webhook_logs(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_created ON webhook_logs(created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. AUDIT LOG (every admin/superadmin sensitive action)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_role  TEXT,
  action      TEXT NOT NULL,                       -- e.g. 'user.block', 'role.grant', 'chat.delete'
  target_type TEXT,                                -- 'user' | 'chat' | 'signal' | ...
  target_id   TEXT,
  ip          INET,
  metadata    JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at DESC);

-- ---------------------------------------------------------------------------
-- 6. MEDIA + EXPLORE (Instagram/YouTube hybrid)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media (
  id            BIGSERIAL PRIMARY KEY,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('image','video','live_archive')),
  storage_key   TEXT NOT NULL,                     -- object-store key (not a public URL)
  thumbnail_key TEXT,
  hls_manifest  TEXT,                              -- key/path to .m3u8 for video
  duration      INT,
  width         INT,
  height        INT,
  size_bytes    BIGINT,
  mime          TEXT,
  status        TEXT NOT NULL DEFAULT 'processing'
                CHECK (status IN ('processing','ready','failed')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_id);

CREATE TABLE IF NOT EXISTS posts (
  id           BIGSERIAL PRIMARY KEY,
  author_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id     BIGINT REFERENCES media(id) ON DELETE SET NULL,
  caption      TEXT DEFAULT '',
  visibility   TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','subscribers','private')),
  like_count   INT DEFAULT 0,                      -- denormalized counter
  comment_count INT DEFAULT 0,
  deleted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts(visibility, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);

CREATE TABLE IF NOT EXISTS comments (
  id          BIGSERIAL PRIMARY KEY,
  post_id     BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);

CREATE TABLE IF NOT EXISTS likes (
  post_id    BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)                   -- one like per user per post
);

-- ---------------------------------------------------------------------------
-- 7. LIVE SESSIONS (WebRTC live trading)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS live_sessions (
  id           BIGSERIAL PRIMARY KEY,
  host_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','ended','archived')),
  viewer_peak  INT DEFAULT 0,
  archive_media_id BIGINT REFERENCES media(id) ON DELETE SET NULL,
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  ended_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_live_status ON live_sessions(status, started_at DESC);

-- ---------------------------------------------------------------------------
-- 8. AI USAGE LOG (chart analysis cost + abuse control)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature      TEXT NOT NULL,                      -- 'chart_vision' | 'chat'
  model        TEXT,
  prompt_tokens     INT,
  completion_tokens INT,
  cost_usd     NUMERIC(10,5),
  ip           INET,
  status       TEXT,                               -- ok|error|rate_limited
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_day ON ai_usage_logs(user_id, created_at);

-- ---------------------------------------------------------------------------
-- 9. ECONOMIC CALENDAR CACHE (ForexFactory proxy)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS economic_events (
  id          BIGSERIAL PRIMARY KEY,
  source_id   TEXT,                                -- upstream id for dedupe
  title       TEXT NOT NULL,
  country     TEXT,
  impact      TEXT,                                -- low|medium|high
  actual      TEXT,
  forecast    TEXT,
  previous    TEXT,
  event_time  TIMESTAMPTZ,
  fetched_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_econ_source ON economic_events(source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_econ_time ON economic_events(event_time);

COMMIT;

-- ============================================================================
-- POST-MIGRATION NOTE:
--   The original database.js still hard-codes role IN ('user','admin','bot')
--   inside CREATE TABLE IF NOT EXISTS. That CREATE is a no-op once the table
--   exists, so this migration's widened constraint is what actually governs.
--   To promote the first SuperAdmin (run once, manually):
--     UPDATE users SET role='superadmin' WHERE email = 'you@yourdomain.com';
-- ============================================================================
