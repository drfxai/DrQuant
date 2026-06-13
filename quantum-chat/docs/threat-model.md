# Quantum Chat — Threat Model

This document is deliberately candid about what Quantum Chat does and does **not**
protect against. A censorship-circumvention tool that oversells itself gets
people hurt. Read the residual-risk rows as carefully as the mitigations.

**One-line honest summary:** Quantum Chat raises the *cost* of censoring and
surveilling communication; it does not make you invisible. DNS tunneling is
fingerprintable by a determined network observer, latency is high, and several
metadata leaks are inherent to store-and-forward over DNS.

Risk levels below are the *residual* risk after the stated mitigation, rated
Low / Medium / High for a capable nation-state-ish adversary.

---

## 1. Deep Packet Inspection (DPI) — Residual: **High**
**Attack.** A censor inspects DNS traffic and flags the statistical signature of
tunneling: long random-looking QNAMEs, high query volume to a single
authoritative zone, TXT-heavy responses, entropy in labels.
**Mitigation.** Data labels are base32 (valid hostname charset); EDNS0 sizing
and TTL=0 look like ordinary authoritative behaviour; the client can throttle,
pad, and randomise timing; traffic can scatter across resolvers and rotate
across `QUANTUM_CHAT_EXTRA_DOMAINS`.
**Residual.** DPI can still classify sustained tunneling and block or throttle
the zone. This is an arms race we do not claim to win — we claim to make crude
blocks ineffective and fine-grained blocks expensive. Treat Quantum Chat as a
*fallback when normal channels are already cut*, not a stealth channel.

## 2. DNS resolver logging — Residual: **Medium**
**Attack.** The recursive resolver a client uses (ISP, 8.8.8.8, etc.) logs every
query, including poll queries that contain the **recipient's own 20-char ID**.
This links "this client polls for ID X" to the client's source IP.
**Mitigation.** IDs are pseudonyms unlinked to phone/email/real identity;
scatter mode spreads queries across multiple resolvers so no single one sees the
whole pattern; random nonce labels prevent cross-query correlation by cache key.
**Residual.** Your *own* resolver still learns that your IP polls for your ID and
talks to the zone. Use resolvers you trust, rotate them, and assume the resolver
+ the authoritative operator can each see one half of the metadata.

## 3. DNS cache poisoning / response spoofing — Residual: **Low**
**Attack.** An on-path attacker forges DNS responses to inject false messages or
drop real ones.
**Mitigation.** Message integrity does **not** depend on DNS. Every envelope is
AEAD-encrypted and Ed25519-signed by the sender; a forged or altered TXT payload
fails `crypto.Open` and is discarded. msg_id replay tracking drops duplicates.
**Residual.** Spoofing can cause *denial* (dropped/garbage responses → retries),
but cannot forge or read message content. Availability degrades; confidentiality
and integrity hold.

## 4. Replay attacks — Residual: **Low**
**Attack.** An observer re-sends captured upstream chunks or a whole message to
duplicate or confuse delivery.
**Mitigation.** Each message carries a random 16-byte `msg_id`; the server drops
any `msg_id` already seen within the TTL window (`DUP` response). The AEAD nonce
is random per message and the signature binds the `msg_id`.
**Residual.** Replays within microseconds before first-delivery bookkeeping, or
after the TTL window has purged the `msg_id`, are theoretically possible; impact
is at most a duplicate ciphertext the client can de-dup locally by `msg_id`.

## 5. Man-in-the-middle (key substitution) — Residual: **Low–Medium**
**Attack.** The server (or a network attacker controlling key lookup) hands you a
key it controls instead of your contact's, then relays/decrypts.
**Mitigation.** IDs are **self-certifying**: `id = base32(SHA-256(signPub ||
dhPub))[:100 bits]`. After a key lookup the client verifies the returned keys
hash back to the claimed ID — the server cannot substitute a different key for an
existing ID without ~2^100 work. For full assurance, contacts compare the
out-of-band **fingerprint / safety number** (`crypto.Fingerprint`).
**Residual.** If you accept a *wrong ID* in the first place (e.g. an attacker
gives you their ID claiming to be your friend), self-certification cannot help —
that is a trust-on-first-use problem solved only by out-of-band fingerprint
comparison. Verify safety numbers for high-stakes contacts.

## 6. Traffic correlation / timing — Residual: **High**
**Attack.** A global passive observer correlates "client A uploads chunks" with
"client B polls and retrieves" by timing/volume to deanonymise who talks to whom.
**Mitigation.** Recipient ID is absent from upstream QNAMEs (server learns it
only after reassembly); store-and-forward decouples send and receive timing;
TTL lets the recipient poll much later; scatter spreads the pattern.
**Residual.** Against an adversary who sees both ends, DNS tunneling provides
little unlinkability. We do not claim anonymity of the *social graph*. If
who-talks-to-whom must be hidden from a global observer, this is not sufficient
alone (consider mixnets/Tor for that property).

## 7. Domain blocking — Residual: **Medium**
**Attack.** The censor blocks `qc.example.com` (or the NS delegation) outright.
**Mitigation.** `QUANTUM_CHAT_EXTRA_DOMAINS` + multiple delegated NS allow
rotation; the client resolver bank routes around resolver-level blocks; the zone
can be re-homed to a new domain quickly.
**Residual.** A censor can keep blocking each new domain (whack-a-mole). You need
an out-of-band channel to distribute new domains to users. Domain fronting is
**not** used here and is increasingly unavailable.

## 8. Server seizure — Residual: **Low (content) / Medium (metadata)**
**Attack.** Authorities seize the VPS.
**Mitigation.** RAM-only mode (default) keeps **no message content on disk**;
power-off destroys queues. Stored envelopes are ciphertext the server cannot
read (no private keys server-side). Logs are off by default and never contain
message content.
**Residual.** A *live* seized server in RAM mode exposes currently-queued
ciphertext + the registration table (public keys + last-seen timestamps), which
leaks who-is-registered and rough activity. Durable mode persists ciphertext +
metadata until TTL. Seizure reveals the *operator*.

## 9. Server compromise (remote) — Residual: **Low (content) / High (availability+metadata)**
**Attack.** An attacker gains code execution on the node.
**Mitigation.** systemd hardening (non-root `quantum-chat` user, `CAP_NET_BIND_SERVICE`
only, `NoNewPrivileges`, `ProtectSystem=strict`, `MemoryDenyWriteExecute`,
syscall filter); per-IP rate limiting; small stdlib-only attack surface; no
plaintext or private keys present to steal.
**Residual.** A compromised node can drop/observe ciphertext and metadata in
flight, register fake IDs, and deny service. It still cannot decrypt messages.
Rotate the host and keys after any suspected compromise.

## 10. User device compromise — Residual: **High**
**Attack.** Malware/forensics on the user's phone or laptop.
**Mitigation.** None at the protocol layer — this is the endpoint, where private
keys and plaintext necessarily live. Local contact book should be encrypted at
rest by the client.
**Residual.** Full compromise of the device defeats end-to-end encryption
entirely. This is true of every E2E messenger. Device security is the user's
responsibility; consider disappearing messages and a screen lock.

## 11. Abuse / spam / DoS — Residual: **Medium**
**Attack.** Flooding the node with junk chunks/registrations or polling to
exhaust memory/CPU.
**Mitigation.** Per-source token-bucket rate limiting; bounded reassembly buffers
with TTL eviction; `MAX_MESSAGE_SIZE` cap; bounded audit ring; `MemoryMax` in
systemd; registration requires a valid self-signature.
**Residual.** A distributed flood can still degrade availability (it is UDP on
:53). Front with anycast/multiple nodes and upstream rate limiting for serious
exposure; consider a proof-of-work stamp on registration in a future batch.

## 12. Enumeration of 20-char IDs — Residual: **Low**
**Attack.** Guessing/brute-forcing IDs to discover users or their keys.
**Mitigation.** IDs carry ~100 bits of entropy (2^100 space); they are derived
from keys, not sequential; key lookup returns only already-public keys; rate
limiting caps guess throughput.
**Residual.** Negligible brute-force risk. Note that key lookup *confirms* a
given ID exists (an oracle); with rate limiting this leaks little, but a
determined party who already knows an ID can confirm registration and fetch the
(public) keys — by design, since that is how contacts add each other.

---

## Properties we explicitly DO and DO NOT claim

**We claim:** end-to-end confidentiality + integrity + sender authenticity of
message *content*; no plaintext at rest; self-certifying IDs that block key
substitution; resilience against crude DNS/domain/resolver blocks; minimal
content logging.

**We do NOT claim:** undetectability against DPI; anonymity of the social graph
against a global observer; forward secrecy against compromise of a recipient's
long-term key (see below); protection against endpoint compromise; guaranteed
availability under a determined, well-resourced blocker.

## Forward secrecy — current state
Batch 1 uses ephemeral-static encryption: a fresh ephemeral key per message
protects against *sender-side* key compromise, but an attacker who later
recovers a *recipient's* long-term X25519 key can decrypt past messages to that
recipient (the ephemeral_pub is in the envelope). Full forward + future secrecy
requires signed one-time prekeys (X3DH) and the Double Ratchet. That construction
is now **implemented and unit-tested** in `internal/ratchet` (forward secrecy,
post-compromise secrecy, and out-of-order delivery are all covered by tests).
It is **not yet wired into the live DNS message path**, so messages on the wire
still have the partial forward secrecy described here until that integration
ships. See `docs/forward-secrecy.md` for the design and the wiring plan. Do not
rely on full forward secrecy for live messages yet.
