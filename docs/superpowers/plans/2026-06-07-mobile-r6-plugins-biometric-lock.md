# Mobile R6 — Plugins UI + Biometric App Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A plugin management UI (list/enable/disable, edit JSON config, per-host deploy lifecycle) over the existing admin plugins API, plus an opt-in biometric app lock (cold-start + background-return >30s).

**Architecture:** New `plugins.ts` API hooks mirror R5's TanStack pattern (queries + plain-async mutations; screens call `q.refetch()` after a mutation — the codebase has no `invalidateQueries` idiom). A `useLock` zustand store + `biometrics.ts` wrapper over `expo-local-authentication` drive a `LockScreen` overlay rendered by the `(app)` shell. All logic + screen renders are unit-tested; the real biometric prompt + AppState transition are device-only.

**Tech Stack:** Expo SDK 56 + expo-router, TanStack Query v5, zustand, `expo-local-authentication` (new), jest-expo + @testing-library/react-native.

**Spec:** `docs/superpowers/specs/2026-06-07-mobile-r6-plugins-biometric-lock-design.md`

**Confirmed integration facts:**
- `(app)/_layout.tsx` currently: `const status = useAuth((s)=>s.status); if (status!=='signedIn') return <Redirect href="/(auth)/login"/>; return <Slot/>`.
- Home header (`(app)/index.tsx`) is a flex-row `View` ending with `<Pressable onPress={logout}><Text style={{color:theme.accent}}>Log out</Text></Pressable>`; screen has `const router = useRouter()`.
- Storage (`src/storage/secure.ts`) uses `AsyncStorage` for non-secret flags (mirror for `shepherd_lock_enabled`).
- `theme` keys: `bg surface border text textDim accent error`, `space:(n)=>n*4`.
- `jest-setup.ts` globally mocks `expo-secure-store` + `@react-native-async-storage/async-storage`; add an `expo-local-authentication` mock there.
- TanStack v5 `refetchInterval` callback receives `(query)` → use `query.state.data`.

**Headless:** verify with `cd mobile && npx tsc --noEmit && npx eslint . && npx jest`. A native dep is added → **lock must stay in sync** (T2 + T14 run `npm ci`).

---

## Task 1: Lock-enabled storage helpers

**Files:** Modify `mobile/src/storage/secure.ts`; Test `mobile/src/storage/__tests__/lockflag.test.ts`.

- [ ] **Step 1: Failing test** `mobile/src/storage/__tests__/lockflag.test.ts`:
```ts
import { saveLockEnabled, loadLockEnabled } from '../secure'

test('lock flag round-trips, defaults false', async () => {
  expect(await loadLockEnabled()).toBe(false)
  await saveLockEnabled(true)
  expect(await loadLockEnabled()).toBe(true)
  await saveLockEnabled(false)
  expect(await loadLockEnabled()).toBe(false)
})
```
Run `npx jest src/storage/__tests__/lockflag` → FAIL.

- [ ] **Step 2: Implement** — append to `mobile/src/storage/secure.ts` (AsyncStorage is already imported):
```ts
const LOCK_ENABLED_KEY = 'shepherd_lock_enabled'

export async function saveLockEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(LOCK_ENABLED_KEY, enabled ? 'true' : 'false')
}
export async function loadLockEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(LOCK_ENABLED_KEY)) === 'true'
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest src/storage/__tests__/lockflag && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add mobile/src/storage/secure.ts mobile/src/storage/__tests__/lockflag.test.ts
git commit -m "feat(mobile): persisted lock-enabled flag in AsyncStorage"
```

---

## Task 2: `expo-local-authentication` dep + biometrics wrapper

**Files:** Modify `mobile/package.json` + `mobile/package-lock.json` (via tooling), `mobile/jest-setup.ts`; Create `mobile/src/lib/biometrics.ts` + test.

- [ ] **Step 1: Add the native dep (SDK-pinned) + sync lock**
```bash
cd /Users/hg/project/Shepherd/mobile && npx expo install expo-local-authentication
npm install --package-lock-only && rm -rf node_modules && npm ci
```
Expected: `expo-local-authentication` added to `dependencies` at an SDK-56-compatible version; `npm ci` exits 0 (lock in sync).

- [ ] **Step 2: Add the global jest mock** — append to `mobile/jest-setup.ts`:
```ts
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: false })),
}))
```

- [ ] **Step 3: Failing test** `mobile/src/lib/__tests__/biometrics.test.ts`:
```ts
import * as LA from 'expo-local-authentication'
import { hasHardware, isEnrolled, authenticate } from '../biometrics'

test('wrappers map to the SDK', async () => {
  expect(await hasHardware()).toBe(true)
  expect(await isEnrolled()).toBe(true)
  ;(LA.authenticateAsync as jest.Mock).mockResolvedValueOnce({ success: true })
  expect(await authenticate()).toBe(true)
  ;(LA.authenticateAsync as jest.Mock).mockResolvedValueOnce({ success: false })
  expect(await authenticate()).toBe(false)
})
```
Run `npx jest src/lib/__tests__/biometrics` → FAIL.

- [ ] **Step 4: Implement** `mobile/src/lib/biometrics.ts`:
```ts
import * as LocalAuthentication from 'expo-local-authentication'

export async function hasHardware(): Promise<boolean> {
  return LocalAuthentication.hasHardwareAsync()
}
export async function isEnrolled(): Promise<boolean> {
  return LocalAuthentication.isEnrolledAsync()
}
export async function authenticate(): Promise<boolean> {
  const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Shepherd' })
  return r.success
}
```

- [ ] **Step 5: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest src/lib/__tests__/biometrics && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add mobile/package.json mobile/package-lock.json mobile/jest-setup.ts mobile/src/lib/biometrics.ts mobile/src/lib/__tests__/biometrics.test.ts
git commit -m "feat(mobile): expo-local-authentication + biometrics wrapper"
```

---

## Task 3: Lock store

**Files:** Create `mobile/src/store/lock.ts` + test.

- [ ] **Step 1: Failing test** `mobile/src/store/__tests__/lock.test.ts`:
```ts
import { useLock } from '../lock'

beforeEach(() => { useLock.setState({ enabled: false, locked: false, lastBackground: null }) })

test('setEnabled persists and locks; unlock clears', async () => {
  await useLock.getState().setEnabled(true)
  expect(useLock.getState().enabled).toBe(true)
  expect(useLock.getState().locked).toBe(true)
  useLock.getState().unlock()
  expect(useLock.getState().locked).toBe(false)
  await useLock.getState().setEnabled(false)
  expect(useLock.getState().enabled).toBe(false)
  expect(useLock.getState().locked).toBe(false)
})

test('hydrate loads persisted flag', async () => {
  await useLock.getState().setEnabled(true)
  useLock.setState({ enabled: false, locked: false })
  await useLock.getState().hydrate()
  expect(useLock.getState().enabled).toBe(true)
  expect(useLock.getState().locked).toBe(true)
})

test('maybeLockOnForeground locks only after >30s background', () => {
  useLock.setState({ enabled: true, locked: false, lastBackground: 1_000 })
  useLock.getState().maybeLockOnForeground(1_000 + 30_000) // exactly 30s → no
  expect(useLock.getState().locked).toBe(false)
  useLock.getState().maybeLockOnForeground(1_000 + 30_001) // >30s → yes
  expect(useLock.getState().locked).toBe(true)
})

test('maybeLockOnForeground is a no-op when disabled', () => {
  useLock.setState({ enabled: false, locked: false, lastBackground: 0 })
  useLock.getState().maybeLockOnForeground(999_999)
  expect(useLock.getState().locked).toBe(false)
})
```
Run `npx jest src/store/__tests__/lock` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/store/lock.ts`:
```ts
import { create } from 'zustand'
import { saveLockEnabled, loadLockEnabled } from '../storage/secure'

const LOCK_AFTER_MS = 30_000

type LockState = {
  enabled: boolean
  locked: boolean
  lastBackground: number | null
  hydrate: () => Promise<void>
  setEnabled: (on: boolean) => Promise<void>
  lock: () => void
  unlock: () => void
  noteBackground: (now: number) => void
  maybeLockOnForeground: (now: number) => void
}

export const useLock = create<LockState>((set, get) => ({
  enabled: false,
  locked: false,
  lastBackground: null,
  hydrate: async () => {
    const enabled = await loadLockEnabled()
    set({ enabled, locked: enabled })
  },
  setEnabled: async (on) => {
    await saveLockEnabled(on)
    set({ enabled: on, locked: on })
  },
  lock: () => set({ locked: true }),
  unlock: () => set({ locked: false }),
  noteBackground: (now) => set({ lastBackground: now }),
  maybeLockOnForeground: (now) => {
    const { enabled, lastBackground } = get()
    if (enabled && lastBackground != null && now - lastBackground > LOCK_AFTER_MS) set({ locked: true })
  },
}))
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest src/store/__tests__/lock && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add mobile/src/store/lock.ts mobile/src/store/__tests__/lock.test.ts
git commit -m "feat(mobile): lock store (cold-start + >30s background-return)"
```

---

## Task 4: Plugins API — global layer

**Files:** Create `mobile/src/api/plugins.ts` + test `mobile/src/api/__tests__/plugins.test.tsx`.

- [ ] **Step 1: Failing test** `mobile/src/api/__tests__/plugins.test.tsx`:
```tsx
import React from 'react'
import { renderHook, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { usePlugins, enablePlugin, disablePlugin, savePluginConfig } from '../plugins'
jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

test('usePlugins resolves', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([{ id: 'xray', meta: { name: 'Xray', description: '', icon: '', category: 'net', host_aware: true }, enabled: true }])
  const { result } = renderHook(() => usePlugins(), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data?.[0].id).toBe('xray')
})
test('enable/disable hit the right paths', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ enabled: true })
  await enablePlugin('xray')
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/enable', { method: 'POST' })
  await disablePlugin('xray')
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/disable', { method: 'POST' })
})
test('savePluginConfig PUTs the object', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ok: true })
  await savePluginConfig('xray', { port: 443 })
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/config', { method: 'PUT', body: { port: 443 } })
})
```
Run `npx jest src/api/__tests__/plugins` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/api/plugins.ts`:
```ts
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { authedFetch } from './authed'

export type PluginMeta = { name: string; description: string; icon: string; category: string; host_aware: boolean }
export type Plugin = { id: string; meta: PluginMeta; enabled: boolean; enabled_at?: string | null; host_count?: number | null }
export type HostDeployment = { id: number; plugin_id: string; server_id: number; deployed_version?: string | null; status: string; last_error?: string | null; updated_at: string; config?: unknown }

export function usePlugins(): UseQueryResult<Plugin[]> {
  return useQuery({ queryKey: ['plugins'], queryFn: () => authedFetch<Plugin[]>('/api/admin/plugins') })
}
export function enablePlugin(id: string): Promise<{ enabled: boolean }> {
  return authedFetch<{ enabled: boolean }>(`/api/admin/plugins/${id}/enable`, { method: 'POST' })
}
export function disablePlugin(id: string): Promise<{ enabled: boolean }> {
  return authedFetch<{ enabled: boolean }>(`/api/admin/plugins/${id}/disable`, { method: 'POST' })
}
export function usePluginConfig(id: string): UseQueryResult<Record<string, unknown>> {
  return useQuery({ queryKey: ['plugin-config', id], queryFn: () => authedFetch<Record<string, unknown>>(`/api/admin/plugins/${id}/config`) })
}
export function savePluginConfig(id: string, cfg: Record<string, unknown>): Promise<{ ok: boolean }> {
  return authedFetch<{ ok: boolean }>(`/api/admin/plugins/${id}/config`, { method: 'PUT', body: cfg })
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest src/api/__tests__/plugins && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add mobile/src/api/plugins.ts mobile/src/api/__tests__/plugins.test.tsx
git commit -m "feat(mobile): plugins API — list/enable/disable/config"
```

---

## Task 5: Plugins API — host deployment layer

**Files:** Modify `mobile/src/api/plugins.ts`; Test `mobile/src/api/__tests__/plugin-hosts.test.tsx`.

- [ ] **Step 1: Failing test** `mobile/src/api/__tests__/plugin-hosts.test.tsx`:
```tsx
import { deployHost, undeployHost, startHost, stopHost, restartHost, refreshHost } from '../plugins'
jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

beforeEach(() => (authedFetch as jest.Mock).mockResolvedValue({}))

test('host actions hit the right method + path', async () => {
  await deployHost('xray', { server_id: 7, version: 'v1' })
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/hosts', { method: 'POST', body: { server_id: 7, version: 'v1' } })
  await undeployHost('xray', 7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/hosts/7', { method: 'DELETE' })
  await startHost('xray', 7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/hosts/7/start', { method: 'POST' })
  await stopHost('xray', 7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/hosts/7/stop', { method: 'POST' })
  await restartHost('xray', 7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/hosts/7/restart', { method: 'POST' })
  await refreshHost('xray', 7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/hosts/7/refresh-status')
})
```
Run `npx jest src/api/__tests__/plugin-hosts` → FAIL.

- [ ] **Step 2: Implement** — append to `mobile/src/api/plugins.ts`:
```ts
const DEPLOYING = new Set(['pending', 'deploying'])

export function usePluginHosts(id: string): UseQueryResult<HostDeployment[]> {
  return useQuery({
    queryKey: ['plugin-hosts', id],
    queryFn: () => authedFetch<HostDeployment[]>(`/api/admin/plugins/${id}/hosts`),
    refetchInterval: (query) => {
      const rows = query.state.data as HostDeployment[] | undefined
      const anyDeploying = !!rows && rows.some((h) => DEPLOYING.has(h.status))
      return anyDeploying ? 2000 : false
    },
  })
}
export function deployHost(id: string, body: { server_id: number; version?: string; config?: Record<string, unknown> }): Promise<HostDeployment> {
  return authedFetch<HostDeployment>(`/api/admin/plugins/${id}/hosts`, { method: 'POST', body })
}
export function undeployHost(id: string, serverId: number): Promise<{ ok: boolean }> {
  return authedFetch<{ ok: boolean }>(`/api/admin/plugins/${id}/hosts/${serverId}`, { method: 'DELETE' })
}
export function startHost(id: string, serverId: number): Promise<{ status: string }> {
  return authedFetch<{ status: string }>(`/api/admin/plugins/${id}/hosts/${serverId}/start`, { method: 'POST' })
}
export function stopHost(id: string, serverId: number): Promise<{ status: string }> {
  return authedFetch<{ status: string }>(`/api/admin/plugins/${id}/hosts/${serverId}/stop`, { method: 'POST' })
}
export function restartHost(id: string, serverId: number): Promise<{ status: string }> {
  return authedFetch<{ status: string }>(`/api/admin/plugins/${id}/hosts/${serverId}/restart`, { method: 'POST' })
}
export function refreshHost(id: string, serverId: number): Promise<HostDeployment> {
  return authedFetch<HostDeployment>(`/api/admin/plugins/${id}/hosts/${serverId}/refresh-status`)
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest src/api/__tests__/plugin-hosts && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add mobile/src/api/plugins.ts mobile/src/api/__tests__/plugin-hosts.test.tsx
git commit -m "feat(mobile): plugins API — host deploy/lifecycle (poll while deploying)"
```

---

## Task 6: Plugins list screen

**Files:** Create `mobile/src/app/(app)/plugins/index.tsx` + test.

- [ ] **Step 1: Failing test** `mobile/src/app/(app)/plugins/__tests__/list.test.tsx`:
```tsx
import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import PluginsList from '../index'
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }))
const enableMock = jest.fn().mockResolvedValue({ enabled: true })
const refetch = jest.fn()
jest.mock('@/api/plugins', () => ({
  usePlugins: () => ({ data: [{ id: 'xray', meta: { name: 'Xray', description: 'proxy', icon: '🛰', category: 'net', host_aware: true }, enabled: false }], isLoading: false, isError: false, refetch }),
  enablePlugin: (...a: unknown[]) => enableMock(...a),
  disablePlugin: jest.fn(),
}))

beforeEach(() => { enableMock.mockClear(); refetch.mockClear() })

test('renders a plugin and toggling enables it', async () => {
  const { getByText, getByTestId } = render(<PluginsList />)
  expect(getByText('Xray')).toBeTruthy()
  fireEvent(getByTestId('toggle-xray'), 'valueChange', true)
  await waitFor(() => expect(enableMock).toHaveBeenCalledWith('xray'))
})
```
Run `npx jest "src/app/(app)/plugins/__tests__/list"` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/app/(app)/plugins/index.tsx`:
```tsx
import { useState } from 'react'
import { FlatList, View, Text, Pressable, Switch, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'
import { usePlugins, enablePlugin, disablePlugin, type Plugin } from '@/api/plugins'
import { theme } from '@/theme'

function PluginRow({ p, onToggle, onOpen }: { p: Plugin; onToggle: (on: boolean) => Promise<void>; onOpen: () => void }) {
  const [busy, setBusy] = useState(false)
  const toggle = async (on: boolean) => { setBusy(true); try { await onToggle(on) } finally { setBusy(false) } }
  return (
    <Pressable onPress={onOpen} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space(3), padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
      <Text style={{ fontSize: 20 }}>{p.meta.icon || '🔌'}</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.text, fontWeight: '600' }}>{p.meta.name}</Text>
        <Text style={{ color: theme.textDim, fontSize: 12 }}>{p.meta.category}</Text>
      </View>
      <Switch testID={`toggle-${p.id}`} value={p.enabled} disabled={busy} onValueChange={toggle} />
    </Pressable>
  )
}

export default function PluginsList() {
  const router = useRouter()
  const q = usePlugins()
  const onToggle = async (p: Plugin, on: boolean) => {
    if (on) await enablePlugin(p.id)
    else await disablePlugin(p.id)
    await q.refetch()
  }
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
        <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600' }}>Plugins</Text>
      </View>
      {q.isLoading ? <ActivityIndicator color={theme.accent} style={{ marginTop: theme.space(8) }} />
        : q.isError ? <Text style={{ color: theme.error, padding: theme.space(4) }}>failed to load plugins</Text>
        : <FlatList
            data={q.data ?? []}
            keyExtractor={(p) => p.id}
            renderItem={({ item }) => <PluginRow p={item} onToggle={(on) => onToggle(item, on)} onOpen={() => router.push(`/(app)/plugins/${item.id}`)} />}
            ListEmptyComponent={<Text style={{ color: theme.textDim, padding: theme.space(4) }}>No plugins.</Text>}
          />}
    </View>
  )
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest "src/app/(app)/plugins/__tests__/list" && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/plugins/index.tsx" "mobile/src/app/(app)/plugins/__tests__/list.test.tsx"
git commit -m "feat(mobile): plugins list screen (enable/disable switch)"
```

---

## Task 7: Plugin detail screen

**Files:** Create `mobile/src/app/(app)/plugins/[id]/index.tsx` + test.

- [ ] **Step 1: Failing test** `mobile/src/app/(app)/plugins/[id]/__tests__/detail.test.tsx`:
```tsx
import React from 'react'
import { render } from '@testing-library/react-native'
import PluginDetail from '../index'
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'xray' }), useRouter: () => ({ push: jest.fn() }) }))
jest.mock('@/api/plugins', () => ({
  usePlugins: () => ({ data: [{ id: 'xray', meta: { name: 'Xray', description: 'proxy', icon: '🛰', category: 'net', host_aware: true }, enabled: true, host_count: 3 }] }),
  enablePlugin: jest.fn(), disablePlugin: jest.fn(),
}))

test('renders meta and a Hosts row for host-aware plugins', () => {
  const { getByText } = render(<PluginDetail />)
  expect(getByText('Xray')).toBeTruthy()
  expect(getByText(/Hosts/)).toBeTruthy()
})
```
Run `npx jest "src/app/(app)/plugins/[id]/__tests__/detail"` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/app/(app)/plugins/[id]/index.tsx`:
```tsx
import { useState } from 'react'
import { View, Text, Pressable, Switch, ScrollView } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { usePlugins, enablePlugin, disablePlugin } from '@/api/plugins'
import { theme } from '@/theme'

export default function PluginDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const q = usePlugins()
  const p = q.data?.find((x) => x.id === id)
  const [busy, setBusy] = useState(false)

  if (!p) return <View style={{ flex: 1, backgroundColor: theme.bg, padding: theme.space(4) }}><Text style={{ color: theme.textDim }}>Plugin not found.</Text></View>

  const toggle = async (on: boolean) => {
    setBusy(true)
    try { if (on) await enablePlugin(p.id); else await disablePlugin(p.id); await q.refetch() } finally { setBusy(false) }
  }
  const rowStyle = { padding: theme.space(3), borderTopWidth: 1, borderColor: theme.border }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: theme.space(4) }}>
        <Text style={{ color: theme.text, fontSize: 22, fontWeight: '700' }}>{p.meta.icon} {p.meta.name}</Text>
        {p.meta.description ? <Text style={{ color: theme.textDim, marginTop: theme.space(2) }}>{p.meta.description}</Text> : null}
        <Text style={{ color: theme.textDim, fontSize: 12, marginTop: theme.space(2) }}>{p.meta.category}</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', ...rowStyle }}>
        <Text style={{ color: theme.text, flex: 1 }}>Enabled</Text>
        <Switch testID="detail-toggle" value={p.enabled} disabled={busy} onValueChange={toggle} />
      </View>
      <Pressable onPress={() => router.push(`/(app)/plugins/${p.id}/config`)} style={rowStyle}>
        <Text style={{ color: theme.accent }}>Edit config</Text>
      </Pressable>
      {p.meta.host_aware ? (
        <Pressable onPress={() => router.push(`/(app)/plugins/${p.id}/hosts`)} style={rowStyle}>
          <Text style={{ color: theme.accent }}>Hosts{p.host_count != null ? ` (${p.host_count})` : ''}</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  )
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest "src/app/(app)/plugins/[id]/__tests__/detail" && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/plugins/[id]/index.tsx" "mobile/src/app/(app)/plugins/[id]/__tests__/detail.test.tsx"
git commit -m "feat(mobile): plugin detail screen (toggle + config/hosts links)"
```

---

## Task 8: Plugin config editor

**Files:** Create `mobile/src/app/(app)/plugins/[id]/config.tsx` + test.

**Note:** the editor is a CHILD component that mounts only after `usePluginConfig` resolves, so its `useState` initializer seeds from the loaded config (avoids the R5 `react-hooks/set-state-in-effect` trap — do NOT seed via `useEffect`).

- [ ] **Step 1: Failing test** `mobile/src/app/(app)/plugins/[id]/__tests__/config.test.tsx`:
```tsx
import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import PluginConfig from '../config'
const mockBack = jest.fn()
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'xray' }), useRouter: () => ({ back: mockBack }) }))
const saveMock = jest.fn().mockResolvedValue({ ok: true })
jest.mock('@/api/plugins', () => ({
  usePluginConfig: () => ({ data: { port: 443 }, isLoading: false, isError: false }),
  savePluginConfig: (...a: unknown[]) => saveMock(...a),
}))

beforeEach(() => { saveMock.mockClear(); mockBack.mockClear() })

test('invalid JSON blocks save; valid JSON saves the parsed object', async () => {
  const { getByText, getByTestId } = render(<PluginConfig />)
  fireEvent.changeText(getByTestId('config-input'), '{ not json')
  fireEvent.press(getByText('Save'))
  expect(saveMock).not.toHaveBeenCalled()
  expect(getByText(/Invalid JSON/)).toBeTruthy()
  fireEvent.changeText(getByTestId('config-input'), '{"port":8443}')
  fireEvent.press(getByText('Save'))
  await waitFor(() => expect(saveMock).toHaveBeenCalledWith('xray', { port: 8443 }))
})
```
Run `npx jest "src/app/(app)/plugins/[id]/__tests__/config"` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/app/(app)/plugins/[id]/config.tsx`:
```tsx
import { useState } from 'react'
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { usePluginConfig, savePluginConfig } from '@/api/plugins'
import { theme } from '@/theme'

function Editor({ id, initial }: { id: string; initial: Record<string, unknown> }) {
  const router = useRouter()
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(text) } catch { setError('Invalid JSON'); return }
    setBusy(true); setError(null)
    try { await savePluginConfig(id, parsed); router.back() }
    catch (e) { setError(e instanceof Error ? e.message : 'save failed') }
    finally { setBusy(false) }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: theme.space(4) }}>
      <Text style={{ color: theme.textDim, fontSize: 12, marginBottom: theme.space(2) }}>Secrets show as &quot;***&quot; — leave them to keep the stored value.</Text>
      <TextInput testID="config-input" multiline value={text} onChangeText={setText} autoCapitalize="none" autoCorrect={false}
        style={{ backgroundColor: theme.surface, color: theme.text, fontFamily: 'monospace', fontSize: 12, borderColor: theme.border, borderWidth: 1, borderRadius: 8, padding: theme.space(3), minHeight: 240, textAlignVertical: 'top' }} />
      {error ? <Text style={{ color: theme.error, marginTop: theme.space(2) }}>{error}</Text> : null}
      <Pressable onPress={save} disabled={busy} style={{ backgroundColor: theme.accent, padding: theme.space(3), borderRadius: 8, alignItems: 'center', marginTop: theme.space(3), opacity: busy ? 0.6 : 1 }}>
        <Text style={{ color: theme.bg, fontWeight: '600' }}>Save</Text>
      </Pressable>
    </ScrollView>
  )
}

export default function PluginConfig() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const q = usePluginConfig(id)
  if (q.isLoading) return <View style={{ flex: 1, backgroundColor: theme.bg, justifyContent: 'center' }}><ActivityIndicator color={theme.accent} /></View>
  if (q.isError) return <View style={{ flex: 1, backgroundColor: theme.bg, padding: theme.space(4) }}><Text style={{ color: theme.error }}>failed to load config</Text></View>
  return <Editor id={id} initial={q.data ?? {}} />
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest "src/app/(app)/plugins/[id]/__tests__/config" && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/plugins/[id]/config.tsx" "mobile/src/app/(app)/plugins/[id]/__tests__/config.test.tsx"
git commit -m "feat(mobile): plugin JSON config editor (validate + save)"
```

---

## Task 9: Plugin hosts screen

**Files:** Create `mobile/src/app/(app)/plugins/[id]/hosts.tsx` + test.

- [ ] **Step 1: Failing test** `mobile/src/app/(app)/plugins/[id]/__tests__/hosts.test.tsx`:
```tsx
import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import PluginHosts from '../hosts'
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'xray' }) }))
const restartMock = jest.fn().mockResolvedValue({ status: 'running' })
const refetch = jest.fn()
jest.mock('@/api/plugins', () => ({
  usePluginHosts: () => ({ data: [{ id: 1, plugin_id: 'xray', server_id: 7, status: 'failed', last_error: 'boom', updated_at: '' }], isLoading: false, isError: false, refetch }),
  deployHost: jest.fn(), undeployHost: jest.fn(), startHost: jest.fn(), stopHost: jest.fn(),
  restartHost: (...a: unknown[]) => restartMock(...a), refreshHost: jest.fn(),
}))

beforeEach(() => { restartMock.mockClear(); refetch.mockClear() })

test('renders a host with its error and restart calls the API', async () => {
  const { getByText, getByTestId } = render(<PluginHosts />)
  expect(getByText(/server #7/)).toBeTruthy()
  expect(getByText(/boom/)).toBeTruthy()
  fireEvent.press(getByTestId('restart-7'))
  await waitFor(() => expect(restartMock).toHaveBeenCalledWith('xray', 7))
})
```
Run `npx jest "src/app/(app)/plugins/[id]/__tests__/hosts"` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/app/(app)/plugins/[id]/hosts.tsx`:
```tsx
import { useState } from 'react'
import { FlatList, View, Text, TextInput, Pressable, ActivityIndicator } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { usePluginHosts, deployHost, undeployHost, startHost, stopHost, restartHost, refreshHost, type HostDeployment } from '@/api/plugins'
import { theme } from '@/theme'

function Btn({ testID, label, onPress }: { testID: string; label: string; onPress: () => void }) {
  return (
    <Pressable testID={testID} onPress={onPress} style={{ paddingVertical: theme.space(1), paddingHorizontal: theme.space(2), borderWidth: 1, borderColor: theme.border, borderRadius: 6 }}>
      <Text style={{ color: theme.accent, fontSize: 12 }}>{label}</Text>
    </Pressable>
  )
}

export default function PluginHosts() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const q = usePluginHosts(id)
  const [serverId, setServerId] = useState('')
  const run = async (fn: () => Promise<unknown>) => { await fn(); await q.refetch() }

  const renderRow = (h: HostDeployment) => {
    const bad = h.status === 'failed' || h.status === 'error'
    return (
      <View style={{ padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
        <Text style={{ color: theme.text }}>server #{h.server_id}{h.deployed_version ? ` · ${h.deployed_version}` : ''}</Text>
        <Text style={{ color: bad ? theme.error : theme.textDim, fontFamily: 'monospace', fontSize: 12 }}>{h.status}{h.last_error ? ` — ${h.last_error}` : ''}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(2), marginTop: theme.space(2) }}>
          <Btn testID={`start-${h.server_id}`} label="Start" onPress={() => run(() => startHost(id, h.server_id))} />
          <Btn testID={`stop-${h.server_id}`} label="Stop" onPress={() => run(() => stopHost(id, h.server_id))} />
          <Btn testID={`restart-${h.server_id}`} label="Restart" onPress={() => run(() => restartHost(id, h.server_id))} />
          <Btn testID={`refresh-${h.server_id}`} label="Refresh" onPress={() => run(() => refreshHost(id, h.server_id))} />
          <Btn testID={`undeploy-${h.server_id}`} label="Undeploy" onPress={() => run(() => undeployHost(id, h.server_id))} />
        </View>
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space(2), padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
        <TextInput value={serverId} onChangeText={setServerId} keyboardType="number-pad" placeholder="server id" placeholderTextColor={theme.textDim}
          style={{ flex: 1, backgroundColor: theme.surface, color: theme.text, borderColor: theme.border, borderWidth: 1, borderRadius: 8, padding: theme.space(2) }} />
        <Pressable onPress={() => { if (serverId.trim()) run(() => deployHost(id, { server_id: Number(serverId) })) }} style={{ backgroundColor: theme.accent, paddingVertical: theme.space(2), paddingHorizontal: theme.space(3), borderRadius: 8 }}>
          <Text style={{ color: theme.bg, fontWeight: '600' }}>Deploy</Text>
        </Pressable>
      </View>
      {q.isLoading ? <ActivityIndicator color={theme.accent} style={{ marginTop: theme.space(8) }} />
        : q.isError ? <Text style={{ color: theme.error, padding: theme.space(4) }}>failed to load hosts</Text>
        : <FlatList data={q.data ?? []} keyExtractor={(h) => String(h.id)} renderItem={({ item }) => renderRow(item)}
            ListEmptyComponent={<Text style={{ color: theme.textDim, padding: theme.space(4) }}>Not deployed anywhere.</Text>} />}
    </View>
  )
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest "src/app/(app)/plugins/[id]/__tests__/hosts" && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/plugins/[id]/hosts.tsx" "mobile/src/app/(app)/plugins/[id]/__tests__/hosts.test.tsx"
git commit -m "feat(mobile): plugin hosts screen (deploy + lifecycle actions)"
```

---

## Task 10: LockScreen component

**Files:** Create `mobile/src/components/LockScreen.tsx` + test.

- [ ] **Step 1: Failing test** `mobile/src/components/__tests__/LockScreen.test.tsx`:
```tsx
import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import { LockScreen } from '../LockScreen'
const unlock = jest.fn()
const logout = jest.fn()
jest.mock('@/store/lock', () => ({ useLock: (sel: (s: { unlock: () => void }) => unknown) => sel({ unlock }) }))
jest.mock('@/store/auth', () => ({ useAuth: (sel: (s: { logout: () => void }) => unknown) => sel({ logout }) }))
const authMock = jest.fn()
jest.mock('@/lib/biometrics', () => ({ authenticate: () => authMock() }))

beforeEach(() => { unlock.mockClear(); logout.mockClear() })

test('successful auth on mount unlocks', async () => {
  authMock.mockResolvedValueOnce(true)
  render(<LockScreen />)
  await waitFor(() => expect(unlock).toHaveBeenCalled())
})
test('failed auth shows Sign out, which logs out', async () => {
  authMock.mockResolvedValue(false)
  const { getByText } = render(<LockScreen />)
  await waitFor(() => expect(getByText('Sign out')).toBeTruthy())
  fireEvent.press(getByText('Sign out'))
  expect(logout).toHaveBeenCalled()
})
```
Run `npx jest src/components/__tests__/LockScreen` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/components/LockScreen.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { authenticate } from '@/lib/biometrics'
import { useLock } from '@/store/lock'
import { useAuth } from '@/store/auth'
import { theme } from '@/theme'

export function LockScreen() {
  const unlock = useLock((s) => s.unlock)
  const logout = useAuth((s) => s.logout)
  const [failed, setFailed] = useState(false)

  const tryAuth = () => { authenticate().then((ok) => (ok ? unlock() : setFailed(true))).catch(() => setFailed(true)) }
  useEffect(() => {
    let live = true
    authenticate().then((ok) => { if (live) { if (ok) unlock(); else setFailed(true) } }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [unlock])

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center', gap: theme.space(5) }}>
      <Text style={{ color: theme.text, fontSize: 20, fontWeight: '700' }}>🔒 Shepherd locked</Text>
      <Pressable onPress={tryAuth} style={{ backgroundColor: theme.accent, paddingVertical: theme.space(3), paddingHorizontal: theme.space(8), borderRadius: 8 }}>
        <Text style={{ color: theme.bg, fontWeight: '600' }}>Unlock</Text>
      </Pressable>
      {failed ? <Pressable onPress={logout}><Text style={{ color: theme.textDim }}>Sign out</Text></Pressable> : null}
    </View>
  )
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest src/components/__tests__/LockScreen && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add mobile/src/components/LockScreen.tsx mobile/src/components/__tests__/LockScreen.test.tsx
git commit -m "feat(mobile): LockScreen (auto-auth on mount, sign-out fallback)"
```

---

## Task 11: Lock gate in the `(app)` shell

**Files:** Modify `mobile/src/app/(app)/_layout.tsx`; Test `mobile/src/app/(app)/__tests__/layout-lock.test.tsx`.

- [ ] **Step 1: Failing test** `mobile/src/app/(app)/__tests__/layout-lock.test.tsx`:
```tsx
import React from 'react'
import { render } from '@testing-library/react-native'
import AppLayout from '../_layout'
jest.mock('expo-router', () => ({ Slot: () => null, Redirect: () => null }))
jest.mock('@/components/LockScreen', () => ({ LockScreen: () => { const { Text } = require('react-native'); return <Text>LOCKED</Text> } }))
jest.mock('@/store/auth', () => ({ useAuth: (sel: (s: { status: string }) => unknown) => sel({ status: 'signedIn' }) }))
const lockState = { enabled: true, locked: true, hydrate: jest.fn(), noteBackground: jest.fn(), maybeLockOnForeground: jest.fn() }
jest.mock('@/store/lock', () => ({ useLock: () => lockState }))

test('renders LockScreen overlay when enabled+locked and signed in', () => {
  const { getByText } = render(<AppLayout />)
  expect(getByText('LOCKED')).toBeTruthy()
})
```
Run `npx jest "src/app/(app)/__tests__/layout-lock"` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/app/(app)/_layout.tsx` (replace the file):
```tsx
import { useEffect, useRef } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { Redirect, Slot } from 'expo-router'
import { useAuth } from '@/store/auth'
import { useLock } from '@/store/lock'
import { LockScreen } from '@/components/LockScreen'

export default function AppLayout() {
  const status = useAuth((s) => s.status)
  const { enabled, locked, hydrate, noteBackground, maybeLockOnForeground } = useLock()
  const appState = useRef<AppStateStatus>(AppState.currentState)

  useEffect(() => { hydrate() }, [hydrate])
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const prev = appState.current
      appState.current = next
      if (next === 'active' && /inactive|background/.test(prev)) maybeLockOnForeground(Date.now())
      else if (/inactive|background/.test(next)) noteBackground(Date.now())
    })
    return () => sub.remove()
  }, [noteBackground, maybeLockOnForeground])

  if (status !== 'signedIn') return <Redirect href="/(auth)/login" />
  return (
    <>
      <Slot />
      {enabled && locked ? <LockScreen /> : null}
    </>
  )
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest "src/app/(app)/__tests__/layout-lock" && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/_layout.tsx" "mobile/src/app/(app)/__tests__/layout-lock.test.tsx"
git commit -m "feat(mobile): lock gate in (app) shell (AppState + overlay)"
```

---

## Task 12: Settings screen

**Files:** Create `mobile/src/app/(app)/settings.tsx` + test.

- [ ] **Step 1: Failing test** `mobile/src/app/(app)/__tests__/settings.test.tsx`:
```tsx
import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import Settings from '../settings'
const setEnabled = jest.fn().mockResolvedValue(undefined)
jest.mock('@/store/lock', () => ({ useLock: () => ({ enabled: false, setEnabled }) }))
jest.mock('@/store/auth', () => ({ useAuth: (sel: (s: { logout: () => void }) => unknown) => sel({ logout: jest.fn() }) }))
jest.mock('@/lib/biometrics', () => ({ hasHardware: jest.fn(async () => true), isEnrolled: jest.fn(async () => true) }))

beforeEach(() => setEnabled.mockClear())

test('toggling the lock enables it once hardware is supported', async () => {
  const { getByTestId } = render(<Settings />)
  await waitFor(() => expect(getByTestId('lock-toggle').props.disabled).toBe(false))
  fireEvent(getByTestId('lock-toggle'), 'valueChange', true)
  await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(true))
})
```
Run `npx jest "src/app/(app)/__tests__/settings"` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/app/(app)/settings.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { View, Text, Switch, Pressable } from 'react-native'
import { useLock } from '@/store/lock'
import { useAuth } from '@/store/auth'
import { hasHardware, isEnrolled } from '@/lib/biometrics'
import { theme } from '@/theme'

export default function Settings() {
  const { enabled, setEnabled } = useLock()
  const logout = useAuth((s) => s.logout)
  const [supported, setSupported] = useState(false)

  useEffect(() => {
    let live = true
    Promise.all([hasHardware(), isEnrolled()]).then(([hw, en]) => { if (live) setSupported(hw && en) }).catch(() => {})
    return () => { live = false }
  }, [])

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
        <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600' }}>Settings</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: theme.space(4), borderBottomWidth: 1, borderColor: theme.border }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.text }}>Require biometric unlock</Text>
          {!supported ? <Text style={{ color: theme.textDim, fontSize: 12, marginTop: theme.space(1) }}>No biometric hardware enrolled.</Text> : null}
        </View>
        <Switch testID="lock-toggle" value={enabled} disabled={!supported} onValueChange={(on) => setEnabled(on)} />
      </View>
      <Pressable onPress={logout} style={{ padding: theme.space(4) }}>
        <Text style={{ color: theme.error }}>Sign out</Text>
      </Pressable>
    </View>
  )
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest "src/app/(app)/__tests__/settings" && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/settings.tsx" "mobile/src/app/(app)/__tests__/settings.test.tsx"
git commit -m "feat(mobile): settings screen (biometric lock toggle + sign out)"
```

---

## Task 13: Home header entries (Plugins + Settings)

**Files:** Modify `mobile/src/app/(app)/index.tsx`.

- [ ] **Step 1: Add two buttons** in the header row, immediately before the existing `<Pressable onPress={logout}>…Log out…</Pressable>`:
```tsx
        <Pressable onPress={() => router.push('/(app)/plugins')} style={{ marginRight: theme.space(3) }}><Text style={{ color: theme.accent }}>Plugins</Text></Pressable>
        <Pressable onPress={() => router.push('/(app)/settings')} style={{ marginRight: theme.space(3) }}><Text style={{ color: theme.accent }}>Settings</Text></Pressable>
```
(`router`, `Pressable`, `Text`, `theme` are already in scope; the screen already imports them. The typed routes `/(app)/plugins` and `/(app)/settings` now resolve — their route files exist.)

- [ ] **Step 2: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx tsc --noEmit && npx jest "src/app/(app)/__tests__" && npx eslint .
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/index.tsx"
git commit -m "feat(mobile): Plugins + Settings entries on home header"
```
Expected: tsc clean (typed routes resolve); existing home/layout/settings tests pass; eslint no errors. (If the home screen has no test, the `(app)/__tests__` run still covers layout + settings; report which suites ran.)

---

## Task 14: Full verification

- [ ] **Step 1: Mobile gates (clean install — CI parity)**
Run: `cd /Users/hg/project/Shepherd/mobile && rm -rf node_modules && npm ci && npx tsc --noEmit && npx eslint . && npx jest --ci`
Expected: `npm ci` exit 0 (lock in sync with the new `expo-local-authentication` dep); tsc clean; eslint no errors; all suites pass.

- [ ] **Step 2: Backend/web untouched + hygiene**
Run: `cd /Users/hg/project/Shepherd && go build ./... && (git status --porcelain | grep -i node_modules && echo LEAK || echo clean)`
Expected: build OK; "clean".

---

## Self-Review
- **Spec coverage:** lock storage → T1; biometrics wrapper + dep → T2; lock store → T3; plugins API global → T4; plugins API hosts → T5; plugins list → T6; plugin detail → T7; config editor → T8; hosts screen → T9; LockScreen → T10; lock gate → T11; settings → T12; home entries → T13; gates → T14. All spec components mapped.
- **Type consistency:** `Plugin`/`PluginMeta`/`HostDeployment` (T4/T5) consumed by all plugin screens (T6–T9); `usePlugins().refetch` used after enable/disable (T6/T7); `usePluginHosts` poll uses `query.state.data` (TanStack v5); lock store `enabled/locked/setEnabled/unlock/maybeLockOnForeground` (T3) used by LockScreen/gate/settings (T10–T12); `authenticate/hasHardware/isEnrolled` (T2) used by LockScreen/settings.
- **Placeholders:** none. The config editor seeds via a child-component `useState` initializer (mounts post-load) to avoid the R5 `react-hooks/set-state-in-effect` lint error; the settings/LockScreen effects call setState only inside async callbacks (allowed).
- **Risk notes:** (1) `expo-local-authentication` adds a native dep → T2 + T14 run `npm ci` to keep the lock in sync (a stale lock has failed CI before). (2) The AppState→lock wiring and the real biometric prompt are device-only — an opus end-to-end review of `_layout.tsx`/LockScreen runs before ship (R4/R5 precedent). (3) Switch tests fire the `valueChange` event with a testID; RN `Switch` is rendered by jest-expo.
