#!/bin/bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  📈 DrFX Quant — Uninstaller
#  Usage: sudo bash uninstall.sh
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

APP_DIR="/var/www/drfx-quant"
DB_NAME="drfx_quant"
DB_USER="drfx"

clear
echo ""
echo -e "${RED}  ╔════════════════════════════════════════════╗${NC}"
echo -e "${RED}  ║                                            ║${NC}"
echo -e "${RED}  ║   🗑️  ${BOLD}DrFX Quant — Uninstaller${NC}${RED}              ║${NC}"
echo -e "${RED}  ║                                            ║${NC}"
echo -e "${RED}  ╚════════════════════════════════════════════╝${NC}"
echo ""

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}✘ Please run as root: sudo bash uninstall.sh${NC}"
  exit 1
fi

echo -e "${YELLOW}⚠️  This will permanently remove:${NC}"
echo -e "  • Application files: ${BOLD}$APP_DIR${NC}"
echo -e "  • PostgreSQL database: ${BOLD}$DB_NAME${NC}"
echo -e "  • PostgreSQL user: ${BOLD}$DB_USER${NC}"
echo -e "  • PM2 process: ${BOLD}drfx-quant${NC}"
echo -e "  • Nginx config: ${BOLD}drfx-quant${NC}"
echo ""
echo -ne "${RED}➤ Are you sure? Type 'YES' to confirm: ${NC}"
read -r CONFIRM
if [ "$CONFIRM" != "YES" ]; then
  echo -e "${GREEN}Uninstall cancelled.${NC}"
  exit 0
fi

echo ""
echo -e "${CYAN}▸ Stopping PM2 process...${NC}"
pm2 stop drfx-quant 2>/dev/null || true
pm2 delete drfx-quant 2>/dev/null || true
pm2 save 2>/dev/null || true
echo -e "  ${GREEN}✓${NC} PM2 process removed"

echo -e "${CYAN}▸ Removing Nginx config...${NC}"
rm -f /etc/nginx/sites-enabled/drfx-quant
rm -f /etc/nginx/sites-available/drfx-quant
nginx -t > /dev/null 2>&1 && systemctl reload nginx 2>/dev/null || true
echo -e "  ${GREEN}✓${NC} Nginx config removed"

echo -e "${CYAN}▸ Dropping PostgreSQL database...${NC}"
sudo -u postgres psql -c "DROP DATABASE IF EXISTS $DB_NAME;" 2>/dev/null || true
sudo -u postgres psql -c "DROP USER IF EXISTS $DB_USER;" 2>/dev/null || true
echo -e "  ${GREEN}✓${NC} Database and user dropped"

echo -e "${CYAN}▸ Removing application files...${NC}"
rm -rf "$APP_DIR"
echo -e "  ${GREEN}✓${NC} Files removed"

echo ""
echo -ne "${YELLOW}➤ Also remove Node.js, PM2, Nginx, PostgreSQL? (y/n): ${NC}"
read -r REMOVE_DEPS
if [[ "$REMOVE_DEPS" =~ ^[Yy]$ ]]; then
  echo -e "${CYAN}▸ Removing PM2...${NC}"
  npm uninstall -g pm2 2>/dev/null || true
  echo -e "${CYAN}▸ Removing Nginx...${NC}"
  apt remove --purge -y nginx nginx-common 2>/dev/null || true
  echo -e "${CYAN}▸ Removing PostgreSQL...${NC}"
  apt remove --purge -y postgresql postgresql-contrib 2>/dev/null || true
  echo -e "${CYAN}▸ Removing Node.js...${NC}"
  apt remove --purge -y nodejs 2>/dev/null || true
  apt autoremove -y 2>/dev/null || true
  echo -e "  ${GREEN}✓${NC} Dependencies removed"
fi

echo ""
echo -e "${GREEN}  ╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}  ║                                            ║${NC}"
echo -e "${GREEN}  ║   ✅ DrFX Quant uninstalled completely     ║${NC}"
echo -e "${GREEN}  ║                                            ║${NC}"
echo -e "${GREEN}  ╚════════════════════════════════════════════╝${NC}"
echo ""
