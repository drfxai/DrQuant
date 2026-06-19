'use strict';
/** Typed errors so callers and the HTTP layer can react precisely. */
class LedgerError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}
const E = {
  InsufficientFunds: (m = 'Insufficient available balance') =>
    new LedgerError('insufficient_funds', m, 409),
  WalletNotFound: (m = 'Wallet not found') => new LedgerError('wallet_not_found', m, 404),
  WalletFrozen: (m = 'Wallet is frozen') => new LedgerError('wallet_frozen', m, 423),
  Unbalanced: (m = 'Transaction entries do not net to zero') =>
    new LedgerError('unbalanced_transaction', m, 422),
  InvalidAmount: (m = 'Amount must be a positive decimal') =>
    new LedgerError('invalid_amount', m, 400),
  Validation: (m = 'Validation failed', details) =>
    new LedgerError('validation_error', m, 400, details),
  Forbidden: (m = 'Not permitted') => new LedgerError('forbidden', m, 403),
  NotImplemented: (m = 'Not enabled') => new LedgerError('not_implemented', m, 501),
  RateLimited: (m = 'Too many requests') => new LedgerError('rate_limited', m, 429),
  Conflict: (m = 'Conflict') => new LedgerError('conflict', m, 409),
};
module.exports = { LedgerError, E };
