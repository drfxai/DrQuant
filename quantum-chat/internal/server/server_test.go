package server

import (
	"context"
	"crypto/ed25519"
	"encoding/binary"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"quantumchat/internal/crypto"
	"quantumchat/internal/dnswire"
	"quantumchat/internal/identity"
	"quantumchat/internal/ratelimit"
	"quantumchat/internal/storage"
	"quantumchat/internal/transport"
)

const testZone = "qc.example.com"

func newServerWithStore(st storage.Store) *Server {
	cfg := Config{
		Zone:          testZone,
		NSNames:       []string{"ns1.qc.example.com"},
		SelfIP:        net.ParseIP("203.0.113.10"),
		MaxMessageLen: 8192,
		MessageTTL:    time.Hour,
		Logs:          false,
	}
	return New(cfg, st, ratelimit.New(100000))
}

func newServer() *Server { return newServerWithStore(storage.NewRAMStore()) }

func buildQuery(name string, qtype uint16, id uint16) []byte {
	var b []byte
	hdr := make([]byte, 12)
	binary.BigEndian.PutUint16(hdr[0:2], id)
	binary.BigEndian.PutUint16(hdr[2:4], 0x0100)
	binary.BigEndian.PutUint16(hdr[4:6], 1)
	b = append(b, hdr...)
	for _, label := range strings.Split(strings.TrimSuffix(name, "."), ".") {
		b = append(b, byte(len(label)))
		b = append(b, label...)
	}
	b = append(b, 0x00)
	var qt [4]byte
	binary.BigEndian.PutUint16(qt[0:2], qtype)
	binary.BigEndian.PutUint16(qt[2:4], 1)
	b = append(b, qt[:]...)
	return b
}

func txtOf(t *testing.T, s *Server, name string) []string {
	t.Helper()
	resp := s.Handle(buildQuery(name, dnswire.TypeTXT, 1), "198.51.100.5")
	strs, err := dnswire.ParseTXTResponse(resp)
	if err != nil {
		t.Fatalf("parse response for %s: %v", name, err)
	}
	return strs
}

func registerOverDNS(t *testing.T, s *Server, id *crypto.Identity) string {
	t.Helper()
	uid, _ := identity.DeriveID(id.SignPub, id.DHPub.Bytes())
	sig := ed25519.Sign(id.SignPriv, []byte("qc-reg/v1"+uid))
	payload := append(append(append([]byte(nil), id.SignPub...), id.DHPub.Bytes()...), sig...)
	names, err := transport.ChunkUpstream("reg"+uid[:5], testZone, payload, "r")
	if err != nil {
		t.Fatal(err)
	}
	var last []string
	for _, n := range names {
		last = txtOf(t, s, n)
	}
	if len(last) == 0 || !strings.HasPrefix(last[0], "OK ") {
		t.Fatalf("register failed: %v", last)
	}
	return uid
}

// runPipeline exercises register -> key lookup -> seal -> chunked DNS upload ->
// poll/paging -> reassemble -> decrypt -> ack against whatever store backs s.
func runPipeline(t *testing.T, s *Server) {
	alice, _ := crypto.GenerateIdentity()
	bob, _ := crypto.GenerateIdentity()
	aliceID := registerOverDNS(t, s, alice)
	bobID := registerOverDNS(t, s, bob)

	look := txtOf(t, s, "rnd1."+bobID+".k."+testZone)
	keyBytes, err := transport.DecodeDownstream(look)
	if err != nil || len(keyBytes) != 64 {
		t.Fatalf("key lookup decode: %v len=%d", err, len(keyBytes))
	}
	bobSign, bobDH := keyBytes[:32], keyBytes[32:]
	if err := identity.VerifyID(bobID, bobSign, bobDH); err != nil {
		t.Fatalf("bob ID not self-certifying: %v", err)
	}

	plaintext := []byte("the bridge is the rendezvous; bring the documents")
	msgID, _ := crypto.RandBytes(16)
	env, err := crypto.Seal(alice, aliceID, bobID, bobDH, msgID, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	wire, _ := transport.SerializeEnvelope(env)
	txid, _ := transport.NewTxID()
	names, _ := transport.ChunkUpstream(txid, testZone, wire, "s")
	for i, n := range names {
		got := txtOf(t, s, n)
		if i < len(names)-1 {
			if len(got) == 0 || !strings.HasPrefix(got[0], "OK ") {
				t.Fatalf("chunk %d unexpected: %v", i, got)
			}
		} else if len(got) == 0 || !strings.HasPrefix(got[0], "DONE ") {
			t.Fatalf("final chunk unexpected: %v", got)
		}
	}

	var frames []string
	var msgTxid string
	offset := 0
	for {
		resp := txtOf(t, s, "r"+strconv.Itoa(offset)+"."+strconv.Itoa(offset)+"."+bobID+".p."+testZone)
		if len(resp) == 0 {
			t.Fatal("empty poll response")
		}
		hdr := strings.Fields(resp[0])
		if len(hdr) != 5 {
			t.Fatalf("bad poll header: %q", resp[0])
		}
		if hdr[1] == "-" {
			t.Fatal("no message queued for bob")
		}
		msgTxid = hdr[1]
		total, _ := strconv.Atoi(hdr[2])
		count, _ := strconv.Atoi(hdr[4])
		frames = append(frames, resp[1:1+count]...)
		offset += count
		if offset >= total {
			break
		}
	}
	assembled, err := transport.DecodeDownstream(frames)
	if err != nil {
		t.Fatal(err)
	}
	gotEnv, err := transport.ParseEnvelope(assembled)
	if err != nil {
		t.Fatal(err)
	}
	out, err := crypto.Open(bob, alice.SignPub, gotEnv)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if string(out) != string(plaintext) {
		t.Fatalf("plaintext mismatch: %q", out)
	}
	ack := txtOf(t, s, "rndz."+msgTxid+"."+bobID+".a."+testZone)
	if len(ack) == 0 || ack[0] != "OK" {
		t.Fatalf("ack failed: %v", ack)
	}
	after := txtOf(t, s, "rnd9.0."+bobID+".p."+testZone)
	if len(after) == 0 || !strings.HasPrefix(after[0], "v1 - ") {
		t.Fatalf("queue not empty after ack: %v", after)
	}
}

func TestEndToEndPipeline(t *testing.T) { runPipeline(t, newServer()) }

// Same full pipeline, but backed by a live Postgres store when configured.
func TestEndToEndPipelinePostgres(t *testing.T) {
	url := os.Getenv("QC_TEST_POSTGRES_URL")
	if url == "" {
		t.Skip("set QC_TEST_POSTGRES_URL to run the Postgres-backed pipeline test")
	}
	pg, err := storage.OpenPostgres(url)
	if err != nil {
		t.Fatalf("OpenPostgres: %v", err)
	}
	defer pg.Close()
	runPipeline(t, newServerWithStore(pg))
}

func TestReplayRejectedAtServer(t *testing.T) {
	s := newServer()
	alice, _ := crypto.GenerateIdentity()
	bob, _ := crypto.GenerateIdentity()
	aliceID := registerOverDNS(t, s, alice)
	bobID := registerOverDNS(t, s, bob)

	msgID, _ := crypto.RandBytes(16)
	env, _ := crypto.Seal(alice, aliceID, bobID, bob.DHPub.Bytes(), msgID, []byte("dup"))
	wire, _ := transport.SerializeEnvelope(env)

	send := func(txid string) []string {
		names, _ := transport.ChunkUpstream(txid, testZone, wire, "s")
		var last []string
		for _, n := range names {
			last = txtOf(t, s, n)
		}
		return last
	}
	if got := send("tx1"); len(got) == 0 || !strings.HasPrefix(got[0], "DONE ") {
		t.Fatalf("first send: %v", got)
	}
	if got := send("tx2"); len(got) == 0 || !strings.HasPrefix(got[0], "DUP ") {
		t.Fatalf("replay not rejected: %v", got)
	}
}

func TestResolverInterop(t *testing.T) {
	s := newServer()
	alice, _ := crypto.GenerateIdentity()
	aliceID := registerOverDNS(t, s, alice)

	ua, _ := net.ResolveUDPAddr("udp", "127.0.0.1:0")
	conn, err := net.ListenUDP("udp", ua)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	go s.ListenUDP(conn)
	port := conn.LocalAddr().(*net.UDPAddr).Port

	res := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			d := net.Dialer{}
			return d.DialContext(ctx, "udp", "127.0.0.1:"+strconv.Itoa(port))
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	name := "rndx." + aliceID + ".k." + testZone
	txts, err := res.LookupTXT(ctx, name)
	if err != nil {
		t.Fatalf("stdlib LookupTXT failed (wire-format incompatibility): %v", err)
	}
	if len(txts) == 0 {
		t.Fatal("stdlib resolver returned no TXT")
	}
	joined := strings.Join(txts, "")
	kb, err := transport.DecodeDownstream([]string{joined})
	if err != nil {
		kb, err = transport.DecodeDownstream(txts)
	}
	if err != nil || len(kb) != 64 {
		t.Fatalf("decode keys from stdlib resolver: %v len=%d", err, len(kb))
	}
	if err := identity.VerifyID(aliceID, kb[:32], kb[32:]); err != nil {
		t.Fatalf("self-cert via stdlib resolver path failed: %v", err)
	}
}
