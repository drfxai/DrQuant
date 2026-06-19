'use strict';
const { LedgerError } = require('../errors');

/** Wrap async route handlers so rejected promises reach Express error handling. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Auth shims. The DrFX Quant host app already has JWT auth + DB-backed RBAC;
 * replace these two with your real middleware when mounting. They are written
 * so the routes are runnable as-is in a dev harness.
 */
function requireAuth(req, res, next) {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ error: { code: 'unauthorized', message: 'authentication required' } });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: { code: 'forbidden', message: `requires role: ${roles.join('|')}` } });
    }
    next();
  };
}

/** Express error handler that renders LedgerError as structured JSON. */
function errorHandler(err, req, res, _next) {
  if (err instanceof LedgerError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    });
  }
  // eslint-disable-next-line no-console
  console.error('[qntm] unhandled route error:', err);
  res.status(500).json({ error: { code: 'internal_error', message: 'internal error' } });
}

module.exports = { asyncHandler, requireAuth, requireRole, errorHandler };
