#!/bin/bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  📈 DrFX Quant v5.0 — Installer (PostgreSQL + Telegram-style)
#  Usage: sudo bash install.sh
#  Uninstall: sudo bash uninstall.sh
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -e
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
APP_DIR="/var/www/drfx-quantum"
# Directory this installer (and the repo) live in — used to locate migrations
# and the optional Quantum Chat installer even after we cd into $APP_DIR.
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

clear
echo ""
echo -e "${CYAN}  ╔════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}  ║                                            ║${NC}"
echo -e "${CYAN}  ║   📈 ${BOLD}DrFX Quant${NC}${CYAN} v5.0 — Installer           ║${NC}"
echo -e "${CYAN}  ║   Telegram-style Trading Platform          ║${NC}"
echo -e "${CYAN}  ║                                            ║${NC}"
echo -e "${CYAN}  ╚════════════════════════════════════════════╝${NC}"
echo ""

if [ "$EUID" -ne 0 ]; then echo -e "${RED}✘ Run as root: sudo bash install.sh${NC}"; exit 1; fi

echo -e "${BOLD}── Step 1: Configuration ──${NC}\n"

echo -ne "${YELLOW}➤ Domain (e.g. chat.drfx.com): ${NC}"; read -r DOMAIN
while [ -z "$DOMAIN" ]; do echo -ne "${RED}  Required: ${NC}"; read -r DOMAIN; done

echo -ne "${YELLOW}➤ Admin email: ${NC}"; read -r ADMIN_EMAIL
while [ -z "$ADMIN_EMAIL" ]; do echo -ne "${RED}  Required: ${NC}"; read -r ADMIN_EMAIL; done

while true; do
  echo -ne "${YELLOW}➤ Admin password (min 6): ${NC}"; read -rs ADMIN_PASSWORD; echo
  [ ${#ADMIN_PASSWORD} -lt 6 ] && echo -e "${RED}  Too short${NC}" && continue
  echo -ne "${YELLOW}➤ Confirm: ${NC}"; read -rs ADMIN_PASSWORD2; echo
  [ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD2" ] && echo -e "${RED}  Mismatch${NC}" && continue; break
done

DB_NAME="drfx_quantum"; DB_USER="drfx"; DB_PASS=$(openssl rand -hex 16)

echo ""; echo -e "${BOLD}── Optional API Keys (Enter to skip) ──${NC}"; echo ""
echo -ne "${YELLOW}➤ OpenRouter API key: ${NC}"; read -r OPENROUTER_KEY
echo -ne "${YELLOW}➤ NowPayments API key: ${NC}"; read -r NP_API_KEY
echo -ne "${YELLOW}➤ NowPayments IPN secret: ${NC}"; read -r NP_IPN_SECRET

echo ""; echo -e "${BOLD}── Confirm ──${NC}"; echo ""
echo -e "  Domain:   ${GREEN}$DOMAIN${NC}"
echo -e "  Admin:    ${GREEN}$ADMIN_EMAIL${NC}"
echo -e "  Database: ${GREEN}PostgreSQL ($DB_NAME)${NC}"
echo ""; echo -ne "${YELLOW}➤ Proceed? (y/n): ${NC}"; read -r CONFIRM
[[ ! "$CONFIRM" =~ ^[Yy]$ ]] && echo -e "${RED}Cancelled.${NC}" && exit 0

echo ""; echo -e "${BOLD}── Step 2: System Packages ──${NC}"; echo ""

echo -e "${CYAN}▸ Updating system...${NC}"
apt update -y -qq && apt upgrade -y -qq

if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 18 ]]; then
  echo -e "${CYAN}▸ Installing Node.js 20...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt install -y -qq nodejs
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"

apt install -y -qq build-essential python3 git > /dev/null 2>&1
echo -e "  ${GREEN}✓${NC} Build tools"

echo -e "${CYAN}▸ Installing PostgreSQL...${NC}"
apt install -y -qq postgresql postgresql-contrib > /dev/null 2>&1
systemctl enable postgresql; systemctl start postgresql
echo -e "  ${GREEN}✓${NC} PostgreSQL $(psql --version 2>/dev/null | awk '{print $3}' || echo 'installed')"

echo -e "${CYAN}▸ Setting up database...${NC}"
sudo -u postgres psql -c "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" 2>/dev/null | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';" 2>/dev/null
sudo -u postgres psql -c "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" 2>/dev/null
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;" 2>/dev/null
echo -e "  ${GREEN}✓${NC} Database ready"

apt install -y -qq nginx > /dev/null 2>&1; echo -e "  ${GREEN}✓${NC} Nginx"
npm install -g pm2 > /dev/null 2>&1; echo -e "  ${GREEN}✓${NC} PM2"

echo ""; echo -e "${BOLD}── Step 3: Application ──${NC}"; echo ""
mkdir -p "$APP_DIR" "$APP_DIR/uploads"

if [ -f "$SRC_DIR/server.js" ]; then
  cp "$SRC_DIR/server.js" "$SRC_DIR/database.js" "$SRC_DIR/package.json" "$APP_DIR/"
  cp -r "$SRC_DIR/routes" "$SRC_DIR/public" "$APP_DIR/"
  # Additive backend modules + DB migrations, so the deployment is complete.
  # middleware/ and services/ are opt-in (see INTEGRATION.md); migrations/ is
  # applied below and is required for the TradingView signal/webhook tables.
  # NOTE: every new top-level runtime directory that server.js require()s MUST
  # be added here, or the deployed copy will be missing it (realtime/ is such a
  # dependency — its omission caused a MODULE_NOT_FOUND crash loop once).
  for d in middleware services migrations realtime qntm-ledger; do
    [ -d "$SRC_DIR/$d" ] && cp -r "$SRC_DIR/$d" "$APP_DIR/"
  done
  # Quantum Chat browser client — served at /qc for the in-app Quantum Chat panel.
  # Only web/ is needed by the Node app; the Go node installs separately (Step 7).
  if [ -d "$SRC_DIR/quantum-chat/web" ]; then
    mkdir -p "$APP_DIR/quantum-chat"
    cp -r "$SRC_DIR/quantum-chat/web" "$APP_DIR/quantum-chat/"
  fi
  for f in uninstall.sh update.sh manage.sh setup-live-sfu.sh INTEGRATION.md; do
    [ -f "$SRC_DIR/$f" ] && cp "$SRC_DIR/$f" "$APP_DIR/"
  done
  echo -e "  ${GREEN}✓${NC} Files copied (incl. middleware, services, migrations, realtime, quantum-chat web)"
fi

# Fail fast if a hard runtime dependency didn't make it into the deployed copy.
# server.js require()s ./realtime/* at startup; an explicit error here is far
# better than a MODULE_NOT_FOUND crash loop under PM2 (which surfaces as a 502).
if [ ! -f "$APP_DIR/realtime/messaging.js" ]; then
  echo -e "${RED}✘ realtime/ modules are missing from $APP_DIR.${NC}"
  echo -e "${YELLOW}  server.js depends on them. Ensure the realtime/ directory exists in this${NC}"
  echo -e "${YELLOW}  checkout (commit & push it to GitHub if you deploy via git clone), then${NC}"
  echo -e "${YELLOW}  re-run this installer.${NC}"
  exit 1
fi

cd "$APP_DIR"
JWT_SECRET=$(openssl rand -hex 32)
TV_SECRET=$(openssl rand -hex 32)
cat > .env << ENVFILE
PORT=3000
JWT_SECRET=$JWT_SECRET
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$ADMIN_PASSWORD
DATABASE_URL=postgresql://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME
DB_USER=$DB_USER
DB_PASS=$DB_PASS
DB_HOST=localhost
DB_PORT=5432
DB_NAME=$DB_NAME
OPENROUTER_API_KEY=${OPENROUTER_KEY:-your_openrouter_api_key_here}
NOWPAYMENTS_API_KEY=${NP_API_KEY:-your_nowpayments_api_key_here}
NOWPAYMENTS_IPN_SECRET=${NP_IPN_SECRET:-your_nowpayments_ipn_secret_here}
TRADINGVIEW_WEBHOOK_SECRET=$TV_SECRET
SIGNAL_CHANNEL_USERNAME=signals
NODE_ENV=production
DOMAIN=$DOMAIN
ALLOWED_ORIGINS=https://$DOMAIN
ACCESS_TTL=15m
REFRESH_TTL_DAYS=30
ENVFILE
chmod 600 .env; echo -e "  ${GREEN}✓${NC} .env created"

npm install --production 2>&1 | tail -1; echo -e "  ${GREEN}✓${NC} Dependencies installed"

echo ""; echo -e "${BOLD}── Step 3b: Database schema + migrations ──${NC}"; echo ""
echo -e "${CYAN}▸ Creating base tables...${NC}"
node -e "require('dotenv').config(); require('./database').initDB().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})" \
  && echo -e "  ${GREEN}✓${NC} Base schema ready" \
  || { echo -e "${RED}✘ Base schema init failed (check DATABASE_URL / PostgreSQL)${NC}"; exit 1; }
if ls "$APP_DIR"/migrations/*.sql >/dev/null 2>&1; then
  echo -e "${CYAN}▸ Applying migrations...${NC}"
  for f in $(ls "$APP_DIR"/migrations/*.sql | sort); do
    echo -e "    ${CYAN}→${NC} $(basename "$f")"
    sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$f" >/dev/null \
      && echo -e "    ${GREEN}✓${NC} applied" \
      || { echo -e "${RED}✘ Migration failed: $(basename "$f")${NC}"; exit 1; }
  done
else
  echo -e "  ${YELLOW}⚠${NC} No migrations found — TradingView signal/webhook tables will be missing"
fi

# Grant the app user access to the migration-created tables. Migrations run as
# the postgres superuser, so without this the app (which connects as $DB_USER)
# hits "permission denied for table ..." on signals/webhook_logs. The Step 2
# grant is DATABASE-level only and does NOT cover tables owned by postgres.
echo -e "${CYAN}▸ Granting table privileges to $DB_USER...${NC}"
if sudo -u postgres psql -d "$DB_NAME" >/dev/null 2>&1 <<SQL
GRANT USAGE ON SCHEMA public TO $DB_USER;
GRANT ALL ON ALL TABLES IN SCHEMA public TO $DB_USER;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO $DB_USER;
SQL
then echo -e "  ${GREEN}✓${NC} Table privileges granted"; else echo -e "  ${YELLOW}⚠${NC} Grant step had warnings"; fi

echo ""; echo -e "${BOLD}── Step 4: Nginx ──${NC}"; echo ""
cat > /etc/nginx/sites-available/drfx-quantum << NGINX
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 12M;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/drfx-quantum /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t > /dev/null 2>&1 && systemctl restart nginx
echo -e "  ${GREEN}✓${NC} Nginx configured"

# If a local firewall (ufw) is active, ensure the web ports are open — otherwise
# the site, and Let's Encrypt's port-80 challenge in Step 6, is unreachable from
# the internet. (Installing the Quantum Chat node enables ufw, for example.)
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  echo -e "  ${GREEN}✓${NC} Firewall (ufw) allows HTTP/HTTPS"
fi

echo ""; echo -e "${BOLD}── Step 5: Start ──${NC}"; echo ""
pm2 delete drfx-quantum > /dev/null 2>&1 || true
pm2 start server.js --name drfx-quantum --cwd "$APP_DIR"
pm2 save > /dev/null 2>&1; pm2 startup systemd -u root --hp /root > /dev/null 2>&1 || true
echo -e "  ${GREEN}✓${NC} Running with PM2"

echo ""; echo -e "${BOLD}── Step 6: SSL ──${NC}"; echo ""
# Always ensure BOTH certbot and its nginx plugin are installed. The old guard
# `command -v certbot || apt install ...` skipped the plugin whenever certbot was
# already present without it, so `certbot --nginx` failed with "nginx plugin does
# not appear to be installed". apt is idempotent, so this is safe when present.
apt install -y -qq certbot python3-certbot-nginx > /dev/null 2>&1 || true
echo -ne "${YELLOW}➤ Setup SSL now? (y/n): ${NC}"; read -r SSL
if [[ "$SSL" =~ ^[Yy]$ ]]; then
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$ADMIN_EMAIL"; then
    echo -e "  ${GREEN}✓${NC} HTTPS enabled — https://$DOMAIN"
  else
    echo -e "${YELLOW}  ⚠ SSL setup did not complete; the app still works over HTTP.${NC}"
    echo -e "${YELLOW}    Retry: sudo apt install -y python3-certbot-nginx && sudo certbot --nginx -d $DOMAIN${NC}"
    echo -e "${YELLOW}    (If certbot was installed via snap: sudo snap install --classic certbot)${NC}"
  fi
fi

echo ""; echo -e "${BOLD}── Step 7: Quantum Chat (optional) ──${NC}"; echo ""
echo -e "  ${CYAN}Quantum Chat${NC} is the DNS-resilient, end-to-end-encrypted emergency messenger."
echo -e "  It runs as a SEPARATE service (its own subdomain + DNS delegation + UDP/TCP 53)."
echo -e "  The in-app Quantum Chat panel needs a running node to connect to."
echo -ne "${YELLOW}➤ Install the Quantum Chat node now? (y/n): ${NC}"; read -r QC_INSTALL
if [[ "$QC_INSTALL" =~ ^[Yy]$ ]]; then
  if [ -f "$SRC_DIR/quantum-chat/scripts/install-quantum-chat.sh" ]; then
    bash "$SRC_DIR/quantum-chat/scripts/install-quantum-chat.sh" || echo -e "${YELLOW}  ⚠ Quantum Chat install did not complete; the main platform is unaffected.${NC}"
  else
    echo -e "${YELLOW}  ⚠ quantum-chat/scripts/install-quantum-chat.sh not found in this checkout.${NC}"
  fi
else
  echo -e "  ${CYAN}Skipped.${NC} Install later: sudo bash $SRC_DIR/quantum-chat/scripts/install-quantum-chat.sh"
fi

echo ""; echo -e "${BOLD}── Step 8: Live Trading — high-FPS WebRTC (SFU + TURN) ──${NC}"; echo ""
echo -e "  Installs the WebRTC ${CYAN}SFU (mediasoup) + TURN (coturn)${NC} so Live Trading streams at smooth"
echo -e "  ${BOLD}30-60 FPS${NC} instead of the low-FPS (~15) relay. ${GREEN}${BOLD}Enabled by default — just press Enter.${NC}"
echo -e "  ${YELLOW}Best on ~2 vCPU / 4 GB with open UDP ports (~3-5 Mbps per 720p viewer). Type 'n' to skip on a small box.${NC}"
# Default-ON: pressing Enter installs + activates mediasoup + coturn. For an
# unattended install, preset the answer:  INSTALL_SFU=yes  (force, no prompt)
# or  INSTALL_SFU=no  (skip, no prompt).
SFU_CHOICE="${INSTALL_SFU:-}"
if [ -z "$SFU_CHOICE" ]; then
  echo -ne "${YELLOW}➜ Install & activate high-FPS live streaming now? [Y/n]: ${NC}"; read -r SFU_CHOICE
  SFU_CHOICE="${SFU_CHOICE:-Y}"
fi
if [[ "$SFU_CHOICE" =~ ^([Nn]|no|No|NO)$ ]]; then
  echo -e "  ${CYAN}Skipped.${NC} Enable later (any time):  sudo bash $SRC_DIR/setup-live-sfu.sh"
else
  if [ -f "$SRC_DIR/setup-live-sfu.sh" ]; then
    echo -e "${CYAN}▸ Installing mediasoup (SFU) + coturn (TURN), writing config, opening ports, activating...${NC}"
    DOMAIN="$DOMAIN" bash "$SRC_DIR/setup-live-sfu.sh" \
      || echo -e "${YELLOW}  ⚠ SFU setup did not finish; Live Trading will use the frame-relay fallback until you re-run it.${NC}"
  else
    echo -e "${YELLOW}  ⚠ setup-live-sfu.sh not found in this checkout.${NC}"
  fi
fi

echo ""; echo -e "${BOLD}── Step 9: Next steps ──${NC}"; echo ""
echo -e "  ${CYAN}Reminder:${NC} TradingView webhook secret is in ${APP_DIR}/.env (TRADINGVIEW_WEBHOOK_SECRET);"
echo -e "  create a channel named 'signals' in-app so incoming signals have somewhere to post."

# Print the full management reference card (current config + how to change each part).
[ -f "$SRC_DIR/manage.sh" ] && bash "$SRC_DIR/manage.sh"

echo ""
echo -e "${GREEN}  ╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}  ║  ✅ ${BOLD}DrFX Quant v5.0 installed!${NC}  ${GREEN}                  ║${NC}"
echo -e "${GREEN}  ╠══════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}  ║  🌐 ${BOLD}http://$DOMAIN${NC}${GREEN}"
echo -e "${GREEN}  ║  👤 ${BOLD}$ADMIN_EMAIL${NC}${GREEN}"
echo -e "${GREEN}  ║  🗄️  ${BOLD}PostgreSQL ($DB_NAME)${NC}${GREEN}"
echo -e "${GREEN}  ╠══════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}  ║  ${NC}pm2 logs drfx-quantum       ${GREEN}# Logs${NC}"
echo -e "${GREEN}  ║  ${NC}pm2 restart drfx-quantum     ${GREEN}# Restart${NC}"
echo -e "${GREEN}  ║  ${NC}nano $APP_DIR/.env   ${GREEN}# Config${NC}"
echo -e "${GREEN}  ║  ${NC}sudo bash uninstall.sh       ${GREEN}# Uninstall${NC}"
echo -e "${GREEN}  ╚══════════════════════════════════════════════════╝${NC}"
echo ""
