// Package storage holds Quantum Chat's server-side state. The only persistent
// content is ENCRYPTED envelopes and PUBLIC identity records — never plaintext,
// never private keys, never message bodies in the clear.
//
// This file implements the RAM store (default, STORAGE_MODE=ram). It keeps:
//   - registrations:   id -> public-key record
//   - upstream buffers: txid -> partially-reassembled inbound message
//   - recipient queues: recipientID -> pending encrypted messages
//   - replay set:       seen msgIDs within the TTL window
//   - audit ring:       admin/operational events (NO message content)
//
// Durable mode (STORAGE_MODE=postgres) uses the schema in
// migrations/001_quantum_chat_schema.sql via the same Store interface, and is
// implemented in postgres.go (PGStore). RAM mode is the default; both are
// covered by tests (PGStore tests run when QC_TEST_POSTGRES_URL is set).
package storage

import (
	"sync"
	"time"

	"quantumchat/internal/identity"
	"quantumchat/internal/transport"
)

// Store is the backend contract. RAM and (future) Postgres both satisfy it.
type Store interface {
	Register(rec identity.Record) error
	Lookup(id string) (identity.Record, bool)
	Touch(id string)

	// PutChunk buffers an upstream frame. When the message is complete it
	// returns the reassembled (still encrypted) envelope bytes.
	PutChunk(txid string, f *transport.UpstreamFrame, maxBytes int) (complete bool, envelope []byte, err error)

	// Enqueue stores a complete encrypted envelope for a recipient. Returns
	// false if msgID was already seen (replay) and the message is dropped.
	Enqueue(recipientID string, msgID []byte, envelope []byte, ttl time.Duration) (accepted bool)

	// Poll returns a window of downstream frames for the oldest pending message.
	Poll(recipientID string, offset, window int) PollResult

	// Ack deletes a delivered message from a recipient's queue.
	Ack(recipientID, txid string) bool

	Audit(action, detail string)
	AuditTail(n int) []AuditEntry

	Sweep(now time.Time)
	Stats() Stats
}

type PollResult struct {
	Found  bool
	TxID   string
	Total  int      // total downstream frames for this message
	Frames []string // the requested window [offset:offset+window]
}

type AuditEntry struct {
	At     time.Time `json:"at"`
	Action string    `json:"action"`
	Detail string    `json:"detail"`
}

type Stats struct {
	Registrations int `json:"registrations"`
	PendingMsgs   int `json:"pending_messages"`
	UpstreamBufs  int `json:"upstream_buffers"`
}

type pendingMsg struct {
	txid    string
	frames  []string // base64url downstream frames (cached)
	expires time.Time
}

type upstreamBuf struct {
	r       *transport.Reassembler
	expires time.Time
}

type seenMsg struct{ expires time.Time }

// RAMStore is the default in-memory backend.
type RAMStore struct {
	mu        sync.Mutex
	regs      map[string]identity.Record
	queues    map[string][]*pendingMsg
	upstreams map[string]*upstreamBuf
	seen      map[string]seenMsg // key = hex(msgID)
	audit     []AuditEntry
	auditCap  int
	bufTTL    time.Duration
}

func NewRAMStore() *RAMStore {
	return &RAMStore{
		regs:      map[string]identity.Record{},
		queues:    map[string][]*pendingMsg{},
		upstreams: map[string]*upstreamBuf{},
		seen:      map[string]seenMsg{},
		auditCap:  500,
		bufTTL:    5 * time.Minute,
	}
}

func (s *RAMStore) Register(rec identity.Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rec.RegisteredAt.IsZero() {
		rec.RegisteredAt = time.Now()
	}
	rec.LastSeen = time.Now()
	s.regs[rec.ID] = rec
	return nil
}

func (s *RAMStore) Lookup(id string) (identity.Record, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.regs[id]
	return r, ok
}

func (s *RAMStore) Touch(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.regs[id]; ok {
		r.LastSeen = time.Now()
		s.regs[id] = r
	}
}

func (s *RAMStore) PutChunk(txid string, f *transport.UpstreamFrame, maxBytes int) (bool, []byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ub, ok := s.upstreams[txid]
	if !ok {
		ub = &upstreamBuf{r: transport.NewReassembler(maxBytes), expires: time.Now().Add(s.bufTTL)}
		s.upstreams[txid] = ub
	}
	complete, env, err := ub.r.Add(f)
	if err != nil {
		delete(s.upstreams, txid)
		return false, nil, err
	}
	if complete {
		delete(s.upstreams, txid)
	}
	return complete, env, nil
}

func (s *RAMStore) Enqueue(recipientID string, msgID []byte, envelope []byte, ttl time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := hexstr(msgID)
	if _, dup := s.seen[key]; dup {
		return false // replay
	}
	s.seen[key] = seenMsg{expires: time.Now().Add(ttl)}

	frames := transport.EncodeDownstream(envelope, 200)
	txid := key[:12]
	s.queues[recipientID] = append(s.queues[recipientID], &pendingMsg{
		txid:    txid,
		frames:  frames,
		expires: time.Now().Add(ttl),
	})
	return true
}

func (s *RAMStore) Poll(recipientID string, offset, window int) PollResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	q := s.queues[recipientID]
	if len(q) == 0 {
		return PollResult{Found: false}
	}
	m := q[0] // oldest
	if offset < 0 {
		offset = 0
	}
	if window <= 0 {
		window = 1
	}
	end := offset + window
	if offset > len(m.frames) {
		offset = len(m.frames)
	}
	if end > len(m.frames) {
		end = len(m.frames)
	}
	return PollResult{
		Found:  true,
		TxID:   m.txid,
		Total:  len(m.frames),
		Frames: m.frames[offset:end],
	}
}

func (s *RAMStore) Ack(recipientID, txid string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	q := s.queues[recipientID]
	for i, m := range q {
		if m.txid == txid {
			s.queues[recipientID] = append(q[:i], q[i+1:]...)
			if len(s.queues[recipientID]) == 0 {
				delete(s.queues, recipientID)
			}
			return true
		}
	}
	return false
}

func (s *RAMStore) Audit(action, detail string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.audit = append(s.audit, AuditEntry{At: time.Now(), Action: action, Detail: detail})
	if len(s.audit) > s.auditCap {
		s.audit = s.audit[len(s.audit)-s.auditCap:]
	}
}

func (s *RAMStore) AuditTail(n int) []AuditEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n <= 0 || n > len(s.audit) {
		n = len(s.audit)
	}
	out := make([]AuditEntry, n)
	copy(out, s.audit[len(s.audit)-n:])
	return out
}

// Sweep removes expired messages, buffers, and replay markers.
func (s *RAMStore) Sweep(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for rid, q := range s.queues {
		kept := q[:0]
		for _, m := range q {
			if m.expires.After(now) {
				kept = append(kept, m)
			}
		}
		if len(kept) == 0 {
			delete(s.queues, rid)
		} else {
			s.queues[rid] = kept
		}
	}
	for tx, ub := range s.upstreams {
		if !ub.expires.After(now) {
			delete(s.upstreams, tx)
		}
	}
	for k, v := range s.seen {
		if !v.expires.After(now) {
			delete(s.seen, k)
		}
	}
}

func (s *RAMStore) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	pending := 0
	for _, q := range s.queues {
		pending += len(q)
	}
	return Stats{
		Registrations: len(s.regs),
		PendingMsgs:   pending,
		UpstreamBufs:  len(s.upstreams),
	}
}

const hexdigits = "0123456789abcdef"

func hexstr(b []byte) string {
	out := make([]byte, len(b)*2)
	for i, c := range b {
		out[i*2] = hexdigits[c>>4]
		out[i*2+1] = hexdigits[c&0xf]
	}
	return string(out)
}
