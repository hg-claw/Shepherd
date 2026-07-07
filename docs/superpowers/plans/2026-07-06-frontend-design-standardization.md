# Frontend Design Standardization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `web/` 前端的设计 token 落实到位：4+2 档字号、全 token 颜色、共享组件（StatCard/EmptyState/LoadingState/ErrorState/PageHeader/ConfirmDialog）、统一表格/按钮约定，并加表头排序、大表虚拟滚动与防回退检查。

**Architecture:** 分四阶段：①规范层（token+共享组件+检查脚本）②逐页面机械收敛（映射表驱动替换）③交互增强（空状态引导/确认弹窗/排序）④性能（虚拟滚动/query key 对齐）。每个任务独立可合入，全程不改视觉风格。

**Tech Stack:** React 19 + TypeScript 6 + Vite 8 + Tailwind 3 + shadcn/ui (Radix) + react-query 5 + vitest 4 + @testing-library/react + i18next。Node 24。

**Spec:** `docs/superpowers/specs/2026-07-06-frontend-design-standardization-design.md`

## Global Constraints

- 工作目录：所有前端命令在 `/Users/hg/project/Shepherd/web` 下执行；脚本/Makefile 在仓库根。
- 每个任务完成即 commit；commit message 用 `feat(web)|fix(web)|refactor(web)|docs` 前缀。
- 验证命令（每个任务收尾必跑）：`cd web && npm run build && npx vitest run`。build 含 `tsc --noEmit`。
- 不改视觉风格：替换前后渲染结果应像素级接近（半像素字号归并除外）。
- i18n：所有新增用户可见文案必须同时加 `web/src/locales/en.json` 和 `web/src/locales/zh-CN.json`，key 按功能分组（`common.*`、`servers.*` 等）。
- 新组件一律放 `web/src/components/`，测试文件同目录 `*.test.tsx`，风格：`describe/it` + `@testing-library/react` 的 `render`。

### 字号映射表（全局替换规则）

| 现值 | 替换为 |
|------|--------|
| `text-[10px]` `text-[10.5px]` `text-[11px]` `text-[11.5px]` | `text-2xs` |
| `text-[12px]` | `text-xs` |
| `text-[12.5px]` `text-[13px]` `text-[13.5px]` `text-[14px]` | `text-sm` |
| `text-[16px]` | `text-lg` |
| `text-[22px]` | `text-title` |
| `text-[26px]` | `text-display` |
| 其它任意值 | 归并到最近档位 |

替换后若同元素有 `leading-[..px]` 且与档位默认行高一致（2xs:16/xs:18/sm:20/lg:22/title:28/display:32），删掉 leading。`leading-none`/`leading-tight` 等语义类保留。

### 颜色映射表（全局替换规则）

| 现值 | 替换为 |
|------|--------|
| `text-green-600` `text-emerald-*` `bg-emerald-500` | `text-ok` / `bg-ok` |
| `text-amber-600` `text-yellow-500` `text-yellow-800` | `text-warn` |
| `bg-yellow-100 dark:bg-yellow-900/40` + `text-yellow-800 dark:text-yellow-300` | `bg-warn-soft text-warn` |
| `text-red-*` `ring-red-400`（toast destructive） | `text-err` 系 / `ring-err`（写法 `ring-[hsl(var(--err))]` 加 `// ui-token-ignore` 或在 tailwind 暴露 `err` 已有——直接 `ring-err` 可用，colors 已含 err） |
| `bg-[#09090b]` `bg-[#0a0a0b]` `bg-zinc-900` | `bg-console` |
| `bg-zinc-800/60` `bg-zinc-700`（活跃 tab/悬浮） | `bg-console-elev` |
| `text-zinc-50` `text-zinc-100` `text-zinc-200` | `text-console-fg` |
| `text-zinc-400` `text-zinc-500` | `text-console-muted` |
| `border-zinc-*` | `border-console-border` |
| `bg-emerald-400`（ConsoleDock 在线点） | `bg-ok` |
| SVG `fill="#3b82f6"` / `stroke="#3b82f6"` | `fill="hsl(var(--chart-1))"` 等，蓝→chart-1、绿→chart-2、橙→chart-3、紫→chart-4 |

### 表格/按钮约定

- 行 hover 统一 `hover:bg-sunken/60`（替换 `hover:bg-sunken/70`、`hover:bg-muted/30`、`hover:bg-elev`）。
- 按钮：页面级 `h-8`；表格行内/次级 `h-7`；图标按钮 `h-7 w-7`；`h-6`、`h-[26px]` → `h-7`。
- 页面标题一律 `<PageHeader title={...} actions={...} />`；页面容器 `space-y-4`（`space-y-5` → `space-y-4`）。
- 数据加载中 → `<LoadingState />`；加载失败 → `<ErrorState onRetry={refetch} />`；列表为空 → `<EmptyState />`。

---

## Phase 1 — 规范层

### Task 1: 字号档位 + DESIGN.md 约定文档

**Files:**
- Modify: `web/tailwind.config.ts`
- Create: `web/DESIGN.md`

**Interfaces:**
- Produces: Tailwind 类 `text-2xs`/`text-xs`/`text-sm`/`text-lg`/`text-title`/`text-display`（后续所有任务使用）

- [ ] **Step 1: 在 tailwind.config.ts 的 `theme.extend` 中加入 fontSize**

在 `extend: {` 内（`colors` 之前）加：

```ts
      fontSize: {
        '2xs': ['11px', '16px'],
        xs: ['12px', '18px'],
        sm: ['13px', '20px'],
        lg: ['16px', '22px'],
        title: ['22px', '28px'],
        display: ['26px', '32px'],
      },
```

- [ ] **Step 2: 创建 `web/DESIGN.md`**

```markdown
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
```

- [ ] **Step 3: 构建验证**

Run: `cd web && npm run build`
Expected: 成功（本任务不替换调用点，旧任意值类仍在，不影响构建）

- [ ] **Step 4: Commit**

```bash
git add web/tailwind.config.ts web/DESIGN.md
git commit -m "feat(web): named font-size scale + DESIGN.md conventions"
```

### Task 2: chart / console 颜色 token

**Files:**
- Modify: `web/src/index.css`
- Modify: `web/tailwind.config.ts`

**Interfaces:**
- Produces: CSS 变量 `--chart-1..4`（分浅/深）、`--console-bg/elev/border/fg/muted`；Tailwind 类 `bg-console`、`bg-console-elev`、`text-console-fg`、`text-console-muted`、`border-console-border`、`text-chart-1`…、SVG 用 `hsl(var(--chart-N))`

- [ ] **Step 1: index.css `:root` 末尾（`--level-alert` 之后）加**

```css
    /* Chart series palette */
    --chart-1: 217 89% 47%;   /* blue — matches primary */
    --chart-2: 145 53% 41%;   /* green — matches ok */
    --chart-3: 38 87% 53%;    /* amber — matches warn */
    --chart-4: 262 60% 55%;   /* purple */
    /* Console (terminal) surfaces — always dark by design, theme-invariant */
    --console-bg: 240 6% 4%;
    --console-elev: 240 5% 12%;
    --console-border: 240 6% 18%;
    --console-fg: 0 0% 96%;
    --console-muted: 0 0% 63%;
```

- [ ] **Step 2: index.css `.dark` 末尾（`--level-alert` 之后）加图表亮色变体**

```css
    --chart-1: 213 92% 67%;
    --chart-2: 145 50% 55%;
    --chart-3: 38 85% 60%;
    --chart-4: 262 70% 70%;
```

（console 变量不在 `.dark` 重定义 — 两主题同值。）

- [ ] **Step 3: tailwind.config.ts `extend.colors` 内（`err` 之后）加**

```ts
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
        },
        console: {
          DEFAULT: 'hsl(var(--console-bg))',
          elev: 'hsl(var(--console-elev))',
          border: 'hsl(var(--console-border))',
          fg: 'hsl(var(--console-fg))',
          muted: 'hsl(var(--console-muted))',
        },
```

- [ ] **Step 4: 构建验证**

Run: `cd web && npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/index.css web/tailwind.config.ts
git commit -m "feat(web): chart + console color tokens"
```

### Task 3: 状态色映射统一到 lib/status.ts

**Files:**
- Create: `web/src/lib/status.ts`
- Modify: `web/src/components/Pill.tsx`
- Test: `web/src/components/Pill.test.tsx`（新建）

**Interfaces:**
- Produces: `statusStyles: Record<StatusKind, { bg: string; text: string; dot: string; pulse: string }>`，`type StatusKind = 'ok' | 'warn' | 'err' | 'neutral'`；`lib/status.ts` 同时 re-export `levelClass`（来自 `@/lib/thresholds`），作为状态色单一入口
- Consumes: `@/lib/thresholds` 的 `levelClass`

- [ ] **Step 1: 写失败测试 `web/src/components/Pill.test.tsx`**

```tsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Pill } from './Pill'
import { statusStyles } from '@/lib/status'

describe('Pill', () => {
  it('uses shared statusStyles for ok kind', () => {
    const { container } = render(<Pill kind="ok">up</Pill>)
    const span = container.firstElementChild!
    expect(span.className).toContain(statusStyles.ok.bg)
    expect(span.className).toContain(statusStyles.ok.text)
  })
  it('neutral kind gets border', () => {
    const { container } = render(<Pill kind="neutral">idle</Pill>)
    expect(container.firstElementChild!.className).toContain('border-border')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/components/Pill.test.tsx`
Expected: FAIL — `Cannot find module '@/lib/status'`

- [ ] **Step 3: 创建 `web/src/lib/status.ts`**

```ts
// Single source of truth for status colours. Pill consumes statusStyles;
// MetricBadge's level scale (low/mid/high/alert) lives in thresholds.ts
// and is re-exported here so both mappings share one import site.
export { levelClass, type Level } from '@/lib/thresholds'

export type StatusKind = 'ok' | 'warn' | 'err' | 'neutral'

export const statusStyles: Record<
  StatusKind,
  { bg: string; text: string; dot: string; pulse: string }
> = {
  ok: { bg: 'bg-ok-soft', text: 'text-ok', dot: 'bg-ok', pulse: 'shep-pulse' },
  warn: { bg: 'bg-warn-soft', text: 'text-warn', dot: 'bg-warn', pulse: 'shep-pulse-warn' },
  err: { bg: 'bg-err-soft', text: 'text-err', dot: 'bg-err', pulse: 'shep-pulse-err' },
  neutral: { bg: 'bg-sunken', text: 'text-muted-foreground', dot: 'bg-muted-foreground', pulse: '' },
}
```

- [ ] **Step 4: Pill.tsx 改为消费 statusStyles**

```tsx
import { cn } from '@/lib/utils'
import { statusStyles, type StatusKind } from '@/lib/status'

export type PillKind = StatusKind

interface PillProps {
  kind: PillKind
  children: React.ReactNode
  className?: string
}

export function Pill({ kind, children, className }: PillProps) {
  const s = statusStyles[kind]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 h-5 px-2 rounded-full text-2xs font-mono tracking-wide whitespace-nowrap border border-transparent',
        kind === 'neutral' && 'border-border',
        s.bg,
        s.text,
        className,
      )}
    >
      <span className={cn('inline-block h-1.5 w-1.5 rounded-full', s.dot, s.pulse)} />
      {children}
    </span>
  )
}
```

（注意：顺手把 `text-[11px]` 换成 `text-2xs`。）

- [ ] **Step 4b: MetricBadge 的 levelClass import 切到单一入口**

`web/src/components/MetricBadge.tsx` 第 2 行：

```ts
// 原: import { levelClass, levelForNetBps, levelForPct, type Level, type Metric } from '@/lib/thresholds'
import { levelForNetBps, levelForPct, type Metric } from '@/lib/thresholds'
import { levelClass, type Level } from '@/lib/status'
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd web && npx vitest run src/components/Pill.test.tsx && npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/status.ts web/src/components/Pill.tsx web/src/components/Pill.test.tsx
git commit -m "refactor(web): shared status colour map in lib/status"
```

### Task 4: StatCard（合并 KpiCard + SummaryStat）

**Files:**
- Create: `web/src/components/StatCard.tsx`
- Test: `web/src/components/StatCard.test.tsx`
- Modify（迁移调用点）: `web/src/pages/admin/Dashboard.tsx:112-119`、`web/src/pages/admin/ServerDetail.tsx:126-138`、`web/src/pages/admin/AuditLogPage.tsx:77-85`、`web/src/pages/admin/ServerList.tsx:285-300`、`web/src/pages/admin/plugins/index.tsx:87-98`、`web/src/pages/admin/ScriptsListPage.tsx:79-95`、`web/src/pages/public/Wall.tsx:86-95`
- Delete: `web/src/components/KpiCard.tsx`、`web/src/components/SummaryStat.tsx`

**Interfaces:**
- Produces: `StatCard({ label: string; value: string | number; sub?: string; tone?: 'ok' | 'warn' | 'err'; icon?: LucideIcon; variant?: 'kpi' | 'compact' })`，默认 `variant='kpi'`
- 迁移规则：`<KpiCard …/>` → `<StatCard …/>`（props 同名直换）；`<SummaryStat …/>` → `<StatCard variant="compact" …/>`

- [ ] **Step 1: 写失败测试 `web/src/components/StatCard.test.tsx`**

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Server } from 'lucide-react'
import { StatCard } from './StatCard'

describe('StatCard', () => {
  it('kpi variant renders label, value and sub', () => {
    render(<StatCard label="Hosts" value={12} sub="3 offline" />)
    expect(screen.getByText('Hosts')).toBeTruthy()
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getByText('3 offline')).toBeTruthy()
  })
  it('tone colours the value', () => {
    render(<StatCard label="Errors" value="3" tone="err" />)
    expect(screen.getByText('3').className).toContain('text-err')
  })
  it('compact variant renders the icon slot', () => {
    const { container } = render(
      <StatCard variant="compact" label="Nodes" value="8" icon={Server} />,
    )
    expect(container.querySelector('svg')).toBeTruthy()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/components/StatCard.test.tsx`
Expected: FAIL — Cannot find module './StatCard'

- [ ] **Step 3: 创建 `web/src/components/StatCard.tsx`**

```tsx
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

type Tone = 'ok' | 'warn' | 'err'

type Props = {
  label: string
  value: string | number
  sub?: string
  tone?: Tone
  icon?: LucideIcon
  variant?: 'kpi' | 'compact'
}

const toneClass: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', err: 'text-err' }

/**
 * StatCard — unified stat tile. `kpi` = big number with eyebrow label
 * (ex-KpiCard); `compact` = icon + value row (ex-SummaryStat).
 */
export function StatCard({ label, value, sub, tone, icon: Icon, variant = 'kpi' }: Props) {
  if (variant === 'compact') {
    return (
      <div className="bg-elev border rounded-lg p-3.5 flex items-center gap-3">
        {Icon && (
          <span className="grid place-items-center h-[34px] w-[34px] rounded-lg bg-sunken text-muted-foreground shrink-0">
            <Icon className="h-4 w-4" />
          </span>
        )}
        <div className="min-w-0">
          <div className="text-fg-dim text-2xs uppercase tracking-[0.05em]">{label}</div>
          <div className={cn('font-mono tabular-nums truncate text-lg leading-tight', tone && toneClass[tone])}>
            {value}
          </div>
          {sub && <div className="font-mono text-fg-dim truncate text-2xs mt-0.5">{sub}</div>}
        </div>
      </div>
    )
  }
  return (
    <div className="bg-elev border rounded-lg px-4 py-3.5">
      <div className="text-2xs uppercase tracking-[0.05em] text-muted-foreground whitespace-nowrap">
        {label}
      </div>
      <div
        className={cn(
          'font-mono text-display mt-1.5 tabular-nums leading-none tracking-tight',
          tone ? toneClass[tone] : 'text-foreground',
        )}
      >
        {value}
      </div>
      {sub && <div className="font-mono text-2xs text-muted-foreground mt-1.5">{sub}</div>}
    </div>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run src/components/StatCard.test.tsx`
Expected: PASS

- [ ] **Step 5: 迁移 7 个调用点**

每个文件：import 改 `import { StatCard } from '@/components/StatCard'`；`<KpiCard` → `<StatCard`；Wall.tsx 中 `<SummaryStat` → `<StatCard variant="compact"`。确认无遗漏：

Run: `grep -rn "KpiCard\|SummaryStat" web/src --include='*.tsx'`
Expected: 无输出（迁移+删除后）

- [ ] **Step 6: 删除旧组件**

```bash
rm web/src/components/KpiCard.tsx web/src/components/SummaryStat.tsx
```

- [ ] **Step 7: 构建 + 全量测试**

Run: `cd web && npm run build && npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -A web/src
git commit -m "refactor(web): merge KpiCard + SummaryStat into StatCard"
```

### Task 5: EmptyState / LoadingState / ErrorState + i18n

**Files:**
- Create: `web/src/components/EmptyState.tsx`、`web/src/components/LoadingState.tsx`、`web/src/components/ErrorState.tsx`
- Test: `web/src/components/StateViews.test.tsx`
- Modify: `web/src/locales/en.json`、`web/src/locales/zh-CN.json`

**Interfaces:**
- Produces:
  - `EmptyState({ icon?: LucideIcon; title: string; description?: string; action?: React.ReactNode; className?: string })`
  - `LoadingState({ label?: string; className?: string })` — 缺省文案 `t('common.loading')`
  - `ErrorState({ message?: string; onRetry?: () => void; className?: string })` — 缺省文案 `t('common.error')`，重试按钮 `t('common.retry')`
  - i18n 新 key：`common.no_results`、`common.clear_filter`
- Consumes: 已有 key `common.loading`、`common.error`、`common.retry`

- [ ] **Step 1: 写失败测试 `web/src/components/StateViews.test.tsx`**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EmptyState } from './EmptyState'
import { LoadingState } from './LoadingState'
import { ErrorState } from './ErrorState'
import '@/i18n'

describe('state views', () => {
  it('EmptyState renders title, description and action', () => {
    render(<EmptyState title="No hosts" description="Add one" action={<button>add</button>} />)
    expect(screen.getByText('No hosts')).toBeTruthy()
    expect(screen.getByText('Add one')).toBeTruthy()
    expect(screen.getByText('add')).toBeTruthy()
  })
  it('LoadingState shows default loading copy', () => {
    const { container } = render(<LoadingState />)
    expect(container.textContent).not.toBe('')
    expect(container.querySelector('svg')).toBeTruthy()
  })
  it('ErrorState fires onRetry', () => {
    const onRetry = vi.fn()
    render(<ErrorState message="boom" onRetry={onRetry} />)
    expect(screen.getByText('boom')).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/components/StateViews.test.tsx`
Expected: FAIL — Cannot find module './EmptyState'

- [ ] **Step 3: 创建三个组件**

`web/src/components/EmptyState.tsx`：

```tsx
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

type Props = {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: Props) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-10 text-center', className)}>
      {Icon && <Icon className="h-5 w-5 text-fg-dim" />}
      <div className="text-sm text-muted-foreground">{title}</div>
      {description && <div className="text-xs text-fg-dim">{description}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
```

`web/src/components/LoadingState.tsx`：

```tsx
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export function LoadingState({ label, className }: { label?: string; className?: string }) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground', className)}>
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>{label ?? t('common.loading')}</span>
    </div>
  )
}
```

`web/src/components/ErrorState.tsx`：

```tsx
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function ErrorState({ message, onRetry, className }: {
  message?: string
  onRetry?: () => void
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-10 text-center', className)}>
      <div className="text-sm text-err">{message ?? t('common.error')}</div>
      {onRetry && (
        <Button variant="outline" className="h-7" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  )
}
```

- [ ] **Step 4: locales 加 key**

`en.json` 的 `common` 组内加：

```json
"no_results": "No matches",
"clear_filter": "Clear filter"
```

`zh-CN.json` 的 `common` 组内加：

```json
"no_results": "无匹配结果",
"clear_filter": "清除筛选"
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd web && npx vitest run src/components/StateViews.test.tsx && npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/components/EmptyState.tsx web/src/components/LoadingState.tsx web/src/components/ErrorState.tsx web/src/components/StateViews.test.tsx web/src/locales
git commit -m "feat(web): EmptyState / LoadingState / ErrorState shared views"
```

### Task 6: PageHeader

**Files:**
- Create: `web/src/components/PageHeader.tsx`
- Test: `web/src/components/PageHeader.test.tsx`

**Interfaces:**
- Produces: `PageHeader({ title: React.ReactNode; actions?: React.ReactNode; className?: string })` — 渲染 `<h1 class="text-title font-semibold tracking-tight m-0">`，actions 靠右

- [ ] **Step 1: 写失败测试 `web/src/components/PageHeader.test.tsx`**

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PageHeader } from './PageHeader'

describe('PageHeader', () => {
  it('renders h1 title and actions', () => {
    render(<PageHeader title="Hosts" actions={<button>add</button>} />)
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1.textContent).toBe('Hosts')
    expect(h1.className).toContain('text-title')
    expect(screen.getByText('add')).toBeTruthy()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/components/PageHeader.test.tsx`
Expected: FAIL — Cannot find module './PageHeader'

- [ ] **Step 3: 创建 `web/src/components/PageHeader.tsx`**

```tsx
import { cn } from '@/lib/utils'

export function PageHeader({ title, actions, className }: {
  title: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      <h1 className="text-title font-semibold tracking-tight m-0">{title}</h1>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run src/components/PageHeader.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/components/PageHeader.tsx web/src/components/PageHeader.test.tsx
git commit -m "feat(web): PageHeader component"
```

### Task 7: ConfirmDialog

**Files:**
- Create: `web/src/components/ConfirmDialog.tsx`
- Test: `web/src/components/ConfirmDialog.test.tsx`

**Interfaces:**
- Produces: `ConfirmDialog({ open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; confirmLabel?: string; destructive?: boolean; onConfirm: () => void })` — 受控组件；确认后自动关闭；`destructive` 默认 `true`
- Consumes: `ui/dialog` 的 Dialog 系列、`ui/button`、i18n `common.cancel`/`common.ok`

- [ ] **Step 1: 写失败测试 `web/src/components/ConfirmDialog.test.tsx`**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConfirmDialog } from './ConfirmDialog'
import '@/i18n'

describe('ConfirmDialog', () => {
  it('fires onConfirm then closes', () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete host"
        description="really?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />,
    )
    expect(screen.getByText('really?')).toBeTruthy()
    fireEvent.click(screen.getByText('Delete'))
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/components/ConfirmDialog.test.tsx`
Expected: FAIL — Cannot find module './ConfirmDialog'

- [ ] **Step 3: 创建 `web/src/components/ConfirmDialog.tsx`**

```tsx
import { useTranslation } from 'react-i18next'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
}

export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel, destructive = true, onConfirm,
}: Props) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" className="h-8" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            className="h-8"
            onClick={() => {
              onConfirm()
              onOpenChange(false)
            }}
          >
            {confirmLabel ?? t('common.ok')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run src/components/ConfirmDialog.test.tsx`
Expected: PASS（若 jsdom 缺 Radix 依赖的 API 如 `hasPointerCapture`，在 `web/src/test-utils/setup.ts` 中按现有 ResizeObserver mock 的模式补 stub）

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ConfirmDialog.tsx web/src/components/ConfirmDialog.test.tsx
git commit -m "feat(web): ConfirmDialog component"
```

### Task 8: ui/table.tsx 密度与 hover 对齐

**Files:**
- Modify: `web/src/components/ui/table.tsx`

**Interfaces:**
- Produces: `TableRow` 默认 hover `hover:bg-sunken/60`；`TableHead` 高度 `h-9 px-3`、`text-2xs uppercase tracking-[0.05em]`；`TableCell` `px-3 py-2`；`Table` 字号 `text-xs`。使用 ui/table 的页面（sshaudit 等）自动获得统一密度。

- [ ] **Step 1: 修改四处 className**

- `Table` 内 `<table>`：`"w-full caption-bottom text-sm"` → `"w-full caption-bottom text-xs"`
- `TableRow`：`"border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted"` → `"border-b transition-colors hover:bg-sunken/60 data-[state=selected]:bg-muted"`
- `TableHead`：`"h-12 px-4 text-left align-middle font-medium text-muted-foreground …"` → `"h-9 px-3 text-left align-middle font-medium text-2xs uppercase tracking-[0.05em] text-muted-foreground …"`（保留 checkbox 选择器部分）
- `TableCell`：`"p-4 align-middle …"` → `"px-3 py-2 align-middle …"`（保留 checkbox 选择器部分）

- [ ] **Step 2: 构建 + 全量测试**

Run: `cd web && npm run build && npx vitest run`
Expected: PASS

- [ ] **Step 3: 视觉抽查（可选但推荐）**

Run: `cd web && npm run dev`，浏览器看 sshaudit Hosts 表密度正常、hover 是浅陷入色。

- [ ] **Step 4: Commit**

```bash
git add web/src/components/ui/table.tsx
git commit -m "feat(web): unify table density and row hover"
```

### Task 9: check-ui-tokens.sh 防回退脚本

**Files:**
- Create: `scripts/check-ui-tokens.sh`（可执行）

**Interfaces:**
- Produces: 违规时 exit 1 并列出 `文件:行号:内容`；行内含 `ui-token-ignore` 注释的行豁免。本任务只创建脚本手动跑（此时必然有违规，Phase 2 逐步清零），Task 17 才接 Makefile/CI。

- [ ] **Step 1: 创建 `scripts/check-ui-tokens.sh`**

```bash
#!/usr/bin/env bash
# Guard against hardcoded UI values that bypass the design tokens.
# Allowlist an exceptional line with a trailing `ui-token-ignore` comment.
set -uo pipefail
cd "$(dirname "$0")/.."
SRC=web/src
fail=0

check() {
  local desc=$1 pattern=$2
  local hits
  hits=$(grep -rnE "$pattern" "$SRC" --include='*.tsx' --include='*.ts' | grep -v 'ui-token-ignore' || true)
  if [ -n "$hits" ]; then
    printf '✗ %s:\n%s\n\n' "$desc" "$hits"
    fail=1
  fi
}

check "arbitrary font size (use text-2xs/xs/sm/lg/title/display)" \
  'text-\[[0-9.]+px\]'
check "raw Tailwind palette colour (use semantic tokens)" \
  '(bg|text|border|ring|fill|stroke)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-[0-9]+'
check "hardcoded hex colour class (use tokens)" \
  '\[#[0-9a-fA-F]{3,8}\]'

if [ "$fail" -eq 0 ]; then echo "✓ UI token check passed"; fi
exit "$fail"
```

- [ ] **Step 2: chmod + 手动跑，记录基线**

Run: `chmod +x scripts/check-ui-tokens.sh && ./scripts/check-ui-tokens.sh; echo "exit=$?"`
Expected: exit=1，输出违规清单（这是 Phase 2 的工作清单，正常）

- [ ] **Step 3: Commit**

```bash
git add scripts/check-ui-tokens.sh
git commit -m "feat(web): UI token regression check script"
```

---

## Phase 2 — 逐页面收敛

> 以下 7 个 sweep 任务做法完全相同，差别只在文件范围。统一步骤模板：
> 1. `./scripts/check-ui-tokens.sh 2>&1 | grep '<范围路径>'` 列出本组违规；
> 2. 按 Global Constraints 的字号/颜色映射表逐条替换；
> 3. 页面标题块改用 `<PageHeader title={…} actions={…} />`（原 `text-[22px] font-semibold tracking-tight` 的 h1/div 及其同行右侧按钮区）；
> 4. 手写 loading（`t('common.loading')` 裸 div）→ `<LoadingState />`；手写空提示 → `<EmptyState title={…} />`（沿用页面现有 `*.empty` i18n key）；
> 5. 表格行 hover 按约定统一；行内按钮 `h-6`→`h-7`；`space-y-5`→`space-y-4`；
> 6. `cd web && npm run build && npx vitest run`；
> 7. 重跑第 1 步 grep 确认本组清零；commit。
>
> 注意：只做等价替换，不改布局结构、不改业务逻辑。凡视觉上刻意不同的地方（如强调色块）拿不准就保留原样并加 `// ui-token-ignore` + 注释说明。

### Task 10: 主界面 sweep A — Dashboard / ServerList / ServerDetail

**Files:**
- Modify: `web/src/pages/admin/Dashboard.tsx`、`web/src/pages/admin/ServerList.tsx`、`web/src/pages/admin/ServerDetail.tsx`

**Interfaces:**
- Consumes: Task 1-6 的字号档位、PageHeader、LoadingState/EmptyState、映射表
- 专项：ServerDetail.tsx:154 的 `bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300` → `bg-warn-soft text-warn`；ServerList.tsx:336 `hover:bg-sunken/60` 已达标不动；三页标题（Dashboard:102、ServerList:257、ServerDetail 若有）迁 PageHeader

- [ ] **Step 1-7: 按 sweep 模板执行**

Run（收尾确认）: `./scripts/check-ui-tokens.sh 2>&1 | grep -E 'Dashboard|ServerList|ServerDetail' || echo clean`
Expected: `clean`

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/admin/Dashboard.tsx web/src/pages/admin/ServerList.tsx web/src/pages/admin/ServerDetail.tsx
git commit -m "refactor(web): tokenize Dashboard/ServerList/ServerDetail"
```

### Task 11: 主界面 sweep B — Settings / ServerNew / AuditLogPage

**Files:**
- Modify: `web/src/pages/admin/Settings.tsx`、`web/src/pages/admin/ServerNew.tsx`、`web/src/pages/admin/AuditLogPage.tsx`

**Interfaces:**
- Consumes: 同上
- 专项：三页标题（Settings:114、ServerNew:378、AuditLogPage:62）迁 PageHeader；AuditLog 空态用现有 `audit.empty` key 接 EmptyState

- [ ] **Step 1-7: 按 sweep 模板执行**

Run: `./scripts/check-ui-tokens.sh 2>&1 | grep -E 'Settings|ServerNew|AuditLogPage' || echo clean`
Expected: `clean`

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/admin/Settings.tsx web/src/pages/admin/ServerNew.tsx web/src/pages/admin/AuditLogPage.tsx
git commit -m "refactor(web): tokenize Settings/ServerNew/AuditLog"
```

### Task 12: 主界面 sweep C — Files ×2 / Scripts ×4 / RecordingPlayer

**Files:**
- Modify: `web/src/pages/admin/FilesHubPage.tsx`、`web/src/pages/admin/FileBrowserPage.tsx`、`web/src/pages/admin/ScriptsListPage.tsx`、`web/src/pages/admin/ScriptEditPage.tsx`、`web/src/pages/admin/ScriptRunPage.tsx`、`web/src/pages/admin/ScriptRunsPage.tsx`、`web/src/pages/admin/ScriptRunDetailPage.tsx`、`web/src/pages/admin/RecordingPlayerPage.tsx`

**Interfaces:**
- Consumes: 同上 + Task 2 console token
- 专项：ScriptEditPage:117 `bg-[#09090b]` 与 FileBrowserPage:475 `bg-[#0a0a0b]` 是终端/编辑器区 → `bg-console`（文字若有 zinc → `text-console-fg`/`text-console-muted`）；表格 hover `sunken/70` → `sunken/60`（ScriptsListPage:271、ScriptRunDetailPage、FileBrowserPage:435）

- [ ] **Step 1-7: 按 sweep 模板执行**

Run: `./scripts/check-ui-tokens.sh 2>&1 | grep -E 'Files|Script|Recording' || echo clean`
Expected: `clean`

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/admin
git commit -m "refactor(web): tokenize Files/Scripts/Recording pages"
```

### Task 13: 插件 sweep A — plugins 骨架 + sshaudit / subgen / cloudflare

**Files:**
- Modify: `web/src/pages/admin/plugins/index.tsx`、`web/src/pages/admin/plugins/detail.tsx`、`web/src/pages/admin/plugins/PluginLogsTab.tsx`、`web/src/pages/admin/plugins/sshaudit/**`、`web/src/pages/admin/plugins/subgen/**`、`web/src/pages/admin/plugins/cloudflare/**`

**Interfaces:**
- Consumes: 同上
- 专项：plugins/index.tsx:265 tab 按钮 `h-[26px]` → `h-7`；PluginLogsTab:59 `bg-[#0a0a0b]` → `bg-console`、:62 `text-zinc-500` → `text-console-muted`；标题（index:76、detail:44/89）迁 PageHeader

- [ ] **Step 1-7: 按 sweep 模板执行**

Run: `./scripts/check-ui-tokens.sh 2>&1 | grep -E 'plugins/(index|detail|PluginLogsTab|sshaudit|subgen|cloudflare)' || echo clean`
Expected: `clean`

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/admin/plugins
git commit -m "refactor(web): tokenize plugins shell + sshaudit/subgen/cloudflare"
```

### Task 14: 插件 sweep B — netquality / singbox / xray（含图表 token）

**Files:**
- Modify: `web/src/pages/admin/plugins/netquality/**`、`web/src/pages/admin/plugins/singbox/**`、`web/src/pages/admin/plugins/xray/**`、`web/src/components/Sparkline.tsx`、`web/src/components/TimeSeriesChart.tsx`（若有硬编码色）

**Interfaces:**
- Consumes: Task 2 的 `--chart-1..4`
- 专项：singbox/xray `TrafficDrawer.tsx:190-202` 的 `fill="#3b82f6"` → `fill="hsl(var(--chart-1))"`、`fill="#22c55e"` → `fill="hsl(var(--chart-2))"`；singbox CertificatesTab:44-45 `text-green-600`/`text-amber-600` → 换 `<Pill kind="ok|warn">` 或 `text-ok`/`text-warn`；InboundsTab:400 `text-yellow-500` → `text-warn`；netquality ResultsTab `hover:bg-elev` → `hover:bg-sunken/60`、CertificatesTab:178 `hover:bg-muted/30` → `hover:bg-sunken/60`；netquality 特殊字号按映射表归档

- [ ] **Step 1-7: 按 sweep 模板执行**

Run: `./scripts/check-ui-tokens.sh 2>&1 | grep -E 'netquality|singbox|xray|Sparkline|TimeSeriesChart' || echo clean`
Expected: `clean`

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/admin/plugins web/src/components
git commit -m "refactor(web): tokenize netquality/singbox/xray + chart palette"
```

### Task 15: ConsoleDock 收敛

**Files:**
- Modify: `web/src/components/ConsoleDock/index.tsx`（及 ConsoleDock/ 目录内其它文件）

**Interfaces:**
- Consumes: Task 2 console token
- 替换规则（保持"永远深色"观感）：`bg-[#09090b]` → `bg-console`；`bg-zinc-900` → `bg-console`；`bg-zinc-800/60`、`bg-zinc-700`、`hover:bg-zinc-700/70` → `bg-console-elev`/`hover:bg-console-elev`；`text-zinc-50/100/200` → `text-console-fg`；`text-zinc-400/500` → `text-console-muted`；`border-zinc-*` → `border-console-border`；在线点 `bg-emerald-400` → `bg-ok`；字号按映射表

- [ ] **Step 1: 替换 + 构建测试**

Run: `cd web && npm run build && npx vitest run`
Expected: PASS

- [ ] **Step 2: 视觉抽查**

`npm run dev` 打开任一主机的 Console，外观应与改前一致（深底浅字、活跃 tab 微亮）。

- [ ] **Step 3: 清零确认**

Run: `./scripts/check-ui-tokens.sh 2>&1 | grep ConsoleDock || echo clean`
Expected: `clean`

- [ ] **Step 4: Commit**

```bash
git add web/src/components/ConsoleDock
git commit -m "refactor(web): ConsoleDock onto console tokens"
```

### Task 16: 公开页 + toast 收敛

**Files:**
- Modify: `web/src/pages/public/Wall.tsx`、`web/src/pages/public/ServerDetail.tsx`、`web/src/components/MetricCard.tsx`、`web/src/components/ui/toast.tsx`、`web/src/components/TopList.tsx`、`web/src/components/MetricBar.tsx`、`web/src/components/OnlineDot.tsx`、`web/src/components/LiveNetCell.tsx`（凡有违规的）

**Interfaces:**
- 专项：MetricCard 字号（10.5px/11.5px→2xs、22px→title、10px→2xs）颜色已是 token 不动；toast.tsx:80 destructive variant 的 `text-red-300`/`text-red-50`/`ring-red-400` → `text-err-soft`/`text-destructive-foreground`/`ring-err`（对照浅深两主题确认可读性，拿不准以 `bg-destructive text-destructive-foreground` 系为准）

- [ ] **Step 1-7: 按 sweep 模板执行**

Run: `./scripts/check-ui-tokens.sh 2>&1 | grep -E 'public/|MetricCard|toast|TopList|MetricBar|OnlineDot|LiveNetCell' || echo clean`
Expected: `clean`

- [ ] **Step 8: Commit**

```bash
git add web/src
git commit -m "refactor(web): tokenize public wall + toast + misc components"
```

### Task 17: 全站清零 + 接入 Makefile / CI

**Files:**
- Modify: `Makefile`、`.github/workflows/ci.yml`、（剩余违规文件）

**Interfaces:**
- Produces: `make lint-web` target；CI web job 中新增 UI token check 步骤

- [ ] **Step 1: 全站跑脚本，清掉所有残留违规**

Run: `./scripts/check-ui-tokens.sh`
Expected: 列出 Phase 2 各 sweep 漏网之鱼（layouts/、login 页、test-utils 等）；逐个按映射表修掉。确需保留的加 `// ui-token-ignore` + 原因注释。

- [ ] **Step 2: 再跑确认通过**

Run: `./scripts/check-ui-tokens.sh && echo OK`
Expected: `✓ UI token check passed` + `OK`

- [ ] **Step 3: Makefile 加 target（放在 `test-web:` 之后）**

```makefile
lint-web:
	./scripts/check-ui-tokens.sh
```

- [ ] **Step 4: ci.yml web job 加步骤（Vitest 之前）**

```yaml
    - name: UI token check
      run: ./scripts/check-ui-tokens.sh
```

- [ ] **Step 5: 构建 + 全量测试 + make lint-web**

Run: `make lint-web && cd web && npm run build && npx vitest run`
Expected: 全 PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): zero token violations; wire check into make + CI"
```

---

## Phase 3 — 交互细节 + 列表体验

### Task 18: 空状态引导 + 筛选清除

**Files:**
- Modify: `web/src/pages/admin/ServerList.tsx`、`web/src/pages/admin/ScriptsListPage.tsx`、`web/src/locales/en.json`、`web/src/locales/zh-CN.json`

**Interfaces:**
- Consumes: `EmptyState`（Task 5）、`common.no_results`/`common.clear_filter` key
- 行为：真空（无任何数据）→ EmptyState 带引导按钮；有筛选词但结果为空 → EmptyState 用 `common.no_results` + "清除筛选"按钮（清空 filter state）

- [ ] **Step 1: ServerList 空态**

真空分支（rows 为空且 filter 为空）：

```tsx
<EmptyState
  title={t('servers.empty', 'No servers yet')}
  action={
    <Button asChild className="h-8">
      <Link to="/admin/servers/new">{t('servers.add', 'Add server')}</Link>
    </Button>
  }
/>
```

（先 grep locales 找现有 key：`grep -n '"empty"\|"add"' web/src/locales/en.json`。已有就用现有 key 并去掉 fallback 第二参；没有则新增 `servers.empty` / 复用页面顶部"添加"按钮的现有 key，zh-CN 补 "暂无主机"。）

筛选无结果分支（rows 为空且 filter 非空）：

```tsx
<EmptyState
  title={t('common.no_results')}
  action={
    <Button variant="outline" className="h-7" onClick={() => setFilter('')}>
      {t('common.clear_filter')}
    </Button>
  }
/>
```

（`setFilter` 用页面现有的筛选 state setter 名。）

- [ ] **Step 2: ScriptsListPage 同样处理**

真空 → `t('scripts.empty')`（已有 key）+ 引导按钮指向新建脚本入口（页面现有"New script"按钮的路由/回调）；筛选无结果 → 同上 `common.no_results` + 清除按钮（该页 `filter` state 已存在，见 ScriptsListPage:287 现有三元判断，改写为两个 EmptyState 分支）。

- [ ] **Step 3: 构建 + 测试 + 视觉抽查**

Run: `cd web && npm run build && npx vitest run`
Expected: PASS。`npm run dev` 下把筛选词输成乱码看"无匹配结果 + 清除筛选"。

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/admin/ServerList.tsx web/src/pages/admin/ScriptsListPage.tsx web/src/locales
git commit -m "feat(web): empty-state CTAs + clear-filter affordance"
```

### Task 19: window.confirm → ConfirmDialog

**Files:**
- Modify: `web/src/pages/admin/ServerDetail.tsx:221`、`web/src/pages/admin/FileBrowserPage.tsx:144`、`web/src/pages/admin/plugins/sshaudit/HardeningTab.tsx:59`（+ grep 到的其它 confirm）
- Modify: `web/src/locales/en.json`、`web/src/locales/zh-CN.json`（确认文案 key）

**Interfaces:**
- Consumes: `ConfirmDialog`（Task 7）

- [ ] **Step 1: 找全 confirm 调用**

Run: `grep -rn "confirm(" web/src --include='*.tsx' | grep -v ConfirmDialog`
Expected: 至少上述 3 处；全部纳入本任务。

- [ ] **Step 2: 逐处替换（模式一致）**

以 ServerDetail 重置流量为例：

```tsx
// 组件顶部
const [confirmReset, setConfirmReset] = useState(false)

// 原 onClick={() => { if (confirm('确认立即重置流量统计？')) resetTraffic.mutate() }}
// 改为：
onClick={() => setConfirmReset(true)}

// JSX 末尾追加：
<ConfirmDialog
  open={confirmReset}
  onOpenChange={setConfirmReset}
  title={t('servers.reset_traffic', 'Reset traffic')}
  description={t('servers.reset_traffic_confirm', 'Reset traffic counters now?')}
  onConfirm={() => resetTraffic.mutate()}
/>
```

FileBrowserPage 删除文件同型（title 用现有删除 key，description 带 `{ name: entry.name }` 插值；注意 entry 来自行内回调，需要把待删 entry 存进 state：`const [removeTarget, setRemoveTarget] = useState<Entry | null>(null)`，open 即 `removeTarget != null`）。HardeningTab 的 fail2ban 开启确认用 `destructive={false}`。所有新文案 key 补进两份 locale（en 给英文、zh-CN 给中文，硬编码中文字符串顺势迁入 zh-CN）。

- [ ] **Step 3: 确认无残留**

Run: `grep -rn "window.confirm\|[^A-Za-z]confirm(" web/src --include='*.tsx' | grep -v ConfirmDialog`
Expected: 无输出

- [ ] **Step 4: 构建 + 测试**

Run: `cd web && npm run build && npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat(web): replace window.confirm with ConfirmDialog"
```

### Task 20: useTableSort + SortableTh + 应用到三张主表

**Files:**
- Create: `web/src/lib/useTableSort.ts`、`web/src/components/SortableTh.tsx`
- Test: `web/src/lib/useTableSort.test.ts`
- Modify: `web/src/pages/admin/ServerList.tsx`（表格视图）、`web/src/pages/admin/ScriptsListPage.tsx`、`web/src/pages/admin/AuditLogPage.tsx`

**Interfaces:**
- Produces:
  - `useTableSort<T>(rows: T[], accessors: Record<string, (row: T) => string | number | null | undefined>, initial?: { key: string; dir: 'asc' | 'desc' }) => { sorted: T[]; sort: { key: string; dir: 'asc' | 'desc' } | null; toggle: (key: string) => void }`
  - `SortableTh({ label: React.ReactNode; sortKey: string; sort; onToggle; className? })`
  - 循环：无排序 → asc → desc → 无排序；null 值恒排最后
- 注意：`accessors` 必须定义在组件外（模块级常量）或 useMemo 包裹，否则每次渲染重排

- [ ] **Step 1: 写失败测试 `web/src/lib/useTableSort.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTableSort } from './useTableSort'

const rows = [
  { name: 'b', n: 2 },
  { name: 'a', n: null as number | null },
  { name: 'c', n: 1 },
]
const accessors = {
  name: (r: (typeof rows)[number]) => r.name,
  n: (r: (typeof rows)[number]) => r.n,
}

describe('useTableSort', () => {
  it('no sort returns rows as-is', () => {
    const { result } = renderHook(() => useTableSort(rows, accessors))
    expect(result.current.sorted).toEqual(rows)
  })
  it('toggle cycles asc -> desc -> off; nulls last', () => {
    const { result } = renderHook(() => useTableSort(rows, accessors))
    act(() => result.current.toggle('n'))
    expect(result.current.sorted.map((r) => r.name)).toEqual(['c', 'b', 'a'])
    act(() => result.current.toggle('n'))
    expect(result.current.sorted.map((r) => r.name)).toEqual(['b', 'c', 'a'])
    act(() => result.current.toggle('n'))
    expect(result.current.sort).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/lib/useTableSort.test.ts`
Expected: FAIL — Cannot find module './useTableSort'

- [ ] **Step 3: 创建 `web/src/lib/useTableSort.ts`**

```ts
import { useMemo, useState } from 'react'

export type SortDir = 'asc' | 'desc'
export type SortState = { key: string; dir: SortDir } | null

export function useTableSort<T>(
  rows: T[],
  accessors: Record<string, (row: T) => string | number | null | undefined>,
  initial?: { key: string; dir: SortDir },
) {
  const [sort, setSort] = useState<SortState>(initial ?? null)

  const sorted = useMemo(() => {
    if (!sort) return rows
    const acc = accessors[sort.key]
    if (!acc) return rows
    const mul = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = acc(a)
      const bv = acc(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul
      return String(av).localeCompare(String(bv)) * mul
    })
  }, [rows, sort, accessors])

  const toggle = (key: string) =>
    setSort((s) => {
      if (s?.key !== key) return { key, dir: 'asc' }
      if (s.dir === 'asc') return { key, dir: 'desc' }
      return null
    })

  return { sorted, sort, toggle }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run src/lib/useTableSort.test.ts`
Expected: PASS

- [ ] **Step 5: 创建 `web/src/components/SortableTh.tsx`**

```tsx
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SortState } from '@/lib/useTableSort'

export function SortableTh({ label, sortKey, sort, onToggle, className }: {
  label: React.ReactNode
  sortKey: string
  sort: SortState
  onToggle: (key: string) => void
  className?: string
}) {
  const active = sort?.key === sortKey
  return (
    <th
      className={cn('cursor-pointer select-none', className)}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      onClick={() => onToggle(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active &&
          (sort.dir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
      </span>
    </th>
  )
}
```

（若页面表头用的是 `TableHead` 而非裸 `th`，同型包一层即可——签名不变，元素换成 `TableHead`。）

- [ ] **Step 6: 三张表接入**

每页模式相同（以 ServerList 表格视图为例）：

```tsx
// 模块级
const serverSortAccessors = {
  name: (s: ServerRow) => s.name,
  status: (s: ServerRow) => (s.online ? 1 : 0),
  cpu: (s: ServerRow) => s.latest?.cpu_pct ?? null,
  mem: (s: ServerRow) => s.latest?.mem_pct ?? null,
}
// 组件内，filter 之后：
const { sorted, sort, toggle } = useTableSort(filtered, serverSortAccessors)
// 渲染 sorted 而非 filtered；对应表头换 <SortableTh label={…} sortKey="name" sort={sort} onToggle={toggle} />
```

ScriptsListPage：name/updated_at 等列；AuditLogPage：ts/actor/action 等列。字段名以各页现有 row 类型为准（先读页面确定）。

- [ ] **Step 7: 构建 + 全量测试 + 视觉抽查**

Run: `cd web && npm run build && npx vitest run`
Expected: PASS。dev 下点表头看排序箭头与顺序。

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/useTableSort.ts web/src/lib/useTableSort.test.ts web/src/components/SortableTh.tsx web/src/pages/admin
git commit -m "feat(web): client-side column sorting on main tables"
```

---

## Phase 4 — 性能

### Task 21: 大表虚拟滚动（AuditLog + singbox/xray Events）

**Files:**
- Modify: `web/package.json`（新依赖 `@tanstack/react-virtual`）
- Create: `web/src/lib/useVirtualRows.tsx`
- Test: `web/src/lib/useVirtualRows.test.tsx`
- Modify: `web/src/pages/admin/AuditLogPage.tsx`、`web/src/pages/admin/plugins/singbox/EventsTab.tsx`、`web/src/pages/admin/plugins/xray/EventsTab.tsx`

**Interfaces:**
- Produces: `useVirtualRows<T>(rows: T[], opts?: { estimateSize?: number; overscan?: number })` → `{ parentRef: RefObject<HTMLDivElement>; items: VirtualItem[]; padTop: number; padBottom: number }`；表格用 padding-row 技法虚拟化，容器 `max-h-[70vh] overflow-auto`

- [ ] **Step 1: 安装依赖**

Run: `cd web && npm install @tanstack/react-virtual`
Expected: 安装成功，package.json 出现该依赖

- [ ] **Step 2: 写失败测试 `web/src/lib/useVirtualRows.test.tsx`**

```tsx
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useVirtualRows } from './useVirtualRows'

describe('useVirtualRows', () => {
  it('returns ref + items + paddings without crashing in jsdom', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i }))
    const { result } = renderHook(() => useVirtualRows(rows))
    expect(result.current.parentRef).toBeTruthy()
    expect(result.current.padTop).toBeGreaterThanOrEqual(0)
    expect(result.current.padBottom).toBeGreaterThanOrEqual(0)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd web && npx vitest run src/lib/useVirtualRows.test.tsx`
Expected: FAIL — Cannot find module './useVirtualRows'

- [ ] **Step 4: 创建 `web/src/lib/useVirtualRows.tsx`**

```tsx
import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

/**
 * Table-row virtualization via the padding-row technique: render two
 * spacer <tr>s around the visible slice so the scrollbar length stays
 * correct without absolute positioning inside <tbody>.
 */
export function useVirtualRows<T>(rows: T[], opts?: { estimateSize?: number; overscan?: number }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => opts?.estimateSize ?? 36,
    overscan: opts?.overscan ?? 10,
  })
  const items = virtualizer.getVirtualItems()
  const padTop = items.length > 0 ? items[0].start : 0
  const padBottom = items.length > 0 ? virtualizer.getTotalSize() - items[items.length - 1].end : 0
  return { parentRef, items, padTop, padBottom }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd web && npx vitest run src/lib/useVirtualRows.test.tsx`
Expected: PASS

- [ ] **Step 6: AuditLogPage 接入（三表同型）**

```tsx
const { parentRef, items, padTop, padBottom } = useVirtualRows(rows)
const COLS = 6 // 与实际列数一致

<div ref={parentRef} className="max-h-[70vh] overflow-auto">
  <table className="w-full">
    <thead>…原表头…</thead>
    <tbody>
      {padTop > 0 && <tr aria-hidden><td colSpan={COLS} style={{ height: padTop }} /></tr>}
      {items.map((vi) => {
        const row = rows[vi.index]
        return <tr key={row.id ?? vi.index} data-index={vi.index}>…原行内容…</tr>
      })}
      {padBottom > 0 && <tr aria-hidden><td colSpan={COLS} style={{ height: padBottom }} /></tr>}
    </tbody>
  </table>
</div>
```

原 `rows.map(...)` 的行 JSX 原样保留，只换外层遍历。Task 20 的排序在虚拟化之前作用于 `rows`（`sorted` 传入 `useVirtualRows`）。singbox/xray EventsTab 同型接入。

- [ ] **Step 7: 构建 + 全量测试 + 视觉抽查**

Run: `cd web && npm run build && npx vitest run`
Expected: PASS。dev 下审计日志滚动流畅、滚动条长度正常、行无跳动。

- [ ] **Step 8: Commit**

```bash
git add web/package.json web/package-lock.json web/src
git commit -m "feat(web): virtualize audit log + plugin events tables"
```

### Task 22: query key 对齐 + 最终验收

**Files:**
- Modify: `web/src/api/servers.ts`（如需）
- Modify: `docs/superpowers/specs/2026-07-06-frontend-design-standardization-design.md`（如实际情况与 spec 出入则更新）

**Interfaces:**
- Consumes: 全部前序任务

- [ ] **Step 1: 检查 useServers query key**

Read `web/src/api/servers.ts`：确认 key 形如 `['servers', { withLatest }]`（参数入 key）。Dashboard 与 ServerList 都用 `{withLatest:true}` → 应共享同一缓存条目（ServerList 的动态 1.5s interval 会成为该 key 的实际节拍，react-query 取各订阅者最小 interval，这是期望行为）。AdminLayout 的无参 `useServers()` 是不同数据形态，保留独立 key。若发现 key 未包含参数（缓存互踩）则修正为参数化 key。

- [ ] **Step 2: 全量验证**

```bash
./scripts/check-ui-tokens.sh
cd web && npm run build && npx vitest run
```
Expected: 全 PASS

- [ ] **Step 3: 端到端冒烟（两主题）**

起后端（项目惯例，如 `make run` 或 `go run ./cmd/...` — 以 Makefile/README 为准）+ `cd web && npm run dev`。浏览器过一遍：Dashboard / Hosts（网格+表格+排序+空筛选）/ 主机详情（含 Console）/ Settings / Files / Scripts / Audit（滚动虚拟化）/ 六个插件各 tab / 公开墙。浅色主题一遍、深色主题一遍（ThemeToggle 切换），确认无样式破损、无刺眼错色。发现问题当场修。

- [ ] **Step 4: 懒加载回归确认**

Run: `grep -c "lazy(" web/src/App.tsx`
Expected: ≥15（与现状一致，无回退）

- [ ] **Step 5: 最终 commit**

```bash
git add -A
git commit -m "chore(web): final polish for design standardization"
```
