# Quantum Chat — Architecture

Quantum Chat is a **separate, self-contained microservice** in the DrFX Quantum
repository (`quantum-chat/`). It shares no code, database, or process with the
main Node.js platform. The main platform keeps working if Quantum Chat is down,
and Quantum Chat keeps working if the main platform is blocked — as long as DNS
to its authoritative node still flows.

## 1. What it is

A text-only, end-to-end-encrypted emergency messenger whose transport is **DNS
queries** to an authoritative server the operator controls. When HTTPS /
WebSockets / VPNs are blocked but DNS still resolves, clients exchange encrypted
messages by encoding them into DNS queries and TXT responses.

It is **stdlib-only Go** (no external modules) so the security-critical core is
small and auditable, and so it builds anywhere with Go ≥ 1.22.

## 2. Service diagram

```
   Sender device                 Recursive resolver(s)            Authoritative
  ┌──────────────┐    DNS query   ┌──────────────────┐   DNS query  ┌──────────────┐
  │ client:      │ ─────────────▶ │  1.1.1.1 / 8.8.8 │ ───────────▶ │ quantum-chat │
  │  seal()      │   (scatter)    │  /9.9.9.9 ...    │  (delegated) │  node :53    │
  │  chunk→QNAME │ ◀───────────── │                  │ ◀─────────── │  UDP + TCP   │
  └──────────────┘    TXT answer  └──────────────────┘   TXT answer └──────┬───────┘
        ▲                                                                   │
        │ poll (later)                                            ┌─────────▼─────────┐
        │                                                         │ store: RAM (def.) │
   ┌────┴─────────┐                                               │   or Postgres     │
   │ recipient    │  same path: poll → reassemble → open()        │ encrypted-only,   │
   │ device       │                                               │ TTL auto-delete   │
   └──────────────┘                                               └───────────────────┘
```

The authoritative node is the only server. Recursive resolvers are untrusted
intermediaries; the random nonce label on every query forces them to forward to
the authoritative node instead of serving cached answers.

## 3. DNS transport design

**Upstream (client → server)** — data rides in the QNAME:
```
<d0>.<d1>...<dk>.<seq>.<total>.<txid>.<action>.<zone>
```
- `d0..dk` — base32 (Crockford, DNS-safe, case-insensitive) chunk data, packed
  into ≤63-char labels, whole name ≤255 bytes.
- `seq`/`total` — chunk index and count for reassembly.
- `txid` — random id grouping the chunks of one message.
- `action` — `s` send, `r` register.
- Recipient ID is **not** in the name; the server learns it only after
  reassembling and parsing the (encrypted) envelope → less on-path metadata.

**Downstream (server → client)** — data rides in TXT character-strings,
base64url-encoded, sized to fit the EDNS0-advertised UDP buffer
(`min(requestor, 1232)`); larger transfers page via an `offset`.

**Control queries** (TXT, with a leading random nonce label to defeat caching):
| Purpose | Name | Returns |
|---|---|---|
| Poll inbox | `<rnd>.<offset>.<recipientID>.p.<zone>` | `v1 <txid> <total> <offset> <count>` + frames |
| Ack delivery | `<rnd>.<txid>.<recipientID>.a.<zone>` | `OK` / `NF` |
| Key lookup | `<rnd>.<targetID>.k.<zone>` | base64url(signPub‖dhPub) |
| Register | chunked upstream, action `r` | `OK <id>` |
| Apex/health | `<zone>` SOA/NS/A | authoritative answer (AA) |

**Cost reality:** ~110–140 raw bytes per query after encoding/overhead, so a
2 KB message is ~15–20 queries. This is intrinsic to DNS tunneling; it is a
fallback channel, not a high-throughput one.

## 4. Cryptographic protocol

Per `internal/crypto` (all Go stdlib):
- **Key agreement:** X25519 (`crypto/ecdh`).
- **Identity signing:** Ed25519 (`crypto/ed25519`).
- **AEAD:** AES-256-GCM (`crypto/cipher`) — verified default. Swap to
  ChaCha20-Poly1305 by replacing `newAEAD()`; envelope format is unchanged.
- **KDF:** HKDF-SHA256 (hand-rolled, RFC 5869).

Per-message envelope (ephemeral-static "sealed box" + sender signature):
```
shared = X25519(ephemeral_priv, recipient_static_pub)
key    = HKDF(shared, salt = ephemeral_pub‖recipient_pub, info="quantum-chat/v1 aead")
ct     = AES-256-GCM(key, nonce, plaintext, aad = sender_id‖recipient_id‖msg_id)
sig    = Ed25519_sign(sender_identity, transcript(envelope))
```
Decryption verifies the sender signature first, then derives the same key and
opens the AEAD. **Forward secrecy is partial on the wire** (see threat-model.md):
the X3DH + Double Ratchet that provides full forward + post-compromise secrecy is
implemented and tested in `internal/ratchet` but not yet wired into this path —
see `docs/forward-secrecy.md`.

## 5. Identity system

`id = Crockford-Base32( first 100 bits of SHA-256("qc-id" ‖ signPub ‖ dhPub) )`
→ exactly 20 uppercase-alphanumeric chars, ~100 bits of entropy, non-sequential,
collision-resistant, and **self-certifying**: anyone with the ID can verify a
claimed key pair hashes back to it, so the server cannot bind your ID to a key
you do not control. The ID is a *locator*; the *authenticator* is the key
fingerprint (safety number) compared out of band. Registration carries
`signPub‖dhPub‖sig` where `sig` proves control of the signing key over the
derived ID; re-registration with conflicting keys is rejected.

## 6. Storage

`internal/storage` defines a `Store` interface; **RAMStore** is the verified
default. It holds registrations, upstream reassembly buffers, per-recipient
queues, a replay set (seen `msg_id`s), and an audit ring — all with TTL
sweeping. Nothing is plaintext; nothing is a private key.

**Durable mode** (`postgres.go`, `PGStore`) uses
`migrations/001_quantum_chat_schema.sql` (schema + `qc_sweep()` TTL function)
behind the same interface and is tested against a live database. Selecting
`postgres` with `QUANTUM_CHAT_POSTGRES_URL` set uses it; if Postgres is
unreachable the node logs a warning and falls back to RAM so messaging stays up.

## 7. Process model & systemd

Single Go process; one goroutine per inbound query; a background sweeper goroutine
runs TTL cleanup each minute; graceful shutdown on SIGINT/SIGTERM. The
`quantum-chat.service` unit runs as a dedicated non-root user with
`CAP_NET_BIND_SERVICE` to bind :53, `NoNewPrivileges`, `ProtectSystem=strict`,
`MemoryDenyWriteExecute`, a `@system-service` syscall filter, and `MemoryMax`.
`ExecStartPost` runs `quantum-chat health` so a node that can't answer fails the
unit.

## 8. Scaling

- **Stateless workers + shared state:** multiple nodes behind multiple delegated
  NS records; move the queue/replay/registration state into Postgres (durable
  mode) or Redis so any node can serve any client.
- **Anycast:** announce the same node IP from multiple PoPs; UDP DNS is
  anycast-friendly. Keep per-message `txid` reassembly on a shared store so
  chunks landing on different PoPs still reassemble.
- **Redis** (`QUANTUM_CHAT_REDIS_URL`): cross-node rate-limit counters and a
  shared message queue for horizontal scale.
- **Multi-domain rotation:** `QUANTUM_CHAT_EXTRA_DOMAINS` lets the same node
  serve several zones; clients rotate domains when one is blocked.

These scaling paths are architecturally supported. The Postgres durable backend
ships and is tested; Redis coordination and anycast operationalization are
future-batch work, not in the current build.

## 9. Swapping the DNS engine

`internal/dnswire` is a compact, audited DNS codec validated against Go's own
resolver. For exhaustive RFC edge-case coverage in very hostile resolver
environments, an operator may replace it with `github.com/miekg/dns` behind the
same `server.Server` boundary without touching crypto/transport/storage.

## 10. Build & verify

```
cd quantum-chat
go build ./...     # stdlib + one pure-Go dep (github.com/lib/pq)
go vet ./...       # clean
go test ./...      # crypto, identity, transport, storage, ratelimit,
                   # end-to-end pipeline, replay rejection, resolver interop

# durable-mode tests + Postgres-backed pipeline (against your own database):
QC_TEST_POSTGRES_URL="postgres://user:pass@host:5432/quantumchat?sslmode=disable" \
  go test ./...

gofmt -w ./...     # canonical formatting (cosmetic)
```
