# Chat Translation (self-hosted)

DrFX Quant has an **advisory, display-only** chat translation layer. It is
**provider-agnostic**; the bundled implementation talks to a self-hosted
[LibreTranslate](https://github.com/LibreTranslate/LibreTranslate) engine over
plain HTTP, so it runs on a normal VPS with no GPU and no third-party API.

Key properties:

- **Originals are never modified.** A translation is shown *under* the original
  message, with a "Hide" toggle. Translations are cached in the
  `message_translations` table, keyed by `(message_id, target_lang)`.
- **Per-user.** Each user picks a target language and can flip on
  "auto-translate incoming" (off by default). Preferences persist server-side.
- **Degrades gracefully.** If the engine is unset, disabled, or unreachable, the
  app hides the translate UI and chat/sockets are completely unaffected. Nothing
  about translation can break message delivery.

---

## One-command install (recommended)

Run on the server **after** the app itself is installed/updated (the translation
API routes ship with the app):

```bash
cd ~/DrFXQuant && git pull && sudo bash update.sh
sudo bash setup-translation.sh
sudo systemctl reload nginx
```

`setup-translation.sh` is idempotent and:

1. installs `python3-venv` + `pip`,
2. creates a venv and `pip install libretranslate`,
3. launches the engine under PM2 as `libretranslate` on `127.0.0.1:5000`
   (with the correct `--interpreter`, see the gotcha below),
4. waits for the language models to download,
5. writes `TRANSLATE_PROVIDER` / `TRANSLATE_URL` into the **runtime** app `.env`,
6. `pm2 save` + restarts the app, then verifies a translation.

Pick languages with `LANGS` (keep it tight — each model is resident in RAM):

```bash
sudo LANGS="en,ru,fa,ar,hi,es,fr" bash setup-translation.sh
```

Then open the app in a **private/incognito window**, open any chat, and the
globe appears in the chat header next to the info button.

---

## Manual install (what the script automates)

If you prefer to do it by hand, this is the exact sequence:

```bash
# 1. Python venv + LibreTranslate
sudo apt update
sudo apt install -y python3-pip python3-venv
python3 -m venv /opt/libretranslate-env
/opt/libretranslate-env/bin/pip install libretranslate

# 2. First run in the FOREGROUND once, to download the models, then Ctrl-C
/opt/libretranslate-env/bin/libretranslate --load-only en,ru,fa,ar,hi --host 127.0.0.1 --port 5000
#    in another terminal, confirm it answers:
curl http://127.0.0.1:5000/languages

# 3. Run it permanently under PM2.
#    NOTE the --interpreter flag — it is MANDATORY (see gotcha #1).
pm2 start /opt/libretranslate-env/bin/libretranslate \
  --name libretranslate \
  --interpreter /opt/libretranslate-env/bin/python3 \
  -- --load-only en,ru,fa,ar,hi --host 127.0.0.1 --port 5000
pm2 save

# 4. Point the app at the engine — edit the RUNTIME .env (see gotcha #2)
cd /var/www/drfx-quant
echo "TRANSLATE_PROVIDER=libretranslate" >> .env
echo "TRANSLATE_URL=http://127.0.0.1:5000" >> .env
pm2 restart drfx-quant --update-env

# 5. Reload nginx so the latest frontend is served, then hard-refresh / incognito
sudo systemctl reload nginx

# 6. Verify end-to-end (the exact request shape the app sends)
curl -s http://127.0.0.1:5000/translate -X POST -H "Content-Type: application/json" \
  -d '{"q":"hello","source":"auto","target":"fa","format":"text"}'
# -> {"detectedLanguage":{"confidence":...,"language":"en"},"translatedText":"سلام"}
```

---

## Gotchas (learned the hard way)

**1. PM2 must be told the interpreter is Python.**
`/opt/libretranslate-env/bin/libretranslate` is a Python script. Start it without
`--interpreter <venv>/bin/python3` and PM2 tries to run it as **Node**, which dies
on a loop with:

```
SyntaxError: Invalid or unexpected token   (# -*- coding: utf-8 -*-)
```

Always pass `--interpreter /opt/libretranslate-env/bin/python3`.

**2. The `.env` that matters is the RUNTIME one.**
`server.js` loads config with `require("dotenv").config()` (no path), so it reads
`.env` from the app's **working directory**. The deploy copies the app into
`/var/www/drfx-quant`, so the live `.env` is **`/var/www/drfx-quant/.env`** — *not*
the `~/DrFXQuant/.env` in your git checkout. Add `TRANSLATE_*` to the runtime file.
Confirm the directory with:

```bash
pm2 jlist | python3 -c "import sys,json; [print(p['pm2_env'].get('pm_cwd')) for p in json.load(sys.stdin) if p['name']=='drfx-quant']"
```

**3. Reload nginx + hard-refresh after deploying frontend.**
Static files are cached; run `sudo systemctl reload nginx` and test in a
**private/incognito** window, or the browser keeps the old `index.html`.

**4. Keep `--load-only` tight.**
Each language model is held in memory (~250–300 MB resident for five languages).
On a shared box also running Node + PostgreSQL + the SFU, watch `free -h`. If RAM
gets tight, move the engine to its own small box and just repoint `TRANSLATE_URL`
— no app code changes needed.

**5. `pm2 save` so it survives reboot.**
Without it, the engine won't come back after a restart and the globe silently
goes "unavailable".

---

## How it works (for contributors)

| Piece | File |
|-------|------|
| Provider-agnostic service (timeout, safe errors, never throws) | `services/translate.js` |
| API routes (status, prefs, cached per-message translate) | `routes/translate.js` |
| Browser UI (self-installing globe, auto mode, settings sheet) | `public/translate-ui.js` |
| Cache table + per-user prefs columns | `migrations/004_translations.sql` (mirrored in `database.js`) |

**API** (all authenticated):

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/translate/status` | `{ available, provider, languages }` |
| `GET`  | `/api/translate/prefs`  | `{ lang, auto }` for the current user |
| `POST` | `/api/translate/prefs`  | Update `{ lang, auto }` |
| `POST` | `/api/translate/message/:id?to=<lang>` | Translate one message (cache-first); membership-checked |

The per-message endpoint authorizes on chat membership (you can't translate a
message in a chat you're not in), returns a cache hit when present, and only then
calls the engine and stores the result. If the engine is unavailable it returns
HTTP 200 with `{ translated: null, reason: "unavailable" }` so the client hides the
UI without treating it as an error.

## Switching providers

`services/translate.js` is the only file that speaks the engine's dialect. To use
a different backend, add a branch there; callers and the database schema don't
change. Set `TRANSLATE_PROVIDER=none` (or unset it) to turn the feature off
entirely — the UI disappears and the rest of the app is unaffected.
