# Frontend Design Standardization — Design

**Date:** 2026-07-06
**Scope:** `web/` (desktop admin UI). Mobile app (`mobile/`) is out of scope.
**Goal:** 不改视觉风格，把现有设计 token 体系落实到位：消除硬编码颜色/字号，收敛重复组件，统一表格/徽章/按钮/空状态等界面模式，并顺带做交互细节、列表体验和性能优化。

## Background (audit findings)

现状调研结论（2026-07-06）：

- 设计 token 体系已完善（语义色、`ok/warn/err`、`bg-elev/bg-sunken`、深浅两套变量、Geist 字体、6px 圆角），但落地不彻底。
- 硬编码颜色约 30+ 处：ConsoleDock 整套 zinc/hex（`bg-[#09090b]`、`text-zinc-100`）、图表 SVG hex 原色（`#3b82f6`、`#22c55e`）、`text-green-600`/`bg-yellow-100`/`bg-emerald-500` 等散落各页，破坏深色模式。
- 徽章三套（`Pill`/`MetricBadge`/`Badge`）、指标卡三套（`KpiCard`/`MetricCard`/`SummaryStat`）。
- 表格行 hover 有 4 种写法：`hover:bg-sunken/60`、`/70`、`hover:bg-muted/30`、`hover:bg-elev`。
- 字号任意值 700+ 处：`text-[11px]` 240、`text-[12px]` 361、`text-[13px]` 111，另有 `11.5px`/`12.5px` 半像素值。
- 无统一 Loading / 空状态 / 错误状态组件。
- 按钮尺寸混用：`h-8`/`h-7`/`h-6`/`h-[26px]`。
- 插件页一致性参差：netquality 最差（自定义图表+特殊字号），singbox/xray 次之，sshaudit/subgen/cloudflare 基本达标。

## Approach

分层推进，单 spec，4 个阶段，每阶段可独立合入：

1. 规范层（token + 共享组件 + 防回退检查）
2. 逐页面收敛（主界面 → 插件 → ConsoleDock）
3. 交互细节 + 列表体验
4. 性能

## Phase 1 — 规范层

### 1.1 字号收敛为 4 档

在 `tailwind.config.ts` 的 `theme.extend.fontSize` 定义命名档位（覆盖默认 `xs`/`sm`）：

| 档位 | 值 | 用途 | 替换规则 |
|------|-----|------|---------|
| `text-2xs` | 11px | 辅助信息、mono 数据、徽章 | `text-[10px]`、`text-[10.5px]`、`text-[11px]`、`text-[11.5px]` → `text-2xs` |
| `text-xs` | 12px | 表格正文、密集内容 | `text-[12px]` → `text-xs` |
| `text-sm` | 13px | 常规正文、表单、说明 | `text-[12.5px]`、`text-[13px]` → `text-sm` |
| `text-lg` | 16px | 卡片次级数值 | `text-[16px]` → `text-lg` |
| `text-title` | 22px | 页面标题、卡片大数值 | `text-[22px]` → `text-title` |
| `text-display` | 26px | KPI 大数字 | `text-[26px]` → `text-display` |

归并规则：≤11.5px 一律归 `2xs`，12.5 → 13（`sm`）。line-height 随档位在 config 中一并定义（2xs: 16px, xs: 18px, sm: 20px, lg: 22px, title: 28px, display: 32px），替换后删除散落的 `leading-[..]` 任意值（与档位默认一致时）。

### 1.2 颜色全部走 token

- **图表色**：`index.css` 新增 `--chart-1..4`（浅/深两套值），`tailwind.config.ts` 暴露为 `chart.1..4`。替换 xray/singbox `TrafficDrawer` 的 SVG hex fill/stroke、`Sparkline`/`TimeSeriesChart`/netquality 图表内的硬编码色。SVG 属性处用 `hsl(var(--chart-1))` 字符串形式。
- **状态色**：一律 `ok/warn/err`（含 `-soft`）。替换 `text-green-600`/`text-amber-600`（singbox CertificatesTab）、`bg-yellow-100 dark:bg-yellow-900/40`（ServerDetail）、`text-yellow-500`（singbox InboundsTab）、`text-red-*`/`ring-red-400`（ui/toast.tsx destructive variant → `err` token）等。
- **ConsoleDock**：终端内容区保留"永远深色"外观（终端惯例），但改用 `index.css` 中新增的 `--console-bg`/`--console-fg`/`--console-muted`/`--console-elev` token（两主题下取值可相同或微调）；标签栏、按钮等外壳改用标准 token（`bg-elev`、`text-foreground`、`bg-ok` 等），在线状态点从 `bg-emerald-400` 改为 `bg-ok`。

### 1.3 组件收敛

- **状态徽章**：`Pill` 是唯一状态徽章组件。`MetricBadge` 保留（用途不同：数值+等级），但其 level→颜色映射改为与 Pill 共用同一模块导出的映射表。shadcn `Badge` 只用于非状态标签（tag、计数）。各页手写状态色全部换成 `Pill`。
- **指标卡**：`KpiCard`/`SummaryStat` 合并为 `StatCard`（props: `label`、`value`、`sub?`、`icon?`、`tone?`、`variant?: 'kpi' | 'compact'`），旧两个组件删除、调用点迁移。（注：`MetricCard` 是公开墙的服务器卡片，用途不同，不参与合并，仅做字号/颜色 token 化。）
- **`EmptyState`**（新增）：`icon?` + `title` + `description?` + `action?`（按钮插槽）。两种语境：真空（无数据，配引导操作）与筛选无结果（配"清除筛选"）。
- **`LoadingState`**（新增）：统一 `text-sm text-muted-foreground` + spinner，可选 skeleton 行模式（表格用）。
- **`ErrorState`**（新增）：错误文案 + 重试按钮。
- **`PageHeader`**（新增）：`title` + `actions?` 插槽，内部 `text-title font-semibold tracking-tight`；所有页面头部迁移。
- **`ConfirmDialog`**（新增）：基于 shadcn Dialog 的 destructive 确认（标题/描述/确认按钮 destructive variant），替换各处自写确认逻辑。

### 1.4 表格与按钮约定

- 表格统一基于 `ui/table.tsx`；行 hover 统一 `hover:bg-sunken/60`；统一行高与单元格 padding；空状态行内嵌 `EmptyState`、加载行内嵌 `LoadingState`（skeleton 模式）。
- 按钮尺寸：页面级操作 `h-8`；表格行内 `h-7`；图标按钮 `h-7 w-7`；插件 tab 的 `h-[26px]` 归入 `h-7`。写入 `web/DESIGN.md` 约定文档（新建，简短一页：字号档位、颜色 token 用法、组件选型决策树、按钮尺寸、表格模式）。

### 1.5 防回退检查

新增 `scripts/check-ui-tokens.sh`：grep `web/src` 禁用模式——任意值字号 `text-\[[0-9.]+px\]`、Tailwind 原色（`(bg|text|border)-(red|green|blue|yellow|amber|emerald|zinc|gray|slate)-[0-9]`）、hex 颜色类 `\[#[0-9a-fA-F]{3,8}\]`。白名单机制（如确需的特例加注释标记）。挂进 `Makefile` 的 lint 目标与 CI。

## Phase 2 — 逐页面收敛

每页做的事一致：替换字号/颜色 → 换用共享组件（PageHeader/StatCard/Pill/EmptyState/LoadingState/ErrorState）→ 对齐表格/按钮约定。

顺序：

1. 主界面：Dashboard → ServerList → ServerDetail → Settings → FilesHubPage/FileBrowserPage → Scripts×4 → AuditLogPage → ServerNew → RecordingPlayerPage
2. 插件：netquality（最差，自定义图表并入 chart token）→ singbox → xray → sshaudit → subgen → cloudflare
3. ConsoleDock（含 1.2 的 console token 落地）

## Phase 3 — 交互细节 + 列表体验

- 空状态引导：Hosts 空 →"添加主机"按钮；Scripts 空 →"新建脚本"；其余页面按有无自然入口配置 action。
- 筛选无结果统一显示"清除筛选"快捷操作。
- 危险操作（删除主机/脚本/inbound/证书等）统一走 `ConfirmDialog`。
- 列排序：主要表格（Hosts、Scripts 列表、Audit 日志）支持点击表头排序（客户端排序即可，数据量大的表结合 Phase 4 虚拟滚动）。实现为 `useTableSort` hook + 表头组件，不引第三方表格库。
- 分页：现状全站无分页、列表全量客户端渲染；不新增分页，大表交给 Phase 4 虚拟滚动解决。

## Phase 4 — 性能

- 虚拟滚动：仅行数可能上千的表（审计日志、singbox/xray 的 events 表）引入 `@tanstack/react-virtual`；普通列表不加。
- 路由懒加载：现状已全部 `React.lazy`（App.tsx 15 个页面 + 插件 `lazyPluginPage`），无需改动，最终验收时确认无回退。
- 轮询排查：现状全部走 react-query `refetchInterval`（`refetchIntervalInBackground` 默认 false，后台标签页已自动暂停）。剩余工作：确认 Dashboard / ServerList / AdminLayout 的 `useServers` query key 一致以复用缓存，消除同数据多 key 重复请求。

## Error handling

数据加载失败统一 `ErrorState`（带重试）；重试调用原 fetch。写操作失败沿用现有 toast 机制不变。

## Testing

- 新共享组件（StatCard/EmptyState/LoadingState/ErrorState/PageHeader/ConfirmDialog/useTableSort）配 vitest 单测，沿用现有 `*.test.tsx` 模式。
- 每阶段合入前：`npm run build` + `npx vitest run` + `scripts/check-ui-tokens.sh` 通过。
- 全部完成后端到端冒烟：起后端，浏览器过一遍主要页面与全部插件 tab，深浅两个主题各一轮，确认无样式破损。

## Out of scope

- 视觉风格重设计（保持现有观感）。
- 表格/Dialog 的移动端响应式改造（桌面 web 为主，另立项目）。
- `mobile/` 应用。
- 大文件拆分（ServerList 722 行等）——仅当页面收敛顺手可拆时小幅拆，不作为目标。
