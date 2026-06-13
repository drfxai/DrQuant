# Phase 1 Integration Guide

This reflects the **actual state on disk** after the automated edits.

## Already applied to your repo (safe, additive — won't break a running app)

- **New files**: `migrations/001_ecosystem_schema.sql`, `middleware/rbac.js`,
  `middleware/security.js`, `middleware/audit.js`, `services/tokens.js`,
  `routes/webhooks.js`, `public/js/longpress.js`, and `docs/*`.
- **`package.json`**: added `helmet`, `express-rate-limit`, `cookie-parser`.
- **`server.js`**: set `trust proxy`, mounted the TradingView webhook **before**
  `express.json()`, and made sockets join the `signals` room.
- **`.env.example`**: documented the new keys.

> Intentionally NOT auto-applied, because each breaks a live contract and needs a
> coordinated change: strict CORS (would block your frontend), lowering the 12 MB
> body / 15 MB socket limits (would break image + live-frame streaming), and
> switching login to short-lived access tokens (would log users out until the
> frontend handles refresh). These are the "Opt-in" steps below.

## Required to activate what was added

```bash
# 1. install the 3 new deps
npm i

# 2. run the migration (transactional, idempotent, additive)
psql "$DATABASE_URL" -1 -f migrations/001_ecosystem_schema.sql

# 3. promote your SuperAdmin (run once)
psql "$DATABASE_URL" -c "UPDATE users SET role='superadmin' WHERE email='you@domain.com';"

# 4. set the webhook secret in .env, then create a 'signals' channel in the app
#    (a chat of type 'channel' whose @username matches SIGNAL_CHANNEL_USERNAME)
```

The webhook is **live after step 4** at `POST /api/webhooks/tradingview`. With no
`TRADINGVIEW_WEBHOOK_SECRET` set it safely rejects every call (401), so it's inert
until you opt in. Test:

```bash
curl -X POST http://localhost:3000/api/webhooks/tradingview \
  -H "Content-Type: application/json" \
  -d '{"secret":"YOUR_SECRET","symbol":"XAUUSD","side":"buy","price":2350.5}'
```

## Opt-in: HTTP hardening (helmet + strict CORS + rate limiting)

After `npm i`, add to `server.js` **above the routes**:

```js
const { applySecurity, corsOptions, globalLimiter, makeLimiter } = require("./middleware/security");

applySecurity(app);                 // helmet + CSP + HSTS (trust proxy already set)
// Replace `app.use(cors())` with the strict allowlist — set ALLOWED_ORIGINS first!
app.use(cors(corsOptions));
app.use(globalLimiter);             // 300 req/min/IP
app.use("/api/auth/login",    makeLimiter({ windowMs: 15*60*1000, max: 10 }));
app.use("/api/auth/register", makeLimiter({ windowMs: 60*60*1000, max: 20 }));
```

> Set `ALLOWED_ORIGINS` before swapping CORS or you'll lock out your own frontend.
> The CSP keeps `'unsafe-inline'` for now so the single-file SPA keeps working;
> tighten it as you extract inline scripts.

## Opt-in: refresh-token auth

After `npm i` (for `cookie-parser`) and the migration, in `routes/auth.js`:

```js
const cookieParser = require("cookie-parser");   // in server.js: app.use(cookieParser());
const {
  signAccessToken, issueRefreshToken, rotateRefreshToken,
  revokeFamilyByToken, refreshCookieOptions,
} = require("../services/tokens");
```

In **login**, after the password check, replace the 30-day token with:

```js
const accessToken  = signAccessToken(user, JWT_SECRET);        // 15m
const refreshToken = await issueRefreshToken(pool, user, { ip: req.ip, userAgent: req.get("user-agent") });
await pool.query("UPDATE users SET last_login_ip=$1, last_login_at=NOW() WHERE id=$2", [req.ip, user.id]);
res.cookie("rt", refreshToken, refreshCookieOptions);
return res.json({ token: accessToken, user: { /* same fields as now */ } });
```

Add `/refresh` and `/logout` (full bodies in `docs/security.md`). Then the
frontend must, on any 401, POST `/api/auth/refresh` once and retry. **Until the
frontend does this, do not shorten the token — users would be logged out after
15 minutes.**

## Opt-in: replace inline role checks with RBAC

Anywhere you wrote `if (req.user.role !== "admin")`, switch to
`requireAdmin` / `requireSuperAdmin` / `guardUserMutation` from
`middleware/rbac.js`, and call `auditFromReq(...)` on sensitive actions. Example
in `docs/security.md`.

## Opt-in: wire long-press in the SPA

In `public/index.html`, give each message element `data-message-id` and
`data-own`, set `document.body.dataset.role`, then:

```html
<script type="module">
  import { attachMessageActions } from './js/longpress.js';
  attachMessageActions(document.querySelector('#messages'), {
    onAction: (action, el) => handleMessageAction(action, el.dataset.messageId),
  });
</script>
```
