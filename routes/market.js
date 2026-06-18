// routes/market.js
// ----------------------------------------------------------------------------
// The "Market" section — an Instagram/TradingView-style creator economy for
// buying & selling trading indicators, strategies, bots and bundles.
//
// Three surfaces (all served from here):
//   1. Market Explore   — a public feed of creator posts (photo/video/text),
//                         ordered MOST-LIKED first (default) or newest.
//   2. Creator Profile  — a creator's page + store (their posts + products).
//   3. Companies         — the directory of verified company stores + creators.
//
// Social primitives: follow (user->user) and like (one per user per post),
// both with denormalized counters maintained transactionally here (migration
// 003 documents why we do NOT also add DB triggers).
//
// Schema lives in migrations/003_market.sql and is also created idempotently by
// database.js on boot, so this route is safe to ship without a manual migration.
//
// Auth: every endpoint requires a valid, non-blocked account (same guard as the
// rest of the API). Capability gating for posting/commenting uses the central
// permission matrix (explore:post / explore:comment / explore:moderate).
// ----------------------------------------------------------------------------

const express = require("express");
const router = express.Router();
const { requirePermission, can } = require("../middleware/permissions");

// Same guard as the rest of the API; re-checks the DB (role/blocked) each call.
router.use((req, res, next) => req.app.get("authMiddleware")(req, res, next));

// ── small helpers ───────────────────────────────────────────────────────────
const clampInt = (v, def, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return max ? Math.min(n, max) : n;
};
const str = (v, max = 2000) => (v == null ? "" : String(v)).slice(0, max);
const trimStr = (v, max = 2000) => str(v, max).trim();
const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 9_999_999_999); // sane ceiling
};
const PRODUCT_TYPES = ["indicator", "strategy", "bot", "bundle", "course", "script"];
const MEDIA_TYPES = ["text", "image", "video"];

// Public shape for a user as a creator (never leaks email/role internals).
function shapeCreator(u, { me } = {}) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username || "",
    name: u.name || "",
    avatar: u.avatar || "",
    bio: u.bio || "",
    headline: u.headline || "",
    cover_image: u.cover_image || "",
    store_kind: u.store_kind || "individual",
    verified: !!u.verified,
    is_creator: !!u.is_creator,
    founded_year: u.founded_year || null,
    follower_count: u.follower_count || 0,
    following_count: u.following_count || 0,
    sales_count: u.sales_count || 0,
    rating_avg: u.rating_avg != null ? Number(u.rating_avg) : 0,
    rating_count: u.rating_count || 0,
    product_count: u.product_count != null ? Number(u.product_count) : undefined,
    is_following: u.is_following === undefined ? undefined : !!u.is_following,
    is_me: me != null ? u.id === me : undefined,
  };
}

function shapeProduct(p) {
  if (!p) return null;
  return {
    id: p.id,
    owner_id: p.owner_id,
    type: p.type,
    name: p.name,
    subtitle: p.subtitle || "",
    description: p.description || "",
    price_qntm: p.price_qntm != null ? Number(p.price_qntm) : 0,
    cover: p.cover || "",
    category: p.category || "",
    tags: p.tags || [],
    badge: p.badge || "",
    rating_avg: p.rating_avg != null ? Number(p.rating_avg) : 0,
    rating_count: p.rating_count || 0,
    sales_count: p.sales_count || 0,
    status: p.status,
    created_at: p.created_at,
    owner: p.owner_username
      ? { id: p.owner_id, username: p.owner_username, name: p.owner_name, avatar: p.owner_avatar, verified: !!p.owner_verified, store_kind: p.owner_store_kind }
      : undefined,
    bought_by_me: p.bought_by_me === undefined ? undefined : !!p.bought_by_me,
  };
}

// Map a feed row (post + author + optional product) into a nested object.
function shapePost(r) {
  return {
    id: r.id,
    title: r.title || "",
    caption: r.caption || "",
    media_url: r.media_url || "",
    media_type: r.media_type || "text",
    thumb_url: r.thumb_url || "",
    visibility: r.visibility,
    like_count: r.like_count || 0,
    comment_count: r.comment_count || 0,
    created_at: r.created_at,
    liked_by_me: !!r.liked_by_me,
    author: {
      id: r.author_id,
      username: r.username || "",
      name: r.name || "",
      avatar: r.avatar || "",
      headline: r.headline || "",
      verified: !!r.verified,
      store_kind: r.store_kind || "individual",
      follower_count: r.follower_count || 0,
      is_following: !!r.following_author,
    },
    product: r.product_id
      ? {
          id: r.product_id,
          name: r.product_name,
          type: r.product_type,
          price_qntm: r.product_price != null ? Number(r.product_price) : 0,
          cover: r.product_cover || "",
          badge: r.product_badge || "",
          rating_avg: r.product_rating != null ? Number(r.product_rating) : 0,
        }
      : null,
  };
}

// Columns selected for the feed (kept in one place so /explore and /posts/:id agree).
const FEED_SELECT = `
  po.id, po.title, po.caption, po.media_url, po.media_type, po.thumb_url,
  po.visibility, po.like_count, po.comment_count, po.created_at,
  u.id AS author_id, u.username, u.name, u.avatar, u.headline,
  u.verified, u.store_kind, u.follower_count,
  pr.id AS product_id, pr.name AS product_name, pr.type AS product_type,
  pr.price_qntm AS product_price, pr.cover AS product_cover, pr.badge AS product_badge,
  pr.rating_avg AS product_rating,
  EXISTS(SELECT 1 FROM likes l   WHERE l.post_id = po.id AND l.user_id = $1) AS liked_by_me,
  EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = u.id) AS following_author
`;

// ============================================================================
// EXPLORE FEED
// ============================================================================

// GET /api/market/explore?sort=likes|new&type=indicator&q=...&limit=&offset=
// Default ordering is MOST LIKED first (the product requirement), newest as the
// tiebreak. `type` filters to posts that showcase a product of that type.
router.get("/explore", async (req, res) => {
  const pool = req.app.get("pool");
  const me = req.user.id;
  const sort = req.query.sort === "new" ? "new" : "likes";
  const type = PRODUCT_TYPES.includes(req.query.type) ? req.query.type : null;
  const q = trimStr(req.query.q, 80);
  const limit = clampInt(req.query.limit, 20, 50);
  const offset = clampInt(req.query.offset, 0);

  const params = [me];
  const where = ["po.deleted_at IS NULL", "po.visibility = 'public'"];
  if (type) {
    params.push(type);
    where.push(`pr.type = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const i = params.length;
    where.push(`(po.title ILIKE $${i} OR po.caption ILIKE $${i} OR u.name ILIKE $${i} OR u.username ILIKE $${i})`);
  }
  const order = sort === "new" ? "po.created_at DESC" : "po.like_count DESC, po.created_at DESC";
  params.push(limit);
  const limIdx = params.length;
  params.push(offset);
  const offIdx = params.length;

  try {
    const { rows } = await pool.query(
      `SELECT ${FEED_SELECT}
         FROM posts po
         JOIN users u   ON u.id = po.author_id
    LEFT JOIN products pr ON pr.id = po.product_id
        WHERE ${where.join(" AND ")}
        ORDER BY ${order}
        LIMIT $${limIdx} OFFSET $${offIdx}`,
      params
    );
    res.json({ posts: rows.map(shapePost), sort, type: type || "", limit, offset });
  } catch (e) {
    console.error("[market] explore:", e.message);
    res.status(500).json({ error: "Could not load feed" });
  }
});

// GET /api/market/posts/:id  → single post + its comments
router.get("/posts/:id", async (req, res) => {
  const pool = req.app.get("pool");
  const me = req.user.id;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Bad id" });
  try {
    const { rows: [r] } = await pool.query(
      `SELECT ${FEED_SELECT}
         FROM posts po
         JOIN users u ON u.id = po.author_id
    LEFT JOIN products pr ON pr.id = po.product_id
        WHERE po.id = $2 AND po.deleted_at IS NULL`,
      [me, id]
    );
    if (!r) return res.status(404).json({ error: "Post not found" });
    const { rows: comments } = await pool.query(
      `SELECT c.id, c.content, c.created_at, c.author_id,
              u.username, u.name, u.avatar, u.verified
         FROM comments c JOIN users u ON u.id = c.author_id
        WHERE c.post_id = $1 AND c.deleted_at IS NULL
        ORDER BY c.created_at ASC LIMIT 200`,
      [id]
    );
    res.json({
      post: shapePost(r),
      comments: comments.map((c) => ({
        id: c.id, content: c.content, created_at: c.created_at,
        author: { id: c.author_id, username: c.username, name: c.name, avatar: c.avatar, verified: !!c.verified },
      })),
    });
  } catch (e) {
    console.error("[market] post:", e.message);
    res.status(500).json({ error: "Could not load post" });
  }
});

// POST /api/market/posts  → create a post (photo / video / text, optional product)
router.post("/posts", requirePermission("explore:post"), async (req, res) => {
  const pool = req.app.get("pool");
  const me = req.user.id;
  const b = req.body || {};
  const title = trimStr(b.title, 140);
  const caption = trimStr(b.caption, 4000);
  const media_url = trimStr(b.media_url, 500);
  let media_type = MEDIA_TYPES.includes(b.media_type) ? b.media_type : "text";
  const thumb_url = trimStr(b.thumb_url, 500);
  const visibility = ["public", "subscribers", "private"].includes(b.visibility) ? b.visibility : "public";
  let product_id = b.product_id ? parseInt(b.product_id, 10) : null;

  if (media_url && media_type === "text") media_type = "image"; // default non-empty media to image
  if (!media_url && media_type !== "text") media_type = "text";
  if (!caption && !media_url && !title) return res.status(400).json({ error: "Post is empty" });

  try {
    // A post may only showcase a product the author owns.
    if (product_id) {
      const { rows: [p] } = await pool.query("SELECT id FROM products WHERE id=$1 AND owner_id=$2 AND status<>'archived'", [product_id, me]);
      if (!p) product_id = null;
    }
    const { rows: [post] } = await pool.query(
      `INSERT INTO posts (author_id, title, caption, media_url, media_type, thumb_url, product_id, visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [me, title, caption, media_url, media_type, thumb_url, product_id, visibility]
    );
    const { rows: [r] } = await pool.query(
      `SELECT ${FEED_SELECT}
         FROM posts po JOIN users u ON u.id = po.author_id
    LEFT JOIN products pr ON pr.id = po.product_id
        WHERE po.id = $2`,
      [me, post.id]
    );
    res.json({ post: shapePost(r) });
  } catch (e) {
    console.error("[market] create post:", e.message);
    res.status(500).json({ error: "Could not create post" });
  }
});

// DELETE /api/market/posts/:id  → soft-delete own post (or moderator)
router.delete("/posts/:id", async (req, res) => {
  const pool = req.app.get("pool");
  const me = req.user.id;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Bad id" });
  try {
    const { rows: [p] } = await pool.query("SELECT author_id FROM posts WHERE id=$1 AND deleted_at IS NULL", [id]);
    if (!p) return res.status(404).json({ error: "Post not found" });
    if (p.author_id !== me && !can(req.user.role, "explore:moderate")) {
      return res.status(403).json({ error: "Not allowed" });
    }
    await pool.query("UPDATE posts SET deleted_at = NOW() WHERE id=$1", [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[market] delete post:", e.message);
    res.status(500).json({ error: "Could not delete post" });
  }
});

// POST /api/market/posts/:id/like  → toggle like; returns {liked, like_count}
router.post("/posts/:id/like", async (req, res) => {
  const pool = req.app.get("pool");
  const me = req.user.id;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Bad id" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [p] } = await client.query("SELECT id FROM posts WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [id]);
    if (!p) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Post not found" }); }

    const ins = await client.query("INSERT INTO likes (post_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, me]);
    let liked;
    if (ins.rowCount === 1) {
      await client.query("UPDATE posts SET like_count = like_count + 1 WHERE id=$1", [id]);
      liked = true;
    } else {
      await client.query("DELETE FROM likes WHERE post_id=$1 AND user_id=$2", [id, me]);
      await client.query("UPDATE posts SET like_count = GREATEST(like_count - 1, 0) WHERE id=$1", [id]);
      liked = false;
    }
    const { rows: [c] } = await client.query("SELECT like_count FROM posts WHERE id=$1", [id]);
    await client.query("COMMIT");
    res.json({ liked, like_count: c.like_count });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[market] like:", e.message);
    res.status(500).json({ error: "Could not like" });
  } finally {
    client.release();
  }
});

// GET /api/market/posts/:id/comments
router.get("/posts/:id/comments", async (req, res) => {
  const pool = req.app.get("pool");
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Bad id" });
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.content, c.created_at, c.author_id,
              u.username, u.name, u.avatar, u.verified
         FROM comments c JOIN users u ON u.id = c.author_id
        WHERE c.post_id = $1 AND c.deleted_at IS NULL
        ORDER BY c.created_at ASC LIMIT 300`,
      [id]
    );
    res.json({
      comments: rows.map((c) => ({
        id: c.id, content: c.content, created_at: c.created_at,
        author: { id: c.author_id, username: c.username, name: c.name, avatar: c.avatar, verified: !!c.verified },
      })),
    });
  } catch (e) {
    console.error("[market] comments:", e.message);
    res.status(500).json({ error: "Could not load comments" });
  }
});

// POST /api/market/posts/:id/comments  → add a comment
router.post("/posts/:id/comments", requirePermission("explore:comment"), async (req, res) => {
  const pool = req.app.get("pool");
  const me = req.user.id;
  const id = parseInt(req.params.id, 10);
  const content = trimStr(req.body && req.body.content, 1000);
  if (!id) return res.status(400).json({ error: "Bad id" });
  if (!content) return res.status(400).json({ error: "Empty comment" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [p] } = await client.query("SELECT id FROM posts WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", [id]);
    if (!p) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Post not found" }); }
    const { rows: [c] } = await client.query(
      "INSERT INTO comments (post_id, author_id, content) VALUES ($1,$2,$3) RETURNING id, content, created_at",
      [id, me, content]
    );
    await client.query("UPDATE posts SET comment_count = comment_count + 1 WHERE id=$1", [id]);
    const { rows: [au] } = await client.query("SELECT username, name, avatar, verified FROM users WHERE id=$1", [me]);
    await client.query("COMMIT");
    res.json({
      comment: {
        id: c.id, content: c.content, created_at: c.created_at,
        author: { id: me, username: au ? au.username : "", name: au ? au.name : "", avatar: au ? au.avatar : "", verified: !!(au && au.verified) },
      },
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[market] add comment:", e.message);
    res.status(500).json({ error: "Could not comment" });
  } finally {
    client.release();
  }
});

// ============================================================================
// FOLLOWS
// ============================================================================

// POST /api/market/follow/:userId  → toggle; returns {following, follower_count}
router.post("/follow/:userId", async (req, res) => {
  const pool = req.app.get("pool");
  const me = req.user.id;
  const target = parseInt(req.params.userId, 10);
  if (!target) return res.status(400).json({ error: "Bad id" });
  if (target === me) return res.status(400).json({ error: "Cannot follow yourself" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [u] } = await client.query("SELECT id FROM users WHERE id=$1 AND blocked=FALSE", [target]);
    if (!u) { await client.query("ROLLBACK"); return res.status(404).json({ error: "User not found" }); }

    const ins = await client.query("INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [me, target]);
    let following;
    if (ins.rowCount === 1) {
      await client.query("UPDATE users SET follower_count = follower_count + 1 WHERE id=$1", [target]);
      await client.query("UPDATE users SET following_count = following_count + 1 WHERE id=$1", [me]);
      following = true;
    } else {
      await client.query("DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2", [me, target]);
      await client.query("UPDATE users SET follower_count = GREATEST(follower_count - 1, 0) WHERE id=$1", [target]);
      await client.query("UPDATE users SET following_count = GREATEST(following_count - 1, 0) WHERE id=$1", [me]);
      following = false;
    }
    const { rows: [c] } = await client.query("SELECT follower_count FROM users WHERE id=$1", [target]);
    await client.query("COMMIT");
    res.json({ following, follower_count: c.follower_count });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[market] follow:", e.message);
    res.status(500).json({ error: "Could not follow" });
  } finally {
    client.release();
  }
});

// ============================================================================
// CREATORS / COMPANIES DIRECTORY + PROFILE
// ============================================================================

// GET /api/market/creators?kind=company|individual|all&sort=followers|rating|new&q=&limit=&offset=
router.get("/creators", async (req, res) => {
  const pool = req.app.get("pool");
  const me = req.user.id;
  const kind = ["company", "individual"].includes(req.query.kind) ? req.query.kind : "all";
  const sort = ["rating", "new"].includes(req.query.sort) ? req.query.sort : "followers";
  const q = trimStr(req.query.q, 80);
  const limit = clampInt(req.query.limit, 24, 50);
  const offset = clampInt(req.query.offset, 0);

  const params = [me];
  const where = ["u.is_creator = TRUE", "u.blocked = FALSE", "u.role <> 'bot'"];
  if (kind !== "all") {
    params.push(kind);
    where.push(`u.store_kind = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    const i = params.length;
    where.push(`(u.name ILIKE $${i} OR u.username ILIKE $${i} OR u.headline ILIKE $${i})`);
  }
  const order = sort === "rating" ? "u.rating_avg DESC, u.follower_count DESC"
    : sort === "new" ? "u.created_at DESC"
    : "u.follower_count DESC, u.sales_count DESC";
  params.push(limit);
  const limIdx = params.length;
  params.push(offset);
  const offIdx = params.length;

  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.name, u.avatar, u.bio, u.headline, u.cover_image,
              u.store_kind, u.verified, u.is_creator, u.founded_year,
              u.follower_count, u.following_count, u.sales_count, u.rating_avg, u.rating_count,
              (SELECT COUNT(*) FROM products p WHERE p.owner_id = u.id AND p.status='active') AS product_count,
              EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = u.id) AS is_following
         FROM users u
        WHERE ${where.join(" AND ")}
        ORDER BY ${order}
        LIMIT $${limIdx} OFFSET $${offIdx}`,
      params
    );
    res.json({ creators: rows.map((r) => shapeCreator(r, { me })), kind, sort, limit, offset });
  } catch (e) {
    console.error("[market] creators:", e.message);
    res.status(500).json({ error: "Could not load creators" });
  }
});

// GET /api/market/creators/:handle  → profile + products + recent posts
router.get("/creators/:handle", async (req, res) => {
  const pool = req.app.get("pool");
  const me = req.user.id;
  const handle = trimStr(req.params.handle, 40).replace(/^@/, "");
  if (!handle) return res.status(400).json({ error: "Bad handle" });
  try {
    const { rows: [u] } = await pool.query(
      `SELECT u.id, u.username, u.name, u.avatar, u.bio, u.headline, u.cover_image,
              u.store_kind, u.verified, u.is_creator, u.founded_year,
              u.follower_count, u.following_count, u.sales_count, u.rating_avg, u.rating_count, u.created_at,
              EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = u.id) AS is_following
         FROM users u
        WHERE (u.username = $2) AND u.blocked = FALSE AND u.role <> 'bot'`,
      [me, handle]
    );
    if (!u) return res.status(404).json({ error: "Creator not found" });

    const { rows: products } = await pool.query(
      `SELECT * FROM products WHERE owner_id=$1 AND status='active' ORDER BY sales_count DESC, created_at DESC LIMIT 60`,
      [u.id]
    );
    const { rows: posts } = await pool.query(
      `SELECT ${FEED_SELECT}
         FROM posts po JOIN users u ON u.id = po.author_id
    LEFT JOIN products pr ON pr.id = po.product_id
        WHERE po.author_id = $2 AND po.deleted_at IS NULL
        ORDER BY po.created_at DESC LIMIT 30`,
      [me, u.id]
    );
    res.json({
      creator: shapeCreator(u, { me }),
      products: products.map(shapeProduct),
      posts: posts.map(shapePost),
      product_count: products.length,
      post_count: posts.length,
    });
  } catch (e) {
    console.error("[market] creator profile:", e.message);
    res.status(500).json({ error: "Could not load creator" });
  }
});

// PUT /api/market/profile  → open/update your own store (sets is_creator=TRUE).
// Name / bio / avatar / username stay on /api/auth/profile; this owns the
// store-specific fields. `verified` is NOT self-settable (admin only).
router.put("/profile", async (req, res) => {
  const pool = req.app.get("pool");
  const me = req.user.id;
  const b = req.body || {};
  const headline = trimStr(b.headline, 120);
  const cover_image = trimStr(b.cover_image, 500);
  const store_kind = ["individual", "company"].includes(b.store_kind) ? b.store_kind : "individual";
  let founded_year = null;
  if (b.founded_year != null && b.founded_year !== "") {
    const y = parseInt(b.founded_year, 10);
    if (Number.isFinite(y) && y >= 1900 && y <= 2100) founded_year = y;
  }
  try {
    const { rows: [u] } = await pool.query(
      `UPDATE users
          SET is_creator = TRUE,
              headline = $2,
              cover_image = $3,
              store_kind = $4,
              founded_year = $5
        WHERE id = $1
        RETURNING id, username, name, avatar, bio, headline, cover_image, store_kind,
                  verified, is_creator, founded_year, follower_count, following_count,
                  sales_count, rating_avg, rating_count`,
      [me, headline, cover_image, store_kind, founded_year]
    );
    res.json({ creator: shapeCreator(u, { me }) });
  } catch (e) {
    console.error("[market] update profile:", e.message);
    res.status(500).json({ error: "Could not update store" });
  }
});

// ============================================================================
// PRODUCTS
// ============================================================================

const PRODUCT_OWNER_JOIN = `
  p.id, p.owner_id, p.type, p.name, p.subtitle, p.description, p.price_qntm,
  p.cover, p.category, p.tags, p.badge, p.rating_avg, p.rating_count,
  p.sales_count, p.status, p.created_at,
  u.username AS owner_username, u.name AS owner_name, u.avatar AS owner_avatar,
  u.verified AS owner_verified, u.store_kind AS owner_store_kind
`;

// GET /api/market/products?owner=&type=&q=&sort=sales|new|price_asc|price_desc&limit=&offset=
router.get("/products", async (req, res) => {
  const pool = req.app.get("pool");
  const owner = req.query.owner ? parseInt(req.query.owner, 10) : null;
  const type = PRODUCT_TYPES.includes(req.query.type) ? req.query.type : null;
  const q = trimStr(req.query.q, 80);
  const sort = req.query.sort;
  const limit = clampInt(req.query.limit, 24, 50);
  const offset = clampInt(req.query.offset, 0);

  const params = [];
  const where = ["p.status = 'active'"];
  if (owner) { params.push(owner); where.push(`p.owner_id = $${params.length}`); }
  if (type) { params.push(type); where.push(`p.type = $${params.length}`); }
  if (q) { params.push(`%${q}%`); const i = params.length; where.push(`(p.name ILIKE $${i} OR p.subtitle ILIKE $${i} OR p.category ILIKE $${i})`); }
  const order = sort === "new" ? "p.created_at DESC"
    : sort === "price_asc" ? "p.price_qntm ASC"
    : sort === "price_desc" ? "p.price_qntm DESC"
    : "p.sales_count DESC, p.rating_avg DESC";
  params.push(limit); const limIdx = params.length;
  params.push(offset); const offIdx = params.length;

  try {
    const { rows } = await pool.query(
      `SELECT ${PRODUCT_OWNER_JOIN}
         FROM products p JOIN users u ON u.id = p.owner_id
        WHERE ${where.join(" AND ")}
        ORDER BY ${order}
        LIMIT $${limIdx} OFFSET $${offIdx}`,
      params
    );
    res.json({ products: rows.map(shapeProduct), type: type || "", sort: sort || "sales", limit, offset });
  } catch (e) {
    console.error("[market] products:", e.message);
    res.status(500).json({ error: "Could not load products" });
  }
});

// GET /api/market/products/:id
router.get("/products/:id", async (req, res) => {
  const pool = req.app.get("pool");
  const me = req.user.id;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Bad id" });
  try {
    const { rows: [p] } = await pool.query(
      `SELECT ${PRODUCT_OWNER_JOIN},
              EXISTS(SELECT 1 FROM product_purchases pp WHERE pp.product_id=p.id AND pp.buyer_id=$1 AND pp.status='completed') AS bought_by_me
         FROM products p JOIN users u ON u.id = p.owner_id
        WHERE p.id = $2`,
      [me, id]
    );
    if (!p || (p.status !== "active" && p.owner_id !== me)) return res.status(404).json({ error: "Product not found" });
    res.json({ product: shapeProduct(p) });
  } catch (e) {
    console.error("[market] product:", e.message);
    res.status(500).json({ error: "Could not load product" });
  }
});

// POST /api/market/products  → create (opening a store auto-flags is_creator)
router.post("/products", async (req, res) => {
  const pool = req.app.get("pool");
  const me = req.user.id;
  const b = req.body || {};
  const type = PRODUCT_TYPES.includes(b.type) ? b.type : "indicator";
  const name = trimStr(b.name, 120);
  const subtitle = trimStr(b.subtitle, 160);
  const description = trimStr(b.description, 6000);
  const price_qntm = money(b.price_qntm);
  const cover = trimStr(b.cover, 500);
  const category = trimStr(b.category, 60);
  const badge = trimStr(b.badge, 20);
  const status = ["active", "draft"].includes(b.status) ? b.status : "active";
  let tags = Array.isArray(b.tags) ? b.tags.slice(0, 10).map((x) => trimStr(x, 30)).filter(Boolean) : [];
  if (!name) return res.status(400).json({ error: "Name is required" });

  try {
    await pool.query("UPDATE users SET is_creator = TRUE WHERE id=$1 AND is_creator = FALSE", [me]);
    const { rows: [p] } = await pool.query(
      `INSERT INTO products (owner_id, type, name, subtitle, description, price_qntm, cover, category, tags, badge, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [me, type, name, subtitle, description, price_qntm, cover, category, tags, badge, status]
    );
    res.json({ product: shapeProduct(p) });
  } catch (e) {
    console.error("[market] create product:", e.message);
    res.status(500).json({ error: "Could not create product" });
  }
});

// PUT /api/market/products/:id  → owner edits
router.put("/products/:id", async (req, res) => {
  const pool = req.app.get("pool");
  const me = req.user.id;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Bad id" });
  const b = req.body || {};
  try {
    const { rows: [p] } = await pool.query("SELECT owner_id FROM products WHERE id=$1", [id]);
    if (!p) return res.status(404).json({ error: "Product not found" });
    if (p.owner_id !== me) return res.status(403).json({ error: "Not allowed" });

    const sets = [];
    const params = [];
    const put = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if (b.type !== undefined && PRODUCT_TYPES.includes(b.type)) put("type", b.type);
    if (b.name !== undefined) { const n = trimStr(b.name, 120); if (n) put("name", n); }
    if (b.subtitle !== undefined) put("subtitle", trimStr(b.subtitle, 160));
    if (b.description !== undefined) put("description", trimStr(b.description, 6000));
    if (b.price_qntm !== undefined) put("price_qntm", money(b.price_qntm));
    if (b.cover !== undefined) put("cover", trimStr(b.cover, 500));
    if (b.category !== undefined) put("category", trimStr(b.category, 60));
    if (b.badge !== undefined) put("badge", trimStr(b.badge, 20));
    if (b.status !== undefined && ["active", "draft", "archived"].includes(b.status)) put("status", b.status);
    if (b.tags !== undefined && Array.isArray(b.tags)) put("tags", b.tags.slice(0, 10).map((x) => trimStr(x, 30)).filter(Boolean));
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
    sets.push("updated_at = NOW()");
    params.push(id);

    const { rows: [u] } = await pool.query(`UPDATE products SET ${sets.join(", ")} WHERE id=$${params.length} RETURNING *`, params);
    res.json({ product: shapeProduct(u) });
  } catch (e) {
    console.error("[market] update product:", e.message);
    res.status(500).json({ error: "Could not update product" });
  }
});

// DELETE /api/market/products/:id  → archive (keeps the purchase ledger intact)
router.delete("/products/:id", async (req, res) => {
  const pool = req.app.get("pool");
  const me = req.user.id;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Bad id" });
  try {
    const { rows: [p] } = await pool.query("SELECT owner_id FROM products WHERE id=$1", [id]);
    if (!p) return res.status(404).json({ error: "Product not found" });
    if (p.owner_id !== me && !can(req.user.role, "explore:moderate")) return res.status(403).json({ error: "Not allowed" });
    await pool.query("UPDATE products SET status='archived', updated_at=NOW() WHERE id=$1", [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[market] delete product:", e.message);
    res.status(500).json({ error: "Could not delete product" });
  }
});

// POST /api/market/products/:id/buy  → record a purchase (LICENSE STUB)
// IMPORTANT: this does NOT move QNTM funds. It records intent + a license so the
// rest of the UX (My Purchases / download gating) works. Wire the real QNTM /
// NowPayments settlement here later (deduct buyer, credit seller, set status).
router.post("/products/:id/buy", async (req, res) => {
  const pool = req.app.get("pool");
  const me = req.user.id;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Bad id" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [p] } = await client.query("SELECT id, owner_id, price_qntm, status FROM products WHERE id=$1 FOR UPDATE", [id]);
    if (!p || p.status !== "active") { await client.query("ROLLBACK"); return res.status(404).json({ error: "Product not available" }); }
    if (p.owner_id === me) { await client.query("ROLLBACK"); return res.status(400).json({ error: "You already own this product" }); }

    const existing = await client.query("SELECT id FROM product_purchases WHERE product_id=$1 AND buyer_id=$2 AND status='completed'", [id, me]);
    if (existing.rowCount) { await client.query("ROLLBACK"); return res.json({ purchased: true, already_owned: true }); }

    await client.query(
      "INSERT INTO product_purchases (product_id, buyer_id, seller_id, price_qntm, status) VALUES ($1,$2,$3,$4,'completed')",
      [id, me, p.owner_id, p.price_qntm]
    );
    await client.query("UPDATE products SET sales_count = sales_count + 1 WHERE id=$1", [id]);
    await client.query("UPDATE users SET sales_count = sales_count + 1 WHERE id=$1", [p.owner_id]);
    await client.query("COMMIT");
    res.json({ purchased: true, settlement: "stub", note: "License recorded. QNTM settlement not yet wired." });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[market] buy:", e.message);
    res.status(500).json({ error: "Could not complete purchase" });
  } finally {
    client.release();
  }
});

// GET /api/market/purchases  → my license vault
router.get("/purchases", async (req, res) => {
  const pool = req.app.get("pool");
  const me = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT ${PRODUCT_OWNER_JOIN}, pp.created_at AS purchased_at, pp.price_qntm AS paid_qntm
         FROM product_purchases pp
         JOIN products p ON p.id = pp.product_id
         JOIN users u ON u.id = p.owner_id
        WHERE pp.buyer_id = $1 AND pp.status='completed'
        ORDER BY pp.created_at DESC LIMIT 200`,
      [me]
    );
    res.json({
      purchases: rows.map((r) => ({ ...shapeProduct(r), bought_by_me: true, purchased_at: r.purchased_at, paid_qntm: Number(r.paid_qntm) })),
    });
  } catch (e) {
    console.error("[market] purchases:", e.message);
    res.status(500).json({ error: "Could not load purchases" });
  }
});

module.exports = router;
