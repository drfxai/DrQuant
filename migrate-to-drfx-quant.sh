#!/bin/bash
# ============================================================================
#  DrFX Quant — one-time RENAME migration:  drfx-quantum  ->  drfx-quant
# ----------------------------------------------------------------------------
#  Moves the LIVE deployment's operational identifiers onto the new name, in
#  place, with no data copy:
#
#     app dir    /var/www/drfx-quantum     ->  /var/www/drfx-quant
#     database   drfx_quantum              ->  drfx_quant         (ALTER ... RENAME)
#     PM2 proc   drfx-quantum              ->  drfx-quant
#     nginx site drfx-quantum              ->  drfx-quant
#     bot email  ai@drfx.quantum           ->  ai@drfx.quant
#     .env       DB_NAME / DATABASE_URL    ->  drfx_quant
#
#  Run ONCE on the server, as root, from your checkout AFTER pulling the renamed
#  code:
#
#       cd ~/DrFXQuant && git pull && sudo bash migrate-to-drfx-quant.sh
#
#  SAFETY
#    • Backs up the database (pg_dump -Fc) and .env BEFORE any change.
#    • RENAMEs the database (a catalog change — instant, no data copied/dropped).
#    • Idempotent: safe to re-run; each step checks whether it's already done.
#    • The app is stopped for the brief rename window, then started under the
#      new name. The old database is never dropped.
#    • Prints verification + rollback steps at the end.
# ============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

OLD_DIR="/var/www/drfx-quantum";  NEW_DIR="/var/www/drfx-quant"
OLD_DB="drfx_quantum";            NEW_DB="drfx_quant"
OLD_PM2="drfx-quantum";           NEW_PM2="drfx-quant"
OLD_SITE="/etc/nginx/sites-available/drfx-quantum"; NEW_SITE="/etc/nginx/sites-available/drfx-quant"
OLD_LINK="/etc/nginx/sites-enabled/drfx-quantum";   NEW_LINK="/etc/nginx/sites-enabled/drfx-quant"

[ "$(id -u)" -eq 0 ] || { echo -e "${RED}Run as root:  sudo bash $0${NC}"; exit 1; }

echo ""
echo -e "${CYAN}${BOLD}  DrFX Quant — rename migration  (drfx-quantum -> drfx-quant)${NC}"
echo ""

db_exists() { sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$1'" 2>/dev/null | grep -q 1; }

# Which app dir / database are live? (supports a re-run after a partial pass)
APP_DIR=""; if [ -d "$NEW_DIR" ]; then APP_DIR="$NEW_DIR"; elif [ -d "$OLD_DIR" ]; then APP_DIR="$OLD_DIR"; fi
[ -n "$APP_DIR" ] || { echo -e "${RED}X Neither $OLD_DIR nor $NEW_DIR exists — nothing to migrate.${NC}"; exit 1; }
CUR_DB=""; if db_exists "$NEW_DB"; then CUR_DB="$NEW_DB"; elif db_exists "$OLD_DB"; then CUR_DB="$OLD_DB"; fi
[ -n "$CUR_DB" ] || { echo -e "${RED}X Neither database $OLD_DB nor $NEW_DB exists.${NC}"; exit 1; }

# ---- 0) BACKUP first (always, before any change) ---------------------------
TS="$(date +%Y%m%d-%H%M%S)"; BK="/root/drfx-rename-backup-$TS"; mkdir -p "$BK"
echo -e "${CYAN}> Backing up database '$CUR_DB' + .env to $BK ...${NC}"
# NOTE: redirect with '>' (the file is opened by THIS root shell) rather than
# pg_dump -f (which makes the postgres user open it) — /root isn't traversable
# by postgres, so -f fails with EACCES. With '>' pg_dump just writes to the fd.
sudo -u postgres pg_dump -Fc -d "$CUR_DB" > "$BK/$CUR_DB.dump"
[ -f "$APP_DIR/.env" ] && cp "$APP_DIR/.env" "$BK/env.backup" || true
echo -e "  ${GREEN}OK${NC} backup saved"

# ---- 1) Stop the app (try both names) --------------------------------------
echo -e "${CYAN}> Stopping the app...${NC}"
pm2 stop "$OLD_PM2" >/dev/null 2>&1 || true
pm2 stop "$NEW_PM2" >/dev/null 2>&1 || true

# ---- 2) Rename the database (do this first; if it fails nothing else moved)--
#     Needs no active connections; the app is stopped, and we terminate any
#     stragglers in the same session right before the rename.
if db_exists "$OLD_DB" && ! db_exists "$NEW_DB"; then
  echo -e "${CYAN}> Renaming database $OLD_DB -> $NEW_DB ...${NC}"
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$OLD_DB' AND pid <> pg_backend_pid();
ALTER DATABASE $OLD_DB RENAME TO $NEW_DB;
SQL
  echo -e "  ${GREEN}OK${NC} database renamed"
else
  echo -e "  ${YELLOW}-${NC} database already $NEW_DB (skip)"
fi

# ---- 3) Move the application directory --------------------------------------
if [ -d "$OLD_DIR" ] && [ ! -d "$NEW_DIR" ]; then
  mv "$OLD_DIR" "$NEW_DIR"
  echo -e "  ${GREEN}OK${NC} moved $OLD_DIR -> $NEW_DIR"
else
  echo -e "  ${YELLOW}-${NC} app dir already $NEW_DIR (skip move)"
fi
APP_DIR="$NEW_DIR"

# ---- 4) Patch the moved .env (DB_NAME + DATABASE_URL) -----------------------
if [ -f "$APP_DIR/.env" ]; then
  echo -e "${CYAN}> Patching $APP_DIR/.env ...${NC}"
  cp "$APP_DIR/.env" "$APP_DIR/.env.bak.$TS"
  sed -i "s/^DB_NAME=${OLD_DB}\$/DB_NAME=${NEW_DB}/" "$APP_DIR/.env"
  sed -i "s#/${OLD_DB}#/${NEW_DB}#g" "$APP_DIR/.env"   # DATABASE_URL .../drfx_quantum -> .../drfx_quant
  echo -e "  ${GREEN}OK${NC} .env updated (DB_NAME, DATABASE_URL)"
fi

# ---- 5) Migrate the AI bot's internal email --------------------------------
echo -e "${CYAN}> Updating AI bot email (ai@drfx.quantum -> ai@drfx.quant)...${NC}"
sudo -u postgres psql -d "$NEW_DB" -c \
  "UPDATE users SET email='ai@drfx.quant' WHERE role='bot' AND email='ai@drfx.quantum';" >/dev/null 2>&1 \
  && echo -e "  ${GREEN}OK${NC} bot email updated (if it existed)" || true

# ---- 6) nginx site rename (+ patch any old path inside) + reload ------------
echo -e "${CYAN}> Renaming nginx site...${NC}"
if [ -f "$OLD_SITE" ] && [ ! -f "$NEW_SITE" ]; then mv "$OLD_SITE" "$NEW_SITE"; fi
[ -f "$NEW_SITE" ] && sed -i "s#${OLD_DIR}#${NEW_DIR}#g" "$NEW_SITE" || true
rm -f "$OLD_LINK"
[ -f "$NEW_SITE" ] && ln -sf "$NEW_SITE" "$NEW_LINK" || true
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx; echo -e "  ${GREEN}OK${NC} nginx site renamed + reloaded"
else
  echo -e "  ${YELLOW}!${NC} nginx -t failed — check $NEW_SITE before reloading"
fi

# ---- 7) Re-register PM2 under the new name from the new dir -----------------
echo -e "${CYAN}> Restarting under PM2 as $NEW_PM2 ...${NC}"
pm2 delete "$OLD_PM2" >/dev/null 2>&1 || true
if pm2 describe "$NEW_PM2" >/dev/null 2>&1; then
  pm2 restart "$NEW_PM2" --update-env >/dev/null 2>&1 || true
else
  ( cd "$APP_DIR" && pm2 start server.js --name "$NEW_PM2" --cwd "$APP_DIR" )
fi
pm2 save >/dev/null 2>&1 || true
echo -e "  ${GREEN}OK${NC} $NEW_PM2 running"

# ---- 8) Done: verify + rollback -------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}  Rename complete.${NC}"
echo ""
echo -e "  ${BOLD}Verify:${NC}"
echo -e "    pm2 status"
echo -e "    pm2 logs $NEW_PM2 --lines 30 --nostream      # clean boot, no DB errors"
echo -e "    curl -i http://127.0.0.1:3000/                # backend answers"
echo -e "    sudo -u postgres psql -lqt | grep drfx        # shows $NEW_DB"
echo -e "    sudo bash $NEW_DIR/manage.sh                   # dashboard shows drfx-quant"
echo ""
echo -e "  ${YELLOW}${BOLD}Rollback${NC} (only if something is wrong):"
echo -e "    pm2 delete $NEW_PM2"
echo -e "    sudo -u postgres psql -c \"ALTER DATABASE $NEW_DB RENAME TO $OLD_DB;\""
echo -e "    mv $NEW_DIR $OLD_DIR"
echo -e "    cp $BK/env.backup $OLD_DIR/.env"
echo -e "    ( cd $OLD_DIR && pm2 start server.js --name $OLD_PM2 --cwd $OLD_DIR ) && pm2 save"
echo -e "    # full DB backup if ever needed:  $BK/$CUR_DB.dump"
echo ""
