# Shepherd Web UI 约定

## 字号（6 档，禁止任意值 text-[..px]）
- `text-2xs` 11px — 辅助信息、mono 数据、徽章
- `text-xs` 12px — 表格正文、密集内容
- `text-sm` 13px — 常规正文、表单、说明
- `text-lg` 16px — 卡片次级数值
- `text-title` 22px — 页面标题（经 PageHeader）、卡片大数值
- `text-display` 26px — KPI 大数字

## 颜色（只用 token，禁止原色/hex 类）
- 状态：`ok/warn/err`（+ `-soft` 底色），中性 `muted-foreground`/`fg-dim`
- 表面：`bg-background`/`bg-elev`/`bg-sunken`，边框 `border`/`border-strong`
- 图表：`chart-1..4`（SVG 里写 `hsl(var(--chart-1))`）
- 终端/控制台（永远深色）：`bg-console`/`bg-console-elev`/`text-console-fg`/`text-console-muted`/`border-console-border`
- 特例需保留时行尾注释 `// ui-token-ignore`

## 组件选型
- 状态徽章 → `Pill`（唯一）；数值+等级 → `MetricBadge`；普通标签 → `ui/badge`
- 指标卡 → `StatCard`（`variant="kpi"` 大数字 / `variant="compact"` 图标行）
- 页头 → `PageHeader`；加载 → `LoadingState`；出错 → `ErrorState`；空列表 → `EmptyState`
- 危险确认 → `ConfirmDialog`（禁用 window.confirm）
- 表格 → `ui/table`，行 hover `hover:bg-sunken/60`

## 按钮尺寸
页面级 `h-8`；表格行内 `h-7`；图标按钮 `h-7 w-7`

## 防回退
`scripts/check-ui-tokens.sh`（Makefile: `make lint-web`，CI 已接入）
