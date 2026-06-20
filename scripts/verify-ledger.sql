-- =====================================================================
-- DrFX Quant — ledger & data integrity fingerprint
-- ---------------------------------------------------------------------
-- Run this on the OLD server and again on the NEW server AFTER restore.
-- The two outputs must be IDENTICAL, line for line.
--
--   sudo -u postgres psql -d drfx_quantum -At -f scripts/verify-ledger.sql
--
-- How to read it:
--   * The two "[MUST=0]" rows are the ledger's core integrity invariants.
--       - ledger_signed_sum   : every debit has its matching credit. If this
--                               is not exactly 0, a transaction was half-written
--                               (partial / corrupt) — STOP, do not go live.
--       - wallet_conservation : the genesis contra-wallet holds -(total issued),
--                               so the balances of ALL wallets sum to 0. If not,
--                               value was created or destroyed — STOP.
--     These must be 0 on BOTH servers (they are also a self-check of the source).
--   * The hash.* rows fingerprint every wallet balance and every ledger entry.
--     Identical hashes prove the data survived the move byte-for-byte.
--   * Every count.* and supply.* and seq.* value must match old vs new.
--
-- If your deployment predates one of the tables below, delete that single line.
-- On very large ledgers the hash rows can be memory-heavy; the count.* and
-- [MUST=0] rows alone already prove integrity if you need a lighter check.
-- =====================================================================
SELECT metric, value FROM (
  SELECT  1 AS ord, 'count.users'              AS metric, count(*)::text AS value FROM users
  UNION ALL SELECT  2, 'count.chats',             count(*)::text FROM chats
  UNION ALL SELECT  3, 'count.chat_members',      count(*)::text FROM chat_members
  UNION ALL SELECT  4, 'count.messages',          count(*)::text FROM messages
  UNION ALL SELECT  5, 'count.products',          count(*)::text FROM products
  UNION ALL SELECT  6, 'count.product_purchases', count(*)::text FROM product_purchases
  UNION ALL SELECT  7, 'count.posts',             count(*)::text FROM posts
  UNION ALL SELECT  8, 'count.payments',          count(*)::text FROM payments
  UNION ALL SELECT  9, 'count.payment_orders',    count(*)::text FROM payment_orders
  UNION ALL SELECT 10, 'count.wallets',           count(*)::text FROM wallets
  UNION ALL SELECT 11, 'count.transactions',      count(*)::text FROM transactions
  UNION ALL SELECT 12, 'count.ledger_entries',    count(*)::text FROM ledger_entries
  UNION ALL SELECT 13, 'count.audit_log',         count(*)::text FROM audit_log
  UNION ALL SELECT 14, 'count.escrows',           count(*)::text FROM escrows
  UNION ALL SELECT 15, 'count.subscriptions',     count(*)::text FROM subscriptions

  -- ── Core integrity invariants (must hold on BOTH servers) ─────────────
  UNION ALL SELECT 20, 'INVARIANT.ledger_signed_sum [MUST=0]',
            COALESCE(SUM(signed_amount), 0)::text FROM ledger_entries
  UNION ALL SELECT 21, 'INVARIANT.wallet_conservation [MUST=0]',
            COALESCE(SUM(available_balance + pending_balance + locked_balance), 0)::text FROM wallets

  -- ── Supply accounting (compare old vs new) ───────────────────────────
  UNION ALL SELECT 22, 'supply.total_issued (=-genesis available)',
            COALESCE(-SUM(available_balance), 0)::text FROM wallets WHERE wallet_type = 'genesis'
  UNION ALL SELECT 23, 'supply.circulating_available (non-genesis)',
            COALESCE(SUM(available_balance), 0)::text FROM wallets WHERE wallet_type <> 'genesis'
  UNION ALL SELECT 24, 'supply.pending_total',
            COALESCE(SUM(pending_balance), 0)::text FROM wallets
  UNION ALL SELECT 25, 'supply.locked_total',
            COALESCE(SUM(locked_balance), 0)::text FROM wallets

  -- ── Sequence high-water marks (so new IDs continue, never collide) ────
  UNION ALL SELECT 26, 'seq.max_transaction_id', COALESCE(MAX(id), 0)::text FROM transactions
  UNION ALL SELECT 27, 'seq.max_ledger_entry_id', COALESCE(MAX(id), 0)::text FROM ledger_entries
  UNION ALL SELECT 28, 'seq.max_user_id',         COALESCE(MAX(id), 0)::text FROM users

  -- ── Content fingerprints (byte-for-byte equality of money data) ──────
  UNION ALL SELECT 30, 'hash.wallet_balances',
            md5(COALESCE(string_agg(
              id::text || '|' || available_balance::text || '|' || pending_balance::text
                       || '|' || locked_balance::text || '|' || status::text,
              ',' ORDER BY id), '')) FROM wallets
  UNION ALL SELECT 31, 'hash.ledger_entries',
            md5(COALESCE(string_agg(
              id::text || '|' || transaction_id::text || '|' || wallet_id::text
                       || '|' || signed_amount::text || '|' || balance_kind::text,
              ',' ORDER BY id), '')) FROM ledger_entries
  UNION ALL SELECT 32, 'hash.transactions',
            md5(COALESCE(string_agg(
              id::text || '|' || public_id || '|' || type::text || '|' || status::text
                       || '|' || amount::text || '|' || COALESCE(idempotency_key, ''),
              ',' ORDER BY id), '')) FROM transactions
) q
ORDER BY ord;
