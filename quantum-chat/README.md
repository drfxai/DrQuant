# Quantum Chat

DNS-resilient, end-to-end-encrypted, **text-only emergency messenger** for the
DrFX Quantum ecosystem. When HTTPS / VPNs / WebSockets are blocked but DNS still
resolves, users exchange encrypted messages over DNS queries to an authoritative
node the operator runs. Separate microservice — it does not touch the main
platform's code, database, or process.

> **Honest framing:** this raises the *cost* of censorship and surveillance; it
> does not make you invisible. DNS tunneling is detectable by DPI, latency is
> high, and some metadata leaks are inherent. Read `docs/threat-model.md`.

## Status

**Verified (Go `go test ./...` passes):** crypto (X25519 +
Ed25519 + AES-256-GCM + HKDF), **X3DH + Double Ratchet** (full forward secrecy +
post-compromise secrecy + out-of-order delivery, all tested), self-certifying
20-char IDs, DNS transport (chunking/reassembly), RAM store with TTL + replay
protection, **durable Postgres store (tested against a live database)**, rate
limiting, authoritative DNS codec (cross-validated against Go's own resolver),
the server, and the `quantum-chat` binary (serve + `health`). The end-to-end
pipeline (register → key-lookup → encrypt → DNS upload → poll → decrypt → ack) is
tested over **both** the RAM and the Postgres backend. Stdlib-only except one
pure-Go dependency, `github.com/lib/pq`, used only for durable mode.

**Honest scope:** the X3DH + Double Ratchet is tested as a module but is **not
yet wired into the live DNS message path** — messages on the wire still use the
ephemeral-static envelope (partial forward secrecy) until that integration ships.
See `docs/forward-secrecy.md`.

**Next batch (clearly scoped, not faked):** wire the ratchet into the live
envelope/transport (prekey publish/fetch DNS actions + atomic one-time-prekey
consumption), multi-resolver scatter on the *native* client, anycast/Redis
coordination, browser-tested frontend.

## Layout

```
quantum-chat/
├── cmd/quantum-chat/main.go          # serve + health + version
├── internal/
│   ├── crypto/        # X25519/Ed25519/AES-GCM/HKDF, seal/open, fingerprint
│   ├── ratchet/       # X3DH + Double Ratchet (full forward secrecy; tested)
│   ├── identity/      # self-certifying 20-char IDs, registration record
│   ├── transport/     # envelope (de)serialize, DNS chunk codec, reassembly
│   ├── storage/       # Store interface, RAM impl + Postgres impl (postgres.go)
│   ├── ratelimit/     # per-source token bucket
│   ├── dnswire/       # minimal authoritative DNS message codec
│   └── server/        # request routing + UDP/TCP listeners
├── configs/quantum-chat.env.example
├── migrations/001_quantum_chat_schema.sql   # durable-mode schema (validated)
├── scripts/{install,uninstall,update}-quantum-chat.sh
├── systemd/quantum-chat.service              # hardened unit (CAP_NET_BIND_SERVICE)
├── web/quantum-chat.js + INTEGRATION.md      # browser client (reference)
└── docs/{architecture,threat-model,forward-secrecy,dns-setup,deployment-checklist}.md
```

## Quick start

```bash
# Build & test (Go >= 1.22)
cd quantum-chat && go test ./...

# Install on a fresh Ubuntu/Debian VPS (one command)
sudo bash scripts/install-quantum-chat.sh
# or: sudo bash -c "$(curl -Ls https://YOUR_DOMAIN/install-quantum-chat.sh)"

# Verify
quantum-chat health
sudo systemctl status quantum-chat
```

Then set the DNS delegation (A glue + NS) per `docs/dns-setup.md`, and ensure
**UDP and TCP 53** are open to the internet. Frontend wiring is in
`web/INTEGRATION.md`.

## Crypto / identity in one paragraph

Each message: ephemeral X25519 → HKDF-SHA256 → AES-256-GCM, signed with the
sender's Ed25519 key (swap to ChaCha20-Poly1305 in one function; envelope
unchanged). The 20-char ID is `Crockford-Base32(SHA-256("qc-id"‖signPub‖dhPub))`
truncated to 100 bits — self-certifying, so the server can't bind your ID to a
key you don't control. Compare fingerprints (safety numbers) out of band for
full MITM protection. On the wire, forward secrecy is currently **partial**
(ephemeral-static); a tested X3DH + Double Ratchet for full forward secrecy lives
in `internal/ratchet` and is pending wiring — see `docs/forward-secrecy.md`.

## License / use

A censorship-circumvention tool intended for lawful emergency communication
(e.g. during internet shutdowns). Operate it responsibly and in accordance with
the laws that apply to you.
