# sing-box 插件 — 设计文档

**状态：** 草案（2026-05-20）
**基线：** v0.4.0（xray 插件已完整落地：多 inbound + 流量监控）
**所属阶段：** Phase 3d（sing-box 插件，18 协议模板，clash-api 流量采样）

---

## §1 范围

### 1.1 交付物

- 新包 `internal/plugins/singbox/`：生命周期（Plugin struct + RegisterRoutes）、Inbound DAO（`singbox_inbounds` 表）、config 渲染器（`RenderServerConfig`）、HTTP CRUD 路由
- 新迁移 `internal/plugins/singbox/migrations/0001_singbox.up.sql`：创建 `singbox_inbounds` 表
- 新 agent 采样器 `internal/agent/singboxsampler/`：每 30s 轮询 clash-api `/connections`，按 inbound tag 聚合 delta bytes，通过现有 WS 通道上报
- WS envelope 新类型 `singbox.traffic`，结构与 `xray.traffic` 平行
- Server 端 ingest：`telemetrysvc` 新增 `singbox.traffic` 分支，写入 **现有** `xray_traffic_raw` / `xray_traffic_minute` / `xray_traffic_hour` 三张表（区分依据：`server_id` JOIN `plugin_hosts.plugin_id='singbox'`）
- 二进制管理：从 https://github.com/SagerNet/sing-box releases 下载，安装为 `/usr/local/bin/shepherd-singbox`；systemd unit / launchd plist 命名 `shepherd-singbox`
- 前端 `web/src/pages/admin/plugins/singbox/`：Config / Inbounds / Traffic / Events / Logs 五个 tab，结构与 xray 平行
- `PluginRegistry.ts` 新增 `singbox` 条目

### 1.2 明确不做

- **跨插件拓扑**：sing-box relay 只能指向 sing-box landing；不支持 sing-box relay → xray landing。跨插件路由留待后续 proxycore 抽象。
- **共享 proxycore 抽象**：`internal/plugins/singbox/` 与 `internal/plugins/xray/` 完全平行，不提取公共父包。待两个插件稳定后再做一次性抽象（§10 后续）。
- **ACME 自动证书**：v1 只支持用户上传证书路径（`cert_path` / `key_path`）或自签名测试证书。真正的 ACME 自动续签列入 §10 后续。
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
- **流量表复用**：v1 沿用 `xray_traffic_*` 三张表，不新建 `singbox_traffic_*`；sing-box 样本通过 `server_id → plugin_hosts.plugin_id` JOIN 区分（§3 详述）。

---

## §2 数据模型

### 2.1 新表 `singbox_inbounds`

设计决策：**使用固定列 + `extra_json TEXT` 混合方案**。

所有 18 个协议共享的核心字段以独立列存储（`port`, `role`, `uuid`, `password`, `sni` 等），协议独特的边缘字段（如 Hysteria2 的 `up_mbps`/`down_mbps`、TUIC 的 `congestion_control`、AnyTLS 的 `padding` 等）存入 `extra_json` TEXT 列（JSON 格式）。

理由：

1. 所有 18 个协议都有 `port`、`role`、`protocol`、TLS 相关字段（cert_path / key_path / sni），这些放固定列方便 SQL 查询和渲染器直接读取，避免每次都反序列化 JSON。
2. 各协议的差异化字段种类繁多（Hysteria2 限速、TUIC 拥塞控制、VMess alterId 等），若全部列出将产生大量 NULL 列，且协议未来新增字段需要 ALTER TABLE。
3. `extra_json` 包含渲染时需要但不常查询的协议特有配置；渲染器读 JSON blob，无需 SQL 过滤。
4. 与 xray 的策略对齐（xray 也有 `ws_path`、`ss_method` 等专用列 + 大量 NULL），只是 sing-box 协议数量更多、差异更大，因此 extra_json 承担更多。

```sql
-- internal/plugins/singbox/migrations/0001_singbox.up.sql

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
  cert_path            TEXT,                     -- TLS 证书路径（landing 用；relay 指向 upstream，无需本地 cert）
  key_path             TEXT,                     -- TLS 私钥路径（同上）

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
- `cert_path` / `key_path`：存远端服务器上的文件路径（用户在部署节点预先放好，或 Shepherd 推送）。v1 接受用户提供的路径，不自动申请证书。
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

### 2.3 流量表复用决策

v1 沿用 `xray_traffic_raw` / `xray_traffic_minute` / `xray_traffic_hour` 三张表（§10 列出重命名为 `proxy_traffic_*` 的计划）。

sing-box 样本写入相同三张表，`server_id` 字段值为 sing-box server 的 ID。区分来源的方式：

```sql
-- 查询属于 singbox 插件的流量数据
SELECT r.*
FROM xray_traffic_raw r
JOIN plugin_hosts ph ON ph.server_id = r.server_id
WHERE ph.plugin_id = 'singbox'
  AND r.tag = 'landing-aabbccdd'
  AND r.ts BETWEEN ? AND ?;
```

因为 Shepherd 保证同一台 server 只启用一个代理插件（xray 或 singbox，不共存），所以同一 `server_id` 的流量行必然属于同一插件，通过 JOIN 查询是明确的。

**已知缺陷**：`xray_traffic_*` 表名对 singbox 数据而言语义误导。v1 接受此命名，不做 migration；§10 列为后续工作（rename + 加 `plugin_id` 列）。

---

## §3 协议目录

所有 18 个协议均对应 `singbox_inbounds.protocol` 列的一个值，以下各子节给出：

1. DB 字段映射（哪些列有值，哪些在 `extra_json` 中）
2. sing-box inbound JSON 完整示例（landing 视角，含所有必要字段）
3. relay 视角的 outbound JSON（relay inbound 如何连接 upstream）
4. 特殊注意事项

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

TLS：不需要用户提供证书，REALITY 协议自管理 TLS。`cert_path` / `key_path` 留空。

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
| `sni` | TLS server_name |
| `cert_path` | TLS 证书路径（landing 用） |
| `key_path` | TLS 私钥路径（landing 用） |
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
    "certificate_path": "/etc/shepherd-singbox/cert.pem",
    "key_path": "/etc/shepherd-singbox/key.pem"
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

**注意：** `cert_path` / `key_path` 仅 landing 需要；relay 连接 landing 时用 TLS 客户端模式（只需 server_name），无需本地证书。v1 证书由用户提前部署到服务器，或 Shepherd 推送自签名证书。

---

### §3.3 VLESS + H2 + TLS

**协议值**：`vless-h2-tls`

**DB 字段映射：**

| 列 | 说明 |
|---|---|
| `uuid` | VLESS 用户 UUID |
| `flow` | 空 |
| `sni` | TLS server_name |
| `cert_path` | TLS 证书路径 |
| `key_path` | TLS 私钥路径 |
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
    "certificate_path": "/etc/shepherd-singbox/cert.pem",
    "key_path": "/etc/shepherd-singbox/key.pem"
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
    "certificate_path": "/etc/shepherd-singbox/cert.pem",
    "key_path": "/etc/shepherd-singbox/key.pem"
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

**注意：** VMess+TCP 无 TLS，明文传输，适用于内网或已有其他加密层的场景。客户端不需要 TLS 配置。`cert_path` / `key_path` / `sni` 均为 NULL。

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

**注意：** VMess+HTTP 使用 HTTP/1.1 obfuscation，无 TLS。`cert_path` / `key_path` / `sni` 为 NULL。不同于 §3.3 的 H2，这里是 HTTP/1.1 obfuscation 层，无加密。

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

**注意：** QUIC 使用 UDP 协议，防火墙需开放对应 UDP 端口。VMess+QUIC 内置简单 TLS，`cert_path` / `key_path` 为 NULL（QUIC 自管理）。

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
    "certificate_path": "/etc/shepherd-singbox/cert.pem",
    "key_path": "/etc/shepherd-singbox/key.pem"
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
    "certificate_path": "/etc/shepherd-singbox/cert.pem",
    "key_path": "/etc/shepherd-singbox/key.pem"
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
    "certificate_path": "/etc/shepherd-singbox/cert.pem",
    "key_path": "/etc/shepherd-singbox/key.pem"
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
| `cert_path` | TLS 证书路径 |
| `key_path` | TLS 私钥路径 |
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
    "certificate_path": "/etc/shepherd-singbox/cert.pem",
    "key_path": "/etc/shepherd-singbox/key.pem"
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

**注意：** Trojan 协议要求 TLS，否则 sing-box 启动时会报错。v1 必须提供有效的 cert + key。self-signed 证书时客户端需要关闭证书验证或信任该证书；relay outbound 连接 landing 时可设 `"insecure": true`（但不推荐生产使用）。

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
    "certificate_path": "/etc/shepherd-singbox/cert.pem",
    "key_path": "/etc/shepherd-singbox/key.pem"
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
    "certificate_path": "/etc/shepherd-singbox/cert.pem",
    "key_path": "/etc/shepherd-singbox/key.pem"
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
    "certificate_path": "/etc/shepherd-singbox/cert.pem",
    "key_path": "/etc/shepherd-singbox/key.pem"
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
| `cert_path` | TLS 证书路径（landing 用） |
| `key_path` | TLS 私钥路径（landing 用） |
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
    "certificate_path": "/etc/shepherd-singbox/cert.pem",
    "key_path": "/etc/shepherd-singbox/key.pem"
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

**注意：** Hysteria2 使用 QUIC，监听 UDP 端口。防火墙必须开放对应 UDP 端口。TLS 证书必须有效（或使用 `"insecure": true`）。此协议是 sing-box 的旗舰协议，在弱网条件下性能优于 TCP-based 协议。`up_mbps` / `down_mbps` 设置限速，0 或不设表示不限速。

---

### §3.16 TUIC v5

**协议值**：`tuic-v5`

**DB 字段映射：**

| 列 | 说明 |
|---|---|
| `uuid` | TUIC 用户 UUID |
| `password` | TUIC 用户密码 |
| `sni` | TLS server_name |
| `cert_path` | TLS 证书路径（landing 用） |
| `key_path` | TLS 私钥路径（landing 用） |
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
    "certificate_path": "/etc/shepherd-singbox/cert.pem",
    "key_path": "/etc/shepherd-singbox/key.pem",
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
| `cert_path` | TLS 证书路径（landing 用） |
| `key_path` | TLS 私钥路径（landing 用） |
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
    "certificate_path": "/etc/shepherd-singbox/cert.pem",
    "key_path": "/etc/shepherd-singbox/key.pem"
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

无 TLS（SS-2022 内置 AEAD 加密）。`sni` / `cert_path` / `key_path` 均为 NULL。

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
    CertPath                 sql.NullString
    KeyPath                  sql.NullString
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

// RenderServerConfig 接受该 server 的所有 inbound 行（含 upstream JOIN 字段），
// 输出完整 sing-box config JSON。
func RenderServerConfig(inbounds []InboundView) ([]byte, error)
```

### 4.3 渲染器内部逻辑

1. 若 `inbounds` 为空，返回 error（不渲染空 config）。
2. 遍历所有 inbounds，按协议调用 `renderInbound(in)` → `map[string]any`，追加到 `inbounds` 数组。
3. 对每个 `role='relay'` 的 inbound：
   - 调用 `renderRelayOutbound(in)` 生成 `to-{upstream.tag}` outbound
   - 追加路由规则：`{"inbound": ["{in.Tag}"], "outbound": "to-{upstream.tag}"}`
4. 追加 `direct` 和 `block` outbound（固定）。
5. 若有 landing inbound，追加 `geoip:private → block` 规则（防止私网 IP 被代理）。
6. 注入 `route.final = "direct"`、`route.auto_detect_interface = true`。
7. 注入 `experimental.clash_api` block（端口 29090，secret 空字符串）。
8. 注入固定 DNS 配置（两个 server：`tls://1.1.1.1` remote + local）。
9. `json.MarshalIndent(cfg, "", "  ")` 返回。

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
        "certificate_path": "/etc/shepherd-singbox/cert.pem",
        "key_path": "/etc/shepherd-singbox/key.pem"
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
  "cert_path": null,
  "key_path": null,
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
  "cert_path": null,
  "key_path": null,
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

**可变字段**：`port`, `uuid`, `flow`, `password`, `sni`, `cert_path`, `key_path`, `reality_private_key`, `reality_public_key`, `reality_short_id`, `reality_handshake_server`, `reality_handshake_port`, `transport_path`, `transport_host`, `alter_id`, `ss_method`, `extra`

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

与 xray 的流量 API 完全对等，读取相同的 `xray_traffic_*` 表，但通过 `server_id` + `plugin_hosts.plugin_id='singbox'` JOIN 限定范围（服务端校验 server_id 属于 singbox 插件）。

参数和响应形状与 xray 的 `/traffic` 端点完全一致（见 xray 流量监控 spec §7.1 / §7.4）。

### 5.6 PATCH `/api/admin/plugins/singbox/servers/:id` — 更新 binary 版本

```json
{ "version": "1.11.5" }
```

行为与 xray 的 `PATCH /api/admin/plugins/xray/servers/:id` 完全一致：UPSERT plugin_hosts、后台 fetch binary + push + restart。

### 5.7 GET `/api/admin/plugins/singbox/versions`

返回已缓存的 sing-box binary 版本 + GitHub 最新 5 个 release tag，格式同 xray `/versions`。

### 5.8 端口保留表

| 插件 | 用途 | 地址 | 保留方 |
|---|---|---|---|
| xray | stats API (gRPC) | `127.0.0.1:28085` | `validatePostInbound` 拒绝 port=28085 |
| singbox | clash-api HTTP | `127.0.0.1:29090` | `validatePostInbound` 拒绝 port=29090 |

两个端口均不对外暴露，仅 loopback 访问。

---

## §6 UI 变更

### 6.1 目录结构

```
web/src/pages/admin/plugins/singbox/
  index.tsx           # 插件入口，读取 :tab 路由参数，渲染 tab bar + 对应 tab 组件
  ConfigTab.tsx       # sing-box binary 版本管理（镜像 xray ConfigTab）
  InboundsTab.tsx     # server 分组的 inbound 列表
  InboundDialog.tsx   # 新建 / 编辑 inbound 表单
  BulkRelayDialog.tsx # 批量为 landing-inbound 添加 relay
  TrafficTab.tsx      # 流量图（镜像 xray TrafficTab，plugin='singbox'）
  EventsTab.tsx       # WS 实时事件流（镜像 xray EventsTab）
  LogsTab.tsx         # WS 日志 tail（镜像 xray LogsTab）
```

### 6.2 PluginRegistry.ts 新增条目

```ts
singbox: {
  module: () => import('./singbox'),
  tabs: [
    { key: 'config',   label: 'Config' },
    { key: 'inbounds', label: 'Inbounds' },
    { key: 'traffic',  label: 'Traffic' },
    { key: 'events',   label: 'Events' },
    { key: 'logs',     label: 'Logs' },
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
| 带 TLS 但非 REALITY | SNI、Cert Path、Key Path |
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

### 6.7 TrafficTab

与 xray TrafficTab 完全相同，数据来源改为：

- `GET /api/admin/plugins/singbox/traffic/batch?server_id=X&tags=...&from=...&to=...`

组件级别可以直接复用 xray TrafficTab 的实现，只需将 API 路径前缀从 `/api/admin/plugins/xray` 改为 `/api/admin/plugins/singbox`。

### 6.8 EventsTab / LogsTab

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
| cert dir | `/etc/shepherd-singbox/` |
| systemd unit | `/etc/systemd/system/shepherd-singbox.service` |
| launchd plist | `/Library/LaunchDaemons/com.shepherd.singbox.plist` |
| unit name (Linux) | `shepherd-singbox` |
| unit name (Darwin) | `com.shepherd.singbox` |

与 xray 的路径（`shepherd-xray`）平行，两者可在同一台 server 上共存（使用不同 port 和不同 binary）。

---

## §8 迁移

### 8.1 新表 `singbox_inbounds`

文件：`internal/plugins/singbox/migrations/0001_singbox.up.sql`

完整 DDL 见 §2.1。

对应 down migration `0001_singbox.down.sql`：

```sql
DROP TABLE IF EXISTS singbox_inbounds;
```

### 8.2 无数据 backfill

sing-box 是全新插件，无旧数据需要迁移。migration 0001 只建新表，不操作任何已有数据。

### 8.3 binary 缓存表

新建 `singbox_binaries` 表，镜像 xray 的 `xray_binaries`，用于缓存已下载的 sing-box binary 元数据。

```sql
-- 在 0001_singbox.up.sql 中追加

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

### 8.4 流量表无变更

sing-box 的流量样本写入现有 `xray_traffic_raw` / `xray_traffic_minute` / `xray_traffic_hour` 表（§2.3 决策）。不新增流量表，不修改现有 schema。

### 8.5 migration 编号方案

sing-box 在自己的 `internal/plugins/singbox/migrations/` 目录下独立维护 migration 文件，从 `0001_singbox` 开始。与 xray 的 `0001_xray`、`0002_topology` 等编号完全独立（不共享序列）。

---

## §9 测试矩阵

### 9.1 Go 单测 — 渲染器

`internal/plugins/singbox/render_test.go`：

| 测试 | 场景 | 验证点 |
|---|---|---|
| `TestRenderVLESSReality` | 1 landing（VLESS-REALITY） | `inbounds[0].type=vless`，`tls.reality.enabled=true`，outbounds 只有 direct + block，无 routing relay rule |
| `TestRenderHysteria2Landing` | 1 landing（Hysteria2） | `inbounds[0].type=hysteria2`，`tls.enabled=true`，cert_path / key_path 正确注入 |
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
| `TestPatchInbound_ImmutableFields` | 请求体含 role/protocol/server_id/tag → 返回 200 但字段不变 |
| `TestPatchInbound_PortConflict` | 改 port 到已被占用 → 409 |
| `TestDeleteInbound_BlockedByRelay` | landing 有 relay 依赖 → 409，body 含 relay_inbound_ids |
| `TestDeleteInbound_LastOnServer` | 删除 server 最后一个 inbound → plugin_hosts.status='stopped' |
| `TestGetInbounds_Filter` | `?server_id=5` 只返回 server 5 的行，按 id 升序 |

### 9.3 Go 单测 — singboxsampler

`internal/agent/singboxsampler/sampler_test.go`：

| 测试 | 场景 | 验证点 |
|---|---|---|
| `TestFirstTickNoReport` | 首次 tick，无 prev | Send 不被调用 |
| `TestSecondTickDelta` | 第二次 tick，connections 有数据 | Send 被调用，per-tag delta 正确（bytes = 连接 upload+download sum） |
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

### 9.4 手工 smoke 步骤

1. 在 server-A 上创建 VLESS-REALITY landing inbound（port=443）。确认 InboundsTab 显示 1 行，`plugin_hosts.status=running`，Copy URL 可用，客户端连接成功。
2. 在 server-A 上再创建 Hysteria2 landing inbound（port=36712）。确认 server-A section 下显示 2 行，两个端口均可用。
3. 在 server-B 上创建 VLESS-REALITY relay inbound（upstream = server-A 的 VLESS-REALITY landing）。确认 server-B 显示 relay 行，relay 标注正确 upstream。客户端通过 relay 可正常出网。
4. 尝试 DELETE server-A 的 VLESS-REALITY landing → 因 relay 依赖被拒绝（Delete 按钮 disabled）。
5. DELETE server-B relay → 成功；再 DELETE server-A landing → 成功；server-A 仍有 Hysteria2 landing，sing-box 继续运行。
6. DELETE server-A Hysteria2 landing（最后一个）→ 成功；`plugin_hosts.status=stopped`。
7. 等待 30s，打开 TrafficTab：确认有流量数据（需先通过客户端发送约 1MB 流量）。
8. 验证 clash-api：在 server-A 上运行 `curl http://127.0.0.1:29090/connections`，确认返回连接列表 JSON。
9. 验证 xray 和 singbox 共存：在同一台 server 上同时部署 xray（port=18443）和 singbox（port=8443），确认两个服务均正常运行，binary 路径不冲突。

---

## §10 已确认的取舍

| 取舍 | 选择 | 理由 |
|---|---|---|
| 代码复用策略 | copy-then-abstract（`internal/plugins/singbox/` 完全平行于 `internal/plugins/xray/`） | 两个插件协议差异巨大（sing-box vs xray config 语法不兼容），过早抽象会引入过度泛型化；待两插件稳定后一次性提取 proxycore |
| 协议覆盖 | 全部 18 个 233boy/sing-box 支持的协议 | 用户预期完整覆盖；协议模板差异大但各自 JSON 结构明确；渲染器按协议分支 |
| 流量数据来源 | clash-api `/connections` polling，30s 间隔，按 inbound tag 聚合 | sing-box 无 per-inbound stats CLI；`/connections` 提供了 per-connection inbound 元数据；`/traffic` SSE 只有全局数据无法按 tag 切分 |
| 关闭连接的 bytes 丢失 | 接受 | 两次 poll 之间关闭的连接其 bytes 不可见（clash-api 限制）；长连接代理场景下影响较小；完整性低于 xray 的 counter 模型 |
| 流量表复用 `xray_traffic_*` | v1 保留现有表名，通过 server_id → plugin_hosts JOIN 区分插件 | 避免在 v0.4.0 阶段进行 schema migration；命名问题小于 migration 代价 |
| 表名后续重命名 | 列入 §10 后续（`proxy_traffic_*` + `plugin_id` 列） | 一次性 migration 在两个插件流量数据均存在后再做，避免中间态复杂度 |
| 跨插件拓扑禁止 | v1 不支持 sing-box relay → xray landing | 协议不兼容（sing-box 的 outbound 无法以 xray-compatible 模式连接 xray inbound 的所有协议）；简化 v1 |
| ACME 证书 | v1 只支持用户提供 cert+key 路径 | ACME 自动续签需要 DNS-01 / HTTP-01 challenge 集成，引入 Cloudflare 或 Let's Encrypt 依赖；独立 spec |
| DB 字段策略 | 固定列 + extra_json 混合 | 18 协议核心字段高度重合（uuid/password/sni/cert/key/transport）放固定列方便渲染和 SQL；差异化边缘字段放 extra_json 避免 ALTER TABLE |

### 后续工作（Future Work）

- **流量表重命名**：将 `xray_traffic_*` 重命名为 `proxy_traffic_*`，增加 `plugin_id TEXT NOT NULL` 列；迁移文件 `0005_rename_traffic_tables.up.sql`。这是 v0.5.0 的目标 migration。
- **`extra_json` 结构化存储**：当前 extra_json 是 opaque JSON blob；未来可考虑拆出高频查询字段（如 Hysteria2 的 up_mbps/down_mbps）为独立列，或提供 generated column。
- **ACME 自动证书**：集成 Let's Encrypt ACME，对 TLS 相关协议自动申请和续签证书，替代手动 cert_path / key_path 配置。
- **跨插件拓扑**：设计 cross-plugin relay（xray relay → singbox landing 或反向）；需要统一的 outbound 模板库，使两个插件能生成对方格式的 outbound JSON。
- **共享 proxycore 抽象**：待 sing-box 和 xray 插件均稳定后，提取 `internal/plugins/proxycore/` 包，包含 InboundStore 接口、AssembleAndDeploy 通用逻辑、traffic 表操作等；消除两个插件的代码重复。
- **Hysteria2 / TUIC 专属流量质量指标**：这两个协议运行于 QUIC，可暴露丢包率、RTT 等指标；需要 clash-api 扩展或 sing-box experimental metrics API 支持。
- **sing-box 热重载**：sing-box 1.11+ 支持 `POST /configs` 热加载配置（不重启进程）；修改 inbound 后可改为热加载，减少 1s 中断。目前 AssembleAndDeploy 总是 `systemctl restart`。
- **per-user 流量统计**：sing-box clash-api 的 `/connections` 包含 `metadata.sourceIP`，可按来源 IP 粗粒度统计；更精细的 per-UUID 统计需要 sing-box v2ray-api 模式（待 sing-box 支持）。
