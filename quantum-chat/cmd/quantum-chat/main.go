// Command quantum-chat is the authoritative DNS messenger node.
//
//	quantum-chat            # serve (reads QUANTUM_CHAT_* env)
//	quantum-chat health     # local DNS round-trip probe (exit 0 = healthy)
//	quantum-chat version
//
// Only authors/operators run this; it binds UDP/TCP :53 (needs root or
// CAP_NET_BIND_SERVICE). Storage defaults to RAM; set STORAGE_MODE=postgres with
// QUANTUM_CHAT_POSTGRES_URL for the durable backend (schema in
// migrations/001_quantum_chat_schema.sql). If Postgres is unreachable the node
// logs a warning and falls back to RAM so emergency messaging stays up.
package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"quantumchat/internal/ratelimit"
	"quantumchat/internal/server"
	"quantumchat/internal/storage"
)

const version = "quantum-chat 0.1.0 (batch-1 core)"

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "version", "-v", "--version":
			fmt.Println(version)
			return
		case "health":
			os.Exit(health())
		}
	}
	serve()
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envBool(k string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(k))) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

func serve() {
	zone := env("QUANTUM_CHAT_DOMAIN", "")
	if zone == "" {
		log.Fatal("QUANTUM_CHAT_DOMAIN is required (e.g. qc.example.com)")
	}
	port := envInt("QUANTUM_CHAT_PORT", 53)
	bind := env("QUANTUM_CHAT_BIND_ADDR", "0.0.0.0")
	udpOn := envBool("QUANTUM_CHAT_UDP_ENABLED", true)
	tcpOn := envBool("QUANTUM_CHAT_TCP_ENABLED", true)
	mode := strings.ToLower(env("QUANTUM_CHAT_STORAGE_MODE", "ram"))
	ttl := time.Duration(envInt("QUANTUM_CHAT_MESSAGE_TTL_MINUTES", 1440)) * time.Minute
	maxMsg := envInt("QUANTUM_CHAT_MAX_MESSAGE_SIZE", 2048)
	rl := envInt("QUANTUM_CHAT_RATE_LIMIT_PER_MINUTE", 30)
	logs := envBool("QUANTUM_CHAT_ENABLE_LOGS", false)
	pgURL := env("QUANTUM_CHAT_POSTGRES_URL", "")

	var nsNames []string
	for _, n := range strings.Split(env("QUANTUM_CHAT_NS_NAMES", ""), ",") {
		if n = strings.TrimSpace(n); n != "" {
			nsNames = append(nsNames, n)
		}
	}
	adminEmail := env("QUANTUM_CHAT_ADMIN_EMAIL", "admin@"+strings.TrimPrefix(zone, "qc."))

	cfg := server.Config{
		Zone:          zone,
		NSNames:       nsNames,
		SelfIP:        net.ParseIP(env("QUANTUM_CHAT_PUBLIC_IP", "")),
		AdminRName:    emailToRName(adminEmail, zone),
		MaxMessageLen: maxMsg,
		MessageTTL:    ttl,
		Logs:          logs,
	}

	var store storage.Store
	switch {
	case mode == "postgres" && pgURL != "":
		pg, err := storage.OpenPostgres(pgURL)
		if err != nil {
			log.Printf("WARNING: postgres unavailable (%v); falling back to RAM — messages will NOT persist", err)
			store = storage.NewRAMStore()
		} else {
			log.Printf("durable storage: postgres")
			defer pg.Close()
			store = pg
		}
	case mode == "postgres":
		log.Printf("WARNING: STORAGE_MODE=postgres but QUANTUM_CHAT_POSTGRES_URL is empty; using RAM")
		store = storage.NewRAMStore()
	default:
		store = storage.NewRAMStore()
	}
	lim := ratelimit.New(rl)
	srv := server.New(cfg, store, lim)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Background TTL sweeper.
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-t.C:
				store.Sweep(now)
			}
		}
	}()

	addr := net.JoinHostPort(bind, strconv.Itoa(port))

	var udpConn *net.UDPConn
	var tcpLn *net.TCPListener

	if udpOn {
		ua, err := net.ResolveUDPAddr("udp", addr)
		if err != nil {
			log.Fatalf("resolve udp: %v", err)
		}
		udpConn, err = net.ListenUDP("udp", ua)
		if err != nil {
			log.Fatalf("listen udp %s: %v (port 53 needs root or CAP_NET_BIND_SERVICE)", addr, err)
		}
		go func() {
			if err := srv.ListenUDP(udpConn); err != nil {
				select {
				case <-ctx.Done():
				default:
					log.Printf("udp: %v", err)
				}
			}
		}()
		log.Printf("Quantum Chat UDP listening on %s for zone %s", addr, zone)
	}

	if tcpOn {
		ta, err := net.ResolveTCPAddr("tcp", addr)
		if err != nil {
			log.Fatalf("resolve tcp: %v", err)
		}
		tcpLn, err = net.ListenTCP("tcp", ta)
		if err != nil {
			log.Fatalf("listen tcp %s: %v", addr, err)
		}
		go func() {
			if err := srv.ListenTCP(tcpLn); err != nil {
				select {
				case <-ctx.Done():
				default:
					log.Printf("tcp: %v", err)
				}
			}
		}()
		log.Printf("Quantum Chat TCP listening on %s", addr)
	}

	if !udpOn && !tcpOn {
		log.Fatal("both UDP and TCP disabled; nothing to do")
	}

	<-ctx.Done()
	log.Printf("shutting down...")
	if udpConn != nil {
		_ = udpConn.Close()
	}
	if tcpLn != nil {
		_ = tcpLn.Close()
	}
	time.Sleep(200 * time.Millisecond)
}

// emailToRName converts admin@host to the DNS SOA RName form (admin.host),
// escaping dots in the local part per RFC 1035.
func emailToRName(email, zone string) string {
	at := strings.IndexByte(email, '@')
	if at < 0 {
		return "admin." + strings.TrimSuffix(zone, ".")
	}
	local := strings.ReplaceAll(email[:at], ".", "\\.")
	return local + "." + email[at+1:]
}

// health sends an SOA query for the zone to the local server over UDP and
// checks for a well-formed response. Used by systemd ExecStartPost and the
// `quantum-chat health` operator command.
func health() int {
	zone := env("QUANTUM_CHAT_DOMAIN", "")
	if zone == "" {
		fmt.Fprintln(os.Stderr, "health: QUANTUM_CHAT_DOMAIN not set")
		return 2
	}
	port := envInt("QUANTUM_CHAT_PORT", 53)
	target := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))

	query := buildSOAQuery(zone, 0x4242)
	conn, err := net.DialTimeout("udp", target, 3*time.Second)
	if err != nil {
		fmt.Fprintf(os.Stderr, "health: dial: %v\n", err)
		return 1
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write(query); err != nil {
		fmt.Fprintf(os.Stderr, "health: write: %v\n", err)
		return 1
	}
	buf := make([]byte, 1500)
	n, err := conn.Read(buf)
	if err != nil {
		fmt.Fprintf(os.Stderr, "health: read: %v\n", err)
		return 1
	}
	if n < 12 || binary.BigEndian.Uint16(buf[0:2]) != 0x4242 || buf[2]&0x80 == 0 {
		fmt.Fprintln(os.Stderr, "health: bad response")
		return 1
	}
	fmt.Printf("OK quantum-chat healthy on %s (zone %s)\n", target, zone)
	return 0
}

// buildSOAQuery crafts a minimal DNS SOA query for name.
func buildSOAQuery(name string, id uint16) []byte {
	var b []byte
	hdr := make([]byte, 12)
	binary.BigEndian.PutUint16(hdr[0:2], id)
	binary.BigEndian.PutUint16(hdr[2:4], 0x0100) // RD
	binary.BigEndian.PutUint16(hdr[4:6], 1)      // QDCOUNT
	b = append(b, hdr...)
	for _, label := range strings.Split(strings.TrimSuffix(name, "."), ".") {
		b = append(b, byte(len(label)))
		b = append(b, label...)
	}
	b = append(b, 0x00)
	var qt [4]byte
	binary.BigEndian.PutUint16(qt[0:2], 6) // SOA
	binary.BigEndian.PutUint16(qt[2:4], 1) // IN
	b = append(b, qt[:]...)
	return b
}
