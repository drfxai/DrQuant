#!/bin/bash
# ============================================================================
#  DrFX Quant — Management Console
#  Run:  sudo bash /var/www/drfx-quant/manage.sh
#
#  Interactive console to VIEW and EDIT the live configuration:
#    • Admin email / password
#    • NowPayments API key + IPN secret
#    • OpenRouter API key (AI assistant)
#    • Email (SMTP) settings used for sign-up confirmation codes
#  …plus restart, status, logs, and a quick command-reference card.
#
#  Every edit writes to $APP_DIR/.env (kept at 0600) and offers to restart the
#  app. Nothing changes unless you choose it.
# ============================================================================

# ---- colours ---------------------------------------------------------------
R=$'\033[0;31m'; G=$'\033[0;32m'; Y=$'\033[1;33m'; B=$'\033[0;34m'; C=$'\033[0;36m'
M=$'\033[0;35m'; W=$'\033[1;37m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; NC=$'\033[0m'

APP_DIR="${APP_DIR:-/var/www/drfx-quant}"
ENV_FILE="$APP_DIR/.env"
NGINX_SITE="/etc/nginx/sites-available/drfx-quant"
PM2_NAME="drfx-quant"
WIDTH=64

# ---- env helpers -----------------------------------------------------------
getenv() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }

set_env() {
  # set_env KEY VALUE — safely upsert a key in .env without disturbing the rest.
  local key="$1"; local val="$2"; local tmp
  if ! touch "$ENV_FILE" 2>/dev/null; then
    echo -e "${R}  ✘ Cannot write $ENV_FILE — re-run with: sudo bash $0${NC}"; return 1
  fi
  tmp="$(mktemp)" || return 1
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  return 0
}

is_placeholder() {
  case "$1" in
    ""|your_*|generate_with_*|*_here|password|change_me|your_secure_password) return 0 ;;
    *) return 1 ;;
  esac
}

mask() {
  local v="$1"; local n=${#v}
  if   [ "$n" -eq 0 ]; then printf '%s' "(not set)"
  elif [ "$n" -le 8 ]; then printf '********'
  else printf '%s…%s  %s(%s chars)%s' "${v:0:4}" "${v: -4}" "$DIM" "$n" "$NC"; fi
}

dot() { if is_placeholder "$1"; then printf '%s○%s' "$Y" "$NC"; else printf '%s●%s' "$G" "$NC"; fi; }

# ---- ui helpers ------------------------------------------------------------
rule()  { printf "  ${B}"; printf '─%.0s' $(seq 1 "$WIDTH"); printf "${NC}\n"; }
top()   { printf "  ${B}╔"; printf '═%.0s' $(seq 1 "$WIDTH"); printf "╗${NC}\n"; }
bot()   { printf "  ${B}╚"; printf '═%.0s' $(seq 1 "$WIDTH"); printf "╝${NC}\n"; }
ctr()   { # centered title line inside the box
  local s="$1"; local len=${#s}; local pad=$(( (WIDTH - len) / 2 ))
  printf "  ${B}║${NC}%*s${BOLD}%s${NC}%*s${B}║${NC}\n" "$pad" "" "$s" "$(( WIDTH - len - pad ))" ""
}
pause() { echo ""; read -rsp "$(printf '%s  Press Enter to continue…%s' "$DIM" "$NC")" _; echo ""; }

banner() {
  clear 2>/dev/null || true
  echo ""
  top; ctr "DrFX Quant — Management Console"; bot
}

# ---- live status -----------------------------------------------------------
read_status() {
  PORT="$(getenv PORT)"; PORT="${PORT:-3000}"
  DOMAIN="$(getenv DOMAIN)"
  [ -z "$DOMAIN" ] && DOMAIN="$(getenv ALLOWED_ORIGINS | sed -E 's#https?://##; s#,.*##')"
  if [ -z "$DOMAIN" ] && [ -f "$NGINX_SITE" ]; then
    DOMAIN="$(grep -m1 -E '^[[:space:]]*server_name' "$NGINX_SITE" 2>/dev/null | awk '{print $2}' | tr -d ';')"
  fi
  [ -z "$DOMAIN" ] && DOMAIN="(unknown)"
  SCHEME="http"; [ -f "$NGINX_SITE" ] && grep -q "listen 443" "$NGINX_SITE" 2>/dev/null && SCHEME="https"

  APP_PID="$(pm2 pid "$PM2_NAME" 2>/dev/null | head -1 | tr -dc '0-9')"
  if [ -n "$APP_PID" ] && ps -p "$APP_PID" >/dev/null 2>&1; then
    PM2_STATE="${G}online${NC}"
    local rss; rss="$(ps -o rss= -p "$APP_PID" 2>/dev/null | tr -dc '0-9')"
    [ -n "$rss" ] && APP_MEM="$(( rss / 1024 )) MB" || APP_MEM="?"
  else
    PM2_STATE="${Y}stopped${NC}"; APP_MEM="(not running)"
  fi
}

dashboard() {
  read_status
  local adm pw np ipn or smtp_h
  adm="$(getenv ADMIN_EMAIL)"; pw="$(getenv ADMIN_PASSWORD)"
  np="$(getenv NOWPAYMENTS_API_KEY)"; ipn="$(getenv NOWPAYMENTS_IPN_SECRET)"
  or="$(getenv OPENROUTER_API_KEY)"; smtp_h="$(getenv SMTP_HOST)"

  echo ""
  printf "   ${C}%-13s${NC} %b\n" "URL"      "${BOLD}${SCHEME}://${DOMAIN}${NC}"
  printf "   ${C}%-13s${NC} %b\n" "Service"  "${PM2_NAME}  [${PM2_STATE}]   ${DIM}${APP_MEM}${NC}"
  printf "   ${C}%-13s${NC} %b\n" "App dir"  "${APP_DIR}"
  printf "   ${C}%-13s${NC} %b\n" "Config"   "${ENV_FILE} ${DIM}(0600)${NC}"
  echo ""
  printf "   ${BOLD}%s${NC}\n" "Editable settings"
  rule
  printf "    ${BOLD}#  Setting${NC}                    ${BOLD}Value${NC}\n"
  printf "    %b 1) %-22s %b\n" "$(dot "$adm")"  "Admin email"            "${adm:-${Y}(not set)${NC}}"
  printf "    %b 2) %-22s %b\n" "$(dot "$pw")"   "Admin password"         "$([ -n "$pw" ] && printf '********  %s(re-synced on restart)%s' "$DIM" "$NC" || printf '%s(not set)%s' "$Y" "$NC")"
  printf "    %b 3) %-22s %b\n" "$(dot "$np")"   "NowPayments API key"    "$(mask "$np")"
  printf "    %b 4) %-22s %b\n" "$(dot "$ipn")"  "NowPayments IPN secret" "$(mask "$ipn")"
  printf "    %b 5) %-22s %b\n" "$(dot "$or")"   "OpenRouter API key"     "$(mask "$or")"
  printf "    %b 6) %-22s %b\n" "$(dot "$smtp_h")" "Email / SMTP"         "$([ -n "$smtp_h" ] && printf '%s  %s(sign-up codes ON)%s' "$smtp_h" "$G" "$NC" || printf '%s(not set — sign-up codes OFF)%s' "$Y" "$NC")"
  rule
  printf "    ${DIM}●%s set   ${Y}○%s not set${NC}\n" "$NC" "$DIM"
}

menu() {
  echo ""
  printf "   ${BOLD}Actions${NC}\n"
  printf "    ${C}1${NC}-${C}5${NC}) edit a setting        ${C}6${NC}) Email / SMTP settings  ▸\n"
  printf "    ${C}7${NC})   restart app           ${C}8${NC}) status & resources\n"
  printf "    ${C}9${NC})   live logs (Ctrl-C)    ${C}r${NC}) command reference\n"
  printf "    ${C}q${NC})   quit\n"
  echo ""
}

# ---- edit primitives -------------------------------------------------------
do_restart() {
  echo ""; echo -e "${C}  Restarting ${PM2_NAME}…${NC}"
  if pm2 restart "$PM2_NAME" --update-env >/dev/null 2>&1; then
    echo -e "${G}  ✔ Restarted.${NC}"
  else
    pm2 start "$APP_DIR/server.js" --name "$PM2_NAME" --cwd "$APP_DIR" >/dev/null 2>&1 \
      && echo -e "${G}  ✔ Started.${NC}" \
      || echo -e "${R}  ✘ Could not (re)start. Check:  pm2 logs ${PM2_NAME}${NC}"
  fi
  pm2 save >/dev/null 2>&1 || true
}

offer_restart() {
  echo ""
  read -rp "$(printf '%s  Restart the app now so changes take effect? [y/N]: %s' "$Y" "$NC")" yn
  case "$yn" in [Yy]*) do_restart ;; *) echo -e "${DIM}  Skipped — use option [7] later to restart.${NC}" ;; esac
}

edit_value() {
  # edit_value KEY "Label" "hint" secret(0/1)
  local key="$1" label="$2" hint="$3" secret="$4" cur val
  cur="$(getenv "$key")"
  banner
  echo ""; echo -e "  ${BOLD}Edit ${label}${NC}"
  [ -n "$hint" ] && echo -e "  ${DIM}${hint}${NC}"
  if [ -n "$cur" ]; then
    echo -e "  Current: ${C}$( [ "$secret" = "1" ] && mask "$cur" || printf '%s' "$cur")${NC}"
  else
    echo -e "  Current: ${Y}(not set)${NC}"
  fi
  echo ""
  if [ "$secret" = "1" ]; then read -rsp "  New value (blank = keep): " val; echo; else read -rp "  New value (blank = keep): " val; fi
  if [ -z "$val" ]; then echo -e "  ${DIM}Unchanged.${NC}"; pause; return; fi
  if set_env "$key" "$val"; then echo -e "  ${G}✔ Saved ${key}.${NC}"; offer_restart; fi
  pause
}

edit_admin_password() {
  local p1 p2
  banner
  echo ""; echo -e "  ${BOLD}Change admin password${NC}"
  echo -e "  ${DIM}Stored in .env; the app re-hashes and re-syncs the admin on restart.${NC}"
  echo ""
  read -rsp "  New password (min 6 chars): " p1; echo
  if [ -z "$p1" ]; then echo -e "  ${DIM}Unchanged.${NC}"; pause; return; fi
  if [ "${#p1}" -lt 6 ]; then echo -e "  ${R}✘ Too short (min 6).${NC}"; pause; return; fi
  read -rsp "  Confirm password: " p2; echo
  if [ "$p1" != "$p2" ]; then echo -e "  ${R}✘ Passwords do not match.${NC}"; pause; return; fi
  if set_env ADMIN_PASSWORD "$p1"; then echo -e "  ${G}✔ Admin password saved.${NC}"; offer_restart; fi
  pause
}

smtp_menu() {
  while true; do
    banner
    local h p s u pw f
    h="$(getenv SMTP_HOST)"; p="$(getenv SMTP_PORT)"; s="$(getenv SMTP_SECURE)"
    u="$(getenv SMTP_USER)"; pw="$(getenv SMTP_PASS)"; f="$(getenv SMTP_FROM)"
    echo ""
    printf "   ${BOLD}Email / SMTP — sign-up confirmation codes${NC}\n"
    echo -e "   ${DIM}When a host is set, new sign-ups must confirm a 6-digit code emailed to them.${NC}"
    echo -e "   ${DIM}Leave host blank to disable (instant sign-up). Works with Resend, SendGrid,${NC}"
    echo -e "   ${DIM}Gmail (app password), Supabase SMTP, Mailgun, etc.${NC}"
    echo -e "   ${Y}If the port does not work (sign-up email times out), use port 2525 instead.${NC}"
    echo -e "   ${DIM}Most VPS hosts block outbound 587/465; 2525 (STARTTLS, Secure=false) is the fix.${NC}"
    rule
    printf "    ${C}1${NC}) %-14s %b\n" "Host"    "${h:-${Y}(not set)${NC}}"
    printf "    ${C}2${NC}) %-14s %b\n" "Port"    "${p:-${DIM}587${NC}}"
    printf "    ${C}3${NC}) %-14s %b\n" "Secure"  "${s:-${DIM}false${NC}}  ${DIM}(true=465/SSL, false=587/STARTTLS)${NC}"
    printf "    ${C}4${NC}) %-14s %b\n" "Username" "${u:-${Y}(not set)${NC}}"
    printf "    ${C}5${NC}) %-14s %b\n" "Password" "$(mask "$pw")"
    printf "    ${C}6${NC}) %-14s %b\n" "From"    "${f:-${Y}(not set)${NC}}"
    rule
    printf "    ${C}7${NC}) send a test email      ${C}b${NC}) back\n"
    echo ""
    read -rp "  Select: " ch
    case "$ch" in
      1) edit_value SMTP_HOST   "SMTP host"     "e.g. smtp.resend.com  /  smtp.gmail.com  /  smtp.sendgrid.net" 0 ;;
      2) edit_value SMTP_PORT   "SMTP port"     "587 STARTTLS / 465 SSL. If email times out, use 2525 (most VPS hosts block 587/465)." 0 ;;
      3) edit_value SMTP_SECURE "SMTP secure"   "type 'true' for port 465, 'false' for port 587" 0 ;;
      4) edit_value SMTP_USER   "SMTP username" "usually your full email or API key id" 0 ;;
      5) edit_value SMTP_PASS   "SMTP password" "SMTP password / API key (hidden input)" 1 ;;
      6) edit_value SMTP_FROM   "From address"  "e.g.  DrFX Quant <no-reply@yourdomain.com>" 0 ;;
      7) smtp_test ;;
      b|B|"") return ;;
      *) ;;
    esac
  done
}

smtp_test() {
  local to
  banner
  echo ""; echo -e "  ${BOLD}Send a test email${NC}"
  if [ -z "$(getenv SMTP_HOST)" ]; then echo -e "  ${Y}Set the SMTP host first.${NC}"; pause; return; fi
  read -rp "  Send test to which address? " to
  [ -z "$to" ] && { echo -e "  ${DIM}Cancelled.${NC}"; pause; return; }
  echo -e "  ${C}Sending…${NC}"
  if ( cd "$APP_DIR" && node -e "require('dotenv').config(); require('./services/email').sendTestEmail(process.argv[1]).then(()=>{console.log('ok')}).catch(e=>{console.error(e.message);process.exit(1)})" "$to" ) 2>/tmp/drfx_mailtest.log; then
    echo -e "  ${G}✔ Sent. Check the inbox (and spam) for ${to}.${NC}"
  else
    echo -e "  ${R}✘ Failed:${NC} $(tr -d '\n' < /tmp/drfx_mailtest.log 2>/dev/null)"
    echo -e "  ${DIM}Double-check host/port/secure/username/password.${NC}"
  fi
  rm -f /tmp/drfx_mailtest.log
  pause
}

show_status() {
  banner
  read_status
  echo ""
  printf "   ${C}%-14s${NC} %b\n" "Service"   "${PM2_NAME}  [${PM2_STATE}]   ${DIM}${APP_MEM}${NC}"
  printf "   ${C}%-14s${NC} %b\n" "RAM"        "$(free -h 2>/dev/null | awk '/^Mem:/{print $3" used / "$2" total ("$7" avail)"}')"
  printf "   ${C}%-14s${NC} %b\n" "Swap"       "$(free -h 2>/dev/null | awk '/^Swap:/{print $3" / "$2}')"
  printf "   ${C}%-14s${NC} %b\n" "Disk (/)"   "$(df -h / 2>/dev/null | awk 'NR==2{print $3" used / "$2" ("$5" full)"}')"
  printf "   ${C}%-14s${NC} %b\n" "Load"       "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
  echo ""
  echo -e "   ${DIM}Live monitor:  pm2 monit${NC}"
  pause
}

reference() {
  banner
  echo ""
  echo -e "   ${BOLD}Command reference${NC} ${DIM}(copy/paste)${NC}"
  rule
  echo -e "   ${BOLD}Service${NC}"
  echo -e "    ${DIM}\$${NC} pm2 status            ${DIM}# all processes + memory${NC}"
  echo -e "    ${DIM}\$${NC} pm2 logs ${PM2_NAME}"
  echo -e "    ${DIM}\$${NC} pm2 restart ${PM2_NAME} --update-env"
  echo ""
  echo -e "   ${BOLD}Domain / SSL${NC}"
  echo -e "    ${DIM}\$${NC} sudo nano ${NGINX_SITE}     ${DIM}# server_name + proxy_pass${NC}"
  echo -e "    ${DIM}\$${NC} sudo nginx -t && sudo systemctl reload nginx"
  echo -e "    ${DIM}\$${NC} sudo certbot --nginx -d yourdomain.com"
  echo ""
  echo -e "   ${BOLD}Database${NC}"
  local dbn; dbn="$(getenv DB_NAME)"; dbn="${dbn:-drfx_quant}"
  echo -e "    ${DIM}\$${NC} sudo -u postgres psql -d ${dbn}"
  echo -e "    ${DIM}\$${NC} sudo -u postgres pg_dump ${dbn} > backup_\$(date +%F).sql"
  echo ""
  echo -e "   ${BOLD}Update to a new version${NC}"
  echo -e "    ${DIM}\$${NC} cd <your DrFXQuant checkout> && git pull && sudo bash update.sh"
  pause
}

# ---- main loop -------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  echo -e "${Y}  ⚠ Not running as root — editing config and restarting need:  sudo bash $0${NC}"
  sleep 1
fi
[ ! -f "$ENV_FILE" ] && echo -e "${Y}  ⚠ $ENV_FILE not found. Are you on the server? (APP_DIR=$APP_DIR)${NC}" && sleep 1

while true; do
  banner
  dashboard
  menu
  read -rp "  Select: " choice
  case "$choice" in
    1) edit_value ADMIN_EMAIL "admin email" "Note: changing this to a NEW address creates a new admin on next restart; the old one stays admin too." 0 ;;
    2) edit_admin_password ;;
    3) edit_value NOWPAYMENTS_API_KEY "NowPayments API key" "From nowpayments.io → Settings → API keys." 1 ;;
    4) edit_value NOWPAYMENTS_IPN_SECRET "NowPayments IPN secret" "From nowpayments.io → Settings → IPN. Required to confirm payments." 1 ;;
    5) edit_value OPENROUTER_API_KEY "OpenRouter API key" "From openrouter.ai → Keys. Powers the AI assistant." 1 ;;
    6) smtp_menu ;;
    7) do_restart; pause ;;
    8) show_status ;;
    9) banner; echo ""; echo -e "  ${DIM}Streaming logs — press Ctrl-C to return…${NC}"; echo ""; pm2 logs "$PM2_NAME" ;;
    r|R) reference ;;
    q|Q|0) echo ""; echo -e "  ${DIM}Bye.${NC}"; echo ""; exit 0 ;;
    *) ;;
  esac
done
