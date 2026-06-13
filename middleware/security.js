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
    if (ALLOWED.length === 0) {
      // Dev fallback: allow localhost only. NEVER ship with empty allowlist.
      if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
      return cb(new Error("CORS: origin not allowed"));
    }
    return ALLOWED.includes(origin)
      ? cb(null, true)
      : cb(new Error("CORS: origin not allowed"));
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
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          // Tighten as you extract inline JS from index.html. 'unsafe-inline'
          // is a temporary concession for the current single-file SPA.
          "script-src": ["'self'", "'unsafe-inline'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "img-src": ["'self'", "data:", "blob:"],
          "media-src": ["'self'", "blob:"],
          "connect-src": ["'self'", "wss:", "https:"],
          "frame-ancestors": ["'none'"],
          "object-src": ["'none'"],
          "base-uri": ["'self'"],
        },
      },
      crossOriginResourcePolicy: { policy: "same-site" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
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
