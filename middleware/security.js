// middleware/security.js
// ----------------------------------------------------------------------------
// Centralized HTTP hardening. Replaces the current `cors()` (no options) and
// the missing headers / rate limiting.
//
// REQUIRES new deps — install before wiring into server.js:
//   npm i helmet express-rate-limit
//
// This file is INERT until server.js requires it, so it is safe to have on disk
// before the deps are installed. Do NOT add the require() in server.js until
// after `npm i`, or the process will crash on startup with MODULE_NOT_FOUND.
//
// Usage in server.js (BEFORE routes):
//   const { applySecurity, globalLimiter, makeLimiter, corsOptions } = require("./middleware/security");
//   applySecurity(app);                      // helmet + headers + trust proxy
//   app.use(cors(corsOptions));              // strict CORS (replaces cors())
//   app.use(globalLimiter);                  // global rate limit
//   app.use("/api/auth/login", makeLimiter({ windowMs: 15*60*1000, max: 10 }));
// ----------------------------------------------------------------------------

const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// Comma-separated allowlist, e.g. ALLOWED_ORIGINS="https://app.drfx.com,https://drfx.com"
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, cb) {
    // Allow same-origin / curl / server-to-server (no Origin header).
    if (!origin) return cb(null, true);
    // Deny cross-origin GRACEFULLY (cb(null,false)) rather than throwing — a
    // thrown error becomes a 500. With a graceful deny the disallowed origin
    // simply gets no CORS header (the browser blocks it), while SAME-origin
    // requests are unaffected (the browser never enforces CORS on them), so
    // the SPA keeps working regardless of how the allowlist is configured.
    if (ALLOWED.length === 0) {
      if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
      return cb(null, false);
    }
    return cb(null, ALLOWED.includes(origin));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-CSRF-Token"],
  maxAge: 600,
};

function applySecurity(app) {
  app.set("trust proxy", 1); // behind Nginx — needed for correct client IPs & rate limiting

  app.use(
    helmet({
      // The SPA loads external scripts (TradingView, the socket.io CDN), Google
      // Fonts, and relies on inline scripts/handlers — a strict default-src CSP
      // would break all of that. So we ship a MINIMAL but meaningful CSP that
      // still blocks the highest-value vectors — clickjacking (frame-ancestors),
      // plugin/object injection, and <base> hijacking — WITHOUT restricting
      // script/style/img origins. Output-encoding (esc()) is the primary XSS
      // defense; a full strict CSP is a recommended follow-up (see SECURITY.md).
      // frame-ancestors is 'self' (not 'none') so the in-app Quantum Chat
      // iframe (same-origin) keeps working while cross-site framing is blocked.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "frame-ancestors": ["'self'"],
          "object-src": ["'none'"],
          "base-uri": ["'self'"],
        },
      },
      crossOriginResourcePolicy: { policy: "same-site" },
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      // No includeSubDomains/preload: other subdomains (e.g. the Quantum Chat
      // node) may not all be HTTPS, and we must not force-upgrade them.
      hsts: { maxAge: 15552000, includeSubDomains: false },
    })
  );
}

// Shared store note: in a PM2 cluster / multi-node setup, swap the default
// memory store for a Redis store (rate-limit-redis) so limits are global.
const baseOpts = {
  standardHeaders: true,
  legacyHeaders: false,
  // keyGenerator default uses req.ip — correct once trust proxy is set.
};

const globalLimiter = rateLimit({
  ...baseOpts,
  windowMs: 60 * 1000,
  max: 300, // per IP per minute across the whole API
  message: { error: "Too many requests" },
});

// Factory for tighter per-endpoint limits (login, register, webhook, AI).
function makeLimiter({ windowMs, max, keyGenerator } = {}) {
  return rateLimit({
    ...baseOpts,
    windowMs: windowMs ?? 15 * 60 * 1000,
    max: max ?? 30,
    ...(keyGenerator ? { keyGenerator } : {}),
    message: { error: "Rate limit exceeded" },
  });
}

module.exports = { applySecurity, corsOptions, globalLimiter, makeLimiter, ALLOWED };
