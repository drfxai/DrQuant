// Package ratchet implements X3DH key agreement and the Double Ratchet for
// Quantum Chat, giving the FULL forward secrecy the batch-1 ephemeral-static
// envelope did not: past message keys stay secret even if a party's long-term
// identity key is later compromised, and the DH ratchet provides post-compromise
// ("future") secrecy once a fresh round-trip occurs.
//
// All primitives are Go standard library:
//   - X25519 (crypto/ecdh)        Diffie-Hellman
//   - Ed25519 (crypto/ed25519)    signed-prekey signatures
//   - HKDF-SHA256 / HMAC-SHA256   root + chain KDFs (RFC 5869 / Signal spec)
//   - AES-256-GCM (crypto/cipher) per-message AEAD
//
// References: Signal "X3DH" and "The Double Ratchet Algorithm" specifications.
// This is a faithful, compact implementation (with skipped-message-key handling
// for out-of-order delivery, which the store-and-forward DNS transport needs).
//
// NOTE ON IDENTITY KEYS: a Quantum Chat identity has a separate Ed25519 signing
// key and X25519 DH key (see internal/crypto). X3DH's DH steps use the X25519
// identity key; the Ed25519 key signs the medium-term signed prekey.
package ratchet

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"
)

const (
	maxSkip   = 1000 // max message keys we will skip/store per chain (DoS bound)
	infoX3DH  = "quantum-chat/v1 x3dh"
	infoRoot  = "quantum-chat/v1 ratchet root"
	infoMsg   = "quantum-chat/v1 ratchet msg"
	spkSigCtx = "quantum-chat/v1 spk"
)

var (
	ErrBadKey      = errors.New("quantum-chat/ratchet: invalid key length")
	ErrBadSig      = errors.New("quantum-chat/ratchet: signed-prekey signature invalid")
	ErrDecrypt     = errors.New("quantum-chat/ratchet: decryption failed")
	ErrSkipTooMany = errors.New("quantum-chat/ratchet: too many skipped messages")
	ErrHeader      = errors.New("quantum-chat/ratchet: malformed header")
)

// ---- DH helpers ------------------------------------------------------------

// KeyPair is an X25519 keypair.
type KeyPair struct {
	Priv *ecdh.PrivateKey
	Pub  []byte
}

// GenerateDH creates a fresh X25519 keypair.
func GenerateDH() (KeyPair, error) {
	p, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return KeyPair{}, err
	}
	return KeyPair{Priv: p, Pub: p.PublicKey().Bytes()}, nil
}

func dh(priv *ecdh.PrivateKey, peerPub []byte) ([]byte, error) {
	pub, err := ecdh.X25519().NewPublicKey(peerPub)
	if err != nil {
		return nil, ErrBadKey
	}
	return priv.ECDH(pub)
}

// ---- HKDF / chain KDFs -----------------------------------------------------

func hkdf(ikm, salt, info []byte, n int) []byte {
	if len(salt) == 0 {
		salt = make([]byte, sha256.Size)
	}
	ext := hmac.New(sha256.New, salt)
	ext.Write(ikm)
	prk := ext.Sum(nil)
	var out, t []byte
	for i := byte(1); len(out) < n; i++ {
		h := hmac.New(sha256.New, prk)
		h.Write(t)
		h.Write(info)
		h.Write([]byte{i})
		t = h.Sum(nil)
		out = append(out, t...)
	}
	return out[:n]
}

// kdfRK derives a new root key and a chain key from the root key + DH output.
func kdfRK(rk, dhOut []byte) (newRK, ck []byte) {
	out := hkdf(dhOut, rk, []byte(infoRoot), 64)
	return out[:32], out[32:]
}

// kdfCK ratchets a chain key forward, yielding the next chain key and a message
// key. Uses the Signal construction: mk = HMAC(ck,0x01), ck' = HMAC(ck,0x02).
func kdfCK(ck []byte) (newCK, mk []byte) {
	m := hmac.New(sha256.New, ck)
	m.Write([]byte{0x01})
	mk = m.Sum(nil)
	c := hmac.New(sha256.New, ck)
	c.Write([]byte{0x02})
	newCK = c.Sum(nil)
	return newCK, mk
}

// msgKeys expands a message key into an AES-256 key + 12-byte nonce.
func msgKeys(mk []byte) (key, nonce []byte) {
	out := hkdf(mk, nil, []byte(infoMsg), 44)
	return out[:32], out[32:44]
}

func aeadSeal(mk, plaintext, ad []byte) ([]byte, error) {
	key, nonce := msgKeys(mk)
	blk, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(blk)
	if err != nil {
		return nil, err
	}
	return g.Seal(nil, nonce, plaintext, ad), nil
}

func aeadOpen(mk, ct, ad []byte) ([]byte, error) {
	key, nonce := msgKeys(mk)
	blk, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(blk)
	if err != nil {
		return nil, err
	}
	pt, err := g.Open(nil, nonce, ct, ad)
	if err != nil {
		return nil, ErrDecrypt
	}
	return pt, nil
}

// ---- X3DH ------------------------------------------------------------------

// PreKeyBundle is what a recipient publishes so others can start a session
// without the recipient being online. IdentityDH/IdentitySign are long-term;
// SignedPreKey is medium-term (rotated periodically) and signed by the identity
// signing key; OneTimePreKey is used for a single session then deleted.
type PreKeyBundle struct {
	IdentityDH    []byte // 32B X25519 long-term identity (DH)
	IdentitySign  []byte // 32B Ed25519 long-term identity (verify)
	SignedPreKey  []byte // 32B X25519 medium-term prekey
	SignedPreSig  []byte // 64B Ed25519 sig over (spkSigCtx || SignedPreKey)
	OneTimePreKey []byte // 32B X25519 one-time prekey (optional; may be nil)
}

// PreKeyMaterial is the private side a recipient keeps for its published bundle.
type PreKeyMaterial struct {
	IdentityDH   *ecdh.PrivateKey
	SignedPreKey KeyPair
	OneTimeKeys  map[string]*ecdh.PrivateKey // pub-hex -> priv
}

// SignSignedPreKey returns the Ed25519 signature a bundle must carry.
func SignSignedPreKey(identitySignPriv ed25519.PrivateKey, signedPreKeyPub []byte) []byte {
	return ed25519.Sign(identitySignPriv, append([]byte(spkSigCtx), signedPreKeyPub...))
}

// VerifyPreKeyBundle checks the signed-prekey signature against the identity key.
func VerifyPreKeyBundle(b PreKeyBundle) error {
	if len(b.IdentitySign) != ed25519.PublicKeySize || len(b.SignedPreKey) != 32 || len(b.SignedPreSig) != 64 {
		return ErrBadKey
	}
	if !ed25519.Verify(ed25519.PublicKey(b.IdentitySign), append([]byte(spkSigCtx), b.SignedPreKey...), b.SignedPreSig) {
		return ErrBadSig
	}
	return nil
}

// x3dhSecret derives the shared secret from four DH outputs (DH4 optional).
func x3dhSecret(dh1, dh2, dh3, dh4 []byte) []byte {
	ikm := make([]byte, 0, 32*4+32)
	// 32-byte 0xFF prefix for domain separation (per X3DH spec).
	ikm = append(ikm, prefix32()...)
	ikm = append(ikm, dh1...)
	ikm = append(ikm, dh2...)
	ikm = append(ikm, dh3...)
	if dh4 != nil {
		ikm = append(ikm, dh4...)
	}
	return hkdf(ikm, nil, []byte(infoX3DH), 32)
}

func prefix32() []byte {
	p := make([]byte, 32)
	for i := range p {
		p[i] = 0xFF
	}
	return p
}

// InitiatorResult is what the X3DH initiator (sender) produces.
type InitiatorResult struct {
	SharedKey      []byte // 32B SK seeding the ratchet
	EphemeralPub   []byte // EK_A public, sent to the responder
	UsedOneTime    []byte // which OPK pub was consumed (nil if none)
	SignedPreKey   []byte // recipient SPK pub (becomes initial DHr)
	AssociatedData []byte // IK_A_pub || IK_B_pub
}

// X3DHInitiate runs the sender side. ourIDDH/ourIDSignPub are the initiator's
// long-term identity (DH private, signing public for AD). bundle is the
// recipient's verified prekey bundle.
func X3DHInitiate(ourIDDH *ecdh.PrivateKey, ourIDSignPub []byte, bundle PreKeyBundle) (*InitiatorResult, error) {
	if err := VerifyPreKeyBundle(bundle); err != nil {
		return nil, err
	}
	ek, err := GenerateDH()
	if err != nil {
		return nil, err
	}
	dh1, err := dh(ourIDDH, bundle.SignedPreKey) // DH(IK_A, SPK_B)
	if err != nil {
		return nil, err
	}
	dh2, err := dh(ek.Priv, bundle.IdentityDH) // DH(EK_A, IK_B)
	if err != nil {
		return nil, err
	}
	dh3, err := dh(ek.Priv, bundle.SignedPreKey) // DH(EK_A, SPK_B)
	if err != nil {
		return nil, err
	}
	var dh4 []byte
	if bundle.OneTimePreKey != nil {
		if dh4, err = dh(ek.Priv, bundle.OneTimePreKey); err != nil { // DH(EK_A, OPK_B)
			return nil, err
		}
	}
	sk := x3dhSecret(dh1, dh2, dh3, dh4)
	ad := append(append([]byte(nil), ourIDDH.PublicKey().Bytes()...), bundle.IdentityDH...)
	return &InitiatorResult{
		SharedKey:      sk,
		EphemeralPub:   ek.Pub,
		UsedOneTime:    bundle.OneTimePreKey,
		SignedPreKey:   bundle.SignedPreKey,
		AssociatedData: ad,
	}, nil
}

// ResponderResult is what the X3DH responder (recipient) produces.
type ResponderResult struct {
	SharedKey      []byte
	AssociatedData []byte
}

// X3DHRespond runs the recipient side using its stored prekey material plus the
// initiator's identity DH pub, ephemeral pub, and the consumed OPK pub (or nil).
func X3DHRespond(mat *PreKeyMaterial, ourIDDH *ecdh.PrivateKey, initiatorIDDHPub, initiatorEphPub, usedOneTimePub []byte) (*ResponderResult, error) {
	dh1, err := dh(mat.SignedPreKey.Priv, initiatorIDDHPub) // DH(SPK_B, IK_A)
	if err != nil {
		return nil, err
	}
	dh2, err := dh(ourIDDH, initiatorEphPub) // DH(IK_B, EK_A)
	if err != nil {
		return nil, err
	}
	dh3, err := dh(mat.SignedPreKey.Priv, initiatorEphPub) // DH(SPK_B, EK_A)
	if err != nil {
		return nil, err
	}
	var dh4 []byte
	if usedOneTimePub != nil {
		opk, ok := mat.OneTimeKeys[hexstr(usedOneTimePub)]
		if !ok {
			return nil, ErrBadKey
		}
		if dh4, err = dh(opk, initiatorEphPub); err != nil { // DH(OPK_B, EK_A)
			return nil, err
		}
		delete(mat.OneTimeKeys, hexstr(usedOneTimePub)) // one-time: consume it
	}
	sk := x3dhSecret(dh1, dh2, dh3, dh4)
	ad := append(append([]byte(nil), initiatorIDDHPub...), ourIDDH.PublicKey().Bytes()...)
	return &ResponderResult{SharedKey: sk, AssociatedData: ad}, nil
}

// ---- Double Ratchet --------------------------------------------------------

// Header travels with each ratchet message.
type Header struct {
	DH []byte // sender's current ratchet public key (32B)
	PN uint32 // number of messages in the previous sending chain
	N  uint32 // message number in the current sending chain
}

// Marshal encodes a header: DH(32) || PN(4 BE) || N(4 BE).
func (h Header) Marshal() []byte {
	out := make([]byte, 0, 40)
	out = append(out, h.DH...)
	var b [8]byte
	binary.BigEndian.PutUint32(b[0:4], h.PN)
	binary.BigEndian.PutUint32(b[4:8], h.N)
	return append(out, b[:]...)
}

// ParseHeader decodes a 40-byte header.
func ParseHeader(b []byte) (Header, error) {
	if len(b) != 40 {
		return Header{}, ErrHeader
	}
	return Header{
		DH: append([]byte(nil), b[:32]...),
		PN: binary.BigEndian.Uint32(b[32:36]),
		N:  binary.BigEndian.Uint32(b[36:40]),
	}, nil
}

// Session is one party's Double Ratchet state for a conversation.
type Session struct {
	DHs     KeyPair           // our current ratchet keypair
	DHr     []byte            // remote ratchet public key (nil until first recv)
	RK      []byte            // root key
	CKs     []byte            // sending chain key (nil until established)
	CKr     []byte            // receiving chain key (nil until established)
	Ns, Nr  uint32            // message numbers in sending / receiving chains
	PN      uint32            // previous sending-chain length
	Skipped map[string][]byte // (DHr-hex||N) -> message key, for out-of-order
	ad      []byte            // associated data bound into every AEAD
}

func skipKey(dhPub []byte, n uint32) string {
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], n)
	return hexstr(dhPub) + ":" + hexstr(b[:])
}

// InitAlice initializes the initiator's session from the X3DH result. Alice's
// initial DHr is Bob's signed prekey; she immediately performs a sending DH
// ratchet so her first message carries a fresh ratchet key.
func InitAlice(r *InitiatorResult) (*Session, error) {
	dhs, err := GenerateDH()
	if err != nil {
		return nil, err
	}
	s := &Session{
		DHs:     dhs,
		DHr:     append([]byte(nil), r.SignedPreKey...),
		RK:      append([]byte(nil), r.SharedKey...),
		Skipped: map[string][]byte{},
		ad:      append([]byte(nil), r.AssociatedData...),
	}
	dhOut, err := dh(s.DHs.Priv, s.DHr)
	if err != nil {
		return nil, err
	}
	s.RK, s.CKs = kdfRK(s.RK, dhOut)
	return s, nil
}

// InitBob initializes the responder's session. Bob's ratchet keypair IS his
// signed prekey keypair; his receiving chain is established when Alice's first
// message triggers a DH ratchet.
func InitBob(r *ResponderResult, signedPreKey KeyPair) *Session {
	return &Session{
		DHs:     signedPreKey,
		RK:      append([]byte(nil), r.SharedKey...),
		Skipped: map[string][]byte{},
		ad:      append([]byte(nil), r.AssociatedData...),
	}
}

// Encrypt ratchets the sending chain and returns (header, ciphertext).
func (s *Session) Encrypt(plaintext []byte) (Header, []byte, error) {
	if s.CKs == nil {
		return Header{}, nil, errors.New("quantum-chat/ratchet: no sending chain (responder must receive first)")
	}
	var mk []byte
	s.CKs, mk = kdfCK(s.CKs)
	h := Header{DH: s.DHs.Pub, PN: s.PN, N: s.Ns}
	s.Ns++
	ct, err := aeadSeal(mk, plaintext, append(append([]byte(nil), s.ad...), h.Marshal()...))
	if err != nil {
		return Header{}, nil, err
	}
	return h, ct, nil
}

// Decrypt processes an incoming (header, ciphertext), performing DH ratchet
// steps and skipped-key handling as needed.
func (s *Session) Decrypt(h Header, ct []byte) ([]byte, error) {
	ad := append(append([]byte(nil), s.ad...), h.Marshal()...)

	// 1. Try a previously-skipped message key.
	k := skipKey(h.DH, h.N)
	if mk, ok := s.Skipped[k]; ok {
		pt, err := aeadOpen(mk, ct, ad)
		if err != nil {
			return nil, err
		}
		delete(s.Skipped, k) // used once
		return pt, nil
	}

	// 2. If the header advertises a new ratchet key, skip the rest of the
	//    current receiving chain and perform a DH ratchet.
	if s.DHr == nil || !bytesEqual(h.DH, s.DHr) {
		if err := s.skipMessageKeys(h.PN); err != nil {
			return nil, err
		}
		if err := s.dhRatchet(h); err != nil {
			return nil, err
		}
	}

	// 3. Skip within the current receiving chain up to h.N.
	if err := s.skipMessageKeys(h.N); err != nil {
		return nil, err
	}

	// 4. Derive this message's key and decrypt.
	var mk []byte
	s.CKr, mk = kdfCK(s.CKr)
	s.Nr++
	return aeadOpen(mk, ct, ad)
}

func (s *Session) skipMessageKeys(until uint32) error {
	if s.CKr == nil {
		return nil
	}
	if until-s.Nr > maxSkip {
		return ErrSkipTooMany
	}
	for s.Nr < until {
		var mk []byte
		s.CKr, mk = kdfCK(s.CKr)
		s.Skipped[skipKey(s.DHr, s.Nr)] = mk
		s.Nr++
		if len(s.Skipped) > maxSkip {
			return ErrSkipTooMany
		}
	}
	return nil
}

func (s *Session) dhRatchet(h Header) error {
	s.PN = s.Ns
	s.Ns = 0
	s.Nr = 0
	s.DHr = append([]byte(nil), h.DH...)

	dhOut, err := dh(s.DHs.Priv, s.DHr)
	if err != nil {
		return err
	}
	s.RK, s.CKr = kdfRK(s.RK, dhOut)

	newDHs, err := GenerateDH()
	if err != nil {
		return err
	}
	s.DHs = newDHs
	dhOut2, err := dh(s.DHs.Priv, s.DHr)
	if err != nil {
		return err
	}
	s.RK, s.CKs = kdfRK(s.RK, dhOut2)
	return nil
}

// ---- small helpers ---------------------------------------------------------

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := range a {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

const hexdig = "0123456789abcdef"

func hexstr(b []byte) string {
	out := make([]byte, len(b)*2)
	for i, c := range b {
		out[i*2] = hexdig[c>>4]
		out[i*2+1] = hexdig[c&0xf]
	}
	return string(out)
}

// RandBytes returns n secure random bytes (exported for callers/tests).
func RandBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return nil, err
	}
	return b, nil
}
