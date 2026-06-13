package storage

import (
	"testing"
	"time"

	"quantumchat/internal/identity"
)

func TestEnqueueReplayDedup(t *testing.T) {
	s := NewRAMStore()
	msgID := []byte("0123456789abcdef")
	if !s.Enqueue("BBBBBBBBBBBBBBBBBBBB", msgID, []byte("ciphertext"), time.Minute) {
		t.Fatal("first enqueue should be accepted")
	}
	if s.Enqueue("BBBBBBBBBBBBBBBBBBBB", msgID, []byte("ciphertext"), time.Minute) {
		t.Fatal("replay of same msgID must be rejected")
	}
}

func TestPollAck(t *testing.T) {
	s := NewRAMStore()
	rid := "BBBBBBBBBBBBBBBBBBBB"
	msgID := []byte("aaaaaaaaaaaaaaaa")
	s.Enqueue(rid, msgID, []byte("hello-ciphertext-payload"), time.Minute)

	pr := s.Poll(rid, 0, 64)
	if !pr.Found || pr.Total < 1 || len(pr.Frames) < 1 {
		t.Fatalf("poll empty: %+v", pr)
	}
	if !s.Ack(rid, pr.TxID) {
		t.Fatal("ack should succeed")
	}
	if s.Poll(rid, 0, 64).Found {
		t.Fatal("queue should be empty after ack")
	}
}

func TestSweepExpiry(t *testing.T) {
	s := NewRAMStore()
	rid := "BBBBBBBBBBBBBBBBBBBB"
	s.Enqueue(rid, []byte("bbbbbbbbbbbbbbbb"), []byte("x"), 1*time.Millisecond)
	time.Sleep(5 * time.Millisecond)
	s.Sweep(time.Now())
	if s.Poll(rid, 0, 64).Found {
		t.Fatal("expired message should be swept")
	}
}

func TestRegisterLookup(t *testing.T) {
	s := NewRAMStore()
	rec := identity.Record{ID: "CCCCCCCCCCCCCCCCCCCC", SignPub: make([]byte, 32), DHPub: make([]byte, 32)}
	if err := s.Register(rec); err != nil {
		t.Fatal(err)
	}
	got, ok := s.Lookup("CCCCCCCCCCCCCCCCCCCC")
	if !ok || got.ID != rec.ID {
		t.Fatal("lookup failed")
	}
}
