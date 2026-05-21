# Shepherd Deployment Design

**Date:** 2026-05-20
**Status:** draft — pending user review
**Scope:** Server-side compose quickstart + agent one-shot install script.

---

## Goal

Make Shepherd deployable in two commands total:

1. Server host: `docker compose up -d` (then read initial admin password from `docker compose logs`).
2. Each managed target: paste one `curl … | sudo bash` line copied from the admin UI; the script auto-installs and starts the agent under systemd (linux) or launchd (macOS).

Out of scope: Kubernetes manifests, Windows agent, HA server topology.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Server host                                             │
│  docker compose up -d                                    │
│    └─ shepherd (GHCR image)                              │
│         port :8080, sqlite by default                    │
│         first start: prints loud admin password banner   │
│         (PR #13, already merged)                         │
└─────────────────┬────────────────────────────────────────┘
                  │ admin opens UI, "+ Add server" → Script install
                  │ creates server row + issues enrollment token
                  ▼
┌──────────────────────────────────────────────────────────┐
│  UI shows copy-paste box:                                │
│  curl -fsSL                                              │
│   https://raw.githubusercontent.com/hg-claw/Shepherd/    │
│     <server-version>/scripts/install-agent.sh            │
│   | sudo bash -s -- --token T --server https://…         │
└─────────────────┬────────────────────────────────────────┘
                  │ user pastes on target VPS / Mac
                  ▼
┌──────────────────────────────────────────────────────────┐
│  install-agent.sh                                        │
│  1. require root                                         │
│  2. uname → linux|darwin × amd64|arm64                   │
│  3. curl tar.gz from GH release (with retry + sha256)    │
│  4. extract → /usr/local/bin/shepherd-agent              │
│  5. write env file /etc/shepherd-agent/env (mode 0600)   │
│  6. write service unit (systemd | launchd plist)         │
│  7. start service                                        │
│  8. poll server /api/agent/status?token=T for up to 30s  │
│     until agent_last_seen is fresh, else fail loudly     │
└──────────────────────────────────────────────────────────┘
```

---

## Part 1 — Server compose quickstart

Most of the runtime already works. Gaps are documentation and example config.

### Changes

| File | Change |
|---|---|
| `README.md` | New **Quickstart** section: clone → `cp .env.example .env` → `docker compose up -d` → `docker compose logs shepherd \| grep -A2 'initial admin'` → open `http://<host>:8080`. |
| `.env.example` | New. Lists `SHEPHERD_PORT`, `SERVER_PUBLIC_URL`, `DATABASE_DRIVER`, `INITIAL_ADMIN_USERNAME`, `INITIAL_ADMIN_PASSWORD`. Each var has a one-line comment; both `INITIAL_ADMIN_*` documented as "leave blank → first boot generates `admin` + random password (look at logs)". |
| `docker-compose.yml` | Add a `healthcheck` (`curl -fs http://localhost:8080/healthz` every 30s) so `docker compose ps` shows accurate status. No service-name or volume renames; backwards-compatible for existing installs. |

### `SERVER_PUBLIC_URL` semantics

Used by the install-command builder. Must be the externally reachable URL of the server (e.g. `https://shepherd.example.com` or `http://1.2.3.4:8080`). If unset, the API falls back to the `Host` header of the admin's current request, which is good enough for LAN demos but breaks behind reverse proxies that rewrite `Host`. Document this gotcha in `.env.example`.

---

## Part 2 — Agent one-shot install

### Script location and versioning

`scripts/install-agent.sh` lives in the repo. The UI builds the install command using the **server's own** `BuildVersion` to construct the raw URL:

```
https://raw.githubusercontent.com/hg-claw/Shepherd/v0.5.0/scripts/install-agent.sh
```

This pins script + binary + server to the same release. A v0.6.0 server's UI generates v0.6.0 URLs; old install commands keep working forever against the old release.

Edge case: server running `BuildVersion=dev` (local builds). The handler falls back to the `main` branch (`raw.githubusercontent.com/hg-claw/Shepherd/main/scripts/...`) — there is no `latest` symlink for raw URLs — and the UI shows a warning that says "dev server — install command points at `main`, expect breakage on incompatible changes".

### Script arguments

| Flag | Required | Description |
|---|---|---|
| `--token <T>` | yes (unless `--uninstall`) | Enrollment token issued by the server. |
| `--server <URL>` | yes (unless `--uninstall`) | Base URL the agent dials back to. |
| `--uninstall` | no | Reverse of install. Removes service unit and binary; preserves `/etc/shepherd-agent/` to avoid foot-guns. |
| `--version <vX.Y.Z>` | no | Override binary tag. Defaults to the version baked into the URL the user `curl`ed. |

### Install steps (detailed)

1. **Privilege check.** Fail-fast if not root (`[ "$(id -u)" -ne 0 ]`). systemd and launchd both need root to install system-level services.
2. **OS / arch detection.**
   - `uname -s` → `Linux` | `Darwin` → maps to `linux` | `darwin`.
   - `uname -m` → `x86_64` | `aarch64` | `arm64` → maps to `amd64` | `arm64`.
   - Any other combination: exit 2 with the unsupported tuple.
3. **Binary fetch.**
   - URL: `https://github.com/hg-claw/Shepherd/releases/download/<TAG>/shepherd-agent-<os>-<arch>.tar.gz` for darwin (release ships one tar per OS+arch), or `shepherd-linux-<arch>.tar.gz` (which contains both server + agent — extract only the agent).
   - Retry on network failure: 3 attempts with 2s/5s backoff.
   - Download the matching `.sha256` and verify before extracting. Mismatch → exit 4, leave nothing on disk.
4. **Install binary.** Extract agent to `/usr/local/bin/shepherd-agent`, `chmod 0755`. If the file already exists (re-install), atomically replace via temp-file rename.
5. **Write env file.** `/etc/shepherd-agent/env`, mode `0600`, owner root:
   ```
   SHEPHERD_SERVER_URL=<URL>
   SHEPHERD_ENROLLMENT_TOKEN=<T>
   ```
   On re-install with the same args, this file is rewritten. On re-install with a fresh `--token` (admin re-issued), the new token replaces the old; the agent picks it up on next start.
6. **Write service unit.**

   **Linux** — `/etc/systemd/system/shepherd-agent.service`:
   ```ini
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
   ```

   **macOS** — `/Library/LaunchDaemons/com.shepherd.agent.plist`:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
       "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key>                <string>com.shepherd.agent</string>
     <key>ProgramArguments</key>     <array><string>/usr/local/bin/shepherd-agent</string></array>
     <key>EnvironmentVariables</key> <dict>
       <key>SHEPHERD_SERVER_URL</key>        <string>__SERVER_URL__</string>
       <key>SHEPHERD_ENROLLMENT_TOKEN</key>  <string>__TOKEN__</string>
     </dict>
     <key>RunAtLoad</key>            <true/>
     <key>KeepAlive</key>            <true/>
     <key>StandardOutPath</key>      <string>/var/log/shepherd-agent.log</string>
     <key>StandardErrorPath</key>    <string>/var/log/shepherd-agent.log</string>
   </dict>
   </plist>
   ```

   The script uses bash heredocs to materialize both unit files inline — no separate template files in the repo. For the macOS plist, the script `sed`-substitutes `__SERVER_URL__` and `__TOKEN__` placeholders after writing the heredoc (launchd plists don't support `EnvironmentFile` so the values must be inlined).
7. **Start service.**
   - Linux: `systemctl daemon-reload && systemctl enable --now shepherd-agent`.
   - macOS: `launchctl bootout system/com.shepherd.agent 2>/dev/null || true; launchctl bootstrap system /Library/LaunchDaemons/com.shepherd.agent.plist`.
8. **Health check.** Poll `GET <server>/api/agent/status?token=<T>` every 2s for up to 30s. Treat `{online: true}` as success. On timeout, print:
   ```
   agent did not connect within 30s
   tail of /var/log/shepherd-agent.log:
   <last 20 lines>
   ```
   and exit 6.

### Idempotency

Re-running the script with new args is the supported upgrade path:

- Service exists → bootout/stop it.
- Binary exists → atomic replace via temp file.
- Env file exists → rewrite.
- Then enable + start as usual.

The script never asks for confirmation — the user already typed `sudo bash`.

### Uninstall

`sudo bash -s -- --uninstall`:

1. Stop and disable service (tolerate "not present").
2. Remove service unit (`/etc/systemd/system/shepherd-agent.service` or `/Library/LaunchDaemons/com.shepherd.agent.plist`).
3. Remove `/usr/local/bin/shepherd-agent`.
4. Print "Config dir /etc/shepherd-agent/ preserved. To remove: sudo rm -rf /etc/shepherd-agent/".
5. Exit 0.

### Error matrix

| Exit | Reason |
|---|---|
| 0 | Success |
| 1 | Not root |
| 2 | Unsupported OS or arch |
| 3 | Binary download failed after retries |
| 4 | sha256 mismatch |
| 5 | No `systemctl` or `launchctl` found |
| 6 | Agent did not reach server within 30s |

---

## Part 3 — Server-side support

### `GET /api/servers/:id/install-command`

Admin-authenticated. Returns:

```json
{
  "command": "curl -fsSL https://raw.githubusercontent.com/hg-claw/Shepherd/v0.5.0/scripts/install-agent.sh | sudo bash -s -- --token T_xxxxxxxx --server https://shepherd.example.com",
  "token": "T_xxxxxxxx",
  "expires_at": "2026-05-20T15:00:00Z"
}
```

Internally issues an enrollment token via the existing `agentsvc.IssueEnrollmentToken` and templates the URL using:
- `BuildVersion` of the running server → URL tag.
- `cfg.ServerPublicURL` → `--server`. Falls back to the admin's request `Host` if unset.

### `GET /api/agent/status?token=<T>`

**Public** (no admin session required — the token is the proof of intent).

- Look up the enrollment token row to resolve `server_id`. The token may be in one of three states by the time the script polls:
  - **Unconsumed + unexpired**: agent hasn't connected yet → `online=false`. Normal early-poll state.
  - **Consumed**: agent has connected at least once. Accept for up to 24h after `consumed_at` so re-runs of the script (idempotent install path) still work, then reject as stale. This is the common case during a successful install: the agent consumes the token within the first few seconds, then the script polls 1-2 more times before seeing `online=true`.
  - **Expired (TTL passed) or never existed**: 404.
- Response: `{ "online": <bool>, "last_seen_at": <RFC3339 | null> }`.
- `online` is `true` if `agent_last_seen` is non-null and within the last 60s.
- Rate limit: 30 req/min per token. Prevents abuse if a token leaks.

---

## Part 4 — File and code change estimate

| File | Type | Lines |
|---|---|---|
| `scripts/install-agent.sh` | new | ~250 |
| `README.md` Quickstart section | modify | ~60 |
| `.env.example` | new | ~25 |
| `docker-compose.yml` healthcheck | modify | ~6 |
| `internal/api/admin_servers.go` install-command handler | add | ~40 |
| `internal/api/public.go` agent-status handler | add | ~50 |
| `internal/api/router.go` route wiring | modify | ~4 |
| `internal/agentsvc/enroll.go` lookup-without-consume | modify | ~15 |
| `web/src/api/servers.ts` | modify | ~15 |
| `web/src/pages/admin/.../AddServerDialog.tsx` script tab | modify | ~100 |
| `cmd/server/main.go` add `/healthz` route | modify | ~10 |
| Tests (script + Go) | new/modify | ~150 |

**Estimated single PR ≈ 700 lines diff.**

---

## Testing strategy

### Server (Go)

- Unit test for install-command handler: server with `BuildVersion=v0.5.0`, `ServerPublicURL=https://x` → response contains the exact URL template.
- Unit test for agent-status handler: known token / unknown token / consumed-token-with-fresh-agent_last_seen / consumed-token-with-stale-last-seen / expired-token → correct responses.
- Rate limit test: 31st request in a minute → 429.

### Script (bash)

- BATS tests for the helper functions: OS/arch detection (mocked `uname`), URL builder, sha256 verify, service-manager detection. Integration test (running a real install) requires Docker/Vagrant and is out of scope for CI; manual smoke covers it.
- One install-then-uninstall smoke pass on Linux container + macOS dev machine before each release.

### Web

- Snapshot test on AddServerDialog "Script install" tab: shows the command with token, copy button works.

---

## Open questions / follow-ups (not in this PR)

- Self-update path: the agent currently restarts on config change but doesn't pull a newer binary. Could re-running the install script on a cron be the upgrade mechanism, or do we need a dedicated `agent upgrade` endpoint? Defer.
- Windows agent: explicitly out of scope for this PR.
- mTLS between server and agent: enrollment-token-then-WS auth is good enough for v1; mTLS deferred to a separate security pass.
