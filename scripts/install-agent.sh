#!/usr/bin/env bash
# install-agent.sh — one-shot installer for the Shepherd agent.
#
# Usage:
#   curl -fsSL <URL> | sudo bash -s -- --token T --server https://...
#   curl -fsSL <URL> | sudo bash -s -- --uninstall
#
# Exit codes: 0 ok / 1 not root / 2 unsupported OS|arch / 3 download failed
#             4 checksum mismatch / 5 no service manager / 6 connect timeout

set -euo pipefail

# --- Configuration knobs ---------------------------------------------------

REPO="hg-claw/Shepherd"
BIN_DIR="/usr/local/bin"
BIN_PATH="${BIN_DIR}/shepherd-agent"
ENV_DIR="/etc/shepherd-agent"
ENV_FILE="${ENV_DIR}/env"
LINUX_UNIT="/etc/systemd/system/shepherd-agent.service"
DARWIN_PLIST="/Library/LaunchDaemons/com.shepherd.agent.plist"
LAUNCHD_LABEL="com.shepherd.agent"
LOG_FILE="/var/log/shepherd-agent.log"
HEALTHCHECK_TIMEOUT=30
HEALTHCHECK_INTERVAL=2

# --- Helpers ---------------------------------------------------------------

err() { echo "error: $*" >&2; }

detect_os() {
	case "$(uname -s)" in
		Linux)  echo linux  ;;
		Darwin) echo darwin ;;
		*) err "unsupported OS: $(uname -s)"; return 2 ;;
	esac
}

detect_arch() {
	case "$(uname -m)" in
		x86_64|amd64) echo amd64 ;;
		aarch64|arm64) echo arm64 ;;
		*) err "unsupported arch: $(uname -m)"; return 2 ;;
	esac
}

# --- Source-only short-circuit (for BATS tests) ---------------------------
#
# When sourced with `--source` as the first arg, define the helpers but
# don't run main(). Lets unit tests exercise individual functions.

if [ "${1:-}" = "--source" ]; then
	return 0 2>/dev/null || exit 0
fi

# --- Main (placeholder until later tasks) ---------------------------------
err "install body not implemented yet"
exit 99
