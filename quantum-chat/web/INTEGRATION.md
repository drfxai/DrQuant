# Quantum Chat — Frontend Integration Plan

How to add the **Quantum Chat** section to the existing DrFX Quantum vanilla-JS
SPA (`public/index.html`), using `web/quantum-chat.js`.

## Read this first (the honest caveats)

- **DoH is HTTPS.** The browser client talks to the node via DNS-over-HTTPS. It
  works when DoH endpoints are reachable — frequently true even under censorship
  — but if *all* HTTPS including DoH is blocked, only the **native Go client**
  (raw port 53) can get through. Present Emergency Mode as "best-effort when
  normal channels are down," not "guaranteed."
- **The module is reference code, not yet browser-tested here.** The Go server
  core is verified (`go test` incl. resolver interop). Run the integration test
  below against a live node before shipping to users.
- **WebCrypto Ed25519/X25519 required.** Supported in current Chrome/Firefox/
  Safari. If you must support older browsers, replace the `crypto.subtle` calls
  for Ed25519/X25519/HKDF with `@noble/curves` (`ed25519`, `x25519`) and
  `@noble/hashes` (`hkdf`, `sha256`) — the envelope byte layout stays identical.
- **Forward secrecy is partial** on the wire today. A complete X3DH + Double
  Ratchet is implemented and tested in `internal/ratchet`; wiring it into the
  live envelope is pending (see `docs/forward-secrecy.md`).

## UI section (matches the spec)

Add a "Quantum Chat" panel with:

- **Emergency Mode** toggle → `qc.setEmergencyMode(on)`. When ON: stop using the
  platform WebSocket for these messages, route through DNS (DoH), enable the
  resolver bank + scatter, queue outgoing locally, and poll on an interval.
- **Generate / show my ID** → `await qc.createIdentity()` then `await qc.register()`;
  display `qc.myId()` (the 20-char code) and `await qc.myFingerprint()` (safety
  number).
- **Add friend by ID** → `await qc.addContact(id)`; show the returned fingerprint
  and ask the user to compare it out of band, then `qc.markVerified(id)`.
- **Local encrypted contact book** → contacts live in `qc.contacts`. Persist them
  encrypted at rest (e.g. AES-GCM under a key derived from a user passphrase via
  PBKDF2/Argon2) in IndexedDB; never store private keys in plaintext.
- **Text composer** → `await qc.send(id, text)`; show delivery status from the
  returned txid (`DONE` = stored for delivery, `DUP` = already seen).
- **DNS transport status / resolver health** → surface per-resolver success in
  `dohTXT` (add a callback/log) and show which resolvers are responding.
- **Retry failed message** → re-call `qc.send(...)` for the queued item.
- **Clear local cache** → `qc.clearLocalCache()`.

## Minimal wiring

```html
<script type="module">
  import QuantumChat from "./quantum-chat.js";

  const qc = new QuantumChat({
    zone: "qc.example.com",
    resolvers: [
      "https://cloudflare-dns.com/dns-query",
      "https://dns.google/resolve",
    ],
  });

  // First run: make + publish an identity.
  const myId = await qc.createIdentity();
  await qc.register();
  document.querySelector("#qc-my-id").textContent = myId;
  document.querySelector("#qc-safety").textContent = await qc.myFingerprint();

  // Add a contact, verify safety number out of band, then mark verified.
  // const { fingerprint } = await qc.addContact("K8F2X9Q7L4M1T6R3Z0W2", "Sam");

  // Send.
  // await qc.send("K8F2X9Q7L4M1T6R3Z0W2", "are you safe?");

  // Poll on an interval while in Emergency Mode.
  let timer = null;
  function startPolling() {
    timer = setInterval(async () => {
      for (const m of await qc.poll()) renderIncoming(m.from, m.text);
    }, 15000); // 15s; tune for latency vs. traffic footprint
  }
  function stopPolling() { clearInterval(timer); timer = null; }

  document.querySelector("#qc-emergency").addEventListener("change", (e) => {
    qc.setEmergencyMode(e.target.checked);
    e.target.checked ? startPolling() : stopPolling();
  });
</script>
```

## Isolation from the main platform (required)

- Quantum Chat keys, contacts, and messages stay **client-side**; do not send
  them to the Node.js backend or store them in the main Postgres DB.
- The Quantum Chat node is a **separate service on a separate subdomain** with
  its own `.env`. The main platform never proxies it.
- If you later want optional account binding, do it through a privacy-preserving
  bridge (e.g. store only a user-chosen Quantum Chat ID, never keys) — out of
  scope for batch 1.
- The main platform must keep working if the node is offline, and the node keeps
  working if the main platform is blocked.

## Integration test before shipping (do this)

1. Stand up a node on a test domain; confirm `quantum-chat health` and
   `dig @<ip> <zone> SOA`.
2. In a browser console with the module loaded, run two identities (two tabs):
   register both, add each other, verify fingerprints match, send a message one
   way, poll the other, confirm plaintext round-trips, confirm a second poll is
   empty (ack worked).
3. **TXT boundary note for DoH:** the node currently packs the poll header +
   frames as multiple character-strings inside one TXT record. Some DoH-JSON
   resolvers concatenate those into a single `data` string. `dohTXT` strips
   quotes and joins, and `poll()` re-joins frames before base64url-decoding, so
   the concatenation is tolerated. If you hit a resolver that mangles this,
   adjust the server to emit **one TXT record per frame** (the native Go client
   already handles both forms) — a small change in `server.handlePoll`.
4. Test under a throttled network to validate retry/timeout behavior.
