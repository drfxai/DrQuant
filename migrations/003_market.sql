-- ============================================================================
-- DrFX Quant — Market / Creator Economy Migration 003
-- ----------------------------------------------------------------------------
-- ADDITIVE + IDEMPOTENT. Safe to run repeatedly against a live v5.x DB that
-- already has migrations 001 and 002 applied. No user data is dropped.
--
-- Adds the "Market" section — an Instagram/TradingView-style creator economy:
--   - creator / store / company profile fields on users
--   - follows (user -> user)
--   - products (indicators, strategies, bots, bundles, courses, scripts) for sale
--   - product_purchases (license ledger; settlement wired separately)
--   - media + product link + title on the existing posts table (Explore feed)
--
-- The posts / likes / comments tables themselves already exist from
-- migration 001 (section 6, "MEDIA + EXPLORE"). This migration only EXTENDS
-- them so post media can be stored as a direct /uploads URL (matching the
-- app's existing Multer flow) instead of the heavier media-processing pipeline.
--
-- Apply:  psql "$DATABASE_URL" -1 -f migrations/003_market.sql
-- (database.js also creates all of this idempotently on boot, so a normal
--  deploy + restart is sufficient; this file is the documented/transactional
--  path and is identical in effect.)
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. CREATOR / STORE / COMPANY PROFILE  (extends users)
--    A "creator profile" IS the user. A "company" is a creator profile whose
--    store_kind = 'company' (a verified org). Both have a store and products.
--    Counters are denormalized and maintained by routes/market.js.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_creator      BOOLEAN     DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS store_kind      TEXT        DEFAULT 'individual';
ALTER TABLE users ADD COLUMN IF NOT EXISTS headline        TEXT        DEFAULT '';   -- e.g. "Elite Quantitative Developer"
ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_image     TEXT        DEFAULT '';   -- profile banner url
ALTER TABLE users ADD COLUMN IF NOT EXISTS verified        BOOLEAN     DEFAULT FALSE;-- creator/company verification badge
ALTER TABLE users ADD COLUMN IF NOT EXISTS founded_year    INT;                      -- companies only
ALTER TABLE users ADD COLUMN IF NOT EXISTS follower_count  INT         DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS following_count INT         DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sales_count     INT         DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_avg      NUMERIC(3,2) DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_count    INT         DEFAULT 0;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_store_kind_check;
ALTER TABLE users ADD CONSTRAINT users_store_kind_check
  CHECK (store_kind IN ('individual','company')) NOT VALID;   -- new/updated rows only

CREATE INDEX IF NOT EXISTS idx_users_creators ON users(store_kind, follower_count DESC) WHERE is_creator = TRUE;

-- ---------------------------------------------------------------------------
-- 2. FOLLOWS  (follower -> followee). One row per directed pair.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);

-- ---------------------------------------------------------------------------
-- 3. PRODUCTS  (the things being sold in the Market: indicators/strategies/…)
--    price_qntm is denominated in the in-app QNTM unit. status='active' is
--    publicly listed; 'draft' is owner-only; 'archived' is hidden.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id           BIGSERIAL PRIMARY KEY,
  owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL DEFAULT 'indicator'
               CHECK (type IN ('indicator','strategy','bot','bundle','course','script')),
  name         TEXT NOT NULL,
  subtitle     TEXT DEFAULT '',
  description  TEXT DEFAULT '',
  price_qntm   NUMERIC(20,2) NOT NULL DEFAULT 0,
  cover        TEXT DEFAULT '',                 -- preview image url
  category     TEXT DEFAULT '',                 -- e.g. 'Forex','Crypto'
  tags         TEXT[] DEFAULT '{}',
  badge        TEXT DEFAULT '',                 -- 'PRO','NEW', etc (optional)
  rating_avg   NUMERIC(3,2) DEFAULT 0,
  rating_count INT DEFAULT 0,
  sales_count  INT DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','draft','archived')),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_products_owner  ON products(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_products_listed ON products(status, type, sales_count DESC) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- 4. PRODUCT PURCHASES  (license ledger). One active license per buyer/product.
--    NOTE: actual QNTM settlement / escrow is intentionally NOT performed here;
--    POST /api/market/products/:id/buy records intent + a license row. Wire the
--    real balance transfer (NowPayments / QNTM ledger) in a follow-up.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_purchases (
  id           BIGSERIAL PRIMARY KEY,
  product_id   BIGINT  NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  buyer_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  seller_id    INTEGER          REFERENCES users(id)    ON DELETE SET NULL,
  price_qntm   NUMERIC(20,2) NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'completed'
               CHECK (status IN ('pending','completed','refunded')),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (product_id, buyer_id)
);
CREATE INDEX IF NOT EXISTS idx_purchases_buyer ON product_purchases(buyer_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. POSTS EXTENSION  (Explore feed cards: text / photo / video + product tie-in)
--    posts(author_id, media_id, caption, visibility, like_count, comment_count,
--    deleted_at, created_at) already exists from migration 001. Add direct-URL
--    media (Multer flow), an optional title, and an optional showcased product.
-- ---------------------------------------------------------------------------
ALTER TABLE posts ADD COLUMN IF NOT EXISTS title      TEXT DEFAULT '';
ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_url  TEXT DEFAULT '';     -- image or video url
ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_type TEXT DEFAULT 'text'; -- text|image|video
ALTER TABLE posts ADD COLUMN IF NOT EXISTS thumb_url  TEXT DEFAULT '';     -- video poster (optional)
ALTER TABLE posts ADD COLUMN IF NOT EXISTS product_id BIGINT REFERENCES products(id) ON DELETE SET NULL;

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_media_type_check;
ALTER TABLE posts ADD CONSTRAINT posts_media_type_check
  CHECK (media_type IN ('text','image','video')) NOT VALID;   -- new/updated rows only
UPDATE posts SET media_type = 'text' WHERE media_type IS NULL OR media_type = '';

-- "Top liked" ordering for the Explore feed (most likes first, newest as tiebreak).
CREATE INDEX IF NOT EXISTS idx_posts_top_liked
  ON posts(like_count DESC, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_posts_product ON posts(product_id);

COMMIT;

-- ============================================================================
-- POST-MIGRATION NOTES
--   * Promote a user to a creator/company by setting is_creator / store_kind,
--     or simply by letting them open their store in-app (PUT /api/market/profile
--     sets is_creator = TRUE on first save).
--   * Counters (follower_count, following_count, like_count, comment_count,
--     sales_count) are maintained transactionally in routes/market.js — do not
--     also add DB triggers or they will double-count.
--   * NOT VALID constraints apply to new/updated rows only; legacy rows remain
--     valid without a full-table rewrite.
-- ============================================================================
