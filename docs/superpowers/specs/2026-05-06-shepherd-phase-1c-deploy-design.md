# Shepherd — Phase 1.C 设计：部署 + 发布流水 + 文档

- **日期**：2026-05-06
- **范围**：Phase 1 路线图中的 1.C（最后一块；包内容 = Docker Compose + 多阶段 Dockerfile + 多架构构建 + GitHub Actions CI/release + 跨编 Makefile + 双语 README + 本地测试流程文档）
- **依赖**：Phase 1.B 已合到 main 后才能并入 main；1.C 在分支期间基于 `phase-1b`（用到 `web/`、`internal/web/`、`internal/installer/bin/`）

---

## 1. 目标 / 非目标

### 1.1 目标

- 一份 `Dockerfile` + `docker-compose.yml` 让任何 docker 用户能 `docker compose up` 起 shepherd
- 多架构构建：linux/amd64 + linux/arm64
- 真正的 `v0.1.0` release：tag push 触发 GitHub Actions，产出双 arch tarball + 双 arch ghcr.io 镜像 + GitHub Release 条目
- PR / push to main 时 CI 跑 lint + test（Go + web）
- 本地能 `make release VERSION=v0.1.0` 离线复现 release 物料（验证 + 不依赖 CI）
- 双语 README：`README.md`（英文，GitHub 默认渲染） + `README.zh-CN.md`（中文）；两份都是完整内容，互相 link
- 本地测试 / smoke 流程文档化（写进 README "Development" 段）

### 1.2 非目标（明确排除）

- TLS 自动化 / 内置 Caddy 服务（用户自行在 Compose 上叠反代；提供 `deploy/caddy/Caddyfile.example` 作参考）
- Helm Chart / Kubernetes manifest（v2）
- 镜像签名 cosign / SBOM（v2）
- 多语言扩展（zh-TW、ja 等）（v2）
- 真正的 staging 环境 / blue-green（用户自己搞）
- 性能测试 / load testing（v2）

---

## 2. 文件布局

```
Dockerfile                                       # 多阶段：node-builder + go-builder + alpine runtime
.dockerignore                                    # 排除 node_modules、bin/、dist 等
docker-compose.yml                               # 默认 SQLite，pg 服务在 profile=pg 后启用
.env.example                                     # 顶层 env 模板，docker-compose.yml 引用

deploy/
  README.md                                      # 三种部署形态对比 + 详细步骤（中英两段）
  caddy/Caddyfile.example                        # 反代 + auto-TLS 参考片段
  systemd/shepherd-server.service                # 非 Docker 单二进制部署
  systemd/shepherd-agent.service                 # 归档参考（实际由 installer 动态生成）

.github/workflows/
  ci.yml                                         # PR + push to main: golangci-lint + go test + npm test
  release.yml                                    # tag/dispatch: 双 arch tarball + 多 arch ghcr 镜像 + GH release

Makefile                                         # 现有基础上加：agent-amd64 / agent-arm64 / agents / release / docker

README.md                                        # 英文，GitHub 默认渲染
README.zh-CN.md                                  # 中文
LICENSE                                          # MIT
```

---

## 3. Dockerfile（多阶段）

```dockerfile
# syntax=docker/dockerfile:1.7

# ── Stage 1: web build (node) ─────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:20-alpine AS web-builder
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build      # outputs to /src/internal/web/dist via vite outDir

# ── Stage 2: go build ─────────────────────────────────────────────
# Note: NO --platform pin here. Under buildx, this stage runs natively for
# the target arch (via QEMU when host != target). That lets CGO=1 work for
# the SQLite driver without setting up a cross-compiler.
FROM golang:1.22-alpine AS go-builder
RUN apk add --no-cache build-base sqlite-dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web-builder /src/internal/web/dist ./internal/web/dist
ARG VERSION=dev
# Cross-compile both agent arches into the embed dir so any-arch server image
# can install agents on either-arch hosts. Agents are pure Go (CGO=0) and
# cross-compile cleanly without a C toolchain.
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

> CGO is required for SQLite (`mattn/go-sqlite3`). Alpine has musl, so we link against `sqlite-libs` at runtime. The agent binaries are CGO-disabled (collector/wsclient don't need cgo) so they cross-compile cleanly.

---

## 4. `.dockerignore`

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
```

> Force-include `.gitkeep` so the embed pattern still matches (although web-builder stage will overwrite the directory with the real dist).

---

## 5. `docker-compose.yml`

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

切到 PG：在 `.env` 里设
```
DATABASE_DRIVER=postgres
DATABASE_DSN=postgres://shepherd:shepherd@postgres:5432/shepherd?sslmode=disable
```
然后 `docker compose --profile pg up`。

---

## 6. `.env.example`

```env
# Required for first run if you want a default admin auto-created.
INITIAL_ADMIN_USERNAME=alice
INITIAL_ADMIN_PASSWORD=change-me

# Required if you want fleet self-onboarding via AUTO_RECOVER_KEY.
AUTO_RECOVER_KEY=

# URL the agent will dial back to (default localhost — set this when behind a reverse proxy).
SERVER_PUBLIC_URL=http://localhost:8080

# Optional: pin a specific image tag.
# SHEPHERD_TAG=v0.1.0

# Optional: change the host port mapping (8080 default).
# SHEPHERD_PORT=8080

# --- Postgres profile (only used with `docker compose --profile pg up`) ---
# DATABASE_DRIVER=postgres
# DATABASE_DSN=postgres://shepherd:shepherd@postgres:5432/shepherd?sslmode=disable
# PG_PASSWORD=change-me

# --- Agent distribution channel (default: embedded; switch to github after first release) ---
# AGENT_DISTRIBUTION=github
# AGENT_DOWNLOAD_TAG=v0.1.0
```

---

## 7. Makefile 增量

> 在现有 Plan 1.B 的 Makefile 基础上追加（不覆盖现有 `web` / `server-no-web` / `agent` / `test*` 等）。

```make
.PHONY: agents agent-amd64 agent-arm64 release docker-build docker-push

# Build agent for both arches and place into the embed directory the server uses.
agents: agent-amd64 agent-arm64

agent-amd64:
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build \
	  -ldflags "-X github.com/hg-claw/Shepherd/internal/agentconfig.BuildVersion=$(VERSION)" \
	  -o internal/installer/bin/shepherd-agent-linux-amd64 ./cmd/agent

agent-arm64:
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build \
	  -ldflags "-X github.com/hg-claw/Shepherd/internal/agentconfig.BuildVersion=$(VERSION)" \
	  -o internal/installer/bin/shepherd-agent-linux-arm64 ./cmd/agent

# `make server` already exists; redefine it to depend on agents so the embed
# pattern always finds real binaries instead of placeholders.
# (Plan 1.A's server target is overridden by adding a hard dependency on `agents`.)

# Local release: cross-compile server + agent for both arches, package tar.gz + sha256.
# Use as: make release VERSION=v0.1.0
release: web agents
	@if [ -z "$(VERSION)" ]; then echo "VERSION required (e.g. make release VERSION=v0.1.0)"; exit 1; fi
	rm -rf dist && mkdir -p dist
	@for arch in amd64 arm64; do \
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

# Single-arch local Docker image build (uses the host's docker; no buildx required).
docker-build:
	docker build -t shepherd:$(VERSION) --build-arg VERSION=$(VERSION) .
```

> Caveat: `make release` cross-compiling the **server** for both arches with CGO requires either Linux host + multiple CC compilers, or use Docker buildx. For Phase 1.C we accept this caveat: `make release` is a Linux-host-only convenience. macOS users use the CI for actual cross-compile, or run `make docker-build` for a single-arch image.

---

## 8. CI 工作流

### 8.1 `.github/workflows/ci.yml`

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
        with: { go-version: '1.22' }
      - name: golangci-lint
        uses: golangci/golangci-lint-action@v6
        with: { version: v1.59 }
      - run: go vet ./...
      - run: go test -race ./...

  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm', cache-dependency-path: 'web/package-lock.json' }
      - run: cd web && npm ci
      - run: cd web && npm test
      - run: cd web && npm run build  # ensures TS + vite build pass
```

### 8.2 `.github/workflows/release.yml`

```yaml
name: Release
on:
  push:
    tags: ['v*.*.*']
  workflow_dispatch:
    inputs:
      tag:
        description: 'Version tag (e.g. v0.1.0)'
        required: true

permissions:
  contents: write       # for GH release
  packages: write       # for ghcr.io push

jobs:
  binaries:
    runs-on: ubuntu-latest
    strategy:
      matrix: { arch: [amd64, arm64] }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.22' }
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm', cache-dependency-path: 'web/package-lock.json' }
      - run: cd web && npm ci && npm run build
      - name: Resolve version
        run: echo "VERSION=${{ github.event.inputs.tag || github.ref_name }}" >> $GITHUB_ENV
      - name: Cross-compile agent (both arches embedded into server)
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
            sudo apt-get update && sudo apt-get install -y gcc-aarch64-linux-gnu
            export CC=aarch64-linux-gnu-gcc
          fi
          mkdir -p dist
          GOOS=linux GOARCH=${{ matrix.arch }} CGO_ENABLED=1 \
            go build \
            -ldflags "-X github.com/hg-claw/Shepherd/internal/config.BuildVersion=${VERSION}" \
            -o dist/shepherd-server-linux-${{ matrix.arch }} \
            ./cmd/server
          cp internal/installer/bin/shepherd-agent-linux-${{ matrix.arch }} dist/
          tar -czf dist/shepherd-linux-${{ matrix.arch }}.tar.gz -C dist shepherd-server-linux-${{ matrix.arch }} shepherd-agent-linux-${{ matrix.arch }}
          (cd dist && sha256sum shepherd-linux-${{ matrix.arch }}.tar.gz > shepherd-linux-${{ matrix.arch }}.tar.gz.sha256)
      - uses: actions/upload-artifact@v4
        with:
          name: bins-${{ matrix.arch }}
          path: dist/shepherd-linux-${{ matrix.arch }}.tar.gz*

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
      - uses: docker/build-push-action@v6
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
        with: { path: dist, pattern: bins-* }
      - run: |
          mkdir -p out
          mv dist/bins-*/* out/
          ls -la out/
      - uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ github.event.inputs.tag || github.ref_name }}
          generate_release_notes: true
          files: |
            out/shepherd-linux-amd64.tar.gz
            out/shepherd-linux-amd64.tar.gz.sha256
            out/shepherd-linux-arm64.tar.gz
            out/shepherd-linux-arm64.tar.gz.sha256
```

---

## 9. README — 双语策略

### 9.1 文件

- `README.md` — 英文，GitHub 默认渲染
- `README.zh-CN.md` — 中文
- 两份顶部都放语言切换 link：`[English](README.md) | [简体中文](README.zh-CN.md)`

### 9.2 内容大纲（两份保持结构对齐，便于翻译同步）

1. **Title / tagline**：Shepherd — Server fleet management with zero-credential agents
2. **Status**：phase 1 (alpha)
3. **Features**（短列表）：监控、运维、xray/relay/告警 plugins(待做)、零凭据 agent、单二进制 / Compose / k8s(v2)
4. **Architecture diagram**：复制 spec §2 的 ASCII 图
5. **Quick start**：
   - 5.1 Docker Compose（推荐）：clone + `cp .env.example .env` + 编辑 admin 凭据 + `docker compose up`
   - 5.2 单二进制：`make web && make server && ./bin/shepherd-server`
   - 5.3 自定义构建：`make release VERSION=v0.1.0`
6. **Deployment**：链到 `deploy/README.md` 的详细分形态指南
7. **Development**（**新增、本任务重点**）：
   - 7.1 Prerequisites：Go 1.22+, Node 20+, npm 10+, make
   - 7.2 First-time setup：`git clone` + `cd web && npm ci`
   - 7.3 Run dev stack：双终端 `./bin/shepherd-server` + `cd web && npm run dev`，浏览器 http://localhost:5173
   - 7.4 Run tests：`make test`（go + web）；细分：`go test -race ./...` 和 `cd web && npm test`
   - 7.5 Lint：`make vet` + `make fmt` + `(cd web && npx tsc --noEmit)`
   - 7.6 End-to-end smoke：`./scripts/smoke.sh`（Phase 1.A backend smoke），`./scripts/web-smoke.sh`（Phase 1.B 完整 e2e）
   - 7.7 Local release dry run：`make release VERSION=v0.1.0`
   - 7.8 Local Docker build：`make docker-build VERSION=v0.1.0`
8. **API reference summary**：spec §7 routes 表格
9. **Roadmap**：5+1 phases
10. **License**：MIT — 同时新增根目录 `LICENSE` 文件（标准 MIT 模板，copyright `2026 hg-claw`）
11. **Contributing**：链到 CONTRIBUTING.md（v2，本期不做）

> 翻译策略：用清晰、机器友好的英文（避免双关 / 习语），中文版用书面语简体；保持代码块、命令、文件路径在两份里一致。

---

## 10. 本地测试流程清单（README §7 的细化）

### 10.1 单测 / lint

```bash
make test          # 跑 go test + npm test
make vet           # go vet
gofmt -l .         # 列出未格式化的 .go 文件
cd web && npx tsc --noEmit
cd web && npx vitest run
```

### 10.2 端到端 smoke

```bash
./scripts/smoke.sh     # backend (server + agent + telemetry)
./scripts/web-smoke.sh # 完整：build frontend + server + agent + 验证 SPA + telemetry
```

### 10.3 Docker Compose

```bash
docker compose up --build    # 默认 SQLite，端口 :8080
docker compose --profile pg up --build    # 用 Postgres
```

### 10.4 多架构镜像本地构建

```bash
docker buildx create --use --name shepherd-builder
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg VERSION=v0.0.0-local -t shepherd:local .
# 拉本地：--load 只能加载一个 arch；多 arch 镜像必须 push 到 registry 才能完整保留
```

### 10.5 Release dry run

```bash
make release VERSION=v0.0.0-local
ls -lh dist/
# expect: shepherd-server-linux-{amd64,arm64} + shepherd-agent-linux-{amd64,arm64} + tar.gz + sha256
tar -tzf dist/shepherd-linux-amd64.tar.gz   # confirm contents
```

> Note: `make release` 本地仅在 Linux 主机上完整工作（需要 `gcc-aarch64-linux-gnu` 给 server 跨编 CGO）。macOS 用户用 CI 或 `make docker-build` 替代。

---

## 11. 出口标准

- `docker compose up` 起来后浏览器访问 `http://localhost:8080`，能看到 Phase 1.B 的公共监控墙（空状态）
- `docker compose --profile pg up` 起来，server 用 Postgres 跑，登录 + agent 自助上线 + telemetry 全流程通
- `make release VERSION=v0.0.0-local` 在 Linux 主机能完整产出 dist/
- 真切一个 `v0.1.0` git tag，CI release.yml 触发并完整跑完，GitHub Releases 出现 tarballs（带 sha256），`ghcr.io/hg-claw/shepherd:v0.1.0` 可拉
- `docker pull ghcr.io/hg-claw/shepherd:v0.1.0` 能在 amd64 + arm64 两种主机上跑起来
- `README.md` 和 `README.zh-CN.md` 内容对齐，两份都包含 §7 Development（本地测试流程）
- 根目录 `LICENSE` 文件存在（标准 MIT 模板）
- CI on PR：lint + test 全绿
- `actionlint .github/workflows/*.yml` 通过

---

## 12. 风险 / 已知 gap

| 项 | 风险 | 缓解 |
|---|---|---|
| 多 arch 跨编 CGO | `gcc-aarch64-linux-gnu` 必须装，CI runner 上靠 apt 装；macOS 本地不行 | release.yml 文档化；本地用 docker buildx 替代 |
| Alpine + sqlite3 musl | mattn/go-sqlite3 需要 sqlite-dev 头 + sqlite-libs 运行时；alpine 已提供 | Dockerfile 装好；测过 |
| ghcr.io 默认私有 | 第一次 push 后镜像默认 private，外部用户拉不到 | 文档：第一次 release 后到 GitHub Settings → Packages 改 public（手动一次性） |
| Caddy 自动 cert 不内置 | 用户必须自己配 | `deploy/caddy/Caddyfile.example` 给完整可用范例 |
| 双语 README 同步漂移 | 改一份忘改另一份 | 在 PR 模板里加提醒（v2）；本期靠 review |

---

## 13. v2 / 之后

- Helm chart + k8s manifest
- cosign 镜像签名
- SBOM（trivy / syft）
- nightly build to ghcr.io
- 多语言扩展（zh-TW / ja / ko）
- CONTRIBUTING.md + PR template + issue templates
- Renovate / Dependabot 配置
