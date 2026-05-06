#!/usr/bin/env bash
# Shepherd Phase 1.A — end-to-end smoke test
# Exercises: build → server → login → agent (AUTO_RECOVER_KEY) → telemetry →
#             config push → public page → offline detection
# Skipped: SSH installer path (requires sshd config)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------------
# Cleanup / trap
# ---------------------------------------------------------------------------
WORKDIR=""
SERVER_PID=""
AGENT_PID=""
PASS=0

cleanup() {
  local exit_code=$?
  if [ -n "$AGENT_PID" ]; then
    kill "$AGENT_PID" 2>/dev/null || true
    wait "$AGENT_PID" 2>/dev/null || true
  fi
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$PASS" -ne 1 ] && [ -n "$WORKDIR" ]; then
    echo ""
    echo "=== FAIL — dumping logs for diagnosis ==="
    echo "--- server.log ---"
    cat "$WORKDIR/server.log" 2>/dev/null || true
    echo "--- agent.log ---"
    cat "$WORKDIR/agent.log" 2>/dev/null || true
    exit 1
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Step 1: Build
# ---------------------------------------------------------------------------
echo "[1/11] Building binaries..."
cd "$REPO_ROOT"
make agent server
echo "      OK: $(ls -lh bin/shepherd-agent bin/shepherd-server | awk '{print $NF, $5}')"

# ---------------------------------------------------------------------------
# Step 2: Isolated workspace
# ---------------------------------------------------------------------------
echo "[2/11] Creating workspace..."
WORKDIR=$(mktemp -d)
DBFILE="$WORKDIR/shepherd.db"
STATEFILE="$WORKDIR/agent.state.json"
COOKIES="$WORKDIR/cookies.txt"
echo "      workdir: $WORKDIR"

# ---------------------------------------------------------------------------
# Step 3: Start server
# ---------------------------------------------------------------------------
echo "[3/11] Starting server..."
INITIAL_ADMIN_USERNAME=alice \
INITIAL_ADMIN_PASSWORD=hunter2 \
AUTO_RECOVER_KEY=secret \
DATABASE_DSN="file:$DBFILE?_fk=1" \
SERVER_PUBLIC_URL=http://localhost:8080 \
"$REPO_ROOT/bin/shepherd-server" > "$WORKDIR/server.log" 2>&1 &
SERVER_PID=$!

# Wait for server to be ready
MAX_WAIT=20
ELAPSED=0
until curl -sf http://localhost:8080/api/public/servers > /dev/null 2>&1; do
  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    echo "      TIMEOUT: server never became ready"
    exit 1
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

PUBLIC_EMPTY=$(curl -sf http://localhost:8080/api/public/servers)
if [ "$PUBLIC_EMPTY" != "[]" ]; then
  echo "      FAIL: expected [], got: $PUBLIC_EMPTY"
  exit 1
fi
echo "      OK: public/servers = []"

# ---------------------------------------------------------------------------
# Step 4: Log in
# ---------------------------------------------------------------------------
echo "[4/11] Logging in as alice..."
LOGIN_RESP=$(curl -sf -c "$COOKIES" -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"hunter2"}' \
  http://localhost:8080/api/login)
if ! echo "$LOGIN_RESP" | jq -e '.username == "alice"' > /dev/null 2>&1; then
  echo "      FAIL: unexpected login response: $LOGIN_RESP"
  exit 1
fi
echo "      OK: $LOGIN_RESP"

# ---------------------------------------------------------------------------
# Step 5: Start agent (AUTO_RECOVER_KEY bypasses SSH installer)
# ---------------------------------------------------------------------------
echo "[5/11] Starting agent..."
SERVER_URL=http://localhost:8080 \
AUTO_RECOVER_KEY=secret \
STATE_PATH="$STATEFILE" \
"$REPO_ROOT/bin/shepherd-agent" > "$WORKDIR/agent.log" 2>&1 &
AGENT_PID=$!

# ---------------------------------------------------------------------------
# Step 6: Verify server registered the agent
# ---------------------------------------------------------------------------
echo "[6/11] Waiting for agent registration..."
MAX_WAIT=30
ELAPSED=0
until curl -sf -b "$COOKIES" http://localhost:8080/api/servers 2>/dev/null | \
    jq -e '.[0].install_stage == "done"' > /dev/null 2>&1; do
  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    echo "      TIMEOUT: agent never registered"
    exit 1
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done
SID=$(curl -sf -b "$COOKIES" http://localhost:8080/api/servers | jq -r '.[0].id')
SERVER_INFO=$(curl -sf -b "$COOKIES" http://localhost:8080/api/servers | \
  jq '.[0] | {id, name, agent_fingerprint, agent_last_seen, install_stage}')
echo "      OK (server_id=$SID): $SERVER_INFO"

# ---------------------------------------------------------------------------
# Step 7: Verify telemetry flowing (default interval=30s, first tick primes
#          net-delta so first storable point arrives at ~60s)
# ---------------------------------------------------------------------------
echo "[7/11] Waiting for first telemetry point (~65s at default 30s interval)..."
MAX_WAIT=80
ELAPSED=0
until [ "$(curl -sf -b "$COOKIES" "http://localhost:8080/api/servers/$SID/telemetry?range=1h" 2>/dev/null | jq 'length' 2>/dev/null)" -ge 1 ] 2>/dev/null; do
  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    echo "      TIMEOUT: no telemetry in ${MAX_WAIT}s"
    exit 1
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done
COUNT=$(curl -sf -b "$COOKIES" "http://localhost:8080/api/servers/$SID/telemetry?range=1h" | jq 'length')
FIRST=$(curl -sf -b "$COOKIES" "http://localhost:8080/api/servers/$SID/telemetry?range=1h" | jq '.[0]')
echo "      OK: count=$COUNT, first point=$FIRST"

# ---------------------------------------------------------------------------
# Step 8: Push config update to shorten interval to 10s; verify more points
# ---------------------------------------------------------------------------
echo "[8/11] Pushing config update (interval=10s)..."
CONFIG_STATUS=$(curl -sfo /dev/null -w "%{http_code}" -b "$COOKIES" \
  -H 'Content-Type: application/json' \
  -d '{"telemetry_interval_seconds":10}' \
  "http://localhost:8080/api/servers/$SID/config")
if [ "$CONFIG_STATUS" != "204" ]; then
  echo "      FAIL: expected 204, got $CONFIG_STATUS"
  exit 1
fi
echo "      OK: 204 No Content"

BEFORE=$COUNT
echo "      Waiting for new points at 10s cadence (prev count=$BEFORE)..."
MAX_WAIT=60
ELAPSED=0
until [ "$(curl -sf -b "$COOKIES" "http://localhost:8080/api/servers/$SID/telemetry?range=1h" 2>/dev/null | jq 'length' 2>/dev/null)" -gt "$BEFORE" ] 2>/dev/null; do
  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    echo "      TIMEOUT: count did not increase beyond $BEFORE in ${MAX_WAIT}s"
    exit 1
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done
AFTER=$(curl -sf -b "$COOKIES" "http://localhost:8080/api/servers/$SID/telemetry?range=1h" | jq 'length')
echo "      OK: count grew from $BEFORE to $AFTER"

# ---------------------------------------------------------------------------
# Step 9: Make the server public; verify public list; PII check
# ---------------------------------------------------------------------------
echo "[9/11] Making server public..."
PATCH_RESP=$(curl -sf -b "$COOKIES" -X PATCH -H 'Content-Type: application/json' \
  -d '{"public_alias":"DEV-1","show_on_public":true,"country_code":"US"}' \
  "http://localhost:8080/api/servers/$SID")
if ! echo "$PATCH_RESP" | jq -e '.show_on_public == true' > /dev/null 2>&1; then
  echo "      FAIL: patch response unexpected: $PATCH_RESP"
  exit 1
fi
echo "      OK: patched"

PUBLIC_BODY=$(curl -sf http://localhost:8080/api/public/servers)
if ! echo "$PUBLIC_BODY" | jq -e '.[0].alias == "DEV-1"' > /dev/null 2>&1; then
  echo "      FAIL: alias missing; body: $PUBLIC_BODY"
  exit 1
fi
if ! echo "$PUBLIC_BODY" | jq -e '.[0].country_code == "US"' > /dev/null 2>&1; then
  echo "      FAIL: country_code missing"
  exit 1
fi
if ! echo "$PUBLIC_BODY" | jq -e '.[0].online == true' > /dev/null 2>&1; then
  echo "      FAIL: expected online=true"
  exit 1
fi
echo "      OK: public card correct"

# PII checks
if echo "$PUBLIC_BODY" | grep -q '"agent_fingerprint"'; then
  echo "      FAIL PII LEAK: agent_fingerprint visible in public response"
  exit 1
fi
if echo "$PUBLIC_BODY" | grep -q '"name":'; then
  echo "      FAIL PII LEAK: internal name visible in public response"
  exit 1
fi
echo "      OK: PII check passed"
echo "      public body: $PUBLIC_BODY"

# ---------------------------------------------------------------------------
# Step 10: Stop agent; verify offline detection
# ---------------------------------------------------------------------------
echo "[10/11] Stopping agent; waiting for offline detection..."
kill "$AGENT_PID" 2>/dev/null || true
wait "$AGENT_PID" 2>/dev/null || true
AGENT_PID=""

# online threshold = max(90s, 3 × default_interval) = max(90s, 30s) = 90s
# Poll until online=false, up to 120s
MAX_WAIT=120
ELAPSED=0
until [ "$(curl -sf http://localhost:8080/api/public/servers 2>/dev/null | jq -r '.[0].online' 2>/dev/null)" = "false" ]; do
  if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    echo "      TIMEOUT: agent still online after ${MAX_WAIT}s"
    exit 1
  fi
  sleep 5
  ELAPSED=$((ELAPSED + 5))
done
echo "      OK: agent reported offline after ~${ELAPSED}s"

# ---------------------------------------------------------------------------
# Step 11: Tear down server
# ---------------------------------------------------------------------------
echo "[11/11] Shutting down server..."
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""
echo "      OK: server stopped"
echo ""
echo "Smoke test logs: $WORKDIR"

PASS=1
echo "============================================"
echo "  PASS — Shepherd Phase 1.A smoke test OK"
echo "============================================"
