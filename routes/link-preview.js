// routes/link-preview.js
// -----------------------------------------------------------------------------
// GET /api/link-preview?url=<http(s) url>
// Fetches the target page's OpenGraph / Twitter-card metadata (title, description,
// image, site name) so the chat client can render a rich link preview - e.g. a
// TradingView script link unfurls to its chart snapshot. Auth-gated, SSRF-guarded
// (blocks private/link-local ranges and re-checks every redirect hop), body size
// and time capped, and cached in-memory. Dependency-free: uses Node 18+ global
// fetch and regex parsing (no cheerio / no new npm deps).
// -----------------------------------------------------------------------------
const express = require("express");
const dns = require("dns").promises;
const net = require("net");

const router = express.Router();
router.use((req, res, next) => req.app.get("authMiddleware")(req, res, next));

const CACHE = new Map();                 // rawUrl -> { at, data }
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h positive
const NEG_TTL_MS = 5 * 60 * 1000;        // 5m negative (avoid hammering dead links)
const CACHE_MAX = 500;
const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 512 * 1024;            // meta lives in <head>; cap the body
const MAX_REDIRECTS = 3;

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;                 // link-local
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;     // private
    if (p[0] === 192 && p[1] === 168) return true;                 // private
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;    // CGNAT
    if (p[0] >= 224) return true;                                  // multicast/reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === "::1" || s === "::") return true;
    if (s.startsWith("fc") || s.startsWith("fd")) return true;     // ULA
    if (s.startsWith("fe80")) return true;                         // link-local
    if (s.startsWith("::ffff:")) return isPrivateIP(s.slice(7));   // v4-mapped
    return false;
  }
  return true; // unknown -> unsafe
}

async function hostIsSafe(hostname) {
  if (net.isIP(hostname)) return !isPrivateIP(hostname);
  const low = String(hostname).toLowerCase();
  if (low === "localhost" || low.endsWith(".localhost") ||
      low.endsWith(".internal") || low.endsWith(".local")) return false;
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    if (!addrs.length) return false;
    for (const a of addrs) if (isPrivateIP(a.address)) return false;
    return true;
  } catch (e) { return false; }
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
  trade: "\u2122", copy: "\u00a9", reg: "\u00ae", deg: "\u00b0",
  middot: "\u00b7", laquo: "\u00ab", raquo: "\u00bb", times: "\u00d7",
};
function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(+n); } catch (e) { return m; } })
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return m; } })
    .replace(/&([a-z]+[0-9]*);/gi, (m, name) => {
      const k = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, k) ? NAMED_ENTITIES[k] : m;
    })
    .replace(/\s+/g, " ").trim();
}

function metaFromHtml(html, baseUrl) {
  const head = html.slice(0, 200000);
  const metas = {};
  const tagRe = /<meta\b[^>]*>/gi;
  let mt;
  while ((mt = tagRe.exec(head))) {
    const tag = mt[0];
    const key = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!key) continue;
    const val = (tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (val == null) continue;
    const k = key.toLowerCase();
    if (!(k in metas)) metas[k] = val;
  }
  const first = (keys) => { for (const k of keys) if (metas[k]) return metas[k]; return null; };
  let title = first(["og:title", "twitter:title"]);
  if (!title) { const t = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i); if (t) title = t[1]; }
  let description = first(["og:description", "twitter:description", "description"]);
  let image = first(["og:image:secure_url", "og:image:url", "og:image", "twitter:image", "twitter:image:src"]);
  const site = first(["og:site_name", "application-name"]);
  title = decodeEntities(title);
  description = decodeEntities(description);
  const siteName = decodeEntities(site);
  if (image) {
    image = decodeEntities(image);
    try { image = new URL(image, baseUrl).href; } catch (e) { image = null; }
    if (image && !/^https?:\/\//i.test(image)) image = null;
  }
  return {
    title: title || null,
    description: description || null,
    image: image || null,
    site: siteName || null,
  };
}

async function fetchOnce(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      redirect: "manual",
      signal: ac.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; DrFXQuantBot/1.0; +https://drfx.io)",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en",
      },
    });
  } finally { clearTimeout(timer); }
}

async function readCapped(resp) {
  const body = resp.body;
  if (!body || !body.getReader) { const t = await resp.text(); return t.slice(0, MAX_BYTES); }
  const reader = body.getReader();
  const dec = new TextDecoder("utf-8", { fatal: false });
  let received = 0, out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    out += dec.decode(value, { stream: true });
    if (received >= MAX_BYTES) { try { await reader.cancel(); } catch (e) {} break; }
  }
  out += dec.decode();
  return out;
}

function cancelBody(resp) { try { if (resp.body && resp.body.cancel) resp.body.cancel(); } catch (e) {} }

async function unfurl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch (e) { const err = new Error("bad_url"); err.code = 400; throw err; }
  if (url.protocol !== "http:" && url.protocol !== "https:") { const err = new Error("bad_scheme"); err.code = 400; throw err; }

  let current = url.href;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current);
    if (!(await hostIsSafe(u.hostname))) { const err = new Error("blocked_host"); err.code = 400; throw err; }
    const resp = await fetchOnce(current);
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      cancelBody(resp);
      if (!loc) { const err = new Error("redirect_no_location"); err.code = 502; throw err; }
      current = new URL(loc, current).href;
      continue;
    }
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("html") && !ct.includes("xml")) {
      cancelBody(resp);
      return { url: current, title: null, description: null,
        image: /^image\//.test(ct) ? current : null, site: null };
    }
    const html = await readCapped(resp);
    return Object.assign({ url: current }, metaFromHtml(html, current));
  }
  const err = new Error("too_many_redirects"); err.code = 400; throw err;
}

router.get("/", async (req, res) => {
  const raw = String(req.query.url || "").trim();
  if (!raw) return res.status(400).json({ error: "url required" });
  if (raw.length > 2048) return res.status(400).json({ error: "url too long" });

  const hit = CACHE.get(raw);
  if (hit && Date.now() - hit.at < (hit.data && hit.data.error ? NEG_TTL_MS : CACHE_TTL_MS)) {
    return res.json(hit.data);
  }

  try {
    const data = await unfurl(raw);
    if (CACHE.size >= CACHE_MAX) { const k = CACHE.keys().next().value; if (k) CACHE.delete(k); }
    CACHE.set(raw, { at: Date.now(), data });
    res.json(data);
  } catch (e) {
    const code = e.code === 400 ? 400 : 502;
    const data = { url: raw, title: null, description: null, image: null, site: null, error: e.message || "fetch_failed" };
    if (CACHE.size < CACHE_MAX) CACHE.set(raw, { at: Date.now(), data }); // NEG_TTL applies on read
    res.status(code).json(data);
  }
});

module.exports = router;
