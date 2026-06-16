#!/usr/bin/env bash
# ============================================================================
#  DrFX Quant - Live Trading: SFU (mediasoup) + TURN/STUN (coturn) installer
# ----------------------------------------------------------------------------
#  Run this ON THE UBUNTU SERVER as root, AFTER resizing the box to at least
#  ~2 vCPU / 4 GB (the SFU + coturn will not run well on 1 GB):
#
#       cd ~/DrFXQuant && git pull
#       sudo bash setup-live-sfu.sh
#
#  It is idempotent (safe to re-run; it backs up files it rewrites) and does:
#    1. install the mediasoup build toolchain + coturn (apt)
#    2. build/install mediasoup into the live app
#    3. detect the public IP and generate a TURN secret
#    4. write /etc/turnserver.conf (STUN + TURN over UDP and TCP, hardened)
#    5. add the LIVE_SFU / TURN settings to the app .env
#    6. open the firewall ports (ufw) or print which to open
#    7. restart coturn and the app
#
#  Override defaults via env, e.g.:
#       sudo DOMAIN=drfx.io PUBLIC_IP=1.2.3.4 bash setup-live-sfu.sh
#
#  NOT done here: TLS TURN (turns: on 5349/443) for 443-only networks - it needs
#  a DNS hostname + matching certificate, a choice this script can't make. STUN +
#  TURN over UDP and TCP already covers the large majority of viewers. See
#  docs/LIVE-SFU-PLAN.md to add TLS later.
# ============================================================================
set -euo pipefail

# ---- settings (override via environment) -----------------------------------
APP_DIR="${APP_DIR:-/var/www/drfx-quantum}"
DOMAIN="${DOMAIN:-drfx.io}"
PM2_NAME="${PM2_NAME:-drfx-quantum}"
RTC_MIN="${RTC_MIN:-40000}"            # mediasoup media UDP range (~one port per viewer)
RTC_MAX="${RTC_MAX:-40100}"
RELAY_MIN="${RELAY_MIN:-49160}"        # coturn relay UDP range
RELAY_MAX="${RELAY_MAX:-49200}"
MEDIASOUP_VERSION="${MEDIASOUP_VERSION:-^3.13.0}"
ENV_FILE="$APP_DIR/.env"

c(){ echo; echo "==> $*"; }
warn(){ echo "  ! $*"; }
ok(){ echo "  OK $*"; }

# ---- preconditions ---------------------------------------------------------
[ "$(id -u)" -eq 0 ] || { echo "Run as root:  sudo bash $0"; exit 1; }
[ -d "$APP_DIR" ] || { echo "App dir not found: $APP_DIR  (set APP_DIR=...)"; exit 1; }

# ---- 1. system packages ----------------------------------------------------
c "Installing build toolchain + coturn (apt)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y build-essential python3 python3-pip curl coturn openssl
ok "packages installed"

# ---- 2. public IPv4 --------------------------------------------------------
c "Determining public IPv4"
PUBLIC_IP="${PUBLIC_IP:-}"
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(curl -fsS4 https://api.ipify.org 2>/dev/null || curl -fsS4 https://ifconfig.me 2>/dev/null || true)"
fi
[ -n "$PUBLIC_IP" ] || { echo "Could not detect public IP. Re-run: sudo PUBLIC_IP=1.2.3.4 bash $0"; exit 1; }
ok "public IP = $PUBLIC_IP"

# ---- 3. mediasoup (the SFU) ------------------------------------------------
c "Building/installing mediasoup $MEDIASOUP_VERSION (can take a minute)"
MEDIASOUP_OK=1
( cd "$APP_DIR" && npm install "mediasoup@$MEDIASOUP_VERSION" --unsafe-perm 2>&1 | tail -3 ) || MEDIASOUP_OK=0
if [ $MEDIASOUP_OK -eq 1 ]; then ok "mediasoup installed"; else warn "mediasoup build failed (see output above) - coturn setup continues"; fi

# ---- 4. TURN shared secret (reuse existing or generate) --------------------
c "Preparing TURN shared secret"
TURN_SECRET=""
if [ -f "$ENV_FILE" ] && grep -q "^TURN_SECRET=" "$ENV_FILE"; then
  TURN_SECRET="$(grep "^TURN_SECRET=" "$ENV_FILE" | head -n1 | cut -d= -f2-)"
fi
[ -n "$TURN_SECRET" ] || TURN_SECRET="$(openssl rand -hex 32)"
ok "secret ready"

# ---- 5. coturn config ------------------------------------------------------
c "Writing /etc/turnserver.conf"
[ -f /etc/turnserver.conf ] && cp /etc/turnserver.conf "/etc/turnserver.conf.bak.$(date +%s)" || true
cat > /etc/turnserver.conf <<EOF
# Managed by DrFX Quant setup-live-sfu.sh
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=$DOMAIN
# advertise the public IP in relay candidates (also correct behind cloud NAT;
# on AWS/GCP-style 1:1 NAT use  external-ip=PUBLIC/PRIVATE )
external-ip=$PUBLIC_IP
# relay port range (must be open in the firewall, UDP)
min-port=$RELAY_MIN
max-port=$RELAY_MAX
# hardening: no telnet CLI, no multicast, and never relay to internal ranges
no-cli
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
EOF
ok "coturn configured (STUN + TURN over UDP and TCP on 3478)"

# enable the service (Ubuntu ships coturn disabled by default)
if [ -f /etc/default/coturn ]; then
  if grep -q "TURNSERVER_ENABLED" /etc/default/coturn; then
    sed -i "s/.*TURNSERVER_ENABLED.*/TURNSERVER_ENABLED=1/" /etc/default/coturn
  else
    echo "TURNSERVER_ENABLED=1" >> /etc/default/coturn
  fi
fi

# ---- 6. app .env -----------------------------------------------------------
c "Updating $ENV_FILE"
[ -f "$ENV_FILE" ] && cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)" || true
touch "$ENV_FILE"
set_env(){
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    echo "$1=$2" >> "$ENV_FILE"
  fi
}
set_env LIVE_SFU on
set_env SFU_ANNOUNCED_IP "$PUBLIC_IP"
set_env SFU_RTC_MIN_PORT "$RTC_MIN"
set_env SFU_RTC_MAX_PORT "$RTC_MAX"
set_env TURN_HOST "$PUBLIC_IP"
set_env TURN_SECRET "$TURN_SECRET"
ok ".env updated (LIVE_SFU=on, SFU_ANNOUNCED_IP, RTC ports, TURN_HOST, TURN_SECRET)"

# ---- 7. firewall -----------------------------------------------------------
c "Opening firewall ports"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$RTC_MIN:$RTC_MAX/udp" >/dev/null 2>&1 || true
  ufw allow 3478/udp >/dev/null 2>&1 || true
  ufw allow 3478/tcp >/dev/null 2>&1 || true
  ufw allow "$RELAY_MIN:$RELAY_MAX/udp" >/dev/null 2>&1 || true
  ok "ufw: opened UDP $RTC_MIN-$RTC_MAX, 3478 udp+tcp, UDP $RELAY_MIN-$RELAY_MAX"
else
  warn "ufw not active - open these in your VPS provider firewall / security group:"
  echo "       UDP $RTC_MIN-$RTC_MAX   (mediasoup media)"
  echo "       UDP 3478 and TCP 3478   (STUN / TURN)"
  echo "       UDP $RELAY_MIN-$RELAY_MAX   (TURN relay)"
fi

# ---- 8. (re)start services -------------------------------------------------
c "Restarting coturn"
systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn || warn "coturn restart failed (check: journalctl -u coturn -n 30)"
sleep 1
if systemctl is-active --quiet coturn; then ok "coturn running"; else warn "coturn not active (check: journalctl -u coturn -n 30)"; fi

c "Restarting the app"
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" --update-env >/dev/null 2>&1 && ok "$PM2_NAME restarted" || warn "restart $PM2_NAME yourself"
else
  warn "pm2 not found - restart the app yourself so LIVE_SFU=on takes effect"
fi

# ---- summary ---------------------------------------------------------------
MS_STATUS=$([ $MEDIASOUP_OK -eq 1 ] && echo "installed" || echo "NOT installed - fix toolchain and re-run")
CT_STATUS=$(systemctl is-active coturn 2>/dev/null || true)
echo
echo "============================================================================"
echo " Done."
echo "   mediasoup : $MS_STATUS"
echo "   coturn    : $CT_STATUS"
echo "   public IP : $PUBLIC_IP"
echo
echo " Verify the SFU started:"
echo "   pm2 logs $PM2_NAME --lines 25 --nostream"
echo "   (expect a line like:  [sfu] enabled: N worker(s), announcedIp=$PUBLIC_IP)"
echo
echo " Verify TURN works (from your laptop, optional):"
echo "   open https://icetest.info/  - you want to see 'srflx' (STUN) and 'relay' (TURN)"
echo
echo " Notes:"
echo "   - Cloudflare: media/TURN go straight to $PUBLIC_IP over UDP; do NOT proxy that."
echo "   - Bandwidth is the real cost (~3-5 Mbps per 720p60 viewer x number of viewers)."
echo "   - The client mediasoup UI is the next code step; until it ships, the app keeps"
echo "     using the old frame-relay fallback."
echo "============================================================================"
