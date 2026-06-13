/* ===========================================================================
 * Quantum Chat — browser client module  (web/quantum-chat.js)
 * ---------------------------------------------------------------------------
 * DNS-resilient end-to-end encrypted messaging for the DrFX Quantum SPA.
 *
 * STATUS: reference implementation. The Go server core is verified
 * (go test passes, incl. resolver interop). THIS browser module mirrors the
 * documented envelope/transport byte-for-byte but has NOT been cross-tested in
 * a browser against a live node here — integration-test it before relying on
 * it (see web/INTEGRATION.md).
 *
 * HONEST LIMITATIONS:
 *  1. A browser cannot send raw port-53 DNS. This module uses DNS-over-HTTPS
 *     (DoH), which is itself HTTPS. It therefore works when DoH endpoints are
 *     reachable (often true even under censorship, since blocking DoH to major
 *     providers breaks the web) but NOT when ALL HTTPS incl. DoH is blocked —
 *     that case needs the native Go client doing raw :53.
 *  2. Forward secrecy is partial (ephemeral-static); see threat-model.md.
 *  3. WebCrypto Ed25519/X25519 are required (modern browsers). If unavailable,
 *     swap in @noble/curves + @noble/hashes (see INTEGRATION.md).
 * ===========================================================================*/

const CROCKFORD_UPPER = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";   // ID alphabet (matches Go)
const CROCKFORD_LOWER = "0123456789abcdefghjkmnpqrstvwxyz";   // DNS label alphabet (matches Go)

const DEFAULT_DOH = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
];

const enc = new TextEncoder();

// ---- low-level encodings ---------------------------------------------------

function b32encodeLower(bytes) {            // Crockford base32, no padding, lowercase
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += CROCKFORD_LOWER[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += CROCKFORD_LOWER[(value << (5 - bits)) & 31];
  return out;
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...arrs) {
  let n = 0; for (const a of arrs) n += a.length;
  const out = new Uint8Array(n); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function randBytes(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; }
function toHex(bytes) { return [...bytes].map(b => b.toString(16).padStart(2, "0")).join(""); }

// ---- identity / ID ---------------------------------------------------------

// id = Crockford-Base32(first 100 bits of SHA-256("qc-id" || signPub || dhPub)), 20 chars UPPER.
async function deriveId(signPub, dhPub) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",
    concat(enc.encode("qc-id"), signPub, dhPub)));
  let bits = 0, value = 0, out = "";
  let i = 0;
  while (out.length < 20) {
    if (bits < 5) { value = (value << 8) | digest[i++]; bits += 8; }
    bits -= 5; out += CROCKFORD_UPPER[(value >>> bits) & 31];
  }
  return out;
}

async function generateIdentity() {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const dh = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  const dhPub = new Uint8Array(await crypto.subtle.exportKey("raw", dh.publicKey));
  const id = await deriveId(signPub, dhPub);
  return { id, signPub, dhPub, signPriv: sign.privateKey, dhPriv: dh.privateKey };
}

// Safety number for out-of-band MITM verification (matches crypto.Fingerprint).
async function fingerprint(signPub, dhPub) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256",
    concat(enc.encode("quantum-chat/v1 fp"), signPub, dhPub)));
  return toHex(d).match(/.{1,5}/g).slice(0, 12).join(" ");
}

// ---- envelope (byte-identical to internal/transport.SerializeEnvelope) -----
//   ver(1) sender(20) recip(20) msgid(16) ephPub(32) nonce(12) ctLen(2) ct sig(64)

async function hkdf32(shared, salt, infoStr) {
  const key = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(infoStr) }, key, 256);
  return new Uint8Array(bits);
}

async function transcriptDigest(ver, senderID, recipID, msgID, ephPub, nonce, ct) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", concat(
    enc.encode("quantum-chat/v1 sig"), new Uint8Array([ver]),
    enc.encode(senderID), enc.encode(recipID), msgID, ephPub, nonce, ct)));
}

async function seal(self, recipientID, recipientDHPub, plaintext) {
  const ephPriv = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("raw", ephPriv.publicKey));
  const recipKey = await crypto.subtle.importKey("raw", recipientDHPub, { name: "X25519" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "X25519", public: recipKey }, ephPriv.privateKey, 256));

  const key = await hkdf32(shared, concat(ephPub, recipientDHPub), "quantum-chat/v1 aead");
  const aesKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);

  const msgID = randBytes(16);
  const nonce = randBytes(12);
  const aad = concat(enc.encode(self.id), enc.encode(recipientID), msgID);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
    aesKey, enc.encode(plaintext)));        // ct||tag, matches Go

  const digest = await transcriptDigest(1, self.id, recipientID, msgID, ephPub, nonce, ct);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", self.signPriv, digest));

  const ctLen = new Uint8Array([(ct.length >> 8) & 0xff, ct.length & 0xff]);
  return concat(new Uint8Array([1]), enc.encode(self.id), enc.encode(recipientID),
    msgID, ephPub, nonce, ctLen, ct, sig);
}

async function open(self, senderSignPub, env) {
  let p = 0; const rd = (n) => env.slice(p, p += n);
  const ver = env[p++];
  const senderID = new TextDecoder().decode(rd(20));
  const recipID = new TextDecoder().decode(rd(20));
  const msgID = rd(16), ephPub = rd(32), nonce = rd(12);
  const ctLen = (env[p] << 8) | env[p + 1]; p += 2;
  const ct = rd(ctLen), sig = rd(64);

  const digest = await transcriptDigest(ver, senderID, recipID, msgID, ephPub, nonce, ct);
  const verifyKey = await crypto.subtle.importKey("raw", senderSignPub, { name: "Ed25519" }, false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", verifyKey, sig, digest)) throw new Error("bad signature");

  const ephKey = await crypto.subtle.importKey("raw", ephPub, { name: "X25519" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "X25519", public: ephKey }, self.dhPriv, 256));
  const selfDHPub = new Uint8Array(await crypto.subtle.exportKey("raw",
    (await crypto.subtle.importKey("raw", self.dhPub, { name: "X25519" }, false, []))));
  const key = await hkdf32(shared, concat(ephPub, selfDHPub), "quantum-chat/v1 aead");
  const aesKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const aad = concat(enc.encode(senderID), enc.encode(recipID), msgID);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, aesKey, ct);
  return { senderID, text: new TextDecoder().decode(pt) };
}

// ---- DoH transport (resolver bank + scatter) -------------------------------

function rnd(n = 6) { return b32encodeLower(randBytes(n)); }

// Resolve a TXT query for `name` via DoH JSON, scattering across resolvers.
// Returns an array of TXT strings (one per character-string / answer).
async function dohTXT(name, resolvers) {
  const bank = resolvers && resolvers.length ? resolvers : DEFAULT_DOH;
  const order = [...bank].sort(() => Math.random() - 0.5);   // scatter
  let lastErr;
  for (const base of order) {
    try {
      const url = base + (base.includes("?") ? "&" : "?") +
        "name=" + encodeURIComponent(name) + "&type=TXT";
      const r = await fetch(url, { headers: { accept: "application/dns-json" } });
      if (!r.ok) { lastErr = new Error("DoH " + r.status); continue; }
      const j = await r.json();
      const ans = (j.Answer || []).filter(a => a.type === 16).map(a =>
        a.data.replace(/^"|"$/g, "").replace(/" "/g, ""));   // strip quotes/joins
      return ans;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("all resolvers failed");
}

// Build upstream chunk names. Conservative sizing: server reassembles by
// seq/total regardless of our chunk size, so we just stay within DNS limits.
function chunkUpstream(txid, zone, data, action) {
  const PER = 96;                                   // raw bytes per query (safe)
  const total = Math.max(1, Math.ceil(data.length / PER));
  const names = [];
  for (let seq = 0; seq < total; seq++) {
    const slice = data.slice(seq * PER, seq * PER + PER);
    const b32 = b32encodeLower(slice);
    const labels = b32.match(/.{1,60}/g) || [""];   // <=63-char labels
    names.push(`${labels.join(".")}.${seq}.${total}.${txid}.${action}.${zone}`);
  }
  return names;
}

// ---- high-level client -----------------------------------------------------

export class QuantumChat {
  constructor({ zone, resolvers } = {}) {
    this.zone = zone;                                // e.g. "qc.example.com"
    this.resolvers = resolvers || DEFAULT_DOH;
    this.self = null;                                // identity
    this.contacts = new Map();                       // id -> {signPub, dhPub, name, verified}
    this.emergency = false;
  }

  async createIdentity() { this.self = await generateIdentity(); return this.self.id; }
  myId() { return this.self?.id; }
  async myFingerprint() { return fingerprint(this.self.signPub, this.self.dhPub); }
  setEmergencyMode(on) { this.emergency = !!on; }    // gates WS vs DNS in the SPA

  // Publish our public keys to the node (self-signed over our derived ID).
  async register() {
    const id = this.self.id;
    const sig = new Uint8Array(await crypto.subtle.sign(
      "Ed25519", this.self.signPriv, enc.encode("qc-reg/v1" + id)));
    const payload = concat(this.self.signPub, this.self.dhPub, sig);   // 128 bytes
    const txid = rnd();
    const names = chunkUpstream(txid, this.zone, payload, "r");
    let last;
    for (const n of names) last = await dohTXT(n, this.resolvers);
    if (!last || !/^OK /.test(last[0] || "")) throw new Error("register failed: " + (last && last[0]));
    return id;
  }

  // Look up a contact's public keys by ID and verify self-certification.
  async addContact(rawId, displayName) {
    const id = rawId.toUpperCase().replace(/[-\s]/g, "");
    const res = await dohTXT(`${rnd()}.${id}.k.${this.zone}`, this.resolvers);
    if (!res.length || res[0] === "NF") throw new Error("unknown ID");
    const keys = b64urlDecode(res.join(""));
    if (keys.length !== 64) throw new Error("bad key blob");
    const signPub = keys.slice(0, 32), dhPub = keys.slice(32, 64);
    if (await deriveId(signPub, dhPub) !== id) throw new Error("ID/key mismatch (possible MITM)");
    const fp = await fingerprint(signPub, dhPub);
    this.contacts.set(id, { signPub, dhPub, name: displayName || id, verified: false, fingerprint: fp });
    return { id, fingerprint: fp };   // compare fingerprint out of band, then mark verified
  }

  markVerified(id) { const c = this.contacts.get(id); if (c) c.verified = true; }

  // Send an encrypted text message to a contact. Returns the message txid.
  async send(recipientID, text) {
    const c = this.contacts.get(recipientID);
    if (!c) throw new Error("add the contact first");
    const env = await seal(this.self, recipientID, c.dhPub, text);
    const txid = rnd();
    const names = chunkUpstream(txid, this.zone, env, "s");
    let last;
    for (const n of names) last = await dohTXT(n, this.resolvers);
    if (!last || !/^(DONE|DUP) /.test(last[0] || "")) throw new Error("send failed: " + (last && last[0]));
    return txid;
  }

  // Poll our inbox; decrypt and return any received messages, then ack them.
  async poll() {
    const id = this.self.id;
    const out = [];
    // Drain: each poll returns the oldest message; ack removes it, then repeat.
    for (let guard = 0; guard < 50; guard++) {
      let frames = [], total = 0, txid = null, offset = 0;
      do {
        const res = await dohTXT(`${rnd()}.${offset}.${id}.p.${this.zone}`, this.resolvers);
        if (!res.length) return out;
        const hdr = (res[0] || "").split(/\s+/);     // v1 <txid> <total> <offset> <count>
        if (hdr[1] === "-" || hdr.length < 5) return out;
        txid = hdr[1]; total = parseInt(hdr[2], 10);
        const count = parseInt(hdr[4], 10);
        frames = frames.concat(res.slice(1, 1 + count));
        offset += count;
      } while (offset < total);

      try {
        const env = b64urlDecode(frames.join(""));
        const senderID = new TextDecoder().decode(env.slice(1, 21));
        const c = [...this.contacts.values()].find(x => x.id === senderID) ||
                  this.contacts.get(senderID);
        // If sender unknown, fetch+verify their keys first.
        let signPub = c?.signPub;
        if (!signPub) {
          const info = await this.addContact(senderID).catch(() => null);
          signPub = info ? this.contacts.get(senderID).signPub : null;
        }
        if (signPub) {
          const msg = await open(this.self, signPub, env);
          out.push({ from: msg.senderID, text: msg.text, txid });
        }
      } catch (e) { /* drop undecryptable; still ack to avoid poison-looping */ }

      await dohTXT(`${rnd()}.${txid}.${id}.a.${this.zone}`, this.resolvers); // ack/delete
    }
    return out;
  }

  clearLocalCache() { this.contacts.clear(); }
}

export default QuantumChat;
