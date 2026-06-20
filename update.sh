#!/bin/bash
# ============================================================================
#  DrFX Quant - In-place Updater
#  Refreshes an EXISTING install with new code WITHOUT re-running first-time setup.
#
#  PRESERVES : your .env (domain, admin, secrets), the PostgreSQL database and all
#              its data, and the uploads/ folder.
#  UPDATES   : application code, Node dependencies, and applies any NEW database
#              migrations (already-applied ones are skipped via schema_migrations).
#  DOES NOT  : recreate the database, change the domain/admin, rewrite nginx, or
#              re-issue SSL. Use:  sudo bash manage.sh   for those.
#
#  Usage:
#     cd <your DrFXQuant checkout>
#     git pull                 # fetch the new version (update.sh can also do this)
#     sudo bash update.sh
#
#  Safe to re-run. On any migration error it stops BEFORE restarting, so the
#  currently-running version keeps serving.
# ============================================================================
set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
APP_DIR="/var/www/drfx-quantum"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PM2_NAME="drfx-quantum"

[ "$EUID" -ne 0 ] && echo -e "${RED}X Run as root: sudo bash update.sh${NC}" && exit 1

echo ""
echo -e "${CYAN}${BOLD}  DrFX Quant - Update${NC}"

# 1) Must already be installed.
if [ ! -f "$APP_DIR/.env" ]; then
  echo -e "${RED}X No existing install found at $APP_DIR (.env missing).${NC}"
  echo -e "${YELLOW}  This is the updater. For a first-time install run:  sudo bash install.sh${NC}"
  exit 1
fi
# 2) Must be run from a checkout that actually contains the app.
if [ ! -f "$SRC_DIR/server.js" ]; then
  echo -e "${RED}X Run this from your DrFXQuant checkout (server.js not found next to update.sh).${NC}"
  exit 1
fi
if [ "$SRC_DIR" = "$APP_DIR" ]; then
  echo -e "${RED}X Run update.sh from your git checkout, not from the live app directory ($APP_DIR).${NC}"
  echo -e "${YELLOW}  Example:  cd ~/DrFXQuant && git pull && sudo bash update.sh${NC}"
  exit 1
fi
echo -e "  ${GREEN}OK${NC} Existing install detected at $APP_DIR"

# 3) Pull the latest code if this is a git checkout (best-effort, never clobbers).
if [ -d "$SRC_DIR/.git" ] && command -v git >/dev/null 2>&1; then
  echo -e "${CYAN}> Fetching latest from git...${NC}"
  git -C "$SRC_DIR" pull --ff-only 2>&1 | tail -2 \
    || echo -e "${YELLOW}  ! git pull skipped (local changes or non-fast-forward) - updating from current files.${NC}"
fi

# 4) Back up the live .env (instant safety net; keep the last several).
cp "$APP_DIR/.env" "$APP_DIR/.env.bak.$(date +%Y%m%d-%H%M%S)"
ls -1t "$APP_DIR"/.env.bak.* 2>/dev/null | tail -n +11 | xargs -r rm -f
echo -e "  ${GREEN}OK${NC} Backed up .env"

# 5) Copy updated code. .env, uploads/, and the database are NOT in this set,
#    so they are left exactly as-is.
echo -e "${CYAN}> Updating application files...${NC}"
cp "$SRC_DIR/server.js" "$SRC_DIR/database.js" "$SRC_DIR/package.json" "$APP_DIR/"
cp -r "$SRC_DIR/routes" "$SRC_DIR/public" "$APP_DIR/"
for d in middleware services migrations realtime qntm-ledger scripts; do
  [ -d "$SRC_DIR/$d" ] && cp -r "$SRC_DIR/$d" "$APP_DIR/"
done
if [ -d "$SRC_DIR/quantum-chat/web" ]; then
  mkdir -p "$APP_DIR/quantum-chat"
  cp -r "$SRC_DIR/quantum-chat/web" "$APP_DIR/quantum-chat/"
fi
for f in uninstall.sh update.sh manage.sh setup-live-sfu.sh INTEGRATION.md; do
  [ -f "$SRC_DIR/$f" ] && cp "$SRC_DIR/$f" "$APP_DIR/"
done
echo -e "  ${GREEN}OK${NC} Code updated (.env, uploads/, and database untouched)"

# Guard: server.js require()s ./realtime/* at boot - fail before restart if missing.
if [ ! -f "$APP_DIR/realtime/messaging.js" ]; then
  echo -e "${RED}X realtime/ modules missing from $APP_DIR - aborting before restart.${NC}"
  echo -e "${YELLOW}  Ensure realtime/ exists in this checkout (commit & push it if you deploy via git).${NC}"
  exit 1
fi

# 6) Dependencies (only meaningful if package.json changed; npm is a no-op otherwise).
cd "$APP_DIR"
echo -e "${CYAN}> Installing dependencies...${NC}"
npm install --production 2>&1 | tail -1
echo -e "  ${GREEN}OK${NC} Dependencies in sync"

# 7) Schema: base tables are idempotent; migrations are applied once and tracked.
echo -e "${CYAN}> Database schema + migrations...${NC}"
node -e "require('dotenv').config(); require('./database').initDB().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})" \
  && echo -e "  ${GREEN}OK${NC} Base schema in sync" \
  || { echo -e "${RED}X Base schema step failed (check PostgreSQL / DATABASE_URL).${NC}"; exit 1; }

DB_NAME="$(grep -E '^DB_NAME=' .env | head -1 | cut -d= -f2-)"; DB_NAME="${DB_NAME:-drfx_quantum}"
if ls "$APP_DIR"/migrations/*.sql >/dev/null 2>&1; then
  sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 \
    -c "CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz DEFAULT now());" >/dev/null
  APPLIED_ANY=0
  for f in $(ls "$APP_DIR"/migrations/*.sql | sort); do
    base="$(basename "$f")"
    done_already="$(sudo -u postgres psql -d "$DB_NAME" -tAc "SELECT 1 FROM schema_migrations WHERE filename='$base'" 2>/dev/null)"
    if [ "$done_already" = "1" ]; then
      echo -e "    ${YELLOW}-${NC} $base ${YELLOW}(already applied, skipped)${NC}"
      continue
    fi
    echo -e "    ${CYAN}>${NC} $base"
    sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$f" >/dev/null \
      && sudo -u postgres psql -d "$DB_NAME" -c "INSERT INTO schema_migrations(filename) VALUES('$base') ON CONFLICT DO NOTHING" >/dev/null \
      && { echo -e "    ${GREEN}OK${NC} applied"; APPLIED_ANY=1; } \
      || { echo -e "${RED}X Migration failed: $base${NC}"; echo -e "${YELLOW}  The old version is still running. Fix the error and re-run update.sh.${NC}"; exit 1; }
  done
  [ "$APPLIED_ANY" -eq 0 ] && echo -e "  ${GREEN}OK${NC} No new migrations" || echo -e "  ${GREEN}OK${NC} New migrations applied"
fi

# 7b) Grant the app's DB user access to every table/sequence. Migrations run as
#     the postgres superuser, so tables they create (signals, webhook_logs, ...)
#     end up owned by postgres and the app - which connects as DB_USER - then
#     gets "permission denied for table ...". Idempotent; safe to run every time.
DB_USER="$(grep -E '^DB_USER=' .env | head -1 | cut -d= -f2-)"; DB_USER="${DB_USER:-drfx}"
echo -e "${CYAN}> Ensuring table privileges for ${DB_USER}...${NC}"
if sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL
GRANT USAGE ON SCHEMA public TO ${DB_USER};
GRANT ALL ON ALL TABLES IN SCHEMA public TO ${DB_USER};
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER};
SQL
then echo -e "  ${GREEN}OK${NC} Privileges ensured"; else echo -e "${YELLOW}  ! grant step had warnings (check DB_USER in .env)${NC}"; fi

# 8) Restart (zero new config; just reload the new code + env).
echo -e "${CYAN}> Restarting service...${NC}"
pm2 restart "$PM2_NAME" --update-env 2>/dev/null || pm2 start server.js --name "$PM2_NAME" --cwd "$APP_DIR"
pm2 save >/dev/null 2>&1 || true
echo -e "  ${GREEN}OK${NC} $PM2_NAME restarted"

# Live Trading SFU sanity check. mediasoup's native build is an OPTIONAL
# dependency, so `npm install --production` SKIPS it on a host without a
# C++/python toolchain - which silently drops Live Trading back to the 15 FPS
# relay even though LIVE_SFU=on. Surface it instead of letting it fail quietly.
if grep -q '^LIVE_SFU=on' "$APP_DIR/.env" 2>/dev/null; then
  if [ -d "$APP_DIR/node_modules/mediasoup" ]; then
    echo -e "  ${GREEN}OK${NC} Live SFU enabled (mediasoup present)"
  else
    echo -e "${YELLOW}  ! LIVE_SFU=on but mediasoup is NOT installed - Live Trading is on the 15 FPS relay.${NC}"
    echo -e "${YELLOW}    Restore high-FPS streaming:  cd $SRC_DIR && sudo bash setup-live-sfu.sh${NC}"
  fi
fi

# 8b) Initial QNTM airdrop on deploy - REMOVED (by design).
#     QNTM rewards are now EVENT-DRIVEN (services/rewards.js): a user receives
#     QNTM the moment they REGISTER, upgrade to PRO, or become a CREATOR - not on
#     update. Deploys therefore never move tokens. The one-time backfill runner
#     remains available to run BY HAND if you ever need to top up pre-existing
#     accounts:
#       cd /var/www/drfx-quantum && node scripts/airdrop-initial-qntm.js            # dry run
#       cd /var/www/drfx-quantum && node scripts/airdrop-initial-qntm.js --execute  # grant

echo ""
echo -e "${GREEN}${BOLD}  Update complete.${NC}"

# 9) Show the management reference card (current config + how to change each part).
[ -f "$SRC_DIR/manage.sh" ] && bash "$SRC_DIR/manage.sh"
