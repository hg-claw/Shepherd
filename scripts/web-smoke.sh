#!/usr/bin/env bash
# scripts/web-smoke.sh — Phase 1.B end-to-end check
# Builds the frontend + binaries, starts the server, registers an agent,
# and verifies the SPA routes + REST endpoints work.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

WORKDIR=$(mktemp -d)
DBFILE="$WORKDIR/shepherd.db"
COOKIES="$WORKDIR/cookies.txt"
SERVER_PID=
AGENT_PID=

cleanup() {
  if [[ -n "${AGENT_PID:-}" ]]; then kill "$AGENT_PID" 2>/dev/null || true; wait "$AGENT_PID" 2>/dev/null || true; fi
  if [[ -n "${SERVER_PID:-}" ]]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  if [[ "${SMOKE_PASSED:-0}" != "1" ]]; then
    echo "--- server.log ---"; tail -50 "$WORKDIR/server.log" 2>/dev/null || true
    echo "--- agent.log ---"; tail -50 "$WORKDIR/agent.log" 2>/dev/null || true
    echo "FAIL — workdir=$WORKDIR"
  fi
}
trap cleanup EXIT

echo "[1/8] build frontend"
make web

echo "[2/8] build server + agent"
make server
make agent

echo "[3/8] start server"
INITIAL_ADMIN_USERNAME=alice \
INITIAL_ADMIN_PASSWORD=hunter2 \
AUTO_RECOVER_KEY=secret \
DATABASE_DSN="file:$DBFILE?_fk=1" \
SERVER_PUBLIC_URL=http://localhost:8080 \
./bin/shepherd-server > "$WORKDIR/server.log" 2>&1 &
SERVER_PID=$!
sleep 2

echo "[4/8] http GET / returns HTML"
curl -sf http://localhost:8080/ -o "$WORKDIR/index.html"
grep -q '<div id="root"></div>' "$WORKDIR/index.html"

echo "[5/8] /admin/anything returns SPA fallback (HTML, status 200)"
curl -sf -o "$WORKDIR/admin.html" -w '%{http_code}\n' http://localhost:8080/admin/dashboard | grep -q '^200$'

echo "[6/8] login + me round trip"
curl -sf -c "$COOKIES" -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"hunter2"}' \
  http://localhost:8080/api/login > /dev/null
curl -sf -b "$COOKIES" http://localhost:8080/api/admins/me | jq -e '.username == "alice"' > /dev/null

echo "[7/8] register agent + telemetry"
SERVER_URL=http://localhost:8080 \
AUTO_RECOVER_KEY=secret \
STATE_PATH="$WORKDIR/agent.state.json" \
./bin/shepherd-agent > "$WORKDIR/agent.log" 2>&1 &
AGENT_PID=$!
sleep 65 # net delta primer + first telemetry
curl -sf -b "$COOKIES" "http://localhost:8080/api/servers?with=latest" | jq -e '.[0].latest != null' > /dev/null

echo "[8/8] tear down"
SMOKE_PASSED=1
echo "PASS"
