// Package dnswire is a minimal authoritative-side DNS message codec, built on
// encoding/binary only. It parses inbound queries and builds responses for the
// narrow record set Quantum Chat needs (TXT, A, NS, SOA) plus EDNS0(OPT).
//
// This is deliberately small and auditable rather than a full RFC stack. It
// handles name compression on PARSE (defensive) and emits uncompressed names on
// BUILD. For exhaustive RFC edge-case coverage in very hostile resolver
// environments, an operator may swap this for github.com/miekg/dns behind the
// same Server interface — see docs/architecture.md.
package dnswire

import (
	"encoding/binary"
	"errors"
	"strings"
)

const (
	TypeA   = 1
	TypeNS  = 2
	TypeSOA = 6
	TypeTXT = 16
	TypeOPT = 41

	ClassINET = 1

	// Response codes
	RcodeSuccess  = 0
	RcodeFormErr  = 1
	RcodeServFail = 2
	RcodeNXDomain = 3
	RcodeRefused  = 5
)

var (
	ErrFormat = errors.New("dnswire: malformed message")
	ErrName   = errors.New("dnswire: malformed name")
)

// Msg is a decoded query (enough fields for an authoritative responder).
type Msg struct {
	ID      uint16
	RD      bool   // recursion desired (echoed back)
	QName   string // lower-cased, trailing dot stripped
	QType   uint16
	QClass  uint16
	UDPSize uint16 // EDNS0 advertised size, 0 if no OPT
	HasOPT  bool
}

// RR is a resource record to emit in a response.
type RR struct {
	Name  string
	Type  uint16
	Class uint16
	TTL   uint32
	// exactly one of the following is used based on Type:
	TXT []string // TypeTXT
	A   [4]byte  // TypeA
	NS  string   // TypeNS
	SOA *SOA     // TypeSOA
}

type SOA struct {
	MName, RName                        string
	Serial, Refresh, Retry, Expire, Min uint32
}

// Parse decodes a query message. Only the first question is read.
func Parse(buf []byte) (*Msg, error) {
	if len(buf) < 12 {
		return nil, ErrFormat
	}
	m := &Msg{}
	m.ID = binary.BigEndian.Uint16(buf[0:2])
	flags := binary.BigEndian.Uint16(buf[2:4])
	m.RD = flags&0x0100 != 0
	qd := binary.BigEndian.Uint16(buf[4:6])
	an := binary.BigEndian.Uint16(buf[6:8])
	ns := binary.BigEndian.Uint16(buf[8:10])
	ar := binary.BigEndian.Uint16(buf[10:12])
	if qd < 1 {
		return nil, ErrFormat
	}
	off := 12
	name, n, err := readName(buf, off)
	if err != nil {
		return nil, err
	}
	off = n
	if off+4 > len(buf) {
		return nil, ErrFormat
	}
	m.QType = binary.BigEndian.Uint16(buf[off : off+2])
	m.QClass = binary.BigEndian.Uint16(buf[off+2 : off+4])
	off += 4
	m.QName = strings.ToLower(strings.TrimSuffix(name, "."))

	// Skip remaining questions (rare) to reach additional for EDNS0.
	for i := uint16(1); i < qd; i++ {
		_, n2, err := readName(buf, off)
		if err != nil {
			return m, nil
		}
		off = n2 + 4
	}
	// Skip answer + authority RRs (none expected in a query, but be safe).
	for i := uint16(0); i < an+ns; i++ {
		off, err = skipRR(buf, off)
		if err != nil {
			return m, nil
		}
	}
	// Scan additional for OPT (EDNS0).
	for i := uint16(0); i < ar; i++ {
		nameStart := off
		_, n3, err := readName(buf, off)
		if err != nil {
			return m, nil
		}
		if n3+10 > len(buf) {
			return m, nil
		}
		typ := binary.BigEndian.Uint16(buf[n3 : n3+2])
		if typ == TypeOPT {
			m.HasOPT = true
			m.UDPSize = binary.BigEndian.Uint16(buf[n3+2 : n3+4]) // class field = UDP size
		}
		var err2 error
		off, err2 = skipRR(buf, nameStart)
		if err2 != nil {
			return m, nil
		}
	}
	return m, nil
}

// BuildResponse assembles an answer for query q.
type Response struct {
	Rcode      int
	AA         bool
	Answers    []RR
	Authority  []RR
	AdvUDPSize uint16 // if >0, emit an OPT record advertising this size
}

func Build(q *Msg, r *Response) ([]byte, error) {
	var b []byte
	hdr := make([]byte, 12)
	binary.BigEndian.PutUint16(hdr[0:2], q.ID)
	var flags uint16 = 0x8000 // QR
	if r.AA {
		flags |= 0x0400
	}
	if q.RD {
		flags |= 0x0100 // echo RD
	}
	flags |= uint16(r.Rcode & 0x0F)
	binary.BigEndian.PutUint16(hdr[2:4], flags)
	binary.BigEndian.PutUint16(hdr[4:6], 1) // QDCOUNT
	binary.BigEndian.PutUint16(hdr[6:8], uint16(len(r.Answers)))
	binary.BigEndian.PutUint16(hdr[8:10], uint16(len(r.Authority)))
	arCount := 0
	if r.AdvUDPSize > 0 {
		arCount = 1
	}
	binary.BigEndian.PutUint16(hdr[10:12], uint16(arCount))
	b = append(b, hdr...)

	// Question
	qn, err := writeName(q.QName)
	if err != nil {
		return nil, err
	}
	b = append(b, qn...)
	var qt [4]byte
	binary.BigEndian.PutUint16(qt[0:2], q.QType)
	binary.BigEndian.PutUint16(qt[2:4], q.QClass)
	b = append(b, qt[:]...)

	for _, rr := range r.Answers {
		enc, err := writeRR(rr)
		if err != nil {
			return nil, err
		}
		b = append(b, enc...)
	}
	for _, rr := range r.Authority {
		enc, err := writeRR(rr)
		if err != nil {
			return nil, err
		}
		b = append(b, enc...)
	}
	if r.AdvUDPSize > 0 {
		// OPT: root name, type 41, class = UDP size, ttl 0, rdlen 0
		opt := []byte{0x00}
		var t [10]byte
		binary.BigEndian.PutUint16(t[0:2], TypeOPT)
		binary.BigEndian.PutUint16(t[2:4], r.AdvUDPSize)
		// ttl (4 bytes) = 0; rdlen (2 bytes) = 0
		opt = append(opt, t[:]...)
		b = append(b, opt...)
	}
	return b, nil
}

// --- name codec -------------------------------------------------------------

func readName(buf []byte, off int) (string, int, error) {
	var labels []string
	jumped := false
	origNext := off
	steps := 0
	for {
		if off >= len(buf) {
			return "", 0, ErrName
		}
		l := int(buf[off])
		if l == 0 {
			off++
			if !jumped {
				origNext = off
			}
			break
		}
		if l&0xC0 == 0xC0 { // compression pointer
			if off+1 >= len(buf) {
				return "", 0, ErrName
			}
			ptr := int(binary.BigEndian.Uint16(buf[off:off+2]) & 0x3FFF)
			if !jumped {
				origNext = off + 2
			}
			off = ptr
			jumped = true
			steps++
			if steps > 64 {
				return "", 0, ErrName
			}
			continue
		}
		if l > 63 || off+1+l > len(buf) {
			return "", 0, ErrName
		}
		labels = append(labels, string(buf[off+1:off+1+l]))
		off += 1 + l
	}
	return strings.Join(labels, "."), origNext, nil
}

func writeName(name string) ([]byte, error) {
	name = strings.TrimSuffix(name, ".")
	var b []byte
	if name != "" {
		for _, label := range strings.Split(name, ".") {
			if len(label) > 63 {
				return nil, ErrName
			}
			b = append(b, byte(len(label)))
			b = append(b, label...)
		}
	}
	b = append(b, 0x00)
	return b, nil
}

func skipRR(buf []byte, off int) (int, error) {
	_, n, err := readName(buf, off)
	if err != nil {
		return 0, err
	}
	if n+10 > len(buf) {
		return 0, ErrFormat
	}
	rdlen := int(binary.BigEndian.Uint16(buf[n+8 : n+10]))
	end := n + 10 + rdlen
	if end > len(buf) {
		return 0, ErrFormat
	}
	return end, nil
}

func writeRR(rr RR) ([]byte, error) {
	name, err := writeName(rr.Name)
	if err != nil {
		return nil, err
	}
	var rdata []byte
	switch rr.Type {
	case TypeTXT:
		for _, s := range rr.TXT {
			if len(s) > 255 {
				s = s[:255]
			}
			rdata = append(rdata, byte(len(s)))
			rdata = append(rdata, s...)
		}
		if len(rdata) == 0 {
			rdata = []byte{0x00}
		}
	case TypeA:
		rdata = append(rdata, rr.A[:]...)
	case TypeNS:
		n, err := writeName(rr.NS)
		if err != nil {
			return nil, err
		}
		rdata = n
	case TypeSOA:
		if rr.SOA == nil {
			return nil, ErrFormat
		}
		mn, err := writeName(rr.SOA.MName)
		if err != nil {
			return nil, err
		}
		rn, err := writeName(rr.SOA.RName)
		if err != nil {
			return nil, err
		}
		rdata = append(rdata, mn...)
		rdata = append(rdata, rn...)
		var nums [20]byte
		binary.BigEndian.PutUint32(nums[0:4], rr.SOA.Serial)
		binary.BigEndian.PutUint32(nums[4:8], rr.SOA.Refresh)
		binary.BigEndian.PutUint32(nums[8:12], rr.SOA.Retry)
		binary.BigEndian.PutUint32(nums[12:16], rr.SOA.Expire)
		binary.BigEndian.PutUint32(nums[16:20], rr.SOA.Min)
		rdata = append(rdata, nums[:]...)
	default:
		return nil, ErrFormat
	}

	out := name
	var meta [10]byte
	binary.BigEndian.PutUint16(meta[0:2], rr.Type)
	binary.BigEndian.PutUint16(meta[2:4], rr.Class)
	binary.BigEndian.PutUint32(meta[4:8], rr.TTL)
	binary.BigEndian.PutUint16(meta[8:10], uint16(len(rdata)))
	out = append(out, meta[:]...)
	out = append(out, rdata...)
	return out, nil
}

// ParseTXTResponse extracts the ordered list of TXT character-strings from all
// answer records of a response message. Preserves character-string boundaries
// (so a single TXT RR carrying [header, frame, frame] yields three elements).
// Reusable by the native client.
func ParseTXTResponse(buf []byte) ([]string, error) {
	if len(buf) < 12 {
		return nil, ErrFormat
	}
	qd := binary.BigEndian.Uint16(buf[4:6])
	an := binary.BigEndian.Uint16(buf[6:8])
	off := 12
	for i := uint16(0); i < qd; i++ {
		_, n, err := readName(buf, off)
		if err != nil {
			return nil, err
		}
		off = n + 4
	}
	var out []string
	for i := uint16(0); i < an; i++ {
		_, n, err := readName(buf, off)
		if err != nil {
			return nil, err
		}
		if n+10 > len(buf) {
			return nil, ErrFormat
		}
		typ := binary.BigEndian.Uint16(buf[n : n+2])
		rdlen := int(binary.BigEndian.Uint16(buf[n+8 : n+10]))
		rd := n + 10
		if rd+rdlen > len(buf) {
			return nil, ErrFormat
		}
		if typ == TypeTXT {
			p := rd
			for p < rd+rdlen {
				slen := int(buf[p])
				p++
				if p+slen > rd+rdlen {
					return nil, ErrFormat
				}
				out = append(out, string(buf[p:p+slen]))
				p += slen
			}
		}
		off = rd + rdlen
	}
	return out, nil
}

// Rcode of a response message (for tests/clients).
func Rcode(buf []byte) int {
	if len(buf) < 4 {
		return -1
	}
	return int(binary.BigEndian.Uint16(buf[2:4]) & 0x0F)
}
