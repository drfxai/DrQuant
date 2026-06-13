-- ============================================================================
-- Quantum Chat — durable-mode schema (PostgreSQL)
-- ----------------------------------------------------------------------------
-- Used only when QUANTUM_CHAT_STORAGE_MODE=postgres. Stores ENCRYPTED payloads
-- and PUBLIC keys only — never plaintext, never private keys, never message
-- bodies in the clear. All message rows carry an expires_at for TTL cleanup.
--
-- NOTE: implemented by the Go PGStore backend (internal/storage/postgres.go).
-- Apply with:
--   psql "$QUANTUM_CHAT_POSTGRES_URL" -1 -f migrations/001_quantum_chat_schema.sql
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS quantum_chat;

-- Registered users. The 20-char ID is self-certifying (hash of the public
-- keys), so this table holds only the locator + timestamps.
CREATE TABLE IF NOT EXISTS quantum_chat.quantum_chat_users (
  id            CHAR(20) PRIMARY KEY,            -- Crockford base32 locator
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Public identity keys (1:1 with users; separated per spec).
CREATE TABLE IF NOT EXISTS quantum_chat.quantum_chat_public_keys (
  user_id    CHAR(20) PRIMARY KEY REFERENCES quantum_chat.quantum_chat_users(id) ON DELETE CASCADE,
  sign_pub   BYTEA NOT NULL,                     -- 32B Ed25519
  dh_pub     BYTEA NOT NULL,                     -- 32B X25519
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sign_pub_len CHECK (octet_length(sign_pub) = 32),
  CONSTRAINT dh_pub_len   CHECK (octet_length(dh_pub) = 32)
);

-- Store-and-forward queue of complete encrypted envelopes.
CREATE TABLE IF NOT EXISTS quantum_chat.quantum_chat_messages (
  id                 BIGSERIAL PRIMARY KEY,
  txid               TEXT NOT NULL,
  recipient_id       CHAR(20) NOT NULL,
  msg_id             BYTEA NOT NULL,             -- 16B replay key
  encrypted_envelope BYTEA NOT NULL,             -- opaque ciphertext blob
  delivered_at       TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_qc_msg_replay ON quantum_chat.quantum_chat_messages(msg_id);
CREATE INDEX IF NOT EXISTS idx_qc_msg_recipient ON quantum_chat.quantum_chat_messages(recipient_id) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_qc_msg_expiry ON quantum_chat.quantum_chat_messages(expires_at);

-- Upstream reassembly buffer for partially-received inbound messages.
CREATE TABLE IF NOT EXISTS quantum_chat.quantum_chat_chunks (
  txid       TEXT NOT NULL,
  seq        INT  NOT NULL,
  total      INT  NOT NULL,
  data       BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (txid, seq)
);
CREATE INDEX IF NOT EXISTS idx_qc_chunk_expiry ON quantum_chat.quantum_chat_chunks(expires_at);

-- Optional delivery receipts (only timestamps + ids; no content).
CREATE TABLE IF NOT EXISTS quantum_chat.quantum_chat_delivery_receipts (
  txid         TEXT NOT NULL,
  recipient_id CHAR(20) NOT NULL,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (txid, recipient_id)
);

-- Durable token-bucket / counter state for rate limiting across nodes.
CREATE TABLE IF NOT EXISTS quantum_chat.quantum_chat_rate_limits (
  bucket_key TEXT PRIMARY KEY,                   -- e.g. ip:203.0.113.5
  tokens     DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Operational audit (admin actions / register / enqueue counts). No content.
CREATE TABLE IF NOT EXISTS quantum_chat.quantum_chat_audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qc_audit_time ON quantum_chat.quantum_chat_audit_logs(created_at DESC);

-- TTL cleanup: call from cron/pg_cron every minute.
CREATE OR REPLACE FUNCTION quantum_chat.qc_sweep() RETURNS void AS $$
BEGIN
  DELETE FROM quantum_chat.quantum_chat_messages WHERE expires_at < NOW();
  DELETE FROM quantum_chat.quantum_chat_chunks   WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

COMMIT;
