#!/usr/bin/env bash
# ============================================================================
#  Quantum Chat — updater (Ubuntu/Debian)
#  Rebuilds the binary from the latest source and restarts the service.
#  Does NOT touch your .env, data, user, or firewall rules.
#
#  Usage:
#     sudo bash update-quantum-chat.sh
#     (from a local checkout, or it will clone the repo fresh)
# ============================================================================
set -Eeuo pipefail

REPO_URL="${QC_REPO_URL:-https://github.com/drfxai/DrFXQuant.git}"
SUBDIR="quantum-chat"
BIN_PATH="/usr/local/bin/quantum-chat"
UNIT_FILE="/etc/systemd/system/quantum-chat.service"

log()  { printf '\033[1;36m[quantum-chat]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[[ "$(id -u)" -eq 0 ]] || die "run as root (sudo)."
have go || die "Go toolchain not found; install Go >=1.22 and re-run."

# Locate source (local checkout preferred, else clone).
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
fi
[[ -f "$SRC_DIR/go.mod" ]] || die "source not found"

OLD_VER="$($BIN_PATH version 2>/dev/null || echo none)"
log "Current: ${OLD_VER}"

# Build to a temp path, then atomically swap to avoid a broken binary on disk.
TMP_BIN="$(mktemp)"
log "Building from ${SRC_DIR} ..."
( cd "$SRC_DIR" && GOFLAGS=-mod=mod CGO_ENABLED=0 go build -trimpath -o "$TMP_BIN" ./cmd/quantum-chat ) \
  || { rm -f "$TMP_BIN"; die "go build failed — service left running on old binary"; }
chmod 0755 "$TMP_BIN"
install -m 0755 "$TMP_BIN" "$BIN_PATH"
rm -f "$TMP_BIN"
log "Updated binary: $($BIN_PATH version)"

# Refresh the unit if the repo ships a newer one.
if [[ -f "$SRC_DIR/systemd/quantum-chat.service" ]]; then
  install -m 0644 "$SRC_DIR/systemd/quantum-chat.service" "$UNIT_FILE"
  systemctl daemon-reload
fi

log "Restarting service..."
systemctl restart quantum-chat || die "restart failed (check: journalctl -u quantum-chat -n50)"
sleep 1
if "$BIN_PATH" health; then
  log "Update complete and healthy."
else
  warn "Service restarted but health check failed — inspect: journalctl -u quantum-chat -f"
fi
