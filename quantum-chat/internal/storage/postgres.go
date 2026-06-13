// Postgres durable backend for Quantum Chat (STORAGE_MODE=postgres).
//
// Implements the same storage.Store interface as RAMStore, against the schema
// in migrations/001_quantum_chat_schema.sql. Stores only ENCRYPTED envelopes
// and PUBLIC keys — never plaintext, never private keys.
//
// Dependency: github.com/lib/pq (pure-Go Postgres driver). This is the only
// non-stdlib dependency in the module and is compiled into every build; it is
// exercised only when a Postgres store is opened.
package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "github.com/lib/pq"

	"quantumchat/internal/identity"
	"quantumchat/internal/transport"
)

// PGStore is the durable (PostgreSQL) implementation of Store.
type PGStore struct {
	db *sql.DB
}

// Compile-time check that *PGStore satisfies the Store interface.
var _ Store = (*PGStore)(nil)

// OpenPostgres connects, verifies reachability, and checks the schema exists.
func OpenPostgres(url string) (*PGStore, error) {
	db, err := sql.Open("postgres", url)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(30 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("postgres ping: %w", err)
	}
	var present int
	err = db.QueryRowContext(ctx,
		`SELECT 1 FROM information_schema.tables
		 WHERE table_schema='quantum_chat' AND table_name='quantum_chat_messages'`).Scan(&present)
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("schema missing — apply migrations/001_quantum_chat_schema.sql: %w", err)
	}
	return &PGStore{db: db}, nil
}

func (s *PGStore) Close() error { return s.db.Close() }

func (s *PGStore) Register(rec identity.Record) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err = tx.Exec(
		`INSERT INTO quantum_chat.quantum_chat_users(id) VALUES($1)
		 ON CONFLICT (id) DO UPDATE SET last_seen=NOW()`, rec.ID); err != nil {
		return err
	}
	if _, err = tx.Exec(
		`INSERT INTO quantum_chat.quantum_chat_public_keys(user_id,sign_pub,dh_pub) VALUES($1,$2,$3)
		 ON CONFLICT (user_id) DO UPDATE SET sign_pub=EXCLUDED.sign_pub, dh_pub=EXCLUDED.dh_pub`,
		rec.ID, rec.SignPub, rec.DHPub); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *PGStore) Lookup(id string) (identity.Record, bool) {
	var rec identity.Record
	err := s.db.QueryRow(
		`SELECT u.id, k.sign_pub, k.dh_pub, u.registered_at, u.last_seen
		 FROM quantum_chat.quantum_chat_users u
		 JOIN quantum_chat.quantum_chat_public_keys k ON k.user_id = u.id
		 WHERE u.id=$1`, id).Scan(&rec.ID, &rec.SignPub, &rec.DHPub, &rec.RegisteredAt, &rec.LastSeen)
	if err != nil {
		return identity.Record{}, false
	}
	return rec, true
}

func (s *PGStore) Touch(id string) {
	_, _ = s.db.Exec(`UPDATE quantum_chat.quantum_chat_users SET last_seen=NOW() WHERE id=$1`, id)
}

func (s *PGStore) PutChunk(txid string, f *transport.UpstreamFrame, maxBytes int) (bool, []byte, error) {
	exp := time.Now().Add(5 * time.Minute)
	tx, err := s.db.Begin()
	if err != nil {
		return false, nil, err
	}
	defer tx.Rollback() //nolint:errcheck

	if _, err = tx.Exec(
		`INSERT INTO quantum_chat.quantum_chat_chunks(txid,seq,total,data,expires_at)
		 VALUES($1,$2,$3,$4,$5) ON CONFLICT (txid,seq) DO NOTHING`,
		txid, f.Seq, f.Total, f.Data, exp); err != nil {
		return false, nil, err
	}

	rows, err := tx.Query(
		`SELECT seq,total,data FROM quantum_chat.quantum_chat_chunks WHERE txid=$1 ORDER BY seq`, txid)
	if err != nil {
		return false, nil, err
	}
	parts := map[int][]byte{}
	total, size := 0, 0
	for rows.Next() {
		var seq, tot int
		var data []byte
		if err = rows.Scan(&seq, &tot, &data); err != nil {
			rows.Close()
			return false, nil, err
		}
		total = tot
		if _, dup := parts[seq]; !dup {
			size += len(data)
			if maxBytes > 0 && size > maxBytes {
				rows.Close()
				return false, nil, transport.ErrTooBig
			}
			parts[seq] = data
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return false, nil, err
	}

	if total == 0 || len(parts) < total {
		// persist the inserted chunk; not complete yet
		return false, nil, tx.Commit()
	}

	out := make([]byte, 0, size)
	for i := 0; i < total; i++ {
		b, ok := parts[i]
		if !ok {
			return false, nil, transport.ErrIncomplete
		}
		out = append(out, b...)
	}
	if _, err = tx.Exec(`DELETE FROM quantum_chat.quantum_chat_chunks WHERE txid=$1`, txid); err != nil {
		return false, nil, err
	}
	if err = tx.Commit(); err != nil {
		return false, nil, err
	}
	return true, out, nil
}

func (s *PGStore) Enqueue(recipientID string, msgID []byte, envelope []byte, ttl time.Duration) bool {
	txid := hexstr(msgID)[:12]
	res, err := s.db.Exec(
		`INSERT INTO quantum_chat.quantum_chat_messages(txid,recipient_id,msg_id,encrypted_envelope,expires_at)
		 VALUES($1,$2,$3,$4,$5) ON CONFLICT (msg_id) DO NOTHING`,
		txid, recipientID, msgID, envelope, time.Now().Add(ttl))
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	return n > 0 // false => duplicate msg_id (replay) was dropped
}

func (s *PGStore) Poll(recipientID string, offset, window int) PollResult {
	var txid string
	var env []byte
	err := s.db.QueryRow(
		`SELECT txid, encrypted_envelope FROM quantum_chat.quantum_chat_messages
		 WHERE recipient_id=$1 AND delivered_at IS NULL AND expires_at > NOW()
		 ORDER BY id ASC LIMIT 1`, recipientID).Scan(&txid, &env)
	if errors.Is(err, sql.ErrNoRows) || err != nil {
		return PollResult{Found: false}
	}
	frames := transport.EncodeDownstream(env, 200)
	if offset < 0 {
		offset = 0
	}
	if window <= 0 {
		window = 1
	}
	if offset > len(frames) {
		offset = len(frames)
	}
	end := offset + window
	if end > len(frames) {
		end = len(frames)
	}
	return PollResult{Found: true, TxID: txid, Total: len(frames), Frames: frames[offset:end]}
}

func (s *PGStore) Ack(recipientID, txid string) bool {
	res, err := s.db.Exec(
		`DELETE FROM quantum_chat.quantum_chat_messages WHERE recipient_id=$1 AND txid=$2`,
		recipientID, txid)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	return n > 0
}

func (s *PGStore) Audit(action, detail string) {
	_, _ = s.db.Exec(
		`INSERT INTO quantum_chat.quantum_chat_audit_logs(action,detail) VALUES($1,$2)`, action, detail)
}

func (s *PGStore) AuditTail(n int) []AuditEntry {
	if n <= 0 {
		n = 100
	}
	rows, err := s.db.Query(
		`SELECT action, COALESCE(detail,''), created_at
		 FROM quantum_chat.quantum_chat_audit_logs ORDER BY created_at DESC LIMIT $1`, n)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var desc []AuditEntry
	for rows.Next() {
		var e AuditEntry
		if err := rows.Scan(&e.Action, &e.Detail, &e.At); err == nil {
			desc = append(desc, e)
		}
	}
	// reverse to chronological order to match RAMStore semantics
	for i, j := 0, len(desc)-1; i < j; i, j = i+1, j-1 {
		desc[i], desc[j] = desc[j], desc[i]
	}
	return desc
}

func (s *PGStore) Sweep(now time.Time) {
	_, _ = s.db.Exec(`SELECT quantum_chat.qc_sweep()`)
}

func (s *PGStore) Stats() Stats {
	var st Stats
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM quantum_chat.quantum_chat_users`).Scan(&st.Registrations)
	_ = s.db.QueryRow(
		`SELECT COUNT(*) FROM quantum_chat.quantum_chat_messages WHERE delivered_at IS NULL`).Scan(&st.PendingMsgs)
	_ = s.db.QueryRow(
		`SELECT COUNT(DISTINCT txid) FROM quantum_chat.quantum_chat_chunks`).Scan(&st.UpstreamBufs)
	return st
}
