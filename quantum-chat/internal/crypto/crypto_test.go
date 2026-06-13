package crypto

import (
	"bytes"
	"testing"
)

func TestSealOpenRoundTrip(t *testing.T) {
	alice, err := GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	bob, err := GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	msgID, _ := RandBytes(16)
	plaintext := []byte("emergency: meet at the safe house at 0600")

	env, err := Seal(alice, "AAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBB", bob.DHPub.Bytes(), msgID, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Open(bob, alice.SignPub, env)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if !bytes.Equal(got, plaintext) {
		t.Fatalf("plaintext mismatch: %q", got)
	}
}

func TestTamperRejected(t *testing.T) {
	a, _ := GenerateIdentity()
	b, _ := GenerateIdentity()
	msgID, _ := RandBytes(16)
	env, _ := Seal(a, "AAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBB", b.DHPub.Bytes(), msgID, []byte("hi"))

	env.Ciphertext[0] ^= 0xFF // flip a bit
	if _, err := Open(b, a.SignPub, env); err == nil {
		t.Fatal("expected auth failure on tampered ciphertext")
	}
}

func TestWrongSenderKeyRejected(t *testing.T) {
	a, _ := GenerateIdentity()
	b, _ := GenerateIdentity()
	imposter, _ := GenerateIdentity()
	msgID, _ := RandBytes(16)
	env, _ := Seal(a, "AAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBB", b.DHPub.Bytes(), msgID, []byte("hi"))

	if _, err := Open(b, imposter.SignPub, env); err == nil {
		t.Fatal("expected signature failure with wrong sender key")
	}
}

func TestFingerprintStable(t *testing.T) {
	a, _ := GenerateIdentity()
	f1 := Fingerprint(a.Public())
	f2 := Fingerprint(a.Public())
	if !bytes.Equal(f1, f2) {
		t.Fatal("fingerprint not stable")
	}
	if len(f1) != 32 {
		t.Fatalf("fingerprint length = %d", len(f1))
	}
}
