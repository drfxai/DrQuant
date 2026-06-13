// Package crypto implements Quantum Chat's message-layer cryptography.
//
// Primitives (all from the Go standard library so the service has a small,
// auditable dependency surface):
//   - X25519 (crypto/ecdh)         key agreement
//   - Ed25519 (crypto/ed25519)     identity signing
//   - AES-256-GCM (crypto/cipher)  authenticated encryption  [verified default]
//   - HKDF-SHA256 (hand-rolled)    key derivation
//
// NOTE on the AEAD choice: the spec allows "ChaCha20-Poly1305 OR AES-256-GCM".
// We default to AES-256-GCM because it is in the standard library (no external
// dependency). To switch to ChaCha20-Poly1305, replace newAEAD() with
// golang.org/x/crypto/chacha20poly1305.New — the envelope format is unchanged
// (both are 96-bit-nonce, 128-bit-tag AEADs).
//
// MESSAGE SCHEME (ephemeral-static, "sealed box" + sender signature):
//   shared = X25519(ephemeral_priv, recipient_static_pub)
//   key    = HKDF(shared, salt=ephemeral_pub||recipient_pub, info="quantum-chat/v1 aead")
//   ct     = AEAD(key, nonce, plaintext, aad = sender_id||recipient_id||msg_id)
//   sig    = Ed25519_sign(sender_identity, transcript)   // sender authenticity
//
// FORWARD SECRECY (read carefully — we do not oversell this):
//   The per-message ephemeral protects against compromise of the SENDER's
//   key material. It does NOT protect past messages if the RECIPIENT's
//   long-term X25519 key is later compromised (an attacker who recovers it can
//   recompute `shared` from the ephemeral_pub carried in the envelope).
//   Full forward + future secrecy against recipient long-term key compromise
//   requires signed one-time prekeys (X3DH) and/or the Double Ratchet. That is
//   implemented and unit-tested in internal/ratchet, but is NOT yet wired into
//   this envelope/transport path; until it is, messages on the wire have the
//   partial forward secrecy described above. See docs/forward-secrecy.md.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
)

const (
	// Envelope/version tag mixed into key derivation and signatures.
	infoLabel = "quantum-chat/v1 aead"
	sigLabel  = "quantum-chat/v1 sig"
)

var (
	ErrBadCiphertext = errors.New("quantum-chat/crypto: authentication failed")
	ErrBadKeyLength  = errors.New("quantum-chat/crypto: invalid key length")
	ErrBadSignature  = errors.New("quantum-chat/crypto: invalid signature")
)

// Identity is a user's long-term key material. Private keys never leave the
// device in the real client; this struct is used server-side only for tests and
// for the optional self-test. Registration stores only the PUBLIC halves.
type Identity struct {
	SignPriv ed25519.PrivateKey // Ed25519 (authenticity)
	SignPub  ed25519.PublicKey
	DHPriv   *ecdh.PrivateKey // X25519 (confidentiality)
	DHPub    *ecdh.PublicKey
}

// PublicIdentity is the publishable half: what gets mapped to a 20-char ID.
type PublicIdentity struct {
	SignPub []byte // 32 bytes ed25519
	DHPub   []byte // 32 bytes x25519
}

// GenerateIdentity creates a fresh long-term identity.
func GenerateIdentity() (*Identity, error) {
	signPub, signPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	dhPriv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return &Identity{
		SignPriv: signPriv,
		SignPub:  signPub,
		DHPriv:   dhPriv,
		DHPub:    dhPriv.PublicKey(),
	}, nil
}

func (id *Identity) Public() PublicIdentity {
	return PublicIdentity{
		SignPub: append([]byte(nil), id.SignPub...),
		DHPub:   id.DHPub.Bytes(),
	}
}

// Envelope is the wire form of an encrypted message (before DNS chunking).
type Envelope struct {
	Version      byte
	SenderID     string // 20-char locator of the sender
	RecipientID  string // 20-char locator of the recipient
	MsgID        []byte // 16 random bytes (replay key)
	EphemeralPub []byte // 32 bytes
	Nonce        []byte // 12 bytes
	Ciphertext   []byte // AEAD output (includes 16-byte tag)
	Sig          []byte // 64-byte Ed25519 signature over the transcript
}

// Seal encrypts plaintext from sender -> recipient and signs the result.
func Seal(sender *Identity, senderID, recipientID string, recipientDHPub []byte, msgID, plaintext []byte) (*Envelope, error) {
	rpub, err := ecdh.X25519().NewPublicKey(recipientDHPub)
	if err != nil {
		return nil, ErrBadKeyLength
	}
	eph, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	shared, err := eph.ECDH(rpub)
	if err != nil {
		return nil, err
	}
	salt := append(append([]byte(nil), eph.PublicKey().Bytes()...), recipientDHPub...)
	key := hkdf(shared, salt, []byte(infoLabel), 32)

	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	aad := aadBytes(senderID, recipientID, msgID)
	ct := aead.Seal(nil, nonce, plaintext, aad)

	env := &Envelope{
		Version:      1,
		SenderID:     senderID,
		RecipientID:  recipientID,
		MsgID:        msgID,
		EphemeralPub: eph.PublicKey().Bytes(),
		Nonce:        nonce,
		Ciphertext:   ct,
	}
	env.Sig = ed25519.Sign(sender.SignPriv, transcript(env))
	return env, nil
}

// Open verifies the sender signature and decrypts. recipient is the local
// identity; senderSignPub is the sender's Ed25519 public key (looked up by ID
// and fingerprint-verified out of band).
func Open(recipient *Identity, senderSignPub []byte, env *Envelope) ([]byte, error) {
	if len(senderSignPub) != ed25519.PublicKeySize {
		return nil, ErrBadKeyLength
	}
	if !ed25519.Verify(ed25519.PublicKey(senderSignPub), transcript(env), env.Sig) {
		return nil, ErrBadSignature
	}
	ephPub, err := ecdh.X25519().NewPublicKey(env.EphemeralPub)
	if err != nil {
		return nil, ErrBadKeyLength
	}
	shared, err := recipient.DHPriv.ECDH(ephPub)
	if err != nil {
		return nil, err
	}
	salt := append(append([]byte(nil), env.EphemeralPub...), recipient.DHPub.Bytes()...)
	key := hkdf(shared, salt, []byte(infoLabel), 32)

	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	aad := aadBytes(env.SenderID, env.RecipientID, env.MsgID)
	pt, err := aead.Open(nil, env.Nonce, env.Ciphertext, aad)
	if err != nil {
		return nil, ErrBadCiphertext
	}
	return pt, nil
}

// Fingerprint returns a stable hash of an identity's public keys. Two users
// compare fingerprints out of band (a "safety number") to defeat MITM: the
// 20-char ID is only a locator, the fingerprint is the authenticator.
func Fingerprint(p PublicIdentity) []byte {
	h := sha256.New()
	h.Write([]byte("quantum-chat/v1 fp"))
	h.Write(p.SignPub)
	h.Write(p.DHPub)
	return h.Sum(nil)
}

// --- helpers ---------------------------------------------------------------

func newAEAD(key []byte) (cipher.AEAD, error) {
	if len(key) != 32 {
		return nil, ErrBadKeyLength
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func aadBytes(senderID, recipientID string, msgID []byte) []byte {
	b := make([]byte, 0, len(senderID)+len(recipientID)+len(msgID))
	b = append(b, senderID...)
	b = append(b, recipientID...)
	b = append(b, msgID...)
	return b
}

// transcript is the byte string the sender signs and the recipient verifies.
// It binds every envelope field except the signature itself.
func transcript(e *Envelope) []byte {
	h := sha256.New()
	h.Write([]byte(sigLabel))
	h.Write([]byte{e.Version})
	h.Write([]byte(e.SenderID))
	h.Write([]byte(e.RecipientID))
	h.Write(e.MsgID)
	h.Write(e.EphemeralPub)
	h.Write(e.Nonce)
	h.Write(e.Ciphertext)
	return h.Sum(nil)
}

// hkdf is RFC 5869 HKDF-SHA256 (extract + expand). Implemented locally to avoid
// an external dependency; ~20 lines, standard construction.
func hkdf(ikm, salt, info []byte, length int) []byte {
	if len(salt) == 0 {
		salt = make([]byte, sha256.Size)
	}
	// extract
	ext := hmac.New(sha256.New, salt)
	ext.Write(ikm)
	prk := ext.Sum(nil)
	// expand
	var out, t []byte
	for i := byte(1); len(out) < length; i++ {
		exp := hmac.New(sha256.New, prk)
		exp.Write(t)
		exp.Write(info)
		exp.Write([]byte{i})
		t = exp.Sum(nil)
		out = append(out, t...)
	}
	return out[:length]
}

// RandBytes returns n cryptographically secure random bytes.
func RandBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return nil, err
	}
	return b, nil
}
