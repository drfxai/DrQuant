// Package transport handles framing Quantum Chat envelopes for DNS carriage.
//
// Two directions, two encodings:
//
//   UPSTREAM (client -> authoritative server), data rides in the QNAME:
//     <d0>.<d1>...<dk>.<seq>.<total>.<txid>.s.<zone>
//   Data labels use Crockford Base32 (DNS-label-safe, case-insensitive).
//   The recipient ID is NOT in the name — the server learns it only after
//   reassembling and parsing the envelope, minimising on-path metadata.
//
//   DOWNSTREAM (server -> client), data rides in TXT character-strings,
//   Base64URL-encoded, sized to fit an EDNS0 UDP response.
//
// DNS limits respected: label <= 63 bytes, total name <= 255 bytes.
package transport

import (
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"quantumchat/internal/crypto"
)

var (
	ErrShort      = errors.New("quantum-chat/transport: short buffer")
	ErrBadName    = errors.New("quantum-chat/transport: malformed query name")
	ErrBadFrame   = errors.New("quantum-chat/transport: bad frame")
	ErrTooBig     = errors.New("quantum-chat/transport: message exceeds max size")
	ErrIncomplete = errors.New("quantum-chat/transport: message incomplete")
)

// Crockford base32, no padding, lower-cased for shorter/uniform DNS labels.
var b32 = base32.NewEncoding("0123456789abcdefghjkmnpqrstvwxyz").WithPadding(base32.NoPadding)

// Base64URL, no padding, for TXT payloads.
var b64 = base64.RawURLEncoding

const (
	maxLabel       = 63
	maxName        = 255
	actionSend     = "s"
	dataLabelChars = 60 // <=63; leaves slack
)

// ---- envelope serialization ----------------------------------------------
//
// Fixed layout (big-endian lengths):
//   ver(1) senderID(20) recipientID(20) msgID(16) ephPub(32) nonce(12)
//   ctLen(2) ct(N) sig(64)

const envFixed = 1 + 20 + 20 + 16 + 32 + 12 + 2 + 64

// SerializeEnvelope encodes an envelope to bytes for chunking.
func SerializeEnvelope(e *crypto.Envelope) ([]byte, error) {
	if len(e.SenderID) != 20 || len(e.RecipientID) != 20 ||
		len(e.MsgID) != 16 || len(e.EphemeralPub) != 32 ||
		len(e.Nonce) != 12 || len(e.Sig) != 64 {
		return nil, ErrBadFrame
	}
	out := make([]byte, 0, envFixed+len(e.Ciphertext))
	out = append(out, e.Version)
	out = append(out, e.SenderID...)
	out = append(out, e.RecipientID...)
	out = append(out, e.MsgID...)
	out = append(out, e.EphemeralPub...)
	out = append(out, e.Nonce...)
	var l [2]byte
	binary.BigEndian.PutUint16(l[:], uint16(len(e.Ciphertext)))
	out = append(out, l[:]...)
	out = append(out, e.Ciphertext...)
	out = append(out, e.Sig...)
	return out, nil
}

// ParseEnvelope is the inverse of SerializeEnvelope.
func ParseEnvelope(b []byte) (*crypto.Envelope, error) {
	if len(b) < envFixed {
		return nil, ErrShort
	}
	p := 0
	rd := func(n int) []byte { s := b[p : p+n]; p += n; return s }
	e := &crypto.Envelope{}
	e.Version = b[p]
	p++
	e.SenderID = string(rd(20))
	e.RecipientID = string(rd(20))
	e.MsgID = append([]byte(nil), rd(16)...)
	e.EphemeralPub = append([]byte(nil), rd(32)...)
	e.Nonce = append([]byte(nil), rd(12)...)
	ctLen := int(binary.BigEndian.Uint16(rd(2)))
	if p+ctLen+64 != len(b) {
		return nil, ErrBadFrame
	}
	e.Ciphertext = append([]byte(nil), rd(ctLen)...)
	e.Sig = append([]byte(nil), rd(64)...)
	return e, nil
}

// ---- upstream (QNAME) chunking --------------------------------------------

// bytesPerChunk computes how many raw bytes fit in one upstream query given the
// zone length, leaving room for the structural labels.
func bytesPerChunk(zone string) int {
	// structural overhead: ".<seq>.<total>.<txid>.s." + zone + dots between
	// data labels. Be conservative: reserve 60 bytes of name budget for
	// structure, the rest for data labels.
	budget := maxName - len(dns_fqdn("", "", 0, 0, actionSend, zone)) - 8
	if budget < dataLabelChars {
		budget = dataLabelChars
	}
	// number of full data labels that fit
	labels := budget / (dataLabelChars + 1)
	if labels < 1 {
		labels = 1
	}
	b32CharsTotal := labels * dataLabelChars
	rawBytes := b32CharsTotal * 5 / 8
	if rawBytes < 8 {
		rawBytes = 8
	}
	return rawBytes
}

// ChunkUpstream splits data into a sequence of fully-qualified query names.
// txid groups the chunks of one message; action is "s" (send) or "r" (register).
func ChunkUpstream(txid, zone string, data []byte, action string) ([]string, error) {
	per := bytesPerChunk(zone)
	total := (len(data) + per - 1) / per
	if total == 0 {
		total = 1
	}
	if total > 9999 {
		return nil, ErrTooBig
	}
	names := make([]string, 0, total)
	for seq := 0; seq < total; seq++ {
		start := seq * per
		end := start + per
		if end > len(data) {
			end = len(data)
		}
		name := dns_fqdn(b32.EncodeToString(data[start:end]), txid, seq, total, action, zone)
		if len(name) > maxName {
			return nil, ErrTooBig
		}
		names = append(names, name)
	}
	return names, nil
}

// dns_fqdn builds the upstream query name, splitting the base32 data string
// into <=63-char labels.
func dns_fqdn(b32data, txid string, seq, total int, action, zone string) string {
	var sb strings.Builder
	for i := 0; i < len(b32data); i += maxLabel {
		end := i + maxLabel
		if end > len(b32data) {
			end = len(b32data)
		}
		sb.WriteString(b32data[i:end])
		sb.WriteByte('.')
	}
	sb.WriteString(strconv.Itoa(seq))
	sb.WriteByte('.')
	sb.WriteString(strconv.Itoa(total))
	sb.WriteByte('.')
	sb.WriteString(txid)
	sb.WriteByte('.')
	sb.WriteString(action)
	sb.WriteByte('.')
	sb.WriteString(strings.TrimSuffix(zone, "."))
	return sb.String()
}

// UpstreamFrame is one decoded upstream chunk.
type UpstreamFrame struct {
	TxID  string
	Seq   int
	Total int
	Data  []byte
}

// ParseUpstreamName decodes a chunked upstream query name relative to zone and
// returns the decoded frame plus its action label ("s" send, "r" register).
func ParseUpstreamName(qname, zone string) (*UpstreamFrame, string, error) {
	lz := "." + strings.ToLower(strings.TrimSuffix(zone, "."))
	low := strings.ToLower(strings.TrimSuffix(qname, "."))
	if !strings.HasSuffix(low, lz) {
		return nil, "", ErrBadName
	}
	name := strings.TrimSuffix(low, lz)
	labels := strings.Split(name, ".")
	if len(labels) < 5 { // >=1 data + seq,total,txid,action
		return nil, "", ErrBadName
	}
	n := len(labels)
	action := labels[n-1]
	txid := labels[n-2]
	total, err1 := strconv.Atoi(labels[n-3])
	seq, err2 := strconv.Atoi(labels[n-4])
	if err1 != nil || err2 != nil || total <= 0 || seq < 0 || seq >= total {
		return nil, "", ErrBadFrame
	}
	dataB32 := strings.Join(labels[:n-4], "")
	data, err := b32.DecodeString(dataB32)
	if err != nil {
		return nil, "", ErrBadFrame
	}
	return &UpstreamFrame{TxID: txid, Seq: seq, Total: total, Data: data}, action, nil
}

// ---- reassembly ------------------------------------------------------------

// Reassembler collects upstream frames for one txid until complete.
type Reassembler struct {
	total int
	parts map[int][]byte
	size  int
	max   int
}

func NewReassembler(maxBytes int) *Reassembler {
	return &Reassembler{parts: map[int][]byte{}, max: maxBytes}
}

// Add ingests a frame. Returns (complete, assembledBytes, error).
func (r *Reassembler) Add(f *UpstreamFrame) (bool, []byte, error) {
	if r.total == 0 {
		r.total = f.Total
	} else if r.total != f.Total {
		return false, nil, ErrBadFrame
	}
	if _, dup := r.parts[f.Seq]; !dup {
		r.size += len(f.Data)
		if r.max > 0 && r.size > r.max {
			return false, nil, ErrTooBig
		}
		r.parts[f.Seq] = f.Data
	}
	if len(r.parts) < r.total {
		return false, nil, nil
	}
	out := make([]byte, 0, r.size)
	for i := 0; i < r.total; i++ {
		b, ok := r.parts[i]
		if !ok {
			return false, nil, ErrIncomplete
		}
		out = append(out, b...)
	}
	return true, out, nil
}

// ---- downstream (TXT) encoding --------------------------------------------

// EncodeDownstream splits data into base64url strings no longer than maxStr.
func EncodeDownstream(data []byte, maxStr int) []string {
	if maxStr <= 0 || maxStr > 255 {
		maxStr = 200
	}
	rawPer := maxStr * 6 / 8 // base64 expands 3->4
	if rawPer < 1 {
		rawPer = 1
	}
	var out []string
	for i := 0; i < len(data); i += rawPer {
		end := i + rawPer
		if end > len(data) {
			end = len(data)
		}
		out = append(out, b64.EncodeToString(data[i:end]))
	}
	if len(out) == 0 {
		out = []string{""}
	}
	return out
}

// DecodeDownstream concatenates and decodes base64url TXT strings.
func DecodeDownstream(strs []string) ([]byte, error) {
	var sb strings.Builder
	for _, s := range strs {
		sb.WriteString(s)
	}
	return b64.DecodeString(sb.String())
}

// NewTxID returns a short random transaction id (hex) for grouping chunks.
func NewTxID() (string, error) {
	b, err := crypto.RandBytes(6)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", b), nil
}
