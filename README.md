# Shepherd

[English](README.md) · [简体中文](README.zh-CN.md)

Self-hosted server fleet management with zero-credential agents. Monitor a
fleet of Linux hosts, install agents over SSH (creds discarded after use),
and remote-operate via a single WebSocket connection per host. Phase 1
(alpha) ships monitoring + admin UI; remote ops, plugins, xray, relay, and
alerting are landing in subsequent phases.

**Status:** Phase 1 alpha — backend + frontend + e2e smoke pass; first
release `v0.1.0` available on GitHub Releases.

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

## Quick start

### Docker Compose (recommended)

```bash
git clone https://github.com/hg-claw/Shepherd.git
cd Shepherd
cp .env.example .env
$EDITOR .env   # set INITIAL_ADMIN_USERNAME / INITIAL_ADMIN_PASSWORD / AUTO_RECOVER_KEY
docker compose up -d
# open http://localhost:8080
```

Add a TLS reverse proxy in front (Caddy / Nginx). See
[`deploy/caddy/Caddyfile.example`](deploy/caddy/Caddyfile.example).

### Use Postgres

```bash
# In .env, set:
#   DATABASE_DRIVER=postgres
#   DATABASE_DSN=postgres://shepherd:shepherd@postgres:5432/shepherd?sslmode=disable
docker compose --profile pg up -d
```

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
# Terminal 1 — backend
make server-no-web   # quick, doesn't bundle the SPA
INITIAL_ADMIN_USERNAME=alice INITIAL_ADMIN_PASSWORD=hunter2 \
AUTO_RECOVER_KEY=secret \
DATABASE_DSN="file:./dev.db?_fk=1" \
SERVER_PUBLIC_URL=http://localhost:8080 \
./bin/shepherd-server

# Terminal 2 — frontend (Vite dev server with /api proxy)
cd web && npm run dev
# open http://localhost:5173
```

### Run tests

```bash
make test                # go test + npm test
make vet                 # go vet
gofmt -l .               # list any unformatted Go files
cd web && npx tsc --noEmit
cd web && npx vitest run
```

### End-to-end smoke

```bash
./scripts/smoke.sh       # backend e2e (server + agent + telemetry)
./scripts/web-smoke.sh   # full e2e: build frontend + server + agent + verify SPA + telemetry
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
