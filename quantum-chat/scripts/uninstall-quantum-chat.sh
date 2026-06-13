#!/usr/bin/env bash
# ============================================================================
#  Quantum Chat — uninstaller (Ubuntu/Debian)
#  Stops and removes the service + binary. Data, config, user and firewall
#  rules are removed ONLY if you explicitly confirm (or pass --purge).
#
#  Usage:  sudo bash uninstall-quantum-chat.sh [--purge]
# ============================================================================
set -Eeuo pipefail

SVC_USER="quantum-chat"
BIN_PATH="/usr/local/bin/quantum-chat"
ETC_DIR="/etc/quantum-chat"
LIB_DIR="/var/lib/quantum-chat"
UNIT_FILE="/etc/systemd/system/quantum-chat.service"
PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

log()  { printf '\033[1;36m[quantum-chat]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "run as root (sudo)."

confirm() { # confirm "question" -> 0 if yes
  [[ "$PURGE" -eq 1 ]] && return 0
  [[ ! -t 0 ]] && return 1   # non-interactive without --purge = keep data
  local a; read -r -p "$1 [y/N]: " a || true
  [[ "$a" =~ ^[Yy]$ ]]
}

log "Stopping and disabling service..."
systemctl stop quantum-chat 2>/dev/null || true
systemctl disable quantum-chat 2>/dev/null || true

if [[ -f "$UNIT_FILE" ]]; then
  rm -f "$UNIT_FILE"
  systemctl daemon-reload
  log "Removed systemd unit."
fi

if [[ -x "$BIN_PATH" ]]; then
  rm -f "$BIN_PATH"
  log "Removed binary."
fi

# --- destructive steps: confirmation required ------------------------------
if confirm "Remove firewall rules for 53/udp and 53/tcp?"; then
  ufw delete allow 53/udp >/dev/null 2>&1 || true
  ufw delete allow 53/tcp >/dev/null 2>&1 || true
  log "Removed firewall rules (SSH rule left intact)."
else
  warn "Keeping firewall rules."
fi

if confirm "DELETE config + stored data ($ETC_DIR, $LIB_DIR)? This is irreversible."; then
  rm -rf "$ETC_DIR" "$LIB_DIR"
  log "Removed config and data directories."
  if id -u "$SVC_USER" >/dev/null 2>&1 && confirm "Also remove system user '$SVC_USER'?"; then
    userdel "$SVC_USER" 2>/dev/null || true
    log "Removed user '$SVC_USER'."
  fi
else
  warn "Keeping $ETC_DIR and $LIB_DIR (config + data preserved)."
fi

log "Uninstall complete."
