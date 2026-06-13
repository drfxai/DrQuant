# Quantum Chat — Forward Secrecy (X3DH + Double Ratchet)

## Why this exists

The batch-1 message envelope (`internal/crypto`) uses **ephemeral-static**
encryption: a fresh ephemeral key per message protects against compromise of the
*sender's* key, but an attacker who later recovers a *recipient's* long-term
X25519 key can recompute the shared secret from the `ephemeral_pub` carried in
the envelope and decrypt past messages. That is **partial** forward secrecy.

`internal/ratchet` closes that gap with the same construction Signal uses:
**X3DH** for asynchronous session setup plus the **Double Ratchet** for
per-message key evolution. With it:

- **Forward secrecy:** each message key is derived from a one-way KDF chain and
  deleted after use, so compromising current state does not reveal past
  messages — even the legitimate recipient cannot re-derive a consumed key
  (verified by `TestForwardSecrecyKeyDeleted`).
- **Post-compromise ("future") secrecy:** the DH ratchet injects fresh
  Diffie-Hellman entropy on every change of direction, so a one-time state
  compromise heals after the next round-trip (verified by
  `TestDHRatchetAdvancesRoot`).
- **Asynchronous + out-of-order:** X3DH lets a sender start a session while the
  recipient is offline; skipped-message-key handling decrypts messages that
  arrive out of order (verified by `TestOutOfOrderDelivery`) — both essential
  for store-and-forward over DNS.

> **Status:** the cryptographic core is implemented and unit-tested in isolation
> (`go test ./internal/ratchet/`). It is **not yet wired into the live DNS
> message path**. Until the integration below ships, messages on the wire still
> use the batch-1 ephemeral-static envelope (partial FS). This is the same
> honest staging used for the Postgres schema → backend.

## X3DH (asynchronous key agreement)

A recipient publishes a **prekey bundle**:
- `IdentityDH` — long-term X25519 identity key (the existing identity DH key).
- `IdentitySign` — long-term Ed25519 key (the existing identity signing key).
- `SignedPreKey` (SPK) — medium-term X25519 key, rotated periodically.
- `SignedPreSig` — Ed25519 signature over `("quantum-chat/v1 spk" || SPK)`,
  proving the SPK belongs to the identity.
- `OneTimePreKey` (OPK) — single-use X25519 key, deleted after one session.

A sender (initiator) with identity key `IK_A` generates an ephemeral `EK_A` and
computes four Diffie-Hellman values, then derives the session secret:
```
DH1 = DH(IK_A,  SPK_B)
DH2 = DH(EK_A,  IK_B)
DH3 = DH(EK_A,  SPK_B)
DH4 = DH(EK_A,  OPK_B)            # omitted if no OPK is available
SK  = HKDF( 0xFF*32 || DH1 || DH2 || DH3 || DH4 )
```
The `0xFF`-prefix and the inclusion of both identity keys in the associated data
(`AD = IK_A_pub || IK_B_pub`) follow the X3DH spec. The recipient recomputes the
same `SK` from its side using the stored SPK/OPK privates and the initiator's
`IK_A`/`EK_A` publics, then **deletes the consumed OPK**.

Mixing the long-term identity keys into `SK` authenticates both parties; the
signed prekey prevents an attacker from substituting an SPK it controls
(`TestForgedSignedPreKeyRejected`).

## Double Ratchet (per-message evolution)

`SK` seeds the root key. Each party keeps a `Session`:
- a root key `RK`, a sending chain key `CKs`, a receiving chain key `CKr`;
- a current DH ratchet keypair `DHs` and the remote ratchet public `DHr`;
- message counters `Ns`/`Nr`, previous sending-chain length `PN`;
- a bounded map of skipped message keys (cap `maxSkip = 1000`).

KDFs (Signal construction):
```
KDF_RK(RK, DH_out) -> RK', CK   = HKDF(salt=RK, ikm=DH_out)        # 64B split
KDF_CK(CK)         -> CK', MK   = HMAC(CK,0x02), HMAC(CK,0x01)
message key        -> AES-256 key + nonce = HKDF(MK)               # 44B split
```
- **Symmetric ratchet:** every message advances `CKs`/`CKr` one step, producing a
  unique `MK` that is used once for AES-256-GCM and discarded → forward secrecy
  within a chain.
- **DH ratchet:** when an incoming header carries a new `DHr`, the receiver
  performs `KDF_RK` with a fresh DH output, rotating `RK` and starting new chains
  → post-compromise secrecy.

Each message carries a 40-byte header: `DH(32) || PN(4) || N(4)`. The header and
the X3DH associated data are bound into the AEAD's additional data.

## Integration plan (the remaining wiring)

To put this on the live DNS path without breaking the running service:

1. **Prekey serving (server + store).** Add DNS actions and store methods:
   - publish: client uploads `SPK + sig` and a batch of OPKs (like `register`,
     action `x`).
   - fetch bundle: a key-lookup variant returns `IK || SPK || sig || one OPK`,
     **atomically consuming** that OPK (one-time guarantee). In Postgres this is
     a `DELETE ... RETURNING` on a `quantum_chat_one_time_prekeys` table inside a
     transaction; in RAM, pop under the mutex. Add a low-OPK signal so clients
     replenish.
   - new tables: `quantum_chat_signed_prekeys`, `quantum_chat_one_time_prekeys`
     (migration 002).
2. **Envelope v2.** Introduce a version-2 envelope that carries the ratchet
   header, and an "initial" flag with `EK_A` + the consumed OPK id so the
   recipient can run `X3DHRespond` on first contact. Keep v1 working (version
   byte already exists) so old clients still interoperate during rollout.
3. **Session persistence (client).** Persist a per-contact `Session` (encrypted
   at rest). On send: `Encrypt` → v2 envelope → existing DNS chunking. On poll:
   parse header → `Decrypt`. First message to a new contact runs X3DH using the
   fetched bundle.
4. **Server stays oblivious.** The node still only stores ciphertext + public
   prekeys; it never sees plaintext, private keys, or message keys. The
   threat-model's "server compromise / seizure" rows are unchanged.
5. **Tests to add:** atomic OPK consumption under concurrency; v1/v2
   interop; a full register→publish-prekeys→fetch-bundle→X3DH→ratchet→DNS
   round-trip over both RAM and Postgres.

## What to tell users until wiring ships

Forward secrecy is currently **partial** on the wire. The full X3DH + Double
Ratchet exists and is tested as a module; once the wiring above lands and is
tested end-to-end, the "partial forward secrecy" caveat can be retired. Do not
claim full forward secrecy for live messages before then.
