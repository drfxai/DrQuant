# Security

## Threat model & baseline (as found in v5.2)

The audited baseline had: `cors()` with no options and Socket.io `origin: "*"`;
a JWT secret that falls back to `"change_me"`; a single 30-day JWT with no
refresh/revocation; no rate limiting; no security headers; two effective roles
(`user`/`admin`) with ad-hoc inline checks; and base64 images flowing through a
12 MB JSON body (plus a 15 MB socket buffer for live frames). SQL injection was
already well-mitigated by parameterized `pg` queries — that's the one strong
existing control and it is preserved.

## Authentication

- **Access token**: JWT, `{ id, role }`, 15-minute expiry (opt-in; current login
  still issues a 30-day token until you make the change below).
- **Refresh token**: opaque 48-byte random value, 30-day expiry, delivered as an
  `httpOnly; Secure; SameSite=Strict` cookie scoped to `/api/auth`. The server
  stores only `sha256(token)`.
- **Rotation**: every `/api/auth/refresh` burns the presented token and issues a
  replacement in the same *family*. Presenting an already-rotated token is
  treated as theft — the whole family is revoked (`services/tokens.js`).
- **Revocation**: logout revokes the family; password change / block should call
  `revokeAllForUser`.

### `/refresh` and `/logout` (add to routes/auth.js)

```js
router.post("/refresh", async (req, res) => {
  const pool = req.app.get("pool");
  const JWT_SECRET = req.app.get("jwt_secret");
  const raw = req.cookies?.rt;
  if (!raw) return res.status(401).json({ error: "No refresh token" });
  try {
    const { accessToken, refreshToken } = await rotateRefreshToken(
      pool, raw, JWT_SECRET, { ip: req.ip, userAgent: req.get("user-agent") }
    );
    res.cookie("rt", refreshToken, refreshCookieOptions);
    return res.json({ token: accessToken });
  } catch {
    res.clearCookie("rt", { path: "/api/auth" });
    return res.status(401).json({ error: "Session expired" });
  }
});

router.post("/logout", async (req, res) => {
  const pool = req.app.get("pool");
  if (req.cookies?.rt) await revokeFamilyByToken(pool, req.cookies.rt);
  res.clearCookie("rt", { path: "/api/auth" });
  res.json({ ok: true });
});
```

## Authorization (RBAC)

Hierarchy: `superadmin (3) > admin (2) > user (1) > bot (0)` (`middleware/rbac.js`).

- `requireRole('admin')` admits admin **and** superadmin.
- `guardUserMutation` enforces the spec's boundaries on any account/role change:
  you cannot act on a peer or higher rank (except yourself); you cannot grant a
  role at or above your own; only SuperAdmin can mint or remove Admins or touch
  SuperAdmins.

Example (routes/admin.js):

```js
const { requireAdmin, guardUserMutation } = require("../middleware/rbac");
const { auditFromReq } = require("../middleware/audit");

async function loadTargetUser(req, res, next) {
  const pool = req.app.get("pool");
  const { rows: [u] } = await pool.query("SELECT id, role FROM users WHERE id=$1", [parseInt(req.params.id)]);
  req.targetUser = u; next();
}

router.post("/users/:id/role", requireAdmin, loadTargetUser, guardUserMutation, async (req, res) => {
  const pool = req.app.get("pool");
  await pool.query("UPDATE users SET role=$1 WHERE id=$2", [req.body.role, req.targetUser.id]);
  await auditFromReq(pool, req, { action: "role.grant", targetType: "user", targetId: req.targetUser.id, metadata: { role: req.body.role } });
  res.json({ ok: true });
});
```

## Transport & header hardening (`middleware/security.js`, opt-in)

- **CORS**: strict allowlist from `ALLOWED_ORIGINS`; localhost-only fallback in
  dev. Set the allowlist before swapping in `corsOptions` or you lock out your
  own frontend.
- **Helmet/CSP**: `default-src 'self'`, `frame-ancestors 'none'`,
  `object-src 'none'`, HSTS with preload. `script-src`/`style-src` keep
  `'unsafe-inline'` only until inline JS is extracted from the single-file SPA.
- **Rate limiting**: 300 req/min/IP global, plus tight per-endpoint caps on
  login (10/15m) and register (20/h). In a PM2 cluster, swap the default memory
  store for `rate-limit-redis` so limits are global, not per worker.

## CSRF

The JSON API authenticates with a `Bearer` header, which browsers don't
auto-attach, so it isn't CSRF-exploitable. The refresh cookie is the exception:
it's `SameSite=Strict`, scoped to `/api/auth`, and only `/api/auth/refresh` reads
it. If you later move access tokens into cookies, add a double-submit CSRF token
(`X-CSRF-Token`, already in the CORS allowed headers).

## File uploads

Whitelist by MIME **and** magic-bytes (not just extension), enforce a hard size
cap, store outside the web root behind signed URLs, and randomize stored names.
Phase 2 voice/file messaging routes binaries through this path instead of
base64-in-JSON.

## Audit & IP logging

Every sensitive admin/superadmin action calls `auditFromReq` →
`audit_logs(actor, action, target, ip, metadata)`. Webhook attempts (including
rejected ones, with reason) are logged in `webhook_logs`. `trust proxy` is set so
`req.ip` is the real client behind Nginx.

## 2FA (TOTP-ready)

`users.totp_secret` / `totp_enabled` columns exist now; enforcement is a drop-in
once you add an authenticator library — no further schema change needed.

## Secrets hygiene (action required)

Rotate any secret sitting at a default: `JWT_SECRET` (`change_me`), DB password,
and `ADMIN_PASSWORD`. Note `database.js` re-syncs the admin password from
`ADMIN_PASSWORD` on **every boot** and forces `role='admin'` — env exposure =
admin compromise. Consider gating that re-sync behind a one-time `SEED_ADMIN=true`.
