// Package identity defines Quantum Chat user IDs and the registration record.
//
// 20-CHARACTER ID DESIGN (self-certifying):
//   id = Crockford-Base32( first 100 bits of SHA-256("qc-id" || signPub || dhPub) )
//   100 bits / 5 bits-per-char = exactly 20 characters, uppercase alphanumeric.
//
// Why derive from the keys instead of pure random? The spec asks for both
// "cryptographically secure random generation" AND "mapped to public identity
// key" and "impersonation prevention". A hash-derived ID satisfies all three:
//   - output is indistinguishable from random and unpredictable without the key
//     (so it is non-sequential and collision-resistant), AND
//   - it is SELF-CERTIFYING: anyone who has your ID can verify that a claimed
//     public key actually belongs to it by recomputing the hash. The server
//     cannot substitute a different key for your ID without ~2^100 work.
//
// The 20-char ID is a LOCATOR. Full impersonation/MITM protection still comes
// from comparing key fingerprints (safety numbers) out of band — see
// crypto.Fingerprint and docs/threat-model.md.
package identity

import (
	"crypto/sha256"
	"errors"
	"strings"
	"time"
)

// Crockford Base32 alphabet (excludes I, L, O, U to avoid ambiguity).
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

const IDLen = 20

var (
	ErrBadID      = errors.New("quantum-chat/identity: malformed ID")
	ErrIDMismatch = errors.New("quantum-chat/identity: ID does not match public keys")
	ErrBadKey     = errors.New("quantum-chat/identity: invalid public key length")
)

// DeriveID computes the self-certifying 20-char ID for a public identity.
func DeriveID(signPub, dhPub []byte) (string, error) {
	if len(signPub) != 32 || len(dhPub) != 32 {
		return "", ErrBadKey
	}
	h := sha256.New()
	h.Write([]byte("qc-id"))
	h.Write(signPub)
	h.Write(dhPub)
	sum := h.Sum(nil)
	return encode100(sum), nil
}

// VerifyID returns nil iff id is the correct self-certifying ID for these keys.
// This is what prevents the server (or anyone) from binding your ID to a key
// you do not control.
func VerifyID(id string, signPub, dhPub []byte) error {
	want, err := DeriveID(signPub, dhPub)
	if err != nil {
		return err
	}
	if !strings.EqualFold(id, want) {
		return ErrIDMismatch
	}
	return nil
}

// NormalizeID upper-cases and strips spaces/hyphens a user may have typed.
func NormalizeID(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	s = strings.ReplaceAll(s, "-", "")
	s = strings.ReplaceAll(s, " ", "")
	return s
}

// ValidID checks shape only (length + alphabet), not key binding.
func ValidID(id string) bool {
	if len(id) != IDLen {
		return false
	}
	for _, c := range id {
		if !strings.ContainsRune(crockford, c) {
			return false
		}
	}
	return true
}

// Record is what the server stores for a registered ID. It holds ONLY public
// data — no message content, no private keys, no personal metadata.
type Record struct {
	ID           string    `json:"id"`
	SignPub      []byte    `json:"sign_pub"` // 32B ed25519
	DHPub        []byte    `json:"dh_pub"`   // 32B x25519
	RegisteredAt time.Time `json:"registered_at"`
	LastSeen     time.Time `json:"last_seen"`
}

// encode100 turns the first 100 bits (12.5 bytes) of sum into 20 Crockford
// chars. We consume 100 bits as twenty 5-bit groups from the big-endian sum.
func encode100(sum []byte) string {
	var out [IDLen]byte
	var bitbuf uint32
	var bits int
	idx := 0
	pos := 0
	for pos < IDLen {
		if bits < 5 {
			bitbuf = (bitbuf << 8) | uint32(sum[idx])
			idx++
			bits += 8
		}
		bits -= 5
		v := (bitbuf >> uint(bits)) & 0x1f
		out[pos] = crockford[v]
		pos++
	}
	return string(out[:])
}
