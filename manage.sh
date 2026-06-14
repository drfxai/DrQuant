#!/bin/bash
# ============================================================================
#  DrFX Quantum - Management & Reference Card
#  Run any time:  sudo bash /var/www/drfx-quantum/manage.sh
#
#  Read-only: this script changes NOTHING. It shows the current configuration,
#  live resource usage, and the exact commands to change each part of the
#  deployment (domain, admin, ports, database, SSL, firewall, updates, logs).
# ============================================================================
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

APP_DIR="${APP_DIR:-/var/www/drfx-quantum}"
ENV_FILE="$APP_DIR/.env"
NGINX_SITE="/etc/nginx/sites-available/drfx-quantum"
PM2_NAME="drfx-quantum"

getenv() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }

# ---- current configuration -------------------------------------------------
PORT="$(getenv PORT)"; PORT="${PORT:-3000}"
ADMIN_EMAIL="$(getenv ADMIN_EMAIL)"; ADMIN_EMAIL="${ADMIN_EMAIL:-(unknown)}"
DB_NAME="$(getenv DB_NAME)"; DB_NAME="${DB_NAME:-drfx_quantum}"
DB_USER="$(getenv DB_USER)"; DB_USER="${DB_USER:-drfx}"
DOMAIN="$(getenv DOMAIN)"
[ -z "$DOMAIN" ] && DOMAIN="$(getenv ALLOWED_ORIGINS | sed -E 's#https?://##; s#,.*##')"
if [ -z "$DOMAIN" ] && [ -f "$NGINX_SITE" ]; then
  DOMAIN="$(grep -m1 -E '^[[:space:]]*server_name' "$NGINX_SITE" 2>/dev/null | awk '{print $2}' | tr -d ';')"
fi
[ -z "$DOMAIN" ] && DOMAIN="(unknown)"

SCHEME="http"
[ -f "$NGINX_SITE" ] && grep -q "listen 443" "$NGINX_SITE" 2>/dev/null && SCHEME="https"

# ---- live status -----------------------------------------------------------
APP_PID="$(pm2 pid "$PM2_NAME" 2>/dev/null | head -1 | tr -dc '0-9')"
if [ -n "$APP_PID" ] && ps -p "$APP_PID" >/dev/null 2>&1; then
  PM2_STATE="${GREEN}online${NC}"
  APP_RSS_KB="$(ps -o rss= -p "$APP_PID" 2>/dev/null | tr -dc '0-9')"
  [ -n "$APP_RSS_KB" ] && APP_MEM="$(( APP_RSS_KB / 1024 )) MB" || APP_MEM="?"
else
  PM2_STATE="${YELLOW}stopped${NC}"; APP_MEM="(not running)"
fi

MEM_TOTAL="$(free -h 2>/dev/null | awk '/^Mem:/{print $2}')"
MEM_USED="$(free -h 2>/dev/null | awk '/^Mem:/{print $3}')"
MEM_AVAIL="$(free -h 2>/dev/null | awk '/^Mem:/{print $7}')"
SWAP_TOTAL="$(free -h 2>/dev/null | awk '/^Swap:/{print $2}')"
SWAP_USED="$(free -h 2>/dev/null | awk '/^Swap:/{print $3}')"
DISK="$(df -h / 2>/dev/null | awk 'NR==2{print $3" used / "$2"  ("$5" full)"}')"
LOAD="$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"

QC_INSTALLED=0
[ -f /etc/systemd/system/quantum-chat.service ] && QC_INSTALLED=1

hdr() { echo ""; echo -e "${BOLD}-- $1 --${NC}"; }
row() { printf "   ${CYAN}%-15s${NC} %b\n" "$1" "$2"; }
cmd() { printf "   ${DIM}\$${NC} %b\n" "$1"; }

echo ""
echo -e "${BLUE}  +==============================================================+${NC}"
echo -e "${BLUE}  |${NC}   ${BOLD}DrFX Quantum - Management Reference${NC}                        ${BLUE}|${NC}"
echo -e "${BLUE}  +==============================================================+${NC}"

hdr "Current configuration"
row "URL"          "${BOLD}${SCHEME}://${DOMAIN}${NC}"
row "Admin login"  "${ADMIN_EMAIL}"
row "App port"     "${PORT}   ${DIM}(nginx proxies :80/:443 -> 127.0.0.1:${PORT})${NC}"
row "App directory" "${APP_DIR}"
row "Config file"  "${ENV_FILE}   ${DIM}(0600)${NC}"
row "Database"     "PostgreSQL   db=${DB_NAME}   user=${DB_USER}"
row "Service"      "${PM2_NAME}   [${PM2_STATE}]"
[ "$QC_INSTALLED" -eq 1 ] && row "Quantum Chat" "${GREEN}node installed${NC} (systemd: quantum-chat)"

hdr "Live resource usage"
row "RAM"          "${MEM_USED:-?} used / ${MEM_TOTAL:-?} total   ${DIM}(${MEM_AVAIL:-?} available)${NC}"
row "Swap"         "${SWAP_USED:-?} used / ${SWAP_TOTAL:-?}"
row "Disk (/)"     "${DISK:-?}"
row "App memory"   "${APP_MEM}"
row "Load (1/5/15)" "${LOAD:-?}"
echo -e "   ${DIM}live monitor: pm2 monit   |   full RAM: free -h   |   disk: df -h${NC}"

hdr "Service control"
cmd "pm2 status                      ${DIM}# all processes + memory${NC}"
cmd "pm2 logs ${PM2_NAME}            ${DIM}# live logs${NC}"
cmd "pm2 restart ${PM2_NAME}         ${DIM}# restart the app${NC}"
cmd "pm2 stop ${PM2_NAME}   ${DIM}|${NC}   pm2 start ${PM2_NAME}"

hdr "Change the ADMIN email or password"
cmd "nano ${ENV_FILE}                ${DIM}# edit ADMIN_EMAIL / ADMIN_PASSWORD${NC}"
cmd "pm2 restart ${PM2_NAME}         ${DIM}# admin is re-synced from .env on every boot${NC}"

hdr "Change the DOMAIN"
cmd "nano ${ENV_FILE}                ${DIM}# set DOMAIN= and ALLOWED_ORIGINS=https://NEWDOMAIN${NC}"
cmd "sudo nano ${NGINX_SITE}         ${DIM}# set: server_name NEWDOMAIN;${NC}"
cmd "sudo nginx -t && sudo systemctl reload nginx"
cmd "sudo certbot --nginx -d NEWDOMAIN          ${DIM}# issue SSL for the new domain${NC}"
cmd "pm2 restart ${PM2_NAME}"

hdr "Change the PORT"
cmd "nano ${ENV_FILE}                ${DIM}# set PORT=NEWPORT${NC}"
cmd "sudo nano ${NGINX_SITE}         ${DIM}# proxy_pass http://127.0.0.1:NEWPORT;${NC}"
cmd "sudo nginx -t && sudo systemctl reload nginx"
cmd "pm2 restart ${PM2_NAME} --update-env"

hdr "Database"
cmd "sudo -u postgres psql -d ${DB_NAME}                       ${DIM}# open a SQL shell${NC}"
cmd "sudo -u postgres pg_dump ${DB_NAME} > backup_\$(date +%F).sql   ${DIM}# backup${NC}"
cmd "sudo -u postgres psql -d ${DB_NAME} < backup.sql              ${DIM}# restore${NC}"

hdr "SSL / HTTPS"
cmd "sudo certbot certificates       ${DIM}# status + expiry${NC}"
cmd "sudo certbot renew              ${DIM}# renew now (auto-renew already scheduled)${NC}"

hdr "Firewall (ufw)"
cmd "sudo ufw status"
cmd "sudo ufw allow 80/tcp && sudo ufw allow 443/tcp   ${DIM}# web${NC}"
[ "$QC_INSTALLED" -eq 1 ] && cmd "sudo ufw allow 53/udp && sudo ufw allow 53/tcp     ${DIM}# Quantum Chat DNS${NC}"

hdr "Update to a new version (no full reinstall)"
cmd "cd <your DrFXQuant checkout> && git pull"
cmd "sudo bash update.sh"

hdr "Logs & diagnostics"
cmd "pm2 logs ${PM2_NAME}                        ${DIM}# app${NC}"
cmd "sudo tail -f /var/log/nginx/error.log       ${DIM}# nginx errors${NC}"
cmd "sudo tail -f /var/log/nginx/access.log      ${DIM}# nginx access${NC}"

if [ "$QC_INSTALLED" -eq 1 ]; then
hdr "Quantum Chat node"
cmd "systemctl status quantum-chat"
cmd "journalctl -u quantum-chat -f"
cmd "quantum-chat health"
fi

echo ""
echo -e "   ${DIM}Show this card again any time:  sudo bash ${APP_DIR}/manage.sh${NC}"
echo ""
