package ratchet

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"testing"
)

// bobBundle builds a full prekey bundle + private material for a recipient.
func bobBundle(t *testing.T) (idDH *ecdh.PrivateKey, idSignPub ed25519.PublicKey, spk KeyPair, bundle PreKeyBundle, mat *PreKeyMaterial) {
	t.Helper()
	idDH, _ = ecdh.X25519().GenerateKey(rand.Reader)
	signPub, signPriv, _ := ed25519.GenerateKey(rand.Reader)
	spk, _ = GenerateDH()
	opk, _ := GenerateDH()
	sig := SignSignedPreKey(signPriv, spk.Pub)
	bundle = PreKeyBundle{
		IdentityDH:    idDH.PublicKey().Bytes(),
		IdentitySign:  signPub,
		SignedPreKey:  spk.Pub,
		SignedPreSig:  sig,
		OneTimePreKey: opk.Pub,
	}
	mat = &PreKeyMaterial{
		IdentityDH:   idDH,
		SignedPreKey: spk,
		OneTimeKeys:  map[string]*ecdh.PrivateKey{hexstr(opk.Pub): opk.Priv},
	}
	return idDH, signPub, spk, bundle, mat
}

func establish(t *testing.T) (alice, bob *Session) {
	t.Helper()
	aliceIDDH, _ := ecdh.X25519().GenerateKey(rand.Reader)
	aliceSignPub, _, _ := ed25519.GenerateKey(rand.Reader)

	bobIDDH, _, bobSPK, bundle, mat := bobBundle(t)

	initRes, err := X3DHInitiate(aliceIDDH, aliceSignPub, bundle)
	if err != nil {
		t.Fatalf("initiate: %v", err)
	}
	respRes, err := X3DHRespond(mat, bobIDDH, aliceIDDH.PublicKey().Bytes(), initRes.EphemeralPub, initRes.UsedOneTime)
	if err != nil {
		t.Fatalf("respond: %v", err)
	}
	if !bytes.Equal(initRes.SharedKey, respRes.SharedKey) {
		t.Fatal("X3DH shared secrets differ")
	}
	if len(mat.OneTimeKeys) != 0 {
		t.Fatal("one-time prekey was not consumed")
	}
	alice, err = InitAlice(initRes)
	if err != nil {
		t.Fatal(err)
	}
	bob = InitBob(respRes, bobSPK)
	return alice, bob
}

func TestX3DHAndBasicSession(t *testing.T) {
	alice, bob := establish(t)

	// Alice -> Bob (first message establishes Bob's receiving chain).
	h1, c1, err := alice.Encrypt([]byte("meet at 0600"))
	if err != nil {
		t.Fatal(err)
	}
	got, err := bob.Decrypt(h1, c1)
	if err != nil || string(got) != "meet at 0600" {
		t.Fatalf("bob decrypt: %v %q", err, got)
	}

	// Bob -> Alice.
	h2, c2, err := bob.Encrypt([]byte("understood"))
	if err != nil {
		t.Fatal(err)
	}
	got, err = alice.Decrypt(h2, c2)
	if err != nil || string(got) != "understood" {
		t.Fatalf("alice decrypt: %v %q", err, got)
	}

	// Several more round trips to exercise repeated DH ratchets.
	for i := 0; i < 5; i++ {
		ha, ca, _ := alice.Encrypt([]byte("ping"))
		if g, err := bob.Decrypt(ha, ca); err != nil || string(g) != "ping" {
			t.Fatalf("rt %d a->b: %v %q", i, err, g)
		}
		hb, cb, _ := bob.Encrypt([]byte("pong"))
		if g, err := alice.Decrypt(hb, cb); err != nil || string(g) != "pong" {
			t.Fatalf("rt %d b->a: %v %q", i, err, g)
		}
	}
}

func TestOutOfOrderDelivery(t *testing.T) {
	alice, bob := establish(t)

	// Alice sends three messages in one sending chain.
	h1, c1, _ := alice.Encrypt([]byte("m1"))
	h2, c2, _ := alice.Encrypt([]byte("m2"))
	h3, c3, _ := alice.Encrypt([]byte("m3"))

	// Bob receives them out of order: 3, 1, 2.
	if g, err := bob.Decrypt(h3, c3); err != nil || string(g) != "m3" {
		t.Fatalf("m3 first: %v %q", err, g)
	}
	if g, err := bob.Decrypt(h1, c1); err != nil || string(g) != "m1" {
		t.Fatalf("m1 via skipped key: %v %q", err, g)
	}
	if g, err := bob.Decrypt(h2, c2); err != nil || string(g) != "m2" {
		t.Fatalf("m2 via skipped key: %v %q", err, g)
	}
}

// Forward secrecy (within a chain): once a message is consumed in order, its key
// is ratcheted away and the same ciphertext can no longer be decrypted.
func TestForwardSecrecyKeyDeleted(t *testing.T) {
	alice, bob := establish(t)
	h1, c1, _ := alice.Encrypt([]byte("secret-1"))
	h2, c2, _ := alice.Encrypt([]byte("secret-2"))

	if g, err := bob.Decrypt(h1, c1); err != nil || string(g) != "secret-1" {
		t.Fatalf("first decrypt: %v %q", err, g)
	}
	if g, err := bob.Decrypt(h2, c2); err != nil || string(g) != "secret-2" {
		t.Fatalf("second decrypt: %v %q", err, g)
	}
	// Re-deliver message 1: its key is gone (chain advanced, not in skipped map).
	if _, err := bob.Decrypt(h1, c1); err == nil {
		t.Fatal("expected failure decrypting a consumed in-order message (forward secrecy)")
	}
}

// Post-compromise (future) secrecy: a fresh DH round-trip injects new entropy,
// changing the root key so a compromise of old chain keys does not reveal new
// messages.
func TestDHRatchetAdvancesRoot(t *testing.T) {
	alice, bob := establish(t)
	rkBefore := append([]byte(nil), alice.RK...)

	h1, c1, _ := alice.Encrypt([]byte("a"))
	bob.Decrypt(h1, c1)
	h2, c2, _ := bob.Encrypt([]byte("b"))
	if _, err := alice.Decrypt(h2, c2); err != nil { // triggers Alice's DH ratchet
		t.Fatal(err)
	}
	if bytes.Equal(alice.RK, rkBefore) {
		t.Fatal("root key did not advance after a DH round-trip")
	}
}

func TestForgedSignedPreKeyRejected(t *testing.T) {
	aliceIDDH, _ := ecdh.X25519().GenerateKey(rand.Reader)
	aliceSignPub, _, _ := ed25519.GenerateKey(rand.Reader)
	_, _, _, bundle, _ := bobBundle(t)
	bundle.SignedPreSig[0] ^= 0xFF // corrupt the signature

	if err := VerifyPreKeyBundle(bundle); err == nil {
		t.Fatal("forged signed prekey accepted by VerifyPreKeyBundle")
	}
	if _, err := X3DHInitiate(aliceIDDH, aliceSignPub, bundle); err == nil {
		t.Fatal("forged signed prekey accepted by X3DHInitiate")
	}
}

func TestSessionWithoutOneTimePreKey(t *testing.T) {
	aliceIDDH, _ := ecdh.X25519().GenerateKey(rand.Reader)
	aliceSignPub, _, _ := ed25519.GenerateKey(rand.Reader)
	bobIDDH, _, bobSPK, bundle, mat := bobBundle(t)
	bundle.OneTimePreKey = nil // no OPK available

	initRes, err := X3DHInitiate(aliceIDDH, aliceSignPub, bundle)
	if err != nil {
		t.Fatal(err)
	}
	respRes, err := X3DHRespond(mat, bobIDDH, aliceIDDH.PublicKey().Bytes(), initRes.EphemeralPub, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(initRes.SharedKey, respRes.SharedKey) {
		t.Fatal("shared secrets differ without OPK")
	}
	alice, err := InitAlice(initRes)
	if err != nil {
		t.Fatal(err)
	}
	bob := InitBob(respRes, bobSPK)
	h, c, _ := alice.Encrypt([]byte("no-opk path"))
	if g, err := bob.Decrypt(h, c); err != nil || string(g) != "no-opk path" {
		t.Fatalf("decrypt without OPK: %v %q", err, g)
	}
}

func TestHeaderRoundTrip(t *testing.T) {
	pub, _ := RandBytes(32)
	h := Header{DH: pub, PN: 7, N: 42}
	got, err := ParseHeader(h.Marshal())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.DH, pub) || got.PN != 7 || got.N != 42 {
		t.Fatalf("header round-trip mismatch: %+v", got)
	}
	if _, err := ParseHeader([]byte("short")); err == nil {
		t.Fatal("expected error on short header")
	}
}
