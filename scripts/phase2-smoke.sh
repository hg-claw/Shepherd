#!/usr/bin/env bash
# Shepherd Phase 2 end-to-end smoke test.
# Linux-only (the agent uses a real PTY via creack/pty; macOS hosts can't run the agent).
# Exercises: console.open, scripts CRUD + fan-out run, file ops (mkdir/upload/list/download/rm),
# sandbox 403, and audit log presence.
#
# Prerequisites: jq, curl, sudo (for /etc/shepherd state path).
# Run from repo root.

set -euo pipefail

DATA=$(mktemp -d)
PORT=${PORT:-18080}
trap 'pkill -f "$DATA/shepherd-server" 2>/dev/null || true; pkill -f "$DATA/shepherd-agent" 2>/dev/null || true; rm -rf "$DATA"' EXIT

echo "▶ building binaries"
go build -o "$DATA/shepherd-server" ./cmd/server
go build -o "$DATA/shepherd-agent" ./cmd/agent

echo "▶ starting server on :$PORT"
DATABASE_DRIVER=sqlite DATABASE_DSN="$DATA/shep.db" \
  SHEPHERD_INITIAL_ADMIN_USERNAME=a SHEPHERD_INITIAL_ADMIN_PASSWORD=p \
  HTTP_ADDR=":$PORT" SERVER_PUBLIC_URL="http://localhost:$PORT" \
  AUTO_RECOVER_KEY=devkey "$DATA/shepherd-server" >"$DATA/server.log" 2>&1 &
sleep 1

COOKIE="$DATA/cookie"
echo "▶ login"
curl -sf -c "$COOKIE" -X POST -H 'content-type: application/json' \
  -d '{"username":"a","password":"p"}' "http://localhost:$PORT/api/login" >/dev/null

echo "▶ starting agent"
sudo mkdir -p /etc/shepherd
echo "{}" | sudo tee /etc/shepherd/agent.state.json >/dev/null
SHEP_SERVER_URL="http://localhost:$PORT" AUTO_RECOVER_KEY=devkey \
  SHEP_AGENT_STATE=/etc/shepherd/agent.state.json sudo -E "$DATA/shepherd-agent" >"$DATA/agent.log" 2>&1 &
sleep 3

echo "▶ assert agent online"
curl -sf -b "$COOKIE" "http://localhost:$PORT/api/servers" | jq '.[0]' | grep -q '"agent_last_seen"'

echo "▶ open console session"
OPEN=$(curl -sf -b "$COOKIE" -X POST -H 'content-type: application/json' \
  -d '{"server_id":1,"rows":24,"cols":80,"term":"xterm-256color"}' \
  "http://localhost:$PORT/api/admin/console/open")
echo "  → $(echo "$OPEN" | jq -c)"

echo "▶ create + run script"
SID=$(curl -sf -b "$COOKIE" -X POST -H 'content-type: application/json' \
  -d '{"name":"echotest","description":"smoke","content":"echo {{.X}}","params":[{"name":"X","required":true}]}' \
  "http://localhost:$PORT/api/admin/scripts" | jq -r .id)
RID=$(curl -sf -b "$COOKIE" -X POST -H 'content-type: application/json' \
  -d "{\"args\":{\"X\":\"shep-test\"},\"target_server_ids\":[1]}" \
  "http://localhost:$PORT/api/admin/scripts/$SID/run" | jq -r .run_id)
echo "  → script_id=$SID run_id=$RID"

echo "▶ wait for run convergence"
for _ in $(seq 1 10); do
  TARGETS=$(curl -sf -b "$COOKIE" "http://localhost:$PORT/api/admin/script-runs/$RID")
  if echo "$TARGETS" | jq -e '.[0].status == "succeeded"' >/dev/null; then
    break
  fi
  sleep 1
done
echo "$TARGETS" | jq

echo "▶ file ops"
curl -sf -b "$COOKIE" -X POST -H 'content-type: application/json' \
  -d '{"server_id":1,"path":"/tmp/shep-smoke","mode":493}' \
  "http://localhost:$PORT/api/admin/files/mkdir" >/dev/null
echo -n "hello" | curl -sf -b "$COOKIE" -X POST --data-binary @- \
  "http://localhost:$PORT/api/admin/files/upload?server_id=1&path=/tmp/shep-smoke/x.txt&mode=420" >/dev/null
LIST=$(curl -sf -b "$COOKIE" "http://localhost:$PORT/api/admin/files?server_id=1&path=/tmp/shep-smoke")
echo "$LIST" | jq
echo "$LIST" | jq -e '.[] | select(.name == "x.txt")' >/dev/null
GOT=$(curl -sf -b "$COOKIE" "http://localhost:$PORT/api/admin/files/download?server_id=1&path=/tmp/shep-smoke/x.txt")
test "$GOT" = "hello"
curl -sf -b "$COOKIE" -X POST -H 'content-type: application/json' \
  -d '{"server_id":1,"path":"/tmp/shep-smoke","recursive":true}' \
  "http://localhost:$PORT/api/admin/files/rm" >/dev/null

echo "▶ sandbox reject (/etc/shadow)"
STATUS=$(curl -s -b "$COOKIE" -o /dev/null -w "%{http_code}" \
  "http://localhost:$PORT/api/admin/files?server_id=1&path=/etc/shadow")
test "$STATUS" = "403" || { echo "expected 403, got $STATUS" >&2; exit 1; }

echo "▶ audit log non-empty"
N=$(curl -sf -b "$COOKIE" "http://localhost:$PORT/api/admin/audit" | jq 'length')
test "$N" -gt 0 || { echo "audit log empty" >&2; exit 1; }
echo "  → $N entries"

echo
echo "PHASE 2 SMOKE OK ($N audit rows)"
