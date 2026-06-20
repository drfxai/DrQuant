-- =====================================================================
-- QNTM admin Economy Console -- migration 004
-- =====================================================================
-- Adds the three txn_type enum values used by the admin Economy Console
-- (/api/qntm/admin/economy):
--   admin_manual_grant    reward_pool -> user   (manual support grant)
--   admin_manual_reclaim  user -> reward_pool   (correction / fraud reversal)
--   pool_transfer         system pool -> system pool (inter-pool rebalance)
-- Idempotent and safe to run repeatedly.
--
-- As with migration 003, ALTER TYPE ... ADD VALUE cannot share a transaction
-- with later use of the value (and on PostgreSQL < 12 cannot run inside a
-- transaction block at all). The application path
-- (qntm-ledger/src/economy/schema.js -> ensureQntmSchema) therefore executes
-- these statements individually (autocommit) at boot from cfg.NEW_TXN_TYPES,
-- with IF NOT EXISTS making every boot a safe no-op. This file is the canonical
-- record of the change and can also be applied with `psql -f` on PostgreSQL 12+.
-- =====================================================================

ALTER TYPE txn_type ADD VALUE IF NOT EXISTS 'admin_manual_grant';
ALTER TYPE txn_type ADD VALUE IF NOT EXISTS 'admin_manual_reclaim';
ALTER TYPE txn_type ADD VALUE IF NOT EXISTS 'pool_transfer';
