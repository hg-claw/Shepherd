# Shepherd Phase 1.C — Deploy + Release CI + Bilingual README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the deployment + release pipeline + docs for Shepherd v0.1.0 — multi-stage Dockerfile, multi-arch ghcr image, dual-arch tarball release CI, Compose with optional Postgres profile, bilingual README with a Development section, MIT license. End state: `git tag v0.1.0 && git push origin v0.1.0` produces a complete GitHub release with attached tarballs and a multi-arch image at `ghcr.io/hg-claw/shepherd:v0.1.0`.

**Out of scope:** Helm charts, Kubernetes manifests, image signing (cosign), SBOM generation, nightly builds, additional locales beyond zh-CN/en. All deferred to v2.

**Architecture:** Three production deployment forms — single binary on systemd, Docker Compose (default SQLite, opt-in Postgres profile), tarball download from GitHub releases. The Dockerfile builds in three stages: web (node 20-alpine), go (golang 1.22-alpine, runs natively for the target arch under buildx + QEMU), runtime (alpine 3.19). `make release` produces release artifacts locally on Linux; CI release.yml is the production source-of-truth.

**Tech Stack:** Docker (alpine), docker buildx + QEMU (multi-arch), GitHub Actions (`docker/build-push-action`, `actions/upload-artifact`, `softprops/action-gh-release`), `golangci-lint`, `actionlint` (optional local lint), `hadolint` (optional local lint), Caddy (TLS reference, not bundled).

**Spec:** `docs/superpowers/specs/2026-05-06-shepherd-phase-1c-deploy-design.md`

**Branch:** already on `phase-1c` (branched off `phase-1b`). Last commit at start: `55ace50 docs(spec 1.C): include MIT LICENSE in scope`. The plan assumes you stay on `phase-1c` for all 12 tasks.

**Local tools:** the macOS dev box doesn't have `docker`, `hadolint`, or `actionlint` installed by default. Tasks that need them either install via `brew install` (recommended) or fall back to skip-with-note. The CI workflow files are validated on GitHub when pushed; local lint is best-effort.

---

## File Map

```
LICENSE                                          # NEW (Task 1)
.dockerignore                                    # NEW (Task 2)
.env.example                                     # NEW (Task 3)
Dockerfile                                       # NEW (Task 4)
docker-compose.yml                               # NEW (Task 5)
deploy/
  README.md                                      # NEW (Task 6)
  caddy/Caddyfile.example                        # NEW (Task 6)
  systemd/shepherd-server.service                # NEW (Task 6)
  systemd/shepherd-agent.service                 # NEW (Task 6)
Makefile                                         # MODIFY (Task 7) — add agents/release/docker-build targets
.github/workflows/ci.yml                         # NEW (Task 8)
.github/workflows/release.yml                    # NEW (Task 9)
README.md                                        # NEW (Task 10) — English
README.zh-CN.md                                  # NEW (Task 11) — Chinese
```

> No application source code changes. Phase 1.C is config + docs only, except for the Makefile additions.

---

## Conventions

- One commit per task unless noted.
- All file paths are absolute from the repo root `/Users/hg/project/Shepherd`.
- The implementer should not push to `origin` during the task — the user will push when finishing the branch.
- For tasks involving Markdown / YAML editing, prefer Write/Edit tools to preserve exact whitespace.
- Commit messages follow the existing convention: `chore:` for tooling, `feat:` for features, `docs:` for documentation, `build:` for build/CI changes.

---

## Milestone 1 — Foundation files

### Task 1: MIT LICENSE

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: Verify branch state**

```
cd /Users/hg/project/Shepherd
git branch --show-current   # expect: phase-1c
git log --oneline -1        # expect: 55ace50 docs(spec 1.C): include MIT LICENSE in scope
```

- [ ] **Step 2: Write `LICENSE`** (standard MIT, copyright `2026 hg-claw`)

```
MIT License

Copyright (c) 2026 hg-claw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 3: Commit**

```
git add LICENSE
git commit -m "chore: add MIT LICENSE"
```

---

### Task 2: `.dockerignore`

**Files:**
- Create: `.dockerignore`

- [ ] **Step 1: Write `.dockerignore`**

```
.git
.github
docs
scripts
bin
dist
**/node_modules
internal/web/dist/*
!internal/web/dist/.gitkeep
shepherd.db*
*.log
.DS_Store
.env
.env.local
```

> Force-include `.gitkeep` so the `go:embed` pattern still matches; the web-builder stage will overwrite the directory with the real dist.

- [ ] **Step 2: Commit**

```
git add .dockerignore
git commit -m "chore: add .dockerignore"
```

---

### Task 3: `.env.example`

**Files:**
- Create: `.env.example`

- [ ] **Step 1: Write `.env.example`**

```env
# Required for first run if you want a default admin auto-created.
INITIAL_ADMIN_USERNAME=alice
INITIAL_ADMIN_PASSWORD=change-me

# Required if you want fleet self-onboarding via AUTO_RECOVER_KEY.
AUTO_RECOVER_KEY=

# URL the agent will dial back to (set this when behind a reverse proxy).
SERVER_PUBLIC_URL=http://localhost:8080

# Optional: pin a specific image tag (default: latest).
# SHEPHERD_TAG=v0.1.0

# Optional: change the host port mapping (8080 default).
# SHEPHERD_PORT=8080

# --- Postgres profile (only used with `docker compose --profile pg up`) ---
# DATABASE_DRIVER=postgres
# DATABASE_DSN=postgres://shepherd:shepherd@postgres:5432/shepherd?sslmode=disable
# PG_PASSWORD=change-me

# --- Agent distribution channel ---
# Default: embedded (server image carries agent binaries internally).
# Switch to `github` after first release if you prefer agents to be fetched
# from the GitHub Releases page during install.
# AGENT_DISTRIBUTION=github
# AGENT_DOWNLOAD_TAG=v0.1.0
```

- [ ] **Step 2: Commit**

```
git add .env.example
git commit -m "chore: add .env.example for compose deployments"
```

---

## Milestone 2 — Docker

### Task 4: `Dockerfile` (multi-stage)

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7

# ── Stage 1: web build (node) ─────────────────────────────────────
# Pinned to BUILDPLATFORM so npm runs natively even when targeting a
# non-host arch — the JS bundle is platform-independent.
FROM --platform=$BUILDPLATFORM node:20-alpine AS web-builder
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# Vite's `outDir: '../internal/web/dist'` writes to /src/internal/web/dist.
RUN npm run build

# ── Stage 2: go build ─────────────────────────────────────────────
# NO --platform pin: under buildx this stage runs natively for the target
# arch (via QEMU when host != target). That lets CGO=1 work for the SQLite
# driver without setting up a cross-compiler.
FROM golang:1.22-alpine AS go-builder
RUN apk add --no-cache build-base sqlite-dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web-builder /src/internal/web/dist ./internal/web/dist
ARG VERSION=dev
# Cross-compile both agent arches into the embed dir so any-arch server
# image can install agents on either-arch hosts. Agents are pure Go (CGO=0)
# and cross-compile cleanly without a C toolchain.
RUN GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build \
      -ldflags "-X github.com/hg-claw/Shepherd/internal/agentconfig.BuildVersion=${VERSION}" \
      -o internal/installer/bin/shepherd-agent-linux-amd64 ./cmd/agent && \
    GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build \
      -ldflags "-X github.com/hg-claw/Shepherd/internal/agentconfig.BuildVersion=${VERSION}" \
      -o internal/installer/bin/shepherd-agent-linux-arm64 ./cmd/agent
# Server: native build for the (QEMU-emulated) target arch. CGO=1 for sqlite.
RUN CGO_ENABLED=1 go build \
      -ldflags "-X github.com/hg-claw/Shepherd/internal/config.BuildVersion=${VERSION}" \
      -o /out/shepherd-server ./cmd/server

# ── Stage 3: runtime ──────────────────────────────────────────────
FROM alpine:3.19 AS runtime
RUN apk add --no-cache ca-certificates sqlite-libs && \
    addgroup -S shep && adduser -S -G shep shep && \
    mkdir -p /data && chown shep:shep /data
COPY --from=go-builder /out/shepherd-server /usr/local/bin/shepherd-server
EXPOSE 8080
USER shep
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/shepherd-server"]
```

- [ ] **Step 2: Optional — local lint with hadolint**

If you have `hadolint` installed (`brew install hadolint`):

```
hadolint Dockerfile
```
Expected: no errors. (Some warnings about pinning versions are acceptable; we trust the package manifests.)

If `hadolint` is not installed, skip this step. CI will catch issues if any.

- [ ] **Step 3: Commit**

```
git add Dockerfile
git commit -m "feat(deploy): multi-stage Dockerfile (alpine + cgo sqlite, dual-arch agent embed)"
```

---

### Task 5: `docker-compose.yml`

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
services:
  shepherd:
    image: ghcr.io/hg-claw/shepherd:${SHEPHERD_TAG:-latest}
    restart: unless-stopped
    volumes:
      - shepherd_data:/data
    environment:
      SERVER_HTTP_ADDR: ":8080"
      DATABASE_DRIVER: ${DATABASE_DRIVER:-sqlite}
      DATABASE_DSN: ${DATABASE_DSN:-file:/data/shepherd.db?_fk=1}
      INITIAL_ADMIN_USERNAME: ${INITIAL_ADMIN_USERNAME:-}
      INITIAL_ADMIN_PASSWORD: ${INITIAL_ADMIN_PASSWORD:-}
      AUTO_RECOVER_KEY: ${AUTO_RECOVER_KEY:-}
      SERVER_PUBLIC_URL: ${SERVER_PUBLIC_URL:-}
      AGENT_DISTRIBUTION: ${AGENT_DISTRIBUTION:-embedded}
    ports:
      - "${SHEPHERD_PORT:-8080}:8080"

  postgres:
    image: postgres:16-alpine
    profiles: [pg]
    restart: unless-stopped
    environment:
      POSTGRES_DB: shepherd
      POSTGRES_USER: shepherd
      POSTGRES_PASSWORD: ${PG_PASSWORD:-shepherd}
    volumes:
      - shepherd_pg_data:/var/lib/postgresql/data

volumes:
  shepherd_data:
  shepherd_pg_data:
```

- [ ] **Step 2: Validate compose syntax (optional, requires Docker)**

If `docker` is installed and running:

```
docker compose config > /dev/null
echo $?  # expect: 0
```

If not, skip — `actionlint` / CI will catch issues.

- [ ] **Step 3: Commit**

```
git add docker-compose.yml
git commit -m "feat(deploy): docker-compose.yml (default sqlite, optional pg profile)"
```

---

### Task 6: `deploy/` directory (Caddy + systemd + README)

**Files:**
- Create: `deploy/README.md`
- Create: `deploy/caddy/Caddyfile.example`
- Create: `deploy/systemd/shepherd-server.service`
- Create: `deploy/systemd/shepherd-agent.service`

- [ ] **Step 1: Create directory layout**

```
mkdir -p /Users/hg/project/Shepherd/deploy/caddy
mkdir -p /Users/hg/project/Shepherd/deploy/systemd
```

- [ ] **Step 2: Write `deploy/caddy/Caddyfile.example`**

```caddyfile
# Caddyfile.example — TLS-terminating reverse proxy for Shepherd.
# Drop into your existing Caddy config or run as a standalone Caddy alongside
# the Shepherd container/binary. Caddy auto-provisions a Let's Encrypt cert
# when the domain resolves to this host and ports 80/443 are reachable.

shep.example.com {
    # Forward to the Shepherd HTTP port (default 8080). If running Shepherd
    # via docker-compose on the same host, use the service name + port.
    reverse_proxy localhost:8080
    # If Caddy and Shepherd share a docker network:
    # reverse_proxy shepherd:8080

    # Optional: stricter security headers.
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
    }

    # Optional: log to a file.
    # log {
    #     output file /var/log/caddy/shepherd.log
    #     format json
    # }
}

# Local-dev example with an internal CA-signed cert (no public DNS required).
# Run: caddy run --config Caddyfile.example
# shep.localhost {
#     tls internal
#     reverse_proxy localhost:8080
# }
```

- [ ] **Step 3: Write `deploy/systemd/shepherd-server.service`**

```
[Unit]
Description=Shepherd server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=shepherd
Group=shepherd
EnvironmentFile=/etc/shepherd/server.env
ExecStart=/usr/local/bin/shepherd-server
Restart=always
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/shepherd

[Install]
WantedBy=multi-user.target
```

> The agent service file is what `internal/installer` writes onto remote hosts at install time. The copy here is for archival / reference only; do not symlink the runtime path to this file.

- [ ] **Step 4: Write `deploy/systemd/shepherd-agent.service`**

```
[Unit]
Description=Shepherd agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/shepherd/agent.env
ExecStart=/usr/local/bin/shepherd-agent
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 5: Write `deploy/README.md`** (bilingual mini-doc; main README is in repo root)

````markdown
# Shepherd Deployment Guide

Three production forms. Pick one. The default `docker-compose.yml` is the
fastest path; the single-binary path is the leanest.

## Form 1 — Docker Compose (recommended)

```bash
git clone https://github.com/hg-claw/Shepherd.git
cd Shepherd
cp .env.example .env
$EDITOR .env   # set INITIAL_ADMIN_USERNAME / INITIAL_ADMIN_PASSWORD / AUTO_RECOVER_KEY
docker compose up -d
# open http://localhost:8080
```

Use Postgres instead of SQLite:

```bash
# In .env, uncomment and set:
#   DATABASE_DRIVER=postgres
#   DATABASE_DSN=postgres://shepherd:shepherd@postgres:5432/shepherd?sslmode=disable
docker compose --profile pg up -d
```

## Form 2 — Single binary on systemd (Linux)

```bash
# Download the latest tarball from https://github.com/hg-claw/Shepherd/releases
ARCH=amd64   # or arm64
curl -fsSLO "https://github.com/hg-claw/Shepherd/releases/latest/download/shepherd-linux-${ARCH}.tar.gz"
tar -xzf "shepherd-linux-${ARCH}.tar.gz"
sudo install -m 0755 "shepherd-server-linux-${ARCH}" /usr/local/bin/shepherd-server
sudo install -m 0755 "shepherd-agent-linux-${ARCH}" /usr/local/bin/shepherd-agent

# Create user + data dir
sudo useradd --system --home /var/lib/shepherd --shell /usr/sbin/nologin shepherd
sudo mkdir -p /var/lib/shepherd /etc/shepherd
sudo chown shepherd:shepherd /var/lib/shepherd

# Write /etc/shepherd/server.env (env vars from .env.example)
sudo install -m 0600 -o shepherd -g shepherd /dev/null /etc/shepherd/server.env
sudo $EDITOR /etc/shepherd/server.env

# Install systemd unit
sudo install -m 0644 deploy/systemd/shepherd-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now shepherd-server
```

Add a TLS reverse proxy in front (Caddy / Nginx). See `deploy/caddy/Caddyfile.example`.

## Form 3 — Build from source

```bash
make web && make server
./bin/shepherd-server
```

## TLS

Compose intentionally does NOT bundle a TLS reverse proxy — production setups
vary too much (Caddy / Nginx / Cloudflare Tunnel / a load balancer). Use
`deploy/caddy/Caddyfile.example` as a starting point if you don't already have
a reverse proxy.

## Postgres details

The `pg` profile starts a Postgres 16 container. Switch by:
1. Set `DATABASE_DRIVER=postgres` and `DATABASE_DSN=...` in `.env`.
2. Run `docker compose --profile pg up -d`.

When migrating from SQLite to Postgres, dump and restore manually — Shepherd
does not auto-migrate between drivers.

---

# Shepherd 部署指南

三种生产形态，按需挑一个。默认 `docker-compose.yml` 最快，单二进制最轻。

## 形态 1 — Docker Compose（推荐）

```bash
git clone https://github.com/hg-claw/Shepherd.git
cd Shepherd
cp .env.example .env
$EDITOR .env   # 设置 INITIAL_ADMIN_USERNAME / INITIAL_ADMIN_PASSWORD / AUTO_RECOVER_KEY
docker compose up -d
# 浏览器打开 http://localhost:8080
```

切到 Postgres：

```bash
# .env 里取消注释并设置：
#   DATABASE_DRIVER=postgres
#   DATABASE_DSN=postgres://shepherd:shepherd@postgres:5432/shepherd?sslmode=disable
docker compose --profile pg up -d
```

## 形态 2 — 单二进制 + systemd（Linux）

```bash
# 从 https://github.com/hg-claw/Shepherd/releases 下载最新 tarball
ARCH=amd64   # 或 arm64
curl -fsSLO "https://github.com/hg-claw/Shepherd/releases/latest/download/shepherd-linux-${ARCH}.tar.gz"
tar -xzf "shepherd-linux-${ARCH}.tar.gz"
sudo install -m 0755 "shepherd-server-linux-${ARCH}" /usr/local/bin/shepherd-server
sudo install -m 0755 "shepherd-agent-linux-${ARCH}" /usr/local/bin/shepherd-agent

# 创建用户和数据目录
sudo useradd --system --home /var/lib/shepherd --shell /usr/sbin/nologin shepherd
sudo mkdir -p /var/lib/shepherd /etc/shepherd
sudo chown shepherd:shepherd /var/lib/shepherd

# 写 /etc/shepherd/server.env（参考 .env.example）
sudo install -m 0600 -o shepherd -g shepherd /dev/null /etc/shepherd/server.env
sudo $EDITOR /etc/shepherd/server.env

# 安装 systemd unit
sudo install -m 0644 deploy/systemd/shepherd-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now shepherd-server
```

前面叠 TLS 反代（Caddy / Nginx）。参考 `deploy/caddy/Caddyfile.example`。

## 形态 3 — 从源码构建

```bash
make web && make server
./bin/shepherd-server
```

## TLS

Compose 默认不内置 TLS 反代——生产设置差异太大（Caddy / Nginx / Cloudflare Tunnel / 负载均衡器）。若你还没反代，
`deploy/caddy/Caddyfile.example` 是个起点。

## Postgres 细节

`pg` profile 起一个 Postgres 16 容器。切换方法：
1. `.env` 设置 `DATABASE_DRIVER=postgres` 和 `DATABASE_DSN=...`
2. `docker compose --profile pg up -d`

SQLite 迁 Postgres 需要手工 dump + restore，Shepherd 不自动跨驱动迁移。
````

- [ ] **Step 6: Commit**

```
git add deploy
git commit -m "docs(deploy): bilingual deployment guide + Caddyfile + systemd units"
```

---

## Milestone 3 — Makefile + local release

### Task 7: Makefile additions

**Files:**
- Modify: `Makefile`

- [ ] **Step 1: Read the existing Makefile**

```
cat /Users/hg/project/Shepherd/Makefile
```
You'll see the Phase 1.B Makefile with `web`, `server`, `agent`, `test*`, `fmt`, `vet`, `tidy` targets.

- [ ] **Step 2: Replace the Makefile with the extended version**

```make
.PHONY: web web-clean server server-no-web agent agents agent-amd64 agent-arm64 \
        release docker-build test test-go test-web fmt vet tidy

VERSION ?= dev

web:
	cd web && npm install && npm run build

web-clean:
	rm -rf internal/web/dist
	mkdir -p internal/web/dist
	touch internal/web/dist/.gitkeep

# Build agent for both Linux arches into the embed directory the server uses.
agents: agent-amd64 agent-arm64

agent-amd64:
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build \
	  -ldflags "-X github.com/hg-claw/Shepherd/internal/agentconfig.BuildVersion=$(VERSION)" \
	  -o internal/installer/bin/shepherd-agent-linux-amd64 ./cmd/agent

agent-arm64:
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build \
	  -ldflags "-X github.com/hg-claw/Shepherd/internal/agentconfig.BuildVersion=$(VERSION)" \
	  -o internal/installer/bin/shepherd-agent-linux-arm64 ./cmd/agent

# `server` builds the host-arch server binary; depends on web (for embed)
# and agents (so installer.bin/* contains real binaries, not just the
# .gitkeep placeholder).
server: web agents
	go build \
	  -ldflags "-X github.com/hg-claw/Shepherd/internal/config.BuildVersion=$(VERSION)" \
	  -o bin/shepherd-server ./cmd/server

# Skip web + agents — for environments without npm or for quick Go iteration.
server-no-web:
	go build -o bin/shepherd-server ./cmd/server

agent:
	go build -o bin/shepherd-agent ./cmd/agent

# Local release: cross-compile server + agent for both Linux arches, package
# tar.gz + sha256. Requires Linux host (CGO cross-compile from macOS to Linux
# is not set up; CI does it via QEMU). Use as: make release VERSION=v0.1.0
release: web agents
	@if [ -z "$(VERSION)" ] || [ "$(VERSION)" = "dev" ]; then \
	  echo "VERSION required (e.g. make release VERSION=v0.1.0)"; exit 1; fi
	@if [ "$$(uname -s)" != "Linux" ]; then \
	  echo "WARNING: make release works fully only on Linux hosts."; \
	  echo "On macOS/Windows the arm64 server build will fail without a"; \
	  echo "cross-compiler. Use the GitHub Actions release workflow instead."; \
	fi
	rm -rf dist && mkdir -p dist
	@for arch in amd64 arm64; do \
	  echo ">> server linux/$$arch"; \
	  GOOS=linux GOARCH=$$arch CGO_ENABLED=1 \
	    go build \
	    -ldflags "-X github.com/hg-claw/Shepherd/internal/config.BuildVersion=$(VERSION)" \
	    -o dist/shepherd-server-linux-$$arch \
	    ./cmd/server || exit 1; \
	  cp internal/installer/bin/shepherd-agent-linux-$$arch dist/shepherd-agent-linux-$$arch; \
	  tar -czf dist/shepherd-linux-$$arch.tar.gz -C dist shepherd-server-linux-$$arch shepherd-agent-linux-$$arch; \
	  (cd dist && sha256sum shepherd-linux-$$arch.tar.gz > shepherd-linux-$$arch.tar.gz.sha256); \
	done
	@echo "Release artifacts:"
	@ls -lh dist/

# Local single-arch Docker image build. Uses the host's docker; no buildx required.
# Use as: make docker-build VERSION=v0.1.0
docker-build:
	docker build -t shepherd:$(VERSION) --build-arg VERSION=$(VERSION) .

test: test-go test-web

test-go:
	go test ./...

test-web:
	cd web && npm test

fmt:
	gofmt -w .

vet:
	go vet ./...

tidy:
	go mod tidy
```

> CRITICAL: recipe lines (everything indented under a target) must use TAB characters, NOT spaces. Verify with `cat -A Makefile | head -20` — tab characters render as `^I`. If your editor stripped them, manually re-indent with the tab key.

- [ ] **Step 3: Verify Makefile parses + existing targets still work**

```
cd /Users/hg/project/Shepherd
make vet
make test-go
```

Both should pass (no behaviour change for existing targets; `agents` are new but unused by `server-no-web`).

- [ ] **Step 4: Verify the new `agents` target compiles**

```
cd /Users/hg/project/Shepherd
make agents VERSION=v0.0.0-test
ls -lh internal/installer/bin/
```
Expected: `shepherd-agent-linux-amd64` and `shepherd-agent-linux-arm64` present (both Linux ELF binaries).

- [ ] **Step 5: Commit**

```
git add Makefile
git commit -m "build: add agents/release/docker-build targets to Makefile"
```

---

## Milestone 4 — GitHub Actions

### Task 8: `.github/workflows/ci.yml`

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflows directory**

```
mkdir -p /Users/hg/project/Shepherd/.github/workflows
```

- [ ] **Step 2: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  go:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - name: golangci-lint
        uses: golangci/golangci-lint-action@v6
        with:
          version: v1.59
      - name: go vet
        run: go vet ./...
      - name: go test -race
        run: go test -race ./...

  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: 'web/package-lock.json'
      - name: Install web deps
        run: cd web && npm ci
      - name: Vitest
        run: cd web && npm test
      - name: Build (typescript + vite)
        run: cd web && npm run build
```

- [ ] **Step 3: Optional — local lint with `actionlint`**

If installed (`brew install actionlint`):

```
actionlint .github/workflows/ci.yml
```
Expected: no errors.

- [ ] **Step 4: Commit**

```
git add .github/workflows/ci.yml
git commit -m "ci: add CI workflow (go lint+test, web test+build)"
```

---

### Task 9: `.github/workflows/release.yml`

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags:
      - 'v*.*.*'
  workflow_dispatch:
    inputs:
      tag:
        description: 'Version tag (e.g. v0.1.0)'
        required: true

permissions:
  contents: write     # for GitHub release creation
  packages: write     # for ghcr.io image push

jobs:
  binaries:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        arch: [amd64, arm64]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
          cache-dependency-path: 'web/package-lock.json'
      - name: Install + build web (for server embed)
        run: cd web && npm ci && npm run build
      - name: Resolve version
        run: echo "VERSION=${{ github.event.inputs.tag || github.ref_name }}" >> $GITHUB_ENV
      - name: Cross-compile agent (both arches embedded in server)
        run: |
          GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build \
            -ldflags "-X github.com/hg-claw/Shepherd/internal/agentconfig.BuildVersion=${VERSION}" \
            -o internal/installer/bin/shepherd-agent-linux-amd64 ./cmd/agent
          GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build \
            -ldflags "-X github.com/hg-claw/Shepherd/internal/agentconfig.BuildVersion=${VERSION}" \
            -o internal/installer/bin/shepherd-agent-linux-arm64 ./cmd/agent
      - name: Cross-compile server for ${{ matrix.arch }}
        run: |
          if [ "${{ matrix.arch }}" = "arm64" ]; then
            sudo apt-get update
            sudo apt-get install -y gcc-aarch64-linux-gnu
            export CC=aarch64-linux-gnu-gcc
          fi
          mkdir -p dist
          GOOS=linux GOARCH=${{ matrix.arch }} CGO_ENABLED=1 \
            go build \
            -ldflags "-X github.com/hg-claw/Shepherd/internal/config.BuildVersion=${VERSION}" \
            -o dist/shepherd-server-linux-${{ matrix.arch }} \
            ./cmd/server
      - name: Package + checksum
        run: |
          cp internal/installer/bin/shepherd-agent-linux-${{ matrix.arch }} dist/
          tar -czf dist/shepherd-linux-${{ matrix.arch }}.tar.gz \
            -C dist shepherd-server-linux-${{ matrix.arch }} shepherd-agent-linux-${{ matrix.arch }}
          (cd dist && sha256sum shepherd-linux-${{ matrix.arch }}.tar.gz \
            > shepherd-linux-${{ matrix.arch }}.tar.gz.sha256)
      - uses: actions/upload-artifact@v4
        with:
          name: bins-${{ matrix.arch }}
          path: |
            dist/shepherd-linux-${{ matrix.arch }}.tar.gz
            dist/shepherd-linux-${{ matrix.arch }}.tar.gz.sha256

  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Resolve version
        run: echo "VERSION=${{ github.event.inputs.tag || github.ref_name }}" >> $GITHUB_ENV
      - name: Build + push multi-arch image
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: |
            ghcr.io/hg-claw/shepherd:${{ env.VERSION }}
            ghcr.io/hg-claw/shepherd:latest
          build-args: |
            VERSION=${{ env.VERSION }}

  release:
    needs: [binaries, image]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: dist
          pattern: bins-*
      - name: Flatten artifact tree
        run: |
          mkdir -p out
          mv dist/bins-*/* out/
          ls -la out/
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ github.event.inputs.tag || github.ref_name }}
          generate_release_notes: true
          files: |
            out/shepherd-linux-amd64.tar.gz
            out/shepherd-linux-amd64.tar.gz.sha256
            out/shepherd-linux-arm64.tar.gz
            out/shepherd-linux-arm64.tar.gz.sha256
```

- [ ] **Step 2: Optional — `actionlint` check**

```
actionlint .github/workflows/release.yml
```

- [ ] **Step 3: Commit**

```
git add .github/workflows/release.yml
git commit -m "ci: add release workflow (dual-arch tarballs + ghcr multi-arch image + GH release)"
```

---

## Milestone 5 — Bilingual README

### Task 10: `README.md` (English)

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

````markdown
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
````

- [ ] **Step 2: Commit**

```
git add README.md
git commit -m "docs: add English README"
```

---

### Task 11: `README.zh-CN.md` (Chinese)

**Files:**
- Create: `README.zh-CN.md`

- [ ] **Step 1: Write `README.zh-CN.md`** (mirror of English README, structurally aligned)

````markdown
# Shepherd

[English](README.md) · [简体中文](README.zh-CN.md)

自托管的服务器舰队管理工具，agent 零凭据架构。监控一批 Linux 主机、用 SSH 一次性
装 agent（凭据用完即弃），并通过单一 WebSocket 长连远程运维。Phase 1（alpha）
提供监控 + admin UI；远程运维、插件、xray、relay、告警是后续 phase 的内容。

**状态：** Phase 1 alpha —— 后端 + 前端 + 端到端 smoke 全过；首个版本 `v0.1.0` 已
发布到 GitHub Releases。

## 特性

- 浏览器 admin 面板（React 19）+ 公共监控墙（脱敏，IP / 主机名 / fingerprint 不外露）
- 一次性 SSH 装 agent，凭据用完即弃，绝不持久化
- 每主机 telemetry（CPU / 内存 / 磁盘 / 网络 / 负载 / TCP 连接数），默认 30s 一次
  采样；可按服务器单独调整间隔
- 时序查询跨 1h / 24h / 7d，库内 30s → 5m → 1h 三级聚合，分桶各自保留期裁剪
- 默认 SQLite（单文件零依赖），通过环境变量切 Postgres
- fleet 自助上线（`AUTO_RECOVER_KEY`）：主机起来后按 fingerprint 识别、领取 machine token
- 双语 UI（zh-CN + en），三态主题（浅色 / 深色 / 跟随系统）
- 单二进制部署（前端 embed），或 `docker compose up`

## 架构

```
┌──────────────┐    HTTPS    ┌─────────────────────┐    HTTP    ┌──────────────────┐
│ 浏览器       │────────────▶│  反代               │───────────▶│  Shepherd Server │
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
                                                                  gopsutil 采集器
```

## 快速开始

### Docker Compose（推荐）

```bash
git clone https://github.com/hg-claw/Shepherd.git
cd Shepherd
cp .env.example .env
$EDITOR .env   # 设置 INITIAL_ADMIN_USERNAME / INITIAL_ADMIN_PASSWORD / AUTO_RECOVER_KEY
docker compose up -d
# 浏览器打开 http://localhost:8080
```

前面叠 TLS 反代（Caddy / Nginx）。参考
[`deploy/caddy/Caddyfile.example`](deploy/caddy/Caddyfile.example)。

### 切到 Postgres

```bash
# .env 里设：
#   DATABASE_DRIVER=postgres
#   DATABASE_DSN=postgres://shepherd:shepherd@postgres:5432/shepherd?sslmode=disable
docker compose --profile pg up -d
```

### 单二进制（Linux）

从[最新 release](https://github.com/hg-claw/Shepherd/releases/latest)下载：

```bash
ARCH=amd64   # 或 arm64
curl -fsSLO "https://github.com/hg-claw/Shepherd/releases/latest/download/shepherd-linux-${ARCH}.tar.gz"
tar -xzf "shepherd-linux-${ARCH}.tar.gz"
sudo install -m 0755 "shepherd-server-linux-${ARCH}" /usr/local/bin/shepherd-server
sudo install -m 0755 "shepherd-agent-linux-${ARCH}" /usr/local/bin/shepherd-agent
```

完整 systemd unit + env-file 步骤见
[`deploy/README.md`](deploy/README.md)。

### 从源码构建

```bash
make web && make server
./bin/shepherd-server
```

## 部署

[`deploy/README.md`](deploy/README.md) 详述三种部署形态（Compose / systemd 二进制 / 源码构建）
以及 TLS 反代配置。

## 开发

### 前置工具

- Go 1.22+
- Node 20+ 和 npm 10+
- GNU make
- （可选）Docker，用于本地镜像构建和 Compose 测试
- （可选）`actionlint`、`hadolint`，用于本地 lint

### 首次拉代码

```bash
git clone https://github.com/hg-claw/Shepherd.git
cd Shepherd
cd web && npm ci && cd ..
```

### 启动开发栈

两个终端：

```bash
# 终端 1 —— 后端
make server-no-web   # 快，不打包 SPA
INITIAL_ADMIN_USERNAME=alice INITIAL_ADMIN_PASSWORD=hunter2 \
AUTO_RECOVER_KEY=secret \
DATABASE_DSN="file:./dev.db?_fk=1" \
SERVER_PUBLIC_URL=http://localhost:8080 \
./bin/shepherd-server

# 终端 2 —— 前端（Vite 开发服务器，含 /api 代理）
cd web && npm run dev
# 浏览器打开 http://localhost:5173
```

### 跑测试

```bash
make test                # go test + npm test
make vet                 # go vet
gofmt -l .               # 列出未格式化的 Go 文件
cd web && npx tsc --noEmit
cd web && npx vitest run
```

### 端到端 smoke

```bash
./scripts/smoke.sh       # backend 端到端（server + agent + telemetry）
./scripts/web-smoke.sh   # 完整流程：build 前端 + server + agent + 验证 SPA + telemetry
```

### 本地 Docker 构建

```bash
make docker-build VERSION=v0.0.0-local
docker run --rm -p 8080:8080 \
  -e INITIAL_ADMIN_USERNAME=alice \
  -e INITIAL_ADMIN_PASSWORD=hunter2 \
  shepherd:v0.0.0-local
```

### 本地 release dry run（仅 Linux）

```bash
make release VERSION=v0.0.0-local
ls -lh dist/
# 期望：shepherd-server-linux-{amd64,arm64} + shepherd-agent-linux-{amd64,arm64} + tar.gz + sha256
tar -tzf dist/shepherd-linux-amd64.tar.gz
```

macOS / Windows 上 arm64 server 跨编会因 CGO 工具链缺失失败 —— 改用 GitHub Actions
release workflow，或者用 `make docker-build` 跑单架构镜像。

## 路线图

| 阶段 | 子系统 | 状态 |
|---|---|---|
| 1.A | 平台核心 + 监控（Go 后端 + agent） | 已完成 |
| 1.B | React SPA（admin 面板 + 公共墙） | 已完成 |
| 1.C | 部署 + release CI + 双语文档 | 本次发布 |
| 2 | 远程运维（PTY / 脚本 / 文件传输） | 计划中 |
| 3 | 插件运行时 + 插件中心 | 计划中 |
| 4 | xray 插件（3x-ui 风格） | 计划中 |
| 5 | relay 插件（gost 风格流量转发） | 计划中 |
| 6 | 告警 / 通知（以插件形式） | 计划中 |

## 许可证

[MIT](LICENSE) —— 见 LICENSE 文件。
````

- [ ] **Step 2: Commit**

```
git add README.zh-CN.md
git commit -m "docs: add Chinese README"
```

---

## Milestone 6 — Local validation

### Task 12: Validate the deploy pipeline locally

This task is mostly **manual** + best-effort: it confirms the artefacts are well-formed without requiring a real release tag push. The CI release.yml is the production source-of-truth.

**Files:** none (validation only).

- [ ] **Step 1: YAML lint (if `actionlint` available)**

```
which actionlint && actionlint .github/workflows/*.yml || echo "actionlint not installed; skipping"
```

If installed, expected: no errors. If not, install via `brew install actionlint` or skip.

- [ ] **Step 2: Dockerfile lint (if `hadolint` available)**

```
which hadolint && hadolint Dockerfile || echo "hadolint not installed; skipping"
```

- [ ] **Step 3: docker-compose syntax (if `docker` available)**

```
which docker && docker compose config > /dev/null && echo "compose: OK" || echo "docker not installed; skipping"
```

- [ ] **Step 4: Verify Makefile targets compile**

```
cd /Users/hg/project/Shepherd
make agents VERSION=v0.0.0-local
ls -lh internal/installer/bin/shepherd-agent-linux-amd64 internal/installer/bin/shepherd-agent-linux-arm64
file internal/installer/bin/shepherd-agent-linux-amd64
file internal/installer/bin/shepherd-agent-linux-arm64
```

Expected: both files exist; `file` reports them as `ELF 64-bit ... x86-64` and `ELF 64-bit ... aarch64`.

- [ ] **Step 5: Run all existing tests one more time**

```
cd /Users/hg/project/Shepherd
make test
```

Expected: all green (Go tests + 34 frontend tests).

- [ ] **Step 6: Local Docker build (if Docker available)**

```
which docker && make docker-build VERSION=v0.0.0-local || echo "docker not installed; skip"
```

If Docker is available:

```
docker images | grep '^shepherd'
docker run --rm -d --name shep-test -p 18080:8080 \
  -e INITIAL_ADMIN_USERNAME=alice \
  -e INITIAL_ADMIN_PASSWORD=hunter2 \
  shepherd:v0.0.0-local
sleep 3
curl -sf http://localhost:18080/api/public/servers
docker stop shep-test
```

Expected: `[]` from the curl. Container starts and stops cleanly.

- [ ] **Step 7: Verify all the new files exist + commit chain looks right**

```
cd /Users/hg/project/Shepherd
ls -la LICENSE Dockerfile docker-compose.yml .dockerignore .env.example
ls -la README.md README.zh-CN.md
ls -la deploy/README.md deploy/caddy/Caddyfile.example
ls -la deploy/systemd/shepherd-server.service deploy/systemd/shepherd-agent.service
ls -la .github/workflows/ci.yml .github/workflows/release.yml
git log --oneline phase-1c ^phase-1b
```

All files should exist; git log should show ~11 commits since branching from `phase-1b`.

- [ ] **Step 8: Cleanup local test artefacts (optional)**

If you ran the docker build:

```
docker rmi shepherd:v0.0.0-local
rm -rf dist/
```

Don't `make web-clean` — that wipes the embedded frontend dist. Leave it.

- [ ] **Step 9: Report**

Status: DONE | DONE_WITH_CONCERNS | BLOCKED
- Which optional checks ran (actionlint? hadolint? docker?), and their result
- Whether `make test` is still all green
- Whether `make agents` produces both ELF binaries
- Any deviations from the plan
- Any concerns about the release.yml that should be flagged before tagging v0.1.0

---

## Done — what's delivered

After Task 12 the branch contains:

- Single binary, Compose, and tarball deployment forms — all documented and reproducible
- `Dockerfile` + `docker-compose.yml` + `deploy/` artefacts
- `.github/workflows/{ci.yml,release.yml}` — PR/push lint+test, tag/dispatch dual-arch tarball + ghcr image + GH release
- Makefile targets for cross-arch agents, local release, local Docker build
- Bilingual README with full Development section (local test flow, smoke scripts, build commands)
- MIT LICENSE

The user should:
1. Push `phase-1c` to GitHub: `git push -u origin phase-1c`
2. Open PR `phase-1c → main` (after `phase-1b` is merged into main)
3. Once merged: `git tag v0.1.0 && git push origin v0.1.0` to trigger the release workflow
4. After first ghcr.io push, manually flip the package visibility to public in GitHub → Settings → Packages

That's the end of Phase 1. Phase 2 (remote ops) is the natural next move.
