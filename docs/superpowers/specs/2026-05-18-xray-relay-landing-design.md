# xray 中继 / 落地拓扑 — 设计文档

**状态：** 草案（2026-05-18）
**基线：** v0.3.0（xray 插件已上线，单机 standalone 部署）
**所属阶段：** Phase 3b（xray 插件能力扩展，不开新插件）

## 1. 范围

### 1.1 交付物

- xray 插件支持两种 host 角色：
  - **landing（落地机）**：保持现状，REALITY inbound + freedom outbound，直接出网
  - **relay（中继机）**：REALITY inbound（客户端接入） + vless+REALITY outbound 指向某台 landing
- relay → landing 的 1:1 link 关系建模与持久化
- DeployDialog 支持 role 选择与 upstream landing 选择（首次部署时生效；re-deploy 时 role 锁死）
- HostsTab 表格新增 Role 列，relay 显示 `→ <landing.name>`
- BulkRelayDialog：从 landing 行一键批量创建多个 relay
- share URL 行为：landing / relay 各自生成自己 host 的 vless URL；客户端连哪台进哪台

### 1.2 明确不做

- 多 landing 的 failover / 负载均衡（xray balancer / 多 vnext）—— 单个 relay 只指 1 个 landing；一个 landing 被 N 个 relay 指向是允许的（详见 5.3 批量创建）
- Re-deploy 改 role（landing↔relay 互转）—— v1 锁死，想换先 undeploy 再 deploy（理由见 4.1）
- relay 端的智能分流（CN 直连 / GFW geosite 等）—— relay 永远把流量整体丢给 landing，由 landing 出网；分流在客户端侧做
- 非 xray 隧道协议（HAProxy、gost、WireGuard）—— 等出现实际多协议需求时再抽 `tunnel` 插件
- landing 密钥旋转后自动重新 deploy 所有 relay —— v1 在 UI 给警告，不自动联动
- relay 链路（relay → relay → landing）—— 明确禁止
- 跨 Shepherd 实例的 relay/landing —— 必须是同一个 Shepherd 管的 host

### 1.3 关键约束

- 隧道协议固定 **vless + REALITY + xtls-rprx-vision**。复用 landing 已有的 REALITY 密钥对（不为 tunnel 单独生成），relay 直接把 landing 的 publicKey / shortID / SNI 填到自己的 outbound。
- relay 连 landing 用的是 landing 的 **公开 host 地址**（`servers.ssh_host`，跟 share URL 用的一致），不走 Shepherd 自己的 agent 通道。意味着：
  - landing 的 inbound 端口必须从 relay 可达（公网或私网路由通）
  - relay 与 landing 之间不需要 Shepherd 额外做 NAT 穿透或 agent 转发
- relay 的 inbound 与 landing 的 inbound 是**独立的 vless user**（不同 UUID）。客户端通过 relay 连进来，relay 用自己存的 UUID 校验客户端；然后 relay 自己作为 vless 客户端，用 landing 给它的 UUID 接到 landing。两条独立认证链。

## 2. 数据模型

### 2.1 新表 `xray_host_topology`

```sql
CREATE TABLE xray_host_topology (
  server_id           INTEGER PRIMARY KEY
                        REFERENCES servers(id) ON DELETE CASCADE,
  role                TEXT    NOT NULL CHECK (role IN ('landing', 'relay')),
  upstream_server_id  INTEGER REFERENCES servers(id) ON DELETE RESTRICT,
  updated_at          TIMESTAMP NOT NULL,
  CHECK (
    (role = 'landing' AND upstream_server_id IS NULL) OR
    (role = 'relay'   AND upstream_server_id IS NOT NULL)
  )
);
CREATE INDEX xray_host_topology_upstream ON xray_host_topology(upstream_server_id);
```

**约定：**
- xray plugin_hosts 与 xray_host_topology 是 1:1 应用层约束，由 API 层维护（删除 xray host 时一并删除 topology 行）
- `upstream_server_id` 不直接 FK 到 plugin_hosts —— SQLite 单字段 FK 不能跨复合表达式。在应用层校验 upstream 必须是已部署的 xray landing
- `ON DELETE RESTRICT` 保证不能在还有 relay 指向它时直接删 landing。要先把对应的 relay 改成别的 landing 或先删 relay

### 2.2 不变更的表

- `plugin_hosts.config` 仍然存渲染出来的完整 xray config JSON。role / upstream 不重复存进 config（避免 source-of-truth 双写），关系数据只在 `xray_host_topology` 里

## 3. 配置渲染

### 3.1 Landing config（与现状完全相同）

```json
{
  "log": { "loglevel": "warning" },
  "inbounds": [{
    "port": <port>,
    "protocol": "vless",
    "settings": {
      "clients": [{ "id": "<landing-uuid>", "flow": "xtls-rprx-vision" }],
      "decryption": "none"
    },
    "streamSettings": {
      "network": "tcp",
      "security": "reality",
      "realitySettings": {
        "show": false,
        "dest": "<sni>:443",
        "serverNames": ["<sni>"],
        "privateKey": "<landing-priv>",
        "publicKey":  "<landing-pub>",
        "shortIds":   ["<landing-sid>"]
      }
    },
    "sniffing": { "enabled": true, "destOverride": ["http", "tls"] }
  }],
  "outbounds": [{
    "protocol": "freedom",
    "settings": { "domainStrategy": "UseIP" }
  }]
}
```

### 3.2 Relay config

Relay 的 inbound 与 landing 几乎一样（自己的 REALITY 密钥对、自己的 UUID）；outbound 改为指向 landing。

```json
{
  "log": { "loglevel": "warning" },
  "inbounds": [{
    "port": <relay-port>,
    "protocol": "vless",
    "settings": {
      "clients": [{ "id": "<relay-uuid>", "flow": "xtls-rprx-vision" }],
      "decryption": "none"
    },
    "streamSettings": {
      "network": "tcp",
      "security": "reality",
      "realitySettings": {
        "show": false,
        "dest": "<relay-sni>:443",
        "serverNames": ["<relay-sni>"],
        "privateKey": "<relay-priv>",
        "publicKey":  "<relay-pub>",
        "shortIds":   ["<relay-sid>"]
      }
    },
    "sniffing": { "enabled": true, "destOverride": ["http", "tls"] }
  }],
  "outbounds": [
    {
      "tag": "to-landing",
      "protocol": "vless",
      "settings": {
        "vnext": [{
          "address": "<landing-ssh-host>",
          "port":    <landing-port>,
          "users": [{
            "id":         "<landing-uuid>",
            "encryption": "none",
            "flow":       "xtls-rprx-vision"
          }]
        }]
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "fingerprint": "chrome",
          "serverName":  "<landing-sni>",
          "publicKey":   "<landing-pub>",
          "shortId":     "<landing-sid>"
        }
      }
    },
    {
      "tag": "direct",
      "protocol": "freedom",
      "settings": { "domainStrategy": "UseIP" }
    }
  ],
  "routing": {
    "rules": [
      { "type": "field", "ip": ["geoip:private"], "outboundTag": "direct" }
    ]
  }
}
```

**说明：**

- 第一个 outbound（`to-landing`）作为 xray 的默认 outbound（路由未命中时走第一个），所有客户端流量都进隧道
- `direct` outbound 只用于命中私网 IP 的规则。防止"客户端访问内网测试地址"被错误转给 landing
- relay 的 outbound REALITY 字段：客户端字段（`fingerprint` / `serverName` / `publicKey` / `shortId`）单数形式，跟 landing 的 inbound 字段（`serverNames` / `shortIds` 数组）不同

### 3.3 渲染分工

沿用 v0.3.0 的现行模式：**前端渲染完整 config，服务端 verbatim 存储 / 推送**。Go 侧的 `RenderVLESSReality` 仅作单测参考实现，部署流程不经过它。

`web/src/pages/admin/plugins/xray/templates.ts` 改动：

```ts
export interface TemplateValues {
  // 现有字段不变
  inbound: Inbound
  port: number
  uuid?: string
  sni?: string
  publicKey?: string
  privateKey?: string
  shortID?: string
  wsPath?: string
  // 新增：
  role?: 'landing' | 'relay'        // 默认 landing
  landing?: LandingRef              // role=relay 时必填
}

export interface LandingRef {
  address: string   // upstream 的 servers.ssh_host
  port: number
  sni: string
  uuid: string
  publicKey: string
  shortID: string
}

// renderTemplate(values) 内部按 role 分支：
//   landing -> 现有 vlessReality(v)
//   relay   -> 新增 relayVlessReality(v, v.landing!)
//
// parseConfig 反向解析：检测 outbound[0].protocol==='vless' && security==='reality'
//                       => 视为 relay，回填 landing 字段
```

**前端取 landing 字段的路径：** DeployDialog 已经通过 react-query 拉到 hosts 列表（`useQuery(['plugin-hosts','xray'])`）。选 upstream 时直接对那条 host 跑 `parseConfig(upstream.config)` 拿到 landing 的 inbound 字段，加上 `upstream.server.ssh_host` 作为 address，就齐了，不需要新增 API。

Go 端 `RenderVLESSReality` 同步扩 `Topology *TopologyRef` 可选参数与 `LandingRef` 类型，保持 server 侧也能渲染（用于 config_test.go 校验输出一致性，以及未来可能的 server-side render 场景）。

## 4. API 变更

### 4.1 Deploy（既有 endpoint 增字段）

`POST /api/admin/plugins/xray/hosts/:server_id`

请求体新增 `topology`（与既有 `config` 并列）：

```json
{
  "version": "1.8.11",
  "config":  { ... 前端已渲染好的完整 xray config ... },
  "topology": {
    "role": "relay",
    "upstream_server_id": 42
  }
}
```

- `topology` 缺省 = `{ "role": "landing" }`
- 当 `role == "relay"` 时 `upstream_server_id` 必填
- 服务端校验（按顺序）：
  1. upstream 必须是已存在的 xray plugin_host（不能挂到 non-xray host 或还没部署的 host）
  2. upstream 的 role 必须是 `landing`（禁止 relay→relay）
  3. upstream ≠ 自己
  4. **Re-deploy 时 role 不可变**：如果目标 server 已经有 xray plugin_host + topology 行，传入的 `topology.role` 必须与已存 role 一致；否则返回 `409 Conflict`，提示先 undeploy。同理 `upstream_server_id` 一旦设定也不允许在 re-deploy 时改变（要换 upstream 必须先 undeploy）。理由：避免 relay↔landing 互转时的中间态（既要清 topology 又要写 topology + 部署事务、失败回滚复杂）；v1 把这层复杂度排除掉，想换就先删后建
- 服务端**不重新渲染 config**，body 里的 config 直接作为 xray config.json 推到 host。topology 只入 `xray_host_topology` 表
- 部署成功后再写 topology 行（事务）；topology 校验失败时整个 deploy 不发生

### 4.2 Hosts 列表（既有 endpoint 增字段）

`GET /api/admin/plugins/xray/hosts` 响应行新增：

```json
{
  "server_id":         5,
  "status":            "running",
  "config":            { ... },
  "deployed_version":  "1.8.11",
  "topology": {
    "role":               "relay",
    "upstream_server_id": 42,
    "upstream_name":      "landing-us-1"   // 由 server 端 join 进来，省一次往返
  }
}
```

### 4.3 Undeploy（既有 endpoint 增加约束）

`DELETE /api/admin/plugins/xray/hosts/:server_id`：

- 如果该 host 是 landing 且有 relay 指向它，返回 `409 Conflict`，body 列出依赖的 relay：
  ```json
  { "error": "landing has 2 relay(s) depending on it", "relays": [3, 7] }
  ```
- 否则正常 undeploy 并删除 topology 行

## 5. UI 变更

### 5.1 DeployDialog

新增字段（紧随 Target server 之后）：

| 字段 | 类型 | 行为 |
|---|---|---|
| Role | radio: Landing / Relay | 默认 Landing。Relay → 显示 Upstream landing 选项 |
| Upstream landing | select | 仅 role=Relay 时显示；选项 = 所有当前已部署的 xray landing host（按 `server.name` 排序）；不可选自己 |

Relay 模式下：
- 上半部分（Inbound：port / UUID / SNI / keypair / shortID）仍由用户配置 —— 这是给客户端用的接入参数，跟 landing 是分开的两套
- 下半部分（Upstream）只读展示：从选中的 landing host（已在前端 hosts 列表里）跑 `parseConfig` 自动解出 address / port / UUID / SNI / publicKey / shortID
- 提交时前端 `renderTemplate({ role:'relay', landing: { ... } })` 把 upstream 字段直接渲染进 outbound，**完整 config 一起 POST**；同时把 `topology: { role, upstream_server_id }` 作为关系数据并行 POST，服务端各取所需

### 5.2 HostsTab

表格列调整：

| 旧 | 新 |
|---|---|
| Server / Protocol / Port / Status / Version / Actions | Server / **Role** / Protocol / Port / Status / Version / Actions |

Role 列展示：
- Landing：`landing` 灰 pill
- Relay：`relay → landing-us-1` 蓝 pill（landing-us-1 可点击跳到对应行）

Undeploy 按钮：
- 该 host 是被依赖的 landing 时，按钮 disabled + tooltip 提示"先解除 N 个 relay 的依赖"

Share URL（Copy URL 按钮）：
- 行为不变。每行的 share URL 是**该 host 自己的接入参数**：
  - landing 行 → 客户端直连 landing 的 URL（已有行为）
  - relay 行 → 客户端连 relay 的 URL（新逻辑，自动从 relay 自己的 config 反解，与 landing 无关）

### 5.3 批量为一个 landing 创建多个 relay

**痛点：** 一个 landing 通常带多个 relay（不同地理位置 / 不同入口）。单次 deploy 一台太慢——要逐个开 DeployDialog、手动选 upstream、生成 keypair、改 port。

**入口：** HostsTab 表格里每个 **landing 行**的 Actions 区新增一个按钮 **"+ Relays"**（与 Re-deploy / Undeploy 并列；只在 role=landing 时显示）。

**点击后弹 BulkRelayDialog**，标题 `Add relays → <landing-name>`。表单：

1. **Target servers**（必填）：多选 checkbox 列表，列出所有"还没部署过 xray 的 server"以及"不是当前 landing 自己"
2. **Shared settings**（应用到本次批量创建的每个 relay）：
   - Version：默认 = landing 的 deployed_version（避免版本错位带来的协议差异），可改
   - REALITY SNI：默认 = landing 的 SNI（同一指纹群组），可改
3. **每个选中 server 一行 inline 配置**（自动生成，可单独 override）：
   - Port：随机端口（10000–59999），可改；冲突检测仅做最低限度（同次批量内部 port 必须唯一）
   - UUID：`crypto.randomUUID()` 自动生成，可点 ↻ 重生成
   - REALITY keypair：每行独立生成一对 X25519，可点 ↻ 重生成
   - Short ID：每行独立随机 8 字节 hex，可点 ↻ 重生成
4. 底部 **Deploy all** 按钮

**提交策略：**

- 前端在 React Query mutation 里 **顺序** 对选中的每一台 server 调一次现有的 `POST /api/admin/plugins/xray/hosts/:server_id`（每次 body 都带 `topology: { role: 'relay', upstream_server_id: landing.id }`）
- 不并行：避免对同一台 landing 的 plugin_hosts 表 / xray_host_topology 表写时并发（虽然行级锁能保护，但顺序部署日志和 UI 进度更直观）
- 进度反馈：每完成一个 toast `Deployed relay on <server>`，失败 toast `<server>: <error>` 并继续下一个（不全停）
- 全部跑完后 invalidate `['plugin-hosts','xray']`，HostsTab 自动刷新

**为什么不开新 API endpoint：**

- 单台 deploy 已经支持完整 topology 字段。批量 = N 次单 deploy 的循环，前端做 orchestration 即可
- 新 endpoint 会复制全部 deploy 逻辑（fetch binary / verify / push / restart），且要处理"部分失败"的 partial commit 语义，不值得
- 任何对单 deploy 的修复（譬如以后加 deploy timeout）自动惠及批量

### 5.4 sidebar / 其它页面

不变。

## 6. 生命周期与依赖

### 6.1 Deploy 顺序

- Landing 必须先存在并部署成功（status=running 不强制，但 plugin_hosts 行必须存在），relay 才能选它做 upstream
- Relay 部署成功后，relay → landing 的隧道立即可用（landing 不需要任何额外动作；landing 的 inbound 一直在监听）

### 6.2 Landing 密钥旋转

当 landing 被 re-deploy 且 UUID / SNI / publicKey / shortID / port 任一发生变化：
- 所有指向它的 relay 都会 stale（继续运行但每个客户端连接进来都会被 landing reject）
- **v1 处理方式**：landing re-deploy 提交前，前端 mutation 在 `onSuccess` 之前先查依赖 relay 数；如果有变化字段，弹 Confirm dialog 警告："This will break N relay(s); you need to re-deploy them manually afterwards. Continue?"
- **v1 不自动**：不自动批量 re-deploy relay。原因：自动 deploy 可能失败到一半留下半破环境；手动可控

### 6.3 Landing Undeploy

见 4.3：被依赖时拒绝。

### 6.4 Relay Undeploy

无下游约束，正常 stop service + 删 plugin_host + 删 topology 行。

## 7. 迁移

新增 `internal/plugins/xray/migrations/0002_topology.up.sql`（sqlite / postgres 两套）：

- 创建 `xray_host_topology` 表
- 给所有现存 xray plugin_hosts 插一行 role='landing'（INSERT OR IGNORE）

迁移由插件 migration runner（Phase 3a 已上）自动跑。

## 8. 测试矩阵

### 8.1 Go 单测

- `RenderVLESSReality` 在 role=landing 时输出与现状逐字节相同
- `RenderVLESSReality` 在 role=relay 时：
  - inbound 用 relay 自己的 UUID / 密钥对
  - outbound[0] = vless to landing.address:landing.port，REALITY client 字段用 landing 的 pub/sni/sid
  - outbound[1] = freedom direct
  - routing 把 private IP 引到 direct
- API `POST /hosts/:id` 拒绝：upstream 不存在 / upstream 是 relay / upstream 是自己 / role=relay 但 upstream_server_id 缺失
- API `POST /hosts/:id` 在 re-deploy 时拒绝改 role 或改 upstream_server_id（返回 409）
- API `DELETE /hosts/:id` 在 landing 有依赖 relay 时返回 409
- Migration: 现存 xray host 升级后被自动标为 landing

### 8.2 前端单测

- `templates.ts`：
  - `renderTemplate({ inbound: 'vless-reality', role: 'relay', landing: {...} })` 输出符合 3.2
  - `parseConfig(relayConfig)` 反解 role='relay' 且能取到 upstream 字段
  - share URL 始终基于 host 自己的 inbound 字段，不受 role 影响
- `DeployDialog`：
  - role=Landing 时不展示 Upstream landing 选项
  - role=Relay 时 Upstream landing 选项不包含 role=relay 的 host 与自己
  - Re-deploy 模式下 Role 与 Upstream 字段为 read-only（带 lock icon + tooltip）
- `BulkRelayDialog`：
  - 候选 target 列表正确排除：自己（landing）、已部署 xray 的 server、未 enroll 的 server
  - 每行 keypair / UUID / shortID 默认值非空且各行互不相同
  - 选中 N 个 target 后点 Deploy all，触发 N 次 POST，调用顺序与 target 列表顺序一致
  - 一台失败不阻塞其他台，最终回调汇总 success / failure 计数

### 8.3 手工 smoke

1. 部署 landing-A（US），客户端直连 OK
2. 部署 relay-B（HK），upstream=landing-A，客户端连 relay-B 也 OK 且经由 landing-A 出网（在 landing-A 看 access log 应有客户端真实目标）
3. relay-B undeploy → 客户端连 relay-B 失败，连 landing-A 仍 OK
4. 尝试 undeploy landing-A → 拒绝，提示有 1 个 relay 依赖
5. landing-A 重新生成 keypair 并 re-deploy → 前端弹 Confirm 警告 → 接受 → relay-B 的客户端连接立刻全部 fail → 手动 re-deploy relay-B 后恢复
6. 在 landing-A 行点 "+ Relays"，多选 3 台 server，Deploy all → 3 个 relay 顺序部署完成，HostsTab 立即出现 3 行 `relay → landing-A`；客户端能连任意一个进去
7. 尝试 re-deploy 一个 relay 把 role 改成 landing → 服务端返回 409

## 9. 已确认的取舍

| 取舍 | 选择 | 原因 |
|---|---|---|
| 隧道协议 | vless + REALITY 固定 | 已经是 landing 用的协议，零新增依赖；REALITY 让 relay→landing 的 hop 也抗主动探测 |
| Relay 数量 | 1 relay → 1 landing（N:1） | 一个 landing 可以被多个 relay 引用；单个 relay 只指一个 landing；balancer / failover 留到后续 |
| Topology 持久化 | 独立表 `xray_host_topology` | 关系建模、依赖查询、外键 cascade 都更干净；不污染 `plugin_hosts.config` 这份"渲染产物" |
| Relay → landing 连接通道 | 走 landing 公网地址 | 与客户端走同一条路径，复用 REALITY 防探测；不依赖 Shepherd agent 转发，避免 agent 故障影响隧道 |
| 密钥旋转 | 手动 + UI 警告 | 自动联动 deploy 失败处理复杂；手动可控；relay 数量初期不会很多 |
| Relay 端分流 | 不做 | 客户端侧分流是更成熟的做法；relay 内嵌分流会显著增加 config 复杂度 |
| Role 在 re-deploy 时是否可变 | 不可变 | landing↔relay 互转涉及清/写 topology + 配置重渲染 + 部署失败回滚，事务复杂度高；想换 role 先 undeploy 再 deploy 即可，多一次点击换来实现大幅简化 |
| 批量创建 relay | 前端 orchestration，不开新 API | 复用单 deploy 路径，任何对单 deploy 的修复自动惠及批量；不需要处理 partial-commit 语义 |

## 10. 后续可能（不在本次范围）

- N:M：1 个 relay 配多个 landing，加 xray balancer 实现 round-robin / latency-based / failover
- 跨协议 tunnel：抽 `tunnel` 插件，relay 可选 vless / trojan / WireGuard 等
- relay-side routing：CN geosite 在 relay 直连不走隧道（适用于 relay 本身就在国内、出国流量才需 landing 的拓扑）
- Auto re-deploy：landing 密钥变化时自动重新渲染并部署所有 relay，带回滚
