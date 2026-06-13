package identity

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"testing"
)

func keys(t *testing.T) (signPub, dhPub []byte) {
	sp, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	dk, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return sp, dk.PublicKey().Bytes()
}

func TestDeriveDeterministicAndShape(t *testing.T) {
	sp, dp := keys(t)
	id1, err := DeriveID(sp, dp)
	if err != nil {
		t.Fatal(err)
	}
	id2, _ := DeriveID(sp, dp)
	if id1 != id2 {
		t.Fatal("derivation not deterministic")
	}
	if len(id1) != IDLen {
		t.Fatalf("len=%d want %d (%s)", len(id1), IDLen, id1)
	}
	if !ValidID(id1) {
		t.Fatalf("derived ID fails ValidID: %s", id1)
	}
}

func TestVerifyID(t *testing.T) {
	sp, dp := keys(t)
	id, _ := DeriveID(sp, dp)
	if err := VerifyID(id, sp, dp); err != nil {
		t.Fatalf("self-cert verify failed: %v", err)
	}
	// Different keys must not match the same ID.
	sp2, dp2 := keys(t)
	if err := VerifyID(id, sp2, dp2); err == nil {
		t.Fatal("expected mismatch for different keys")
	}
}

func TestNormalizeAndValid(t *testing.T) {
	sp, dp := keys(t)
	id, _ := DeriveID(sp, dp)
	mangled := " " + id[:4] + "-" + id[4:] + " "
	if NormalizeID(mangled) != id {
		t.Fatalf("normalize: got %q want %q", NormalizeID(mangled), id)
	}
	if ValidID("0000000000000000000") { // 19 chars
		t.Fatal("19-char accepted")
	}
}
