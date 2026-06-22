-- ============================================================================
-- DrFX Quant — Migration 004: Chat translation cache + per-user language prefs
-- ----------------------------------------------------------------------------
-- ADDITIVE + IDEMPOTENT. Safe to run against an existing v5.x database.
--   psql "$DATABASE_URL" -1 -f migrations/004_translations.sql
--
-- Nothing here mutates or overwrites any chat message. Translations are stored
-- in their OWN table, keyed by (message_id, target_lang). The original message
-- in `messages` is never touched — translation is advisory/display-only.
--
-- These statements are mirrored in database.js initDB(), so a normal deploy
-- (git pull && update.sh restart) creates them automatically; running this file
-- by hand is optional.
-- ============================================================================

BEGIN;

-- Per-message translation cache. One row per (message, target language). The
-- source language is recorded when the provider detects it. provider lets us
-- tell which backend produced a cached row (e.g. 'libretranslate').
CREATE TABLE IF NOT EXISTS message_translations (
  id              BIGSERIAL PRIMARY KEY,
  message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  target_lang     TEXT NOT NULL,
  source_lang     TEXT,
  provider        TEXT NOT NULL DEFAULT 'libretranslate',
  translated_text TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (message_id, target_lang)            -- cache key; one translation per language
);
CREATE INDEX IF NOT EXISTS idx_msgtrans_message ON message_translations(message_id);

-- Per-user language preference + auto-translate toggle (off by default).
ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_lang      TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_translate BOOLEAN DEFAULT FALSE;

COMMIT;
