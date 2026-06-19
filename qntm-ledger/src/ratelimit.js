'use strict';
const { E } = require('./errors');
/**
 * ratelimit.js — in-process token bucket for financial endpoints (spec §21.4).
 * Adequate for a single node; for the multi-node DrFX Quant deployment behind
 * PM2/load-balancing, back this with Redis (INCR + EXPIRE) so limits are shared.
 * Wire `guard()` as Express middleware on sensitive routes (transfer, withdraw).
 */
const buckets = new Map();

function take(key, { capacity = 20, refillPerSec = 1 } = {}) {
  const now = Date.now() / 1000;
  let b = buckets.get(key);
  if (!b) { b = { tokens: capacity, last: now }; buckets.set(key, b); }
  b.tokens = Math.min(capacity, b.tokens + (now - b.last) * refillPerSec);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function guard(opts = {}) {
  return (req, res, next) => {
    const key = `${opts.scope || 'default'}:${req.user?.id || req.ip}`;
    if (!take(key, opts)) return next(E.RateLimited());
    next();
  };
}
// Periodically drop idle buckets to bound memory.
setInterval(() => {
  const cutoff = Date.now() / 1000 - 3600;
  for (const [k, b] of buckets) if (b.last < cutoff) buckets.delete(k);
}, 600000).unref?.();

module.exports = { take, guard };
