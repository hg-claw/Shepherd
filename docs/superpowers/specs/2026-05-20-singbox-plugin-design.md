# sing-box 插件 — 设计文档

**状态：** 草案（2026-05-20）
**基线：** v0.4.0（xray 插件已完整落地：多 inbound + 流量监控）
**所属阶段：** Phase 3d（sing-box 插件，18 协议模板，clash-api 流量采样）

---

## §1 范围

### 1.1 交付物

- 新包 `internal/plugins/singbox/`：生命周期（Plugin struct + RegisterRoutes）、Inbound DAO（`singbox_inbounds` 表）、config 渲染器（`RenderServerConfig`）、HTTP CRUD 路由
- 新迁移目录 `internal/plugins/singbox/migrations/`：`0001_singbox_inbounds`、`0002_singbox_binaries`、`0003_singbox_traffic`、`0004_singbox_certificates` 四个 migration 文件（DDL 见 §8）
- ACME 证书管理：`internal/plugins/singbox/certmgr/`，使用 `github.com/go-acme/lego/v4`，服务端申请并存储证书（`singbox_certificates` 表），DNS-01（Cloudflare plugin API token）为主、HTTP-01（Shepherd 服务器 port 80）为备；每日 cron goroutine 续签到期前 30 天的证书；证书文件在 config 推送时写入 host
- 新 agent 采样器 `internal/agent/singboxsampler/`：每 30s 轮询 clash-api `/connections`，按 inbound tag 聚合 delta bytes，通过现有 WS 通道上报
- WS envelope 新类型 `SingboxTrafficBatch`（区别于 `XrayTrafficBatch`，server 端按 envelope 类型分发），结构与 `XrayTrafficBatch` 平行
- Server 端 ingest：`telemetrysvc` 新增 `SingboxTrafficBatch` 分支，写入 singbox 自有三张流量表：`singbox_traffic_raw` / `singbox_traffic_minute` / `singbox_traffic_hour`（由 singbox 插件自己的 migration 创建，schema 与 xray 对应表完全相同）
- Server 端新增 singbox 流量 rollup goroutine（在 `cmd/server/main.go` 中，与现有 xray rollup goroutine 平行启动），负责定期将 `singbox_traffic_raw` 聚合写入 `singbox_traffic_minute` / `singbox_traffic_hour` 并执行保留策略清理
- 二进制管理：从 https://github.com/SagerNet/sing-box releases 下载，安装为 `/usr/local/bin/shepherd-singbox`；systemd unit / launchd plist 命名 `shepherd-singbox`
- 前端 `web/src/pages/admin/plugins/singbox/`：Config / Inbounds / Traffic / Events / Logs 五个 tab，结构与 xray 平行
- `PluginRegistry.ts` 新增 `singbox` 条目

### 1.2 明确不做

- **跨插件拓扑**：sing-box relay 只能指向 sing-box landing；不支持 sing-box relay → xray landing。跨插件路由留待后续 proxycore 抽象。
- **共享 proxycore 抽象**：`internal/plugins/singbox/` 与 `internal/plugins/xray/` 完全平行，不提取公共父包。待两个插件稳定后再做一次性抽象（§10 后续）。
- **ACME EAB（External Account Binding）**：不支持 ZeroSSL 等需要 EAB 的 CA；v1 仅支持 Let's Encrypt。
- **通配符证书**：v1 只支持单域名证书；通配符证书（`*.example.com`）不支持。
- **证书吊销**：仅 best-effort（DELETE 时尝试吊销，失败不阻断删除）；不保证 OCSP 吊销生效。
- **per-user 流量切分**：sing-box clash-api 不提供 per-user 数据，v1 只到 inbound tag 粒度。
- **cross-plugin relay 拓扑**：xray relay → singbox landing 或反向均不支持，v1 明确拒绝。
- **multi-process**：一台 server 仍只跑一个 sing-box 进程，不为每个 inbound 单独起进程。
- **inbound 跨 server 迁移**：删后重建，不提供迁移 API。
- **inbound tag 重命名**：tag 创建后不可改，原因与 xray 一致（流量历史数据断裂）。
- **relay → relay → landing 链路**：明确禁止，每个 relay inbound 必须直接指向一个 landing inbound。

### 1.3 关键约束

- **修改任一 inbound 触发该 server sing-box restart**：约 1s 中断，所有 inbound 短暂断开。
- **clash-api 监听地址**：`127.0.0.1:29090`（区别于 xray 的 28085），由 `validatePostInbound` 明确拒绝用户占用此端口。
- **tag 在 server 内唯一**：`(server_id, tag)` UNIQUE；格式 `{role}-{8hex}`，服务端自动生成。
- **port 在 server 内唯一**：`(server_id, port)` UNIQUE，用户提交 port 冲突返回 409。
- **自引用 FK RESTRICT**：relay inbound 通过 `upstream_inbound_id` 引用 landing inbound，ON DELETE RESTRICT 防止删除有依赖的 landing。
- **二进制路径保留**：`/usr/local/bin/shepherd-singbox` vs `/usr/local/bin/shepherd-xray`，两者可在同机共存。
- **独立流量表**：singbox 插件拥有自己的 `singbox_traffic_raw` / `singbox_traffic_minute` / `singbox_traffic_hour` 三张表，由插件自己的 migration 创建；不依赖 xray 插件已安装。
- **ACME HTTP-01 约束**：HTTP-01 challenge 要求 Shepherd admin host 在申请域名上以 port 80 公网可达；通常是 Shepherd 所在主机对应的域名，不是被管理的 proxy host。
- **ACME DNS-01 约束**：DNS-01 challenge 要求 Cloudflare 插件已启用，且目标域名在该 CF 账号的托管 Zone 内；使用 cloudflare 插件 `config_json` 中存储的 API token。
- **lego 依赖**：`github.com/go-acme/lego/v4` 加入 `go.mod`（约 5MB 增量）。
- **证书 FK**：`singbox_inbounds.cert_id` 引用 `singbox_certificates(id)` ON DELETE RESTRICT，禁止删除被 inbound 引用的证书。

---

## §2 数据模型

### 2.1 新表 `singbox_inbounds`

设计决策：**使用固定列 + `extra_json TEXT` 混合方案**。

所有 18 个协议共享的核心字段以独立列存储（`port`, `role`, `uuid`, `password`, `sni` 等），协议独特的边缘字段（如 Hysteria2 的 `up_mbps`/`down_mbps`、TUIC 的 `congestion_control`、AnyTLS 的 `padding` 等）存入 `extra_json` TEXT 列（JSON 格式）。

理由：

1. 所有 18 个协议都有 `port`、`role`、`protocol`、TLS 相关字段（cert_id / sni），这些放固定列方便 SQL 查询和渲染器直接读取，避免每次都反序列化 JSON。
2. 各协议的差异化字段种类繁多（Hysteria2 限速、TUIC 拥塞控制、VMess alterId 等），若全部列出将产生大量 NULL 列，且协议未来新增字段需要 ALTER TABLE。
3. `extra_json` 包含渲染时需要但不常查询的协议特有配置；渲染器读 JSON blob，无需 SQL 过滤。
4. 与 xray 的策略对齐（xray 也有 `ws_path`、`ss_method` 等专用列 + 大量 NULL），只是 sing-box 协议数量更多、差异更大，因此 extra_json 承担更多。

```sql
-- internal/plugins/singbox/migrations/0001_singbox_inbounds.up.sql

CREATE TABLE IF NOT EXISTS singbox_inbounds (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id            INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag                  TEXT    NOT NULL,         -- 格式：landing-<8hex> 或 relay-<8hex>
  port                 INTEGER NOT NULL,
  role                 TEXT    NOT NULL CHECK (role IN ('landing', 'relay')),
  protocol             TEXT    NOT NULL,
                                                 -- 18 个协议值见 §3

  -- VLESS / VMess 共用
  uuid                 TEXT,                     -- VLESS / VMess UUID
  flow                 TEXT,                     -- VLESS REALITY 需要 "xtls-rprx-vision"；其他 VLESS 空

  -- Trojan / Shadowsocks-2022 / Hysteria2 / TUIC
  password             TEXT,                     -- Trojan 密码 / SS-2022 密码 / Hysteria2 密码 / TUIC 密码

  -- TLS 相关（VLESS+TLS/Trojan/Hysteria2/TUIC/AnyTLS 均用）
  sni                  TEXT,                     -- TLS SNI（landing：server_name；relay：upstream 的 SNI）
  cert_id              INTEGER REFERENCES singbox_certificates(id) ON DELETE RESTRICT,
                                                 -- 引用 singbox_certificates 行；VLESS-REALITY/VMess-TCP/VMess-HTTP/VMess-QUIC/SS-2022 时 NULL
                                                 -- 证书文件路径在渲染时由服务端根据 cert.domain 计算，不存入 DB

  -- REALITY 专用（VLESS-REALITY）
  reality_private_key  TEXT,                     -- REALITY 私钥（landing 有值；relay 存 upstream 公钥，见 render）
  reality_public_key   TEXT,                     -- REALITY 公钥（landing + relay 均需要）
  reality_short_id     TEXT,                     -- REALITY short_id（8 hex）
  reality_handshake_server  TEXT,               -- REALITY 握手目标域名，如 "www.icloud.com"
  reality_handshake_port    INTEGER,             -- REALITY 握手目标端口，通常 443

  -- Transport 相关（WS / H2 / HTTPUpgrade）
  transport_path       TEXT,                     -- WS / H2 / HTTPUpgrade path
  transport_host       TEXT,                     -- WS / HTTP Host 头

  -- VMess 专用
  alter_id             INTEGER DEFAULT 0,        -- VMess alterId（0 表示不使用）

  -- Shadowsocks-2022 专用
  ss_method            TEXT,                     -- 如 "2022-blake3-aes-128-gcm"

  -- relay 拓扑
  upstream_inbound_id  INTEGER REFERENCES singbox_inbounds(id) ON DELETE RESTRICT,
                                                 -- role=relay 时非空；role=landing 时 NULL

  -- 协议特有扩展字段（Hysteria2 up_mbps/down_mbps；TUIC congestion_control；AnyTLS padding 等）
  extra_json           TEXT,                     -- JSON blob，渲染器解析；NULL 表示无扩展字段

  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CHECK (
    (role = 'landing' AND upstream_inbound_id IS NULL) OR
    (role = 'relay'   AND upstream_inbound_id IS NOT NULL)
  ),
  UNIQUE (server_id, tag),
  UNIQUE (server_id, port)
);

CREATE INDEX IF NOT EXISTS singbox_inbounds_server
    ON singbox_inbounds(server_id);
CREATE INDEX IF NOT EXISTS singbox_inbounds_upstream
    ON singbox_inbounds(upstream_inbound_id);
```

**字段说明：**

- `tag`：服务端在 `INSERT` 时自动生成，格式 `landing-a1b2c3d4` 或 `relay-e5f6a7b8`，永不改变。
- `reality_private_key`：仅存于 DB，GET API 返回 `[REDACTED]`。渲染时服务端直接注入 config。
- `cert_id`：引用 `singbox_certificates(id)`；渲染时服务端查找对应证书域名，推算出确定性路径 `<config_dir>/certs/<domain>.crt` 和 `.key`，在推送 config 之前将证书文件写入 host。不使用 ACME 证书的协议（VLESS-REALITY、VMess-TCP、VMess-HTTP、VMess-QUIC、SS-2022）此列为 NULL。
- 证书文件路径（`certificate_path` / `key_path` in sing-box JSON）：不存入 DB；渲染时由服务端根据 `cert_id` 查到 `singbox_certificates.domain`，用 `CertFilePath(configDir, domain)` 计算得出。
- `extra_json`：存储协议扩展字段，格式由各协议渲染函数定义（见 §3 各子节）。不向前端暴露原始 blob；前端通过协议专属表单字段提交，服务端序列化存入 extra_json。
- `upstream_inbound_id`：自引用本表 `id`，ON DELETE RESTRICT 保证 landing 被删除前必须先清空依赖 relay。

### 2.2 `plugin_hosts` 用法（plugin_id = 'singbox'）

与 xray 完全一致：一台 server 最多一行 `plugin_hosts`（plugin_id='singbox'）。含义：

| 字段 | 语义 |
|---|---|
| `config_json` | 不使用（设为 `{}`），config 在 push 时实时组装 |
| `deployed_version` | sing-box binary 版本（server 级） |
| `status` | sing-box 进程状态：`not_deployed` / `running` / `stopped` / `failed` |
| `last_error` | 最近 deploy 失败信息 |

第一个 inbound 成功部署时创建该行；最后一个 inbound 被删除时 status 改为 `stopped`（行不删除）；下次新建 inbound 时服务端检测到 status=stopped，直接重渲染 + restart（不重新 fetch binary）。

### 2.3 独立流量表

singbox 插件拥有自己的三张流量表，schema 与 xray 对应表完全相同，仅表名前缀不同。表由 singbox 插件的 `0003_singbox_traffic` migration 创建，不依赖 xray 插件已安装。

```sql
-- internal/plugins/singbox/migrations/0003_singbox_traffic.up.sql

CREATE TABLE IF NOT EXISTS singbox_traffic_raw (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag         TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('landing', 'relay')),
  ts          TIMESTAMP NOT NULL,
  bytes_up    INTEGER NOT NULL DEFAULT 0,
  bytes_down  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS singbox_traffic_raw_server_tag_ts
    ON singbox_traffic_raw(server_id, tag, ts);

-- 保留策略：raw 保留 7 天
-- rollup goroutine 每分钟运行一次，清理 ts < now()-7d 的行

CREATE TABLE IF NOT EXISTS singbox_traffic_minute (
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag         TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  ts          TIMESTAMP NOT NULL,  -- 分钟级 truncate
  bytes_up    INTEGER NOT NULL DEFAULT 0,
  bytes_down  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, tag, ts)
);
CREATE INDEX IF NOT EXISTS singbox_traffic_minute_server_tag_ts
    ON singbox_traffic_minute(server_id, tag, ts);

-- 保留策略：minute 保留 30 天

CREATE TABLE IF NOT EXISTS singbox_traffic_hour (
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag         TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  ts          TIMESTAMP NOT NULL,  -- 小时级 truncate
  bytes_up    INTEGER NOT NULL DEFAULT 0,
  bytes_down  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, tag, ts)
);
CREATE INDEX IF NOT EXISTS singbox_traffic_hour_server_tag_ts
    ON singbox_traffic_hour(server_id, tag, ts);

-- 保留策略：hour 保留 365 天
```

对应 down migration `0003_singbox_traffic.down.sql`：

```sql
DROP TABLE IF EXISTS singbox_traffic_hour;
DROP TABLE IF EXISTS singbox_traffic_minute;
DROP TABLE IF EXISTS singbox_traffic_raw;
```

查询 singbox 流量直接读 `singbox_traffic_*` 表，无需 JOIN `plugin_hosts`：

```sql
SELECT ts, SUM(bytes_up) AS bytes_up, SUM(bytes_down) AS bytes_down
FROM singbox_traffic_minute
WHERE server_id = ?
  AND tag = 'landing-aabbccdd'
  AND ts BETWEEN ? AND ?
GROUP BY ts
ORDER BY ts;
```

### 2.4 `singbox_certificates` 表

存储服务端申请的 ACME 证书（PEM 明文，与 xray REALITY 私钥处理方式一致）。

```sql
-- internal/plugins/singbox/migrations/0004_singbox_certificates.up.sql

CREATE TABLE IF NOT EXISTS singbox_certificates (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  domain                TEXT    NOT NULL UNIQUE,
  cert_pem              TEXT    NOT NULL,          -- 完整证书链 PEM
  key_pem               TEXT    NOT NULL,          -- 私钥 PEM（明文存储）
  expires_at            TIMESTAMP NOT NULL,
  issuer                TEXT    NOT NULL DEFAULT 'Let''s Encrypt',
  status                TEXT    NOT NULL DEFAULT 'issuing'
                                  CHECK (status IN ('issuing', 'active', 'failed', 'revoked')),
  last_renew_attempt_at TIMESTAMP,
  last_error            TEXT,
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

对应 down migration `0004_singbox_certificates.down.sql`：

```sql
DROP TABLE IF EXISTS singbox_certificates;
```

**字段说明：**

- `domain`：单域名，UNIQUE 约束；v1 不支持通配符证书。
- `cert_pem`：完整证书链（leaf + intermediate），PEM 格式，直接写入 host 文件系统。
- `key_pem`：私钥 PEM，明文存储（与 xray REALITY 私钥存储策略一致；encrypted-at-rest 为 future work）。
- `status`：`issuing`（申请中）、`active`（有效）、`failed`（申请/续签失败，见 `last_error`）、`revoked`（已吊销 / 删除流程中）。
- `last_renew_attempt_at`：最近一次续签尝试时间（含失败）；初次申请时为 NULL。
- `expires_at`：从 ACME 响应解析；cron goroutine 以此判断是否需要续签（`expires_at - now() < 30d` → 触发续签）。

---

## §3 协议目录

所有 18 个协议均对应 `singbox_inbounds.protocol` 列的一个值，以下各子节给出：

1. DB 字段映射（哪些列有值，哪些在 `extra_json` 中）
2. sing-box inbound JSON 完整示例（landing 视角，含所有必要字段）
3. relay 视角的 outbound JSON（relay inbound 如何连接 upstream）
4. 特殊注意事项

**ACME 证书需求分类：**

| 是否需要 cert_id | 协议 |
|---|---|
| **不需要**（`cert_id = NULL`） | `vless-reality`、`vmess-tcp`、`vmess-http`、`vmess-quic`、`shadowsocks-2022` |
| **需要**（`cert_id` 指向 `singbox_certificates` 行） | `vless-ws-tls`、`vless-h2-tls`、`vless-httpupgrade-tls`、`vmess-ws-tls`、`vmess-h2-tls`、`vmess-httpupgrade-tls`、`trojan-tls`、`trojan-ws-tls`、`trojan-h2-tls`、`trojan-httpupgrade-tls`、`hysteria2`、`tuic-v5`、`anytls` |

TLS 需要证书的 inbound 在创建时必须在 `singbox_certificates` 中已有 `status='active'` 的证书行（cert_id 非空）；渲染时服务端将证书文件写入 host 路径 `/etc/shepherd-singbox/certs/<domain>.crt` 和 `/etc/shepherd-singbox/certs/<domain>.key`，并在 inbound JSON 中引用这些路径。

协议值命名约定（`protocol` 列枚举）：

```
vless-reality
vless-ws-tls
vless-h2-tls
vless-httpupgrade-tls
vmess-tcp
vmess-http
vmess-quic
vmess-ws-tls
vmess-h2-tls
vmess-httpupgrade-tls
trojan-tls
trojan-ws-tls
trojan-h2-tls
trojan-httpupgrade-tls
hysteria2
tuic-v5
anytls
shadowsocks-2022
```

---

### §3.1 VLESS-REALITY

**协议值**：`vless-reality`

**DB 字段映射：**

| 列 | 说明 |
|---|---|
| `uuid` | VLESS 用户 UUID |
| `flow` | `"xtls-rprx-vision"`（固定；Vision 是 REALITY 的默认 flow） |
| `reality_private_key` | REALITY 私钥（landing 独有，relay 时留空） |
| `reality_public_key` | REALITY 公钥（landing 和 relay 均需要） |
| `reality_short_id` | 8 hex 字符串 |
| `reality_handshake_server` | 握手目标域名，如 `www.icloud.com` |
| `reality_handshake_port` | 握手目标端口，通常 `443` |
| `sni` | 客户端 server_name，通常 = `reality_handshake_server` |
| `extra_json` | NULL（无扩展字段） |

TLS：REALITY 协议自管理 TLS，不需要 ACME 证书。`cert_id` 为 NULL。

**Landing inbound JSON：**

```json
{
  "type": "vless",
  "tag": "landing-a1b2c3d4",
  "listen": "::",
  "listen_port": 443,
  "users": [
    {
      "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "flow": "xtls-rprx-vision"
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "www.icloud.com",
    "reality": {
      "enabled": true,
      "handshake": {
        "server": "www.icloud.com",
        "server_port": 443
      },
      "private_key": "LANDING_REALITY_PRIVATE_KEY",
      "short_id": ["aabb1122"]
    }
  }
}
```

**Relay outbound JSON（relay 连接 landing）：**

```json
{
  "type": "vless",
  "tag": "to-landing-a1b2c3d4",
  "server": "landing-server.example.com",
  "server_port": 443,
  "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "flow": "xtls-rprx-vision",
  "tls": {
    "enabled": true,
    "server_name": "www.icloud.com",
    "utls": { "enabled": true, "fingerprint": "chrome" },
    "reality": {
      "enabled": true,
      "public_key": "LANDING_REALITY_PUBLIC_KEY",
      "short_id": "aabb1122"
    }
  }
}
```

**注意：** relay 的 inbound 也是 VLESS-REALITY 形状（对客户端侧），relay 有自己的 REALITY 密钥对；relay 的 outbound 是连接 landing 的 VLESS-REALITY 客户端侧配置（使用 landing 的 public_key）。两组密钥对分别独立。

---

### §3.2 VLESS + WS + TLS

**协议值**：`vless-ws-tls`

**DB 字段映射：**

| 列 | 说明 |
|---|---|
| `uuid` | VLESS 用户 UUID |
| `flow` | 空（WS+TLS 模式不使用 Vision flow） |
| `sni` | TLS server_name（通常 = `singbox_certificates.domain`） |
| `cert_id` | 引用 `singbox_certificates(id)`，必填（`status='active'`） |
| `transport_path` | WebSocket path，如 `/vless` |
| `transport_host` | WebSocket Host 头（可选，CDN 场景使用） |
| `extra_json` | NULL |

**Landing inbound JSON：**

```json
{
  "type": "vless",
  "tag": "landing-b2c3d4e5",
  "listen": "::",
  "listen_port": 8443,
  "users": [
    {
      "uuid": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com",
    "certificate_path": "/etc/shepherd-singbox/certs/proxy.example.com.crt",
    "key_path": "/etc/shepherd-singbox/certs/proxy.example.com.key"
  },
  "transport": {
    "type": "ws",
    "path": "/vless",
    "headers": {
      "Host": "proxy.example.com"
    }
  }
}
```

**Relay outbound JSON：**

```json
{
  "type": "vless",
  "tag": "to-landing-b2c3d4e5",
  "server": "landing-server.example.com",
  "server_port": 8443,
  "uuid": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com"
  },
  "transport": {
    "type": "ws",
    "path": "/vless",
    "headers": {
      "Host": "proxy.example.com"
    }
  }
}
```

**注意：** 证书文件路径由服务端根据 `cert_id` → `singbox_certificates.domain` 拼接（`/etc/shepherd-singbox/certs/<domain>.crt` 和 `.key`），在推送 config.json 之前写入 host。relay 连接 landing 时用 TLS 客户端模式（只需 server_name），无需本地证书文件。

---

### §3.3 VLESS + H2 + TLS

**协议值**：`vless-h2-tls`

**DB 字段映射：**

| 列 | 说明 |
|---|---|
| `uuid` | VLESS 用户 UUID |
| `flow` | 空 |
| `sni` | TLS server_name |
| `cert_id` | 引用 `singbox_certificates(id)`，必填 |
| `transport_path` | H2 路径，如 `/vless` |
| `transport_host` | H2 Host 头 |
| `extra_json` | NULL |

**Landing inbound JSON：**

```json
{
  "type": "vless",
  "tag": "landing-c3d4e5f6",
  "listen": "::",
  "listen_port": 8444,
  "users": [
    {
      "uuid": "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com",
    "certificate_path": "/etc/shepherd-singbox/certs/proxy.example.com.crt",
    "key_path": "/etc/shepherd-singbox/certs/proxy.example.com.key"
  },
  "transport": {
    "type": "http",
    "path": "/vless",
    "host": ["proxy.example.com"],
    "method": "PUT"
  }
}
```

**Relay outbound JSON：**

```json
{
  "type": "vless",
  "tag": "to-landing-c3d4e5f6",
  "server": "landing-server.example.com",
  "server_port": 8444,
  "uuid": "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com"
  },
  "transport": {
    "type": "http",
    "path": "/vless",
    "host": ["proxy.example.com"]
  }
}
```

**注意：** sing-box H2 transport 的 `type` 字段为 `"http"`（不是 `"h2"`），`host` 是数组。

---

### §3.4 VLESS + HTTPUpgrade + TLS

**协议值**：`vless-httpupgrade-tls`

**DB 字段映射：** 同 §3.2（WS+TLS），将 `transport_path` 用于 HTTPUpgrade path。

**Landing inbound JSON：**

```json
{
  "type": "vless",
  "tag": "landing-d4e5f6a7",
  "listen": "::",
  "listen_port": 8445,
  "users": [
    {
      "uuid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com",
    "certificate_path": "/etc/shepherd-singbox/certs/proxy.example.com.crt",
    "key_path": "/etc/shepherd-singbox/certs/proxy.example.com.key"
  },
  "transport": {
    "type": "httpupgrade",
    "path": "/vless",
    "host": "proxy.example.com"
  }
}
```

**Relay outbound JSON：**

```json
{
  "type": "vless",
  "tag": "to-landing-d4e5f6a7",
  "server": "landing-server.example.com",
  "server_port": 8445,
  "uuid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com"
  },
  "transport": {
    "type": "httpupgrade",
    "path": "/vless",
    "host": "proxy.example.com"
  }
}
```

**注意：** HTTPUpgrade 与 WS 的区别在于 transport type 字段为 `"httpupgrade"`，兼容 Cloudflare Workers 的 HTTP upgrade 路由。`host` 是字符串（非数组），与 H2 不同。

---

### §3.5 VMess + TCP

**协议值**：`vmess-tcp`

**DB 字段映射：**

| 列 | 说明 |
|---|---|
| `uuid` | VMess 用户 UUID |
| `alter_id` | VMess alterId，通常 `0` |
| `extra_json` | NULL |

无 TLS，无 transport。

**Landing inbound JSON：**

```json
{
  "type": "vmess",
  "tag": "landing-e5f6a7b8",
  "listen": "::",
  "listen_port": 10086,
  "users": [
    {
      "uuid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "alterId": 0
    }
  ]
}
```

**Relay outbound JSON：**

```json
{
  "type": "vmess",
  "tag": "to-landing-e5f6a7b8",
  "server": "landing-server.example.com",
  "server_port": 10086,
  "uuid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  "alter_id": 0,
  "security": "auto"
}
```

**注意：** VMess+TCP 无 TLS，明文传输，适用于内网或已有其他加密层的场景。客户端不需要 TLS 配置。`cert_id` / `sni` 均为 NULL。

---

### §3.6 VMess + HTTP

**协议值**：`vmess-http`

**DB 字段映射：**

| 列 | 说明 |
|---|---|
| `uuid` | VMess 用户 UUID |
| `alter_id` | 通常 `0` |
| `transport_path` | HTTP path，如 `/` |
| `transport_host` | HTTP Host 头 |
| `extra_json` | NULL |

**Landing inbound JSON：**

```json
{
  "type": "vmess",
  "tag": "landing-f6a7b8c9",
  "listen": "::",
  "listen_port": 8080,
  "users": [
    {
      "uuid": "cccccccc-cccc-cccc-cccc-cccccccccccc",
      "alterId": 0
    }
  ],
  "transport": {
    "type": "http",
    "path": "/",
    "host": ["target.example.com"]
  }
}
```

**Relay outbound JSON：**

```json
{
  "type": "vmess",
  "tag": "to-landing-f6a7b8c9",
  "server": "landing-server.example.com",
  "server_port": 8080,
  "uuid": "cccccccc-cccc-cccc-cccc-cccccccccccc",
  "alter_id": 0,
  "security": "auto",
  "transport": {
    "type": "http",
    "path": "/",
    "host": ["target.example.com"]
  }
}
```

**注意：** VMess+HTTP 使用 HTTP/1.1 obfuscation，无 TLS。`cert_id` / `sni` 为 NULL。不同于 §3.3 的 H2，这里是 HTTP/1.1 obfuscation 层，无加密。

---

### §3.7 VMess + QUIC

**协议值**：`vmess-quic`

**DB 字段映射：**

| 列 | 说明 |
|---|---|
| `uuid` | VMess 用户 UUID |
| `alter_id` | 通常 `0` |
| `extra_json` | 可存 `{"quic_security": "none"}` 等 QUIC 扩展参数 |

`extra_json` 结构（可选，NULL 时使用默认值）：
```json
{"quic_security": "none", "key": ""}
```

**Landing inbound JSON：**

```json
{
  "type": "vmess",
  "tag": "landing-a7b8c9d0",
  "listen": "::",
  "listen_port": 10443,
  "users": [
    {
      "uuid": "dddddddd-dddd-dddd-dddd-dddddddddddd",
      "alterId": 0
    }
  ],
  "transport": {
    "type": "quic"
  }
}
```

**Relay outbound JSON：**

```json
{
  "type": "vmess",
  "tag": "to-landing-a7b8c9d0",
  "server": "landing-server.example.com",
  "server_port": 10443,
  "uuid": "dddddddd-dddd-dddd-dddd-dddddddddddd",
  "alter_id": 0,
  "security": "auto",
  "transport": {
    "type": "quic"
  }
}
```

**注意：** QUIC 使用 UDP 协议，防火墙需开放对应 UDP 端口。VMess+QUIC 内置简单 TLS，`cert_id` 为 NULL（QUIC 自管理，无需 ACME 证书）。

---

### §3.8 VMess + WS + TLS

**协议值**：`vmess-ws-tls`

**DB 字段映射：** 与 §3.2（VLESS+WS+TLS）相同，UUID 类型改为 VMess，增加 `alter_id`。

**Landing inbound JSON：**

```json
{
  "type": "vmess",
  "tag": "landing-b8c9d0e1",
  "listen": "::",
  "listen_port": 443,
  "users": [
    {
      "uuid": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      "alterId": 0
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com",
    "certificate_path": "/etc/shepherd-singbox/certs/proxy.example.com.crt",
    "key_path": "/etc/shepherd-singbox/certs/proxy.example.com.key"
  },
  "transport": {
    "type": "ws",
    "path": "/vmess",
    "headers": {
      "Host": "proxy.example.com"
    }
  }
}
```

**Relay outbound JSON：**

```json
{
  "type": "vmess",
  "tag": "to-landing-b8c9d0e1",
  "server": "landing-server.example.com",
  "server_port": 443,
  "uuid": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
  "alter_id": 0,
  "security": "auto",
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com"
  },
  "transport": {
    "type": "ws",
    "path": "/vmess",
    "headers": {
      "Host": "proxy.example.com"
    }
  }
}
```

**注意：** CDN 友好，适合 Cloudflare 等 TLS+WebSocket 穿透场景。证书需要 landing server 上真实的 TLS 证书（或自签名 + 客户端跳过验证，不推荐）。

---

### §3.9 VMess + H2 + TLS

**协议值**：`vmess-h2-tls`

**DB 字段映射：** 与 §3.3（VLESS+H2+TLS）相同，UUID 改为 VMess，增加 `alter_id`。

**Landing inbound JSON：**

```json
{
  "type": "vmess",
  "tag": "landing-c9d0e1f2",
  "listen": "::",
  "listen_port": 8444,
  "users": [
    {
      "uuid": "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "alterId": 0
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com",
    "certificate_path": "/etc/shepherd-singbox/certs/proxy.example.com.crt",
    "key_path": "/etc/shepherd-singbox/certs/proxy.example.com.key"
  },
  "transport": {
    "type": "http",
    "path": "/vmess",
    "host": ["proxy.example.com"]
  }
}
```

**Relay outbound JSON：**

```json
{
  "type": "vmess",
  "tag": "to-landing-c9d0e1f2",
  "server": "landing-server.example.com",
  "server_port": 8444,
  "uuid": "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "alter_id": 0,
  "security": "auto",
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com"
  },
  "transport": {
    "type": "http",
    "path": "/vmess",
    "host": ["proxy.example.com"]
  }
}
```

---

### §3.10 VMess + HTTPUpgrade + TLS

**协议值**：`vmess-httpupgrade-tls`

**DB 字段映射：** 与 §3.4（VLESS+HTTPUpgrade+TLS）相同，UUID 改为 VMess，增加 `alter_id`。

**Landing inbound JSON：**

```json
{
  "type": "vmess",
  "tag": "landing-d0e1f2a3",
  "listen": "::",
  "listen_port": 8445,
  "users": [
    {
      "uuid": "11111111-1111-1111-1111-111111111111",
      "alterId": 0
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com",
    "certificate_path": "/etc/shepherd-singbox/certs/proxy.example.com.crt",
    "key_path": "/etc/shepherd-singbox/certs/proxy.example.com.key"
  },
  "transport": {
    "type": "httpupgrade",
    "path": "/vmess",
    "host": "proxy.example.com"
  }
}
```

**Relay outbound JSON：**

```json
{
  "type": "vmess",
  "tag": "to-landing-d0e1f2a3",
  "server": "landing-server.example.com",
  "server_port": 8445,
  "uuid": "11111111-1111-1111-1111-111111111111",
  "alter_id": 0,
  "security": "auto",
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com"
  },
  "transport": {
    "type": "httpupgrade",
    "path": "/vmess",
    "host": "proxy.example.com"
  }
}
```

---

### §3.11 Trojan + TLS

**协议值**：`trojan-tls`

**DB 字段映射：**

| 列 | 说明 |
|---|---|
| `password` | Trojan 密码 |
| `sni` | TLS server_name |
| `cert_id` | 引用 `singbox_certificates(id)`，必填 |
| `extra_json` | NULL |

**Landing inbound JSON：**

```json
{
  "type": "trojan",
  "tag": "landing-e1f2a3b4",
  "listen": "::",
  "listen_port": 443,
  "users": [
    {
      "password": "my_trojan_password_here"
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com",
    "certificate_path": "/etc/shepherd-singbox/certs/proxy.example.com.crt",
    "key_path": "/etc/shepherd-singbox/certs/proxy.example.com.key"
  }
}
```

**Relay outbound JSON：**

```json
{
  "type": "trojan",
  "tag": "to-landing-e1f2a3b4",
  "server": "landing-server.example.com",
  "server_port": 443,
  "password": "my_trojan_password_here",
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com"
  }
}
```

**注意：** Trojan 协议要求 TLS，否则 sing-box 启动时会报错。`cert_id` 必须引用 `status='active'` 的证书行；渲染时服务端将 PEM 写入 host，路径为 `/etc/shepherd-singbox/certs/<domain>.crt` 和 `.key`。relay outbound 连接 landing 时用 TLS 客户端模式，可设 `"insecure": false`（推荐，使用 ACME 颁发的受信证书）。

---

### §3.12 Trojan + WS + TLS

**协议值**：`trojan-ws-tls`

**DB 字段映射：** 同 §3.11 加 `transport_path` / `transport_host`。

**Landing inbound JSON：**

```json
{
  "type": "trojan",
  "tag": "landing-f2a3b4c5",
  "listen": "::",
  "listen_port": 443,
  "users": [
    {
      "password": "my_trojan_password_here"
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com",
    "certificate_path": "/etc/shepherd-singbox/certs/proxy.example.com.crt",
    "key_path": "/etc/shepherd-singbox/certs/proxy.example.com.key"
  },
  "transport": {
    "type": "ws",
    "path": "/trojan",
    "headers": {
      "Host": "proxy.example.com"
    }
  }
}
```

**Relay outbound JSON：**

```json
{
  "type": "trojan",
  "tag": "to-landing-f2a3b4c5",
  "server": "landing-server.example.com",
  "server_port": 443,
  "password": "my_trojan_password_here",
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com"
  },
  "transport": {
    "type": "ws",
    "path": "/trojan",
    "headers": {
      "Host": "proxy.example.com"
    }
  }
}
```

---

### §3.13 Trojan + H2 + TLS

**协议值**：`trojan-h2-tls`

**DB 字段映射：** 同 §3.11 加 `transport_path` / `transport_host`。

**Landing inbound JSON：**

```json
{
  "type": "trojan",
  "tag": "landing-a3b4c5d6",
  "listen": "::",
  "listen_port": 8443,
  "users": [
    {
      "password": "my_trojan_password_here"
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com",
    "certificate_path": "/etc/shepherd-singbox/certs/proxy.example.com.crt",
    "key_path": "/etc/shepherd-singbox/certs/proxy.example.com.key"
  },
  "transport": {
    "type": "http",
    "path": "/trojan",
    "host": ["proxy.example.com"]
  }
}
```

**Relay outbound JSON：**

```json
{
  "type": "trojan",
  "tag": "to-landing-a3b4c5d6",
  "server": "landing-server.example.com",
  "server_port": 8443,
  "password": "my_trojan_password_here",
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com"
  },
  "transport": {
    "type": "http",
    "path": "/trojan",
    "host": ["proxy.example.com"]
  }
}
```

---

### §3.14 Trojan + HTTPUpgrade + TLS

**协议值**：`trojan-httpupgrade-tls`

**DB 字段映射：** 同 §3.11 加 `transport_path` / `transport_host`。

**Landing inbound JSON：**

```json
{
  "type": "trojan",
  "tag": "landing-b4c5d6e7",
  "listen": "::",
  "listen_port": 8444,
  "users": [
    {
      "password": "my_trojan_password_here"
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com",
    "certificate_path": "/etc/shepherd-singbox/certs/proxy.example.com.crt",
    "key_path": "/etc/shepherd-singbox/certs/proxy.example.com.key"
  },
  "transport": {
    "type": "httpupgrade",
    "path": "/trojan",
    "host": "proxy.example.com"
  }
}
```

**Relay outbound JSON：**

```json
{
  "type": "trojan",
  "tag": "to-landing-b4c5d6e7",
  "server": "landing-server.example.com",
  "server_port": 8444,
  "password": "my_trojan_password_here",
  "tls": {
    "enabled": true,
    "server_name": "proxy.example.com"
  },
  "transport": {
    "type": "httpupgrade",
    "path": "/trojan",
    "host": "proxy.example.com"
  }
}
```

---

### §3.15 Hysteria2

**协议值**：`hysteria2`

**DB 字段映射：**

| 列 | 说明 |
|---|---|
| `password` | Hysteria2 用户密码 |
| `sni` | TLS server_name |
| `cert_id` | 引用 `singbox_certificates(id)`，必填 |
| `extra_json` | `{"up_mbps": 100, "down_mbps": 200}` 可选限速；NULL 表示不限速 |

`extra_json` 结构：
```json
{
  "up_mbps": 100,
  "down_mbps": 200,
  "obfs": "",
  "obfs_password": ""
}
```
所有字段可选；`up_mbps` / `down_mbps` 为 0 时 sing-box 不限速；`obfs` 非空时启用混淆（`"salamander"` 是唯一支持值）。

**Landing inbound JSON：**

```json
{
  "type": "hysteria2",
  "tag": "landing-c5d6e7f8",
  "listen": "::",
  "listen_port": 36712,
  "up_mbps": 100,
  "down_mbps": 200,
  "users": [
    {
      "password": "hysteria2_user_password"
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "hy2.example.com",
    "certificate_path": "/etc/shepherd-singbox/certs/hy2.example.com.crt",
    "key_path": "/etc/shepherd-singbox/certs/hy2.example.com.key"
  }
}
```

**Relay outbound JSON：**

```json
{
  "type": "hysteria2",
  "tag": "to-landing-c5d6e7f8",
  "server": "landing-server.example.com",
  "server_port": 36712,
  "password": "hysteria2_user_password",
  "up_mbps": 100,
  "down_mbps": 200,
  "tls": {
    "enabled": true,
    "server_name": "hy2.example.com"
  }
}
```

**注意：** Hysteria2 使用 QUIC，监听 UDP 端口。防火墙必须开放对应 UDP 端口。`cert_id` 引用有效证书（`status='active'`），渲染时路径为 `/etc/shepherd-singbox/certs/<domain>.crt` 和 `.key`；ACME 颁发的受信证书无需客户端 `insecure`。此协议是 sing-box 的旗舰协议，在弱网条件下性能优于 TCP-based 协议。`up_mbps` / `down_mbps` 设置限速，0 或不设表示不限速。

---

### §3.16 TUIC v5

**协议值**：`tuic-v5`

**DB 字段映射：**

| 列 | 说明 |
|---|---|
| `uuid` | TUIC 用户 UUID |
| `password` | TUIC 用户密码 |
| `sni` | TLS server_name |
| `cert_id` | 引用 `singbox_certificates(id)`，必填 |
| `extra_json` | `{"congestion_control": "bbr"}` TUIC 拥塞控制算法，可选 `"cubic"` / `"new_reno"` |

`extra_json` 结构：
```json
{
  "congestion_control": "bbr",
  "auth_timeout": "3s",
  "max_udp_relay_packet_size": 1500
}
```
所有字段可选，NULL 时使用 sing-box 默认值（congestion_control 默认 `"cubic"`）。

**Landing inbound JSON：**

```json
{
  "type": "tuic",
  "tag": "landing-d6e7f8a9",
  "listen": "::",
  "listen_port": 36713,
  "users": [
    {
      "uuid": "22222222-2222-2222-2222-222222222222",
      "password": "tuic_user_password"
    }
  ],
  "congestion_control": "bbr",
  "auth_timeout": "3s",
  "tls": {
    "enabled": true,
    "server_name": "tuic.example.com",
    "certificate_path": "/etc/shepherd-singbox/certs/tuic.example.com.crt",
    "key_path": "/etc/shepherd-singbox/certs/tuic.example.com.key",
    "alpn": ["h3"]
  }
}
```

**Relay outbound JSON：**

```json
{
  "type": "tuic",
  "tag": "to-landing-d6e7f8a9",
  "server": "landing-server.example.com",
  "server_port": 36713,
  "uuid": "22222222-2222-2222-2222-222222222222",
  "password": "tuic_user_password",
  "congestion_control": "bbr",
  "tls": {
    "enabled": true,
    "server_name": "tuic.example.com",
    "alpn": ["h3"]
  }
}
```

**注意：** TUIC v5 使用 QUIC，监听 UDP 端口。TLS ALPN 必须包含 `"h3"`（TUIC 协议要求）。TUIC 是 sing-box 特有协议，xray 不支持，因此跨插件 relay 不适用。`congestion_control` 建议设为 `"bbr"` 以获得更好的网络利用率。

---

### §3.17 AnyTLS

**协议值**：`anytls`

**DB 字段映射：**

| 列 | 说明 |
|---|---|
| `password` | AnyTLS 用户密码 |
| `sni` | TLS server_name |
| `cert_id` | 引用 `singbox_certificates(id)`，必填 |
| `extra_json` | `{"padding_scheme": ""}` 可选混淆 scheme；NULL 使用 sing-box 默认 |

`extra_json` 结构：
```json
{
  "padding_scheme": "random-padding-256-4096"
}
```
`padding_scheme` 可选，空字符串或 NULL 表示不启用 padding 混淆。

**Landing inbound JSON：**

```json
{
  "type": "anytls",
  "tag": "landing-e7f8a9b0",
  "listen": "::",
  "listen_port": 8443,
  "users": [
    {
      "password": "anytls_user_password"
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "anytls.example.com",
    "certificate_path": "/etc/shepherd-singbox/certs/anytls.example.com.crt",
    "key_path": "/etc/shepherd-singbox/certs/anytls.example.com.key"
  }
}
```

**Relay outbound JSON：**

```json
{
  "type": "anytls",
  "tag": "to-landing-e7f8a9b0",
  "server": "landing-server.example.com",
  "server_port": 8443,
  "password": "anytls_user_password",
  "tls": {
    "enabled": true,
    "server_name": "anytls.example.com"
  }
}
```

**注意：** AnyTLS 是 sing-box 较新的私有协议（1.11+ 支持），基于 TLS 1.3，可选 padding 混淆。xray 不支持此协议。TLS 证书必须有效。`padding_scheme` 建议保持 NULL 除非有特殊混淆需求。

---

### §3.18 Shadowsocks-2022

**协议值**：`shadowsocks-2022`

**DB 字段映射：**

| 列 | 说明 |
|---|---|
| `password` | SS-2022 密钥（Base64，长度由加密方法决定） |
| `ss_method` | 加密方法，如 `"2022-blake3-aes-128-gcm"` / `"2022-blake3-aes-256-gcm"` / `"2022-blake3-chacha20-poly1305"` |
| `extra_json` | NULL |

无 TLS（SS-2022 内置 AEAD 加密）。`sni` / `cert_id` 均为 NULL。

**Landing inbound JSON：**

```json
{
  "type": "shadowsocks",
  "tag": "landing-f8a9b0c1",
  "listen": "::",
  "listen_port": 8388,
  "method": "2022-blake3-aes-128-gcm",
  "password": "base64_encoded_16_byte_key_here="
}
```

**Relay outbound JSON：**

```json
{
  "type": "shadowsocks",
  "tag": "to-landing-f8a9b0c1",
  "server": "landing-server.example.com",
  "server_port": 8388,
  "method": "2022-blake3-aes-128-gcm",
  "password": "base64_encoded_16_byte_key_here="
}
```

**注意：** SS-2022 密钥长度由加密方法决定：
- `2022-blake3-aes-128-gcm`：16 字节 → 24 字符 Base64（含 padding）
- `2022-blake3-aes-256-gcm`：32 字节 → 44 字符 Base64
- `2022-blake3-chacha20-poly1305`：32 字节 → 44 字符 Base64

sing-box 会在启动时验证密钥长度，不符合则 fatal。Shepherd 在 `validatePostInbound` 中应校验 Base64 解码后字节数是否与所选方法匹配。

---

## §4 配置渲染

### 4.1 顶层 JSON 结构

sing-box config 与 xray 结构不同，顶层字段为 `log`、`dns`、`inbounds`、`outbounds`、`route`、`experimental`。

完整顶层结构（含 clash-api block）：

```json
{
  "log": {
    "level": "warn",
    "timestamp": true
  },
  "dns": {
    "servers": [
      {
        "tag": "dns-remote",
        "address": "tls://1.1.1.1",
        "detour": "direct"
      },
      {
        "tag": "dns-local",
        "address": "local",
        "detour": "direct"
      }
    ],
    "rules": [],
    "final": "dns-remote"
  },
  "inbounds": [
    /* 渲染器生成：该 server 所有 singbox_inbounds 行 */
  ],
  "outbounds": [
    /* relay inbound 各自对应的 to-{upstream.tag} outbound */
    {
      "type": "direct",
      "tag": "direct"
    },
    {
      "type": "block",
      "tag": "block"
    }
  ],
  "route": {
    "rules": [
      /* relay inbound → to-{upstream.tag} routing rule */
      /* geoip:private → direct rule（landing 场景） */
    ],
    "final": "direct",
    "auto_detect_interface": true
  },
  "experimental": {
    "clash_api": {
      "external_controller": "127.0.0.1:29090",
      "secret": ""
    }
  }
}
```

**关键差异（vs xray config）：**

| 字段 | xray | sing-box |
|---|---|---|
| log level key | `loglevel` | `level` |
| inbound 类型字段 | `protocol` | `type` |
| TLS 配置位置 | `streamSettings.security` / `realitySettings` | inbound 的 `tls` 子块 |
| Transport 配置位置 | `streamSettings.wsSettings` 等 | inbound 的 `transport` 子块 |
| 路由字段名 | `routing.rules[].inboundTag` | `route.rules[].inbound` |
| 路由字段名 | `routing.rules[].outboundTag` | `route.rules[].outbound` |
| 直连 outbound | `protocol: "freedom"` | `type: "direct"` |
| Stats 注入 | `api` + `stats` + `policy` block | `experimental.clash_api` block |
| Stats 端口 | `127.0.0.1:28085` | `127.0.0.1:29090` |

### 4.2 渲染器函数签名

```go
// internal/plugins/singbox/render.go

// InboundView 是 singbox_inbounds JOIN servers 的视图，
// relay 行额外 JOIN upstream 的字段（upstream_address / upstream_uuid 等）。
type InboundView struct {
    // 来自 singbox_inbounds
    ID                       int64
    ServerID                 int64
    Tag                      string
    Port                     int
    Role                     string  // "landing" | "relay"
    Protocol                 string
    UUID                     sql.NullString
    Flow                     sql.NullString
    Password                 sql.NullString
    SNI                      sql.NullString
    CertID                   sql.NullInt64   // 引用 singbox_certificates(id)；渲染时 JOIN CertView 查 domain
    RealityPrivateKey        sql.NullString  // 渲染用，不通过 API 返回
    RealityPublicKey         sql.NullString
    RealityShortID           sql.NullString
    RealityHandshakeServer   sql.NullString
    RealityHandshakePort     sql.NullInt64
    TransportPath            sql.NullString
    TransportHost            sql.NullString
    AlterID                  sql.NullInt64
    SSMethod                 sql.NullString
    ExtraJSON                sql.NullString  // 原始 JSON blob，渲染器 Unmarshal
    UpstreamInboundID        *int64
    // JOIN 字段（relay 用）
    ServerName               string
    UpstreamTag              sql.NullString
    UpstreamPort             sql.NullInt64
    UpstreamServerID         sql.NullInt64
    UpstreamServerName       sql.NullString
    UpstreamAddress          sql.NullString
    UpstreamProtocol         sql.NullString
    UpstreamUUID             sql.NullString
    UpstreamPassword         sql.NullString
    UpstreamSNI              sql.NullString
    UpstreamRealityPublicKey sql.NullString
    UpstreamRealityShortID   sql.NullString
    UpstreamTransportPath    sql.NullString
    UpstreamTransportHost    sql.NullString
    UpstreamSSMethod         sql.NullString
    UpstreamExtraJSON        sql.NullString
}

// CertView 是 singbox_certificates 的投影，渲染时用于确定路径和提供 PEM 内容。
type CertView struct {
    ID       int64
    Domain   string
    CertPEM  string
    KeyPEM   string
}

// RenderServerConfig 接受该 server 的所有 inbound 行（含 upstream JOIN 字段）
// 以及所有被 inbound 引用的证书行，输出完整 sing-box config JSON。
// 调用者（AssembleAndDeploy 步骤）在推送 config.json 之前还需调用 WriteCertFiles 将证书写入 host。
func RenderServerConfig(inbounds []InboundView, certs []CertView) ([]byte, error)

// CertFilePath 返回域名对应的确定性文件路径（纯函数，无 IO）。
// crt: <configDir>/certs/<domain>.crt
// key: <configDir>/certs/<domain>.key
func CertFilePath(configDir, domain string) (crt, key string)
```

### 4.3 渲染器内部逻辑

`RenderServerConfig` 纯函数（无 IO）：

1. 若 `inbounds` 为空，返回 error（不渲染空 config）。
2. 构建 `certsByID map[int64]CertView`（从 `certs` 参数）。
3. 遍历所有 inbounds，按协议调用 `renderInbound(in, certsByID)` → `map[string]any`：
   - 若协议需要证书（`in.CertID != nil`），用 `CertFilePath(configDir, cert.Domain)` 计算路径注入 `certificate_path` / `key_path`。
   - 若协议不需要证书（VLESS-REALITY 等），TLS 块中不含证书路径字段。
4. 追加结果到 `inbounds` 数组。
5. 对每个 `role='relay'` 的 inbound：
   - 调用 `renderRelayOutbound(in)` 生成 `to-{upstream.tag}` outbound
   - 追加路由规则：`{"inbound": ["{in.Tag}"], "outbound": "to-{upstream.tag}"}`
6. 追加 `direct` 和 `block` outbound（固定）。
7. 若有 landing inbound，追加 `geoip:private → block` 规则（防止私网 IP 被代理）。
8. 注入 `route.final = "direct"`、`route.auto_detect_interface = true`。
9. 注入 `experimental.clash_api` block（端口 29090，secret 空字符串）。
10. 注入固定 DNS 配置（两个 server：`tls://1.1.1.1` remote + local）。
11. `json.MarshalIndent(cfg, "", "  ")` 返回。

**AssembleAndDeploy 步骤顺序（有 IO 的调用者）：**

1. 查询该 server 所有 `singbox_inbounds` 行 + JOIN `singbox_certificates`。
2. 调用 `RenderServerConfig(inbounds, certs)` 生成 config JSON。
3. 对每个有 `cert_id` 的 inbound：将 `cert_pem` / `key_pem` 写入 host 的 `/etc/shepherd-singbox/certs/<domain>.crt` 和 `.key`（SSH 推送，与 config.json 同批次）。
4. 将 `config.json` 写入 host `/etc/shepherd-singbox/config.json`。
5. `systemctl restart shepherd-singbox`。

### 4.4 路由规则生成

```go
// route.rules 数组构成（示例：1 landing + 2 relay）：
[
  // relay-1 → upstream-A
  {
    "inbound": ["relay-e5f6a7b8"],
    "outbound": "to-landing-a1b2c3d4"
  },
  // relay-2 → upstream-B
  {
    "inbound": ["relay-f9e8d7c6"],
    "outbound": "to-landing-b2c3d4e5"
  },
  // 私网 IP 不转发（landing 节点防止误转）
  {
    "ip_cidr": ["0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8",
                "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16",
                "fc00::/7", "fe80::/10"],
    "outbound": "block"
  }
]
```

注意：sing-box 路由字段是 `inbound`（数组，对应 tag 列表）和 `outbound`（字符串），与 xray 的 `inboundTag` / `outboundTag` 不同。

### 4.5 完整 config 示例

场景：server-A 有 1 个 landing（VLESS-REALITY, port=443）+ 1 个 relay（Hysteria2, port=36712，upstream 是 server-B 的 VLESS-REALITY landing）。

```json
{
  "log": {
    "level": "warn",
    "timestamp": true
  },
  "dns": {
    "servers": [
      {"tag": "dns-remote", "address": "tls://1.1.1.1", "detour": "direct"},
      {"tag": "dns-local",  "address": "local",          "detour": "direct"}
    ],
    "rules": [],
    "final": "dns-remote"
  },
  "inbounds": [
    {
      "type": "vless",
      "tag": "landing-a1b2c3d4",
      "listen": "::",
      "listen_port": 443,
      "users": [{"uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", "flow": "xtls-rprx-vision"}],
      "tls": {
        "enabled": true,
        "server_name": "www.icloud.com",
        "reality": {
          "enabled": true,
          "handshake": {"server": "www.icloud.com", "server_port": 443},
          "private_key": "SERVER_A_REALITY_PRIVATE_KEY",
          "short_id": ["aabb1122"]
        }
      }
    },
    {
      "type": "hysteria2",
      "tag": "relay-e5f6a7b8",
      "listen": "::",
      "listen_port": 36712,
      "up_mbps": 100,
      "down_mbps": 200,
      "users": [{"password": "relay_hy2_password"}],
      "tls": {
        "enabled": true,
        "server_name": "relay.example.com",
        "certificate_path": "/etc/shepherd-singbox/certs/relay.example.com.crt",
        "key_path": "/etc/shepherd-singbox/certs/relay.example.com.key"
      }
    }
  ],
  "outbounds": [
    {
      "type": "vless",
      "tag": "to-landing-b2c3d4e5",
      "server": "server-b.example.com",
      "server_port": 443,
      "uuid": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
      "flow": "xtls-rprx-vision",
      "tls": {
        "enabled": true,
        "server_name": "www.apple.com",
        "utls": {"enabled": true, "fingerprint": "chrome"},
        "reality": {
          "enabled": true,
          "public_key": "SERVER_B_REALITY_PUBLIC_KEY",
          "short_id": "ccdd3344"
        }
      }
    },
    {"type": "direct", "tag": "direct"},
    {"type": "block",  "tag": "block"}
  ],
  "route": {
    "rules": [
      {
        "inbound": ["relay-e5f6a7b8"],
        "outbound": "to-landing-b2c3d4e5"
      },
      {
        "ip_cidr": [
          "0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8",
          "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16",
          "fc00::/7", "fe80::/10"
        ],
        "outbound": "block"
      }
    ],
    "final": "direct",
    "auto_detect_interface": true
  },
  "experimental": {
    "clash_api": {
      "external_controller": "127.0.0.1:29090",
      "secret": ""
    }
  }
}
```

---

## §5 API 变更

### 5.1 POST `/api/admin/plugins/singbox/inbounds` — 创建 inbound

请求体（所有字段，非必填字段在不相关协议时为 null）：

```json
{
  "server_id": 5,
  "port": 443,
  "role": "landing",
  "protocol": "vless-reality",
  "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "flow": "xtls-rprx-vision",
  "password": null,
  "sni": "www.icloud.com",
  "cert_id": null,
  "reality_private_key": "...",
  "reality_public_key": "...",
  "reality_short_id": "aabb1122",
  "reality_handshake_server": "www.icloud.com",
  "reality_handshake_port": 443,
  "transport_path": null,
  "transport_host": null,
  "alter_id": null,
  "ss_method": null,
  "extra": null,
  "upstream_inbound_id": null
}
```

`extra` 字段：前端提交协议扩展参数（如 Hysteria2 的 `up_mbps`、TUIC 的 `congestion_control`），服务端序列化为 `extra_json` TEXT 存入 DB。

响应（201）：

```json
{
  "id": 7,
  "server_id": 5,
  "server_name": "server-A",
  "tag": "landing-a1b2c3d4",
  "port": 443,
  "role": "landing",
  "protocol": "vless-reality",
  "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "flow": "xtls-rprx-vision",
  "password": null,
  "sni": "www.icloud.com",
  "cert_id": null,
  "reality_private_key": "[REDACTED]",
  "reality_public_key": "...",
  "reality_short_id": "aabb1122",
  "reality_handshake_server": "www.icloud.com",
  "reality_handshake_port": 443,
  "transport_path": null,
  "transport_host": null,
  "alter_id": null,
  "ss_method": null,
  "extra": null,
  "upstream_inbound_id": null,
  "created_at": "2026-05-20T10:00:00Z",
  "updated_at": "2026-05-20T10:00:00Z"
}
```

**服务端校验（顺序）：**

1. `server_id` 非零，且是已 enroll 的 server
2. `port` 在 1–65535 范围内
3. `port == 29090` → 拒绝：409（clash-api 保留端口）
4. `(server_id, port)` 是否与现有 singbox_inbounds 冲突 → 409
5. `role` 必须是 `landing` 或 `relay`
6. `role='relay'` 时 `upstream_inbound_id` 必填
7. `upstream_inbound_id` 指向的 inbound 必须存在且 `role='landing'` → 409（不允许 relay→relay）
8. `role='relay'` 时 `upstream_inbound_id` 不能指向同一 server 上的 relay（防止同机 relay-relay 链）
9. 协议必须是 18 个枚举值之一
10. 协议必填字段校验（如 `vless-reality` 必须有 `uuid` / `reality_private_key` / `reality_public_key` 等）
11. `shadowsocks-2022`：校验密钥长度（Base64 解码后字节数 = 方法要求的字节数）
12. `tag` 由服务端生成（请求体中 `tag` 字段被忽略）

创建成功后立即触发该 `server_id` 的 sing-box config 重渲染 + 推送 + restart（后台 goroutine）。

### 5.2 PATCH `/api/admin/plugins/singbox/inbounds/:id` — 更新 inbound

**可变字段**：`port`, `uuid`, `flow`, `password`, `sni`, `cert_id`, `reality_private_key`, `reality_public_key`, `reality_short_id`, `reality_handshake_server`, `reality_handshake_port`, `transport_path`, `transport_host`, `alter_id`, `ss_method`, `extra`

**不可变字段（请求体中若包含则忽略）**：`server_id`, `tag`, `role`, `upstream_inbound_id`, `protocol`

PATCH 成功后触发重渲染 + 推送 + restart。

### 5.3 DELETE `/api/admin/plugins/singbox/inbounds/:id`

校验：
- 若 `role='landing'` 且有 relay 依赖 → 409：
  ```json
  {"error": "landing inbound landing-a1b2c3d4 has 2 relay(s) depending on it", "relay_inbound_ids": [7, 9]}
  ```
- 否则删除，触发重渲染 + restart
- 若删除后该 server 的 singbox_inbounds 行数为 0：stop sing-box service，`plugin_hosts.status = 'stopped'`

### 5.4 GET `/api/admin/plugins/singbox/inbounds`

```
GET /api/admin/plugins/singbox/inbounds
GET /api/admin/plugins/singbox/inbounds?server_id=5
```

响应（200）：按 `(server_id, id)` 升序排列的 inbound 对象数组，格式同 POST 201 响应。`reality_private_key` 始终返回 `"[REDACTED]"`。relay 行包含 `upstream_tag` / `upstream_server_id` / `upstream_server_name` JOIN 字段。

### 5.5 GET `/api/admin/plugins/singbox/traffic` 和 `/traffic/batch`

与 xray 的流量 API 完全对等，读取 singbox 自有的 `singbox_traffic_minute` / `singbox_traffic_hour` 表（根据时间跨度自动选表，与 xray 逻辑相同）。参数和响应形状与 xray 的 `/traffic` 端点完全一致（见 xray 流量监控 spec §7.1 / §7.4）。

### 5.6a WS Envelope — `SingboxTrafficBatch`

Agent 上报 singbox 流量样本时使用独立的 envelope 类型 `SingboxTrafficBatch`（区别于 xray 的 `XrayTrafficBatch`），服务端 `telemetrysvc` 按 envelope 类型分发：

```go
// agent → server WS message
type SingboxTrafficBatch struct {
    Type      string              `json:"type"`      // "singbox.traffic"
    ServerID  int64               `json:"server_id"`
    Samples   []TrafficSample     `json:"samples"`
    CollectedAt time.Time         `json:"collected_at"`
}

// TrafficSample 结构与 XrayTrafficBatch 中相同
type TrafficSample struct {
    Tag       string  `json:"tag"`
    Kind      string  `json:"kind"`   // "landing" | "relay"
    BytesUp   int64   `json:"bytes_up"`
    BytesDown int64   `json:"bytes_down"`
}
```

服务端收到 `type="singbox.traffic"` 时写入 `singbox_traffic_raw`；收到 `type="xray.traffic"` 时写入 `xray_traffic_raw`。两条分支互不干扰。

### 5.6 PATCH `/api/admin/plugins/singbox/servers/:id` — 更新 binary 版本

```json
{ "version": "1.11.5" }
```

行为与 xray 的 `PATCH /api/admin/plugins/xray/servers/:id` 完全一致：UPSERT plugin_hosts、后台 fetch binary + push + restart。

### 5.7 GET `/api/admin/plugins/singbox/versions`

返回已缓存的 sing-box binary 版本 + GitHub 最新 5 个 release tag，格式同 xray `/versions`。

### 5.8 证书 API

#### POST `/api/admin/plugins/singbox/certificates` — 申请证书

```json
{
  "domain": "proxy.example.com",
  "challenge": "dns-01-cf"
}
```

`challenge` 枚举值：`"dns-01-cf"`（DNS-01 via Cloudflare）或 `"http-01"`（HTTP-01 via Shepherd server port 80）。

响应（202 Accepted）：

```json
{
  "id": 3,
  "domain": "proxy.example.com",
  "status": "issuing",
  "issuer": "Let's Encrypt",
  "expires_at": null,
  "last_error": null,
  "created_at": "2026-05-20T10:00:00Z",
  "updated_at": "2026-05-20T10:00:00Z"
}
```

申请异步执行（`status=issuing`）；`cert_pem` / `key_pem` 不在响应体中暴露。服务端在后台 goroutine 中使用 lego 完成 ACME 流程；完成后 `status` 更新为 `active`；失败则 `status=failed`，`last_error` 记录错误信息。

**服务端校验：**
1. `domain` 必须是合法域名（RFC 1035 格式）
2. `domain` 不能与现有行重复（UNIQUE 约束保证）
3. `challenge="dns-01-cf"` 要求 Cloudflare 插件已配置且 domain 在托管 Zone 内（查 CF API 验证）；不满足 → 400
4. `challenge="http-01"` 无额外 DB 校验，但 Let's Encrypt 会在申请时验证 port 80 可达性

#### GET `/api/admin/plugins/singbox/certificates` — 列出证书

响应（200）：

```json
[
  {
    "id": 3,
    "domain": "proxy.example.com",
    "issuer": "Let's Encrypt",
    "status": "active",
    "expires_at": "2026-08-18T12:00:00Z",
    "last_renew_attempt_at": null,
    "last_error": null,
    "created_at": "2026-05-20T10:00:00Z",
    "updated_at": "2026-05-20T10:00:00Z"
  }
]
```

`cert_pem` / `key_pem` 不在响应体中暴露。

#### DELETE `/api/admin/plugins/singbox/certificates/:id`

校验：若有任何 `singbox_inbounds.cert_id = :id` 的行存在 → 409：
```json
{"error": "certificate is in use by 2 inbound(s)", "inbound_ids": [5, 9]}
```

否则：尝试 best-effort ACME 吊销（失败不阻断），删除 DB 行，响应 204。

#### POST `/api/admin/plugins/singbox/certificates/:id/renew` — 手动触发续签

异步触发续签（与 cron 续签逻辑相同）；立即响应 202：
```json
{"id": 3, "status": "issuing"}
```

### 5.9 端口保留表

| 插件 | 用途 | 地址 | 保留方 |
|---|---|---|---|
| xray | stats API (gRPC) | `127.0.0.1:28085` | `validatePostInbound` 拒绝 port=28085 |
| singbox | clash-api HTTP | `127.0.0.1:29090` | `validatePostInbound` 拒绝 port=29090 |
| singbox ACME | HTTP-01 challenge | Shepherd host `:80` | Shepherd 临时绑定，申请期间独占 |

两个端口均不对外暴露，仅 loopback 访问。

---

## §6 UI 变更

### 6.1 目录结构

```
web/src/pages/admin/plugins/singbox/
  index.tsx              # 插件入口，读取 :tab 路由参数，渲染 tab bar + 对应 tab 组件
  ConfigTab.tsx          # sing-box binary 版本管理（镜像 xray ConfigTab）
  InboundsTab.tsx        # server 分组的 inbound 列表
  InboundDialog.tsx      # 新建 / 编辑 inbound 表单（含证书选择器）
  BulkRelayDialog.tsx    # 批量为 landing-inbound 添加 relay
  CertificatesTab.tsx    # ACME 证书列表 + 申请 / 续签操作
  TrafficTab.tsx         # 流量图（镜像 xray TrafficTab，plugin='singbox'）
  EventsTab.tsx          # WS 实时事件流（镜像 xray EventsTab）
  LogsTab.tsx            # WS 日志 tail（镜像 xray LogsTab）
```

### 6.2 PluginRegistry.ts 新增条目

```ts
singbox: {
  module: () => import('./singbox'),
  tabs: [
    { key: 'config',       label: 'Config' },
    { key: 'inbounds',     label: 'Inbounds' },
    { key: 'certificates', label: 'Certificates' },
    { key: 'traffic',      label: 'Traffic' },
    { key: 'events',       label: 'Events' },
    { key: 'logs',         label: 'Logs' },
  ],
},
```

### 6.3 ConfigTab

与 xray 的 ConfigTab 行为完全一致，差异点：

- 标题：`sing-box Binary`
- 调用 `GET /api/admin/plugins/singbox/versions` 获取已缓存 + 最新版本列表
- 版本更新调用 `PATCH /api/admin/plugins/singbox/servers/:id`

### 6.4 InboundsTab

与 xray 的 InboundsTab 布局一致（按 server 分组，inbound 行级展示），差异点：

| 列 | 说明 |
|---|---|
| Tag | `landing-a1b2c3d4` / `relay-e5f6a7b8`，font-mono |
| Role | landing（灰 pill）/ relay（蓝 pill）+ `→ {upstream_tag} @ {upstream_server_name}` |
| Protocol | 协议名展示，如 `VLESS-REALITY`、`Hysteria2`、`TUIC v5` |
| Port | 数字 |
| Status | 继承自 `plugin_hosts.status` |
| Actions | Copy URL / Edit / Delete |

Server section header：server name + ssh_host + sing-box 版本 + `+ Add inbound` 按钮 + `+ Bulk Relay` 按钮（仅 landing 存在时）。

顶部全局 `+ New inbound` 按钮。

**Copy URL**：根据协议生成对应的 share link（参见下方 §6.4.1）。

#### §6.4.1 Share URL 格式

不同协议的 share URL 格式不同：

| 协议 | URL 格式 |
|---|---|
| VLESS-REALITY | `vless://{uuid}@{host}:{port}?flow=xtls-rprx-vision&security=reality&...` |
| VLESS+WS+TLS | `vless://{uuid}@{host}:{port}?security=tls&type=ws&path={path}&...` |
| VMess 系列 | VMess Base64 JSON 格式 |
| Trojan 系列 | `trojan://{password}@{host}:{port}?...` |
| Hysteria2 | `hysteria2://{password}@{host}:{port}?...` |
| TUIC v5 | `tuic://{uuid}:{password}@{host}:{port}?...` |
| AnyTLS | `anytls://{password}@{host}:{port}?...` |
| SS-2022 | `ss://{base64(method:password)}@{host}:{port}` |

前端 `buildShareURL(inbound: SingboxInbound, serverHost: string): string` 函数根据 `inbound.protocol` 分支生成对应格式。

### 6.5 InboundDialog

新建 / 编辑单个 inbound 的对话框，与 xray InboundDialog 逻辑相同，差异点：

- **Protocol 下拉菜单**：18 个选项（协议名 + 简短描述）
- **表单字段根据协议动态显示**：

| 协议组 | 显示字段 |
|---|---|
| 所有 | Server（新建可选，编辑只读）、Role、Port、Protocol |
| VLESS 系列 | UUID + 随机生成按钮、Flow（REALITY 固定显示 `xtls-rprx-vision`） |
| VMess 系列 | UUID + AlterID（默认 0） |
| Trojan / Hysteria2 / TUIC / AnyTLS / SS-2022 | Password |
| 带 TLS 但非 REALITY | SNI、Cert 下拉（从 `GET /certificates` 拉取 `status='active'` 的证书，按 domain 显示）；若无可用证书，显示提示：「先在 Certificates tab 申请证书」 |
| REALITY | SNI（= Handshake Server）、REALITY Keypair 生成按钮、Short ID、Handshake Server、Handshake Port |
| 带 Transport | Transport Path、Transport Host |
| SS-2022 | SS Method 下拉（3 个选项）、密钥生成按钮 |
| Hysteria2 | up_mbps / down_mbps（扩展字段，通过 `extra` 提交） |
| TUIC v5 | Congestion Control 下拉（bbr / cubic / new_reno） |
| AnyTLS | Padding Scheme（可选输入） |
| role=relay | Upstream landing-inbound 选择器（只显示同插件的 landing） |

**不可变字段（编辑模式）**：role / upstream_inbound_id / server_id / protocol — 全部 disabled + tooltip "不可变，删后重建"。

### 6.6 BulkRelayDialog

入口：InboundsTab landing-inbound 行的 `+ Bulk Relay` 按钮。

与 xray BulkRelayDialog 行为一致，差异点：

- 批量创建时调用 `POST /api/admin/plugins/singbox/inbounds`（带 `upstream_inbound_id`）
- 选择的协议列表仅列出 singbox 支持的协议（18 个）
- Upstream 必须是 singbox landing-inbound（不跨插件）

### 6.7 CertificatesTab

入口：tab bar `Certificates`（位于 Inbounds 之后、Traffic 之前）。

**列表视图：**

| 列 | 说明 |
|---|---|
| Domain | 域名，font-mono |
| Issuer | `Let's Encrypt` |
| Status | pill：`issuing`（灰）、`active`（绿）、`failed`（红）、`revoked`（灰） |
| Expires | `expires_at` 格式化显示；到期前 > 30 天 → 绿色，7–30 天 → 黄色，< 7 天 → 红色；`status=issuing` 时显示 `—` |
| Actions | Renew 按钮（仅 `status='active'` 时可用）、Delete 按钮（被 inbound 引用时 disabled + tooltip） |

顶部 `+ Issue Certificate` 按钮 → 打开 IssueCertDialog。

**IssueCertDialog：**
- Domain 输入框（必填）
- Challenge 下拉：`DNS-01 (Cloudflare)` / `HTTP-01`
- 提示文案：
  - DNS-01：「需要 Cloudflare 插件已配置，且域名在托管 Zone 内」
  - HTTP-01：「需要 Shepherd 服务器的 port 80 对该域名公网可达」
- 提交 → POST `/api/admin/plugins/singbox/certificates`；申请异步，提交后 dialog 关闭，列表自动刷新（轮询 3s 间隔直到 status 变为 active/failed）

**Renew 行为：** POST `/api/admin/plugins/singbox/certificates/:id/renew` → 状态临时变为 `issuing`，轮询刷新同上。

### 6.8 TrafficTab

与 xray TrafficTab 完全相同，数据来源改为：

- `GET /api/admin/plugins/singbox/traffic/batch?server_id=X&tags=...&from=...&to=...`

组件级别可以直接复用 xray TrafficTab 的实现，只需将 API 路径前缀从 `/api/admin/plugins/xray` 改为 `/api/admin/plugins/singbox`。

### 6.9 EventsTab / LogsTab

与 xray 的 EventsTab / LogsTab 完全一致，只需修改 WS 订阅时发送的 `plugin_id: 'singbox'`。

---

## §7 生命周期 / 依赖

### 7.1 任意 inbound 修改触发 server restart

POST / PATCH / DELETE 任一 inbound → 服务端异步 `AssembleAndDeploy(serverID)` → 重渲染全部该 server 的 inbounds → 推送 config → `systemctl restart shepherd-singbox`（或 launchctl 等效）。

约 1s 中断。v1 不做 batching（BulkRelayDialog 创建 N 个 relay → N 次 restart）。

### 7.2 landing-inbound 删除保护

`DELETE /inbounds/:id`：若该 landing 有依赖 relay → DB FK RESTRICT 兜底（应用层先校验返回 409）。UI 侧 landing-inbound 行的 Delete 按钮：若本地 allInbounds 中存在 `upstream_inbound_id = this.id` 的 relay，则 disabled + tooltip。

### 7.3 tag 稳定性

同 xray 方案：tag 在 inbound 创建时自动生成，永不改变。流量监控以 tag 为 stats 维度，重命名会导致历史数据断裂（与 xray 同逻辑）。

### 7.4 最后一个 inbound 删除后 sing-box 行为

`DELETE` 后 `SELECT COUNT(*) FROM singbox_inbounds WHERE server_id = ?`：
- count > 0：重渲染 + restart
- count = 0：stop sing-box service，`plugin_hosts.status = 'stopped'`，plugin_hosts 行保留

### 7.5 cross-plugin 隔离

`validatePostInbound` 校验：`upstream_inbound_id` 必须指向 `singbox_inbounds` 表中的行，不允许指向 `xray_inbounds`。由于两张表完全独立，DB 层面天然隔离（无 cross-table FK）。应用层通过检查"upstream 是否在本表"来明确拒绝跨插件引用。

### 7.6 binary 与 config 路径

| 项目 | 路径 |
|---|---|
| binary | `/usr/local/bin/shepherd-singbox` |
| config | `/etc/shepherd-singbox/config.json` |
| cert dir | `/etc/shepherd-singbox/certs/` |
| systemd unit | `/etc/systemd/system/shepherd-singbox.service` |
| launchd plist | `/Library/LaunchDaemons/com.shepherd.singbox.plist` |
| unit name (Linux) | `shepherd-singbox` |
| unit name (Darwin) | `com.shepherd.singbox` |

与 xray 的路径（`shepherd-xray`）平行，两者可在同一台 server 上共存（使用不同 port 和不同 binary）。

### 7.7 ACME 证书申请流程

1. 用户 POST `/api/admin/plugins/singbox/certificates`。
2. 服务端创建 `singbox_certificates` 行（`status=issuing`），立即返回 202。
3. 后台 goroutine 使用 lego 初始化 ACME 账号（Let's Encrypt）：
   - `dns-01-cf`：lego 使用 cloudflare 插件的 API token 调 CF API 写 `_acme-challenge.<domain>` TXT 记录，等待 DNS 传播，完成 challenge。
   - `http-01`：lego 临时在 Shepherd 进程中 listen `:80`（或通过 HTTP challenge provider 代理），响应 Let's Encrypt 验证请求。
4. 证书颁发成功：更新 `singbox_certificates`（`status=active`、`cert_pem`、`key_pem`、`expires_at`、`last_renew_attempt_at`）。
5. 证书颁发失败：更新 `status=failed`、`last_error`。

### 7.8 证书续签 Cron

`cmd/server/main.go` 中启动 certRenewLoop goroutine（每 24h 运行一次）：

1. 查询所有 `status='active'` 且 `expires_at - now() < 30d` 的证书行。
2. 对每行：执行与 7.7 步骤 3–4 相同的申请流程（使用相同 challenge 类型；challenge 类型存在 `singbox_certificates` 的 `extra` 字段中，供续签时复用）。
3. 续签成功后：更新 DB 行（`cert_pem`、`key_pem`、`expires_at`、`status=active`）。
4. 触发该证书关联的所有 server（查询 `singbox_inbounds.cert_id = this.id` → 去重 `server_id`）执行 `AssembleAndDeploy`（写最新证书文件到 host + restart sing-box）。
5. 续签失败：更新 `status=failed`、`last_error`；不影响当前已部署的证书文件（host 上文件不变，直到下次成功续签覆盖）。

### 7.9 证书申请失败处理

- `status=failed` 时，证书无法被 inbound 引用（POST inbound 时校验 `status='active'`）。
- 用户可在 CertificatesTab 点击 `Renew` 手动重试（同 §7.8 续签流程）。
- certRenewLoop 每 24h 也会对 `status=failed` 的证书重试（`last_renew_attempt_at < now()-24h`）。

---

## §8 迁移

sing-box 插件在 `internal/plugins/singbox/migrations/` 下独立维护 migration 文件，与 xray 的编号序列完全独立。全部是新表，无旧数据 backfill。

### 8.1 `0001_singbox_inbounds`

文件：`internal/plugins/singbox/migrations/0001_singbox_inbounds.up.sql`

完整 DDL 见 §2.1（`singbox_inbounds` 表及其索引）。

Down migration `0001_singbox_inbounds.down.sql`：

```sql
DROP TABLE IF EXISTS singbox_inbounds;
```

### 8.2 `0002_singbox_binaries`

文件：`internal/plugins/singbox/migrations/0002_singbox_binaries.up.sql`

```sql
CREATE TABLE IF NOT EXISTS singbox_binaries (
  version        TEXT NOT NULL,
  os             TEXT NOT NULL,
  arch           TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  downloaded_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version, os, arch)
);
```

Down migration `0002_singbox_binaries.down.sql`：

```sql
DROP TABLE IF EXISTS singbox_binaries;
```

### 8.3 `0003_singbox_traffic`

文件：`internal/plugins/singbox/migrations/0003_singbox_traffic.up.sql`

完整 DDL 见 §2.3（`singbox_traffic_raw` / `singbox_traffic_minute` / `singbox_traffic_hour` 三张表及其索引）。

Down migration `0003_singbox_traffic.down.sql`：

```sql
DROP TABLE IF EXISTS singbox_traffic_hour;
DROP TABLE IF EXISTS singbox_traffic_minute;
DROP TABLE IF EXISTS singbox_traffic_raw;
```

### 8.4 `0004_singbox_certificates`

文件：`internal/plugins/singbox/migrations/0004_singbox_certificates.up.sql`

完整 DDL 见 §2.4（`singbox_certificates` 表）。注意：`singbox_inbounds.cert_id` FK 在 `0001` 中已通过 `REFERENCES singbox_certificates(id)` 声明——SQLite 的外键延迟检查允许这样写，但实际执行时 `singbox_certificates` 表必须已存在。因此 `0004` 必须在 `0001` 之前或同时运行。**修订**：将 `cert_id` FK 声明移到 `0004` 的 down migration 不影响表结构（SQLite 不支持 ADD CONSTRAINT），up migration 按 0001 → 0004 顺序运行即可（lego 证书表先于 inbound 使用时创建）。

Down migration `0004_singbox_certificates.down.sql`：

```sql
DROP TABLE IF EXISTS singbox_certificates;
```

### 8.5 migration 编号方案与顺序

```
0001_singbox_inbounds.up.sql      → singbox_inbounds 表
0002_singbox_binaries.up.sql      → singbox_binaries 表
0003_singbox_traffic.up.sql       → 3 张流量表
0004_singbox_certificates.up.sql  → singbox_certificates 表
```

运行顺序：1 → 2 → 3 → 4。所有 migration 均为 CREATE TABLE IF NOT EXISTS，幂等。`singbox_inbounds.cert_id` 引用 `singbox_certificates`，SQLite 外键在 migration 完成后（0004 运行后）生效（`PRAGMA foreign_keys = ON`）。

---

## §9 测试矩阵

### 9.1 Go 单测 — 渲染器

`internal/plugins/singbox/render_test.go`：

| 测试 | 场景 | 验证点 |
|---|---|---|
| `TestRenderVLESSReality` | 1 landing（VLESS-REALITY） | `inbounds[0].type=vless`，`tls.reality.enabled=true`，outbounds 只有 direct + block，无 routing relay rule |
| `TestRenderHysteria2Landing` | 1 landing（Hysteria2，cert_id 指向 domain="hy2.example.com"） | `inbounds[0].type=hysteria2`，`tls.certificate_path="/etc/shepherd-singbox/certs/hy2.example.com.crt"` 正确注入 |
| `TestRenderTUICv5Landing` | 1 landing（TUIC v5） | `tls.alpn=["h3"]`，`congestion_control` 从 extra_json 正确读取 |
| `TestRenderShadowsocks2022` | 1 landing（SS-2022） | `type=shadowsocks`，`method=2022-blake3-aes-128-gcm`，无 TLS 块 |
| `TestRenderRelayVLESSReality` | 1 relay（VLESS-REALITY，upstream 是另一 server 的 landing） | outbounds 含 `to-landing-{upstream.tag}`，routing rule `inbound:[relay-tag]→to-landing-tag`，upstream REALITY public_key 注入 |
| `TestRenderRelayHysteria2ToVLESSReality` | 1 relay（Hysteria2）→ landing（VLESS-REALITY） | inbound 是 hy2 类型；outbound 是 vless+reality 客户端配置 |
| `TestRenderMixed` | 1 landing + 2 relay 各指不同 upstream | 3 个 inbound，2 个 to-* outbound，2 条 inbound routing rule + 私网 block rule |
| `TestRenderEmpty` | 空 inbounds | 返回 error，不返回 JSON |
| `TestClashAPIAlwaysInjected` | 任意 inbound | `experimental.clash_api.external_controller = "127.0.0.1:29090"` 总是存在 |
| `TestAllProtocols` | 18 个协议各 1 个 landing | 所有 18 个协议的 inbound JSON 结构正确（type 字段、users/tls/transport 子块无 nil 崩溃） |

### 9.2 Go 单测 — CRUD API

`internal/plugins/singbox/inbounds_routes_test.go`：

| 测试 | 验证点 |
|---|---|
| `TestPostInbound_PortConflict` | 同 server 已有相同 port → 409 |
| `TestPostInbound_ReservedPort` | port=29090 → 409 |
| `TestPostInbound_RelayToRelay` | upstream_inbound_id 指向 relay → 409 |
| `TestPostInbound_RelayNoUpstream` | role=relay 但 upstream_inbound_id 为空 → 409 |
| `TestPostInbound_InvalidProtocol` | protocol 不在枚举表中 → 409 |
| `TestPostInbound_SS2022KeyLenMismatch` | SS-2022 密钥长度不匹配方法 → 409 |
| `TestPostInbound_TLSNoCert` | TLS 协议（trojan-tls）cert_id 为空 → 409 |
| `TestPostInbound_CertNotActive` | cert_id 指向 status='issuing' 的证书 → 409 |
| `TestDeleteCert_BlockedByInbound` | DELETE /certificates/:id，有 inbound 引用 → 409 |
| `TestDeleteCert_Unblocked` | DELETE /certificates/:id，无 inbound 引用 → 204 |
| `TestPatchInbound_ImmutableFields` | 请求体含 role/protocol/server_id/tag → 返回 200 但字段不变 |
| `TestPatchInbound_PortConflict` | 改 port 到已被占用 → 409 |
| `TestDeleteInbound_BlockedByRelay` | landing 有 relay 依赖 → 409，body 含 relay_inbound_ids |
| `TestDeleteInbound_LastOnServer` | 删除 server 最后一个 inbound → plugin_hosts.status='stopped' |
| `TestGetInbounds_Filter` | `?server_id=5` 只返回 server 5 的行，按 id 升序 |

### 9.3 Go 单测 — ACME certmgr

`internal/plugins/singbox/certmgr/certmgr_test.go`：

| 测试 | 场景 | 验证点 |
|---|---|---|
| `TestIssueCert_DNS01_Success` | fake lego ACME server（lego test mode），DNS-01 challenge mock | `singbox_certificates.status` 变为 `active`，`cert_pem` / `key_pem` / `expires_at` 被填入 |
| `TestIssueCert_HTTP01_Success` | HTTP-01 challenge，httptest server 模拟 Let's Encrypt | 同上 |
| `TestIssueCert_Failure` | ACME server 返回 error | `status=failed`，`last_error` 非空，DB 行保留 |
| `TestRenewCert_TriggersDeploy` | cert `expires_at` = now()+15d，certRenewLoop 运行 | 续签成功；`AssembleAndDeploy` 对引用该 cert 的所有 server 调用一次 |
| `TestRenewCert_SkipsNotExpiring` | cert `expires_at` = now()+60d | `AssembleAndDeploy` 不被调用 |
| `TestCertPushOnRender` | RenderServerConfig 收到 CertView | config JSON 中 `certificate_path` = `/etc/shepherd-singbox/certs/<domain>.crt` |

### 9.4 Go 单测 — singboxsampler

`internal/agent/singboxsampler/sampler_test.go`：

| 测试 | 场景 | 验证点 |
|---|---|---|
| `TestFirstTickNoReport` | 首次 tick，无 prev | Send 不被调用 |
| `TestSecondTickDelta` | 第二次 tick，connections 有数据 | Send 被调用，envelope type = `"singbox.traffic"`（`SingboxTrafficBatch`），per-tag delta 正确 |
| `TestNoConnectionsZeroDelta` | clash-api 返回空连接列表 | Send 仍被调用（上报零值样本，证明 sing-box 在线） |
| `TestSingboxRestart` | 两次 tick 之间 sing-box 重启（连接对象消失，新连接 bytes 较小） | delta 不为负，接受 delta ≥ 0 |
| `TestClashAPIDown` | `/connections` 返回 500 | 跳过此次 tick；prevExists 保持上次状态（不清零） |
| `TestConnectionClosedBetweenPolls` | 某连接在两次 poll 之间关闭 | 丢失该连接的 bytes（已知限制，不报错） |

fake clash-api：测试中启动 `httptest.NewServer`，提供预设的 `/connections` JSON 响应，不依赖真实 sing-box。

`internal/agent/singboxsampler/parse_test.go`：

| 测试 | 验证点 |
|---|---|
| 连接有 inbound 字段 | 正确提取 tag 和 upload/download bytes |
| 连接 inbound 为空 | 跳过（不计入统计） |
| 格式非法的 JSON | 返回 error，不 panic |

### 9.5 手工 smoke 步骤

1. 打开 Certificates tab，点击 `+ Issue Certificate`，输入域名 `proxy.example.com`，选择 `DNS-01 (Cloudflare)`，提交。确认列表出现 `status=issuing` 行；等待约 60s，状态变为 `active`，expires_at 约 90 天后。
2. 在 server-A 上创建 VLESS-REALITY landing inbound（port=443）。确认 InboundsTab 显示 1 行，`plugin_hosts.status=running`，Copy URL 可用，客户端连接成功（REALITY 无需证书）。
3. 在 server-A 上创建 Hysteria2 landing inbound（port=36712），cert 选择步骤 1 申请的证书。确认 server-A section 下显示 2 行；SSH 到 server-A 确认 `/etc/shepherd-singbox/certs/proxy.example.com.crt` 存在；Hysteria2 客户端连接成功（无证书警告）。
4. 尝试 DELETE 步骤 1 的证书 → 因 Hysteria2 inbound 引用被拒绝（409）。
5. 在 server-B 上创建 VLESS-REALITY relay inbound（upstream = server-A 的 VLESS-REALITY landing）。确认 relay 标注正确。客户端通过 relay 出网成功。
6. 尝试 DELETE server-A 的 VLESS-REALITY landing → 因 relay 依赖被拒绝。
7. DELETE server-B relay → 成功；再 DELETE server-A VLESS-REALITY landing → 成功；server-A 仍有 Hysteria2 landing，sing-box 继续运行。
8. DELETE server-A Hysteria2 landing（最后一个）→ 成功；`plugin_hosts.status=stopped`。现在可 DELETE 证书（无 inbound 引用）→ 204。
9. 等待 30s，打开 TrafficTab：确认 `singbox_traffic_minute` 有流量数据（查 DB 直接验证，需先通过客户端发送约 1MB 流量）；确认 `xray_traffic_*` 表无新增 singbox 数据（数据隔离验证）。
10. 验证 clash-api：在 server-A 上运行 `curl http://127.0.0.1:29090/connections`，确认返回连接列表 JSON。
11. 验证 xray 和 singbox 共存：在同一台 server 上同时部署 xray（port=18443）和 singbox（port=8443），确认两个服务均正常运行，binary 路径不冲突，流量分别写入各自的 traffic 表。

---

## §10 已确认的取舍

| 取舍 | 选择 | 理由 |
|---|---|---|
| 代码复用策略 | copy-then-abstract（`internal/plugins/singbox/` 完全平行于 `internal/plugins/xray/`） | 两个插件协议差异巨大（sing-box vs xray config 语法不兼容），过早抽象会引入过度泛型化；待两插件稳定后一次性提取 proxycore |
| 协议覆盖 | 全部 18 个 233boy/sing-box 支持的协议 | 用户预期完整覆盖；协议模板差异大但各自 JSON 结构明确；渲染器按协议分支 |
| 流量数据来源 | clash-api `/connections` polling，30s 间隔，按 inbound tag 聚合 | sing-box 无 per-inbound stats CLI；`/connections` 提供了 per-connection inbound 元数据；`/traffic` SSE 只有全局数据无法按 tag 切分 |
| 关闭连接的 bytes 丢失 | 接受 | 两次 poll 之间关闭的连接其 bytes 不可见（clash-api 限制）；长连接代理场景下影响较小；完整性低于 xray 的 counter 模型 |
| 独立流量表（singbox_traffic_*） | singbox 自有三张表，不复用 `xray_traffic_*` | 用户可能单独安装 singbox 插件而不安装 xray；依赖 xray 表存在会导致插件独立安装失败；独立表也使查询更直接，无需 plugin_hosts JOIN；命名语义清晰 |
| WS envelope 区分（SingboxTrafficBatch vs XrayTrafficBatch） | 独立 envelope 类型 | server 端按 envelope type 分发写入各自表，无需在 ingest 层做 JOIN 推断；新增插件时只需注册新 type，不改现有逻辑 |
| 跨插件拓扑禁止 | v1 不支持 sing-box relay → xray landing | 协议不兼容（sing-box 的 outbound 无法以 xray-compatible 模式连接 xray inbound 的所有协议）；简化 v1 |
| ACME 库选型（lego） | `github.com/go-acme/lego/v4` | 支持 HTTP-01 + DNS-01，provider 接口灵活，Cloudflare provider 已内置；活跃维护；cons：约 5MB 增量依赖 |
| ACME challenge 策略 | DNS-01（CF）为主 + HTTP-01 为备 | DNS-01 不要求 Shepherd 在 proxy host 上 port 80 可达，更通用；HTTP-01 作为不依赖 CF 插件时的退路 |
| ACME 证书存储位置 | Shepherd DB（singbox_certificates 表） | DB 随备份完整保存证书；推送到 host 时按需写文件；对比存 Shepherd 文件系统：DB 更易移植，避免文件权限问题 |
| 证书 PEM 明文存储 | 接受，同 xray REALITY 私钥策略 | v1 无 KMS 集成；encrypted-at-rest 列为 future work |
| cert_id 在 inbound 上（非 domain 文本） | FK 引用 singbox_certificates(id) | RESTRICT FK 防止删除被引用证书；续签后证书自动更新（path 不变），inbound 无需修改 |
| 服务端申请 ACME（非 agent 端） | Shepherd server 持有 ACME 账号 + 证书 | 简化 agent 职责（agent 只需运行 sing-box + 上报流量）；Shepherd 已有 DB + CF API token；agent 无需持久化状态 |
| DB 字段策略 | 固定列 + extra_json 混合 | 18 协议核心字段高度重合（uuid/password/sni/cert/key/transport）放固定列方便渲染和 SQL；差异化边缘字段放 extra_json 避免 ALTER TABLE |

### 后续工作（Future Work）

- **统一流量表（proxycore 提取时）**：当 proxycore 包被提取后，可将 `singbox_traffic_*` 和 `xray_traffic_*` 统一为 `proxy_traffic_*` 并增加 `plugin_id TEXT NOT NULL` 列；届时一次性 migration；不在 v1 做，避免中间态复杂度。
- **`extra_json` 结构化存储**：当前 extra_json 是 opaque JSON blob；未来可考虑拆出高频查询字段（如 Hysteria2 的 up_mbps/down_mbps）为独立列，或提供 generated column。
- **ACME EAB / ZeroSSL**：支持 External Account Binding，使用 ZeroSSL 等非 Let's Encrypt CA；需要 lego EAB 配置 + UI 入口。
- **通配符证书**：DNS-01 支持 `*.example.com`，但需要 lego 通配符流程 + UI 改动（inbound SNI 需手动匹配通配符域）。
- **证书 encrypted-at-rest**：将 `key_pem` 加密存储（AES-GCM，key 由 Shepherd 启动时 env var 注入）；现阶段与 REALITY 私钥策略一致，均明文。
- **跨插件拓扑**：设计 cross-plugin relay（xray relay → singbox landing 或反向）；需要统一的 outbound 模板库，使两个插件能生成对方格式的 outbound JSON。
- **共享 proxycore 抽象**：待 sing-box 和 xray 插件均稳定后，提取 `internal/plugins/proxycore/` 包，包含 InboundStore 接口、AssembleAndDeploy 通用逻辑、traffic 表操作等；消除两个插件的代码重复。
- **Hysteria2 / TUIC 专属流量质量指标**：这两个协议运行于 QUIC，可暴露丢包率、RTT 等指标；需要 clash-api 扩展或 sing-box experimental metrics API 支持。
- **sing-box 热重载**：sing-box 1.11+ 支持 `POST /configs` 热加载配置（不重启进程）；修改 inbound 后可改为热加载，减少 1s 中断。目前 AssembleAndDeploy 总是 `systemctl restart`。
- **per-user 流量统计**：sing-box clash-api 的 `/connections` 包含 `metadata.sourceIP`，可按来源 IP 粗粒度统计；更精细的 per-UUID 统计需要 sing-box v2ray-api 模式（待 sing-box 支持）。
