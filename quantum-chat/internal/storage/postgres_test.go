package storage

import (
	"os"
	"testing"
	"time"

	"quantumchat/internal/identity"
	"quantumchat/internal/transport"
)

// These tests run only when QC_TEST_POSTGRES_URL points at a database with the
// schema from migrations/001_quantum_chat_schema.sql applied. Otherwise skipped.
//
// Example:
//   QC_TEST_POSTGRES_URL="postgres://user:pass@127.0.0.1:5432/quantumchat?sslmode=disable" \
//     go test ./internal/storage/ -run TestPG -v
func pgStore(t *testing.T) *PGStore {
	t.Helper()
	url := os.Getenv("QC_TEST_POSTGRES_URL")
	if url == "" {
		t.Skip("set QC_TEST_POSTGRES_URL to run Postgres backend tests")
	}
	s, err := OpenPostgres(url)
	if err != nil {
		t.Fatalf("OpenPostgres: %v", err)
	}
	// clean slate
	_, err = s.db.Exec(`TRUNCATE quantum_chat.quantum_chat_users,
		quantum_chat.quantum_chat_public_keys, quantum_chat.quantum_chat_messages,
		quantum_chat.quantum_chat_chunks, quantum_chat.quantum_chat_delivery_receipts,
		quantum_chat.quantum_chat_audit_logs RESTART IDENTITY CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestPGRegisterLookup(t *testing.T) {
	s := pgStore(t)
	sp := make([]byte, 32)
	dp := make([]byte, 32)
	sp[0], dp[0] = 1, 2
	rec := identity.Record{ID: "CCCCCCCCCCCCCCCCCCCC", SignPub: sp, DHPub: dp}
	if err := s.Register(rec); err != nil {
		t.Fatal(err)
	}
	got, ok := s.Lookup("CCCCCCCCCCCCCCCCCCCC")
	if !ok || got.ID != rec.ID || len(got.SignPub) != 32 || len(got.DHPub) != 32 {
		t.Fatalf("lookup mismatch: %+v ok=%v", got, ok)
	}
	if got.SignPub[0] != 1 || got.DHPub[0] != 2 {
		t.Fatal("key bytes not round-tripped")
	}
	// re-register is idempotent
	if err := s.Register(rec); err != nil {
		t.Fatalf("re-register: %v", err)
	}
}

func TestPGEnqueueReplayPollAck(t *testing.T) {
	s := pgStore(t)
	rid := "BBBBBBBBBBBBBBBBBBBB"
	msgID := []byte("0123456789abcdef")
	env := []byte("an-encrypted-envelope-blob-of-some-length-................")

	if !s.Enqueue(rid, msgID, env, time.Hour) {
		t.Fatal("first enqueue should be accepted")
	}
	if s.Enqueue(rid, msgID, env, time.Hour) {
		t.Fatal("replay (same msg_id) must be rejected")
	}

	var frames []string
	offset, total, txid := 0, 0, ""
	for {
		pr := s.Poll(rid, offset, 64)
		if !pr.Found {
			t.Fatal("poll returned nothing")
		}
		txid = pr.TxID
		total = pr.Total
		frames = append(frames, pr.Frames...)
		offset += len(pr.Frames)
		if offset >= total {
			break
		}
	}
	got, err := transport.DecodeDownstream(frames)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(env) {
		t.Fatalf("envelope round-trip mismatch via Postgres poll")
	}
	if !s.Ack(rid, txid) {
		t.Fatal("ack should delete")
	}
	if s.Poll(rid, 0, 64).Found {
		t.Fatal("queue must be empty after ack")
	}
}

func TestPGPutChunkReassemble(t *testing.T) {
	s := pgStore(t)
	// three chunks for one txid
	full := []byte("CHUNK-A|CHUNK-B|CHUNK-C")
	chunks := [][]byte{[]byte("CHUNK-A|"), []byte("CHUNK-B|"), []byte("CHUNK-C")}
	var done bool
	var assembled []byte
	for i, c := range chunks {
		f := &transport.UpstreamFrame{TxID: "tx-abc", Seq: i, Total: 3, Data: c}
		complete, out, err := s.PutChunk("tx-abc", f, 1<<20)
		if err != nil {
			t.Fatalf("PutChunk %d: %v", i, err)
		}
		if complete {
			done, assembled = true, out
		}
	}
	if !done {
		t.Fatal("never completed")
	}
	if string(assembled) != string(full) {
		t.Fatalf("reassembled mismatch: %q", assembled)
	}
}

func TestPGSweep(t *testing.T) {
	s := pgStore(t)
	rid := "DDDDDDDDDDDDDDDDDDDD"
	s.Enqueue(rid, []byte("expiremsgidxxxxx"), []byte("x"), 1*time.Millisecond)
	time.Sleep(10 * time.Millisecond)
	s.Sweep(time.Now())
	if s.Poll(rid, 0, 64).Found {
		t.Fatal("expired message should be swept by qc_sweep()")
	}
}
