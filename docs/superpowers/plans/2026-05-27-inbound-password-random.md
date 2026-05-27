# Inbound Password "Random" Generator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a `new` (random) button to password/key fields in the inbound dialogs — sing-box Password + SS, and xray's (newly built-out) Shadowsocks form.

**Architecture:** Shared `randomPassword()` + method-aware `randomSSKey()` in `xray/templates.ts`; wired into both InboundDialogs as buttons mirroring the existing UUID `new` button. xray's Shadowsocks form is built out (method dropdown + password input) since it's currently a stub.

**Tech Stack:** React/TS, vitest. Frontend-only (backend already supports SS).

**Spec:** `docs/superpowers/specs/2026-05-27-inbound-password-random-design.md`

**Run frontend commands from `/Users/hg/project/Shepherd/web`. Do NOT run `npm run build` (deletes a tracked artifact); use `npx tsc --noEmit` and `npx vitest`. git from repo root; never `git checkout`/`reset`/`stash`.**

---

## Task 1: Shared random helpers in templates.ts (+ DRY the BulkRelayDialogs)

**Files:**
- Modify: `web/src/pages/admin/plugins/xray/templates.ts`
- Modify: `web/src/pages/admin/plugins/singbox/BulkRelayDialog.tsx`
- Modify: `web/src/pages/admin/plugins/xray/BulkRelayDialog.tsx`
- Test: `web/src/pages/admin/plugins/xray/templates.test.ts` (create if absent; else add to existing)

- [ ] **Step 1: Write failing unit test for the helpers**

Create/extend `web/src/pages/admin/plugins/xray/templates.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { randomPassword, randomSSKey } from './templates'

describe('randomPassword', () => {
  it('returns a non-empty url-safe base64 string with no padding', () => {
    const p = randomPassword()
    expect(p.length).toBeGreaterThan(0)
    expect(p).toMatch(/^[A-Za-z0-9_-]+$/) // url-safe, no '=' padding
  })
  it('is random (two calls differ)', () => {
    expect(randomPassword()).not.toBe(randomPassword())
  })
})

describe('randomSSKey', () => {
  const b64len = (s: string) => atob(s).length
  it('aes-128 SS2022 → 16-byte standard-base64 key', () => {
    expect(b64len(randomSSKey('2022-blake3-aes-128-gcm'))).toBe(16)
  })
  it('aes-256 / chacha SS2022 → 32-byte key', () => {
    expect(b64len(randomSSKey('2022-blake3-aes-256-gcm'))).toBe(32)
    expect(b64len(randomSSKey('2022-blake3-chacha20-poly1305'))).toBe(32)
  })
  it('legacy method → non-empty string', () => {
    expect(randomSSKey('aes-256-gcm').length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/plugins/xray/templates.test.ts`
Expected: FAIL — `randomPassword`/`randomSSKey` are not exported.

- [ ] **Step 3: Add the helpers to templates.ts**

Append to `web/src/pages/admin/plugins/xray/templates.ts`:

```ts
// randomPassword returns 24 random bytes as URL-safe base64 (no padding).
// Suitable for arbitrary-string passwords (trojan/hysteria2/tuic/anytls and
// legacy shadowsocks methods).
export function randomPassword(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

// randomSSKey returns a Shadowsocks key appropriate for the given method.
// SS2022 methods (2022-blake3-*) need an exact-length standard-base64 key:
// 16 bytes for aes-128, 32 bytes otherwise. Legacy methods accept any string,
// so they reuse randomPassword().
export function randomSSKey(method: string): string {
  if (!method.startsWith('2022-blake3-')) return randomPassword()
  const n = method.includes('aes-128') ? 16 : 32
  const bytes = new Uint8Array(n)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)) // standard base64, with padding
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/plugins/xray/templates.test.ts`
Expected: PASS.

- [ ] **Step 5: DRY — import randomPassword in both BulkRelayDialogs**

In `web/src/pages/admin/plugins/singbox/BulkRelayDialog.tsx` and
`web/src/pages/admin/plugins/xray/BulkRelayDialog.tsx`: delete the local
`function randomPassword() {…}` (around line 25 in each) and import it from
templates. singbox imports from `'../xray/templates'`; xray from `'./templates'`.
Add `randomPassword` to the existing template import in each file (check whether
one already exists; xray BulkRelayDialog may already import from `./templates`).

- [ ] **Step 6: Verify the bulk-relay tests still pass + typecheck**

Run: `cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/plugins/singbox/BulkRelayDialog.test.tsx src/pages/admin/plugins/xray/BulkRelayDialog.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc clean. (Behaviour is identical — same impl, just relocated.)

- [ ] **Step 7: Commit**

```bash
cd /Users/hg/project/Shepherd
git add web/src/pages/admin/plugins/xray/templates.ts web/src/pages/admin/plugins/xray/templates.test.ts web/src/pages/admin/plugins/singbox/BulkRelayDialog.tsx web/src/pages/admin/plugins/xray/BulkRelayDialog.tsx
git commit -m "feat(web): shared randomPassword + method-aware randomSSKey helpers"
```

---

## Task 2: sing-box InboundDialog — Random buttons on Password + SS

**Files:**
- Modify: `web/src/pages/admin/plugins/singbox/InboundDialog.tsx`
- Test: `web/src/pages/admin/plugins/singbox/InboundDialog.test.tsx`

Reference markup — the existing UUID row (in this file) is:
```tsx
<Input id="ib-uuid" aria-label="uuid" className={inputCls + ' flex-1'}
  value={uuid} onChange={(e) => setUUID(e.target.value)} />
<Button ... onClick={() => setUUID(randomUUID())}>new</Button>
```
Mirror this exact wrapper/Button style (read the UUID block to copy the flex
container + Button variant/size/className).

- [ ] **Step 1: Write failing tests**

Add to `web/src/pages/admin/plugins/singbox/InboundDialog.test.tsx` (mirror the
file's existing render helper + queries):

```tsx
it('fills Password via the new button (trojan)', () => {
  renderDialog({}) // create mode; select a trojan-tls protocol if needed via the file's helper
  // ensure a password protocol is selected; if the default isn't one, set it as sibling tests do
  const before = (screen.getByLabelText(/^password$/i) as HTMLInputElement).value
  fireEvent.click(screen.getByRole('button', { name: /^new$/i, ... })) // the password row's button
  const after = (screen.getByLabelText(/^password$/i) as HTMLInputElement).value
  expect(after).not.toBe(before)
  expect(after.length).toBeGreaterThan(0)
})

it('fills SS key via the new button with method-correct length', () => {
  renderDialog({}) // create mode, select shadowsocks
  // pick 2022-blake3-aes-128-gcm in the method select
  // click the SS password row's new button
  // assert atob(value).length === 16
})
```

> Implementer note: the exact render helper, how to select a protocol/method, and how to disambiguate the two `new` buttons (UUID vs password vs SS) come from reading the existing tests + dialog. Use accessible names / `within(row)` scoping. The essential assertions: clicking the Password `new` button changes the password input to a non-empty value; clicking the SS `new` button (with `2022-blake3-aes-128-gcm` selected) yields a value whose `atob(...).length === 16`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/plugins/singbox/InboundDialog.test.tsx`
Expected: FAIL — no `new` button on the password / SS rows.

- [ ] **Step 3: Add the buttons**

In `web/src/pages/admin/plugins/singbox/InboundDialog.tsx`:
- Import `randomPassword, randomSSKey` from `'../xray/templates'` (extend the
  existing `randomUUID, randomPort` import).
- Password field: wrap the input in the same flex container as the UUID row and
  add a `new` `<Button>` → `setPassword(randomPassword())`.
- SS field ("Password (base64)"): add a `new` `<Button>` →
  `setSSPassword(randomSSKey(ssMethod))`.

Match the UUID row's Button variant/size/classNames so it looks consistent.

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/plugins/singbox/InboundDialog.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add web/src/pages/admin/plugins/singbox/InboundDialog.tsx web/src/pages/admin/plugins/singbox/InboundDialog.test.tsx
git commit -m "feat(web/singbox): Random button on Password + SS-key fields"
```

---

## Task 3: xray InboundDialog — build Shadowsocks form + Random button

**Files:**
- Modify: `web/src/pages/admin/plugins/xray/InboundDialog.tsx`
- Test: `web/src/pages/admin/plugins/xray/InboundDialog.test.tsx`

Current state: `protocol` includes `'shadowsocks'` (option at line ~173) but no
SS fields render and the create body (lines ~65–70) omits `ss_*`. `ss_password`
is NOT in the `XrayInbound` GET response, so edit starts blank (mirror how
`private_key` is handled in this dialog).

- [ ] **Step 1: Write failing tests**

Add to `web/src/pages/admin/plugins/xray/InboundDialog.test.tsx` (mirror the
file's render helper + `vi.spyOn(pluginsAPI, 'createXrayInbound')`):

```tsx
it('shadowsocks: renders method+password and submits ss_* on create', async () => {
  const create = vi.spyOn(pluginsAPI, 'createXrayInbound').mockResolvedValue({} as never)
  renderDialog({ mode: 'create' }) // file's helper
  // select Shadowsocks in the protocol <select>
  fireEvent.change(screen.getByLabelText(/protocol/i), { target: { value: 'shadowsocks' } })
  // method + password fields now present
  expect(screen.getByLabelText(/method/i)).toBeInTheDocument()
  // generate a password
  fireEvent.click(screen.getByRole('button', { name: /^new$/i, ... })) // ss password row's button
  fireEvent.click(screen.getByRole('button', { name: /create/i }))
  await waitFor(() => expect(create).toHaveBeenCalled())
  const body = create.mock.calls[0][0]
  expect(body).toMatchObject({ protocol: 'shadowsocks' })
  expect(typeof body.ss_method).toBe('string')
  expect((body.ss_password as string).length).toBeGreaterThan(0)
})
```

> Implementer note: match the file's actual render helper, protocol-select label,
> and button disambiguation (UUID is hidden for shadowsocks, so the only `new`
> button should be the SS one). Essential assertions: selecting Shadowsocks shows
> Method + Password fields; `new` fills the password; create sends `ss_method` and
> a non-empty `ss_password`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/plugins/xray/InboundDialog.test.tsx`
Expected: FAIL — no method/password fields for shadowsocks.

- [ ] **Step 3: Build the SS form + wiring**

In `web/src/pages/admin/plugins/xray/InboundDialog.tsx`:
- Import `randomPassword, randomSSKey` from `'./templates'` (extend the existing
  `randomPort, randomUUID` import).
- Add a methods constant near the top:
  ```tsx
  const XRAY_SS_METHODS = [
    'aes-256-gcm', 'aes-128-gcm', 'chacha20-poly1305', 'xchacha20-poly1305',
    '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305',
  ]
  ```
- Add state:
  ```tsx
  const [ssMethod, setSSMethod] = useState<string>(editing?.ss_method ?? 'aes-256-gcm')
  const [ssPassword, setSSPassword] = useState<string>('')
  ```
  (`editing` is the file's edit-prop name — confirm it; `ss_password` isn't in
  the GET response, so it always starts `''`.)
- Render an SS block when `protocol === 'shadowsocks'` (place beside the existing
  `protocol === 'vmess-ws'` block, mirroring sibling markup): a Method `<select>`
  over `XRAY_SS_METHODS` (bound to `ssMethod`/`setSSMethod`) and a Password
  `<Input>` (bound to `ssPassword`/`setSSPassword`) with a `new` `<Button>` →
  `setSSPassword(randomSSKey(ssMethod))`. Give the inputs accessible labels
  (`Method`, `Password`) so tests can target them.
- Create body (the `createXrayInbound({...})` call): add, conditional on
  shadowsocks:
  ```tsx
  ss_method: protocol === 'shadowsocks' ? ssMethod : undefined,
  ss_password: protocol === 'shadowsocks' ? ssPassword : undefined,
  ```
- Patch body (the `patchXrayInbound(editing.id, {...})` call):
  ```tsx
  ss_method: ssMethod !== editing.ss_method ? ssMethod : undefined,
  ss_password: ssPassword || undefined,
  ```
  (Mirrors the `private_key: privateKey || undefined` pattern — only send a new
  SS password if one was generated/typed.)

- [ ] **Step 4: Run to verify it passes + typecheck**

Run: `cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/plugins/xray/InboundDialog.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add web/src/pages/admin/plugins/xray/InboundDialog.tsx web/src/pages/admin/plugins/xray/InboundDialog.test.tsx
git commit -m "feat(web/xray): build out Shadowsocks form with Random key button"
```

---

## Task 4: Full frontend verification

- [ ] **Step 1: Typecheck + full test suite**

Run: `cd /Users/hg/project/Shepherd/web && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all suites PASS.

- [ ] **Step 2: Restore embedded artifact if touched + confirm clean tree**

Run: `cd /Users/hg/project/Shepherd && git checkout -- internal/web/dist/.gitkeep 2>/dev/null; git status --short`
Expected: only intended `web/src` + docs changes (already committed) — clean.

---

## Self-Review Notes

- **Spec coverage:** shared helpers (Task 1) ✓; sing-box Password + method-aware SS buttons (Task 2) ✓; xray SS form build-out + button (Task 3) ✓; DRY of duplicated `randomPassword` (Task 1) ✓; tests at each layer ✓; out-of-scope (bulk-relay behaviour, backend) untouched ✓.
- **Type consistency:** `randomPassword()` / `randomSSKey(method)` names stable across templates.ts, both InboundDialogs, and both BulkRelayDialogs. `ssMethod`/`ssPassword`/`setSSMethod`/`setSSPassword` consistent in xray dialog.
- **Edit correctness:** xray `ss_password` not in GET → starts `''`, patch only sends when non-empty (mirrors `private_key`). `ss_method` patched only when changed.
- **No-backend-change:** verified backend renders `ss_method`/`ss_password` as-is and DTOs already carry them.
