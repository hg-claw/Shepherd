# Shepherd

[English](README.md) · [简体中文](README.zh-CN.md)

Self-hosted server fleet management with zero-credential agents. Monitor a
fleet of Linux hosts, install agents over SSH (creds discarded after use),
and remote-operate via a single WebSocket connection per host — terminal,
scripts, files, plugins (xray / sing-box / cloudflare / netquality /
subscription generator), audit trail, and a mobile companion app.

**Status:** current release [`v0.32.0`](https://github.com/hg-claw/Shepherd/releases/latest)
— monitoring + remote ops + plugin system + the Shepherd mobile app
(Expo / React Native under `mobile/`: live fleet wall, telemetry history
charts, remote terminal, scripts with per-target logs, file management,
plugin control with live log streaming, audit viewer, biometric app lock).

## Quickstart

### Server (docker compose)

```bash
git clone https://github.com/hg-claw/Shepherd.git
cd Shepherd
cp .env.example .env
docker compose up -d
docker compose logs shepherd | grep -A2 'Generated password'
```

Open `http://<host>:8080` and log in with the user `admin` and the
password printed in the logs.

To use Postgres instead of the default sqlite, **edit `.env` first**
— `--profile pg` only adds the postgres service, it does not flip
shepherd's `DATABASE_DRIVER`. Uncomment the postgres block in
`.env.example` (set `DATABASE_DRIVER=postgres` and the matching DSN),
then:

```bash
docker compose --profile pg up -d
```

The shepherd service is set to wait for postgres to report healthy
before starting, so first-boot races are handled automatically.

Set `SERVER_PUBLIC_URL` in `.env` if your server is behind a reverse
proxy or accessed via a domain different from the docker host's IP —
the UI uses it to build the agent install command.

### Agents

Once the server is running, add a managed host:

1. In the admin UI, click **+ Add server → Script install**.
2. Fill in the name + optional metadata, click **Generate install command**.
3. Copy the displayed `curl … | sudo bash` line and run it as root on
   the target machine. The script auto-installs the agent under systemd
   (linux) or launchd (macOS) and waits for it to connect.

The script also supports `--uninstall` to reverse the install. Logs
go to `/var/log/shepherd-agent.log` on both OSes.

## Other install methods

### Single binary (Linux)

Download from [the latest release](https://github.com/hg-claw/Shepherd/releases/latest):

```bash
ARCH=amd64   # or arm64
curl -fsSLO "https://github.com/hg-claw/Shepherd/releases/latest/download/shepherd-linux-${ARCH}.tar.gz"
tar -xzf "shepherd-linux-${ARCH}.tar.gz"
sudo install -m 0755 "shepherd-server-linux-${ARCH}" /usr/local/bin/shepherd-server
sudo install -m 0755 "shepherd-agent-linux-${ARCH}" /usr/local/bin/shepherd-agent
```

Full systemd unit + env-file walkthrough in
[`deploy/README.md`](deploy/README.md).

### Build from source

```bash
make web && make server
./bin/shepherd-server
```

## Features

- Browser-based admin panel (React 19) and a public, desensitized monitoring
  wall (no IP / hostname / fingerprint exposed).
- One-shot SSH install of an agent per host. Credentials are never persisted.
- Per-host telemetry (CPU / memory / disk / network / load / TCP conns)
  every 30s by default; sampling interval is configurable per server.
- Time-series queries spanning 1h / 24h / 7d via in-database 30s → 5m → 1h
  rollups, with retention pruning per bucket size.
- SQLite by default (single-file zero-dep); switch to Postgres via env.
- Self-onboarding fleet via `AUTO_RECOVER_KEY` (agents on hosts boot,
  identify by machine fingerprint, get a machine token).
- Bilingual UI (zh-CN + en); light / dark / system theme.
- Single-binary deployment with embedded frontend; or `docker compose up`.
- Shepherd mobile app (`mobile/`, Expo / React Native): bearer-token login,
  live fleet wall, telemetry charts, remote terminal (bundled xterm — no
  CDN), scripts + per-target logs, file ops, plugin status/logs, audit
  viewer, biometric lock. Build with EAS or `npx expo run:ios|android`.

## Architecture

```
┌──────────────┐    HTTPS    ┌─────────────────────┐    HTTP    ┌──────────────────┐
│ Browser      │────────────▶│  Reverse Proxy      │───────────▶│  Shepherd Server │
│ (公共/admin) │             │  (Caddy/Nginx, TLS) │            │  :8080           │
└──────────────┘             └─────────────────────┘            └────────┬─────────┘
                                                                         │
                                                                         │ /agent/ws
                                                                         │ (WS, Bearer)
                                                                         ▼
                                                                   ┌───────────┐
                                                                   │  Agent    │
                                                                   │ (systemd) │
                                                                   └─────┬─────┘
                                                                         ▼
                                                                  gopsutil collector
```

## Remote Ops (Phase 2, since v0.2.0)

Once an agent is online, admins can:

- **Console** — open an interactive PTY in the browser via the bottom drawer. Any registered server, no SSH credentials needed; backed by the existing reverse-WS channel. PTYs are recorded as asciicast v2 and replayable from the Recordings page.
- **Scripts** — author parameterized scripts in the Scripts library, then run them on a single server or fan-out to many. Each target gets its own PTY (so interactive prompts work). Run history shows status per target with attach + replay buttons.
- **Files** — browse/upload/download/mkdir/rename/delete files on any online server. Path sandbox (default `/tmp /var/log /etc/shepherd /home /opt /srv`) is configurable in Settings; toggle off only if you accept that admins == root on the agent host.
- **Audit log** — every privileged operation (pty.open/close, script.run, file.*) writes to `audit_log` with admin/server/action/details. Default 30-day retention, configurable.

Compatibility: Phase 2 requires agent v0.2.0+. Older agents continue to serve telemetry but the admin UI shows a "needs upgrade" hint when remote ops endpoints time out.

## Deployment

See [`deploy/README.md`](deploy/README.md) for the three deployment forms
(Compose, systemd binary, source build) and the TLS reverse-proxy setup.

## Development

### Prerequisites

- Go 1.22+
- Node 20+ and npm 10+
- GNU make
- (optional) Docker for local image builds and Compose tests
- (optional) `actionlint`, `hadolint` for local lint

### First-time setup

```bash
git clone https://github.com/hg-claw/Shepherd.git
cd Shepherd
cd web && npm ci && cd ..
```

### Run the dev stack

Two terminals:

```bash
# Terminal 1 — backend (port :8080)
DATABASE_DRIVER=sqlite \
DATABASE_DSN=./data/dev.db \
SHEPHERD_INITIAL_ADMIN_USERNAME=admin \
SHEPHERD_INITIAL_ADMIN_PASSWORD=admin \
HTTP_ADDR=:8080 \
SERVER_PUBLIC_URL=http://localhost:8080 \
AUTO_RECOVER_KEY=devkey \
go run ./cmd/server

# Terminal 2 — frontend (Vite dev server, port :5173, /api+/agent proxied to :8080)
cd web && npm run dev
# open http://localhost:5173 (login: admin / admin)
```

First boot creates the SQLite DB and the initial admin. `AUTO_RECOVER_KEY` is the shared secret an agent uses to auto-register itself.

### Run an agent (Linux or macOS — for Phase 2 console / scripts / files)

The agent uses real PTYs (`creack/pty`); it runs on Linux and macOS. **Windows is not supported** (no ConPTY backend yet). Production server-driven SSH install still targets Linux only — for macOS agents, download the binary from a GitHub Release tarball and run it manually:

```bash
# (macOS) — manual install
curl -fL https://github.com/hg-claw/Shepherd/releases/download/v0.2.0/shepherd-agent-darwin-arm64.tar.gz \
  | tar -xz
sudo mv shepherd-agent-darwin-arm64 /usr/local/bin/shepherd-agent
```

For local dev (any host), run the agent directly:

```bash
sudo mkdir -p /etc/shepherd
echo "{}" | sudo tee /etc/shepherd/agent.state.json

SHEP_SERVER_URL=http://localhost:8080 \
AUTO_RECOVER_KEY=devkey \
SHEP_AGENT_STATE=/etc/shepherd/agent.state.json \
sudo -E go run ./cmd/agent
```

After a few seconds the admin dashboard shows the host online; Console / Files / Scripts buttons become live.

### Run tests

```bash
# Full local CI parity (run before pushing)
gofmt -l .                         # should print nothing
go vet ./...                       # should print nothing
golangci-lint run --timeout=5m     # should print "0 issues"
go test -race ./...                # 18 packages green
( cd web && npm test )             # vitest, all green
( cd web && npm run build )        # tsc + vite build clean

# Or via make
make test                          # go test + npm test
make vet                           # go vet
```

### End-to-end smoke

```bash
./scripts/smoke.sh           # Phase 1 backend e2e (server + agent + telemetry)
./scripts/web-smoke.sh       # Phase 1 full e2e (SPA + server + agent + telemetry)
./scripts/phase2-smoke.sh    # Phase 2 e2e (console.open + scripts run + file ops + sandbox 403 + audit) — Linux only
```

### Local Docker build

```bash
make docker-build VERSION=v0.0.0-local
docker run --rm -p 8080:8080 \
  -e INITIAL_ADMIN_USERNAME=alice \
  -e INITIAL_ADMIN_PASSWORD=hunter2 \
  shepherd:v0.0.0-local
```

### Local release dry run (Linux only)

```bash
make release VERSION=v0.0.0-local
ls -lh dist/
# expect: shepherd-server-linux-{amd64,arm64} + shepherd-agent-linux-{amd64,arm64} + tar.gz + sha256
tar -tzf dist/shepherd-linux-amd64.tar.gz
```

On macOS/Windows the arm64 server cross-compile fails without a CGO
toolchain — use the GitHub Actions release workflow instead, or use
`make docker-build` for a single-arch image.

## Roadmap

| Phase | Subsystem | Status |
|---|---|---|
| 1.A | Platform core + monitoring (Go backend + agent) | done |
| 1.B | React SPA (admin panel + public wall) | done |
| 1.C | Deploy + release CI + bilingual docs | this release |
| 2 | Remote ops (PTY / scripts / file transfer) | planned |
| 3 | Plugin runtime + plugin center | planned |
| 4 | xray plugin (3x-ui-style) | planned |
| 5 | relay plugin (gost-style traffic forwarding) | planned |
| 6 | Alerting / notifications (as plugin) | planned |

## License

[MIT](LICENSE) — see the LICENSE file.
