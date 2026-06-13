// services/tokens.js
// ----------------------------------------------------------------------------
// Access + refresh token lifecycle.
//
//   Access token : short-lived JWT (15m), sent in Authorization: Bearer.
//   Refresh token: opaque random string (30d), stored client-side in an
//                  httpOnly+Secure+SameSite=Strict cookie. Server keeps only a
//                  SHA-256 hash. Rotated on every use. Reuse of an already-
//                  rotated token revokes the entire family (theft detection).
//
// Deps: crypto (built-in) + jsonwebtoken (already a project dependency).
// Requires the refresh_tokens table from migrations/001_ecosystem_schema.sql.
// ----------------------------------------------------------------------------

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const ACCESS_TTL = process.env.ACCESS_TTL || "15m";
const REFRESH_TTL_DAYS = parseInt(process.env.REFRESH_TTL_DAYS || "30", 10);

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function signAccessToken(user, secret) {
  // Keep the JWT minimal — id + role are all the middleware needs.
  return jwt.sign({ id: user.id, role: user.role }, secret, { expiresIn: ACCESS_TTL });
}

// Issue a brand-new refresh token (new family). Used at login.
async function issueRefreshToken(pool, user, { ip, userAgent } = {}) {
  const raw = crypto.randomBytes(48).toString("base64url");
  const familyId = crypto.randomUUID();
  const expires = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000);
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, user_agent, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [user.id, sha256(raw), familyId, userAgent || null, ip || null, expires]
  );
  return raw;
}

// Rotate: validate the presented token, kill it, mint a replacement in the
// SAME family. Detects reuse of a revoked token and burns the family.
// Returns { user, accessToken, refreshToken } or throws.
async function rotateRefreshToken(pool, rawToken, secret, { ip, userAgent } = {}) {
  const hash = sha256(rawToken);
  const { rows } = await pool.query(
    `SELECT rt.*, u.role AS user_role
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1`,
    [hash]
  );
  const row = rows[0];
  if (!row) throw new Error("invalid_refresh");

  // Reuse of a token that was already rotated/revoked => probable theft.
  if (row.revoked_at) {
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = NOW()
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [row.family_id]
    );
    throw new Error("refresh_reuse_detected");
  }
  if (new Date(row.expires_at) < new Date()) {
    throw new Error("refresh_expired");
  }

  // Mint replacement in the same family.
  const raw = crypto.randomBytes(48).toString("base64url");
  const expires = new Date(Date.now() + REFRESH_TTL_DAYS * 86400 * 1000);
  const { rows: ins } = await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, user_agent, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [row.user_id, sha256(raw), row.family_id, userAgent || null, ip || null, expires]
  );
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = $2 WHERE id = $1`,
    [row.id, ins[0].id]
  );

  const user = { id: row.user_id, role: row.user_role };
  return { user, accessToken: signAccessToken(user, secret), refreshToken: raw };
}

// Logout / revoke a single token's whole family.
async function revokeFamilyByToken(pool, rawToken) {
  const { rows } = await pool.query(
    `SELECT family_id FROM refresh_tokens WHERE token_hash = $1`,
    [sha256(rawToken)]
  );
  if (!rows[0]) return;
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
      WHERE family_id = $1 AND revoked_at IS NULL`,
    [rows[0].family_id]
  );
}

// Revoke everything for a user (e.g. on password change or block).
async function revokeAllForUser(pool, userId) {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

const refreshCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/api/auth",
  maxAge: REFRESH_TTL_DAYS * 86400 * 1000,
};

module.exports = {
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeFamilyByToken,
  revokeAllForUser,
  refreshCookieOptions,
  ACCESS_TTL,
};
