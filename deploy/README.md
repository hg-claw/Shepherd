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
