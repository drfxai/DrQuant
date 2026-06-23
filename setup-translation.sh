#!/usr/bin/env bash
# ============================================================================
#  DrFX Quant - Chat Translation: LibreTranslate (self-hosted) installer
# ----------------------------------------------------------------------------
#  Run this ON THE UBUNTU SERVER as root, AFTER the app is installed/updated
#  (it needs the /api/translate routes, i.e. run install.sh or update.sh first):
#
#       cd ~/DrFXQuant && git pull && sudo bash update.sh
#       sudo bash setup-translation.sh
#
#  It is idempotent (safe to re-run) and does:
#    1. install python3 venv + pip (apt)
#    2. create a venv and pip-install LibreTranslate
#    3. launch it under PM2 as 'libretranslate', bound to 127.0.0.1:5000
#       (CRITICAL: with --interpreter <venv python>, because PM2 would otherwise
#        try to run the Python launcher as Node and crash-loop)
#    4. wait for the language models to download and the engine to answer
#    5. write TRANSLATE_PROVIDER / TRANSLATE_URL into the RUNTIME app .env
#       (/var/www/drfx-quant/.env — NOT the git checkout's .env)
#    6. pm2 save + restart the app so it picks up the new env
#    7. verify the engine translates
#
#  Override defaults via env, e.g.:
#       sudo LANGS="en,ru,fa,ar,hi,es" PORT=5000 bash setup-translation.sh
#
#  The translation feature DEGRADES GRACEFULLY: if this engine is absent, the
#  app simply hides the translate UI. So the platform runs fine without it; this
#  script is what turns the feature ON.
# ============================================================================
set -euo pipefail

# ---- settings (override via environment) -----------------------------------
APP_DIR="${APP_DIR:-/var/www/drfx-quant}"      # the RUNTIME app dir (reads .env from here)
PM2_APP="${PM2_APP:-drfx-quant}"               # the main app's PM2 name
PM2_ENGINE="${PM2_ENGINE:-libretranslate}"     # PM2 name for the engine
VENV_DIR="${VENV_DIR:-/opt/libretranslate-env}"
HOST="${HOST:-127.0.0.1}"                      # bind loopback only (app talks to it locally)
PORT="${PORT:-5000}"
LANGS="${LANGS:-en,ru,fa,ar,hi}"               # keep tight: each model is resident in RAM
ENV_FILE="$APP_DIR/.env"
BASE_URL="http://${HOST}:${PORT}"

c(){ echo; echo "==> $*"; }
warn(){ echo "  ! $*"; }
ok(){ echo "  OK $*"; }

# ---- preconditions ---------------------------------------------------------
[ "$(id -u)" -eq 0 ] || { echo "Run as root:  sudo bash $0"; exit 1; }
command -v pm2 >/dev/null 2>&1 || { echo "pm2 not found. Install the app first (install.sh)."; exit 1; }
if [ ! -f "$ENV_FILE" ]; then
  warn "App .env not found at $ENV_FILE"
  warn "Set APP_DIR to the directory the app actually runs from, e.g.:"
  warn "    sudo APP_DIR=\$(pm2 jlist | python3 -c \"import sys,json;[print(p['pm2_env']['pm_cwd']) for p in json.load(sys.stdin) if p['name']=='${PM2_APP}']\") bash $0"
  exit 1
fi

# ---- 1. system packages ----------------------------------------------------
c "Installing python3 venv + pip (apt)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y python3 python3-venv python3-pip curl
ok "packages installed"

# ---- 2. venv + LibreTranslate ---------------------------------------------
c "Creating venv and installing LibreTranslate at $VENV_DIR (can take a few minutes)"
if [ ! -x "$VENV_DIR/bin/libretranslate" ]; then
  python3 -m venv "$VENV_DIR"
  "$VENV_DIR/bin/pip" install --upgrade pip >/dev/null 2>&1 || true
  "$VENV_DIR/bin/pip" install libretranslate
  ok "LibreTranslate installed"
else
  ok "LibreTranslate already present (skipping pip)"
fi

# ---- 3. (re)launch the engine under PM2 ------------------------------------
# NOTE: --interpreter is MANDATORY. The launcher at $VENV_DIR/bin/libretranslate
# is a Python script; without telling PM2 to use the venv's python, PM2 runs it
# as Node and dies with "SyntaxError: Invalid or unexpected token" on a loop.
c "Starting the engine under PM2 as '$PM2_ENGINE' ($HOST:$PORT, langs: $LANGS)"
pm2 delete "$PM2_ENGINE" >/dev/null 2>&1 || true
pm2 start "$VENV_DIR/bin/libretranslate" \
  --name "$PM2_ENGINE" \
  --interpreter "$VENV_DIR/bin/python3" \
  -- --load-only "$LANGS" --host "$HOST" --port "$PORT"
pm2 save >/dev/null 2>&1 || true
ok "engine launched under PM2 (and saved to the boot list)"

# ---- 4. wait for models to download + engine to answer ---------------------
c "Waiting for the engine to load language models (first run downloads them)…"
ENGINE_OK=0
for i in $(seq 1 60); do          # up to ~5 minutes
  if curl -fsS "${BASE_URL}/languages" >/dev/null 2>&1; then ENGINE_OK=1; break; fi
  sleep 5
done
if [ $ENGINE_OK -eq 1 ]; then ok "engine is answering at ${BASE_URL}/languages"; else
  warn "engine did not answer within the timeout."
  warn "check its logs:  pm2 logs $PM2_ENGINE --lines 40"
  warn "(models can be large on a slow link; re-run this script once it's done)"
  exit 1
fi

# ---- 5. point the app at the engine (RUNTIME .env) -------------------------
c "Writing TRANSLATE_* into $ENV_FILE"
set_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}
set_env "TRANSLATE_PROVIDER" "libretranslate"
set_env "TRANSLATE_URL" "$BASE_URL"
ok "app pointed at $BASE_URL"

# ---- 6. restart the app so dotenv reloads the new vars ---------------------
c "Restarting the app ($PM2_APP) with the updated environment"
pm2 restart "$PM2_APP" --update-env
ok "app restarted"

# ---- 7. verify end-to-end --------------------------------------------------
c "Verifying a translation through the engine"
RESP="$(curl -fsS -m 10 "${BASE_URL}/translate" -X POST -H 'Content-Type: application/json' \
        -d '{"q":"hello","source":"auto","target":"fa","format":"text"}' 2>/dev/null || true)"
if echo "$RESP" | grep -q 'translatedText'; then
  ok "engine translated: $RESP"
else
  warn "verification call did not return a translation: ${RESP:-<empty>}"
fi

cat <<DONE

============================================================================
 Chat translation is installed.
----------------------------------------------------------------------------
 Engine (PM2):   $PM2_ENGINE  ->  $BASE_URL   (languages: $LANGS)
 App env:        $ENV_FILE  (TRANSLATE_PROVIDER, TRANSLATE_URL)

 LAST STEP — serve the latest frontend and clear the cache, then verify:
     sudo systemctl reload nginx
   Open the app in a PRIVATE/INCOGNITO window, open any chat, and the globe
   appears in the chat header (next to the info button). Tap it to pick a
   language / enable auto-translate; long-press a foreign message -> Translate.

 Tips:
   * Keep --load-only tight; each language model stays resident in RAM
     (~250-300 MB total for 5 languages). Add languages with, e.g.:
         sudo LANGS="en,ru,fa,ar,hi,es,fr" bash setup-translation.sh
   * Engine logs:    pm2 logs $PM2_ENGINE
   * Turn it back off: pm2 delete $PM2_ENGINE  (the app auto-hides the UI)
============================================================================
DONE
