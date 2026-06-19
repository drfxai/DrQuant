-- =====================================================================
-- QNTM Ledger — migration 002: NOWPayments one-way top-up + spend/tip
-- =====================================================================
-- Additive only; safe to run after 001 on an existing database.
--
-- Enables the (one-way, non-redeemable) purchase of QNTM credits via the
-- third-party processor NOWPayments, plus the `spend` and `tip` ledger flows
-- and the wallet kinds the QNTM Control Deck needs. There is still NO
-- withdrawal / redemption / on-chain bridge — value flows IN only.
--
-- NOTE: `ALTER TYPE ... ADD VALUE` cannot be used in the same transaction it is
-- added in, and these statements intentionally run OUTSIDE an explicit
-- transaction block (psql autocommits each). None of the new enum values are
-- referenced in the DDL below, so there is no same-transaction-use conflict.
-- =====================================================================

-- New transaction types -------------------------------------------------
ALTER TYPE txn_type   ADD VALUE IF NOT EXISTS 'purchase';   -- NOWPayments credit: treasury -> user
ALTER TYPE txn_type   ADD VALUE IF NOT EXISTS 'spend';      -- user -> revenue sink (feature/AI/marketplace use)
ALTER TYPE txn_type   ADD VALUE IF NOT EXISTS 'tip';        -- user -> user

-- New wallet kinds ------------------------------------------------------
ALTER TYPE wallet_type ADD VALUE IF NOT EXISTS 'control_deck'; -- QNTM Control Deck platform wallet (singleton)
ALTER TYPE wallet_type ADD VALUE IF NOT EXISTS 'revenue';      -- spend sink (singleton)

-- New owner kind --------------------------------------------------------
ALTER TYPE owner_type  ADD VALUE IF NOT EXISTS 'admin';        -- super-admin personal wallets

-- Payment order lifecycle ----------------------------------------------
-- pending           : created locally, no invoice yet
-- awaiting_webhook  : NOWPayments invoice created, waiting for IPN
-- paid_pending_credit: payment confirmed but QNTM not yet credited
--                     (e.g. treasury underfunded) — needs admin re-credit
-- completed         : QNTM credited to the user
-- failed / cancelled: terminal non-credit states
DO $$ BEGIN
  CREATE TYPE payment_order_status AS ENUM
    ('pending', 'awaiting_webhook', 'paid_pending_credit', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS payment_orders (
  id                     BIGSERIAL PRIMARY KEY,
  public_id              TEXT NOT NULL DEFAULT ('po_' || replace(gen_random_uuid()::text, '-', '')),
  user_id                TEXT NOT NULL,
  qntm_amount            NUMERIC(36,18) NOT NULL CHECK (qntm_amount > 0),
  fiat_amount_usd        NUMERIC(18,2)  NOT NULL CHECK (fiat_amount_usd > 0),
  pay_currency           TEXT           NOT NULL,
  unit_price_usd         NUMERIC(18,8)  NOT NULL DEFAULT 0.01,   -- USD per QNTM
  nowpayments_payment_id TEXT,
  status                 payment_order_status NOT NULL DEFAULT 'pending',
  ledger_transaction_id  BIGINT REFERENCES transactions(id),     -- set when credited
  error                  TEXT,
  raw_request            JSONB,    -- request we sent to NOWPayments
  raw_response           JSONB,    -- invoice-create response
  raw_webhook            JSONB,    -- last IPN payload received
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_po_public ON payment_orders (public_id);
CREATE INDEX        IF NOT EXISTS ix_po_user   ON payment_orders (user_id, created_at);
CREATE INDEX        IF NOT EXISTS ix_po_status ON payment_orders (status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_po_nowpayments
  ON payment_orders (nowpayments_payment_id) WHERE nowpayments_payment_id IS NOT NULL;

-- keep updated_at fresh on every change
CREATE OR REPLACE FUNCTION trg_po_touch() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS po_touch ON payment_orders;
CREATE TRIGGER po_touch BEFORE UPDATE ON payment_orders
  FOR EACH ROW EXECUTE FUNCTION trg_po_touch();
