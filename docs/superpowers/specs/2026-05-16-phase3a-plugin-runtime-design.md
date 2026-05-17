# Phase 3a：插件运行时 + 插件中心 — 设计文档

**状态：** 已确认（2026-05-16）
**基线：** v0.3.0（Linear 风格 admin UI；PluginsPage 占位页已上线）
**不在本设计范围：** Phase 3b（relay 插件）、Phase 3c（第三方 / 市场）

## 1. 范围

### 1.1 Phase 3a 交付物

- 插件运行时：编译期内置 Go 接口 + 注册表 + 生命周期管理
- 插件中心 UI：列出所有已编译插件，admin 可启用/禁用；`HostAware` 插件展示每台主机的部署状态
- 参考插件 **xray**（HostAware）：GitHub release 抓取 + 按 OS/arch 缓存二进制 + 通过 filehandler 推送到主机 + systemd 接管守护进程
- 参考插件 **cloudflare**（纯服务端）：API token 存储 + Zones / DNS / Audit log 代理 UI
- 每插件的迁移机制串到运行时，让插件各自拥有自己的表

### 1.2 明确不做

- 第三方动态加载、签名、OCI 分发——不做市场。所有插件都是仓库里的首方 Go 包
- relay 插件——形态和 xray 几乎一样，做完 xray 再上能复用 80% 部署逻辑，归到 Phase 3b
- 插件代码热更新——重启服务即可，注册表在 `init()` 期间构建
- 插件可观测性（插件向 Shepherd 遥测系统回写指标）——延后
- 插件间事件 / pub-sub——延后

### 1.3 关键约束

- Shepherd 服务器需要可访问 `github.com`（用于下载 xray release）。失败时 UI 给出"重试"按钮，不自动重试
- 插件凭据（cloudflare API token、xray UUID/密码）明文存 SQLite/Postgres。当前 Shepherd DB 已经明文存 SSH 密码，本次不引入新的攻击面。响应序列化前对 `secret: true` 字段做 `"***"` 脱敏
- 主机端 xray 守护进程由 systemd 托管。Phase 3a 仅 Linux（Shepherd Phase 1 的唯一目标平台）；macOS launchd 集成与 relay 一起放到 3b

## 2. 架构

### 2.1 后端布局

```
internal/
  plugins/
    plugin.go           # Plugin 接口、Meta、Deps、HostAware
    registry.go         # 全局 Registry: Register / All / Get / Enabled
    deploy/
      pusher.go         # 通用「推二进制 + 写文件 + 控 systemd」工具
                        # 今天 xray 用,明天 relay 用
    xray/
      meta.go           # Meta() {ID, Name, Icon, Description}
      release.go        # GitHub release 索引 + 带 sha256 校验的下载
      deploy.go         # 实现 HostAware: DeployToHost / UndeployFromHost / HostStatus
      config.go         # 由模板请求构造 xray config.json,
                        # 或对 raw JSON 做 schema 校验后透传
      routes.go         # /api/admin/plugins/xray/* 处理器
      migrations/
        0001_xray.up.sql
        0001_xray.down.sql
    cloudflare/
      meta.go
      api.go            # 用 plugins.config_json 里的 token 调 api.cloudflare.com
      routes.go         # /api/admin/plugins/cloudflare/*
      # 3a 不带迁移——zones 按需拉取,进程内缓存
  api/
    plugins.go          # /api/admin/plugins 通用端点 (list/manifest/enable/...)
  db/migrations/
    0003_plugins.up.sql # 共享的 plugins + plugin_hosts 表
    0003_plugins.down.sql
```

### 2.2 Plugin 接口

```go
package plugins

type Meta struct {
    ID          string // 稳定标识,用于 URL 与 DB
    Name        string
    Description string
    Icon        string // lucide 图标名,透出到前端 manifest
    Category    string // "proxy" | "dns" | "system" | ...
    HostAware   bool   // 与接口断言一致;UI 用这个提示
}

type Migration struct {
    Name string
    SQL  string
}

type Deps struct {
    DB        *sqlx.DB
    Hub       *agentsvc.Hub        // 与在线 agent 通信
    Audit     *audit.Logger
    DataDir   string               // 例: data/plugins/<id>/
    Settings  *serversvc.SettingsStore
}

type Plugin interface {
    Meta() Meta
    Migrations() []Migration
    RegisterRoutes(r chi.Router, deps Deps)
    OnEnable(ctx context.Context, deps Deps) error
    OnDisable(ctx context.Context, deps Deps) error
}

// 可选能力:需要操作主机的插件实现这个
type HostAware interface {
    Plugin
    DeployToHost(ctx context.Context, deps Deps, serverID int64, configJSON []byte) error
    UndeployFromHost(ctx context.Context, deps Deps, serverID int64) error
    HostStatus(ctx context.Context, deps Deps, serverID int64) (HostStatus, error)
}

type HostStatus struct {
    State       string // pending | deploying | running | failed | stopped
    Version     string
    Message     string // 给 UI 显示的诊断信息
    CheckedAt   time.Time
}
```

插件在自己包的 `init()` 中注册：

```go
// internal/plugins/xray/xray.go
func init() { plugins.Register(&xrayPlugin{}) }
```

`cmd/server/main.go` 只 import 一次 `_ "github.com/hg-claw/Shepherd/internal/plugins/xray"`（cloudflare 同），完成后全局注册表就装好了。启动时 server 遍历 `plugins.All()`，跑共享 + 每插件迁移，把所有插件的路由都挂上去。每个插件子树上有中间件，当 `plugins.enabled = 0` 时返回 `404 plugin disabled`，因此启用/禁用切换从不需要重建路由（见 §4.4）。

### 2.3 前端布局

```
web/src/pages/admin/plugins/
  index.tsx            # 插件中心:列出所有已编译插件 + 启用/禁用按钮
  detail.tsx           # 通用详情壳: header + tabs (Config / Hosts / About)
  PluginRegistry.ts    # 静态映射: id -> { lazy(() => import('./xray')), labels, routes }
  xray/
    index.tsx          # default export = xray 插件的 React 路由
    HostsTab.tsx
    ConfigTab.tsx
  cloudflare/
    index.tsx
    ZonesTab.tsx
    DnsTab.tsx
```

shell 调一次 `/api/admin/plugins`，把响应（已启用 ID 列表 + 来自静态注册表的 UI 路由）合并进侧栏和 React Router 路由。禁用的插件路由不渲染。静态注册表是前端代码的唯一来源——服务端不分发动态 JS。

## 3. 数据模型

### 3.1 共享 schema (`db/migrations/0003_plugins.up.sql`)

```sql
CREATE TABLE plugins (
  id          TEXT      PRIMARY KEY,
  enabled     INTEGER   NOT NULL DEFAULT 0,
  config_json TEXT      NOT NULL DEFAULT '{}',
  enabled_at  TIMESTAMP,
  created_at  TIMESTAMP NOT NULL
);

CREATE TABLE plugin_hosts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id        TEXT    NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  server_id        INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  config_json      TEXT    NOT NULL DEFAULT '{}',
  deployed_version TEXT,
  status           TEXT    NOT NULL DEFAULT 'pending', -- pending|deploying|running|failed|stopped
  last_error       TEXT,
  updated_at       TIMESTAMP NOT NULL,
  UNIQUE(plugin_id, server_id)
);
CREATE INDEX plugin_hosts_plugin ON plugin_hosts(plugin_id);

-- 跟踪每个插件的迁移已应用情况。同一表中按 plugin_id 划分命名空间,
-- 同一插件内迁移名必须唯一。
CREATE TABLE plugin_migrations (
  plugin_id  TEXT      NOT NULL,
  name       TEXT      NOT NULL,
  applied_at TIMESTAMP NOT NULL,
  PRIMARY KEY (plugin_id, name)
);
```

### 3.2 xray 插件自带 schema

```sql
CREATE TABLE xray_binaries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  version       TEXT    NOT NULL,
  os            TEXT    NOT NULL, -- linux
  arch          TEXT    NOT NULL, -- amd64 | arm64
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT    NOT NULL,
  path          TEXT    NOT NULL, -- 绝对路径,在 deps.DataDir/<id>/cache 下
  downloaded_at TIMESTAMP NOT NULL,
  UNIQUE(version, os, arch)
);
```

cloudflare 当前不需要自己的表；zones 按需获取并在请求生命周期内做进程内缓存。如果后续证明需要缓存表，再以 `cloudflare/migrations/0001_cf.up.sql` 落地。

### 3.3 Postgres 方言

平行的 `db/migrations/postgres/0003_plugins.up.sql` 用项目现有的翻译约定镜像 schema（`AUTOINCREMENT` → `BIGSERIAL`，布尔字段维持 `INTEGER NOT NULL DEFAULT 0`，`TIMESTAMP` → `TIMESTAMPTZ`）。每插件迁移也同样处理。

## 4. 生命周期

### 4.1 启用 / 禁用插件

`POST /api/admin/plugins/{id}/enable`：

1. 在进程内注册表查找插件。未知返回 404
2. 事务内：如果 `plugins.id` 行不存在，插入（`enabled=0`、空 config）。如果已经 `enabled=1`，返回 200（幂等）
3. 用按 `plugin_id` 限定的迁移表（`plugin_migrations(plugin_id, name, applied_at)`）跑该插件尚未应用的迁移
4. 调 `OnEnable(ctx, deps)`。失败：回滚启用、写审计日志、返回 500
5. 置 `plugins.enabled=1`、`enabled_at=NOW()`。审计 `plugin.enabled`，details 包含 `{plugin_id}`
6. 触发路由刷新（见 §4.4）

`POST .../disable`：

1. 已禁用则幂等
2. HostAware 插件：遍历 `plugin_hosts` 中 `status IN (running, failed)` 的每行，尽力调 `UndeployFromHost`，失败记日志。不要因为主机离线而阻塞 disable——把那台机标 `stopped`，写 `last_error`
3. 调 `OnDisable(ctx, deps)`
4. 置 `plugins.enabled=0`，清 `enabled_at`。审计 `plugin.disabled`
5. 触发路由刷新

### 4.2 按主机部署（HostAware 插件，今天就是 xray）

`POST /api/admin/plugins/xray/hosts` body：

```json
{ "server_id": 7, "version": "1.8.11", "config": { ... } }
```

1. 检查插件是否启用——未启用 400
2. upsert `plugin_hosts(plugin_id="xray", server_id=7)` 行：`status="deploying"`，`deployed_version=null`，`last_error=null`。立即返回该行
3. 启动后台 goroutine（context 绑定到 server 生命周期，而非 request）：
   a. 确保 `(version, host.os, host.arch)` 在二进制缓存里。缺失则从
      `https://github.com/XTLS/Xray-core/releases/download/v{version}/Xray-{os}-{arch}.zip`
      下载，对照同目录 `dgst` 文件验证 sha256，解压到
      `data/plugins/xray/cache/{os}-{arch}/v{version}/xray`，插入一行 `xray_binaries`
   b. 用 `config` 渲染 config.json（模板或 raw——见 §5）
   c. 调 `internal/plugins/deploy.Pusher`：
      - filehandler PUT 二进制 → `/usr/local/bin/shepherd-xray`（mode 0755）
      - filehandler PUT 配置 → `/etc/shepherd-xray/config.json`（mode 0600）
      - filehandler PUT systemd unit → `/etc/systemd/system/shepherd-xray.service`
      - PTY exec `systemctl daemon-reload && systemctl enable --now shepherd-xray`
   d. 探测 `systemctl is-active shepherd-xray`。`active` 置 `status="running"`，
      其他置 `status="failed"` 并写 `last_error`
4. HTTP 调用方可轮询 `GET /api/admin/plugins/xray/hosts/{server_id}` 拿更新，
   或前端用现有 react-query 30s 自动重拉

重新部署 / 改配置走同一端点的 `PUT`。写完新配置后：

```
systemctl reload shepherd-xray || systemctl restart shepherd-xray
```

xray 并非所有场景都支持 SIGHUP reload——unit 文件里 `ExecReload` 设为 restart，所以 `reload` 语义始终正确（即便实际是 restart）。

### 4.3 插件 manifest 端点

`GET /api/admin/plugins` 返回：

```json
[
  {
    "id": "xray",
    "meta": {
      "name": "xray",
      "description": "在指定主机上以托管模式管理 xray-core 代理",
      "icon": "shield",
      "category": "proxy",
      "host_aware": true
    },
    "enabled": true,
    "enabled_at": "2026-05-16T10:11:12Z",
    "host_count": 4
  },
  {
    "id": "cloudflare",
    "meta": { "name": "Cloudflare", "icon": "cloud", "category": "dns", "host_aware": false },
    "enabled": false,
    "enabled_at": null,
    "host_count": null
  }
]
```

前端用响应交叉对照静态 `PluginRegistry.ts`，决定挂载哪个 lazy 模块、暴露哪些侧栏入口和路由。

### 4.4 路由刷新

HTTP 路由是启动时构造的 `chi.Mux`。插件路由在启动期就挂载到 `/api/admin/plugins/{id}/...`（始终可达），每个插件的 handler 用中间件包一层：当 `plugins.enabled` 为 0 时返回 `404 plugin disabled`。无需真正重建路由。前端隐藏禁用插件的 UI，所以这条 404 路径在应用层不可达。

## 5. xray 插件细节

### 5.1 二进制分发

- 插件代码里硬编 release URL 模板。运维不需要按部署配置模板
- `GET /api/admin/plugins/xray/versions` 返回缓存版本表，外加可选项「从
  `GET https://api.github.com/repos/XTLS/Xray-core/releases?per_page=10` 抓最新 10 个 release tag」
- `POST /api/admin/plugins/xray/binaries` `{version, os, arch}` 触发下载到缓存。
  流式写入 `data/plugins/xray/cache/{os}-{arch}/v{version}/xray.zip`，解压，对照官方
  `Xray-{os}-{arch}.zip.dgst` 校验 sha256。sha256 不匹配则删缓存返回 500
- 禁用插件时缓存保留；`OnDisable` 只清 cloudflare 那类纯状态

### 5.2 配置 UI

主机配置页面双 tab 编辑器：

- **模板**（默认）——admin 选 inbound 预设（VLESS+REALITY / VMess+WS / Shadowsocks），
  填端口、UUID、sni 等关键字段。服务端 `config.go` `Render(template, fields) -> xrayConfig`
  返回规范化 JSON
- **Raw**——纯 `<textarea>` 配 monospace 字体 + tab-to-spaces 处理器。校验只在服务端：
  插件把提交的 JSON 写到 `/tmp/<sid>` 目录后调 `xray run -test -confdir /tmp/<sid>`，
  把 xray 自身的错误文本透传给客户端。不打包 xray 的 schema——用 xray 自己的校验器才是
  真理之源，避免 schema 漂移

UUID 和密码字段标 `secret: true`——从服务端回来都是 `"***"`，admin 必须明确切换"编辑"才能
重新输入。保存时只有真正编辑过、不是 `"***"` 的字段才发回服务端

### 5.3 systemd unit

`internal/plugins/xray/unit.tmpl` 内嵌：

```ini
[Unit]
Description=Shepherd-managed xray
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/shepherd-xray run -c /etc/shepherd-xray/config.json
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

## 6. cloudflare 插件细节

### 6.1 全局配置

`plugins.config_json` schema：

```json
{
  "api_token": "***",
  "account_id": "可选,用于 account-scoped 操作"
}
```

`api_token` 标 `secret: true`。

### 6.2 端点（全部位于 `/api/admin/plugins/cloudflare/`）

- `GET /zones` —— 透传 `GET https://api.cloudflare.com/client/v4/zones?per_page=50`，
  每进程缓存 60s
- `GET /zones/{id}/records` —— 透传
- `POST /zones/{id}/records` —— body 同 CF 的 create-record schema；透传
- `PATCH /zones/{id}/records/{rid}` —— 透传
- `DELETE /zones/{id}/records/{rid}` —— 透传
- `GET /audit?since=...` —— 取最近 N 天 CF audit log（account scope）

所有请求服务端发出；admin 浏览器永不接触 API token。CF 的错误映射到我方 4xx/5xx，
body 里带上 CF 的错误码。

### 6.3 UI tabs（在 `pages/admin/plugins/cloudflare/` 下）

- **Setup**：API token 表单（未配置时显示，或通过 edit 进入）
- **Zones**：zones 表格（name、plan、name servers）
- **DNS records**：zone 选择器 + records 表格，行内增删改
- **Activity**：最近 CF audit log 条目（admin 上下文）

## 7. API 表面汇总

通用：

```
GET    /api/admin/plugins                       # 带 manifest 的列表
POST   /api/admin/plugins/{id}/enable
POST   /api/admin/plugins/{id}/disable
GET    /api/admin/plugins/{id}/config           # 全局 config (secrets 脱敏)
PUT    /api/admin/plugins/{id}/config
GET    /api/admin/plugins/{id}/hosts            # HostAware 才有,否则 404
POST   /api/admin/plugins/{id}/hosts            # 部署
PUT    /api/admin/plugins/{id}/hosts/{server_id}
DELETE /api/admin/plugins/{id}/hosts/{server_id}
GET    /api/admin/plugins/{id}/hosts/{server_id}
```

每插件特有：

```
# xray
GET    /api/admin/plugins/xray/versions         # 缓存 + 最新 10 tag
POST   /api/admin/plugins/xray/binaries         # 触发下载 {version, os, arch}
GET    /api/admin/plugins/xray/binaries         # 缓存清单

# cloudflare
GET    /api/admin/plugins/cloudflare/zones
GET    /api/admin/plugins/cloudflare/zones/{id}/records
POST   /api/admin/plugins/cloudflare/zones/{id}/records
PATCH  /api/admin/plugins/cloudflare/zones/{id}/records/{rid}
DELETE /api/admin/plugins/cloudflare/zones/{id}/records/{rid}
GET    /api/admin/plugins/cloudflare/audit
```

## 8. 错误处理

- 启用 / 禁用：失败回滚 DB 行，返回 JSON `{error, code}`；审计日志始终记录尝试
- 部署操作：HTTP 立即 200 返回（deploying 行）。真实状态走轮询查 host 端点。
  后台 goroutine 写 `status=failed, last_error=…`，前端在 Hosts tab 红色显示
- xray 二进制下载：sha256 不匹配是唯一致命错误；瞬时网络错误返回 `code: "download_failed"`，
  客户端可重试
- cloudflare 透传：CF API 错误包装为：
  ```json
  { "error": "CF API: <code> <message>", "code": "cloudflare_api_error" }
  ```
- 插件未启用：`/api/admin/plugins/{id}/...` 下的所有路径（除共享 `enable` / `config` 端点）返回 404

## 9. 测试

- `internal/plugins`：单元测试覆盖 registry、生命周期顺序、迁移 runner
- `internal/plugins/xray/release_test.go`：GitHub release 索引解析 + sha256 校验，用小 fixture
- `internal/plugins/xray/deploy_test.go`：对接 fake `Pusher` 接口记录操作。
  验证 systemd unit 模板渲染正确
- `internal/plugins/cloudflare/api_test.go`：用 httptest 假装 api.cloudflare.com，
  验证 token 转发、响应脱敏、错误映射
- `internal/api/plugins_test.go`：用两个 fake 注册插件（一个 HostAware、一个不是）端到端
  测启用/禁用/manifest
- 前端：插件中心首页的渲染测试（用 MSW stub `/api/admin/plugins`）

不做真 xray 的端到端测试；那需要 Linux VM 和真实 systemd。手工冒烟 checklist 写在实现 plan 里。

## 10. 后续 phase 推迟项

- relay 插件（3b）
- xray 在 macOS 上走 launchd（3b）
- 插件指标回写 Shepherd 遥测（如 xray 连接数）——需要 plugin → telemetrysvc 桥
- 插件更新提醒（检测到新 xray release）
- 单台主机多版本共存（今天只支持每台一个部署版本）
- 第三方插件的 sidecar / WASM 模型（3c，如果真有那天）
