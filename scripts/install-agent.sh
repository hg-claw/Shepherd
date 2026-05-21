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

# --- CLI globals -----------------------------------------------------------

# Globals set by parse_args.
MODE=""        # install | uninstall
TOKEN=""
SERVER_URL=""
VERSION=""     # optional override; empty → derived from script URL pinning

parse_args() {
	MODE="install"
	while [ $# -gt 0 ]; do
		case "$1" in
			--token)     TOKEN="$2";      shift 2 ;;
			--server)    SERVER_URL="$2"; shift 2 ;;
			--version)   VERSION="$2";    shift 2 ;;
			--uninstall) MODE="uninstall"; shift   ;;
			*) err "unknown arg: $1"; return 1 ;;
		esac
	done
	if [ "$MODE" = "install" ]; then
		[ -n "$TOKEN" ]      || { err "--token required"; return 1; }
		[ -n "$SERVER_URL" ] || { err "--server required"; return 1; }
	fi
}

# --- Release URL + checksum helpers ----------------------------------------

# BUILD_TAG: substituted by `make release` at build time. Default lets
# the script run from a `git clone` checkout against the latest release.
BUILD_TAG="${BUILD_TAG:-v0.5.0}"

release_tag() {
	if [ -n "${VERSION:-}" ]; then echo "$VERSION"; else echo "$BUILD_TAG"; fi
}

asset_url() {
	local os="$1" arch="$2" tag="$3"
	if [ "$os" = "linux" ]; then
		# Linux release ships server+agent in one tarball.
		echo "https://github.com/${REPO}/releases/download/${tag}/shepherd-linux-${arch}.tar.gz"
	else
		# Darwin release ships agent-only.
		echo "https://github.com/${REPO}/releases/download/${tag}/shepherd-agent-${os}-${arch}.tar.gz"
	fi
}

sha256sum_cmd() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	else
		shasum -a 256 "$1" | awk '{print $1}'
	fi
}

verify_sha256() {
	local file="$1" sumfile="$2"
	local got want
	got=$(sha256sum_cmd "$file")
	want=$(awk '{print $1}' "$sumfile")
	[ "$got" = "$want" ] || { err "sha256 mismatch: got $got want $want"; return 1; }
}

download_with_retry() {
	local url="$1" out="$2" attempt
	for attempt in 1 2 3; do
		if curl -fsSL --connect-timeout 10 -o "$out" "$url"; then
			return 0
		fi
		err "download attempt $attempt failed: $url"
		sleep $((attempt * 2))
	done
	return 3
}

# --- Linux install / uninstall ---------------------------------------------

install_linux() {
	command -v systemctl >/dev/null 2>&1 || { err "systemctl not found"; return 5; }
	systemctl stop shepherd-agent 2>/dev/null || true

	mv -f "$1" "${BIN_PATH}.new"
	chmod 0755 "${BIN_PATH}.new"
	mv -f "${BIN_PATH}.new" "$BIN_PATH"

	mkdir -p "$ENV_DIR"
	cat > "$ENV_FILE" <<EOF
SHEPHERD_SERVER_URL=${SERVER_URL}
SHEPHERD_ENROLLMENT_TOKEN=${TOKEN}
EOF
	chmod 0600 "$ENV_FILE"

	cat > "$LINUX_UNIT" <<'EOF'
[Unit]
Description=Shepherd Agent
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/shepherd-agent/env
ExecStart=/usr/local/bin/shepherd-agent
Restart=always
RestartSec=5
StandardOutput=append:/var/log/shepherd-agent.log
StandardError=append:/var/log/shepherd-agent.log

[Install]
WantedBy=multi-user.target
EOF

	systemctl daemon-reload
	systemctl enable --now shepherd-agent
}

uninstall_linux() {
	systemctl disable --now shepherd-agent 2>/dev/null || true
	rm -f "$LINUX_UNIT"
	rm -f "$BIN_PATH"
	systemctl daemon-reload || true
	echo "Config dir $ENV_DIR preserved. To remove: sudo rm -rf $ENV_DIR"
}

# --- Darwin install / uninstall --------------------------------------------

install_darwin() {
	command -v launchctl >/dev/null 2>&1 || { err "launchctl not found"; return 5; }
	launchctl bootout "system/${LAUNCHD_LABEL}" 2>/dev/null || true

	mv -f "$1" "${BIN_PATH}.new"
	chmod 0755 "${BIN_PATH}.new"
	mv -f "${BIN_PATH}.new" "$BIN_PATH"

	mkdir -p "$ENV_DIR"
	cat > "$ENV_FILE" <<EOF
SHEPHERD_SERVER_URL=${SERVER_URL}
SHEPHERD_ENROLLMENT_TOKEN=${TOKEN}
EOF
	chmod 0600 "$ENV_FILE"

	cat > "$DARWIN_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
    "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>                <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>     <array><string>${BIN_PATH}</string></array>
    <key>EnvironmentVariables</key> <dict>
        <key>SHEPHERD_SERVER_URL</key>        <string>${SERVER_URL}</string>
        <key>SHEPHERD_ENROLLMENT_TOKEN</key>  <string>${TOKEN}</string>
    </dict>
    <key>RunAtLoad</key>            <true/>
    <key>KeepAlive</key>            <true/>
    <key>StandardOutPath</key>      <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>    <string>${LOG_FILE}</string>
</dict>
</plist>
EOF
	chmod 0644 "$DARWIN_PLIST"
	launchctl bootstrap system "$DARWIN_PLIST"
	launchctl kickstart -k "system/${LAUNCHD_LABEL}"
}

uninstall_darwin() {
	launchctl bootout "system/${LAUNCHD_LABEL}" 2>/dev/null || true
	rm -f "$DARWIN_PLIST"
	rm -f "$BIN_PATH"
	echo "Config dir $ENV_DIR preserved. To remove: sudo rm -rf $ENV_DIR"
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
