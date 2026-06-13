// Package server wires the DNS codec, store, rate limiter, and crypto-aware
// routing into an authoritative responder for the Quantum Chat zone.
//
// Action labels (immediately left of the zone):
//   s  send     <data...>.<seq>.<total>.<txid>.s.<zone>     -> buffer/enqueue
//   r  register <data...>.<seq>.<total>.<txid>.r.<zone>     -> publish public keys
//   p  poll     <rnd>.<offset>.<recipientID>.p.<zone>       -> fetch message window
//   a  ack      <rnd>.<txid>.<recipientID>.a.<zone>         -> delete delivered
//   k  key      <rnd>.<targetID>.k.<zone>                   -> public-key lookup
// Zone apex SOA/NS/A answer delegation + health probes.
package server

import (
	"crypto/ed25519"
	"net"
	"strconv"
	"strings"
	"time"

	"quantumchat/internal/dnswire"
	"quantumchat/internal/identity"
	"quantumchat/internal/ratelimit"
	"quantumchat/internal/storage"
	"quantumchat/internal/transport"
)

type Config struct {
	Zone          string        // e.g. "qc.example.com"
	NSNames       []string      // delegated nameserver hostnames for apex NS
	SelfIP        net.IP        // apex A record / glue
	AdminRName    string        // SOA RName (email as dotted name), e.g. "admin.qc.example.com"
	MaxMessageLen int           // QUANTUM_CHAT_MAX_MESSAGE_SIZE
	MessageTTL    time.Duration // QUANTUM_CHAT_MESSAGE_TTL_MINUTES
	Logs          bool
}

type Server struct {
	cfg     Config
	store   storage.Store
	lim     *ratelimit.Limiter
	zoneDot string
	serial  uint32
}

func New(cfg Config, store storage.Store, lim *ratelimit.Limiter) *Server {
	return &Server{
		cfg:     cfg,
		store:   store,
		lim:     lim,
		zoneDot: strings.ToLower(strings.TrimSuffix(cfg.Zone, ".")),
		serial:  uint32(time.Now().Unix()),
	}
}

// Handle processes one raw query and returns one raw response.
func (s *Server) Handle(query []byte, clientIP string) []byte {
	q, err := dnswire.Parse(query)
	if err != nil {
		return nil // drop malformed
	}
	adv := uint16(1232)
	if q.HasOPT && q.UDPSize > 0 && q.UDPSize < adv {
		if q.UDPSize < 512 {
			adv = 512
		} else {
			adv = q.UDPSize
		}
	}
	resp := &dnswire.Response{AA: true, AdvUDPSize: adv}

	name := q.QName
	if name == s.zoneDot {
		s.answerApex(q, resp)
		return s.build(q, resp)
	}
	if !strings.HasSuffix(name, "."+s.zoneDot) {
		resp.Rcode = dnswire.RcodeRefused
		return s.build(q, resp)
	}

	// Rate limit by client IP (cheap DoS/abuse guard; full abuse model in docs).
	if !s.lim.Allow(clientIP) {
		resp.Rcode = dnswire.RcodeRefused
		return s.build(q, resp)
	}

	labels := strings.Split(strings.TrimSuffix(name, "."+s.zoneDot), ".")
	action := labels[len(labels)-1]

	switch action {
	case "s", "r":
		s.handleUpstream(q, resp, action)
	case "p":
		s.handlePoll(q, resp, labels)
	case "a":
		s.handleAck(q, resp, labels)
	case "k":
		s.handleKeyLookup(q, resp, labels)
	default:
		resp.Rcode = dnswire.RcodeNXDomain
	}
	return s.build(q, resp)
}

func (s *Server) txt(resp *dnswire.Response, q *dnswire.Msg, strs []string) {
	resp.Answers = append(resp.Answers, dnswire.RR{
		Name: q.QName, Type: dnswire.TypeTXT, Class: dnswire.ClassINET, TTL: 0, TXT: strs,
	})
}

func (s *Server) handleUpstream(q *dnswire.Msg, resp *dnswire.Response, action string) {
	f, act, err := transport.ParseUpstreamName(q.QName, s.cfg.Zone)
	if err != nil || act != action {
		resp.Rcode = dnswire.RcodeFormErr
		return
	}
	complete, payload, err := s.store.PutChunk(f.TxID, f, s.cfg.MaxMessageLen)
	if err != nil {
		s.txt(resp, q, []string{"ERR " + err.Error()})
		return
	}
	if !complete {
		s.txt(resp, q, []string{"OK " + strconv.Itoa(f.Seq)})
		return
	}
	if action == "r" {
		s.completeRegister(q, resp, payload)
		return
	}
	// send: parse envelope, enqueue for recipient (replay-checked)
	env, err := transport.ParseEnvelope(payload)
	if err != nil || !identity.ValidID(env.SenderID) || !identity.ValidID(env.RecipientID) {
		s.txt(resp, q, []string{"ERR envelope"})
		return
	}
	accepted := s.store.Enqueue(env.RecipientID, env.MsgID, payload, s.cfg.MessageTTL)
	if !accepted {
		s.txt(resp, q, []string{"DUP " + f.TxID})
		return
	}
	if s.cfg.Logs {
		s.store.Audit("enqueue", "to="+env.RecipientID+" txid="+f.TxID)
	}
	s.txt(resp, q, []string{"DONE " + f.TxID})
}

func (s *Server) completeRegister(q *dnswire.Msg, resp *dnswire.Response, payload []byte) {
	// payload = signPub(32) || dhPub(32) || sig(64)
	if len(payload) != 128 {
		s.txt(resp, q, []string{"ERR reg-len"})
		return
	}
	signPub := payload[0:32]
	dhPub := payload[32:64]
	sig := payload[64:128]
	id, err := identity.DeriveID(signPub, dhPub)
	if err != nil {
		s.txt(resp, q, []string{"ERR keys"})
		return
	}
	// Self-signature proves control of the signing key over the derived ID.
	if !ed25519.Verify(ed25519.PublicKey(signPub), []byte("qc-reg/v1"+id), sig) {
		s.txt(resp, q, []string{"ERR sig"})
		return
	}
	// If already registered to different keys -> reject (collision/impersonation).
	if existing, ok := s.store.Lookup(id); ok {
		if string(existing.SignPub) != string(signPub) || string(existing.DHPub) != string(dhPub) {
			s.txt(resp, q, []string{"ERR conflict"})
			return
		}
	}
	_ = s.store.Register(identity.Record{ID: id, SignPub: append([]byte(nil), signPub...), DHPub: append([]byte(nil), dhPub...)})
	if s.cfg.Logs {
		s.store.Audit("register", "id="+id)
	}
	s.txt(resp, q, []string{"OK " + id})
}

func (s *Server) handlePoll(q *dnswire.Msg, resp *dnswire.Response, labels []string) {
	// <rnd>.<offset>.<recipientID>.p
	if len(labels) < 4 {
		resp.Rcode = dnswire.RcodeFormErr
		return
	}
	rid := identity.NormalizeID(labels[len(labels)-2])
	offset, _ := strconv.Atoi(labels[len(labels)-3])
	if !identity.ValidID(rid) {
		resp.Rcode = dnswire.RcodeFormErr
		return
	}
	s.store.Touch(rid)
	pr := s.store.Poll(rid, offset, 64)
	if !pr.Found {
		s.txt(resp, q, []string{"v1 - 0 0 0"})
		return
	}
	// Trim frames so the whole response fits the advertised UDP size.
	header := "v1 " + pr.TxID + " " + strconv.Itoa(pr.Total) + " " + strconv.Itoa(offset) + " "
	budget := int(resp.AdvUDPSize) - len(q.QName) - 80
	strs := []string{""} // header placeholder
	size := len(header) + 4
	count := 0
	for _, fr := range pr.Frames {
		if size+len(fr)+1 > budget {
			break
		}
		strs = append(strs, fr)
		size += len(fr) + 1
		count++
	}
	strs[0] = header + strconv.Itoa(count)
	s.txt(resp, q, strs)
}

func (s *Server) handleAck(q *dnswire.Msg, resp *dnswire.Response, labels []string) {
	// <rnd>.<txid>.<recipientID>.a
	if len(labels) < 4 {
		resp.Rcode = dnswire.RcodeFormErr
		return
	}
	rid := identity.NormalizeID(labels[len(labels)-2])
	txid := labels[len(labels)-3]
	if s.store.Ack(rid, txid) {
		s.txt(resp, q, []string{"OK"})
	} else {
		s.txt(resp, q, []string{"NF"})
	}
}

func (s *Server) handleKeyLookup(q *dnswire.Msg, resp *dnswire.Response, labels []string) {
	// <rnd>.<targetID>.k
	if len(labels) < 3 {
		resp.Rcode = dnswire.RcodeFormErr
		return
	}
	tid := identity.NormalizeID(labels[len(labels)-2])
	rec, ok := s.store.Lookup(tid)
	if !ok {
		s.txt(resp, q, []string{"NF"})
		return
	}
	keys := append(append([]byte(nil), rec.SignPub...), rec.DHPub...)
	s.txt(resp, q, transport.EncodeDownstream(keys, 200))
}

func (s *Server) answerApex(q *dnswire.Msg, resp *dnswire.Response) {
	switch q.QType {
	case dnswire.TypeSOA, 255 /*ANY*/ :
		resp.Answers = append(resp.Answers, s.soa())
	case dnswire.TypeNS:
		for _, ns := range s.cfg.NSNames {
			resp.Answers = append(resp.Answers, dnswire.RR{Name: s.zoneDot, Type: dnswire.TypeNS, Class: dnswire.ClassINET, TTL: 3600, NS: ns})
		}
	case dnswire.TypeA:
		if s.cfg.SelfIP != nil {
			var a [4]byte
			copy(a[:], s.cfg.SelfIP.To4())
			resp.Answers = append(resp.Answers, dnswire.RR{Name: s.zoneDot, Type: dnswire.TypeA, Class: dnswire.ClassINET, TTL: 300, A: a})
		}
	default:
		// authoritative empty answer with SOA in authority
		resp.Authority = append(resp.Authority, s.soa())
	}
}

func (s *Server) soa() dnswire.RR {
	mname := s.zoneDot
	if len(s.cfg.NSNames) > 0 {
		mname = s.cfg.NSNames[0]
	}
	rname := s.cfg.AdminRName
	if rname == "" {
		rname = "admin." + s.zoneDot
	}
	return dnswire.RR{
		Name: s.zoneDot, Type: dnswire.TypeSOA, Class: dnswire.ClassINET, TTL: 300,
		SOA: &dnswire.SOA{MName: mname, RName: rname, Serial: s.serial, Refresh: 7200, Retry: 3600, Expire: 1209600, Min: 60},
	}
}

func (s *Server) build(q *dnswire.Msg, resp *dnswire.Response) []byte {
	out, err := dnswire.Build(q, resp)
	if err != nil {
		fail := &dnswire.Response{AA: true, Rcode: dnswire.RcodeServFail}
		out, _ = dnswire.Build(q, fail)
	}
	return out
}

// ---- listeners -------------------------------------------------------------

// ListenUDP serves DNS over UDP until the connection is closed.
func (s *Server) ListenUDP(conn *net.UDPConn) error {
	buf := make([]byte, 4096)
	for {
		n, addr, err := conn.ReadFromUDP(buf)
		if err != nil {
			return err
		}
		req := append([]byte(nil), buf[:n]...)
		ip := addr.IP.String()
		go func() {
			resp := s.Handle(req, ip)
			if resp != nil {
				_, _ = conn.WriteToUDP(resp, addr)
			}
		}()
	}
}

// ListenTCP serves DNS over TCP (2-byte length-prefixed messages).
func (s *Server) ListenTCP(ln *net.TCPListener) error {
	for {
		c, err := ln.AcceptTCP()
		if err != nil {
			return err
		}
		go s.serveTCPConn(c)
	}
}

func (s *Server) serveTCPConn(c *net.TCPConn) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	var lenbuf [2]byte
	if _, err := readFull(c, lenbuf[:]); err != nil {
		return
	}
	msgLen := int(lenbuf[0])<<8 | int(lenbuf[1])
	if msgLen == 0 || msgLen > 65535 {
		return
	}
	msg := make([]byte, msgLen)
	if _, err := readFull(c, msg); err != nil {
		return
	}
	ip, _, _ := net.SplitHostPort(c.RemoteAddr().String())
	resp := s.Handle(msg, ip)
	if resp == nil {
		return
	}
	out := make([]byte, 2+len(resp))
	out[0] = byte(len(resp) >> 8)
	out[1] = byte(len(resp))
	copy(out[2:], resp)
	_, _ = c.Write(out)
}

func readFull(c net.Conn, b []byte) (int, error) {
	got := 0
	for got < len(b) {
		n, err := c.Read(b[got:])
		if err != nil {
			return got, err
		}
		got += n
	}
	return got, nil
}
