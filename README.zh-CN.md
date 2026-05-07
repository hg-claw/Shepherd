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
