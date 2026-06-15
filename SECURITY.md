# Security Policy

DrFX Quant handles user accounts, private messages, crypto‑payment callbacks and
admin tooling, so we take security seriously. This document explains how to
report a vulnerability, what protections are built in, and what was changed in
the most recent hardening pass.

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue, pull request, or Telegram post for a
security vulnerability.** Public disclosure before a fix is available puts every
deployment at risk.

Instead, report privately through one of:

- **GitHub private advisory** — go to the repository's **Security** tab →
  **Report a vulnerability** (GitHub Security Advisories). This is the preferred
  channel.
- **Direct message** — Telegram: https://t.me/Drfxai

Please include:

- A clear description of the issue and its **impact** (what an attacker can do).
- **Reproduction steps** or a proof of concept.
- The affected **endpoint / file / version** if known.
- Any suggested remediation.

**What to expect:** we aim to acknowledge a report within **72 hours**, agree on
a severity and timeline, and ship a fix or mitigation as quickly as the severity
warrants. Please give us a reasonable window to remediate before any public
disclosure, and avoid accessing or modifying other users' data while testing.

We currently do not run a paid bug‑bounty program, but we are happy to credit
reporters in the changelog unless you prefer to remain anonymous.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 5.x     | ✅ Actively maintained |
| < 5.0   | ❌ Please upgrade |

## Out of Scope

The following are generally **not** treated as vulnerabilities on their own:

- Reports from automated scanners without a demonstrated, exploitable impact.
- Missing security headers on the static marketing/landing assets where no
  sensitive data is handled.
- Self‑XSS that requires a victim to paste attacker‑supplied code into their own
  console/DevTools.
- Denial of service through volumetric traffic (use the rate limits + a CDN/WAF
  in front of the app for that).
- Social engineering of operators or end users.

---

## Built‑in Protections

These are enforced by the application as shipped:

- **Authentication:** JWT bearer tokens (no auth cookies, so the app is not
  susceptible to classic CSRF). Passwords are hashed with bcrypt. The server
  refuses to start if `JWT_SECRET` is missing, shorter than 16 characters, or
  left at the placeholder value.
- **Live authorization:** every authenticated REST request and every socket
  connection re‑checks the account against the database, so a **ban or role
  change takes effect immediately** instead of waiting for the 30‑day token to
  expire. The database role is authoritative — a stale role embedded in a token
  is never trusted.
- **Transport & headers:** `helmet` sets HSTS, `X‑Content‑Type‑Options: nosniff`,
  a clickjacking‑resistant `frame-ancestors 'self'` policy, `object-src 'none'`,
  `base-uri 'self'`, a restrictive referrer policy, and cross‑origin
  resource/opener policies.
- **CORS:** restricted to the origins listed in `ALLOWED_ORIGINS`. Disallowed
  cross‑origin requests are denied gracefully (no CORS header) rather than
  erroring; same‑origin app traffic is unaffected.
- **Rate limiting:** a global per‑IP limit on `/api`, with tighter limits on
  `/api/auth/login` and `/api/auth/register` to slow credential stuffing and
  brute force.
- **Output encoding:** all user‑controlled data rendered in the web client is
  HTML‑escaped (`& < > " '`). Avatars and message images are rendered as real
  `<img>` elements (no CSS `url()` interpolation) and image/reply interactions
  use delegated event listeners instead of inline `onclick` handlers, so
  attacker‑supplied strings can't break out of an attribute or be HTML‑entity
  decoded into executable code.
- **Uploads:** images only; the stored file extension is derived from the
  validated MIME type (never the user's filename), and `/uploads` is served with
  `nosniff` plus a sandbox/`default-src 'none'` content policy so a file that
  somehow slips through cannot execute as a document on our origin.
- **Payments:** NOWPayments IPN callbacks are accepted only when the shared
  secret is configured **and** the request carries a valid `x-nowpayments-sig`
  HMAC signature (verified with a constant‑time comparison).
- **Object‑level access control:** chat membership is checked on the server for
  reading messages, joining socket rooms, reacting, receipts, and pinning.
  Channels are post‑restricted to admins.
- **TradingView webhooks:** the per‑channel webhook URL embeds a secret token;
  posts are de‑duplicated and flood‑capped.

---

## Security Audit — June 2026

A full review was performed across the server, routes, realtime layer,
middleware and web client. The following issues were identified and **fixed**:

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | Critical | Stored XSS — the client's HTML‑escape helper did not escape quotes, allowing attacker‑controlled values (e.g. a message `image` field) to break out of HTML attributes and execute script, leading to token theft from `localStorage`. | Escape all five characters; render avatars/images as `<img>` and move image/reply handlers to delegated listeners (no inline `onclick`). |
| 2 | Critical | Upload → stored XSS — the saved file extension came from the user‑supplied filename, so an HTML/SVG file sent with an image MIME type could be served back as an executable document from our origin. | Derive the extension from the validated MIME type; serve `/uploads` with `nosniff` and a sandbox content policy. |
| 3 | High | Payment webhook bypass — IPN signature verification was skipped entirely when the signature header was omitted, letting anyone grant themselves a paid subscription. | Require the IPN secret **and** a valid signature; constant‑time compare; correct raw‑body parsing. |
| 4 | High | Wide‑open `CORS` (`origin: "*"`), guessable `JWT_SECRET` fallback, and no rate limiting. | Strict CORS allowlist, hard‑fail on weak `JWT_SECRET`, and `helmet` + global/auth rate limits wired in. |
| 5 | High | Bans and role changes did not take effect until the 30‑day token expired. | Per‑request and per‑socket DB re‑check of `blocked` + live role. |
| 6 | Medium | CSS‑injection via avatar interpolated into a CSS `url('…')`; oversized socket buffer (15 MB). | Avatars rendered as `<img>`; server‑side avatar/image validation; socket buffer reduced to 4 MB. |

Server‑side validation was also added so a message `image` must be an uploaded
`/uploads/...` path, and avatars may not contain markup or `javascript:`/`data:`
URLs (defense‑in‑depth behind the client‑side encoding).

---

## Deployment Checklist

Before exposing an instance to the internet:

1. **Set a strong `JWT_SECRET`** in `.env` (e.g. `openssl rand -hex 32`). The app
   will refuse to start otherwise.
2. **Set `ALLOWED_ORIGINS`** to your real origin(s), e.g.
   `ALLOWED_ORIGINS=https://drfx.io`.
3. **Configure `NOWPAYMENTS_IPN_SECRET`** if crypto payments are enabled —
   without it the payment webhook refuses to grant subscriptions.
4. Run behind **HTTPS** (the provided Nginx + certbot setup) with `trust proxy`
   enabled (already set) so client IPs and rate limiting work correctly.
5. Keep the database user (`drfx`) scoped to its own database; never expose
   PostgreSQL to the public internet.
6. Keep dependencies patched (`npm audit`).

---

## Recommended Next Steps (not yet implemented)

These would further raise the security bar and are good follow‑ups:

- **Strict Content‑Security‑Policy.** The current CSP intentionally does not
  restrict script/style/img origins because the single‑file SPA relies on inline
  scripts/handlers and external resources (TradingView, the socket.io CDN,
  Google Fonts). Extracting inline JS and pinning external origins would allow a
  strict `script-src`/`default-src` policy, turning CSP into a strong second
  layer of XSS defense.
- **Shared rate‑limit store (Redis).** Limits are currently per‑process
  (in‑memory). For a multi‑instance / PM2‑cluster deployment, move to
  `rate-limit-redis` so limits are global.
- **Refresh‑token rotation & revocation.** Access tokens live 30 days. A short
  access token + rotating refresh token (with a server‑side revocation list)
  would shrink the window of a stolen token and enable true "log out everywhere".
- **Finish wiring the RBAC layer.** `middleware/rbac.js` and
  `middleware/permissions.js` provide a centralized policy matrix and
  privilege‑escalation guards; routes still use some inline role checks. Routing
  all authorization through these modules removes the risk of an inconsistent
  inline check.
- **Stronger password policy & MFA.** Consider raising the minimum password
  length to 8–12, checking against a breached‑password list, and offering TOTP
  two‑factor authentication for admin accounts.
- **Upload content validation.** In addition to the MIME→extension mapping,
  validate image magic bytes (and optionally re‑encode images) to reject
  disguised payloads outright.
- **Audit logging.** `middleware/audit.js` exists; recording admin actions
  (bans, role changes, subscription grants, deletions) to an append‑only log
  aids incident response.
