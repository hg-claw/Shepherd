# 中继协议解耦 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 InboundDialog 能创建中继 inbound，代理模式下中继协议可与落地协议不同（例如入口 snell、落地 vless-reality），并修掉 BulkRelayDialog 代理模式建 reality 中继必失败的 bug。

**Architecture:** 纯前端改动，后端零改动——`validatePostInbound` 对 relay 只要求上游存在且是 landing，不限制协议组合；`collect.go` 的 proxy 分支已按中继自己的协议输出订阅。InboundDialog 新增角色/上游/模式三个控件；转发模式折叠掉所有协议字段并沿用落地协议，代理模式放开全部 20 个协议并复用既有的按协议字段谓词。

**Tech Stack:** React 18 + Vite + TypeScript + TanStack Query + shadcn/ui + react-i18next；测试 vitest + @testing-library/react。

## Global Constraints

- 工作目录 `/Users/hg/project/Shepherd`，分支 `relay-protocol-decoupling`（已存在，spec 在其上）。
- 前端验证：`web/` 下 `npm run build && npm test`；仓库根 `bash scripts/check-ui-tokens.sh`。
- **后端不得修改**。任何需要动 `internal/` 的想法都说明理解有误——先停下报告。
- i18n：新增文案的 key 必须同时加入 `web/src/locales/en.json` 与 `web/src/locales/zh-CN.json`，**两个文件的 key 结构必须完全一致**（本仓库已有的硬性不变量）。key 放 `singbox.inbound_dialog.*` 命名空间。
- 设计系统约束（本仓库已收敛，勿回退）：Button 只用 `size="xs"`(h-7)/`sm`(h-8)/`default`，**禁止**用 className 覆盖高度；Dialog 宽度只用 `max-w-sm`/`max-w-lg`/`max-w-2xl`；状态徽章统一用 `Pill`。
- **角色、上游、中继模式都是创建期字段**：后端 `InboundPatch` 没有 `Role`/`RelayMode`/`Protocol`/`UpstreamInboundID`，patch 路径既不读也不写它们。因此这三个控件**只在创建模式出现**，编辑模式（含 `isRelayEdit`）行为完全不变。
- 转发模式提交的 `protocol` 取**所选落地的协议**（不是留空、不是中继自己的选择）——subgen 的 forward 特判读上游协议，列表里的协议标签也依赖它。
- 每个任务一个 commit，前缀 `fix(web):` 或 `feat(web):`。

---

### Task 1: 修复 BulkRelayDialog 代理模式建 reality 中继失败

**Files:**
- Modify: `web/src/pages/admin/plugins/singbox/BulkRelayDialog.tsx`（`buildRelayBody` 的 `vless-reality` 分支）
- Test: `web/src/pages/admin/plugins/singbox/BulkRelayDialog.test.tsx`

**Interfaces:**
- Consumes: `SingboxInbound.reality_handshake_server?: string`、`reality_handshake_port?: number`（`web/src/api/plugins.ts` 已定义，且后端 GET 不脱敏这两个字段——只有 `reality_private_key` 被替换成 `[REDACTED]`）。
- Produces: 无新接口。

**背景**：`validatePostInbound`（`internal/plugins/singbox/inbounds_routes.go`）对 `vless-reality` 无条件要求 `reality_handshake_server` 与 `reality_handshake_port`，而该分支只发 uuid、sni 与三把 reality 密钥。所以今天用批量对话框在代理模式下建 reality 中继**一定失败**，报 `reality_handshake_server required for vless-reality`。

- [ ] **Step 1: 写失败测试**

在 `BulkRelayDialog.test.tsx` 中，按该文件既有测试的构造方式（fixture 落地、渲染、切到 Proxy 模式、勾选一台服务器、点部署、断言 `createSingboxInbound` mock 的入参）新增：

```tsx
it('proxy-mode reality relay carries the landing handshake target with its own keys', async () => {
  // landing fixture must be vless-reality with a handshake target set
  // (mirror the existing landing fixture in this file and add these two fields):
  //   reality_handshake_server: 'www.microsoft.com',
  //   reality_handshake_port: 443,
  //   reality_public_key: 'LANDING_PUB',
  renderDialog()
  await userEvent.click(screen.getByRole('button', { name: /proxy/i }))
  // select one target server + deploy, following this file's existing tests
  ...
  const call = mockCreate.mock.calls[0][0]
  expect(call.reality_handshake_server).toBe('www.microsoft.com')
  expect(call.reality_handshake_port).toBe(443)
  // the relay gets FRESH keys — it must not clone the landing's identity
  expect(call.reality_private_key).toBeTruthy()
  expect(call.reality_public_key).toBeTruthy()
  expect(call.reality_public_key).not.toBe('LANDING_PUB')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/pages/admin/plugins/singbox/BulkRelayDialog.test.tsx`
Expected: FAIL —— `call.reality_handshake_server` 是 `undefined`。**必须先看到这个失败**：不失败说明测试没测到点子上（本轮之前出现过断言与所声称守卫无关的空转测试），此时应修测试而非跳过。

- [ ] **Step 3: 实现**

`buildRelayBody` 的 `vless-reality` 分支加两行：

```ts
  if (proto === 'vless-reality') {
    return {
      ...base,
      uuid: d.uuid,
      sni: landing.sni,
      reality_public_key: d.publicKey,
      reality_private_key: d.privateKey,
      reality_short_id: d.shortID,
      // The backend requires a handshake target for vless-reality
      // unconditionally. Reuse the landing's — the relay still gets its
      // own freshly generated keypair above, only the camouflage target
      // is shared.
      reality_handshake_server: landing.reality_handshake_server,
      reality_handshake_port: landing.reality_handshake_port,
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run src/pages/admin/plugins/singbox/BulkRelayDialog.test.tsx && npm test && npm run build`
Expected: PASS，全量测试与构建全绿。

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/plugins/singbox/BulkRelayDialog.tsx web/src/pages/admin/plugins/singbox/BulkRelayDialog.test.tsx
git commit -m "fix(web): send reality handshake target when bulk-creating proxy relays"
```

---

### Task 2: InboundDialog 角色 / 上游 / 模式三个控件（代理模式提交体）

**Files:**
- Modify: `web/src/pages/admin/plugins/singbox/InboundDialog.tsx`
- Modify: `web/src/locales/en.json`、`web/src/locales/zh-CN.json`
- Test: `web/src/pages/admin/plugins/singbox/InboundDialog.test.tsx`

**Interfaces:**
- Consumes: `listSingboxInbounds()`、`SingboxInbound`（含 `role`、`protocol`、`tag`、`server_name`、`id`）。
- Produces（Task 3、4 依赖）：
  - state `role: 'landing' | 'relay'`（默认 `'landing'`）
  - state `upstreamID: string`（`SingboxInbound.id` 的字符串形式，空串表示未选）
  - state `relayMode: 'forward' | 'proxy'`（默认 `'forward'`）
  - `const landings: SingboxInbound[]` —— 全部 `role === 'landing'` 的 inbound
  - `const selectedLanding: SingboxInbound | undefined` —— `landings.find(l => String(l.id) === upstreamID)`

**本任务只做代理模式的提交体**；转发模式的字段折叠是 Task 3。

- [ ] **Step 1: 写失败测试**

按 `InboundDialog.test.tsx` 既有测试的渲染方式（注意该组件的 props 是 `{ serverID, initial?, open, onClose, onSaved }`，`serverID` 由调用方传入、对话框内不选服务器）新增：

```tsx
it('landing is the default role and shows no relay controls', () => {
  renderDialog()  // create mode: no `initial`
  expect(screen.queryByLabelText(/upstream/i)).not.toBeInTheDocument()
})

it('choosing relay reveals the upstream picker and mode toggle', async () => {
  renderDialog()
  await userEvent.selectOptions(screen.getByLabelText(/role/i), 'relay')
  expect(screen.getByLabelText(/upstream/i)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /proxy/i })).toBeInTheDocument()
})

it('the upstream picker lists only landings', async () => {
  // fixture inbounds must include at least one role='relay' row
  renderDialog()
  await userEvent.selectOptions(screen.getByLabelText(/role/i), 'relay')
  const opts = within(screen.getByLabelText(/upstream/i)).getAllByRole('option')
  const labels = opts.map((o) => o.textContent ?? '')
  expect(labels.some((l) => l.includes('landing-fixture-tag'))).toBe(true)
  expect(labels.some((l) => l.includes('relay-fixture-tag'))).toBe(false)
})

it('proxy-mode relay submits role, upstream and its own protocol credentials', async () => {
  renderDialog()
  await userEvent.selectOptions(screen.getByLabelText(/role/i), 'relay')
  await userEvent.selectOptions(screen.getByLabelText(/upstream/i), '11')  // landing fixture id
  await userEvent.click(screen.getByRole('button', { name: /proxy/i }))
  await userEvent.selectOptions(screen.getByLabelText(/protocol/i), 'snell-v5')
  await userEvent.type(screen.getByLabelText(/psk/i), 'relay-psk-value')
  await userEvent.click(screen.getByRole('button', { name: /create|save/i }))

  const call = mockCreate.mock.calls[0][0]
  expect(call.role).toBe('relay')
  expect(call.relay_mode).toBe('proxy')
  expect(call.upstream_inbound_id).toBe(11)
  // the relay speaks its OWN protocol, not the landing's
  expect(call.protocol).toBe('snell-v5')
  expect(call.password).toBe('relay-psk-value')
})
```

> 测试文件里已有的 mock 方式（`vi.mock('@/api/plugins')` 之类）与 fixture 构造以现状为准；本任务需要 `listSingboxInbounds` 返回至少一个 landing（id 11、tag 含 `landing-fixture-tag`）与一个 relay（tag 含 `relay-fixture-tag`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/pages/admin/plugins/singbox/InboundDialog.test.tsx`
Expected: FAIL —— 找不到 role 下拉。

- [ ] **Step 3: 实现**

在 certs query 附近新增 inbounds query（**用与 InboundsTab 相同的 queryKey**，react-query 会命中同一份缓存，不产生重复请求）：

```ts
  // Same key as InboundsTab's list — react-query serves this from cache
  // instead of refetching. Only needed while creating a relay.
  const { data: allInbounds = [] } = useQuery({
    queryKey: ['singbox', 'inbounds'],
    queryFn: () => listSingboxInbounds(),
  })
  const landings = allInbounds.filter((i) => i.role === 'landing')
```

新增 state（放在既有 form state 之后）：

```ts
  // Relay wiring. These three are create-only: the backend's InboundPatch
  // carries no role / relay_mode / protocol / upstream_inbound_id, so the
  // patch path neither reads nor writes them.
  const [role, setRole]             = useState<'landing' | 'relay'>('landing')
  const [upstreamID, setUpstreamID] = useState<string>('')
  const [relayMode, setRelayMode]   = useState<'forward' | 'proxy'>('forward')

  const selectedLanding = landings.find((l) => String(l.id) === upstreamID)
```

在表单顶部（协议选择器之前）渲染控件，仅创建模式：

```tsx
{!isEdit && (
  <>
    <div className="grid gap-1.5">
      <Label htmlFor="inb-role">{t('singbox.inbound_dialog.role', 'Role')}</Label>
      <select
        id="inb-role"
        value={role}
        onChange={(e) => setRole(e.target.value as 'landing' | 'relay')}
        className={SELECT_CLASS}
      >
        <option value="landing">{t('singbox.inbound_dialog.role_landing', 'Landing')}</option>
        <option value="relay">{t('singbox.inbound_dialog.role_relay', 'Relay')}</option>
      </select>
    </div>
    {role === 'relay' && (
      <>
        <div className="grid gap-1.5">
          <Label htmlFor="inb-upstream">{t('singbox.inbound_dialog.upstream', 'Upstream landing')}</Label>
          <select
            id="inb-upstream"
            value={upstreamID}
            onChange={(e) => setUpstreamID(e.target.value)}
            className={SELECT_CLASS}
          >
            <option value="">{t('singbox.inbound_dialog.upstream_placeholder', 'Select a landing…')}</option>
            {landings.map((l) => (
              <option key={l.id} value={String(l.id)}>
                {l.server_name} / {l.tag} / {l.protocol}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label>{t('singbox.inbound_dialog.relay_mode', 'Relay mode')}</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={relayMode === 'forward' ? 'default' : 'outline'}
              onClick={() => setRelayMode('forward')}
            >
              {t('singbox.inbound_dialog.mode_forward', 'Forward')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={relayMode === 'proxy' ? 'default' : 'outline'}
              onClick={() => setRelayMode('proxy')}
            >
              {t('singbox.inbound_dialog.mode_proxy', 'Proxy')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {relayMode === 'forward'
              ? t('singbox.inbound_dialog.mode_forward_desc', 'Transparently forwards raw bytes to the landing. Clients speak the landing\'s protocol; this relay needs no credentials.')
              : t('singbox.inbound_dialog.mode_proxy_desc', 'This relay terminates its own protocol with its own credentials, then dials the landing. Pick any protocol below — it does not have to match the landing.')}
          </p>
        </div>
      </>
    )}
  </>
)}
```

> `SELECT_CLASS`：复用该文件中既有 `<select>` 的 className 常量或字面量——以文件现状为准，不要新造样式。若文件用的是 shadcn `Select` 而非原生 `select`，改用同款组件并保持 `htmlFor`/`id` 关联（可访问名必须来自 `<Label>`，本仓库刚移除过会覆盖可见标签的 `aria-label`，勿重新引入）。

提交体：把 `body.role = 'landing'` 替换为：

```ts
      if (role === 'relay') {
        body.role = 'relay'
        body.relay_mode = relayMode
        body.upstream_inbound_id = Number(upstreamID)
      } else {
        body.role = 'landing'
      }
```

提交前校验（沿用该文件既有的 `setError` 方式）：角色为中继而未选上游时，报 `t('singbox.inbound_dialog.upstream_required', 'Select an upstream landing')` 并中止提交。

i18n（en / zh-CN 的 `singbox.inbound_dialog` 下同步添加）：

```json
"role": "Role", "role_landing": "Landing", "role_relay": "Relay",
"upstream": "Upstream landing", "upstream_placeholder": "Select a landing…",
"upstream_required": "Select an upstream landing",
"relay_mode": "Relay mode", "mode_forward": "Forward", "mode_proxy": "Proxy",
"mode_forward_desc": "Transparently forwards raw bytes to the landing. Clients speak the landing's protocol; this relay needs no credentials.",
"mode_proxy_desc": "This relay terminates its own protocol with its own credentials, then dials the landing. Pick any protocol below — it does not have to match the landing."
```
```json
"role": "角色", "role_landing": "落地", "role_relay": "中继",
"upstream": "上游落地", "upstream_placeholder": "选择一个落地…",
"upstream_required": "请选择上游落地",
"relay_mode": "中继模式", "mode_forward": "转发", "mode_proxy": "代理",
"mode_forward_desc": "透明转发原始字节到落地。客户端说的是落地的协议，本中继不需要任何凭据。",
"mode_proxy_desc": "本中继用自己的凭据终结自己的协议，再拨号到落地。下面的协议可以随便选，不必与落地相同。"
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run src/pages/admin/plugins/singbox/InboundDialog.test.tsx && npm test && npm run build && bash ../scripts/check-ui-tokens.sh`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/plugins/singbox/InboundDialog.tsx web/src/pages/admin/plugins/singbox/InboundDialog.test.tsx web/src/locales
git commit -m "feat(web): create relay inbounds from the inbound dialog"
```

---

### Task 3: 转发模式折叠字段并沿用落地协议

**Files:**
- Modify: `web/src/pages/admin/plugins/singbox/InboundDialog.tsx`
- Test: `web/src/pages/admin/plugins/singbox/InboundDialog.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `role`、`relayMode`、`selectedLanding`。
- Produces: `const isForward = role === 'relay' && relayMode === 'forward'`（Task 4 用它跳过版本警告）。

**背景**：转发模式的中继在后端渲染成 `direct` 入站（`renderInbound` 在协议 switch 之前短路），协议字段一概不读。表单不该要求填。

- [ ] **Step 1: 写失败测试**

```tsx
it('forward mode hides the protocol picker and all credential fields', async () => {
  renderDialog()
  await userEvent.selectOptions(screen.getByLabelText(/role/i), 'relay')
  await userEvent.selectOptions(screen.getByLabelText(/upstream/i), '11')
  // forward is the default mode
  expect(screen.queryByLabelText(/protocol/i)).not.toBeInTheDocument()
  expect(screen.queryByLabelText(/uuid/i)).not.toBeInTheDocument()
  expect(screen.queryByLabelText(/sni/i)).not.toBeInTheDocument()
})

it('forward mode submits the landing protocol and no credentials', async () => {
  renderDialog()
  await userEvent.selectOptions(screen.getByLabelText(/role/i), 'relay')
  await userEvent.selectOptions(screen.getByLabelText(/upstream/i), '11')  // landing fixture is vless-reality
  await userEvent.click(screen.getByRole('button', { name: /create|save/i }))

  const call = mockCreate.mock.calls[0][0]
  expect(call.relay_mode).toBe('forward')
  // protocol is inherited from the landing so subgen's forward special-case
  // and the inbound list's protocol label keep working
  expect(call.protocol).toBe('vless-reality')
  expect(call.uuid).toBeUndefined()
  expect(call.sni).toBeUndefined()
  expect(call.reality_private_key).toBeUndefined()
  expect(call.cert_id).toBeUndefined()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/pages/admin/plugins/singbox/InboundDialog.test.tsx`
Expected: FAIL —— 协议选择器仍在，且提交体带着凭据。

- [ ] **Step 3: 实现**

在 state 之后定义：

```ts
  // Forward relays render as a sing-box "direct" inbound — the protocol
  // switch is short-circuited server-side, so every protocol field is
  // dead weight. Collapse them and inherit the landing's protocol.
  const isForward = role === 'relay' && relayMode === 'forward'
```

把协议选择器与所有按协议显隐的字段块整体包在 `{!isForward && ( ... )}` 内（端口、别名、以及 Task 2 的三个中继控件**不在**其中）。

提交体改为：

```ts
      const body: Record<string, unknown> = {
        server_id: serverID,
        port:      Number(port),
        protocol:  isForward && selectedLanding ? selectedLanding.protocol : protocol,
      }

      body.alias = alias

      if (!isForward) {
        // ... 既有的 needsUUID / needsPassword / needsCertAndSNI /
        //     needsTransport / needsReality / needsSS / snell extra 全部块
        //     原样搬进这个分支，内容不变 ...
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run src/pages/admin/plugins/singbox/InboundDialog.test.tsx && npm test && npm run build`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/plugins/singbox/InboundDialog.tsx web/src/pages/admin/plugins/singbox/InboundDialog.test.tsx
git commit -m "feat(web): forward-mode relays inherit the landing protocol and hide credential fields"
```

---

### Task 4: snell 的 sing-box 1.14 版本提示

**Files:**
- Create: `web/src/pages/admin/plugins/singbox/version.ts`
- Create: `web/src/pages/admin/plugins/singbox/version.test.ts`
- Modify: `web/src/pages/admin/plugins/singbox/InboundDialog.tsx`
- Modify: `web/src/locales/en.json`、`web/src/locales/zh-CN.json`
- Test: `web/src/pages/admin/plugins/singbox/InboundDialog.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `isForward`；`listPluginHosts('singbox')` 返回的行含 `server_id: number` 与 `deployed_version: string | null`。
- Produces: `export function singboxMinorAtLeast(version: string | null | undefined, wantMajor: number, wantMinor: number): boolean`

**背景**：snell inbound 需要主机 sing-box ≥ 1.14。后端在创建时会 409 拦下（`inboundNeeds114`），本任务只是提前提示，不做置灰——主机版本可能在对话框打开后才变，置灰会把用户卡死。

- [ ] **Step 1: 写失败测试**

`web/src/pages/admin/plugins/singbox/version.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { singboxMinorAtLeast } from './version'

describe('singboxMinorAtLeast', () => {
  it.each([
    ['1.14.0', true], ['v1.14.0', true],
    ['1.14.0-beta.2', true], ['v1.14.0-beta.2', true],
    ['1.15.3', true], ['2.0.0', true],
    ['1.13.14', false], ['1.13.12', false], ['1.9.0', false],
    ['', false], ['garbage', false],
  ])('%s -> %s', (input, want) => {
    expect(singboxMinorAtLeast(input, 1, 14)).toBe(want)
  })

  it('fails closed on null/undefined', () => {
    expect(singboxMinorAtLeast(null, 1, 14)).toBe(false)
    expect(singboxMinorAtLeast(undefined, 1, 14)).toBe(false)
  })
})
```

`InboundDialog.test.tsx` 追加（fixture 需要能控制该 serverID 对应主机的 `deployed_version`）：

```tsx
it('warns when snell is picked on a host below sing-box 1.14', async () => {
  renderDialog()  // host fixture: deployed_version '1.13.14'
  await userEvent.selectOptions(screen.getByLabelText(/protocol/i), 'snell-v5')
  expect(screen.getByText(/1\.14/)).toBeInTheDocument()
})

it('does not warn for snell on 1.14, nor for non-snell on 1.13', async () => {
  renderDialog({ hostVersion: 'v1.14.0-beta.2' })
  await userEvent.selectOptions(screen.getByLabelText(/protocol/i), 'snell-v5')
  expect(screen.queryByText(/1\.14/)).not.toBeInTheDocument()

  renderDialog({ hostVersion: '1.13.14' })
  await userEvent.selectOptions(screen.getByLabelText(/protocol/i), 'trojan-tls')
  expect(screen.queryByText(/1\.14/)).not.toBeInTheDocument()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/pages/admin/plugins/singbox/version.test.ts src/pages/admin/plugins/singbox/InboundDialog.test.tsx`
Expected: FAIL —— `./version` 不存在。

- [ ] **Step 3: 实现**

`web/src/pages/admin/plugins/singbox/version.ts`：

```ts
/**
 * Compares only major.minor, which is all the sing-box 1.14 boundary needs.
 * Tolerates a leading "v" and any pre-release suffix, so "v1.14.0-beta.2"
 * counts as 1.14. Unparseable input returns false — deployed_version is
 * free-form and an unknown value must not silently pass a gate.
 *
 * Mirrors singboxMinorAtLeast in internal/plugins/singbox/version_gate.go.
 * Keep the two in sync.
 */
export function singboxMinorAtLeast(
  version: string | null | undefined,
  wantMajor: number,
  wantMinor: number,
): boolean {
  if (!version) return false
  let s = version.trim().replace(/^v/, '')
  const cut = s.search(/[-+]/)
  if (cut >= 0) s = s.slice(0, cut)
  const parts = s.split('.')
  if (parts.length < 2) return false
  const major = Number(parts[0])
  const minor = Number(parts[1])
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false
  if (major !== wantMajor) return major > wantMajor
  return minor >= wantMinor
}
```

`InboundDialog.tsx` 新增 hosts query 与提示：

```ts
  const { data: hosts = [] } = useQuery({
    queryKey: ['plugin-hosts', 'singbox'],
    queryFn: () => listPluginHosts('singbox'),
  })
  const hostVersion = hosts.find((h) => h.server_id === serverID)?.deployed_version ?? null
  const isSnellProtocol = protocol === 'snell-v5' || protocol === 'snell-v6'
  // Backend refuses the create with 409 anyway (inboundNeeds114); this is
  // just so it isn't a surprise. Not a disable — the host's version can
  // change while the dialog is open.
  const snellNeedsUpgrade = !isForward && isSnellProtocol && !singboxMinorAtLeast(hostVersion, 1, 14)
```

在协议选择器下方渲染（沿用该文件既有的提示文案样式）：

```tsx
{snellNeedsUpgrade && (
  <p className="text-xs text-warn">
    {t('singbox.inbound_dialog.snell_needs_114', 'Snell requires sing-box 1.14+ on this host — upgrade it on the Deploy tab first.')}
  </p>
)}
```

i18n（两个 locale 同步）：

```json
"snell_needs_114": "Snell requires sing-box 1.14+ on this host — upgrade it on the Deploy tab first."
```
```json
"snell_needs_114": "Snell 需要该主机的 sing-box 1.14+，请先在部署页升级。"
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run src/pages/admin/plugins/singbox/ && npm test && npm run build && bash ../scripts/check-ui-tokens.sh`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/plugins/singbox/version.ts web/src/pages/admin/plugins/singbox/version.test.ts web/src/pages/admin/plugins/singbox/InboundDialog.tsx web/src/pages/admin/plugins/singbox/InboundDialog.test.tsx web/src/locales
git commit -m "feat(web): warn when snell is picked on a host below sing-box 1.14"
```

---

### Task 5: 修正误导性说明 + 文档 + 终验

**Files:**
- Modify: `web/src/pages/admin/plugins/singbox/InboundDialog.tsx`（`relay_edit_notice` 文案）
- Modify: `web/src/locales/en.json`、`web/src/locales/zh-CN.json`
- Modify: `docs/singbox.md`

- [ ] **Step 1: 修正文案**

现文案称 handshake server / port「从上游落地继承，此处不可编辑」。这会让人以为改落地能传播到中继——实际上 `renderVlessReality` 读的是中继行自己的列，Task 1 只是在**创建时**把落地的值复制过去。改为：

```json
"relay_edit_notice": "Editing a relay. Its REALITY handshake target was copied from the upstream landing when the relay was created and is stored on this row — changing the landing does not propagate here."
```
```json
"relay_edit_notice": "正在编辑中继。它的 REALITY handshake 目标是创建时从上游落地复制过来的，存在这一行上——改落地不会传播到这里。"
```

- [ ] **Step 2: 更新文档**

`docs/singbox.md` 的中继一节补充：代理模式中继的协议可与落地不同（例：入口 snell-v5、落地 vless-reality），从 inbound 对话框创建；转发模式沿用落地协议、无需凭据；批量对话框只做同协议中继。

- [ ] **Step 3: 全量门禁**

```bash
cd web && npm run build && npm test && cd ..
bash scripts/check-ui-tokens.sh
```
Expected: 全绿

- [ ] **Step 4: 清零审计**

```bash
cd web
grep -rn 'size="sm"\|size="xs"' src/pages/admin/plugins/singbox --include='*.tsx' | grep -cE 'h-[789]'   # 期望 0
grep -rn 'max-w-3xl\|max-w-4xl' src/pages/admin/plugins/singbox --include='*.tsx'                        # 期望无输出
python3 -c "
import json
a=json.load(open('src/locales/en.json')); b=json.load(open('src/locales/zh-CN.json'))
def keys(o,p=''):
    s=set()
    for k,v in o.items():
        kp=f'{p}.{k}' if p else k
        s.add(kp)
        if isinstance(v,dict): s|=keys(v,kp)
    return s
d=keys(a)^keys(b); print('key diff:', d if d else 'none')
"                                                                                                        # 期望 none
```

- [ ] **Step 5: 人工验证（浏览器）**

`npm run dev`，在 inbound 对话框里走一遍：角色切中继 → 上游选一个 vless-reality 落地 → 保持转发模式 → 确认协议选择器与凭据字段都消失 → 创建 → 在列表里确认新行显示为 relay / forward / vless-reality。再建一个：切代理模式 → 协议选 snell-v5 → 确认出现 PSK 与混淆下拉；若该主机低于 1.14 确认出现版本提示。

- [ ] **Step 6: Commit**

```bash
git add web/src/locales web/src/pages/admin/plugins/singbox/InboundDialog.tsx docs/singbox.md
git commit -m "docs: correct the relay handshake notice and document mixed-protocol relays"
```

---

## Self-Review 记录

- **Spec 覆盖**：三控件→T2；转发折叠与协议继承→T3；代理自由协议→T2（提交体）+T3（`!isForward` 包裹）；版本提示→T4；BulkRelayDialog reality 修复→T1；说明文案修正→T5；测试要求逐条落在 T1–T4 的 Step 1。无缺口。
- **类型一致**：`role: 'landing'|'relay'`、`relayMode: 'forward'|'proxy'`、`upstreamID: string`、`selectedLanding`、`isForward`、`singboxMinorAtLeast(version, major, minor)` 全程一致；`upstream_inbound_id` 提交为 `number`（`Number(upstreamID)`）。
- **后端零改动**已写入 Global Constraints，并要求发现需要动 `internal/` 时先停下报告。
- **T1 的 Step 2 明确要求先看到失败**，并说明为何（本轮此前出现过空转测试）。
- 无占位符：所有代码步骤给出可直接使用的代码；标注"以文件现状为准"的只有 select 控件样式与测试 mock 构造，属写法差异而非逻辑缺失。
