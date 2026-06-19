-- =====================================================================
-- QNTM Ledger Engine — core schema (migration 001)
-- =====================================================================
-- Internal, non-redeemable token ledger for the DrFX Quant platform.
--
-- Design rules enforced HERE, at the database, not just in app code:
--   * amounts are NUMERIC(36,18) — never float/double
--   * balances may never go negative (except the contra `genesis` wallet)
--   * ledger_entries are strictly append-only (no UPDATE / DELETE)
--   * every transaction's entries sum to exactly zero per currency
--     (double-entry invariant, checked at COMMIT via a deferred trigger)
--   * idempotency_key is globally unique → safe request retries
--
-- The database is the last line of defense: even a buggy service or a
-- compromised query cannot create, destroy, or misplace a base unit.
-- =====================================================================

BEGIN;

-- ---------- enums ----------------------------------------------------
CREATE TYPE owner_type AS ENUM ('user', 'creator', 'company', 'platform', 'system');

CREATE TYPE wallet_type AS ENUM (
  'genesis',                 -- contra-account; holds -(total issued). May be negative.
  'personal',
  'creator',
  'company',
  'treasury',
  'escrow',
  'reward_pool',
  'burn',
  'staking',
  'tournament_pool',
  'subscription_settlement',
  'fee'
);

CREATE TYPE wallet_status AS ENUM ('active', 'frozen', 'closed');

CREATE TYPE balance_kind AS ENUM ('available', 'pending', 'locked');

CREATE TYPE entry_direction AS ENUM ('debit', 'credit');

CREATE TYPE txn_status AS ENUM (
  'pending', 'completed', 'failed', 'cancelled', 'reversed', 'under_review'
);

CREATE TYPE txn_type AS ENUM (
  'mint',                    -- issue supply: genesis -> treasury (admin only)
  'transfer',
  'marketplace_purchase',
  'escrow_lock',
  'escrow_release',
  'escrow_refund',
  'creator_release',         -- creator pending -> available
  'platform_fee',
  'refund',
  'reward',
  'referral_bonus',
  'subscription_payment',
  'tournament_entry',
  'tournament_prize',
  'staking_lock',
  'staking_unlock',
  'ai_feature_payment',
  'burn',
  'adjustment',              -- admin correction (two-person approval)
  'reversal',                -- mechanical reversal of a prior transaction
  'deposit',                 -- RESERVED: on-chain in-ramp. NOT implemented. See COMPLIANCE.md
  'withdrawal'               -- RESERVED: on-chain out-ramp. NOT implemented. See COMPLIANCE.md
);

-- ---------- wallets --------------------------------------------------
CREATE TABLE wallets (
  id                BIGSERIAL PRIMARY KEY,
  owner_type        owner_type    NOT NULL,
  owner_id          TEXT,                          -- NULL for singleton system wallets
  wallet_type       wallet_type   NOT NULL,
  currency          TEXT          NOT NULL DEFAULT 'QNTM',
  available_balance NUMERIC(36,18) NOT NULL DEFAULT 0,
  pending_balance   NUMERIC(36,18) NOT NULL DEFAULT 0,
  locked_balance    NUMERIC(36,18) NOT NULL DEFAULT 0,
  status            wallet_status NOT NULL DEFAULT 'active',
  metadata          JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- total_balance is derived, never stored, so it can never drift.
CREATE VIEW wallet_balances AS
SELECT
  w.*,
  (w.available_balance + w.pending_balance + w.locked_balance) AS total_balance
FROM wallets w;

-- One personal wallet per user per currency; system wallets are singletons.
CREATE UNIQUE INDEX uq_wallet_owner
  ON wallets (owner_type, owner_id, wallet_type, currency)
  WHERE owner_id IS NOT NULL;

CREATE UNIQUE INDEX uq_wallet_singleton
  ON wallets (wallet_type, currency)
  WHERE owner_id IS NULL;

-- Non-negativity guard (skips the genesis contra-account's available balance).
CREATE OR REPLACE FUNCTION trg_wallet_nonneg() RETURNS trigger AS $$
BEGIN
  IF NEW.wallet_type = 'genesis' THEN
    IF NEW.pending_balance < 0 OR NEW.locked_balance < 0 THEN
      RAISE EXCEPTION 'genesis pending/locked balances must be >= 0'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.available_balance < 0 OR NEW.pending_balance < 0 OR NEW.locked_balance < 0 THEN
      RAISE EXCEPTION 'insufficient_funds: wallet % (%) would go negative (avail=%, pend=%, lock=%)',
        NEW.id, NEW.wallet_type, NEW.available_balance, NEW.pending_balance, NEW.locked_balance
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wallet_nonneg
  BEFORE INSERT OR UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION trg_wallet_nonneg();

-- ---------- transactions ---------------------------------------------
CREATE TABLE transactions (
  id                BIGSERIAL PRIMARY KEY,
  public_id         TEXT          NOT NULL DEFAULT ('tx_' || replace(gen_random_uuid()::text, '-', '')),
  type              txn_type      NOT NULL,
  status            txn_status    NOT NULL DEFAULT 'completed',
  amount            NUMERIC(36,18) NOT NULL CHECK (amount >= 0),  -- gross principal, for reporting
  currency          TEXT          NOT NULL DEFAULT 'QNTM',
  initiator_user_id TEXT,
  reference_type    TEXT,
  reference_id      TEXT,
  idempotency_key   TEXT,
  reverses_txn_id   BIGINT        REFERENCES transactions(id),
  metadata          JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_txn_idempotency
  ON transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX uq_txn_public_id ON transactions (public_id);
CREATE INDEX ix_txn_reference ON transactions (reference_type, reference_id);
CREATE INDEX ix_txn_initiator ON transactions (initiator_user_id);
CREATE INDEX ix_txn_type_status ON transactions (type, status);

-- Immutable fields + no deletes. Status may move forward, never out of a
-- settled terminal state.
CREATE OR REPLACE FUNCTION trg_txn_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transactions are append-only and cannot be deleted';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.type <> OLD.type
     OR NEW.amount <> OLD.amount
     OR NEW.currency <> OLD.currency
     OR NEW.created_at <> OLD.created_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'immutable transaction fields cannot be modified';
  END IF;
  IF OLD.status IN ('failed', 'cancelled', 'reversed') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'transaction % is in terminal state % and cannot transition to %',
      OLD.id, OLD.status, NEW.status;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER txn_guard
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION trg_txn_guard();

-- ---------- ledger_entries -------------------------------------------
CREATE TABLE ledger_entries (
  id                 BIGSERIAL PRIMARY KEY,
  transaction_id     BIGINT       NOT NULL REFERENCES transactions(id),
  wallet_id          BIGINT       NOT NULL REFERENCES wallets(id),
  direction          entry_direction NOT NULL,
  amount             NUMERIC(36,18) NOT NULL CHECK (amount > 0),
  balance_kind       balance_kind  NOT NULL,
  -- signed_amount: debit is an outflow (negative), credit an inflow (positive).
  signed_amount      NUMERIC(38,18) GENERATED ALWAYS AS
                       (CASE WHEN direction = 'debit' THEN -amount ELSE amount END) STORED,
  currency           TEXT          NOT NULL DEFAULT 'QNTM',
  balance_after      NUMERIC(36,18),               -- snapshot of the affected balance kind
  description        TEXT,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX ix_ledger_txn ON ledger_entries (transaction_id);
CREATE INDEX ix_ledger_wallet ON ledger_entries (wallet_id, created_at);

-- Strict append-only.
CREATE OR REPLACE FUNCTION trg_ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries are append-only (no UPDATE/DELETE)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION trg_ledger_immutable();

-- Double-entry invariant: per transaction & currency, signed amounts net to 0.
-- DEFERRED so multi-row inserts within one transaction are validated together
-- at COMMIT, not row-by-row.
CREATE OR REPLACE FUNCTION trg_ledger_balanced() RETURNS trigger AS $$
DECLARE bad RECORD;
BEGIN
  FOR bad IN
    SELECT le.currency AS cur, SUM(le.signed_amount) AS net
    FROM ledger_entries le
    WHERE le.transaction_id = NEW.transaction_id
    GROUP BY le.currency
    HAVING SUM(le.signed_amount) <> 0
  LOOP
    RAISE EXCEPTION 'unbalanced transaction %: % nets to % (must be 0)',
      NEW.transaction_id, bad.cur, bad.net
      USING ERRCODE = 'check_violation';
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_ledger_balanced();

-- ---------- audit_log ------------------------------------------------
CREATE TABLE audit_log (
  id             BIGSERIAL PRIMARY KEY,
  actor_id       TEXT,
  actor_role     TEXT,
  action         TEXT          NOT NULL,
  wallet_id      BIGINT,
  transaction_id BIGINT,
  ip_address     INET,
  device_id      TEXT,
  user_agent     TEXT,
  reason         TEXT,
  metadata       JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_actor ON audit_log (actor_id, created_at);
CREATE INDEX ix_audit_action ON audit_log (action, created_at);

-- audit_log is append-only too.
CREATE TRIGGER audit_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION trg_ledger_immutable();

-- ---------- escrow ---------------------------------------------------
CREATE TYPE escrow_status AS ENUM (
  'created', 'funded', 'active', 'released', 'refunded', 'disputed', 'cancelled'
);

CREATE TABLE escrows (
  id              BIGSERIAL PRIMARY KEY,
  public_id       TEXT          NOT NULL DEFAULT ('esc_' || replace(gen_random_uuid()::text, '-', '')),
  buyer_wallet_id BIGINT        NOT NULL REFERENCES wallets(id),
  seller_wallet_id BIGINT       NOT NULL REFERENCES wallets(id),
  escrow_wallet_id BIGINT       NOT NULL REFERENCES wallets(id),
  amount          NUMERIC(36,18) NOT NULL CHECK (amount > 0),
  currency        TEXT          NOT NULL DEFAULT 'QNTM',
  status          escrow_status NOT NULL DEFAULT 'created',
  release_after   TIMESTAMPTZ,                    -- refund window end
  reference_type  TEXT,
  reference_id    TEXT,
  metadata        JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX ix_escrow_status ON escrows (status, release_after);
CREATE UNIQUE INDEX uq_escrow_public ON escrows (public_id);

-- ---------- subscriptions --------------------------------------------
CREATE TYPE subscription_status AS ENUM (
  'active', 'trialing', 'past_due', 'paused', 'cancelled', 'expired'
);

CREATE TABLE subscriptions (
  id                  BIGSERIAL PRIMARY KEY,
  public_id           TEXT          NOT NULL DEFAULT ('sub_' || replace(gen_random_uuid()::text, '-', '')),
  subscriber_user_id  TEXT          NOT NULL,
  plan_id             TEXT          NOT NULL,
  creator_wallet_id   BIGINT        REFERENCES wallets(id),
  amount              NUMERIC(36,18) NOT NULL CHECK (amount > 0),
  currency            TEXT          NOT NULL DEFAULT 'QNTM',
  status              subscription_status NOT NULL DEFAULT 'active',
  interval_days       INTEGER       NOT NULL DEFAULT 30,
  current_period_end  TIMESTAMPTZ,
  failed_attempts     INTEGER       NOT NULL DEFAULT 0,
  metadata            JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX ix_sub_due ON subscriptions (status, current_period_end);
CREATE UNIQUE INDEX uq_sub_public ON subscriptions (public_id);

-- ---------- stakes ---------------------------------------------------
CREATE TYPE stake_status AS ENUM ('active', 'cooldown', 'released');

CREATE TABLE stakes (
  id              BIGSERIAL PRIMARY KEY,
  public_id       TEXT          NOT NULL DEFAULT ('stk_' || replace(gen_random_uuid()::text, '-', '')),
  wallet_id       BIGINT        NOT NULL REFERENCES wallets(id),
  amount          NUMERIC(36,18) NOT NULL CHECK (amount > 0),
  tier            TEXT,
  status          stake_status  NOT NULL DEFAULT 'active',
  cooldown_until  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX ix_stake_wallet ON stakes (wallet_id, status);
CREATE UNIQUE INDEX uq_stake_public ON stakes (public_id);

-- ---------- admin adjustment requests (two-person approval) ----------
CREATE TYPE adjustment_status AS ENUM ('pending', 'approved', 'rejected', 'executed');

CREATE TABLE adjustment_requests (
  id               BIGSERIAL PRIMARY KEY,
  public_id        TEXT          NOT NULL DEFAULT ('adj_' || replace(gen_random_uuid()::text, '-', '')),
  wallet_id        BIGINT        NOT NULL REFERENCES wallets(id),
  direction        entry_direction NOT NULL,       -- credit = add, debit = remove
  balance_kind     balance_kind  NOT NULL DEFAULT 'available',
  amount           NUMERIC(36,18) NOT NULL CHECK (amount > 0),
  currency         TEXT          NOT NULL DEFAULT 'QNTM',
  reason           TEXT          NOT NULL,
  requested_by     TEXT          NOT NULL,
  approved_by      TEXT,
  status           adjustment_status NOT NULL DEFAULT 'pending',
  executed_txn_id  BIGINT        REFERENCES transactions(id),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_adj_public ON adjustment_requests (public_id);
-- An approver may never be the same person who requested the adjustment.
ALTER TABLE adjustment_requests
  ADD CONSTRAINT chk_two_person
  CHECK (approved_by IS NULL OR approved_by <> requested_by);

COMMIT;
