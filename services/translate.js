// services/translate.js
// ----------------------------------------------------------------------------
// Provider-agnostic translation layer. The ONLY backend implemented today is
// LibreTranslate (self-hosted), selected because it runs on modest hardware
// with no GPU and exposes a trivial HTTP API. Swapping providers later means
// adding another branch here — callers (routes/translate.js) never change.
//
// Configuration (.env):
//   TRANSLATE_PROVIDER = libretranslate | none      (default: none)
//   TRANSLATE_URL      = http://127.0.0.1:5000       (base URL of the engine)
//   TRANSLATE_API_KEY  = <optional>                  (sent if the engine needs it)
//   TRANSLATE_TIMEOUT_MS = 8000                       (per request)
//
// DEGRADES GRACEFULLY. If the provider is 'none', URL is unset, or the engine
// is unreachable / slow / errors, every function resolves to a soft result
// ({ ok:false, reason }) — it NEVER throws and NEVER crashes the app. Chat,
// sockets, and message delivery are completely independent of this service.
//
// Node 18+ provides global fetch + AbortController (used for timeouts).
// ----------------------------------------------------------------------------

"use strict";

const PROVIDER = String(process.env.TRANSLATE_PROVIDER || "none").toLowerCase().trim();
const BASE_URL = String(process.env.TRANSLATE_URL || "").trim().replace(/\/+$/, "");
const API_KEY = String(process.env.TRANSLATE_API_KEY || "").trim();
const TIMEOUT_MS = Math.max(1000, parseInt(process.env.TRANSLATE_TIMEOUT_MS || "8000", 10) || 8000);

const MAX_CHARS = 5000; // never ship a wall of text to the engine

// A conservative default language set for validation when the engine's own
// /languages list can't be fetched. (LibreTranslate typically supports more.)
const FALLBACK_LANGS = ["en", "ru", "fa", "ar", "hi", "es", "fr", "de", "tr", "zh", "pt", "it", "nl", "pl", "uk", "id", "ur"];

function enabled() {
  return PROVIDER === "libretranslate" && !!BASE_URL;
}

// ── languages cache (the engine's supported set; refreshed periodically) ────
let _langs = null;          // array of codes, or null until first successful fetch
let _langsAt = 0;           // last successful fetch (ms)
let _langsInFlight = null;  // de-dupe concurrent fetches
const LANGS_TTL = 10 * 60 * 1000;

async function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(to);
  }
}

async function loadLanguages() {
  if (!enabled()) return null;
  if (_langs && Date.now() - _langsAt < LANGS_TTL) return _langs;
  if (_langsInFlight) return _langsInFlight;
  _langsInFlight = (async () => {
    try {
      const r = await fetchWithTimeout(`${BASE_URL}/languages`, { method: "GET" });
      if (!r.ok) return _langs; // keep whatever we had
      const data = await r.json();
      if (Array.isArray(data)) {
        _langs = data.map((l) => String(l.code || "").toLowerCase()).filter(Boolean);
        _langsAt = Date.now();
      }
      return _langs;
    } catch (e) {
      return _langs; // unreachable -> keep stale (possibly null)
    } finally {
      _langsInFlight = null;
    }
  })();
  return _langsInFlight;
}

// Public: availability + supported languages (for the UI picker + validation).
async function status() {
  if (!enabled()) {
    return { available: false, provider: PROVIDER === "libretranslate" ? "libretranslate" : "none", languages: [] };
  }
  const langs = await loadLanguages();
  // available only if we could actually reach the engine at least once
  const available = Array.isArray(langs) && langs.length > 0;
  return { available, provider: "libretranslate", languages: langs || [] };
}

// Validate a target code: lowercase 2–5 letters, and — if we know the engine's
// list — actually supported. Falls back to a static allowlist otherwise.
function isValidLang(code) {
  const c = String(code || "").toLowerCase().trim();
  if (!/^[a-z]{2,5}$/.test(c)) return false;
  if (Array.isArray(_langs) && _langs.length) return _langs.includes(c);
  return FALLBACK_LANGS.includes(c);
}

// Core: translate `text` into `target`. Auto-detects the source so we also learn
// the source language (returned to the caller / cached). Returns a soft result;
// never throws.
//
//   { ok:true,  translated, source_lang, provider }
//   { ok:false, reason: "disabled"|"unsupported"|"empty"|"too_long"|"timeout"|"bad_status"|"error" }
async function translate(text, target) {
  if (!enabled()) return { ok: false, reason: "disabled" };
  const q = String(text == null ? "" : text);
  if (!q.trim()) return { ok: false, reason: "empty" };
  if (q.length > MAX_CHARS) return { ok: false, reason: "too_long" };

  // refresh the language list opportunistically so isValidLang is accurate
  await loadLanguages().catch(() => {});
  if (!isValidLang(target)) return { ok: false, reason: "unsupported" };

  const body = { q, source: "auto", target: String(target).toLowerCase(), format: "text" };
  if (API_KEY) body.api_key = API_KEY;

  try {
    const r = await fetchWithTimeout(`${BASE_URL}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, reason: "bad_status", status: r.status };
    const data = await r.json();
    const translated = data && typeof data.translatedText === "string" ? data.translatedText : null;
    if (translated == null) return { ok: false, reason: "error" };
    const source_lang =
      data && data.detectedLanguage && data.detectedLanguage.language
        ? String(data.detectedLanguage.language).toLowerCase()
        : null;
    return { ok: true, translated, source_lang, provider: "libretranslate" };
  } catch (e) {
    const reason = e && e.name === "AbortError" ? "timeout" : "error";
    if (reason !== "timeout") console.error("[translate] error:", e && e.message);
    return { ok: false, reason };
  }
}

module.exports = { enabled, status, translate, isValidLang, PROVIDER };
