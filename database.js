const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const crypto = require("crypto");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    `postgresql://${process.env.DB_USER || "drfx"}:${process.env.DB_PASS || "drfx123"}@${process.env.DB_HOST || "localhost"}:${process.env.DB_PORT || "5432"}/${process.env.DB_NAME || "drfx_quant"}`,
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT DEFAULT '',
        bio TEXT DEFAULT '',
        avatar TEXT DEFAULT '',
        role TEXT DEFAULT 'user' CHECK(role IN ('user','admin','bot','wizard')),
        subscription_status TEXT DEFAULT 'free' CHECK(subscription_status IN ('free','active')),
        subscription_expiry TIMESTAMPTZ,
        blocked BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS chats (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('dm','group','channel')),
        username TEXT UNIQUE,
        name TEXT DEFAULT '',
        bio TEXT DEFAULT '',
        avatar TEXT DEFAULT '',
        visibility TEXT DEFAULT 'public' CHECK(visibility IN ('public','private')),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS chat_members (
        id SERIAL PRIMARY KEY,
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT DEFAULT 'member' CHECK(role IN ('admin','member')),
        last_read_id INTEGER DEFAULT 0,
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(chat_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT DEFAULT '',
        image TEXT DEFAULT '',
        reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        edited_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS trading_notes (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL DEFAULT '',
        timeframe TEXT DEFAULT '',
        direction TEXT DEFAULT '',
        note TEXT DEFAULT '',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        payment_id TEXT,
        amount NUMERIC(10,2),
        currency TEXT,
        status TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS email_verifications (
        email TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT DEFAULT '',
        password_hash TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_chat_members_chat ON chat_members(chat_id);
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_id_chat ON messages(id, chat_id);
      CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_chats_username ON chats(username);
      CREATE INDEX IF NOT EXISTS idx_trading_notes_user ON trading_notes(user_id, symbol);
    `);

    // Add columns if upgrading from v4.0
    const cols = [
      ["users", "username", "TEXT UNIQUE"],
      ["chats", "username", "TEXT UNIQUE"],
      ["chats", "webhook_token", "TEXT"],
      ["chats", "pro_only", "BOOLEAN DEFAULT FALSE"],
      ["messages", "edited_at", "TIMESTAMPTZ"],
      ["messages", "reply_to", "INTEGER REFERENCES messages(id) ON DELETE SET NULL"],
      ["messages", "pinned", "BOOLEAN DEFAULT FALSE"],
      ["messages", "pinned_at", "TIMESTAMPTZ"],
      ["messages", "pinned_by", "INTEGER REFERENCES users(id) ON DELETE SET NULL"],
      ["messages", "attachment", "JSONB"],
      ["users", "pref_lang", "TEXT DEFAULT ''"],
      ["users", "auto_translate", "BOOLEAN DEFAULT FALSE"],
    ];
    for (const [tbl, col, def] of cols) {
      await client.query(`ALTER TABLE ${tbl} ADD COLUMN IF NOT EXISTS ${col} ${def}`).catch(() => {});
    }
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_webhook_token ON chats(webhook_token) WHERE webhook_token IS NOT NULL").catch(() => {});
    await client.query("CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(chat_id) WHERE pinned=TRUE").catch(() => {});

    // AI Bot
    const { rows: [botExists] } = await client.query("SELECT id FROM users WHERE role='bot' LIMIT 1");
    if (!botExists) {
      const bh = await bcrypt.hash("bot_no_login_" + Date.now(), 10);
      await client.query(
        "INSERT INTO users (email,username,password_hash,name,bio,avatar,role,subscription_status) VALUES ($1,$2,$3,$4,$5,$6,'bot','active')",
        ["ai@drfx.quant", "drfx_ai", bh, "DrFX AI", "Your AI trading assistant.", "🤖"]
      );
      console.log("✅ AI Bot created");
    }

    // Admin
    const adminEmail = (process.env.ADMIN_EMAIL || "admin@drfx.com").toLowerCase().trim();
    const adminPass = process.env.ADMIN_PASSWORD || "admin123";
    const { rows: [ae] } = await client.query("SELECT id FROM users WHERE email=$1", [adminEmail]);
    if (!ae) {
      const h = await bcrypt.hash(adminPass, 10);
      await client.query(
        "INSERT INTO users (email,username,password_hash,name,role,subscription_status) VALUES ($1,$2,$3,$4,'admin','active')",
        [adminEmail, "admin", h, "Admin"]
      );
      console.log(`✅ Admin created: ${adminEmail}`);
    } else {
      const h = await bcrypt.hash(adminPass, 10);
      await client.query("UPDATE users SET password_hash=$1, role='admin' WHERE email=$2", [h, adminEmail]);
      console.log(`✅ Admin synced: ${adminEmail}`);
    }

    // ── Default broadcast channels: DrFX + Dr Signal ──────────────────────
    // Like the AI assistant DM, these exist for everyone: every non-bot user is
    // auto-joined. They are private, channel-type (admin-post-only) chats. The
    // Dr Signal channel carries a webhook_token used to route TradingView alerts.
    const { rows: [adminRow] } = await client.query("SELECT id FROM users WHERE email=$1", [adminEmail]);
    const adminId = adminRow?.id;
    if (adminId) {
      const signalUsername =
        (process.env.SIGNAL_CHANNEL_USERNAME || "signals").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 30) || "signals";
      const ensureChannel = async (uname, name, bio, avatar, withToken) => {
        let { rows: [ch] } = await client.query("SELECT id, webhook_token FROM chats WHERE username=$1", [uname]);
        if (!ch) {
          const token = withToken ? crypto.randomBytes(24).toString("hex") : null;
          const { rows: [created] } = await client.query(
            "INSERT INTO chats (type,username,name,bio,avatar,visibility,created_by,webhook_token) VALUES ('channel',$1,$2,$3,$4,'private',$5,$6) RETURNING id",
            [uname, name, bio, avatar, adminId, token]
          );
          ch = created;
        } else if (withToken && !ch.webhook_token) {
          await client.query("UPDATE chats SET webhook_token=$1 WHERE id=$2", [crypto.randomBytes(24).toString("hex"), ch.id]);
        }
        // Admin owns the channel; everyone else is a plain member. Backfills users
        // created before the channel existed (idempotent on every boot).
        await client.query(
          "INSERT INTO chat_members (chat_id,user_id,role) VALUES ($1,$2,'admin') ON CONFLICT (chat_id,user_id) DO UPDATE SET role='admin'",
          [ch.id, adminId]
        );
        await client.query(
          "INSERT INTO chat_members (chat_id,user_id) SELECT $1, id FROM users WHERE role <> 'bot' ON CONFLICT (chat_id,user_id) DO NOTHING",
          [ch.id]
        );
        return ch.id;
      };
      await ensureChannel("drfx", "DrFX", "Official DrFX channel — announcements and updates from the team.", "📈", false);
      await ensureChannel(signalUsername, "Dr Signal", "Automated trading signals delivered from TradingView. Only admins post here.", "📊", true);
      console.log("✅ Default channels ready (DrFX, Dr Signal)");

      // ── VIP (Pro-only) channels ───────────────────────────────────────────
      // Same shape as the default channels, but pro_only=TRUE and members are
      // NOT everyone — only CURRENT active subscribers are auto-joined here (and
      // the admin owner). Free users never become members; when a subscription
      // lapses the user is removed (see services/pro.js, wired into payment +
      // auth + admin routes). The VIP Signals channel carries its own webhook
      // token so it receives TradingView alerts exactly like Dr Signal.
      const ensureProChannel = async (uname, name, bio, avatar, withToken) => {
        let { rows: [ch] } = await client.query("SELECT id, webhook_token, pro_only FROM chats WHERE username=$1", [uname]);
        if (!ch) {
          const token = withToken ? crypto.randomBytes(24).toString("hex") : null;
          const { rows: [created] } = await client.query(
            "INSERT INTO chats (type,username,name,bio,avatar,visibility,pro_only,created_by,webhook_token) VALUES ('channel',$1,$2,$3,$4,'private',TRUE,$5,$6) RETURNING id",
            [uname, name, bio, avatar, adminId, token]
          );
          ch = created;
        } else {
          if (!ch.pro_only) await client.query("UPDATE chats SET pro_only=TRUE WHERE id=$1", [ch.id]);
          if (withToken && !ch.webhook_token) await client.query("UPDATE chats SET webhook_token=$1 WHERE id=$2", [crypto.randomBytes(24).toString("hex"), ch.id]);
        }
        // Admin owns the channel (kept on every boot, idempotent).
        await client.query(
          "INSERT INTO chat_members (chat_id,user_id,role) VALUES ($1,$2,'admin') ON CONFLICT (chat_id,user_id) DO UPDATE SET role='admin'",
          [ch.id, adminId]
        );
        // Auto-join EVERY non-bot user (exactly like the default channels) so the
        // VIP channels appear in everyone's list with the latest signal preview.
        // Whether a user may OPEN/read the channel is gated separately by the
        // pro_only flag in routes/chats.js (free members get an upgrade screen).
        await client.query(
          "INSERT INTO chat_members (chat_id,user_id) SELECT $1, id FROM users WHERE role <> 'bot' ON CONFLICT (chat_id,user_id) DO NOTHING",
          [ch.id]
        );
        return ch.id;
      };
      await ensureProChannel("vipsignals", "VIP Forex & Crypto Signals", "Premium Forex & Crypto trading signals delivered from TradingView. Pro subscribers only.", "📡", true);
      await ensureProChannel("vipalgo", "VIP Algo Channel", "Premium indicators and bots. Pro subscribers only.", "🤖", false);
      await ensureProChannel("vipstrategies", "VIP Strategies", "Learn specific trading strategies, step by step. Pro subscribers only.", "🎯", false);
      console.log("✅ VIP channels ready (VIP Signals, VIP Algo, VIP Strategies)");
    }

    // ── Market section: Explore feed, creators/companies, products ────────
    // Mirrors migrations/003_market.sql so a normal deploy + restart is enough
    // (no manual psql step). Fully additive + idempotent. posts/likes/comments
    // are created IF NOT EXISTS so the Market also works on a fresh DB where the
    // numbered migrations were never run; on an existing DB these are no-ops and
    // the ALTERs below add only the new columns.
    await client.query(`
      CREATE TABLE IF NOT EXISTS posts (
        id BIGSERIAL PRIMARY KEY,
        author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        media_id BIGINT,
        title TEXT DEFAULT '',
        caption TEXT DEFAULT '',
        media_url TEXT DEFAULT '',
        media_type TEXT DEFAULT 'text',
        thumb_url TEXT DEFAULT '',
        product_id BIGINT,
        visibility TEXT NOT NULL DEFAULT 'public',
        like_count INT DEFAULT 0,
        comment_count INT DEFAULT 0,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS likes (
        post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (post_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS comments (
        id BIGSERIAL PRIMARY KEY,
        post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS products (
        id BIGSERIAL PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL DEFAULT 'indicator',
        name TEXT NOT NULL,
        subtitle TEXT DEFAULT '',
        description TEXT DEFAULT '',
        price_qntm NUMERIC(20,2) NOT NULL DEFAULT 0,
        cover TEXT DEFAULT '',
        category TEXT DEFAULT '',
        tags TEXT[] DEFAULT '{}',
        badge TEXT DEFAULT '',
        rating_avg NUMERIC(3,2) DEFAULT 0,
        rating_count INT DEFAULT 0,
        sales_count INT DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS product_purchases (
        id BIGSERIAL PRIMARY KEY,
        product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        buyer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        seller_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        price_qntm NUMERIC(20,2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'completed',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (product_id, buyer_id)
      );
      CREATE TABLE IF NOT EXISTS follows (
        follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (follower_id, followee_id),
        CHECK (follower_id <> followee_id)
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_creator      BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS store_kind      TEXT DEFAULT 'individual';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS headline        TEXT DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_image     TEXT DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS verified        BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS founded_year    INT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS follower_count  INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS following_count INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS sales_count     INT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_avg      NUMERIC(3,2) DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS rating_count    INT DEFAULT 0;
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS title      TEXT DEFAULT '';
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS caption    TEXT DEFAULT '';
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_url  TEXT DEFAULT '';
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_type TEXT DEFAULT 'text';
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS thumb_url  TEXT DEFAULT '';
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS product_id BIGINT;
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'public';
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS like_count INT DEFAULT 0;
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS comment_count INT DEFAULT 0;
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS tv_public_url TEXT DEFAULT '';
      ALTER TABLE products ADD COLUMN IF NOT EXISTS tv_invite_url TEXT DEFAULT '';
      ALTER TABLE products ADD COLUMN IF NOT EXISTS src_file TEXT DEFAULT '';
      ALTER TABLE products ADD COLUMN IF NOT EXISTS src_name TEXT DEFAULT '';
      ALTER TABLE products ADD COLUMN IF NOT EXISTS src_size BIGINT DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_users_creators ON users(store_kind, follower_count DESC) WHERE is_creator = TRUE;
      CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);
      CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
      CREATE INDEX IF NOT EXISTS idx_products_owner  ON products(owner_id, status);
      CREATE INDEX IF NOT EXISTS idx_products_listed ON products(status, type, sales_count DESC) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_purchases_buyer ON product_purchases(buyer_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_posts_top_liked ON posts(like_count DESC, created_at DESC) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
      CREATE INDEX IF NOT EXISTS idx_posts_product ON posts(product_id);
      CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);
    `).catch((e) => console.error("Market schema:", e.message));
    // Widened CHECK constraints kept separate so a legacy row can't abort the batch.
    await client.query("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_store_kind_check").catch(() => {});
    await client.query("ALTER TABLE users ADD CONSTRAINT users_store_kind_check CHECK (store_kind IN ('individual','company')) NOT VALID").catch(() => {});
    await client.query("ALTER TABLE products DROP CONSTRAINT IF EXISTS products_type_check").catch(() => {});
    await client.query("ALTER TABLE products ADD CONSTRAINT products_type_check CHECK (type IN ('indicator','strategy','bot','bundle','course','script')) NOT VALID").catch(() => {});
    await client.query("ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_check").catch(() => {});
    await client.query("ALTER TABLE products ADD CONSTRAINT products_status_check CHECK (status IN ('active','draft','archived')) NOT VALID").catch(() => {});
    await client.query("ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_media_type_check").catch(() => {});
    await client.query("ALTER TABLE posts ADD CONSTRAINT posts_media_type_check CHECK (media_type IN ('text','image','video')) NOT VALID").catch(() => {});
    await client.query("UPDATE posts SET media_type='text' WHERE media_type IS NULL OR media_type=''").catch(() => {});
    // Allow the 'wizard' role (guard). Widened separately + NOT VALID so a legacy row can't abort the batch.
    await client.query("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check").catch(() => {});
    await client.query("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('user','admin','bot','wizard')) NOT VALID").catch(() => {});
    console.log("✅ Market schema ready (Explore feed, creators/companies, products)");

    // ── Chat translation cache (mirrors migrations/004_translations.sql) ──
    // Per-message translations live here, keyed (message_id, target_lang). The
    // original message in `messages` is never mutated — display-only/advisory.
    await client.query(`
      CREATE TABLE IF NOT EXISTS message_translations (
        id              BIGSERIAL PRIMARY KEY,
        message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        target_lang     TEXT NOT NULL,
        source_lang     TEXT,
        provider        TEXT NOT NULL DEFAULT 'libretranslate',
        translated_text TEXT NOT NULL,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (message_id, target_lang)
      );
      CREATE INDEX IF NOT EXISTS idx_msgtrans_message ON message_translations(message_id);
    `).catch((e) => console.error("Translation schema:", e.message));
    console.log("✅ Translation cache ready (message_translations)");

    console.log("✅ PostgreSQL ready");
  } finally { client.release(); }
}

module.exports = { pool, initDB };
