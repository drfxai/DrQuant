#!/usr/bin/env bash
# ============================================================================
#  Quantum Chat — one-command installer (Ubuntu/Debian)
#  DNS-resilient, end-to-end encrypted emergency messenger.
#
#  Usage:
#     sudo bash install-quantum-chat.sh
#     sudo bash -c "$(curl -Ls https://YOUR_DOMAIN/install-quantum-chat.sh)"
#
#  Idempotent: safe to re-run. It will NOT overwrite an existing .env or delete
#  any data unless you pass --force. Authoring-only artifact — review before use.
# ============================================================================
set -Eeuo pipefail

REPO_URL="${QC_REPO_URL:-https://github.com/drfxai/DrFXQuant.git}"
SUBDIR="quantum-chat"
SVC_USER="quantum-chat"
BIN_PATH="/usr/local/bin/quantum-chat"
ETC_DIR="/etc/quantum-chat"
LIB_DIR="/var/lib/quantum-chat"
ENV_FILE="${ETC_DIR}/quantum-chat.env"
UNIT_FILE="/etc/systemd/system/quantum-chat.service"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

log()  { printf '\033[1;36m[quantum-chat]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- 1. distro detection ----------------------------------------------------
[[ -f /etc/os-release ]] || die "cannot detect OS (no /etc/os-release)"
. /etc/os-release
case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) : ;;
  *) die "this installer supports Debian/Ubuntu; detected '${ID:-unknown}'" ;;
esac
log "Detected ${PRETTY_NAME:-Debian/Ubuntu}"

# --- 2. require root --------------------------------------------------------
[[ "$(id -u)" -eq 0 ]] || die "run as root (sudo)."

# --- 3. base packages -------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
log "Installing base packages..."
apt-get update -qq
apt-get install -y -qq curl git ufw ca-certificates openssl jq >/dev/null

# --- 4. Go toolchain (to build the DNS microservice) ------------------------
if ! have go; then
  log "Installing Go toolchain (golang-go)..."
  apt-get install -y -qq golang-go >/dev/null || die "failed to install Go; install Go >=1.22 manually and re-run"
fi
GO_VER="$(go version | awk '{print $3}')"
log "Go: ${GO_VER}"

# --- 12-prompt. gather configuration ---------------------------------------
prompt() { # prompt VAR "Question" "default"
  local __var="$1" __q="$2" __def="${3:-}" __ans
  if [[ -n "${!__var:-}" ]]; then return; fi          # env override wins
  if [[ ! -t 0 ]]; then printf -v "$__var" '%s' "$__def"; return; fi  # non-interactive
  read -r -p "$__q [${__def}]: " __ans || true
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

log "Configuration (press Enter to accept defaults):"
prompt QC_DOMAIN     "DNS subdomain to delegate to this server" "qc.example.com"
prompt QC_NS1        "Primary nameserver hostname"              "ns1.${QC_DOMAIN}"
PUBIP_GUESS="$(curl -Ls https://api.ipify.org 2>/dev/null || echo "")"
prompt QC_PUBLIC_IP  "Public IPv4 of this server"               "${PUBIP_GUESS:-203.0.113.10}"
prompt QC_ADMIN_EMAIL "Admin email (SOA contact)"               "admin@example.com"
prompt QC_STORAGE    "Storage mode (ram/postgres)"              "ram"
QC_PG_URL=""; QC_REDIS_URL=""
if [[ "$QC_STORAGE" == "postgres" ]]; then
  prompt QC_PG_URL   "PostgreSQL URL (postgres://user:pass@host/db?sslmode=disable)" ""
fi
prompt QC_REDIS_URL  "Redis URL (optional, for multi-node)"     ""
prompt QC_ENABLE_LOGS "Enable operational logs? (true/false)"   "false"
prompt QC_TTL        "Message TTL minutes"                      "1440"

# --- 6/7. derive source, build ---------------------------------------------
SRC_DIR=""
if [[ -f "go.mod" && -d "internal" && "$(basename "$PWD")" == "$SUBDIR" ]]; then
  SRC_DIR="$PWD"
elif [[ -d "$SUBDIR" && -f "$SUBDIR/go.mod" ]]; then
  SRC_DIR="$PWD/$SUBDIR"
else
  TMP="$(mktemp -d)"
  log "Cloning ${REPO_URL} ..."
  git clone --depth 1 "$REPO_URL" "$TMP/repo" >/dev/null 2>&1 || die "git clone failed"
  SRC_DIR="$TMP/repo/$SUBDIR"
  [[ -f "$SRC_DIR/go.mod" ]] || die "subdir '$SUBDIR' not found in repo"
fi
log "Building from ${SRC_DIR} ..."
( cd "$SRC_DIR" && GOFLAGS=-mod=mod CGO_ENABLED=0 go build -trimpath -o "$BIN_PATH" ./cmd/quantum-chat ) \
  || die "go build failed"
chmod 0755 "$BIN_PATH"
log "Installed binary: $($BIN_PATH version)"

# --- 6b. Postgres schema (durable mode) ------------------------------------
if [[ "$QC_STORAGE" == "postgres" && -n "$QC_PG_URL" ]]; then
  have psql || apt-get install -y -qq postgresql-client >/dev/null 2>&1 || true
  if have psql && psql "$QC_PG_URL" -1 -f "$SRC_DIR/migrations/001_quantum_chat_schema.sql" >/dev/null 2>&1; then
    log "Postgres schema applied."
  else
    warn "Apply migrations/001_quantum_chat_schema.sql to your database manually."
  fi
fi

# --- 9. service user --------------------------------------------------------
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  log "Creating system user '$SVC_USER'..."
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
else
  log "User '$SVC_USER' already exists (ok)."
fi

# --- 10. directories --------------------------------------------------------
install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$ETC_DIR" "$LIB_DIR"

# --- 8/11. secrets + .env (idempotent, never clobber without --force) -------
gen_secret() { openssl rand -hex 32; }
if [[ -f "$ENV_FILE" && "$FORCE" -eq 0 ]]; then
  warn "$ENV_FILE exists — keeping it (use --force to regenerate). Secrets preserved."
else
  log "Writing $ENV_FILE ..."
  ADMIN_TOKEN="$(gen_secret)"; SECRET_KEY="$(gen_secret)"
  umask 077
  cat > "$ENV_FILE" <<EOF
QUANTUM_CHAT_DOMAIN=${QC_DOMAIN}
QUANTUM_CHAT_EXTRA_DOMAINS=
QUANTUM_CHAT_PUBLIC_IP=${QC_PUBLIC_IP}
QUANTUM_CHAT_NS_NAMES=${QC_NS1}
QUANTUM_CHAT_ADMIN_EMAIL=${QC_ADMIN_EMAIL}
QUANTUM_CHAT_PORT=53
QUANTUM_CHAT_BIND_ADDR=0.0.0.0
QUANTUM_CHAT_TCP_ENABLED=true
QUANTUM_CHAT_UDP_ENABLED=true
QUANTUM_CHAT_STORAGE_MODE=${QC_STORAGE}
QUANTUM_CHAT_POSTGRES_URL=${QC_PG_URL}
QUANTUM_CHAT_REDIS_URL=${QC_REDIS_URL}
QUANTUM_CHAT_MESSAGE_TTL_MINUTES=${QC_TTL}
QUANTUM_CHAT_MAX_MESSAGE_SIZE=2048
QUANTUM_CHAT_RATE_LIMIT_PER_MINUTE=30
QUANTUM_CHAT_ENABLE_LOGS=${QC_ENABLE_LOGS}
QUANTUM_CHAT_ADMIN_TOKEN=${ADMIN_TOKEN}
QUANTUM_CHAT_SECRET_KEY=${SECRET_KEY}
QUANTUM_CHAT_RESOLVER_BANK=1.1.1.1,8.8.8.8,9.9.9.9,208.67.222.222
EOF
fi
chown "$SVC_USER:$SVC_USER" "$ENV_FILE"
chmod 0600 "$ENV_FILE"

# --- 13. systemd unit -------------------------------------------------------
log "Installing systemd unit..."
if [[ -f "$SRC_DIR/systemd/quantum-chat.service" ]]; then
  install -m 0644 "$SRC_DIR/systemd/quantum-chat.service" "$UNIT_FILE"
else
  die "systemd unit not found at $SRC_DIR/systemd/quantum-chat.service"
fi
systemctl daemon-reload
systemctl enable quantum-chat >/dev/null 2>&1 || true

# --- 14. firewall -----------------------------------------------------------
# This node normally runs ALONGSIDE the main DrFX Quantum web platform, which
# needs 80/443. Open them here too, so that enabling ufw can never silently cut
# off the website (or Let's Encrypt's port-80 challenge) on a shared box. On a
# dedicated DNS-only box these rules are harmless (nothing listens there).
log "Configuring firewall (UDP/TCP 53 + SSH + HTTP/HTTPS)..."
ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 53/udp >/dev/null 2>&1 || true
ufw allow 53/tcp >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
if ! ufw status | grep -q "Status: active"; then
  warn "Enabling ufw (SSH, DNS, and HTTP/HTTPS allowed above)."
  yes | ufw enable >/dev/null 2>&1 || true
fi

# --- 15/16. systemd-resolved squats 127.0.0.53:53 and blocks our bind ------
# free_port53 disables the resolved STUB listener (not resolved itself) and
# repoints /etc/resolv.conf at the real upstream resolvers so the box keeps
# resolving DNS. This changes system DNS config, so it is prompted (default yes,
# since the authoritative server cannot bind :53 otherwise). Override with
# QC_FREE_PORT53=no to skip.
free_port53() {
  log "Freeing port 53 (disabling the systemd-resolved stub listener)..."
  local rc=/etc/systemd/resolved.conf
  # 1) Set DNSStubListener=no, handling commented / missing lines + section.
  if [[ -f "$rc" ]] && grep -qE '^[[:space:]]*#?[[:space:]]*DNSStubListener=' "$rc"; then
    sed -i -E 's/^[[:space:]]*#?[[:space:]]*DNSStubListener=.*/DNSStubListener=no/' "$rc"
  elif [[ -f "$rc" ]] && grep -q '^\[Resolve\]' "$rc"; then
    sed -i '/^\[Resolve\]/a DNSStubListener=no' "$rc"
  else
    printf '\n[Resolve]\nDNSStubListener=no\n' >> "$rc"
  fi
  # 2) Keep the host able to resolve DNS via the REAL upstreams (not the stub).
  if [[ -e /run/systemd/resolve/resolv.conf ]]; then
    ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf
  else
    warn "/run/systemd/resolve/resolv.conf missing; writing public resolvers to /etc/resolv.conf"
    printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf
  fi
  # 3) Restart resolved to release the socket.
  systemctl restart systemd-resolved 2>/dev/null || true
  sleep 1
  # 4) Verify the port is actually free now.
  if ss -lunp 2>/dev/null | grep -q ':53 .*systemd-resolve'; then
    warn "systemd-resolved still appears to hold :53 — check 'systemctl status systemd-resolved'."
  else
    log "Port 53 is free."
  fi
}

if ss -lunp 2>/dev/null | grep -q ':53 .*systemd-resolve'; then
  warn "systemd-resolved is listening on 127.0.0.53:53, which blocks Quantum Chat from binding :53."
  prompt QC_FREE_PORT53 "Free port 53 now (disable the resolved stub + repoint /etc/resolv.conf)?" "yes"
  case "${QC_FREE_PORT53,,}" in
    y|yes|true|1) free_port53 ;;
    *)
      warn "Leaving systemd-resolved as-is; the service will fail to start until :53 is free."
      warn "  Manual fix: set DNSStubListener=no in /etc/systemd/resolved.conf, then run"
      warn "  'sudo ln -sf /run/systemd/resolve/resolv.conf /etc/resolv.conf && sudo systemctl restart systemd-resolved'."
      ;;
  esac
fi

# --- 17. start + health -----------------------------------------------------
log "Starting quantum-chat..."
systemctl restart quantum-chat || die "service failed to start (check: journalctl -u quantum-chat -n50)"
sleep 1
if "$BIN_PATH" health; then
  log "Health check passed."
else
  warn "Health check failed — inspect: journalctl -u quantum-chat -f"
fi

# --- 20. DNS records to configure at your registrar/DNS host ----------------
cat <<SUMMARY

============================================================================
 Quantum Chat installed.

 Service:     systemctl status quantum-chat
 Logs:        journalctl -u quantum-chat -f
 Health:      quantum-chat health
 Config:      ${ENV_FILE}  (0600)
 Binary:      ${BIN_PATH}

 DNS DELEGATION — set these at the DNS host of your PARENT domain:
   ; 1) Glue/host record for the nameserver
   ${QC_NS1%.*}                A      ${QC_PUBLIC_IP}
   ; 2) Delegate the subdomain to it
   ${QC_DOMAIN}.               NS     ${QC_NS1}.

 REQUIREMENT: this VPS must receive UDP *and* TCP on port 53 from the public
 internet. Verify from another host:
   dig @${QC_PUBLIC_IP} ${QC_DOMAIN} SOA +norecurse
   dig +tcp @${QC_PUBLIC_IP} ${QC_DOMAIN} SOA

 Storage mode: ${QC_STORAGE}$( [[ "$QC_STORAGE" == "postgres" ]] && echo "  (durable; falls back to RAM if DB unreachable)" )
 Update:       sudo bash update-quantum-chat.sh
 Uninstall:    sudo bash uninstall-quantum-chat.sh
============================================================================
SUMMARY
