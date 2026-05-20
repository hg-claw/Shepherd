# xray 单服务器多 inbound — 设计文档

**状态：** 草案（2026-05-19）
**基线：** v0.3.1（Phase 3b relay/landing topology 已合并落地）
**所属阶段：** Phase 3c-1（xray 插件能力扩展）

---

## §1 范围

### 1.1 交付物

- 新表 `xray_inbounds`：每行代表一个 xray inbound，一台 server 可以有 N 个 inbound
- 新表 `xray_inbound_topology`：inbound 级别的 relay→landing 关系，替代旧的 server 级别 `xray_host_topology`
- `plugin_hosts` 退化为 server 级进程状态行（binary 版本、xray 进程 status、最近 error），不再存 inbound 配置
- 服务端 config 渲染器：接受"该 server 所有 inbound + 各自 topology"，组装完整 xray config JSON 并推送
- 前端重构：`HostsTab` → `InboundsTab`（按 server 分组，每行是 inbound），`DeployDialog` → `InboundDialog`，`BulkRelayDialog` 改为操作 inbound 而非 server
- 数据迁移 `0003_multi_inbound.up.sql`：现存"1 server 1 inbound"平滑映射进新结构
- `GET /api/admin/plugins/xray/inbounds` 等 per-inbound API，废弃旧 `POST /hosts/:server_id` 中"写 inbound 配置"的用途
- 修改任一 inbound → 服务端重新聚合该 server 全部 inbound → 推送 → restart xray

### 1.2 明确不做

- **多进程方案**：一台 server 仍然只跑一个 xray 进程。不为每个 inbound 单独起进程，不做进程级隔离。
- **inbound 间共享 user 凭证**：每个 inbound 有独立的 UUID / REALITY 密钥对，不在同一 server 的不同 inbound 之间复用。
- **inbound 跨 server 迁移**：不提供"把 inbound-A 从 server-X 移到 server-Y"的操作，想换 server 必须删后建。
- **inbound 级路由自定义**：routing rules 由渲染器自动生成（relay inbound → to-{tag} outbound），不开放给用户手动编写 per-inbound routing。
- **inbound tag 重命名**：tag 一旦创建不可改。流量监控（Phase 3c-2）用 tag 作为 stats 维度，重命名会导致历史数据断裂。
- **relay → relay → landing 链路**：明确禁止。每个 relay-inbound 必须直接指向一个 landing-inbound，不允许中继链。
- **landing inbound 密钥旋转后自动重部署 relay**：v1 在 UI 给警告，手动 re-deploy。

### 1.3 关键约束

- **修改任一 inbound 触发该 server 的 xray restart**：增/改/删该 server 上任意 inbound 都会导致完整 config 重渲染并推送 restart，所有该 server 上的 inbound 会短暂中断约 1s。
- **relay-inbound 必须指向具体的 landing-inbound**：不再允许"指向某台 server（让服务端猜 inbound）"，必须明确 `upstream_inbound_id`。
- **一台 server 最多一个 plugin_hosts 行**：plugin_hosts 仍然是 server 级别，不随 inbound 数量增加。
- **tag 在 server 内唯一**：`(server_id, tag)` 有 UNIQUE 约束；tag 格式为 `{role}-{short_uuid}` 由服务端在创建时自动生成，不接受用户输入。
- **port 在 server 内唯一**：`(server_id, port)` 有 UNIQUE 约束；客户端提交的 port 若与同 server 其他 inbound 冲突，返回 409。
- **一台 server 上最后一个 inbound 被删后自动 stop xray service**：service 停止但 plugin_hosts 行保留（状态改为 stopped），下次新建 inbound 时重新 start。

---

## §2 数据模型

### 2.1 新表 `xray_inbounds`

```sql
-- 0003_multi_inbound.up.sql（节选）
CREATE TABLE xray_inbounds (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id            INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag                  TEXT    NOT NULL,   -- 稳定 ID，格式：landing-<8hex> 或 relay-<8hex>
  port                 INTEGER NOT NULL,
  role                 TEXT    NOT NULL CHECK (role IN ('landing', 'relay')),
  protocol             TEXT    NOT NULL DEFAULT 'vless-reality',
                                          -- vless-reality | vmess-ws | shadowsocks
  uuid                 TEXT,              -- vless/vmess 协议必填
  sni                  TEXT,              -- REALITY 协议必填
  public_key           TEXT,              -- REALITY 协议必填
  private_key          TEXT,              -- REALITY 协议必填（仅 landing-inbound 有值；relay-inbound 自身 REALITY 密钥）
  short_id             TEXT,              -- REALITY 协议必填
  ws_path              TEXT,              -- vmess-ws 协议使用
  ss_method            TEXT,              -- shadowsocks 使用
  ss_password          TEXT,              -- shadowsocks 使用
  upstream_inbound_id  INTEGER REFERENCES xray_inbounds(id) ON DELETE RESTRICT,
                                          -- role=relay 时非空；role=landing 时 NULL
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL,
  CHECK (
    (role = 'landing' AND upstream_inbound_id IS NULL) OR
    (role = 'relay'   AND upstream_inbound_id IS NOT NULL)
  ),
  UNIQUE (server_id, tag),
  UNIQUE (server_id, port)
);

CREATE INDEX xray_inbounds_server ON xray_inbounds(server_id);
CREATE INDEX xray_inbounds_upstream ON xray_inbounds(upstream_inbound_id);
```

**字段说明：**

- `tag`：服务端自动生成，不接受客户端写入。格式 `landing-a1b2c3d4` 或 `relay-e5f6a7b8`（role + 8位随机 hex）。全局唯一性通过 `(server_id, tag)` UNIQUE 保证；服务端在插入前检测碰撞并 retry（碰撞概率极低）。
- `upstream_inbound_id`：自引用本表 `id`，RESTRICT 保证删除 landing-inbound 时若有 relay 依赖则阻断。
- `private_key`：仅存于 DB，不通过 GET API 返回给前端（返回 `[REDACTED]`）。渲染 config 时由服务端读取注入。

### 2.2 新表 `xray_inbound_topology`（替代 `xray_host_topology`）

`xray_host_topology` 是 server 级别的拓扑，新模型拓扑粒度降到 inbound 级别，但关系信息已经内嵌到 `xray_inbounds.upstream_inbound_id`，因此不需要单独的 topology 表。

旧 `xray_host_topology` 在本 spec 落地后废弃（见 §7 迁移时机）。

前端 GET `GET /api/admin/plugins/xray/topology` 原端点不再需要，由 `GET /api/admin/plugins/xray/inbounds` 替代（每条 inbound 行包含 `upstream_inbound_id` 和 `upstream_tag`、`upstream_server_name` join 字段）。

### 2.3 `plugin_hosts` 的语义变化

`plugin_hosts` 在本 spec 落地后含义变化：

| 字段 | 旧语义 | 新语义 |
|---|---|---|
| `config` | 存完整渲染好的 xray config JSON | **不再使用**，设为空 `{}` 或 NULL；config 由服务端在推送时实时组装，不持久化 |
| `deployed_version` | inbound 部署时使用的 xray 版本 | server 上 xray binary 版本（不变，仍是 server 级别） |
| `status` | xray inbound 的运行状态 | xray 进程的运行状态（not deployed / running / stopped / failed） |
| `last_error` | 最近部署错误 | 最近 deploy 错误（不变） |

一台 server 仍然只有至多一行 `plugin_hosts`。该行在"该 server 第一个 inbound 被创建并成功部署"时产生，在"最后一个 inbound 被删除"时状态更新为 stopped（行不删除，保留历史信息）。

**不再在 `plugin_hosts` 里存 inbound 参数**。config 字段对外只读（GET 时返回 `{}`），不作为 source of truth。

### 2.4 数据迁移：现存 1 server 1 inbound 映射到新结构

现存数据特征：
- `plugin_hosts`（plugin_id='xray'）每行代表一台 server 上的 xray 部署，`config` 字段是完整 xray config JSON
- `xray_host_topology` 每行是 server 级别的 role（landing/relay）+ upstream_server_id

迁移逻辑（幂等）：对每个现存的 xray plugin_host，从其 `config` JSON 中提取 inbound 参数，插入一行 `xray_inbounds`。

```sql
-- 迁移片段（SQLite 不支持 json_extract 在所有版本，可在 Go migration runner 中执行）
-- 以下用 Go 伪代码描述逻辑，实际在 0003 migration 的 Go 钩子中执行：

-- 1. 读取所有 xray plugin_hosts
SELECT ph.server_id, ph.config, ph.deployed_version,
       ht.role, ht.upstream_server_id
FROM plugin_hosts ph
LEFT JOIN xray_host_topology ht ON ht.server_id = ph.server_id
WHERE ph.plugin_id = 'xray';

-- 2. 对每行：解析 config JSON，提取 inbounds[0] 的字段
--    生成 tag：若 role='landing' 则 'landing-' + random 8hex；若 'relay' 则 'relay-' + random 8hex
--    若 xray_inbounds 中已存在 (server_id, port) 相同的行则跳过（幂等）

-- 3. 对于 relay 行，upstream_inbound_id 暂为 NULL；在所有行插入完成后，
--    根据旧 xray_host_topology.upstream_server_id 找到对应 server 的 inbound，
--    再 UPDATE xray_inbounds SET upstream_inbound_id = <landing inbound id>

-- 完整 SQL 示意（在 Go migration runner 中逐行执行）：
INSERT INTO xray_inbounds (
  server_id, tag, port, role, protocol,
  uuid, sni, public_key, private_key, short_id,
  upstream_inbound_id, updated_at
)
SELECT
  ph.server_id,
  CASE ht.role
    WHEN 'landing' THEN 'landing-' || lower(hex(randomblob(4)))
    WHEN 'relay'   THEN 'relay-'   || lower(hex(randomblob(4)))
    ELSE                'landing-' || lower(hex(randomblob(4)))
  END,
  -- port / uuid / sni / public_key / private_key / short_id
  -- 由 Go 代码从 config JSON 解析后拼入；以下为占位示意
  <parsed_port>,
  COALESCE(ht.role, 'landing'),
  'vless-reality',
  <parsed_uuid>,
  <parsed_sni>,
  <parsed_public_key>,
  <parsed_private_key>,
  <parsed_short_id>,
  NULL,   -- relay 的 upstream_inbound_id 在第二步 UPDATE
  CURRENT_TIMESTAMP
WHERE ph.plugin_id = 'xray'
  AND NOT EXISTS (
    SELECT 1 FROM xray_inbounds xi
    WHERE xi.server_id = ph.server_id
      AND xi.port = <parsed_port>
  );

-- 第二步：为 relay 行填 upstream_inbound_id
UPDATE xray_inbounds
SET upstream_inbound_id = (
  SELECT xi2.id
  FROM xray_host_topology ht
  JOIN xray_inbounds xi2 ON xi2.server_id = ht.upstream_server_id
  WHERE ht.server_id = xray_inbounds.server_id
  LIMIT 1
)
WHERE role = 'relay'
  AND upstream_inbound_id IS NULL;
```

迁移完成后，`plugin_hosts.config` 字段清空（设为 `'{}'`），后续不再写入 config。

---

## §3 配置渲染

### 3.1 多-inbound xray config 示例

场景：server-X 同时有 1 个 landing-inbound + 2 个 relay-inbound，relay-1 指向 server-Y 的 landing-inbound-A，relay-2 指向 server-Z 的 landing-inbound-B。

```json
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    {
      "tag": "landing-a1b2c3d4",
      "port": 443,
      "protocol": "vless",
      "settings": {
        "clients": [{ "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", "flow": "xtls-rprx-vision" }],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "dest": "www.lovelive-anime.jp:443",
          "serverNames": ["www.lovelive-anime.jp"],
          "privateKey": "SERVER_X_PRIVATE_KEY",
          "publicKey":  "SERVER_X_PUBLIC_KEY",
          "shortIds":   ["aabb1122"]
        }
      },
      "sniffing": { "enabled": true, "destOverride": ["http", "tls"] }
    },
    {
      "tag": "relay-e5f6a7b8",
      "port": 18443,
      "protocol": "vless",
      "settings": {
        "clients": [{ "id": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy", "flow": "xtls-rprx-vision" }],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "dest": "www.microsoft.com:443",
          "serverNames": ["www.microsoft.com"],
          "privateKey": "RELAY1_PRIVATE_KEY",
          "publicKey":  "RELAY1_PUBLIC_KEY",
          "shortIds":   ["ccdd3344"]
        }
      },
      "sniffing": { "enabled": true, "destOverride": ["http", "tls"] }
    },
    {
      "tag": "relay-f9e8d7c6",
      "port": 28443,
      "protocol": "vless",
      "settings": {
        "clients": [{ "id": "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz", "flow": "xtls-rprx-vision" }],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "dest": "www.apple.com:443",
          "serverNames": ["www.apple.com"],
          "privateKey": "RELAY2_PRIVATE_KEY",
          "publicKey":  "RELAY2_PUBLIC_KEY",
          "shortIds":   ["eeff5566"]
        }
      },
      "sniffing": { "enabled": true, "destOverride": ["http", "tls"] }
    }
  ],
  "outbounds": [
    {
      "tag": "to-landing-inbound-A",
      "protocol": "vless",
      "settings": {
        "vnext": [{
          "address": "server-y.example.com",
          "port": 443,
          "users": [{
            "id": "landing-A-uuid",
            "encryption": "none",
            "flow": "xtls-rprx-vision"
          }]
        }]
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "fingerprint": "chrome",
          "serverName":  "www.lovelive-anime.jp",
          "publicKey":   "SERVER_Y_PUBLIC_KEY",
          "shortId":     "aabb1122"
        }
      }
    },
    {
      "tag": "to-landing-inbound-B",
      "protocol": "vless",
      "settings": {
        "vnext": [{
          "address": "server-z.example.com",
          "port": 443,
          "users": [{
            "id": "landing-B-uuid",
            "encryption": "none",
            "flow": "xtls-rprx-vision"
          }]
        }]
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "fingerprint": "chrome",
          "serverName":  "www.lovelive-anime.jp",
          "publicKey":   "SERVER_Z_PUBLIC_KEY",
          "shortId":     "ccdd3344"
        }
      }
    },
    {
      "tag": "freedom",
      "protocol": "freedom",
      "settings": { "domainStrategy": "UseIP" }
    }
  ],
  "routing": {
    "rules": [
      {
        "type": "field",
        "inboundTag": ["relay-e5f6a7b8"],
        "outboundTag": "to-landing-inbound-A"
      },
      {
        "type": "field",
        "inboundTag": ["relay-f9e8d7c6"],
        "outboundTag": "to-landing-inbound-B"
      },
      {
        "type": "field",
        "ip": ["geoip:private"],
        "outboundTag": "freedom"
      }
    ]
  }
}
```

**规则说明：**

- landing-inbound（`landing-a1b2c3d4`）无需 routing rule：流量命中 `freedom` 默认出网。
- 每个 relay-inbound 有一条 `inboundTag` → `to-landing-*` 的 routing rule，精确绑定，互不干扰。
- `geoip:private` → `freedom`：防止私网 IP 被错误转发给 landing。
- outbound 命名规则：`to-{upstream_inbound.tag}`，与 routing rule 一一对应。

### 3.2 渲染策略

渲染改为**服务端全权负责**（Phase 3b 的"前端渲染、服务端存储"方案在此反转）。

理由：多 inbound 时 config 需要聚合多行数据（包括 upstream inbound 的 address/uuid/publicKey 等），这些字段存在 DB 中，服务端 JOIN 一次比前端多次 API 调用再组装更自然；同时 `private_key` 不暴露给前端。

```go
// internal/plugins/xray/render.go

type InboundRow struct {
    ID                 int64
    ServerID           int64
    Tag                string
    Port               int
    Role               string  // "landing" | "relay"
    Protocol           string
    UUID               string
    SNI                string
    PublicKey          string
    PrivateKey         string  // 仅服务端读取，不通过 API 返回
    ShortID            string
    WSPath             string
    SSMethod           string
    SSPassword         string
    UpstreamInboundID  *int64
    // 以下字段由 JOIN 填充，仅在 role=relay 时有值
    UpstreamTag        string
    UpstreamPort       int
    UpstreamSNI        string
    UpstreamUUID       string
    UpstreamPublicKey  string
    UpstreamShortID    string
    UpstreamAddress    string  // upstream server 的 servers.ssh_host
}

// RenderServerConfig 接受该 server 的所有 inbound 行（含 upstream join 字段），
// 输出完整 xray config JSON。
func RenderServerConfig(inbounds []InboundRow) ([]byte, error)
```

渲染器内部逻辑：

1. 遍历所有 `inbounds`，生成 `inbounds[]` 数组（每行对应一个 xray inbound object）
2. 对每个 `role='relay'` 的 inbound，生成一个 `to-{tag}` outbound（vless → upstream）
3. 若该 server 有 landing-inbound 或 relay-inbound 直接出网需求，添加 `freedom` outbound
4. 生成 `routing.rules`：每个 relay-inbound 一条 `inboundTag → to-{upstream.tag}` rule；最后追加 `geoip:private → freedom` rule
5. 若 `inbounds` 为空，返回 error（不应渲染空配置）

### 3.3 前端 vs 后端职责

| 职责 | 3b 方案 | 3c-1 方案 |
|---|---|---|
| config 渲染 | 前端 `renderTemplate` | **服务端 `RenderServerConfig`** |
| config 持久化 | `plugin_hosts.config` | **不持久化**（每次 deploy 时实时组装） |
| private_key 处理 | 前端生成并提交 | 前端生成并提交（存入 DB）；GET 时不返回，仅在渲染时服务端读取 |
| inbound 参数存储 | `plugin_hosts.config` JSON | **`xray_inbounds` 表字段** |
| share URL 生成 | 前端 `buildShareURL(parseConfig(...))` | 前端从 `GET /inbounds` 返回的字段直接构建，不再需要 parseConfig |

前端不再需要 `parseConfig` / `renderTemplate` 函数（可保留 `buildShareURL`）。前端提交的是结构化字段（port/uuid/sni/…），服务端负责组装 config 并推送。

---

## §4 API 变更

### 4.1 新 endpoint：per-inbound CRUD

**POST `/api/admin/plugins/xray/inbounds`** — 创建新 inbound

请求体：
```json
{
  "server_id": 5,
  "port": 18443,
  "protocol": "vless-reality",
  "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "sni": "www.microsoft.com",
  "public_key": "...",
  "private_key": "...",
  "short_id": "ccdd3344",
  "role": "relay",
  "upstream_inbound_id": 12
}
```

响应（201）：
```json
{
  "id": 7,
  "server_id": 5,
  "tag": "relay-e5f6a7b8",
  "port": 18443,
  "role": "relay",
  "protocol": "vless-reality",
  "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "sni": "www.microsoft.com",
  "public_key": "...",
  "private_key": "[REDACTED]",
  "short_id": "ccdd3344",
  "upstream_inbound_id": 12,
  "upstream_tag": "landing-a1b2c3d4",
  "upstream_server_id": 3,
  "upstream_server_name": "server-Y",
  "created_at": "2026-05-19T12:00:00Z",
  "updated_at": "2026-05-19T12:00:00Z"
}
```

服务端校验（按顺序）：
1. `server_id` 必须是已 enroll 的 server
2. `(server_id, port)` 不能与现有 inbound 冲突 → 409
3. `role='relay'` 时 `upstream_inbound_id` 必填
4. `upstream_inbound_id` 指向的 inbound 必须存在且 `role='landing'` → 否则 409
5. `upstream_inbound_id` 不能等于将创建的 inbound（防自引用；自引用在创建时不存在，但 API 层明确拒绝 server_id 相同 + port 相同的环路）
6. `role='relay'` 时禁止 upstream 与本 inbound 在同一台 server 且 upstream 也是 relay（防止同机 relay-relay 链）
7. tag 由服务端生成，请求体中若带 `tag` 字段则忽略

创建成功后立即触发该 `server_id` 的 xray config 重渲染 + 推送 + restart（见 §4.5）。

---

**PATCH `/api/admin/plugins/xray/inbounds/:id`** — 更新已有 inbound 的可变字段

可变字段：`port`, `uuid`, `sni`, `public_key`, `private_key`, `short_id`, `ws_path`, `ss_method`, `ss_password`

不可变字段（请求体中若包含则忽略）：`server_id`, `tag`, `role`, `upstream_inbound_id`, `protocol`

> `role` 和 `upstream_inbound_id` 不可变：想改 role 必须删后建，同 Phase 3b 的逻辑，理由相同（避免中间态事务复杂度）。

响应（200）：返回完整更新后的 inbound 对象（同 POST 201 格式）。

PATCH 成功后触发该 inbound 所在 server 的重渲染 + 推送 + restart。

---

**DELETE `/api/admin/plugins/xray/inbounds/:id`** — 删除 inbound

校验：
- 若该 inbound 是 landing 且有 relay-inbound 通过 `upstream_inbound_id` 引用它 → 409：
  ```json
  { "error": "landing inbound has 2 relay(s) depending on it", "relay_inbound_ids": [7, 9] }
  ```
- 否则删除该行，触发该 server 重渲染 + 推送 + restart
- 若删除后该 server 上 `xray_inbounds` 行数为 0，则 stop xray service，更新 `plugin_hosts.status = 'stopped'`

### 4.2 既有 `POST /api/admin/plugins/xray/hosts/:server_id` 的处置

**废弃**。该端点在 3b 中承担"deploy inbound 配置 + 写 topology"两个职责。3c-1 后：

- 写 inbound 配置的职责移交给 `POST /inbounds`
- server 级 binary 版本管理（若 3b 尚未独立提取）由 `PATCH /api/admin/plugins/xray/servers/:server_id/version` 承接（见 §5.4）

旧端点返回 `410 Gone` 并在 body 里说明新端点路径，保留至 v0.4.0 删除。

### 4.3 GET `/api/admin/plugins/xray/inbounds`

```
GET /api/admin/plugins/xray/inbounds?server_id=5
GET /api/admin/plugins/xray/inbounds          （返回全部）
```

响应（200）：
```json
[
  {
    "id": 7,
    "server_id": 5,
    "server_name": "server-X",
    "tag": "relay-e5f6a7b8",
    "port": 18443,
    "role": "relay",
    "protocol": "vless-reality",
    "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "sni": "www.microsoft.com",
    "public_key": "...",
    "private_key": "[REDACTED]",
    "short_id": "ccdd3344",
    "upstream_inbound_id": 12,
    "upstream_tag": "landing-a1b2c3d4",
    "upstream_server_id": 3,
    "upstream_server_name": "server-Y",
    "created_at": "2026-05-19T12:00:00Z",
    "updated_at": "2026-05-19T12:00:00Z"
  }
]
```

响应按 `(server_id, id)` 排序，方便前端按 server 分组展示。

### 4.4 旧 topology endpoint 的变更

`GET /api/admin/plugins/xray/topology` 废弃（同 4.2，返回 410 Gone）。

拓扑关系已经内嵌在 `GET /inbounds` 的每行 `upstream_*` 字段中，无需单独 topology endpoint。

### 4.5 deploy 流：任意 inbound 变更触发 server 级 restart

```
inbound CRUD 成功写入 DB
    ↓
assembleServerConfig(server_id):
    SELECT * FROM xray_inbounds + JOIN upstream server address
    → RenderServerConfig(inbounds[])
    → json bytes
    ↓
pushConfigAndRestart(server_id, json):
    1. 推送 config.json 到 /etc/shepherd-xray/config.json
    2. systemctl restart shepherd-xray（或 launchctl 等效命令）
    ↓
更新 plugin_hosts.status / last_error / updated_at
```

批量改动时（例如 BulkRelayDialog 一次创建 N 个 relay-inbound，均在同一 server），调用方应**顺序**创建，每次创建完成后都会触发一次 restart。若需减少 restart 次数，前端在批量场景下可改用"一次性提交多个 inbound"的专用端点（见 §10 后续可能），v1 不实现此优化，接受 N 次 restart。

---

## §5 UI 变更

### 5.1 HostsTab → InboundsTab

**文件：** `web/src/pages/admin/plugins/xray/InboundsTab.tsx`

整体布局：按 server 分组的 inbound 表。每个 server 是一个 section header，其下列出该 server 的所有 inbound 行。

表格列（每行是一个 inbound，不是 server）：

| 列 | 说明 |
|---|---|
| Tag | `relay-e5f6a7b8`，font-mono；landing-inbound 灰色；relay-inbound 蓝色 |
| Role | landing pill（灰）/ relay pill（蓝）+ `→ landing-tag @ server-name` |
| Protocol | `vless+REALITY` / `vmess+WS` / `shadowsocks` |
| Port | 数字 |
| Status | 继承自 server 的 `plugin_hosts.status`（xray 进程状态） |
| Actions | Copy URL / Edit / Delete |

Server section header 显示：server name + ssh_host + xray 版本（`plugin_hosts.deployed_version`） + "＋ Add inbound" 按钮 + "＋ Bulk Relay" 按钮（仅当该 server 有 landing-inbound 时显示）。

顶部保留全局"＋ New inbound"按钮（跨 server，让用户在 InboundDialog 里选 server）。

数据来源：`GET /api/admin/plugins/xray/inbounds`（全量），前端按 `server_id` 分组。同时并发 `GET /api/admin/servers` 拿 server 名/host 用于 section header。不再需要单独的 topology query。

```tsx
// InboundsTab.tsx 骨架（关键数据流）
const inboundsQ = useQuery({
  queryKey: ['xray-inbounds'],
  queryFn: () => listXrayInbounds(),   // GET /api/admin/plugins/xray/inbounds
  refetchInterval: 5_000,
})
const hostsQ = useQuery({              // 用于 plugin_hosts.status / deployed_version
  queryKey: ['plugin-hosts', 'xray'],
  queryFn: () => listPluginHosts('xray'),
  refetchInterval: 5_000,
})

// 按 server_id 分组
const byServer: Map<number, XrayInbound[]> = groupBy(inboundsQ.data ?? [], (i) => i.server_id)
```

**Undeploy 行为变更：** 不再有 server 级别的 Undeploy 按钮；用户通过逐一 Delete inbound 完成下线。最后一个 inbound 删除时服务端自动 stop service（§4.1 末尾规则）。

### 5.2 DeployDialog → InboundDialog

**文件：** `web/src/pages/admin/plugins/xray/InboundDialog.tsx`

用于新建或编辑单个 inbound。

| 字段 | 新建 | 编辑（PATCH） |
|---|---|---|
| Server | 可选（select）| 只读（disabled） |
| Role | 可选（landing / relay）| 只读（disabled，附 tooltip "role 不可变，删后重建"） |
| Upstream landing-inbound | role=relay 时可选 | 只读（disabled） |
| Protocol | 可选 | 只读（disabled） |
| Port | 可编辑 | 可编辑 |
| UUID | 可编辑 + 随机生成 | 可编辑 + 随机生成 |
| SNI | 可编辑（仅 vless-reality）| 可编辑 |
| REALITY keypair | 生成按钮 | 重新生成按钮（提示：更换密钥需手动通知客户端）|
| Short ID | 可编辑 + 生成 | 可编辑 + 生成 |
| WS Path | 可编辑（仅 vmess-ws）| 可编辑 |

**Upstream landing-inbound 选项**（role=relay 时）：从 `GET /inbounds` 数据中筛选 `role='landing'` 的 inbound，展示为 `{server_name} / {tag} (:{port})`，不可选自己 server 上的 relay-inbound 作为 upstream。

**Port 唯一性检测**：前端在提交前 client-side 检查同 server 其他 inbound 是否已占用该 port；服务端 DB UNIQUE 约束兜底。

提交后 invalidate `['xray-inbounds']` 和 `['plugin-hosts', 'xray']`（后者因为 status 会因 restart 短暂变化）。

### 5.3 BulkRelayDialog（改为 inbound 级别）

入口变更：从"landing **server** 行的 + Relays 按钮" → 变为"landing **inbound** 行的 + Bulk Relay 按钮"。

**Props 变更：**

```ts
interface BulkRelayDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  landingInbound: XrayInbound        // 选定的 landing-inbound（role='landing'）
  landingServerHost: string          // landing 所在 server 的 ssh_host
  landingServerName: string
  // 改：从"已有 xray 的 server set"变为"已有 inbound 的 server set"
  // （一台 server 可以有多个 inbound，批量 relay 仍可以部署到已有 inbound 的 server）
  allInbounds: XrayInbound[]         // 全量 inbound 列表，用于 port 冲突检测
}
```

**Target 列表变更：** 不再排除"已有 xray 的 server"，改为列出所有 enrolled server（包括已有 inbound 的 server），因为一台 server 可以同时跑多个 inbound。但需要在每行展示该 server 已占用的端口列表（帮助用户避免 port 冲突）。

**提交方式变更：** 调用 `POST /api/admin/plugins/xray/inbounds`（带 `upstream_inbound_id`），而不是旧的 `POST /hosts/:server_id`。

其余行为（顺序提交、单条失败不阻塞、toast 反馈）不变。

### 5.4 Server 级控件：xray binary 版本管理

一台 server 只有一个 xray 进程，binary 版本是 server 级概念。在 InboundsTab 的 server section header 区域增加：

```
server-X (1.2.3.4)  xray v1.8.11 [Update version ↗]
```

"Update version" 展开一个 inline form（不是 dialog）：

```
Version: [1.8.12 ▼]  [Apply]
```

提交调用 `PATCH /api/admin/plugins/xray/servers/:server_id`：

```json
{ "version": "1.8.12" }
```

服务端更新 `plugin_hosts.deployed_version`，重新 fetch binary，推送并 restart xray（config 不变，只换 binary）。

---

## §6 生命周期 / 依赖

### 6.1 修改任一 inbound → server xray restart

修改该 server 上任意 inbound（增/改/删）都会触发整台 server 的 xray restart，约 1s 中断。所有该 server 上其他 inbound 的连接在 restart 期间断开。

**批量改动的 restart 次数：** v1 不做 batching，每次 POST/PATCH/DELETE 都会触发一次 restart。用户若需批量操作（如 BulkRelayDialog 在同一 server 上创建 3 个 relay-inbound），会触发 3 次 restart，约 3s 总中断。接受此代价；restart 优化（比如"defer restart，聚合后只做一次"）列入 §10 后续可能。

### 6.2 删除 landing-inbound 阻断

`DELETE /inbounds/:id` 校验：若 `id` 是 landing-inbound 且有其他 relay-inbound 的 `upstream_inbound_id = id`，返回 409：

```json
{
  "error": "landing inbound landing-a1b2c3d4 has 2 relay(s) depending on it",
  "relay_inbound_ids": [7, 9]
}
```

前端在 Delete 按钮处：若该 landing-inbound 有依赖的 relay-inbound（从 allInbounds 本地计算），则 Delete 按钮 disabled + tooltip `"先删除 N 个依赖此 landing 的 relay-inbound"`。

DB 层面由 `upstream_inbound_id` FK RESTRICT 兜底（xray_inbounds 自引用，ON DELETE RESTRICT）。

### 6.3 tag 稳定性

- tag 在 inbound 创建时由服务端生成，格式 `{role}-{8hex}`，永不改变。
- 不提供重命名 API。PATCH 请求体中的 `tag` 字段被服务端忽略。
- tag 被删除的 inbound 对应的历史 tag 不可被新 inbound 复用（DB UNIQUE 约束不够，需应用层维护 tombstone 表或 tag 前缀加时间戳；v1 暂不实现 tombstone，依赖 UUID 碰撞概率极低 + 8hex 空间 4B = 2^32 组合）。
- Phase 3c-2（流量监控）以 `tag` 为 stats 维度；tag 变化意味着历史监控数据与新监控数据断裂。本 spec 通过禁止重命名保证 tag 在 inbound 生命周期内稳定。

### 6.4 最后一个 inbound 删除后 xray 行为

删除成功后，服务端检查 `SELECT COUNT(*) FROM xray_inbounds WHERE server_id = ?`：

- 若 count > 0：正常重渲染 + restart。
- 若 count = 0：stop xray service（`systemctl stop shepherd-xray` 或等效命令），更新 `plugin_hosts.status = 'stopped'`，不推送 config（无 inbound 时 config 为空）。plugin_hosts 行**保留**，不删除（保留 `deployed_version` 和 `last_error` 历史记录）。下次 POST 新 inbound 时，服务端检测到 plugin_hosts 行存在但 status=stopped，直接重渲染 + restart（不需要重新 fetch binary，binary 文件仍在）。

---

## §7 迁移

### 7.1 新建 `xray_inbounds` 表

新建文件 `internal/plugins/xray/migrations/0003_multi_inbound.up.sql`：

```sql
-- 0003_multi_inbound.up.sql

CREATE TABLE IF NOT EXISTS xray_inbounds (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id            INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag                  TEXT    NOT NULL,
  port                 INTEGER NOT NULL,
  role                 TEXT    NOT NULL CHECK (role IN ('landing', 'relay')),
  protocol             TEXT    NOT NULL DEFAULT 'vless-reality',
  uuid                 TEXT,
  sni                  TEXT,
  public_key           TEXT,
  private_key          TEXT,
  short_id             TEXT,
  ws_path              TEXT,
  ss_method            TEXT,
  ss_password          TEXT,
  upstream_inbound_id  INTEGER REFERENCES xray_inbounds(id) ON DELETE RESTRICT,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (role = 'landing' AND upstream_inbound_id IS NULL) OR
    (role = 'relay'   AND upstream_inbound_id IS NOT NULL)
  ),
  UNIQUE (server_id, tag),
  UNIQUE (server_id, port)
);

CREATE INDEX IF NOT EXISTS xray_inbounds_server   ON xray_inbounds(server_id);
CREATE INDEX IF NOT EXISTS xray_inbounds_upstream ON xray_inbounds(upstream_inbound_id);
```

### 7.2 旧表 `xray_host_topology` 处置

旧表不在 0003 中删除，保留至 v0.4.0（给两个版本的过渡期）。在 0003 中只添加 deprecation 注释：

```sql
-- xray_host_topology 已由 xray_inbounds.upstream_inbound_id 取代。
-- 将在 0004_cleanup.up.sql 中删除。请勿再写入新数据。
```

v0.4.0 时新增 `0004_cleanup.up.sql`：

```sql
DROP TABLE IF EXISTS xray_host_topology;
```

对应 down migration `0003_multi_inbound.down.sql`：

```sql
DROP TABLE IF EXISTS xray_inbounds;
```

### 7.3 数据从旧结构迁移

纯 SQL migration 无法优雅解析 JSON config 字段（SQLite 的 json_extract 在所有宿主环境不一定可用），迁移逻辑在 Go migration runner 中以钩子方式执行：

```go
// internal/plugins/xray/migrations/migrate_0003.go

// Migrate0003 在 0003.up.sql 执行后运行。
// 从 plugin_hosts.config JSON 提取 inbound 参数，
// 结合 xray_host_topology 的 role/upstream_server_id，
// 批量插入 xray_inbounds 行（幂等）。
func Migrate0003(db *sqlx.DB) error {
    type hostRow struct {
        ServerID        int64          `db:"server_id"`
        Config          []byte         `db:"config"`
        DeployedVersion sql.NullString `db:"deployed_version"`
        Role            sql.NullString `db:"role"`
        UpstreamServerID sql.NullInt64 `db:"upstream_server_id"`
    }
    rows := []hostRow{}
    err := db.Select(&rows, `
        SELECT ph.server_id, ph.config, ph.deployed_version,
               ht.role, ht.upstream_server_id
        FROM plugin_hosts ph
        LEFT JOIN xray_host_topology ht ON ht.server_id = ph.server_id
        WHERE ph.plugin_id = 'xray'
    `)
    if err != nil { return err }

    // 第一轮：插入所有 inbound（landing 和 relay 均插入，relay 的 upstream_inbound_id 暂为 NULL）
    serverToInboundID := map[int64]int64{}
    for _, h := range rows {
        var cfg map[string]any
        json.Unmarshal(h.Config, &cfg)
        inbounds, _ := cfg["inbounds"].([]any)
        if len(inbounds) == 0 { continue }
        first := inbounds[0].(map[string]any)
        port := int(first["port"].(float64))
        role := "landing"
        if h.Role.Valid { role = h.Role.String }

        tag := role + "-" + randomHex8()
        // 幂等：若 (server_id, port) 已存在则跳过
        var existingID int64
        err := db.QueryRowx(`SELECT id FROM xray_inbounds WHERE server_id=? AND port=?`,
            h.ServerID, port).Scan(&existingID)
        if err == nil {
            serverToInboundID[h.ServerID] = existingID
            continue
        }
        // 提取 vless-reality 字段
        // ... uuid / sni / public_key / private_key / short_id 从 JSON 中提取 ...
        res, _ := db.Exec(`
            INSERT INTO xray_inbounds (server_id, tag, port, role, protocol,
              uuid, sni, public_key, private_key, short_id, upstream_inbound_id, updated_at)
            VALUES (?,?,?,?,'vless-reality',?,?,?,?,?,NULL,CURRENT_TIMESTAMP)`,
            h.ServerID, tag, port, role, uuid, sni, publicKey, privateKey, shortID)
        id, _ := res.LastInsertId()
        serverToInboundID[h.ServerID] = id
    }

    // 第二轮：为 relay-inbound 填 upstream_inbound_id
    for _, h := range rows {
        if !h.Role.Valid || h.Role.String != "relay" { continue }
        if !h.UpstreamServerID.Valid { continue }
        upstreamInboundID, ok := serverToInboundID[h.UpstreamServerID.Int64]
        if !ok { continue }
        myInboundID := serverToInboundID[h.ServerID]
        db.Exec(`UPDATE xray_inbounds SET upstream_inbound_id=? WHERE id=?`,
            upstreamInboundID, myInboundID)
    }
    return nil
}
```

迁移完成后，`plugin_hosts.config` 字段清空（不删除字段，设为 `'{}'`），确保旧代码（若有）不意外使用旧 config：

```sql
UPDATE plugin_hosts SET config = '{}' WHERE plugin_id = 'xray';
```

### 7.4 老表删除时机

| 表 | 保留版本 | 删除时机 |
|---|---|---|
| `xray_host_topology` | v0.3.1 ~ v0.3.x | v0.4.0 的 `0004_cleanup.up.sql` |
| `plugin_hosts.config` 字段 | 字段保留（设为 `{}`） | 不删除字段（删字段需 ALTER TABLE，SQLite 限制多） |

---

## §8 测试矩阵

### 8.1 Go 单测

`internal/plugins/xray/render_test.go`：

- `RenderServerConfig` 单 landing-inbound：输出含 `inbounds[0].tag`，outbounds 只有 freedom，无 routing rules。
- `RenderServerConfig` 单 relay-inbound：输出含 `inbounds[0].tag`，`outbounds` 含 `to-{upstream.tag}` + freedom，routing rules 含 `inboundTag:[relay-tag] → to-{upstream.tag}`。
- `RenderServerConfig` 混合（1 landing + 2 relay 各指不同 upstream）：输出 3 个 inbound，2 个 to-* outbound，2 条 inboundTag routing rule + 1 条 geoip:private rule；顺序稳定（landing 先于 relay，relay 按 id 排序）。
- `RenderServerConfig` 空 inbounds：返回 error，不返回 json。

`internal/plugins/xray/api_test.go`：

- `POST /inbounds` 拒绝 port 冲突（同 server 已有相同 port）→ 409
- `POST /inbounds` 拒绝 relay 指向不存在的 upstream_inbound_id → 409
- `POST /inbounds` 拒绝 relay 指向 role=relay 的 upstream → 409
- `PATCH /inbounds/:id` 不允许修改 role / upstream_inbound_id / server_id / tag → 字段被忽略，返回 200，修改不生效
- `DELETE /inbounds/:id` 被 relay 依赖时 → 409，body 含 relay_inbound_ids
- `DELETE /inbounds/:id` 删除后 server 无 inbound → plugin_hosts.status='stopped'
- `GET /inbounds?server_id=5` 只返回 server_id=5 的行，按 id 升序
- `GET /api/admin/plugins/xray/hosts/:server_id`（旧端点）→ 410 Gone

`internal/plugins/xray/migrations/migrate_0003_test.go`：

- 已有 landing plugin_host → 迁移后 xray_inbounds 有 1 行，role=landing，upstream_inbound_id=NULL
- 已有 relay plugin_host（upstream=landing server）→ 迁移后 relay 行的 upstream_inbound_id 指向 landing 行的 id
- 迁移幂等：重复执行不插入重复行

### 8.2 前端单测

`InboundsTab.test.tsx`：

- 正确按 server_id 分组展示 inbound 行
- landing-inbound 行的 Delete 按钮在有 relay 依赖时为 disabled 状态
- server section header 展示正确的 `deployed_version`

`InboundDialog.test.tsx`：

- 新建模式：role=relay 时显示 upstream 选项，选项只包含 role=landing 的 inbound
- 编辑模式：role / upstream_inbound_id / server_id / protocol 字段为 disabled
- port 本地冲突检测：同 server 已有 port 时提交按钮 disabled + 错误提示

`BulkRelayDialog.test.tsx`（改为 inbound 级别后）：

- target 列表包含已有 inbound 的 server（与旧版不同）
- 展示每个 server 已占用的 port 列表
- 提交调用 `POST /api/admin/plugins/xray/inbounds`（不是旧的 `/hosts/:id`）
- 带 `upstream_inbound_id` = 选定 landing-inbound 的 `id`

### 8.3 手工 smoke 步骤

1. 部署全新环境（无旧数据）：在 server-A 上 POST `/inbounds`（role=landing, port=443）。确认 InboundsTab 显示 1 行，Copy URL 可用，客户端连接成功。
2. 在 server-A 上再 POST `/inbounds`（role=landing, port=8443）。确认 server-A section 下显示 2 行；xray restart 1 次，两个 landing 端口均可用。
3. 在 server-B 上 POST `/inbounds`（role=relay, upstream_inbound_id = server-A port:443 的 inbound id）。确认 server-B section 显示 relay 行，relay 指向正确 landing。客户端通过 relay 可正常出网。
4. 尝试 DELETE server-A port:443 的 landing-inbound → 拒绝（有 relay 依赖），InboundsTab Delete 按钮为 disabled。
5. DELETE server-B 的 relay-inbound → 成功；再 DELETE server-A port:443 的 landing-inbound → 成功；server-A 仍有 port:8443 landing，xray 继续运行。
6. DELETE server-A port:8443 的 landing-inbound（最后一个）→ 成功；server-A section header 显示 xray status=stopped。
7. 升级测试（有旧数据）：停服，在 DB 手工插入旧格式 plugin_hosts + xray_host_topology 数据，跑 migration 0003，确认 xray_inbounds 中有正确数据（包括 relay 的 upstream_inbound_id 正确填充），plugin_hosts.config = `{}`。
8. BulkRelayDialog：在已有 inbound 的 landing-inbound 行点"+ Bulk Relay"，选择 2 个 server（其中 1 个已有其他 inbound），填写配置，Deploy all。确认 2 个 relay-inbound 创建成功，inbound 列表更新，port 无冲突。

---

## §9 已确认的取舍

| 取舍 | 选择 | 原因 |
|---|---|---|
| 多 inbound 方案 | 单进程 + xray 原生 `inbounds[]` 数组 | xray 原生支持，zero overhead；多进程方案引入进程管理/端口分配复杂度 |
| 修改 inbound 的代价 | 整台 server restart（~1s 抖动） | xray 不支持热加载单个 inbound；accept 1s 中断，运维窗口可控 |
| config 渲染位置 | 服务端（反转 3b 的前端渲染） | 多 inbound 聚合需要 DB JOIN，private_key 不能暴露给前端；服务端渲染更安全、更一致 |
| plugin_hosts.config 字段 | 保留字段但设为 `{}`，不删除 | SQLite ALTER TABLE DROP COLUMN 在老版本不支持；字段清空后不影响功能 |
| xray_host_topology 删除时机 | 保留 2 个版本，v0.4.0 删除 | 给客户端代码（如有直接查旧表的脚本）过渡时间；不影响 v0.3.x 线上功能 |
| tag 重命名 | 禁止 | 流量监控（Phase 3c-2）以 tag 为 stats 维度，重命名导致历史数据断裂 |
| role 变更 | 禁止（删后重建） | 与 3b 一致；避免 DB 中间态 + 部署失败回滚复杂度 |
| 批量 inbound 创建的 restart 次数 | N 次（每创建一个 inbound restart 一次） | v1 不实现 batching；接受 N*1s 中断；batching 列入后续 |
| BulkRelayDialog target 服务器范围 | 包含已有 inbound 的 server | 多 inbound 后，一台 server 可以同时有多个 inbound（包括多个 relay），排除已有 xray 的 server 逻辑不再适用 |
| upstream_inbound_id 存储位置 | 内嵌于 xray_inbounds 表（自引用 FK） | 不需要单独 topology 表；FK RESTRICT 直接提供删除保护；关系数据与 inbound 数据同行 |

---

## §10 后续可能

- **流量监控按 inbound tag 切分（Phase 3c-2）**：利用 xray stats API（`xray api statsoneof --pattern inbound`）按 `tag` 维度采集流量数据，存入独立 stats 表，在 UI 按 inbound 展示 RX/TX。本 spec 通过稳定 tag + 不允许重命名为此打好基础，Phase 3c-2 独立 spec。
- **批量 inbound 创建端点 + 单次 restart**：`POST /api/admin/plugins/xray/servers/:server_id/inbounds/batch`，接受多个 inbound 定义，DB 批量插入后只做一次 restart。减少 BulkRelayDialog 的中断次数。
- **inbound 级 xray restart 热加载**：待 xray 支持 SIGHUP 或 API 热加载时，单个 inbound 变更可不重启整个进程。
- **跨 server inbound 迁移**：提供"把 inbound-A 从 server-X 迁移到 server-Y"的 API，服务端自动处理删建 + upstream 关系更新。
- **1 relay-inbound → N landing-inbound 的 balancer/failover**：xray `balancers` 配置；relay 选取多个 upstream landing，xray 自动负载均衡或 latency-based 路由。
- **relay-side 分流（CN 直连）**：relay-inbound 上添加 geosite:cn → direct 路由，适用于 relay 本身在国内的拓扑。
