-- =====================================================================
-- QNTM economic layer -- migration 003 (Dubai Edition)
-- =====================================================================
-- Adds the three allocation-bucket wallet types and the bootstrap/system
-- status table. Idempotent and safe to run repeatedly.
--
-- NOTE: ALTER TYPE ... ADD VALUE cannot be used in the same transaction in
-- which the value is later referenced, and on PostgreSQL < 12 cannot run inside
-- a transaction block at all. The application path
-- (qntm-ledger/src/economy/schema.js -> ensureQntmSchema) therefore executes
-- these ADD VALUE statements individually (autocommit) at boot. This file is
-- the canonical record of the change and can also be applied with `psql -f`
-- on PostgreSQL 12+.
-- =====================================================================

ALTER TYPE wallet_type ADD VALUE IF NOT EXISTS 'ecosystem';
ALTER TYPE wallet_type ADD VALUE IF NOT EXISTS 'team_vesting';
ALTER TYPE wallet_type ADD VALUE IF NOT EXISTS 'community_reserve';

CREATE TABLE IF NOT EXISTS qntm_system_status (
  key         TEXT PRIMARY KEY,
  value       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
