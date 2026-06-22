// routes/translate.js
// ----------------------------------------------------------------------------
// Chat translation API. Mounted in server.js:
//
//   app.use("/api/translate", require("./routes/translate"));
//
// All routes authenticated (any logged-in user). Translation is advisory and
// display-only — the original message is NEVER modified. Results are cached in
// message_translations (Postgres) keyed by (message_id, target_lang); the
// provider is only called on a cache miss.
//
//   GET  /api/translate/status                 -> { available, provider, languages }
//   GET  /api/translate/prefs                  -> { lang, auto }
//   POST /api/translate/prefs  {lang,auto}     -> { lang, auto }
//   POST /api/translate/message/:id?to=<lang>  -> { original, translated, ... } | { translated:null, reason }
//
// If the provider is missing / disabled / unreachable, endpoints degrade
// gracefully (HTTP 200 with translated:null + a reason) so the client can hide
// the UI quietly without treating it as an error. Requires migration 004
// (message_translations + users.pref_lang/auto_translate), mirrored in
// database.js so a normal deploy creates it.
// ----------------------------------------------------------------------------

const express = require("express");
const router = express.Router();
const translator = require("../services/translate");

// Auth for every route here (mirrors routes/manage.js / routes/signals.js).
router.use((req, res, next) => req.app.get("authMiddleware")(req, res, next));

// ── GET /status — provider availability + supported languages ─────────────
router.get("/status", async (req, res) => {
  try {
    const st = await translator.status();
    res.json(st);
  } catch (e) {
    res.json({ available: false, provider: "none", languages: [] });
  }
});

// ── GET /prefs — this user's language + auto-translate toggle ─────────────
router.get("/prefs", async (req, res) => {
  const pool = req.app.get("pool");
  try {
    const { rows: [u] } = await pool.query(
      "SELECT pref_lang, auto_translate FROM users WHERE id=$1",
      [req.user.id]
    );
    res.json({ lang: (u && u.pref_lang) || "", auto: !!(u && u.auto_translate) });
  } catch (e) {
    // columns missing (pre-migration) or DB hiccup -> safe defaults
    res.json({ lang: "", auto: false });
  }
});

// ── POST /prefs — update language / auto-translate ────────────────────────
router.post("/prefs", async (req, res) => {
  const pool = req.app.get("pool");
  const body = req.body || {};
  const sets = [], vals = [];
  let i = 1;

  if (body.lang !== undefined) {
    let lang = String(body.lang || "").toLowerCase().trim();
    if (lang && !/^[a-z]{2,5}$/.test(lang)) return res.status(400).json({ error: "Invalid language code" });
    sets.push(`pref_lang=$${i++}`); vals.push(lang.slice(0, 5));
  }
  if (body.auto !== undefined) {
    sets.push(`auto_translate=$${i++}`); vals.push(!!body.auto);
  }
  if (!sets.length) return res.status(400).json({ error: "Nothing to update" });

  vals.push(req.user.id);
  try {
    const { rows: [u] } = await pool.query(
      `UPDATE users SET ${sets.join(",")} WHERE id=$${i} RETURNING pref_lang, auto_translate`,
      vals
    );
    res.json({ lang: (u && u.pref_lang) || "", auto: !!(u && u.auto_translate) });
  } catch (e) {
    console.error("[translate] prefs save:", e.message);
    res.status(500).json({ error: "Could not save preferences" });
  }
});

// ── POST /message/:id?to=<lang> — translate one message (cached) ──────────
router.post("/message/:id", async (req, res) => {
  const pool = req.app.get("pool");
  const messageId = parseInt(req.params.id, 10);
  const target = String(req.query.to || req.body.to || "").toLowerCase().trim();

  if (!Number.isInteger(messageId)) return res.status(400).json({ error: "Invalid message id" });
  if (!/^[a-z]{2,5}$/.test(target)) return res.status(400).json({ error: "Invalid target language" });

  try {
    // Authorization: the requester must be a MEMBER of the chat this message
    // belongs to — never let a user translate arbitrary messages by id.
    const { rows: [row] } = await pool.query(
      `SELECT m.id, m.content, m.chat_id,
              EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = m.chat_id AND cm.user_id = $2) AS is_member
         FROM messages m WHERE m.id = $1`,
      [messageId, req.user.id]
    );
    if (!row) return res.status(404).json({ error: "Message not found" });
    if (!row.is_member) return res.status(403).json({ error: "Not allowed" });
    if (!row.content || !row.content.trim()) {
      return res.json({ message_id: messageId, translated: null, reason: "empty" });
    }

    // 1) cache hit?
    const { rows: [cached] } = await pool.query(
      "SELECT source_lang, provider, translated_text FROM message_translations WHERE message_id=$1 AND target_lang=$2",
      [messageId, target]
    );
    if (cached) {
      return res.json({
        message_id: messageId,
        target_lang: target,
        source_lang: cached.source_lang || null,
        provider: cached.provider,
        original: row.content,
        translated: cached.translated_text,
        same: !!(cached.source_lang && cached.source_lang === target),
        cached: true,
      });
    }

    // 2) provider available?
    if (!translator.enabled()) {
      return res.json({ message_id: messageId, translated: null, reason: "unavailable" });
    }

    // 3) call provider on miss
    const out = await translator.translate(row.content, target);
    if (!out.ok) {
      return res.json({ message_id: messageId, translated: null, reason: out.reason || "unavailable" });
    }

    // 4) persist (best-effort; a cache write failure must not fail the response)
    pool.query(
      `INSERT INTO message_translations (message_id, target_lang, source_lang, provider, translated_text, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (message_id, target_lang)
       DO UPDATE SET translated_text=EXCLUDED.translated_text, source_lang=EXCLUDED.source_lang,
                     provider=EXCLUDED.provider, updated_at=NOW()`,
      [messageId, target, out.source_lang || null, out.provider || "libretranslate", out.translated]
    ).catch((e) => console.error("[translate] cache write:", e.message));

    return res.json({
      message_id: messageId,
      target_lang: target,
      source_lang: out.source_lang || null,
      provider: out.provider || "libretranslate",
      original: row.content,
      translated: out.translated,
      same: !!(out.source_lang && out.source_lang === target),
      cached: false,
    });
  } catch (e) {
    console.error("[translate] message error:", e.message);
    res.status(500).json({ error: "Translation failed" });
  }
});

module.exports = router;
