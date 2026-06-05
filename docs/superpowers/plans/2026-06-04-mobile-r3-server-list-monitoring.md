# Mobile R3 — Server List + Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace R2's placeholder Home with a live server list + per-server detail (TanStack Query over R2's apiFetch), and wire 401 → clearSession.

**Architecture:** `authedFetch` reads baseURL/token from the auth store, delegates to `apiFetch`, and clears the session on 401. TanStack Query hooks (`useServers` polling 5s, `useServer` from cache) feed a `FlatList` server list and a `[id]` detail route. Pure helpers (metrics/format) and the hooks/screens are unit-tested headlessly.

**Tech Stack:** Expo SDK 56 + expo-router, zustand (R2), @tanstack/react-query (added here), jest + @testing-library/react-native.

**Spec:** `docs/superpowers/specs/2026-06-04-mobile-r3-server-list-monitoring-design.md`

**CRITICAL (R2 lesson):** after ANY `npm install` in `mobile/`, commit the **in-sync** `package-lock.json` (CI runs `npm ci`, which fails on a stale lock). Each dep-adding step ends by verifying `npm ci` succeeds.

**Headless:** verify only with `cd mobile && npx tsc --noEmit && npx eslint . && npx jest` (no simulator).

---

## File Structure
- `mobile/src/api/authed.ts` (T1), `mobile/src/api/metrics.ts` + `mobile/src/lib/format.ts` (T2), `mobile/src/api/servers.ts` (T3).
- `mobile/src/app/_layout.tsx` — wrap in QueryClientProvider (T1).
- `mobile/src/app/(app)/index.tsx` — server list (T4); `mobile/src/app/(app)/server/[id].tsx` — detail (T5).

---

## Task 1: Add TanStack Query + provider + authedFetch (401 wiring)

**Files:** add dep; Modify `mobile/src/app/_layout.tsx`; Create `mobile/src/api/authed.ts` + test.

- [ ] **Step 1: Add the dependency (sync the lock)**

```bash
cd /Users/hg/project/Shepherd/mobile
npx expo install @tanstack/react-query
npm install --package-lock-only   # ensure lock fully in sync with package.json
rm -rf node_modules && npm ci      # MUST succeed (this is what CI runs)
```
Expected: `npm ci` exits 0. If it errors "out of sync", re-run `npm install` then `npm ci` until green.

- [ ] **Step 2: Write the failing authedFetch test**

Create `mobile/src/api/__tests__/authed.test.ts`:
```ts
import { authedFetch } from '../authed'
import { APIError } from '../client'
import { useAuth } from '../../store/auth'

jest.mock('../client', () => ({
  APIError: jest.requireActual('../client').APIError,
  apiFetch: jest.fn(),
}))
import { apiFetch } from '../client'

beforeEach(() => {
  useAuth.setState({ status: 'signedIn', baseURL: 'https://h', token: 'T', admin: null, error: null })
  ;(apiFetch as jest.Mock).mockReset()
})

test('200 returns body, no session change', async () => {
  ;(apiFetch as jest.Mock).mockResolvedValue({ ok: 1 })
  await expect(authedFetch('/api/x')).resolves.toEqual({ ok: 1 })
  expect(useAuth.getState().status).toBe('signedIn')
})

test('401 clears session and re-throws', async () => {
  ;(apiFetch as jest.Mock).mockRejectedValue(new APIError(401, 'unauthorized'))
  await expect(authedFetch('/api/x')).rejects.toBeInstanceOf(APIError)
  expect(useAuth.getState().status).toBe('signedOut')
})

test('non-401 error re-throws WITHOUT clearing session', async () => {
  ;(apiFetch as jest.Mock).mockRejectedValue(new APIError(500, 'boom'))
  await expect(authedFetch('/api/x')).rejects.toMatchObject({ status: 500 })
  expect(useAuth.getState().status).toBe('signedIn')
})

test('missing baseURL throws without calling apiFetch', async () => {
  useAuth.setState({ baseURL: null })
  await expect(authedFetch('/api/x')).rejects.toBeInstanceOf(APIError)
  expect(apiFetch).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: Run to verify failure**

Run: `cd mobile && npx jest src/api/__tests__/authed`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `mobile/src/api/authed.ts`**

```ts
import { apiFetch, APIError } from './client'
import { useAuth } from '../store/auth'

// authedFetch issues an authenticated request using the current session
// (baseURL + token from the auth store). On a 401 it clears the session so the
// routing gate bounces to login, then re-throws.
export async function authedFetch<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const { baseURL, token } = useAuth.getState()
  if (!baseURL) throw new APIError(401, 'not signed in')
  try {
    return await apiFetch<T>(baseURL, token, path, opts)
  } catch (e) {
    if (e instanceof APIError && e.status === 401) {
      await useAuth.getState().clearSession()
    }
    throw e
  }
}
```

- [ ] **Step 5: Wrap the app in QueryClientProvider**

In `mobile/src/app/_layout.tsx`, add a single `QueryClient` and wrap the returned tree. Keep the R2 restore()/spinner/Stack logic:
```tsx
import { useEffect, useState } from 'react'
import { Stack } from 'expo-router'
import { View, ActivityIndicator } from 'react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuth } from '@/store/auth'
import { theme } from '@/theme'

export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient())
  const status = useAuth((s) => s.status)
  const restore = useAuth((s) => s.restore)
  useEffect(() => { restore() }, [restore])

  return (
    <QueryClientProvider client={queryClient}>
      {status === 'loading' ? (
        <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : (
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }} />
      )}
    </QueryClientProvider>
  )
}
```

- [ ] **Step 6: Verify**

Run: `cd mobile && npx jest src/api/__tests__/authed && npx tsc --noEmit && npx eslint .`
Expected: PASS (4/4); tsc clean; eslint no errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/hg/project/Shepherd
git add mobile/package.json mobile/package-lock.json mobile/src/api/authed.ts mobile/src/api/__tests__/authed.test.ts mobile/src/app/_layout.tsx
git commit -m "feat(mobile): TanStack Query provider + authedFetch (401 -> clearSession)"
```
Confirm `mobile/package-lock.json` IS in the commit and `mobile/node_modules` is NOT.

---

## Task 2: Pure helpers — metrics + format

**Files:** Create `mobile/src/api/metrics.ts`, `mobile/src/lib/format.ts`; Tests alongside.

- [ ] **Step 1: Write the failing tests**

`mobile/src/api/__tests__/metrics.test.ts`:
```ts
import { memPct, firstDiskPct, isOnline } from '../metrics'

test('memPct', () => {
  expect(memPct({ ts: '', mem_used: 50, mem_total: 100 })).toBe(50)
  expect(memPct({ ts: '', mem_used: 50 })).toBeNull()
  expect(memPct(null)).toBeNull()
})

test('firstDiskPct parses defensively', () => {
  expect(firstDiskPct(JSON.stringify([{ used: 30, total: 60 }]))).toBe(50)
  expect(firstDiskPct('not json')).toBeNull()
  expect(firstDiskPct(undefined)).toBeNull()
  expect(firstDiskPct('[]')).toBeNull()
})

test('isOnline', () => {
  expect(isOnline({ id: 1, name: 'a', connected: true, latest: null })).toBe(true)
  const recent = new Date().toISOString()
  expect(isOnline({ id: 1, name: 'a', connected: false, latest: null, agent_last_seen: { Valid: true, Time: recent } })).toBe(true)
  const stale = new Date(Date.now() - 5 * 60_000).toISOString()
  expect(isOnline({ id: 1, name: 'a', connected: false, latest: null, agent_last_seen: { Valid: true, Time: stale } })).toBe(false)
})
```

`mobile/src/lib/__tests__/format.test.ts`:
```ts
import { bps, pct, relTime } from '../format'

test('bps', () => {
  expect(bps(0)).toBe('0 B/s')
  expect(bps(1500)).toMatch(/KB\/s$/)
  expect(bps(5_000_000)).toMatch(/MB\/s$/)
})
test('pct', () => {
  expect(pct(42.6)).toBe('43%')
  expect(pct(null)).toBe('—')
})
test('relTime recent', () => {
  expect(relTime(new Date(Date.now() - 90_000).toISOString())).toMatch(/m ago$/)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mobile && npx jest src/api/__tests__/metrics src/lib/__tests__/format`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `mobile/src/api/metrics.ts`**

```ts
import type { Point, ServerRow } from './servers'

const ONLINE_WINDOW_MS = 90_000

export function memPct(p: Point | null): number | null {
  if (!p || p.mem_used == null || p.mem_total == null || p.mem_total === 0) return null
  return (p.mem_used / p.mem_total) * 100
}

export function firstDiskPct(disksJSON?: string): number | null {
  if (!disksJSON) return null
  try {
    const arr = JSON.parse(disksJSON)
    if (!Array.isArray(arr) || arr.length === 0) return null
    const d = arr[0] as { used?: number; total?: number; pct?: number }
    if (typeof d.pct === 'number') return d.pct
    if (typeof d.used === 'number' && typeof d.total === 'number' && d.total > 0) {
      return (d.used / d.total) * 100
    }
    return null
  } catch {
    return null
  }
}

function lastSeenISO(v: ServerRow['agent_last_seen']): string | null {
  if (!v) return null
  if (typeof v === 'string') return v
  return v.Valid ? v.Time : null
}

export function isOnline(row: ServerRow): boolean {
  if (row.connected) return true
  const iso = lastSeenISO(row.agent_last_seen)
  if (!iso) return false
  return Date.now() - new Date(iso).getTime() <= ONLINE_WINDOW_MS
}
```

- [ ] **Step 4: Implement `mobile/src/lib/format.ts`**

```ts
export function bps(n: number): string {
  if (n < 1000) return `${Math.round(n)} B/s`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} KB/s`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB/s`
  return `${(n / 1_000_000_000).toFixed(1)} GB/s`
}

export function pct(n: number | null | undefined): string {
  return n == null ? '—' : `${Math.round(n)}%`
}

export function relTime(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
```

- [ ] **Step 5: Verify**

Run: `cd mobile && npx jest src/api/__tests__/metrics src/lib/__tests__/format && npx tsc --noEmit && npx eslint .`
Expected: PASS; tsc clean (note: `metrics.ts` imports `Point`/`ServerRow` from `./servers` — Task 3 creates them; until then tsc will error on the missing import. To keep this task self-contained, ALSO create a minimal `mobile/src/api/servers.ts` exporting only the `Point` and `ServerRow` types in this step, then Task 3 fills in the hooks. Add the type-only file now:)

```ts
// mobile/src/api/servers.ts (types first; hooks added in Task 3)
export type Point = {
  ts: string
  cpu_pct?: number; mem_used?: number; mem_total?: number; load_1?: number
  net_rx_bps?: number; net_tx_bps?: number; tcp_conn?: number; disks_json?: string
}
export type ServerRow = {
  id: number; name: string
  agent_os?: string | null; agent_arch?: string | null
  agent_last_seen?: { Valid: boolean; Time: string } | string | null
  connected: boolean
  latest: Point | null
}
```
Re-run the verify; PASS + tsc clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/hg/project/Shepherd
git add mobile/src/api/metrics.ts mobile/src/api/servers.ts mobile/src/lib/format.ts mobile/src/api/__tests__/metrics.test.ts mobile/src/lib/__tests__/format.test.ts
git commit -m "feat(mobile): metrics (memPct/firstDiskPct/isOnline) + format helpers + server types"
```

---

## Task 3: Server query hooks

**Files:** Modify `mobile/src/api/servers.ts` (add hooks below the types); Test `mobile/src/api/__tests__/servers.test.tsx`.

- [ ] **Step 1: Write the failing test**

`mobile/src/api/__tests__/servers.test.tsx`:
```tsx
import React from 'react'
import { renderHook, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useServers } from '../servers'

jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

test('useServers resolves to rows', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([{ id: 1, name: 'srv1', connected: true, latest: null }])
  const { result } = renderHook(() => useServers(), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data?.[0].name).toBe('srv1')
  expect(authedFetch).toHaveBeenCalledWith('/api/servers?with=latest')
})

test('useServers surfaces error', async () => {
  ;(authedFetch as jest.Mock).mockRejectedValue(new Error('nope'))
  const { result } = renderHook(() => useServers(), { wrapper })
  await waitFor(() => expect(result.current.isError).toBe(true))
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mobile && npx jest src/api/__tests__/servers`
Expected: FAIL — `useServers` not exported.

- [ ] **Step 3: Add the hooks to `mobile/src/api/servers.ts`** (below the existing type exports)

```ts
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { authedFetch } from './authed'

export function useServers(): UseQueryResult<ServerRow[]> {
  return useQuery({
    queryKey: ['servers'],
    queryFn: () => authedFetch<ServerRow[]>('/api/servers?with=latest'),
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    staleTime: 2000,
  })
}

export function useServer(id: number): ServerRow | undefined {
  return useServers().data?.find((s) => s.id === id)
}
```
(Put the `import` lines at the TOP of the file, above the type exports.)

- [ ] **Step 4: Verify**

Run: `cd mobile && npx jest src/api/__tests__/servers && npx tsc --noEmit && npx eslint .`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add mobile/src/api/servers.ts mobile/src/api/__tests__/servers.test.tsx
git commit -m "feat(mobile): useServers/useServer query hooks (5s poll)"
```

---

## Task 4: Server list screen (replace Home)

**Files:** Replace `mobile/src/app/(app)/index.tsx`; Test `mobile/src/app/(app)/__tests__/list.test.tsx`.

- [ ] **Step 1: Write the failing test**

`mobile/src/app/(app)/__tests__/list.test.tsx`:
```tsx
import React from 'react'
import { render } from '@testing-library/react-native'
import ServerList from '../index'

jest.mock('expo-router', () => ({ router: { push: jest.fn() }, useRouter: () => ({ push: jest.fn() }) }))
jest.mock('@/api/servers', () => ({ useServers: jest.fn() }))
jest.mock('@/store/auth', () => ({ useAuth: Object.assign(() => jest.fn(), { getState: () => ({ logout: jest.fn() }) }) }))
import { useServers } from '@/api/servers'

test('renders rows with online + offline', () => {
  ;(useServers as jest.Mock).mockReturnValue({
    data: [
      { id: 1, name: 'alpha', connected: true, latest: { ts: '', cpu_pct: 12, mem_used: 1, mem_total: 2, net_rx_bps: 1000, net_tx_bps: 500 } },
      { id: 2, name: 'bravo', connected: false, latest: null },
    ],
    isLoading: false, isError: false, refetch: jest.fn(), isRefetching: false,
  })
  const { getByText } = render(<ServerList />)
  expect(getByText('alpha')).toBeTruthy()
  expect(getByText('bravo')).toBeTruthy()
})

test('renders error state', () => {
  ;(useServers as jest.Mock).mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error('boom'), refetch: jest.fn(), isRefetching: false })
  const { getByText } = render(<ServerList />)
  expect(getByText(/boom/)).toBeTruthy()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mobile && npx jest "src/app/(app)/__tests__/list"`
Expected: FAIL — current index is the R2 placeholder (no `alpha`/error text).

- [ ] **Step 3: Implement `mobile/src/app/(app)/index.tsx`**

```tsx
import { FlatList, View, Text, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'
import { useServers, type ServerRow } from '@/api/servers'
import { isOnline, memPct } from '@/api/metrics'
import { bps, pct } from '@/lib/format'
import { useAuth } from '@/store/auth'
import { theme } from '@/theme'

function Row({ row, onPress }: { row: ServerRow; onPress: () => void }) {
  const online = isOnline(row)
  const l = row.latest
  return (
    <Pressable onPress={onPress} style={{ padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border, opacity: online ? 1 : 0.55 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space(2) }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: online ? '#4ade80' : theme.textDim }} />
        <Text style={{ color: theme.text, fontWeight: '600', flex: 1 }}>{row.name}</Text>
        <Text style={{ color: theme.textDim, fontFamily: 'monospace', fontSize: 12 }}>
          {online && l ? `↓${bps(l.net_rx_bps ?? 0)} ↑${bps(l.net_tx_bps ?? 0)}` : '—'}
        </Text>
      </View>
      <Text style={{ color: theme.textDim, fontSize: 12, marginTop: theme.space(1) }}>
        {online && l ? `CPU ${pct(l.cpu_pct ?? null)}   MEM ${pct(memPct(l))}` : 'offline'}
      </Text>
    </Pressable>
  )
}

export default function ServerList() {
  const router = useRouter()
  const logout = useAuth((s) => s.logout)
  const q = useServers()
  const rows = (q.data ?? []).slice().sort((a, b) => {
    const oa = isOnline(a) ? 0 : 1, ob = isOnline(b) ? 0 : 1
    return oa - ob || a.name.localeCompare(b.name)
  })
  const onlineCount = rows.filter(isOnline).length

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
        <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600', flex: 1 }}>Servers</Text>
        <Text style={{ color: theme.textDim, marginRight: theme.space(3) }}>{onlineCount}/{rows.length} online</Text>
        <Pressable onPress={logout}><Text style={{ color: theme.accent }}>Log out</Text></Pressable>
      </View>
      {q.isLoading ? (
        <ActivityIndicator color={theme.accent} style={{ marginTop: theme.space(8) }} />
      ) : q.isError ? (
        <Text style={{ color: theme.error, padding: theme.space(4) }}>{q.error instanceof Error ? q.error.message : 'failed to load'}</Text>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(s) => String(s.id)}
          renderItem={({ item }) => <Row row={item} onPress={() => router.push(`/(app)/server/${item.id}`)} />}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={theme.accent} />}
          ListEmptyComponent={<Text style={{ color: theme.textDim, padding: theme.space(4) }}>No servers.</Text>}
        />
      )}
    </View>
  )
}
```

- [ ] **Step 4: Verify**

Run: `cd mobile && npx jest "src/app/(app)/__tests__/list" && npx tsc --noEmit && npx eslint .`
Expected: PASS; tsc clean. (If RN warns about `fontFamily: 'monospace'` in jest, it's harmless.)

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/index.tsx" "mobile/src/app/(app)/__tests__/list.test.tsx"
git commit -m "feat(mobile): server list screen (live poll, online-first, pull-to-refresh)"
```

---

## Task 5: Server detail screen

**Files:** Create `mobile/src/app/(app)/server/[id].tsx`; Test `mobile/src/app/(app)/server/__tests__/detail.test.tsx`.

- [ ] **Step 1: Write the failing test**

`mobile/src/app/(app)/server/__tests__/detail.test.tsx`:
```tsx
import React from 'react'
import { render } from '@testing-library/react-native'
import ServerDetail from '../[id]'

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: '7' }) }))
jest.mock('@/api/servers', () => ({ useServer: jest.fn() }))
import { useServer } from '@/api/servers'

test('renders metrics for a server', () => {
  ;(useServer as jest.Mock).mockReturnValue({
    id: 7, name: 'gamma', connected: true, agent_os: 'linux', agent_arch: 'amd64',
    latest: { ts: '', cpu_pct: 33, mem_used: 1, mem_total: 4, load_1: 0.5, tcp_conn: 12, net_rx_bps: 2000, net_tx_bps: 1000 },
  })
  const { getByText } = render(<ServerDetail />)
  expect(getByText('gamma')).toBeTruthy()
  expect(getByText(/linux/)).toBeTruthy()
})

test('not found when absent', () => {
  ;(useServer as jest.Mock).mockReturnValue(undefined)
  const { getByText } = render(<ServerDetail />)
  expect(getByText(/not found/i)).toBeTruthy()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mobile && npx jest "src/app/(app)/server/__tests__/detail"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mobile/src/app/(app)/server/[id].tsx`**

```tsx
import { View, Text } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { useServer } from '@/api/servers'
import { isOnline, memPct, firstDiskPct } from '@/api/metrics'
import { bps, pct, relTime } from '@/lib/format'
import { theme } from '@/theme'

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: theme.space(2), borderBottomWidth: 1, borderColor: theme.border }}>
      <Text style={{ color: theme.textDim }}>{label}</Text>
      <Text style={{ color: theme.text, fontFamily: 'monospace' }}>{value}</Text>
    </View>
  )
}

export default function ServerDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const row = useServer(Number(id))
  if (!row) {
    return <View style={{ flex: 1, backgroundColor: theme.bg, padding: theme.space(5) }}><Text style={{ color: theme.textDim }}>Server not found.</Text></View>
  }
  const l = row.latest
  const lastSeen = typeof row.agent_last_seen === 'object' && row.agent_last_seen?.Valid ? row.agent_last_seen.Time : null
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, padding: theme.space(4) }}>
      <Text style={{ color: theme.text, fontSize: 20, fontWeight: '600' }}>{row.name}</Text>
      <Text style={{ color: isOnline(row) ? '#4ade80' : theme.textDim, marginBottom: theme.space(3) }}>{isOnline(row) ? 'online' : 'offline'}</Text>
      <Stat label="CPU" value={pct(l?.cpu_pct ?? null)} />
      <Stat label="Memory" value={pct(memPct(l ?? null))} />
      <Stat label="Disk" value={pct(firstDiskPct(l?.disks_json))} />
      <Stat label="Net" value={l ? `↓ ${bps(l.net_rx_bps ?? 0)}  ↑ ${bps(l.net_tx_bps ?? 0)}` : '—'} />
      <Stat label="Load (1m)" value={l?.load_1 != null ? l.load_1.toFixed(2) : '—'} />
      <Stat label="TCP conns" value={l?.tcp_conn != null ? String(l.tcp_conn) : '—'} />
      <Stat label="OS / Arch" value={`${row.agent_os ?? '—'} / ${row.agent_arch ?? '—'}`} />
      <Stat label="Last seen" value={lastSeen ? relTime(lastSeen) : '—'} />
    </View>
  )
}
```

- [ ] **Step 4: Verify**

Run: `cd mobile && npx jest "src/app/(app)/server/__tests__/detail" && npx tsc --noEmit && npx eslint .`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/server/" 
git commit -m "feat(mobile): server detail screen (current telemetry)"
```

---

## Task 6: Full verification

**Files:** none.

- [ ] **Step 1: Mobile gates (clean install — CI parity)**

Run: `cd /Users/hg/project/Shepherd/mobile && rm -rf node_modules && npm ci && npx tsc --noEmit && npx eslint . && npx jest --ci`
Expected: `npm ci` succeeds (lock in sync); tsc clean; eslint no errors; all jest suites pass.

- [ ] **Step 2: Backend/web untouched**

Run: `cd /Users/hg/project/Shepherd && go build ./... && (cd web && npx tsc --noEmit)`
Expected: clean.

- [ ] **Step 3: Hygiene**

Run: `cd /Users/hg/project/Shepherd && git status --porcelain | grep -i node_modules && echo LEAK || echo "clean"`
Expected: "clean".

---

## Self-Review

- **Spec coverage:** authedFetch + 401 wiring + QueryClientProvider → T1; metrics + format helpers → T2; server types → T2; useServers/useServer → T3; list screen → T4; detail screen → T5; gates → T6. All spec components mapped.
- **Type consistency:** `Point`/`ServerRow` defined in `servers.ts` (T2) and imported by `metrics.ts` (T2) + screens (T4/T5); `authedFetch<T>(path, opts?)` (T1) used by `useServers` (T3); `memPct/firstDiskPct/isOnline` (T2) used in screens; `bps/pct/relTime` (T2) used in screens.
- **Placeholders:** none — complete code + tests. T2 deliberately creates the type-only `servers.ts` so `metrics.ts` compiles before T3 adds the hooks (noted inline).
- **Risk note:** the R2 CI failure (stale lock) is pre-empted — T1 Step 1 syncs + `npm ci`-verifies the lock, and T6 re-verifies a clean `npm ci`. Screen tests mock `expo-router` + the hooks so they don't need the router runtime or a live query client.
