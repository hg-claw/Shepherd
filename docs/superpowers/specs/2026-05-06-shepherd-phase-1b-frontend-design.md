# Shepherd — Phase 1.B 设计：React SPA 前端

- **日期**：2026-05-06
- **范围**：Phase 1 路线图中的 1.B（公共监控墙 + admin 面板）
- **依赖**：Phase 1.A 已合并到 main（commit `5e8897a`）。本 spec 在不破坏现有后端契约的前提下，**仅新增**一个查询参数（见 §11）。
- **后续**：Phase 1.C — Docker Compose、Caddyfile、跨编 Makefile、GitHub release CI

---

## 1. 目标 / 非目标

### 1.1 目标

- 把 Phase 1.A 后端的能力暴露成可用的 Web UI：
  - **公共监控墙**（`/`）：按分组卡片网格，CPU/MEM/DISK/NET 4 个核心指标，三档展示模式（raw / level / both）
  - **公共详情页**（`/public/servers/:id`）：1h / 24h / 7d 切换 + 时序图（CPU / MEM / NET / Load / TCP）
  - **Admin 登录** + **dashboard** + **server CRUD** + **装机表单（含进度）** + **设置页**
- 单二进制部署：`go:embed` 把 `dist/` 打进 `cmd/server`，SPA fallback 接管前端路由
- 中英双语，浅 / 深 / 跟随系统主题
- 与 Phase 1.A 的 zero-credential / 反向 WS / 公共脱敏契约**严格一致**

### 1.2 非目标（明确排除）

- PTY 终端、脚本下发、文件上传/下载 UI → Phase 2
- 插件中心 UI → Phase 3
- xray、relay 的管理面 → Phase 4/5
- 告警面板 → Phase 6
- E2E 浏览器测试（Playwright）→ v2
- 完整单元测试覆盖率（Vitest 装好，关键组件 smoke 测试即可）
- 后端任何**新接口**或**字段**变更（仅允许 §11 列出的一个 `?with=latest` 查询参数）

---

## 2. 技术栈

| 层 | 选型 | 备注 |
|---|---|---|
| 框架 | React 19 + TS + Vite | spec §3 已锁 |
| CSS | Tailwind 3，`darkMode: 'class'` | spec §3 已锁 |
| 路由 | `react-router-dom@6` 经典 `<Routes>` | 不用 data router |
| 服务端状态 | `@tanstack/react-query` v5 | spec §3 已锁 |
| 客户端状态 | `zustand` v5 | auth user / theme / lang / toast 队列 |
| 表单 | `react-hook-form` + `zod` | install 表单和 settings 表单都走 RHF |
| i18n | `react-i18next` + `i18next-browser-languagedetector` | 默认 `zh-CN`，备用 `en` |
| 图标 | `lucide-react` | 仅按需 import |
| UI 组件 | `shadcn/ui` (CLI 生成) | 按需添加，依赖 `@radix-ui/*`、`cva`、`clsx`、`tailwind-merge` |
| 测试 | Vitest + @testing-library/react | 关键组件 smoke 测试 |
| 构建 | `vite build` 输出到 `internal/web/dist/`（**不是** `web/dist`） | 让 `go:embed all:dist/*` 直接捕获 |

---

## 3. 文件布局

```
web/                                # 前端源
  index.html
  package.json
  vite.config.ts
  tsconfig.json
  tailwind.config.ts
  postcss.config.js
  components.json                   # shadcn 配置
  .gitignore                        # node_modules、本地 .env
  src/
    main.tsx                        # 入口，挂 QueryClientProvider + I18nextProvider + RouterProvider
    App.tsx                         # <Routes> 树
    index.css                       # @tailwind directives + shadcn CSS 变量
    i18n.ts                         # i18next 初始化，加载 locales/*.json
    api/
      client.ts                    # fetch 封装：baseURL（dev=http://localhost:8080，prod=同源）、credentials: 'include'、401 拦截
      auth.ts                      # login / logout / me
      servers.ts                   # servers CRUD + install + repair + config + telemetry
      public.ts                    # public/servers + public/telemetry + public/settings
      settings.ts                  # admin /api/settings GET/PATCH
    components/
      ui/                          # shadcn copies — button / card / input / label / select / table / dialog / toast / tabs / dropdown-menu / sheet / badge / progress
      MetricCard.tsx               # 公共卡片单台
      MetricBadge.tsx              # raw / level / both 渲染（共享给 admin dashboard）
      Sparkline.tsx                # 公共详情 + admin 详情用，60×16 SVG
      TimeSeriesChart.tsx          # 详情页大图 SVG（带 X/Y 轴 + tooltip on hover）
      OnlineDot.tsx                # 在线/离线 8×8 圆点
      CountryFlag.tsx              # ISO alpha-2 → emoji
      ThemeToggle.tsx              # 三态切换
      LangToggle.tsx
      InstallProgress.tsx          # 装机日志流式渲染（pre-formatted，autoscroll）
      RequireAdmin.tsx             # 路由守卫
      Toaster.tsx                  # 监听 ui store toast 队列
    layouts/
      PublicLayout.tsx             # 顶栏（logo + 主题/语言切换）+ 内容
      AdminLayout.tsx              # 顶栏 + 侧边导航 + 内容
    pages/
      public/
        Wall.tsx                   # /
        ServerDetail.tsx           # /public/servers/:id
      admin/
        Login.tsx                  # /admin/login
        Dashboard.tsx              # /admin/dashboard
        ServerList.tsx             # /admin/servers
        ServerNew.tsx              # /admin/servers/new
        ServerDetail.tsx           # /admin/servers/:id
        Settings.tsx               # /admin/settings
    store/
      auth.ts                      # zustand：admin?, isLoaded, setAdmin, clear
      ui.ts                        # zustand：theme/lang/toasts，persist 到 localStorage
    locales/
      zh-CN.json                   # 默认
      en.json
    lib/
      utils.ts                     # cn() 合并 className（shadcn 标准）
      bytes.ts                     # bytes / bps 人类可读
      time.ts                      # relative time（"5 分钟前"）+ 范围格式化
      thresholds.ts                # 把 spec §9.4 的阈值表搬过来
      country.ts                   # ISO 国家码到 emoji 国旗的转换
internal/web/                      # Go 端嵌入 + 静态服务
  embed.go                         # //go:embed all:dist/* + Handler()
  dist/
    .gitkeep                       # 让 embed 在前端未编译时也能跑
    index.html                     # 占位首页（"前端未构建" 提示），构建后被覆盖
```

> `web/` 与 `internal/web/dist/` 分离的原因：Go 的 `go:embed` 路径必须在包目录内，所以 `dist/` 输出到 `internal/web/dist/`。`web/` 是源；构建产物通过 `vite.config.ts` 的 `build.outDir: '../internal/web/dist'` 写到 Go 端。

---

## 4. 路由表

| 路径 | 守卫 | 内容 |
|---|---|---|
| `/` | 公开 | Wall — 监控墙 |
| `/public/servers/:id` | 公开 | 公共详情（仅 `show_on_public=true` 的服务器；否则 404） |
| `/admin/login` | 公开 | 登录表单 |
| `/admin/dashboard` | RequireAdmin | fleet 概览 |
| `/admin/servers` | RequireAdmin | 服务器列表 + 操作入口 |
| `/admin/servers/new` | RequireAdmin | 装机表单（POST install） |
| `/admin/servers/:id` | RequireAdmin | 详情：完整指标 + repair + config 间隔 + 删除 |
| `/admin/settings` | RequireAdmin | 设置（公共展示模式 + 保留期） |
| `*` | 公开 | 404 页（中英文） |

`AdminLayout` 自带顶栏（admin 用户名 + 登出按钮 + 主题切换 + 语言切换）和侧边导航（Dashboard / Servers / Settings）。  
`PublicLayout` 顶栏只有 logo + 主题切换 + 语言切换。

---

## 5. 状态管理

### 5.1 服务端状态（react-query）

| 数据 | Key | TTL / refetch |
|---|---|---|
| `admins/me` | `['me']` | staleTime 5min；首次 fetch 在 App 挂载时触发 |
| 公共服务器列表 | `['public-servers']` | `refetchInterval: 30_000` |
| 公共时序 | `['public-telemetry', id, range]` | range=1h→30s, 24h→5m, 7d→30m |
| 公共 settings | `['public-settings']` | staleTime 5min |
| Admin 服务器列表 | `['servers']` | `refetchInterval: 30_000`（dashboard 也用此 key） |
| Admin 服务器详情 | `['server', id]` | 装机中：`refetchInterval: 1500`；done 后：30s |
| Admin 时序 | `['admin-telemetry', id, range]` | 同公共 |
| Admin settings | `['settings']` | staleTime 5min |

react-query 全局 `onError`：401 → 清 auth store + 跳 `/admin/login`（仅当当前路径在 `/admin/*` 下，避免误踢公共页）。

### 5.2 客户端状态（zustand）

```ts
// store/auth.ts
type AuthState = {
  admin: { id: number; username: string } | null
  isLoaded: boolean              // 首次 me 请求完成后 true
  setAdmin(a: Admin | null): void
  clear(): void
}
```

```ts
// store/ui.ts — persist 到 localStorage 'shepherd-ui'
type UIState = {
  themeMode: 'system' | 'light' | 'dark'
  lang: 'zh-CN' | 'en'
  toasts: Toast[]               // {id, kind: 'info'|'error'|'success', message}
  setTheme(m: ThemeMode): void
  setLang(l: Lang): void
  toast(kind, message): void
  dismissToast(id): void
}
```

主题应用：`useEffect` 监听 `themeMode` 和 `prefers-color-scheme`，给 `document.documentElement` 加/去 `dark` class。

---

## 6. 公共监控墙

### 6.1 数据流

`GET /api/public/settings` → `public_display_mode`（raw / level / both）  
`GET /api/public/servers` → `[{id, alias, group, country_code, online, latest}]`

按 `group` 分组（无 group 的归"未分组"），组内按 `alias` 字典序，组间按组名字典序。

### 6.2 卡片设计

```
┌───────────────────────────────┐
│ 🇭🇰 HK-1               ●     │  ← alias + 国旗 + 在线点（spec §9.2 阈值）
├───────────────────────────────┤
│ CPU      ▓▓▓▓░░░░  42%        │  ← raw 模式
│ MEM      ▓▓▓▓▓▓░░  68%        │
│ DISK     ▓▓░░░░░░  21%        │
│ NET ↓ 1.2 MB/s  ↑ 340 KB/s    │
└───────────────────────────────┘
```

`level` 模式把进度条换成 4 档色块（绿/黄/橙/红，spec §9.4 阈值）；`both` 模式两者都显示。

### 6.3 离线服务器

`online=false` 的卡片显示灰色调，金属点改红色，指标显示最后一次的值（带"最后更新 X 分钟前"提示）。

---

## 7. 公共详情页

`/public/servers/:id` —— 顶栏 alias + 国旗 + 在线状态 + range 切换 (1h / 24h / 7d)。

下方 5 个 `TimeSeriesChart`：
- CPU%（0-100 区间，单线）
- 内存（已用 / 总量，双线或填充）
- 网络（rx / tx 双线）
- Load1（自适应 Y 轴）
- TCP 连接数

`TimeSeriesChart` 是手写 SVG：宽度自适应容器、固定高 120px、X 轴 5 个时间刻度、Y 轴 4 个数值刻度、hover 显示 tooltip（鼠标 X 坐标对应到最近的数据点）。**不引入 recharts/d3**（包体积考虑）。

如果 `show_on_public=false`，后端返回 404，前端显示"未找到"页。

---

## 8. Admin 登录

`POST /api/login` body `{username, password}`，成功设置 cookie + 200 响应 `{id, username}`。

react-hook-form + zod 校验：`username` 非空、`password` 非空。失败 toast 显示 401 错误（"用户名或密码错误"）。

成功后：`useAuth().setAdmin(...)`、`queryClient.invalidateQueries(['me'])`、`navigate('/admin/dashboard')`。

---

## 9. Admin Dashboard

`GET /api/servers?with=latest` 返回每台 server 的完整字段 + 一个 `latest` 子对象（见 §11）。客户端聚合：

- **总台数 / 在线 / 离线** 三块大数字
- **告警计数**：CPU/MEM/DISK 任一进入"告警"档位的服务器数（spec §9.4 阈值）
- **CPU Top 5 / MEM Top 5**：表格行，列出 alias 或 name，数值条
- **最近告警**（v2）：留 placeholder 卡片，显示"暂无"

如果 `latest` 为空（agent 未上线或刚装好），显示连字符 `-`。

---

## 10. Admin Servers 列表 / 装机 / 详情

### 10.1 列表

`GET /api/servers?with=latest` → 表格列：

| name | ssh_host | os/arch | install_stage | agent_last_seen | CPU | MEM | DISK | 操作 |
|---|---|---|---|---|---|---|---|---|

操作列：详情 / 删除（带 dialog 确认）。顶栏右侧 "添加服务器" 按钮 → `/admin/servers/new`。

筛选条件（仅前端）：搜索框（按 name / ssh_host）、stage 过滤（pending / installing / done / failed）。

### 10.2 装机表单

字段：`name`（必填）、`ssh_host`（必填）、`ssh_port`（默认 22）、`ssh_user`（必填）、`ssh_password` **xor** `ssh_key`、`arch`（amd64 / arm64）、`public_alias`（选填）、`public_group`（选填）、`country_code`（选填，2 字符大写）、`show_on_public`（开关）。

提交 → `POST /api/servers/install` → `navigate(\`/admin/servers/\${server_id}\`)`。

### 10.3 详情

- **顶部状态栏**：在线/离线点 + last_seen 相对时间 + 4 指标当前值
- **装机进度块**（仅当 `install_stage === 'installing'` 或 `failed`）：`InstallProgress` 组件读 `install_log`，按 1.5s 轮询。`done` 后变成可折叠的"装机历史"
- **时序图区**：跟公共详情同构，但显示完整字段 + 内部 name / ssh_host / fingerprint
- **操作面板**：
  - "Re-pair agent"：`POST /api/servers/:id/repair` → 显示新 enrollment_token + 过期时间，点 "复制" 按钮
  - "采样间隔"：input + Slider（5-3600s）→ `POST /api/servers/:id/config`，409（agent 离线）显示 toast
  - "删除"：dialog 二次确认 → `DELETE /api/servers/:id` → `navigate('/admin/servers')`
- **公共展示开关**：编辑 `public_alias` / `public_group` / `country_code` / `show_on_public` → `PATCH /api/servers/:id`（按字段 onBlur 自动保存，or 一键"保存"按钮——选 onBlur）

---

## 11. Admin Settings

GET 当前 `settings` 表所有 KV，按 spec 已知 key 列出表单：

- `public_display_mode`：单选 raw / level / both
- `retention_30s` / `retention_5m` / `retention_1h`：duration 字符串输入（zod 校验 `^\d+(s|m|h|d)$` 然后 `time.ParseDuration`-friendly 格式）
- `default_telemetry_interval_seconds`：number input（5-3600）

提交：`PATCH /api/settings` 带 only-changed 字段。

---

## 12. 后端唯一改动：`?with=latest`

为了让 dashboard / 列表少打一倍请求，给 `GET /api/servers` 增加一个**查询参数**：

```
GET /api/servers?with=latest
```

响应每台 server 多一个字段：

```jsonc
{
  ...同原响应...,
  "latest": {                  // null if no telemetry yet
    "ts": "2026-05-06T...",
    "cpu_pct": 12.4,
    "mem_used": 4123456789,
    "mem_total": 16777216000,
    "load_1": 0.42,
    "net_rx_bps": 184320,
    "net_tx_bps": 92160,
    "tcp_conn": 184,
    "disks_json": "[{...}]"
  }
}
```

实现：`internal/api/admin_servers.go` 的 `List` handler 检查 `r.URL.Query().Get("with") == "latest"`，如是则对每个 server 调用 `telemetrysvc.Query.Latest()`。  
**不**改 `Server` 结构体本身；用一个 anonymous 包装结构体输出，保持原响应不变（兼容现有调用方）。

测试：在 `internal/api/admin_servers_test.go` 新增 `TestServersList_WithLatest`。

---

## 13. 嵌入 + SPA Fallback

### 13.1 `internal/web/embed.go`

```go
package web

import (
    "embed"
    "io/fs"
    "net/http"
    "strings"
)

//go:embed all:dist/*
var distFS embed.FS

func Handler() http.Handler {
    sub, err := fs.Sub(distFS, "dist")
    if err != nil {
        panic(err)
    }
    fileServer := http.FileServer(http.FS(sub))
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // 静态资源（含 . 即视为带扩展名的文件）直接走 FileServer
        if strings.Contains(r.URL.Path[1:], ".") {
            fileServer.ServeHTTP(w, r)
            return
        }
        // 其它都返回 index.html，交给 React Router
        b, err := fs.ReadFile(sub, "index.html")
        if err != nil {
            // 前端还没构建（dist/ 只有 .gitkeep）— 显示提示
            w.Header().Set("Content-Type", "text/html; charset=utf-8")
            _, _ = w.Write([]byte(`<!doctype html><title>Shepherd</title><h1>Shepherd</h1><p>frontend not built — run <code>make web</code> and restart the server.</p>`))
            return
        }
        w.Header().Set("Content-Type", "text/html; charset=utf-8")
        w.Header().Set("Cache-Control", "no-cache")
        _, _ = w.Write(b)
    })
}
```

> `//go:embed all:dist/*` 要求 `dist/` 至少有一个文件 → 只要 `.gitkeep` 在 git 里就一直满足。`vite build` 会执行 `emptyOutDir: true`，把 `.gitkeep` 删掉，但同时写入真正的 `index.html` + `assets/`，pattern 仍命中。两种状态都跑得起来。

### 13.2 `internal/api/router.go` 末尾追加

```go
import shepweb "github.com/hg-claw/Shepherd/internal/web"

// ...在所有 API 路由之后：
mux.Handle("/", shepweb.Handler())
```

但要小心：`/api/public/*` 等路径已经显式注册，会优先匹配；`/` 是 catch-all。验证 Go 1.22 ServeMux 路由优先级是按"最具体"匹配，确认无误。

### 13.3 占位文件 + .gitignore

只需要一个占位：`internal/web/dist/.gitkeep`（空文件）。

`.gitignore` 规则（追加到根 `.gitignore`）：

```
/internal/web/dist/*
!/internal/web/dist/.gitkeep
```

- 干净 checkout：`.gitkeep` 在 git 里 → embed pattern 命中。Handler 见到没有 `index.html` → 渲染"前端未构建"提示。
- `make web` 后：vite `emptyOutDir: true` 把 `.gitkeep` 清掉，写入真正的 `index.html` + `assets/`。pattern 命中真实文件，正常服务。
- `git status` 在构建后是干净的（除 `.gitkeep` 外的 `dist/` 都被 `.gitignore` 排除）。

### 13.4 Makefile 更新

```make
.PHONY: web server agent test fmt vet tidy

web:
	cd web && npm install && npm run build

server: web
	go build -o bin/shepherd-server ./cmd/server

agent:
	go build -o bin/shepherd-agent ./cmd/agent

# CI / dev 不强依赖 npm 时跳过 web 构建：
server-no-web:
	go build -o bin/shepherd-server ./cmd/server
```

`server-no-web` 是给 `go test ./...` 用的（embed FS 会回退到占位 index.html，正确）。

---

## 14. 开发环境

`vite.config.ts` proxy：

```ts
server: {
  port: 5173,
  proxy: {
    '/api': { target: 'http://localhost:8080', changeOrigin: false },
    '/agent': { target: 'http://localhost:8080', changeOrigin: false, ws: true },
  },
},
build: {
  outDir: '../internal/web/dist',
  emptyOutDir: true,
},
```

开发流程：
1. 跑后端：`./bin/shepherd-server` (端口 8080)
2. 跑前端：`cd web && npm run dev`（端口 5173，proxy 转 /api 到 8080）
3. 浏览器打开 http://localhost:5173

构建流程：
1. `make web`（输出到 `internal/web/dist/`）
2. `make server`（embed dist 进二进制）
3. 运行 `./bin/shepherd-server`，浏览器 http://localhost:8080 同时拿到前后端

---

## 15. 测试 / 出口标准

### 15.1 单元

- `lib/bytes.ts` / `lib/time.ts` / `lib/thresholds.ts` 100% 表驱动测试
- `MetricBadge.tsx` 三种 mode 的渲染分支
- `RequireAdmin.tsx` 重定向逻辑
- `api/client.ts` 401 拦截器

### 15.2 后端单元

- `TestServersList_WithLatest`：插入 1 个 server + 1 条 telemetry，调 `?with=latest`，断言 `latest.cpu_pct` 命中。

### 15.3 端到端冒烟（手工）

延续 `scripts/smoke.sh` 的精神。新增 `scripts/web-smoke.sh`：
1. `make web && make server`
2. 跑 server，浏览器打开 http://localhost:8080
3. 看到登录页 / 公共墙加载
4. 用 alice/hunter2 登录
5. 走完装一台机 → 看到装机进度 → done → 在 dashboard / 公共墙看到该机
6. 切语言、切主题，验证状态持久

### 15.4 出口标准

- `make web && make server && ./bin/shepherd-server` 后浏览器打开能看到完整 UI（默认中文深色主题）
- 公共页脱敏（前端不显示 IP / hostname / fingerprint，浏览器开发者工具网络面板里也没出现这些字段）
- `go test ./...` 全绿（含新加的 `TestServersList_WithLatest`）
- `cd web && npm test` 单元测试全绿
- 关键路径手工测过：公共墙、详情、登录、装机、设置改动、re-pair、config 推送

---

## 16. 风险 / 已知 gap

| 项 | 风险 | 缓解 |
|---|---|---|
| 包体积 | shadcn 全装 + i18next + react-query + RHF 可能 > 600KB gzipped | 按需 import；监控 `dist/` 大小，超过 500KB gzipped 报警；用 vite-bundle-visualizer 排查 |
| SVG 时序图实现复杂度 | 手写 axis/tooltip 比库慢 | Phase 1 接受朴素实现，v2 评估迁到 lightweight chart 库（Apache ECharts 不在选项内 — 太大） |
| dashboard 客户端聚合 N 服务器 | O(N) react-query 查询 | 列表已带 `?with=latest`，单次请求拿全部最新数据；不需要 N 次查询 |
| `?with=latest` 的 N+1 SQL | 每台一次 `SELECT ... ORDER BY ts DESC LIMIT 1` | Phase 1 fleet O(100) 可接受；v2 用 `SELECT DISTINCT ON (server_id) ...`（PG）或 window function |
| 占位 `index.html` 在测试环境的语义 | `go test` 不构建前端，浏览器到 `/` 看到提示页 | 文档化即可；`server-no-web` make 目标支持纯后端构建 |
| 安全：CSP | 内联 style/script 的 vite 默认产物可能违反 CSP | Phase 1 不强 CSP，反代层加 `default-src 'self'`；本 spec 标记 v2 完善 |

---

## 17. v2 / 之后

- E2E Playwright 测试
- bundle splitting / route-based code splitting（react.lazy）
- CSP header（在反代层）
- 真实图表库评估
- 多语言扩展（日语等）
- a11y 审计 — 蓝色 / 红色对色盲不友好的修正
