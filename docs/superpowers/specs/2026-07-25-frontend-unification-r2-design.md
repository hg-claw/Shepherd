# 前端统一规范第二轮（Frontend Unification R2）设计

日期：2026-07-25
状态：已确认
前置：PR #125（frontend-standardization）已建立 token 体系与共享组件（PageHeader / EmptyState / LoadingState / ErrorState / ConfirmDialog / StatCard / SortableTh），硬编码颜色已清零。本轮解决"主界面已规范、插件页未跟进"及剩余全局不一致。

## 目标

1. 修复 token 层缺陷（死变量、任意值语法绕过）。
2. 建立统一表格体系，消灭 27 处手写 `<table>` 的样式漂移。
3. 6 个插件（sshaudit / subgen / singbox / xray / cloudflare / netquality）共 20 个 Tab 页对齐主界面规范：PageHeader、空状态、表格样式、i18n。
4. 收敛 Button 尺寸、Dialog 宽高、Toast variant、徽章组件双轨。

不做（后续轮次）：42 文件响应式补齐、卡片表面 class 收敛、大文件拆分。

## A. 共享层改造

### A1. `--glow-primary` 死 token
`ui/button.tsx:13` 与 `Login.tsx:50` 引用了 `index.css` 中不存在的 `--glow-primary`，阴影声明非法被浏览器丢弃。在 `:root` 与 `.dark` 各定义 `--glow-primary`（取 primary 色相的 HSL 分量），恢复两处辉光效果。

### A2. 表格 primitives
现状：`ui/table.tsx`（shadcn 原版）零引用；27 处手写表格中表头 padding 4 种、hover 3 种、表头 tracking 2 种、空状态全部手写 colSpan。

改造 `ui/table.tsx` 为项目风格 primitives（不引入重抽象，保持组合式）：

- `Table`：外层自带 `overflow-x-auto` 滚动容器 + 表面样式（`border rounded-lg bg-elev`），解决窄屏溢出。
- `Th`：`px-3 py-2 text-2xs font-medium uppercase tracking-[0.05em] text-muted-foreground text-left`。
- `Tr`（数据行）：`hover:bg-sunken/60`；失败行等特例允许调用方覆盖。
- `Td`：`px-3 py-2 text-sm`。
- `TableEmpty`：`<TableEmpty colSpan={n}>{文案}</TableEmpty>`，内部统一 `px-3 py-6 text-center text-sm text-muted-foreground`，文案必填并走 i18n。
- `SortableTh` 重构为基于 `Th`，API 不变。

迁移全部 27 处手写表格（主界面 + 插件页）。已虚拟化的两个表（AuditLogPage、插件 EventsTab）保持虚拟化实现，仅对齐 Th/Td/空状态样式。

### A3. Button 尺寸档位
现状：`size="sm"`(h-9) 共 126 处使用，其中 68 处覆盖为 h-7、30 处覆盖为 h-8，默认高度几乎无人使用。

- `buttonVariants` 新增 `xs`: h-7；`sm` 改为 h-8（含对应 px/text 调整）。
- 全局替换：`size="sm" className="h-7..."` → `size="xs"`；`size="sm" className="h-8..."` → `size="sm"`，移除全部 98 处高度覆盖。
- 裸 `size="sm"`（原 h-9 渲染）约 28 处随 sm 档变为 h-8，视觉略紧凑，属预期收敛。

### A4. Toast
- `toaster.tsx` 为 `info` 增加独立 variant（accent/primary 色 ring 与图标，与 success 区分）。
- 标题 `'Error'/'Success'/'Info'` 改走 i18n key（`toast.error` / `toast.success` / `toast.info`，en+zh）。

### A5. Dialog 宽高收敛
宽度只允许三档：`max-w-sm`（简单确认/单字段）、`max-w-lg`（常规表单）、`max-w-2xl`（宽表单/预览）。现有 `max-w-3xl`/`max-w-4xl` 归入 `max-w-2xl`。内容高度上限统一 `max-h-[80vh]`（内部滚动），现有 `65vh`/`60vh` 调整。共 11 处。

### A6. 徽章归一：Pill 胜出
`Pill`（22 文件，语义色 ok/warn/err/neutral + 脉冲点）保留为唯一状态徽章。迁移仅有的 2 处 `ui/badge` 用法（`singbox/CertificatesTab.tsx`、`subgen/TemplatesTab.tsx`）到 Pill；确认无其它依赖后删除 `ui/badge.tsx`。

### A7. MetricCard token 别名
`MetricCard.tsx:44-46,110-112` 的 `bg-[hsl(var(--ok)/0.12)]` 等任意值语法改为已注册的 token 类：`border-ok/30`、`bg-ok/12 text-ok`（warn/err 同理）。

### A8. FileBrowserPage 原生弹窗清理
- `:125` `alert(preview failed)` → error toast。
- `:139` `prompt('Folder name:')` → 复用 Dialog 的单字段输入弹窗（与 A5 的 `max-w-sm` 档一致）。

## B. 插件页对齐（6 插件 20 文件）

每个插件 Tab 页统一：

1. 接入 `PageHeader`（页级标题处；Tab 内部小节标题用 `text-lg font-semibold`）。
2. 表格全部迁到 A2 primitives，空状态用 `TableEmpty`。
3. 表头 tracking 统一 `[0.05em]`（消灭 netquality/sshaudit 的 `tracking-wide`）、行 hover 统一 `sunken/60`（消灭 xray/singbox TrafficTab 的 `background/40`）。
4. **i18n 全量补齐**：所有硬编码英文 UI 文案换 `useTranslation`，en + zh 双语 key。现状覆盖率：cloudflare 0/6、xray 1/9、singbox 2/10、netquality 1/6、sshaudit 2/5、subgen 2/3。
5. 页面根间距统一 `space-y-4`。

## C. 验证与交付

- `npm run build`、`check-ui-tokens`、lint、现有测试全绿。
- 迁移前后逐页截图对比：视觉变化应仅限规范收敛处（表头 padding、空状态样式、按钮高度），无功能变化。
- 独立分支 + PR：共享层（A）一个 commit；之后每插件一个 commit；主界面表格迁移一个 commit。

## 风险

- Button sm 档 h-9→h-8 影响约 28 处未覆盖调用点：视觉更紧凑，需截图确认无布局破坏。
- 表格迁移量大（27 处）且涉及虚拟化表格：虚拟化表仅换样式不换结构。
- 删除 `ui/badge.tsx` 前需 grep 确认零引用（含间接引用）。
