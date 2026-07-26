# Frontend Unification R2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-07-25-frontend-unification-r2-design.md` 统一 web 前端：修 token 缺陷、建表格 primitives、6 个插件页对齐主界面规范（表格/空状态/i18n）、收敛 Button/Dialog/Toast/徽章。

**Architecture:** 先改共享层（`ui/table.tsx`、`ui/button.tsx`、`ui/toast(er)`、token），再逐页迁移消费方。所有颜色走 CSS 变量 token，无 `dark:` 前缀、无调色板类、无 hex。

**Tech Stack:** React 18 + Vite + Tailwind 3 + shadcn/ui + zustand + react-i18next + vitest（jsdom + testing-library）。

## Global Constraints

- 工作目录：`/Users/hg/project/Shepherd/web`（命令均在此执行；`check-ui-tokens.sh` 在仓库根 `scripts/`）。
- 分支：`frontend-unification-r2`（从 `main` 切出，Task 1 创建）。
- 验证命令：`npm run build`（含 tsc --noEmit）、`npm test`（vitest run）、`bash ../scripts/check-ui-tokens.sh`。每个任务结束三者必须全绿再 commit。
- **表格规范（唯一真源，所有迁移任务遵守）**：
  - 容器：`Table`（自带 `overflow-x-auto rounded-lg border bg-elev` 外壳）。调用方原有的 `border rounded-lg bg-elev` / `overflow-hidden` 外层 div 删除。
  - 表头：`TableHead` = `px-3 py-2 text-left align-middle font-medium text-2xs uppercase tracking-[0.05em] text-muted-foreground`。禁止 `tracking-wide`、`px-4`、`py-1.5`、`pr-4` 变体。
  - 数据行：`TableRow` = `border-b hover:bg-sunken/60`。禁止 `hover:bg-background/40`。失败行等特例用 `className` 覆盖（如 `hover:bg-err-soft/30`）。
  - 单元格：`TableCell` = `px-3 py-2`（表格根 `text-sm`）。
  - 空状态：`TableEmpty colSpan={n}`，文案必须走 i18n。禁止手写 colSpan 空行。
- **i18n 规范**：文案 key 放各插件既有顶层命名空间（`sshaudit`/`singbox`/`xray`/`netquality`/`subgen`；`cloudflare` 为新增），en 与 zh-CN 两个文件同步加 key，结构镜像。组件内 `const { t } = useTranslation()`。测试断言随文案改为断言 i18n 后的默认语言（fallback `zh-CN`）或用 key 渲染值。
- **Dialog 规范**：宽度仅 `max-w-sm` / `max-w-lg` / `max-w-2xl` 三档；内容高度上限统一 `max-h-[80vh]`。
- **Button 规范**（Task 3 之后生效）：`xs`=h-7、`sm`=h-8，禁止 className 里出现 `h-7`/`h-8` 覆盖 Button 高度。
- 提交信息用 `feat(web):` / `fix(web):` / `refactor(web):` 前缀，每任务一个 commit。
- 视觉基线：改动只允许发生在规范收敛处（表头 padding、按钮高度、空状态样式、Dialog 宽度），其余像素不变。

---

### Task 1: 分支 + token 修复（--glow-primary、ok/warn/err alpha）

**Files:**
- Modify: `src/index.css:29`（:root）、`src/index.css:80`（.dark）
- Modify: `tailwind.config.ts:61-72`

**Interfaces:**
- Produces: CSS 变量 `--glow-primary`（两主题）；Tailwind 类 `border-ok/30`、`bg-ok/10`、`bg-warn/15`、`bg-err/15`、`border-primary/40`、`border-ok/40` 等 opacity 修饰符可用（后续 Task 4/7 依赖）。

- [ ] **Step 1: 创建分支**

```bash
cd /Users/hg/project/Shepherd && git checkout -b frontend-unification-r2
```

- [ ] **Step 2: 定义 --glow-primary**

`src/index.css` `:root` 块内 `--ring: 217 89% 47%;` 之后加：

```css
    --glow-primary: 217 89% 47%;        /* button/Login glow — follows primary */
```

`.dark` 块内 `--ring: 213 92% 67%;` 之后加：

```css
    --glow-primary: 213 92% 67%;
```

- [ ] **Step 3: ok/warn/err 支持 opacity 修饰符**

`tailwind.config.ts` 中三组颜色改为 alpha-value 形式（与 `console`/`elev` 同款写法）：

```ts
        ok: {
          DEFAULT: 'hsl(var(--ok) / <alpha-value>)',
          soft: 'hsl(var(--ok-soft) / <alpha-value>)',
        },
        warn: {
          DEFAULT: 'hsl(var(--warn) / <alpha-value>)',
          soft: 'hsl(var(--warn-soft) / <alpha-value>)',
        },
        err: {
          DEFAULT: 'hsl(var(--err) / <alpha-value>)',
          soft: 'hsl(var(--err-soft) / <alpha-value>)',
        },
```

- [ ] **Step 4: 验证**

```bash
npm run build && npm test && bash ../scripts/check-ui-tokens.sh
```
Expected: 全绿；`grep -c 'glow-primary' src/index.css` 输出 2。

- [ ] **Step 5: Commit**

```bash
git add src/index.css tailwind.config.ts && git commit -m "fix(web): define --glow-primary, add alpha-value to ok/warn/err tokens"
```

---

### Task 2: 表格 primitives（ui/table.tsx + TableEmpty + SortableTh 重构）

**Files:**
- Modify: `src/components/ui/table.tsx`
- Modify: `src/components/SortableTh.tsx`
- Create: `src/components/ui/table.test.tsx`

**Interfaces:**
- Produces（后续所有迁移任务消费）:
  - `Table({ wrapperClassName?, className?, ...HTMLTableAttributes })` — 渲染 `<div class="w-full overflow-x-auto rounded-lg border bg-elev"><table class="w-full text-sm">`。
  - `TableHeader` / `TableBody` / `TableRow` / `TableHead` / `TableCell` — 同现有导出名，类名按 Global Constraints 表格规范。
  - `TableEmpty({ colSpan: number, children: ReactNode })` — 渲染 `<tr><td colSpan class="px-3 py-6 text-center text-sm text-muted-foreground">`。
  - `SortableTh({ label, sortKey, sort, onToggle, className? })` — API 不变，内部改为渲染 `TableHead`。

- [ ] **Step 1: 写失败测试** `src/components/ui/table.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react'
import { Table, TableBody, TableEmpty } from './table'

test('Table wraps in horizontal-scroll surface', () => {
  const { container } = render(<Table data-testid="t"><TableBody /></Table>)
  const wrapper = container.firstElementChild!
  expect(wrapper.className).toContain('overflow-x-auto')
  expect(wrapper.className).toContain('bg-elev')
})

test('TableEmpty renders spanning placeholder row', () => {
  render(
    <table><tbody><TableEmpty colSpan={5}>nothing here</TableEmpty></tbody></table>,
  )
  const cell = screen.getByText('nothing here')
  expect(cell).toHaveAttribute('colspan', '5')
  expect(cell.className).toContain('py-6')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/ui/table.test.tsx`
Expected: FAIL（`TableEmpty` 未导出；wrapper 无 bg-elev）。

- [ ] **Step 3: 实现** `src/components/ui/table.tsx` 改动点：

Table 组件替换为：

```tsx
interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  wrapperClassName?: string
}

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, wrapperClassName, ...props }, ref) => (
    <div className={cn("w-full overflow-x-auto rounded-lg border bg-elev", wrapperClassName)}>
      <table
        ref={ref}
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
)
```

TableHead 的类改为（去掉 `h-9`，加 `py-2`）：

```tsx
      "px-3 py-2 text-left align-middle font-medium text-2xs uppercase tracking-[0.05em] text-muted-foreground [&:has([role=checkbox])]:pr-0",
```

文件尾部（TableCaption 之后）新增并加入 export 列表：

```tsx
function TableEmpty({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-6 text-center text-sm text-muted-foreground">
        {children}
      </td>
    </tr>
  )
}
```

`SortableTh.tsx` 中 `<th className={cn('cursor-pointer select-none', className)}` 改为 `<TableHead className={cn('cursor-pointer select-none', className)}`（导入 `TableHead`，闭合标签同步），其余不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/ui/table.test.tsx && npm test`
Expected: 新测试 PASS；全量测试无回归（SortableTh 现有消费方 className 带自己的 padding，`cn`/tailwind-merge 会以调用方为准）。

- [ ] **Step 5: 验证 + Commit**

```bash
npm run build && git add src/components/ui/table.tsx src/components/ui/table.test.tsx src/components/SortableTh.tsx && git commit -m "feat(web): project-style table primitives + TableEmpty; SortableTh on TableHead"
```

---

### Task 3: Button 尺寸档位 xs/sm + 清除 98 处高度覆盖

**Files:**
- Modify: `src/components/ui/button.tsx:23-28`
- Modify: 所有含 `<Button ... className="...h-7/h-8..."` 的页面（用 Step 2 的 grep 得到精确清单，约 40 文件）

**Interfaces:**
- Produces: `size="xs"`（h-7 px-2 text-xs）、`size="sm"`（h-8 px-3）。所有任务后续新代码禁止再写高度覆盖。

- [ ] **Step 1: 改 buttonVariants**

```ts
      size: {
        default: "h-10 px-4 py-2",
        xs: "h-7 rounded-md px-2 text-xs",
        sm: "h-8 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
```

- [ ] **Step 2: 列出全部覆盖点**

```bash
grep -rn 'size="sm"' src --include='*.tsx' | grep -E 'h-[78]'
```

- [ ] **Step 3: 逐处替换**

规则（对 Step 2 清单每一行）：
- className 含 `h-7` → 改 `size="xs"`，从 className 删除 `h-7` 及伴随的 `px-2`/`text-xs`（variant 已含）。
- className 含 `h-8` → 保持 `size="sm"`，从 className 删除 `h-8`（伴随 `px-4` 等 padding 覆盖若有意为之则保留）。
- className 因此变空则删掉整个 className 属性。

- [ ] **Step 4: 验证清零 + 全量测试**

```bash
grep -rn 'size="sm"' src --include='*.tsx' | grep -cE 'h-[78]' ; grep -rn 'size="xs"' src --include='*.tsx' | grep -cE 'h-[78]'
npm run build && npm test
```
Expected: 两个计数都是 0；build/test 全绿。

- [ ] **Step 5: Commit**

```bash
git add -A src && git commit -m "refactor(web): button xs/sm size variants, drop 98 ad-hoc height overrides"
```

---

### Task 4: Toast info/success variant + 标题 i18n

**Files:**
- Modify: `src/components/ui/toast.tsx:30-40`（toastVariants）
- Modify: `src/components/ui/toaster.tsx`
- Modify: `src/locales/en.json`、`src/locales/zh-CN.json`（新增顶层 `toast` 命名空间）
- Test: `src/components/ui/toaster.test.tsx`（已存在，扩展）

**Interfaces:**
- Consumes: Task 1 的 `border-ok/40`。
- Produces: toast variant `info` / `success`；i18n key `toast.error` / `toast.success` / `toast.info`。

- [ ] **Step 1: 写失败测试**（追加到 `toaster.test.tsx`，沿用该文件现有的渲染/StoreProvider 方式）：

```tsx
test('success and info toasts are visually distinct', () => {
  useUI.getState().toast('success', 'saved')
  useUI.getState().toast('info', 'heads up')
  render(<Toaster />)
  const success = screen.getByText('saved').closest('li')!
  const info = screen.getByText('heads up').closest('li')!
  expect(success.className).not.toEqual(info.className)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/ui/toaster.test.tsx`
Expected: FAIL（两者 className 相同，均为 default variant）。

- [ ] **Step 3: 实现**

`toast.tsx` variants 增加：

```ts
        success: "border-ok/40 bg-background text-foreground",
        info: "border-primary/40 bg-background text-foreground",
```

`toaster.tsx` 的 `ToastItem`：

```tsx
import { useTranslation } from 'react-i18next'
// ...
function ToastItem({ t, onDismiss }: { t: UIToast; onDismiss: (id: number) => void }) {
  const { t: tr } = useTranslation()
  useEffect(() => { /* 不变 */ }, [t.id, onDismiss])
  const variant = t.kind === 'error' ? 'destructive' : t.kind === 'success' ? 'success' : 'info'
  return (
    <Toast variant={variant} onOpenChange={(open) => { if (!open) onDismiss(t.id) }}>
      <div className="grid gap-1">
        <ToastTitle>{tr(`toast.${t.kind}`)}</ToastTitle>
        <ToastDescription>{t.message}</ToastDescription>
      </div>
      <ToastClose />
    </Toast>
  )
}
```

locale 两文件顶层加（en / zh-CN 对应）：

```json
"toast": { "error": "Error", "success": "Success", "info": "Info" }
```
```json
"toast": { "error": "错误", "success": "成功", "info": "提示" }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/ui/toaster.test.tsx && npm test && npm run build`
Expected: PASS，全绿。

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/toast.tsx src/components/ui/toaster.tsx src/components/ui/toaster.test.tsx src/locales && git commit -m "feat(web): toast success/info variants, i18n titles"
```

---

### Task 5: Dialog 宽高收敛（3 档宽 + 80vh）

**Files:**
- Modify: `src/components/RunLogDialog.tsx:35,59`
- Modify: `src/pages/admin/FileBrowserPage.tsx:566,570`
- Modify: `src/pages/admin/plugins/subgen/TemplatesTab.tsx:352,359,543`
- Modify: `src/pages/admin/plugins/subgen/SubscriptionsTab.tsx:348`

**Interfaces:** 无新接口，纯类名替换。

- [ ] **Step 1: 替换**（行号为当前 HEAD，先 grep 复核）

| 位置 | 现值 → 新值 |
|---|---|
| `RunLogDialog.tsx:35` | `max-w-3xl` → `max-w-2xl` |
| `RunLogDialog.tsx:59` | `max-h-[60vh]` → `max-h-[80vh]` |
| `FileBrowserPage.tsx:566` | `max-w-4xl` → `max-w-2xl` |
| `FileBrowserPage.tsx:570` | `max-h-[60vh]` → `max-h-[80vh]` |
| `TemplatesTab.tsx:352` | `max-w-4xl` → `max-w-2xl` |
| `TemplatesTab.tsx:359,543` | `max-h-[65vh]` → `max-h-[80vh]` |
| `SubscriptionsTab.tsx:348` | `max-h-[60vh]` → `max-h-[80vh]` |

- [ ] **Step 2: 验证清零**

```bash
grep -rn 'max-w-3xl\|max-w-4xl\|max-h-\[6[05]vh\]' src --include='*.tsx'
npm run build && npm test
```
Expected: grep 无输出；全绿。

- [ ] **Step 3: Commit**

```bash
git add -A src && git commit -m "refactor(web): converge dialog widths to sm/lg/2xl, content max-h to 80vh"
```

---

### Task 6: 徽章归一 — Badge 迁 Pill，删 badge.tsx

**Files:**
- Modify: `src/pages/admin/plugins/singbox/CertificatesTab.tsx:5` 及其 `<Badge>` 用点
- Modify: `src/pages/admin/plugins/subgen/TemplatesTab.tsx:17` 及其 `<Badge>` 用点
- Delete: `src/components/ui/badge.tsx`

**Interfaces:**
- Consumes: `Pill({ kind: 'ok'|'warn'|'err'|'neutral', children })`（`src/components/Pill.tsx`）。

- [ ] **Step 1: 迁移两处用点**

先读两文件中每个 `<Badge variant=...>` 的语义，按映射替换为 `<Pill kind=...>`：`default`→`ok`、`secondary`/`outline`→`neutral`、`destructive`→`err`。import 改为 `import { Pill } from '@/components/Pill'`。

- [ ] **Step 2: 删除死组件并验证零引用**

```bash
grep -rn "ui/badge" src --include='*.tsx' --include='*.ts'
```
Expected: 无输出。然后 `rm src/components/ui/badge.tsx`。

- [ ] **Step 3: 验证 + Commit**

```bash
npm run build && npm test
git add -A src && git commit -m "refactor(web): single badge component — migrate ui/badge usages to Pill, delete badge.tsx"
```

---

### Task 7: MetricCard 任意值语法 → token 类

**Files:**
- Modify: `src/components/MetricCard.tsx:44-46,110-112`

**Interfaces:**
- Consumes: Task 1 的 alpha-value token 类。

- [ ] **Step 1: 替换**（数值就近取 Tailwind opacity 档，视觉差 ≤2%）

`:44-46`：

```tsx
          status === 'ok' && 'border-ok/30',
          status === 'warn' && 'border-warn/50',
          status === 'err' && 'border-err/50',
```

`:110-112`：

```tsx
              tone === 'ok' && 'bg-ok/10 text-ok',
              tone === 'warn' && 'bg-warn/15 text-warn',
              tone === 'err' && 'bg-err/15 text-err',
```

- [ ] **Step 2: 验证清零 + Commit**

```bash
grep -n 'hsl(var(--' src/components/MetricCard.tsx
npm run build && npm test
git add src/components/MetricCard.tsx && git commit -m "refactor(web): MetricCard uses token alias classes instead of arbitrary hsl values"
```
Expected: grep 无输出；全绿。

---

### Task 8: FileBrowserPage 原生弹窗清理（alert → toast，prompt → Dialog）

**Files:**
- Modify: `src/pages/admin/FileBrowserPage.tsx:125`（alert）、`:138-146`（handleMkdir）+ 文件尾部 Dialog 区域
- Modify: `src/locales/en.json`、`src/locales/zh-CN.json`（`files` 命名空间加 key）

**Interfaces:**
- Consumes: `useUI((s) => s.toast)`（`src/store/ui.ts:16`，签名 `toast(kind, message)`）；`Dialog`/`DialogContent`/`Input`/`Button`（文件已 import Dialog 系）。

- [ ] **Step 1: alert → error toast**

组件顶部取 `const toast = useUI((s) => s.toast)`（该文件已 import `useUI` 则复用；否则加 import）。`:125` 改为：

```tsx
      .catch((err) => toast('error', t('files.preview_failed', { err: String(err) })))
```

- [ ] **Step 2: prompt → 单字段 Dialog**

新增 state 与提交逻辑（替换 `handleMkdir`）：

```tsx
const [mkdirOpen, setMkdirOpen] = useState(false)
const [mkdirName, setMkdirName] = useState('')

const handleMkdir = async () => {
  const name = mkdirName.trim()
  if (!name) return
  await mkdir.mutateAsync({
    server_id: sid,
    path: cwd === '/' ? `/${name}` : `${cwd}/${name}`,
    mode: 0o755,
  })
  setMkdirOpen(false)
  setMkdirName('')
}
```

原触发点（调用 `handleMkdir` 的按钮）改为 `onClick={() => setMkdirOpen(true)}`。文件尾部与预览 Dialog 并列处新增：

```tsx
<Dialog open={mkdirOpen} onOpenChange={setMkdirOpen}>
  <DialogContent className="max-w-sm">
    <DialogHeader><DialogTitle>{t('files.new_folder')}</DialogTitle></DialogHeader>
    <Input
      value={mkdirName}
      onChange={(e) => setMkdirName(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') handleMkdir() }}
      placeholder={t('files.folder_name')}
      autoFocus
    />
    <div className="flex justify-end gap-2">
      <Button variant="outline" size="sm" onClick={() => setMkdirOpen(false)}>{t('common.cancel')}</Button>
      <Button size="sm" onClick={handleMkdir} disabled={!mkdirName.trim()}>{t('common.create')}</Button>
    </div>
  </DialogContent>
</Dialog>
```

locale `files` 命名空间加 key（en：`"preview_failed": "Preview failed: {{err}}"`、`"new_folder": "New folder"`、`"folder_name": "Folder name"`；zh-CN：`"preview_failed": "预览失败：{{err}}"`、`"new_folder": "新建文件夹"`、`"folder_name": "文件夹名称"`）。`common.cancel`/`common.create` 若缺则同步补齐。

- [ ] **Step 3: 验证清零 + Commit**

```bash
grep -n 'alert(\|prompt(' src/pages/admin/FileBrowserPage.tsx
npm run build && npm test
git add -A src && git commit -m "fix(web): replace native alert/prompt in FileBrowserPage with toast and dialog"
```
Expected: grep 无输出；全绿。

---

### Task 9: 主界面表格迁移（7 文件）

**Files:**
- Modify: `src/pages/admin/ServerList.tsx`、`src/pages/admin/ScriptRunsPage.tsx`、`src/pages/admin/ScriptsListPage.tsx`、`src/pages/admin/ScriptRunDetailPage.tsx`、`src/pages/admin/FileBrowserPage.tsx`、`src/pages/admin/AuditLogPage.tsx`（虚拟化，仅样式）、`src/pages/public/Wall.tsx`（仅结构与空状态，保留 font-mono 视觉）

**Interfaces:**
- Consumes: Task 2 全部 primitives。

- [ ] **Step 1: 逐文件迁移**

模式（以 ScriptRunsPage 为例，其余同构）——before：

```tsx
<div className="border rounded-lg bg-elev overflow-hidden">
  <table className="w-full text-sm">
    <thead>
      <tr className="border-b text-2xs uppercase tracking-[0.05em] text-muted-foreground">
        <th className="px-4 py-2 text-left">...</th>
```

after：

```tsx
<Table>
  <TableHeader>
    <TableRow className="hover:bg-transparent">
      <TableHead>...</TableHead>
```

规则：
- 原手写外壳 div 删除（Table 自带）；表头行不需要 hover 时加 `className="hover:bg-transparent"`。
- `<tbody>` → `TableBody`；数据行 `<tr className="border-b hover:bg-sunken/60">` → `<TableRow>`（特例覆盖保留，如 ScriptRunDetailPage 失败行 `hover:bg-err-soft/30`）。
- `<td className="px-4 py-2...">` → `<TableCell>`（padding 交给组件，其余修饰类保留）。
- 手写空行 → `<TableEmpty colSpan={n}>{t('...')}</TableEmpty>`（沿用该页现有 i18n key）。
- SortableTh 调用点：删除重复的 padding/字号 className（组件已带）。
- **AuditLogPage（虚拟化）**：保留虚拟化结构（不包 Table 组件，虚拟行结构不动），仅把 th/td/空状态的类名对齐上述规范值。
- **Wall.tsx（公开页）**：结构迁 primitives，但其 `font-mono` 字体与自有配色通过 className 保留，不改视觉。

- [ ] **Step 2: 验证**

```bash
grep -rn '<table' src/pages/admin/ServerList.tsx src/pages/admin/Script*.tsx src/pages/admin/FileBrowserPage.tsx src/pages/public/Wall.tsx
npm run build && npm test
```
Expected: grep 无输出（AuditLogPage 允许保留原生 table 结构）；全绿。逐页人工过一遍 UI（`npm run dev`）确认无布局破坏。

- [ ] **Step 3: Commit**

```bash
git add -A src && git commit -m "refactor(web): migrate main-UI tables to shared table primitives"
```

---

### Task 10–15: 插件页对齐（每插件一个任务、一个 commit）

六个任务同一套操作规程，仅文件清单不同。**每个任务独立执行 Step 1–5 并 commit。**

**Files（按任务）：**

| Task | 插件 | 迁移文件 | commit 信息 |
|---|---|---|---|
| 10 | cloudflare | `DnsTab.tsx`、`HostsTab.tsx`、`ZonesTab.tsx`、`ActivityTab.tsx`、`SetupTab.tsx`、`index.tsx` | `refactor(web): align cloudflare plugin pages with design system + i18n` |
| 11 | netquality | `HostsTab.tsx`、`ResultsTab.tsx`、`TargetsTab.tsx`、`HostTargetsDialog.tsx`、`HistoryDrawer.tsx`、`index.tsx` | `refactor(web): align netquality plugin pages with design system + i18n` |
| 12 | sshaudit | `HostsTab.tsx`、`HistoryTab.tsx`、`SessionsTab.tsx`、`HardeningTab.tsx`、`index.tsx` | `refactor(web): align sshaudit plugin pages with design system + i18n` |
| 13 | subgen | `SubscriptionsTab.tsx`、`TemplatesTab.tsx`、`index.tsx` | `refactor(web): align subgen plugin pages with design system + i18n` |
| 14 | singbox | `InboundsTab.tsx`、`CertificatesTab.tsx`、`DeployTab.tsx`、`EventsTab.tsx`、`TrafficTab.tsx`、`LogsTab.tsx`、`InboundDialog.tsx`、`BulkRelayDialog.tsx`、`TrafficDrawer.tsx`、`index.tsx` | `refactor(web): align singbox plugin pages with design system + i18n` |
| 15 | xray | `InboundsTab.tsx`、`DeployTab.tsx`、`EventsTab.tsx`、`TrafficTab.tsx`、`LogsTab.tsx`、`InboundDialog.tsx`、`BulkRelayDialog.tsx`、`TrafficDrawer.tsx`、`index.tsx` | `refactor(web): align xray plugin pages with design system + i18n` |

（路径前缀均为 `src/pages/admin/plugins/<插件名>/`；对应 `*.test.tsx` 随文案改动同步更新断言。）

**Interfaces:**
- Consumes: Task 2 primitives、Task 4 toast、Global Constraints 的表格/i18n 规范。
- Produces: 无新接口。

每个任务的步骤：

- [ ] **Step 1: 表格迁移** — 该插件所有含 `<table` 的文件按 Task 9 Step 1 的完全相同规则迁移到 primitives；空状态一律 `<TableEmpty colSpan={n}>{t('<ns>.empty.<表名>')}</TableEmpty>`。EventsTab 若为虚拟化表（singbox/xray），按 AuditLogPage 规则仅对齐类名。

- [ ] **Step 2: i18n 全量抽取** — 逐文件把硬编码英文 UI 文案（标题、表头、按钮、空状态、说明、toast message、Dialog 文案；`title=` tooltip 也算）替换为 `t('<ns>.<key>')`。命名空间：本插件既有顶层 ns（cloudflare 新建）。en.json 填原英文文案，zh-CN.json 填对应中文。已有 key 复用不重复造。**不翻译**：协议名、字段代码值、日志正文等数据内容。

- [ ] **Step 3: 样式规范化** — 消灭 `tracking-wide`（表头）、`hover:bg-background/40`；tab 内小节标题统一 `text-lg font-semibold`；页面/Tab 根容器间距统一 `space-y-4`。

- [ ] **Step 4: 验证**

```bash
grep -rn '<table\|tracking-wide\|hover:bg-background/40' src/pages/admin/plugins/<插件名>/ --include='*.tsx' | grep -v test
npx vitest run src/pages/admin/plugins/<插件名>/
npm run build
```
Expected: grep 无输出（虚拟化 EventsTab 的 `<table` 除外，如有）；该插件测试与 build 全绿。文案改动导致的测试断言失败在本任务内修复。

- [ ] **Step 5: Commit** — 用上表对应 commit 信息，`git add -A src && git commit`。

---

### Task 16: 终验 + PR

**Files:** 无新改动（只验证与交付）。

- [ ] **Step 1: 全量门禁**

```bash
npm run build && npm test && bash ../scripts/check-ui-tokens.sh
```
Expected: 全绿。

- [ ] **Step 2: 规范清零审计**

```bash
cd /Users/hg/project/Shepherd/web
grep -rn 'tracking-wide' src/pages --include='*.tsx'                                  # 期望 0
grep -rn 'hover:bg-background/40' src --include='*.tsx'                               # 期望 0
grep -rn 'max-w-3xl\|max-w-4xl\|max-h-\[6[05]vh\]' src --include='*.tsx'              # 期望 0
grep -rn 'alert(\|prompt(' src/pages --include='*.tsx'                                # 期望 0
grep -rn 'ui/badge' src                                                               # 期望 0
grep -rn 'size="sm"' src --include='*.tsx' | grep -cE 'h-[78]'                        # 期望 0
grep -rn 'hsl(var(--' src/components/MetricCard.tsx                                   # 期望 0
grep -rln '<table' src/pages --include='*.tsx'                                        # 期望仅虚拟化文件
```

- [ ] **Step 3: 视觉抽查** — `npm run dev`，浅/深两主题各过一遍：Dashboard、ServerList 双视图、任一 Script 页、FileBrowser（含新建文件夹 Dialog）、6 个插件页、公开 Wall。确认变化仅限规范收敛处。

- [ ] **Step 4: 交付** — 用 superpowers:finishing-a-development-branch 技能收尾（push 分支 + PR，PR 描述引用 spec 文档）。

---

## Self-Review 记录

- Spec 覆盖：A1→T1、A2→T2+T9、A3→T3、A4→T4、A5→T5、A6→T6、A7→T1+T7、A8→T8、B→T10-15、C→各任务验证步骤+T16。无缺口。
- 类型/命名一致：`TableEmpty(colSpan, children)`、`Table(wrapperClassName)`、`toast(kind, message)`、`t('toast.error')` 全文一致。
- 无占位符：迁移类任务以"完全相同的规则 + 精确文件清单 + 清零 grep"表达，i18n 以抽取规则 + 命名空间约定表达（逐字串枚举 20 个文件不现实，规则本身即完整指令）。
