# Shepherd — Phase 1 设计：平台核心 + 监控

- **日期**：2026-05-06
- **范围**：5 阶段路线图中的 Phase 1
- **后续 phase**（各自单独 spec）：
  - Phase 2 — 远程运维（PTY/脚本/文件传输）
  - Phase 3 — 插件运行时 + 插件中心（含市场）
  - Phase 4 — xray 插件
  - Phase 5 — relay 插件
  - Phase 6 — 告警、通知 插件

---

## 1. 目标 / 非目标

### 1.1 目标
- 通过 admin Web 面板**注册并安装**一批 Linux 服务器（一次性 SSH 装 agent，不存凭据）
- 自服务 fleet 上线（全局 `AUTO_RECOVER_KEY`）
- 持续采集 CPU / MEM / DISK / NET / Load / TCP 连接数 / 上下行速率
- 提供两面 UI：
  - **公共监控墙**（无需登录、脱敏）
  - **admin 面板**（完整信息）
- agent 连接稳态走单条 WebSocket，所有控制/数据帧通过该连接复用

### 1.2 非目标（明确排除，留给后续 phase）
- 远程交互（PTY、脚本下发、文件上传/下载） → Phase 2
- 插件运行时 + 第三方插件加载 → Phase 3
- xray、relay、DNS 等具体业务能力 → Phase 4/5（皆为插件）
- 告警、通知（用插件实现） → Phase 6
- Windows agent
- 多 admin 用户、操作审计日志（v2）
- TLS 直接终结于 Go 进程（统一交给反代）

---

## 2. 架构

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
                                                                  gopsutil 采集
```

- 单进程、单端口（默认 `:8080`）。同一个 Go 进程同时 serve：
  - 浏览器静态资源（embed `web/dist`）
  - REST API（`/api/*`）
  - 公共 WS（如有，目前 Phase 1 只走 REST）
  - agent 反向 WS（`/agent/ws`）+ agent 注册 HTTP（`/agent/enroll`、`/agent/auto-register`）
- TLS 由反代终结。Go 进程跑明文 HTTP/WS。
- Agent 反向连接 server 的 WS，server 通过 hub 统一推送 envelope；server 不主动连接 agent。

---

## 3. 技术栈

| 层 | 选型 | 备注 |
|---|---|---|
| 后端 | Go 1.22+ | |
| HTTP | `net/http` + `gorilla/websocket` 或 `nhooyr.io/websocket` | 优先 stdlib + 单一 WS 库 |
| DB 访问 | `sqlx` + `golang-migrate` | |
| DB | SQLite（默认）/ Postgres（`DATABASE_DRIVER=postgres`） | 同一份 schema 同时跑 |
| 系统采集 | `gopsutil` | |
| 前端 | React 19 + Vite + TS + Tailwind 3 | |
| 路由/状态 | react-router + react-query | |
| 图表 | 手写 SVG sparkline（避免大依赖） | recharts 可选，不进 Phase 1 |

---

## 4. Go 模块拆分

模块路径：`github.com/<owner>/shepherd`（具体 owner 实施时确定）。

| 包 | 职责 |
|---|---|
| `cmd/server` | 主进程装配；解析 env，连 DB，跑迁移，启 HTTP server |
| `cmd/agent` | agent 主进程 |
| `internal/agentapi` | envelope wire types：`{sid, type, p}`，server / agent 共用 |
| `internal/auth` | bcrypt + DB session cookie；中间件 `RequireAdmin` |
| `internal/serversvc` | server CRUD、异步 SSH 安装器、`install_stage` / `install_log` 状态机 |
| `internal/agentsvc` | enrollment token、machine token、auto-recover、hub（在线 agent 注册表 + 推送） |
| `internal/installer` | SSH 走一次，scp 二进制 + systemd unit + `agent.env`；TOFU host key 待加 |
| `internal/telemetrysvc` | 接收 telemetry envelope → 写 `samples_30s`；后台 1 个 goroutine 每分钟跑一次聚合（封盘上一个 5m / 1h bucket）；后台另 1 个 goroutine 每 10 分钟跑保留期裁剪 |
| `internal/api` | REST 路由（`/api/public/*`、`/api/*`），WS 路由（`/agent/ws`） |
| `internal/db` | 连接、迁移、driver 抽象 |
| `internal/plugin` | **占位**：声明 hook 接口（未实现），Phase 3 填充 |
| `internal/agent/wsclient` | 反向 WS 长连，重连退避，收 server envelope dispatch |
| `internal/agent/collector` | gopsutil 采集，按周期发 telemetry envelope；采样间隔可被 server 下发更新 |
| `internal/agent/state` | `/etc/shepherd/agent.state.json` 读写 |
| `web/` | React 单页 |

---

## 5. 通信协议

### 5.1 envelope（`internal/agentapi`）

```go
type Envelope struct {
    Sid  string          `json:"sid,omitempty"` // 会话相关帧用，Phase 1 留空
    Type string          `json:"type"`
    P    json.RawMessage `json:"p"`
}
```

### 5.2 server → agent

| `type` | payload | 说明 |
|---|---|---|
| `config.update` | `{telemetry_interval_seconds: int}` | 调整采集频率，agent 持久化到 state |
| `ping` | `{}` | 30s 一次，活性探测 |

### 5.3 agent → server

| `type` | payload | 说明 |
|---|---|---|
| `heartbeat` | `{ts, agent_version, os, arch, kernel}` | 1 min |
| `telemetry` | 见 §5.4 | 默认 30s，可调 |
| `pong` | `{}` | 回复 ping |

### 5.4 telemetry payload

```jsonc
{
  "ts": "2026-05-06T10:00:00Z",
  "cpu_pct": 12.4,                    // 0-100
  "mem_used": 4123456789,             // bytes
  "mem_total": 16777216000,
  "load_1": 0.42,
  "load_5": 0.38,
  "load_15": 0.31,
  "net_rx_bps": 184320,               // 自上次发送以来的平均速率
  "net_tx_bps": 92160,
  "tcp_conn": 184,                    // 当前 ESTABLISHED 数
  "disks": [                          // 排除 tmpfs / squashfs / overlay
    {"mount": "/", "used": 12000000000, "total": 100000000000},
    {"mount": "/data", "used": 50000000000, "total": 500000000000}
  ]
}
```

> **net 速率算法**：agent 在 collector 内保存上次累计 `rx_bytes` / `tx_bytes` 与时间戳，每次差分除以间隔。首次采样无前值则跳过本次发送。

---

## 6. 数据模型

```sql
-- ============== 用户 ==============
CREATE TABLE admins (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                    -- bcrypt
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,                   -- random 32B base64url
  admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at  TIMESTAMP NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============== 服务器 ==============
CREATE TABLE servers (
  id                 INTEGER PRIMARY KEY,
  name               TEXT NOT NULL,               -- admin 内部别名
  public_alias       TEXT,                        -- 公共页显示名（NULL 不出现）
  public_group       TEXT,                        -- 公共页分组
  country_code       TEXT,                        -- ISO 3166-1 alpha-2，可选
  show_on_public     BOOLEAN NOT NULL DEFAULT 0,

  -- 一次性安装通道（仅 stage='installing' 期间临时持有）
  ssh_host           TEXT,
  ssh_port           INTEGER NOT NULL DEFAULT 22,
  ssh_user           TEXT,
  install_stage      TEXT NOT NULL DEFAULT 'pending',  -- pending|installing|done|failed
  install_log        TEXT NOT NULL DEFAULT '',
  install_error      TEXT,
  install_started_at TIMESTAMP,

  -- agent 状态
  agent_version      TEXT,
  agent_os           TEXT,
  agent_arch         TEXT,
  agent_kernel       TEXT,
  agent_last_seen    TIMESTAMP,
  agent_fingerprint  TEXT UNIQUE,                 -- 自动恢复匹配键

  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_servers_show_on_public ON servers(show_on_public);

-- ============== 入网凭据 ==============
CREATE TABLE enrollment_tokens (
  token       TEXT PRIMARY KEY,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  expires_at  TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Phase 1 内 enrollment_token 总是绑到具体 server。AUTO_RECOVER_KEY 走另一条路（不查这张表）。

CREATE TABLE machine_tokens (
  token       TEXT PRIMARY KEY,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  rotated_at  TIMESTAMP                                          -- 自动恢复时被替换则更新
);

-- ============== 监控样本 ==============
CREATE TABLE telemetry_samples_30s (
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts          TIMESTAMP NOT NULL,
  cpu_pct     REAL,
  mem_used    INTEGER,
  mem_total   INTEGER,
  load_1      REAL,
  load_5      REAL,
  load_15     REAL,
  net_rx_bps  INTEGER,
  net_tx_bps  INTEGER,
  tcp_conn    INTEGER,
  disks_json  TEXT,                                              -- 原 JSON 数组
  PRIMARY KEY (server_id, ts)
);

CREATE TABLE telemetry_rollup_5m (
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts          TIMESTAMP NOT NULL,                                -- bucket 起点
  cpu_avg REAL, cpu_max REAL,
  mem_used_avg INTEGER, mem_used_max INTEGER, mem_total INTEGER,
  load_1_avg REAL, load_1_max REAL,
  net_rx_bps_avg INTEGER, net_rx_bps_max INTEGER,
  net_tx_bps_avg INTEGER, net_tx_bps_max INTEGER,
  tcp_conn_avg INTEGER, tcp_conn_max INTEGER,
  disks_json TEXT,
  PRIMARY KEY (server_id, ts)
);

CREATE TABLE telemetry_rollup_1h (
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts          TIMESTAMP NOT NULL,
  cpu_avg REAL, cpu_max REAL,
  mem_used_avg INTEGER, mem_used_max INTEGER, mem_total INTEGER,
  load_1_avg REAL, load_1_max REAL,
  net_rx_bps_avg INTEGER, net_rx_bps_max INTEGER,
  net_tx_bps_avg INTEGER, net_tx_bps_max INTEGER,
  tcp_conn_avg INTEGER, tcp_conn_max INTEGER,
  disks_json TEXT,
  PRIMARY KEY (server_id, ts)
);

-- ============== 全局设置 ==============
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 已知 key：
--   public_display_mode  := 'raw' | 'level' | 'both'   -- 公共页粒度
--   retention_30s        := '24h'                      -- 短粒度保留期
--   retention_5m         := '7d'
--   retention_1h         := '90d'
--   default_telemetry_interval_seconds := '30'         -- 新装 agent 的初始周期
--   auto_recover_key_hint:= 'last4...'                 -- UI 显示用
```

> 保留期采用字符串（Go 侧 `time.ParseDuration`）。SQLite / Postgres 行为统一，靠应用层 `WHERE ts < ?` 删除。

---

## 7. REST API

### 7.1 公共（无需登录）

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/api/public/servers` | 列出 `show_on_public=true` 的脱敏卡片：`{id, alias, group, country_code, online, latest: {cpu_pct, mem_pct, disks_pct[], net_rx_bps, net_tx_bps, load_1, tcp_conn}}` |
| `GET` | `/api/public/servers/:id/telemetry?range=1h\|24h\|7d` | 时序点；自动按 range 选 30s / 5m / 1h 粒度 |
| `GET` | `/api/public/settings` | 仅暴露 `public_display_mode`（`raw` / `level` / `both`） |

### 7.2 admin（需 session）

| Method | Path | 说明 |
|---|---|---|
| `POST` | `/api/login` | username + password → 设置 `__Host-shepherd_session` cookie |
| `POST` | `/api/logout` | |
| `GET`  | `/api/admins/me` | |
| `GET`  | `/api/servers` | 列表 |
| `POST` | `/api/servers` | 创建占位（不装） |
| `PATCH`| `/api/servers/:id` | 改 name / public_* / show_on_public |
| `DELETE`| `/api/servers/:id` | 级联删 telemetry / token |
| `POST` | `/api/servers/install` | 异步 SSH 装 agent；body `{name, ssh_host, ssh_port, ssh_user, ssh_password\|ssh_key, public_alias?, public_group?, country_code?, show_on_public?}`；返回 `{server_id}` |
| `GET`  | `/api/servers/:id` | 含 install 状态、最新指标、agent 元数据 |
| `GET`  | `/api/servers/:id/telemetry?range=...` | admin 看到完整字段 |
| `POST` | `/api/servers/:id/repair` | 重发 enrollment token，触发 agent 重新拿 machine token |
| `POST` | `/api/servers/:id/config` | body `{telemetry_interval_seconds}`；server 推 `config.update` 到 agent |
| `GET`  | `/api/settings` | 全部 |
| `PATCH`| `/api/settings` | 改 `public_display_mode`、保留期等 |

### 7.3 agent 入口

| Method | Path | 说明 |
|---|---|---|
| `POST` | `/agent/enroll` | body `{enrollment_token, fingerprint, os, arch, kernel, agent_version}` → 返回 `{machine_token, server_id}` |
| `POST` | `/agent/auto-register` | body `{auto_recover_key, fingerprint, hostname, os, arch, kernel, agent_version}` → fingerprint 命中已有则**轮换** machine token，否则**新建**一台 server，返回 `{machine_token, server_id}` |
| `GET`  | `/agent/ws` | `Authorization: Bearer <machine_token>` 升级为 WS |

---

## 8. Agent 端

### 8.1 启动配置（env）

```
SERVER_URL=https://shep.example.com
ENROLLMENT_TOKEN=<one-shot>            # 与 AUTO_RECOVER_KEY 二选一；优先 AUTO_RECOVER_KEY
AUTO_RECOVER_KEY=<global>
```

### 8.2 持久化状态：`/etc/shepherd/agent.state.json`

```json
{
  "machine_token": "...",
  "fingerprint": "...",
  "telemetry_interval_seconds": 30
}
```

- `fingerprint` 来源：`/etc/machine-id` + 主网卡 MAC 的 SHA-256，首次启动生成后落盘；硬件不变就稳定。
- `ENROLLMENT_TOKEN` 用一次后，agent 写入 state 并停止读 env；后续启动靠 state 文件复用 token。
- `AUTO_RECOVER_KEY` 永远从 env 读；state 丢失也能凭 fingerprint 续期 machine_token。

### 8.3 重连退避

`1s → 2s → 4s → 8s → 16s → 32s → 60s`（封顶 60s）；连上后清零。

### 8.4 永久错误（`agentclient.ErrPermanent`）

`/agent/enroll`、`/agent/auto-register`、`/agent/ws` 返回 `401` / `403` 时，agent 退出（exit 1），让 systemd 体现失败状态而不是死循环重连。

### 8.5 安装产物

```
/usr/local/bin/shepherd-agent
/etc/shepherd/agent.env                # SERVER_URL + token 之一
/etc/shepherd/agent.state.json
/etc/systemd/system/shepherd-agent.service
```

---

## 9. 公共展示页

### 9.1 路由
- `/`（默认入口）= 公共监控墙

### 9.2 卡片网格
- 按 `public_group` 分组（无 group 的归"未分组"）
- 每张卡：
  - `public_alias` + 国旗（`country_code` 转 emoji）
  - 在线/离线状态点（`agent_last_seen` 在 `max(90s, 3 × telemetry_interval)` 内视为在线，避免 admin 把间隔改大后误判离线）
  - 4 个核心指标：CPU、MEM（已用/总）、DISK（最满挂载点）、NET（上下行速率）
  - 三个表现模式（由 `public_display_mode` 控制）：
    - `raw`：百分比数字 + 进度条
    - `level`：低 / 中 / 高 / 告警 四档色块（阈值见 §9.4）
    - `both`：两者都显示

### 9.3 详情页
- 路由：`/public/servers/:id`
- 展示 1h / 24h / 7d 三个 range 的 sparkline（CPU、MEM、NET、Load、TCP 连接）
- **不显示**：IP、hostname、ssh_user、agent_fingerprint、agent_version、token 任意字段、install_log

### 9.4 档位阈值（写死，v2 可做成可配）

| 指标 | 低 | 中 | 高 | 告警 |
|---|---|---|---|---|
| CPU% | <40 | 40-70 | 70-90 | ≥90 |
| MEM% | <50 | 50-75 | 75-90 | ≥90 |
| DISK%（最满挂载点） | <60 | 60-80 | 80-90 | ≥90 |
| NET（取 `max(rx_bps, tx_bps)`，即两方向中较大的一档） | <10 MB/s | 10–50 | 50–200 | ≥200 |

---

## 10. Admin 面板

### 10.1 路由

| 路由 | 内容 |
|---|---|
| `/admin/login` | 登录页 |
| `/admin/dashboard` | fleet 概览：在线/离线统计、各指标 top-N |
| `/admin/servers` | 列表（含 IP、agent 状态、操作）+ "添加服务器"按钮 |
| `/admin/servers/new` | 表单：name、SSH 凭据、public_*、country_code、show_on_public → `POST /api/servers/install` |
| `/admin/servers/:id` | 详情：完整指标、agent 状态、re-pair、改 telemetry 间隔、删除 |
| `/admin/settings` | 公共页 `public_display_mode`、保留期、AUTO_RECOVER_KEY 提示 |

### 10.2 装机进度
- 提交 install 后跳到 `/admin/servers/:id`
- 页面 1.5s 轮询 `GET /api/servers/:id`，显示 `install_stage` 与流式 `install_log`
- 完成（`done`）后转入正常详情视图

---

## 11. 部署形态

### 11.1 形态 A — 单二进制 + 反代

```
/usr/local/bin/shepherd-server
/etc/shepherd/server.env
/etc/systemd/system/shepherd-server.service
/var/lib/shepherd/shepherd.db          # SQLite
```

`server.env` 关键：
```
SERVER_HTTP_ADDR=:8080
DATABASE_DRIVER=sqlite
DATABASE_DSN=file:/var/lib/shepherd/shepherd.db?_fk=1
AUTO_RECOVER_KEY=<可选>
INITIAL_ADMIN_USERNAME=<首次启动建号；存在则跳过>
INITIAL_ADMIN_PASSWORD=<同上>
```

反代（Caddy 示例）：
```
shep.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

### 11.2 形态 B — Docker Compose

```yaml
services:
  shepherd:
    image: ghcr.io/<owner>/shepherd:latest
    restart: unless-stopped
    volumes:
      - ./data:/data
    environment:
      SERVER_HTTP_ADDR: ":8080"
      DATABASE_DRIVER: sqlite
      DATABASE_DSN: "file:/data/shepherd.db?_fk=1"
    expose: ["8080"]

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
```

`Caddyfile`:
```
shep.example.com {
    reverse_proxy shepherd:8080
}
```

### 11.3 Postgres 切换

把 env 改成：
```
DATABASE_DRIVER=postgres
DATABASE_DSN=postgres://user:pass@host:5432/shepherd?sslmode=disable
```
迁移文件需同时维护 SQLite / Postgres 双方言（用 golang-migrate 多 dialect 目录）。

---

## 12. agent 二进制分发

**双通道**，由 server 端 env `AGENT_DISTRIBUTION` 切换：

1. `github`（生产默认）— installer 在目标机 SSH 执行：
   ```
   curl -fsSL https://github.com/<owner>/shepherd/releases/download/<tag>/shepherd-agent-linux-<arch> \
     -o /usr/local/bin/shepherd-agent
   chmod +x /usr/local/bin/shepherd-agent
   ```
   版本对齐：server 二进制 embed `BuildVersion` 常量，installer 默认拉同版本；可被 env `AGENT_DOWNLOAD_TAG` 覆盖。

2. `embedded`（开发 / 内网 / 离线）— server 端 `go:embed` 把 agent 二进制（per-arch）打进自己的二进制；installer 通过已建立的 SSH 会话 `scp` 推过去。Makefile 必须能先构建 agent 再构建 server。

> **owner 占位**：`github.com/<owner>/shepherd` 中的 `<owner>` 在仓库初始化时填实，后续整库 grep 替换；本 spec 不锁死。
>
> Phase 1 出口要求：至少一次 `embedded` 模式装机成功，并打出 `v0.1.0` GitHub Release 验证 `github` 模式。

---

## 13. 插件系统的预留（不在本 phase 实现）

Phase 1 不实现任何插件运行时，但**架构必须不挡路**：

- `internal/plugin/` 仅放接口骨架（空文件占位）
- agent 侧的 wsclient envelope dispatch 走 `map[string]Handler` 注册表，便于 Phase 3 后让插件子进程注册新 type
- agent 进程内的 collector / wsclient / state 解耦，Phase 3 引入子进程 RPC 时，agent 主进程演变为"宿主"，插件以独立子进程通过 unix socket gRPC 接入（HashiCorp `go-plugin` 心智）
- 数据库迁移版本号留出空间（Phase 1 用 `0001`，Phase 3 起跳 `0010` 起预留）

---

## 14. 风险 / 已知 gap

| 项 | 风险 | 缓解 |
|---|---|---|
| `ssh.InsecureIgnoreHostKey()` | MITM 风险 | Phase 1 先标 TODO；上反代/暴露公网前必须切 TOFU |
| `auth.Handler{Secure: false}` | session cookie 在明文链路 | 部署侧前置 TLS 反代后切 `true`，文档强制说明 |
| 单 admin、无审计日志 | 多人协作不便 | v2 上 RBAC + audit log |
| WS 在长 NAT/CDN 路径上断连 | telemetry 丢点 | 30s ping/pong；断连内 telemetry 在 agent 端**不**缓冲（设计上接受丢点，避免内存膨胀） |
| SQLite 写并发 | 多 agent 高频写入卡顿 | WAL 模式；30s 间隔下百台机量级无压力；规模到千台再谈 PG |
| install 进程崩了留下 `installing` 卡死 | UI 假阳性 | server 启动时把超过 10min 还在 `installing` 的 row 改为 `failed` |

---

## 15. 测试 / 出口标准

### 15.1 单元 / 集成
- `internal/telemetrysvc` 聚合算法表驱动测试
- `internal/agentsvc` enroll / auto-register / token 轮换路径
- `internal/serversvc` install 状态机
- DB 同时跑 SQLite + Postgres（CI 用 `testcontainers`）

### 15.2 端到端冒烟（手动可复现脚本）
1. `go run ./cmd/server &`
2. 用初始 admin 登录拿 cookie
3. `POST /api/servers/install` 装一台测试机（可以是本地 `localhost` + ssh 自连）
4. 轮询 `GET /api/servers/:id` 直到 `install_stage=done`
5. agent 起来后 1 分钟内 `GET /api/servers/:id/telemetry` 看到点
6. `POST /api/servers/:id/config` 把间隔改成 10s，观察后续点频率变化
7. `GET /api/public/servers` 看到脱敏卡片（且不含 IP/hostname）
8. 详情页 sparkline 渲染正常
9. 改 `public_display_mode` 切 raw / level / both，刷新公共页验证
10. 拆机：`pkill shepherd-agent`，90s 后公共/admin 页都置离线

### 15.3 出口标准
- 上述 10 步全过
- `go test ./...` 全绿
- Docker Compose 形态可一键起；Caddy + 自签证书可访问
- 至少有一次 GitHub Release，installer 真实从 release 拉 agent 二进制成功
