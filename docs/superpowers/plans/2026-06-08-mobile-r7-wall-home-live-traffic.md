# Mobile R7 — Wall-style Home + Live Traffic + Safe-area Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the mobile home into the web "public wall" form (grouped server cards + summary strip), wire live network traffic via the public multiplexed WS, and make every screen safe-area aware.

**Architecture:** A `wallLive` zustand store (port of the web's) fed by one public WS opened in `(app)/_layout.tsx`; a `LiveNet` render-prop cell subscribes per-server. The home rewrites `useServers()` rows into grouped cards computing mem%/disk% client-side. A `Screen` wrapper + root `SafeAreaProvider` apply insets everywhere.

**Tech Stack:** Expo SDK 56 + expo-router, TanStack Query, zustand, `react-native-safe-area-context` (already installed), jest-expo + @testing-library/react-native.

**Spec:** `docs/superpowers/specs/2026-06-08-mobile-r7-wall-home-live-traffic-design.md`

**Confirmed facts:**
- `src/api/metrics.ts` already exports `memPct(p)`, `firstDiskPct(disksJSON)`, `isOnline(row)`. REUSE them.
- `src/lib/format.ts` exports `bps(n)`, `pct(n)`, `relTime(iso)`. REUSE `bps`.
- `src/console/wsurl.ts` does `baseURL.replace(/^http/, 'ws')` — T1 generalizes that.
- Admin `/api/servers?with=latest` returns `public_alias, public_group, country_code, agent_os, agent_arch, connected, latest{cpu_pct,mem_used,mem_total,load_1,net_rx_bps,net_tx_bps,disks_json}` — but the mobile `ServerRow` type currently omits `public_alias/public_group/country_code` (T6 adds them).
- Public WS `/api/public/net-live/ws` pushes `{server_id, ts, rx_bps, tx_bps}`, no auth, ids == admin ids.
- `jest-setup.ts` globally mocks expo-secure-store, async-storage, expo-local-authentication. T5 adds a safe-area-context mock.
- `(app)/_layout.tsx` (post-R6) holds the lock gate; T7 adds the live-WS hook there. `(app)/index.tsx` is the current flat list.

**Headless:** `cd mobile && npx tsc --noEmit && npx eslint . && npx jest`. No new dep (no lock change); T10 still runs `npm ci`.

---

## Task 1: `wsURL` helper

**Files:** Create `mobile/src/lib/wsurl.ts` + test.

- [ ] **Step 1: Failing test** `mobile/src/lib/__tests__/wsurl.test.ts`:
```ts
import { wsURL } from '../wsurl'
test('http→ws, https→wss, path appended', () => {
  expect(wsURL('https://h.example', '/api/public/net-live/ws')).toBe('wss://h.example/api/public/net-live/ws')
  expect(wsURL('http://localhost:8080', '/x')).toBe('ws://localhost:8080/x')
})
```
Run `npx jest src/lib/__tests__/wsurl` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/lib/wsurl.ts`:
```ts
// wsURL turns an https/http baseURL + a path into a wss/ws URL.
export function wsURL(baseURL: string, path: string): string {
  return `${baseURL.replace(/^http/, 'ws')}${path}`
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest src/lib/__tests__/wsurl && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add mobile/src/lib/wsurl.ts mobile/src/lib/__tests__/wsurl.test.ts
git commit -m "feat(mobile): generic wsURL helper"
```

---

## Task 2: `wallLive` store + connection + `useLiveNet`

**Files:** Create `mobile/src/api/wallLive.ts` + test.

- [ ] **Step 1: Failing test** `mobile/src/api/__tests__/wallLive.test.tsx`:
```tsx
import { renderHook } from '@testing-library/react-native'
import { useWallLiveStore, useWallLiveConnection, useLiveNet } from '../wallLive'
import { useAuth } from '@/store/auth'

class FakeWS {
  static last: FakeWS | null = null
  url: string
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  close = jest.fn()
  constructor(url: string) { this.url = url; FakeWS.last = this }
}

beforeEach(() => {
  useWallLiveStore.setState({ live: {}, connected: false })
  ;(global as unknown as { WebSocket: unknown }).WebSocket = FakeWS
  useAuth.setState({ status: 'signedIn', baseURL: 'https://h', token: 'T', admin: null, error: null })
})

test('setFrame updates one id; useLiveNet reads it', () => {
  useWallLiveStore.getState().setFrame(7, 100, 200)
  const { result } = renderHook(() => useLiveNet(7))
  expect(result.current).toEqual({ rx_bps: 100, tx_bps: 200 })
})

test('connection opens the public ws and writes frames', () => {
  renderHook(() => useWallLiveConnection())
  expect(FakeWS.last?.url).toBe('wss://h/api/public/net-live/ws')
  FakeWS.last?.onopen?.()
  expect(useWallLiveStore.getState().connected).toBe(true)
  FakeWS.last?.onmessage?.({ data: JSON.stringify({ server_id: 3, rx_bps: 5, tx_bps: 6 }) })
  expect(useWallLiveStore.getState().live[3]).toEqual({ rx_bps: 5, tx_bps: 6 })
})
```
Run `npx jest src/api/__tests__/wallLive` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/api/wallLive.ts`:
```ts
import { useEffect } from 'react'
import { create } from 'zustand'
import { useAuth } from '@/store/auth'
import { wsURL } from '@/lib/wsurl'

export type LiveVal = { rx_bps: number; tx_bps: number }

type WallLiveState = {
  live: Record<number, LiveVal>
  connected: boolean
  setFrame: (id: number, rx: number, tx: number) => void
  setConnected: (b: boolean) => void
}

// One store keyed by server_id. setFrame replaces only the changed id's value so
// sibling references stay stable and per-id subscribers don't re-render.
export const useWallLiveStore = create<WallLiveState>((set) => ({
  live: {},
  connected: false,
  setFrame: (id, rx, tx) => set((s) => ({ live: { ...s.live, [id]: { rx_bps: rx, tx_bps: tx } } })),
  setConnected: (connected) => set({ connected }),
}))

// Opens the single public multiplexed net-live WS and writes frames into the store.
// Call ONCE for the authed session (we mount it in (app)/_layout.tsx). Public
// endpoint → no bearer. Best-effort: if it never opens, cards use polled fallback.
export function useWallLiveConnection(): void {
  useEffect(() => {
    const baseURL = useAuth.getState().baseURL
    if (!baseURL) return
    const ws = new WebSocket(wsURL(baseURL, '/api/public/net-live/ws'))
    const { setFrame, setConnected } = useWallLiveStore.getState()
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onmessage = (ev) => {
      try {
        const f = JSON.parse(ev.data as string) as { server_id: number; rx_bps: number; tx_bps: number }
        setFrame(f.server_id, f.rx_bps, f.tx_bps)
      } catch {
        /* ignore malformed frame */
      }
    }
    return () => { ws.onmessage = null; ws.close() }
  }, [])
}

// Subscribes to one server's latest {rx,tx}; re-renders the caller only when THAT
// id's value changes.
export function useLiveNet(id: number): LiveVal | undefined {
  return useWallLiveStore((s) => s.live[id])
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest src/api/__tests__/wallLive && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add mobile/src/api/wallLive.ts mobile/src/api/__tests__/wallLive.test.tsx
git commit -m "feat(mobile): wallLive store + public net-live WS connection"
```

---

## Task 3: `LiveNet` cell

**Files:** Create `mobile/src/components/LiveNet.tsx` + test.

- [ ] **Step 1: Failing test** `mobile/src/components/__tests__/LiveNet.test.tsx`:
```tsx
import React from 'react'
import { render } from '@testing-library/react-native'
import { Text } from 'react-native'
import { LiveNet } from '../LiveNet'
jest.mock('@/api/wallLive', () => ({ useLiveNet: jest.fn() }))
import { useLiveNet } from '@/api/wallLive'

test('shows live value when present, else fallback', () => {
  ;(useLiveNet as jest.Mock).mockReturnValue({ rx_bps: 11, tx_bps: 22 })
  const a = render(<LiveNet id={1} fallbackRx={1} fallbackTx={2}>{(rx, tx) => <Text>{`${rx}/${tx}`}</Text>}</LiveNet>)
  expect(a.getByText('11/22')).toBeTruthy()
  ;(useLiveNet as jest.Mock).mockReturnValue(undefined)
  const b = render(<LiveNet id={1} fallbackRx={1} fallbackTx={2}>{(rx, tx) => <Text>{`${rx}/${tx}`}</Text>}</LiveNet>)
  expect(b.getByText('1/2')).toBeTruthy()
})
```
Run `npx jest src/components/__tests__/LiveNet` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/components/LiveNet.tsx`:
```tsx
import type { ReactNode } from 'react'
import { useLiveNet } from '@/api/wallLive'

// Subscribes to one server's live net and renders through children, so only this
// leaf re-renders on a frame. Falls back to the polled values until a frame lands.
export function LiveNet({ id, fallbackRx, fallbackTx, children }: {
  id: number; fallbackRx: number; fallbackTx: number; children: (rx: number, tx: number) => ReactNode
}) {
  const live = useLiveNet(id)
  return <>{children(live?.rx_bps ?? fallbackRx, live?.tx_bps ?? fallbackTx)}</>
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest src/components/__tests__/LiveNet && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add mobile/src/components/LiveNet.tsx mobile/src/components/__tests__/LiveNet.test.tsx
git commit -m "feat(mobile): LiveNet render-prop cell (live + fallback)"
```

---

## Task 4: `countryFlag` + `MetricBar` + `OnlineDot`

**Files:** Modify `mobile/src/lib/format.ts`; Create `mobile/src/components/MetricBar.tsx`, `mobile/src/components/OnlineDot.tsx` + tests.

- [ ] **Step 1: Failing tests**
`mobile/src/lib/__tests__/countryFlag.test.ts`:
```ts
import { countryFlag } from '../format'
test('ISO-2 → flag emoji, else empty', () => {
  expect(countryFlag('US')).toBe('\u{1F1FA}\u{1F1F8}')
  expect(countryFlag('us')).toBe('\u{1F1FA}\u{1F1F8}')
  expect(countryFlag('')).toBe('')
  expect(countryFlag(null)).toBe('')
  expect(countryFlag('X')).toBe('')
})
```
`mobile/src/components/__tests__/MetricBar.test.tsx`:
```tsx
import React from 'react'
import { render } from '@testing-library/react-native'
import { MetricBar } from '../MetricBar'
test('renders percent and dash for null', () => {
  expect(render(<MetricBar label="CPU" value={42} />).getByText('42%')).toBeTruthy()
  expect(render(<MetricBar label="MEM" value={null} />).getByText('—')).toBeTruthy()
})
```
Run `npx jest src/lib/__tests__/countryFlag src/components/__tests__/MetricBar` → FAIL.

- [ ] **Step 2: Implement**
Append to `mobile/src/lib/format.ts`:
```ts
// countryFlag turns an ISO-3166-1 alpha-2 code into its flag emoji ('' if absent/invalid).
export function countryFlag(code?: string | null): string {
  if (!code) return ''
  const cc = code.toUpperCase()
  if (!/^[A-Z]{2}$/.test(cc)) return ''
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
}
```
`mobile/src/components/MetricBar.tsx`:
```tsx
import { View, Text } from 'react-native'
import { theme } from '@/theme'

// A labeled horizontal usage bar. Tints warn ≥80, err ≥92 (web thresholds); dim when null.
export function MetricBar({ label, value }: { label: string; value: number | null }) {
  const v = value == null ? 0 : Math.min(100, Math.max(0, value))
  const color = value == null ? theme.textDim : value >= 92 ? theme.error : value >= 80 ? '#f0c060' : theme.accent
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space(2) }}>
      {label ? <Text style={{ color: theme.textDim, fontSize: 10, width: 30 }}>{label}</Text> : null}
      <View style={{ flex: 1, height: 6, backgroundColor: theme.surface, borderRadius: 3, overflow: 'hidden' }}>
        <View style={{ width: `${v}%`, height: 6, backgroundColor: color }} />
      </View>
      <Text style={{ color: theme.textDim, fontSize: 10, width: 36, textAlign: 'right' }}>{value == null ? '—' : `${Math.round(value)}%`}</Text>
    </View>
  )
}
```
`mobile/src/components/OnlineDot.tsx`:
```tsx
import { View } from 'react-native'
import { theme } from '@/theme'

export function OnlineDot({ online }: { online: boolean }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: online ? '#4ade80' : theme.textDim }} />
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest src/lib/__tests__/countryFlag src/components/__tests__/MetricBar && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add mobile/src/lib/format.ts mobile/src/components/MetricBar.tsx mobile/src/components/OnlineDot.tsx mobile/src/lib/__tests__/countryFlag.test.ts mobile/src/components/__tests__/MetricBar.test.tsx
git commit -m "feat(mobile): countryFlag + MetricBar + OnlineDot atoms"
```

---

## Task 5: `SafeAreaProvider` + `Screen` wrapper + jest mock

**Files:** Modify `mobile/src/app/_layout.tsx`, `mobile/jest-setup.ts`; Create `mobile/src/components/Screen.tsx` + test.

- [ ] **Step 1: Add the safe-area jest mock** — append to `mobile/jest-setup.ts`:
```ts
jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('react-native-safe-area-context/jest/mock'))
```
(This provides `SafeAreaProvider` + `useSafeAreaInsets` returning zero insets, so screen tests need no provider.)

- [ ] **Step 2: Failing test** `mobile/src/components/__tests__/Screen.test.tsx`:
```tsx
import React from 'react'
import { render } from '@testing-library/react-native'
import { Text } from 'react-native'
import { Screen } from '../Screen'
test('renders children', () => {
  expect(render(<Screen><Text>hi</Text></Screen>).getByText('hi')).toBeTruthy()
})
```
Run `npx jest src/components/__tests__/Screen` → FAIL.

- [ ] **Step 3: Implement** `mobile/src/components/Screen.tsx`:
```tsx
import type { ReactNode } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { theme } from '@/theme'

// Applies safe-area insets + the app background so screens clear the notch / status
// bar / home indicator. A screen with its own scroll can pass edges={['top']} and
// handle the bottom itself.
export function Screen({ children, edges = ['top', 'bottom'] }: { children: ReactNode; edges?: ('top' | 'bottom')[] }) {
  const i = useSafeAreaInsets()
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: edges.includes('top') ? i.top : 0, paddingBottom: edges.includes('bottom') ? i.bottom : 0 }}>
      {children}
    </View>
  )
}
```

- [ ] **Step 4: Wrap the root** `mobile/src/app/_layout.tsx` — add the provider around the existing tree:
```tsx
import { SafeAreaProvider } from 'react-native-safe-area-context'
// ...existing imports...

export default function RootLayout() {
  // ...existing body unchanged, but wrap the returned tree:
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        {/* existing loading-vs-Stack content unchanged */}
      </QueryClientProvider>
    </SafeAreaProvider>
  )
}
```
(Keep the existing `status === 'loading' ? <loading/> : <Stack .../>` body verbatim inside `QueryClientProvider`.)

- [ ] **Step 5: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest src/components/__tests__/Screen && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add mobile/src/app/_layout.tsx mobile/jest-setup.ts mobile/src/components/Screen.tsx mobile/src/components/__tests__/Screen.test.tsx
git commit -m "feat(mobile): SafeAreaProvider + Screen inset wrapper"
```

---

## Task 6: Wall home screen

**Files:** Modify `mobile/src/api/servers.ts` (extend `ServerRow` type); Rewrite `mobile/src/app/(app)/index.tsx`; Test `mobile/src/app/(app)/__tests__/home.test.tsx`.

- [ ] **Step 1: Extend the type** in `mobile/src/api/servers.ts` — add to `ServerRow`:
```ts
  public_alias?: string | null
  public_group?: string | null
  country_code?: string | null
```

- [ ] **Step 2: Failing test** `mobile/src/app/(app)/__tests__/home.test.tsx`:
```tsx
import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'
import Home from '../index'
const mockPush = jest.fn()
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }))
jest.mock('@/store/auth', () => ({ useAuth: (sel: (s: { logout: () => void }) => unknown) => sel({ logout: jest.fn() }) }))
jest.mock('@/api/wallLive', () => ({ useWallLiveStore: (sel: (s: { live: Record<number, unknown> }) => unknown) => sel({ live: {} }), useLiveNet: () => undefined }))
const rows = [
  { id: 1, name: 'alpha', public_group: 'asia', country_code: 'HK', connected: true, agent_os: 'linux', agent_arch: 'amd64', latest: { ts: '', cpu_pct: 10, mem_used: 1, mem_total: 2, load_1: 0.5, net_rx_bps: 100, net_tx_bps: 50, disks_json: '[]' } },
  { id: 2, name: 'beta', public_group: 'asia', country_code: 'US', connected: false, latest: null },
]
jest.mock('@/api/servers', () => ({ useServers: () => ({ data: rows, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() }) }))
jest.mock('@/api/metrics', () => ({ isOnline: (r: { connected: boolean }) => r.connected, memPct: () => 50, firstDiskPct: () => 30 }))

beforeEach(() => mockPush.mockClear())

test('renders grouped cards, summary counts, and navigates on tap', () => {
  const { getByText } = render(<Home />)
  expect(getByText('asia')).toBeTruthy()       // group header
  expect(getByText('alpha')).toBeTruthy()
  expect(getByText('beta')).toBeTruthy()
  expect(getByText('1/2 online')).toBeTruthy() // group online count
  fireEvent.press(getByText('alpha'))
  expect(mockPush).toHaveBeenCalledWith('/(app)/server/1')
})
```
Run `npx jest "src/app/(app)/__tests__/home"` → FAIL.

- [ ] **Step 3: Rewrite** `mobile/src/app/(app)/index.tsx`:
```tsx
import { FlatList, View, Text, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'
import { useServers, type ServerRow } from '@/api/servers'
import { isOnline, memPct, firstDiskPct } from '@/api/metrics'
import { bps, countryFlag } from '@/lib/format'
import { useAuth } from '@/store/auth'
import { useWallLiveStore } from '@/api/wallLive'
import { LiveNet } from '@/components/LiveNet'
import { MetricBar } from '@/components/MetricBar'
import { OnlineDot } from '@/components/OnlineDot'
import { Screen } from '@/components/Screen'
import { theme } from '@/theme'

const aliasOf = (r: ServerRow) => r.public_alias || r.name

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'ok' | 'err' }) {
  return (
    <View style={{ flexGrow: 1, flexBasis: 90, backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: theme.space(2) }}>
      <Text style={{ color: theme.textDim, fontSize: 10 }}>{label}</Text>
      <Text style={{ color: tone === 'err' ? theme.error : tone === 'ok' ? '#4ade80' : theme.text, fontSize: 16, fontWeight: '700' }}>{value}</Text>
      {sub ? <Text style={{ color: theme.textDim, fontSize: 10 }}>{sub}</Text> : null}
    </View>
  )
}

function RealtimeStat({ onlineRows }: { onlineRows: ServerRow[] }) {
  const live = useWallLiveStore((s) => s.live)
  const rx = onlineRows.reduce((a, r) => a + (live[r.id]?.rx_bps ?? r.latest?.net_rx_bps ?? 0), 0)
  const tx = onlineRows.reduce((a, r) => a + (live[r.id]?.tx_bps ?? r.latest?.net_tx_bps ?? 0), 0)
  return <Stat label="Realtime" value={`↓ ${bps(rx)}`} sub={`↑ ${bps(tx)}`} />
}

function SummaryStrip({ total, online, offline, onlineRows }: { total: number; online: number; offline: number; onlineRows: ServerRow[] }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space(2), padding: theme.space(3) }}>
      <Stat label="Nodes" value={String(total)} />
      <Stat label="Online" value={String(online)} tone="ok" />
      <Stat label="Offline" value={String(offline)} tone={offline > 0 ? 'err' : undefined} />
      <RealtimeStat onlineRows={onlineRows} />
    </View>
  )
}

function ServerCard({ row, onPress }: { row: ServerRow; onPress: () => void }) {
  const online = isOnline(row)
  const l = row.latest
  const flag = countryFlag(row.country_code)
  return (
    <Pressable onPress={onPress} style={{ backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, borderRadius: 10, padding: theme.space(3), marginBottom: theme.space(2), opacity: online ? 1 : 0.6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space(2) }}>
        <OnlineDot online={online} />
        {flag ? <Text style={{ fontSize: 14 }}>{flag}</Text> : null}
        <Text style={{ color: theme.text, fontWeight: '600', flex: 1 }} numberOfLines={1}>{aliasOf(row)}</Text>
        {online && l ? <Text style={{ color: theme.textDim, fontSize: 11 }}>load {l.load_1?.toFixed(2) ?? '—'}</Text> : null}
      </View>
      {online && l ? (
        <View style={{ marginTop: theme.space(2), gap: theme.space(1) }}>
          {row.agent_os ? <Text style={{ color: theme.textDim, fontSize: 10 }}>{row.agent_os}{row.agent_arch ? ` · ${row.agent_arch}` : ''}</Text> : null}
          <MetricBar label="CPU" value={l.cpu_pct ?? null} />
          <MetricBar label="MEM" value={memPct(l)} />
          <MetricBar label="DSK" value={firstDiskPct(l.disks_json)} />
          <LiveNet id={row.id} fallbackRx={l.net_rx_bps ?? 0} fallbackTx={l.net_tx_bps ?? 0}>
            {(rx, tx) => <Text style={{ color: theme.textDim, fontFamily: 'monospace', fontSize: 11, marginTop: theme.space(1) }}>↓ {bps(rx)}   ↑ {bps(tx)}</Text>}
          </LiveNet>
        </View>
      ) : <Text style={{ color: theme.textDim, fontSize: 11, marginTop: theme.space(1) }}>offline</Text>}
    </Pressable>
  )
}

export default function Home() {
  const router = useRouter()
  const logout = useAuth((s) => s.logout)
  const q = useServers()
  const rows = q.data ?? []
  const total = rows.length
  const onlineRows = rows.filter(isOnline)

  const groups = new Map<string, ServerRow[]>()
  for (const r of rows) {
    const k = r.public_group || ''
    const a = groups.get(k) ?? []
    a.push(r)
    groups.set(k, a)
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
        <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600', flex: 1 }}>Servers</Text>
        <Pressable onPress={() => router.push('/(app)/plugins')} style={{ marginRight: theme.space(3) }}><Text style={{ color: theme.accent }}>Plugins</Text></Pressable>
        <Pressable onPress={() => router.push('/(app)/settings')} style={{ marginRight: theme.space(3) }}><Text style={{ color: theme.accent }}>Settings</Text></Pressable>
        <Pressable onPress={logout}><Text style={{ color: theme.accent }}>Log out</Text></Pressable>
      </View>
      {q.isLoading ? <ActivityIndicator color={theme.accent} style={{ marginTop: theme.space(8) }} />
        : q.isError ? <Text style={{ color: theme.error, padding: theme.space(4) }}>{q.error instanceof Error ? q.error.message : 'failed to load'}</Text>
        : <FlatList
            data={ordered}
            keyExtractor={([g]) => g || '_'}
            ListHeaderComponent={<SummaryStrip total={total} online={onlineRows.length} offline={total - onlineRows.length} onlineRows={onlineRows} />}
            renderItem={({ item: [group, ss] }) => {
              const gOnline = ss.filter(isOnline).length
              const sorted = ss.slice().sort((a, b) => {
                const oa = isOnline(a) ? 0 : 1, ob = isOnline(b) ? 0 : 1
                return oa - ob || aliasOf(a).localeCompare(aliasOf(b))
              })
              return (
                <View style={{ paddingHorizontal: theme.space(3), paddingTop: theme.space(3) }}>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.space(2), marginBottom: theme.space(2) }}>
                    <Text style={{ color: theme.text, fontWeight: '600', fontSize: 13 }}>{group || 'Ungrouped'}</Text>
                    <Text style={{ color: theme.textDim, fontSize: 11 }}>{gOnline}/{ss.length} online</Text>
                  </View>
                  {sorted.map((r) => <ServerCard key={r.id} row={r} onPress={() => router.push(`/(app)/server/${r.id}`)} />)}
                </View>
              )
            }}
            refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={theme.accent} />}
            ListEmptyComponent={<Text style={{ color: theme.textDim, padding: theme.space(4) }}>No servers.</Text>}
          />}
    </Screen>
  )
}
```

- [ ] **Step 4: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest "src/app/(app)/__tests__/home" && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add mobile/src/api/servers.ts "mobile/src/app/(app)/index.tsx" "mobile/src/app/(app)/__tests__/home.test.tsx"
git commit -m "feat(mobile): wall-style home (grouped cards, summary, live net)"
```

---

## Task 7: Open the live WS in the `(app)` shell

**Files:** Modify `mobile/src/app/(app)/_layout.tsx`; Update `mobile/src/app/(app)/__tests__/layout-lock.test.tsx`.

- [ ] **Step 1: Add the hook** — in `mobile/src/app/(app)/_layout.tsx`, import and call `useWallLiveConnection()` near the top of `AppLayout` (it's a hook → must run before the conditional returns, alongside the existing hooks):
```tsx
import { useWallLiveConnection } from '@/api/wallLive'
// ...
export default function AppLayout() {
  const status = useAuth((s) => s.status)
  const { enabled, locked, hydrated, hydrate, noteBackground, maybeLockOnForeground } = useLock()
  useWallLiveConnection()
  // ...rest unchanged (appState ref, effects, the redirect + !hydrated guards + Slot/LockScreen)...
}
```

- [ ] **Step 2: Update the layout test** — the existing `layout-lock.test.tsx` mocks `@/store/lock`, `@/store/auth`, `@/components/LockScreen`, `expo-router`. Add a mock for `@/api/wallLive` so the new hook is a no-op:
```tsx
jest.mock('@/api/wallLive', () => ({ useWallLiveConnection: () => {} }))
```
(Insert alongside the other `jest.mock` calls.)

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest layout-lock && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/_layout.tsx" "mobile/src/app/(app)/__tests__/layout-lock.test.tsx"
git commit -m "feat(mobile): open the live net WS once for the authed session"
```
Expected: layout-lock tests pass; tsc clean. (One socket serves home + detail; it closes when the (app) group unmounts on logout.)

---

## Task 8: Safe-area rollout to remaining screens

**Files:** Modify `mobile/src/app/(app)/console/[id].tsx`, `files/[id]/index.tsx`, `files/[id]/preview.tsx`, `scripts/index.tsx`, `scripts/[id].tsx`, `scripts/run/[runId].tsx`, `plugins/index.tsx`, `plugins/[id]/index.tsx`, `plugins/[id]/config.tsx`, `plugins/[id]/hosts.tsx`, `settings.tsx`. (Home + detail handled in T6/T9.)

- [ ] **Step 1: Wrap each screen's root in `<Screen>`** — for every file above, read it, then replace the outermost layout element with `<Screen>…</Screen>`:
  - If the root is `<View style={{ flex: 1, backgroundColor: theme.bg }}>…</View>`, change it to `<Screen>…</Screen>` (drop the now-redundant flex/bg — `Screen` provides both) and add `import { Screen } from '@/components/Screen'`.
  - If the root is a `<ScrollView>`, wrap it: `<Screen edges={['top']}><ScrollView …>…</ScrollView></Screen>` (let the scroll content handle its own bottom padding).
  - **`console/[id].tsx`**: use `<Screen edges={['top']}>` and add the bottom inset to the control-key bar / input container so keys clear the home indicator — `import { useSafeAreaInsets }` and add `paddingBottom: insets.bottom` to the keybar container's style. Keep the WebView filling the area above.
  - Early-return states ("not found", loading) may stay as-is or also be wrapped — wrapping is preferred for consistency but not required.

- [ ] **Step 2: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx tsc --noEmit && npx eslint . && npx jest
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/"
git commit -m "feat(mobile): apply safe-area Screen wrapper to all screens"
```
Expected: tsc clean; eslint no new errors; ALL existing suites still pass (the safe-area jest mock from T5 gives zero insets, so `Screen` is transparent in tests). Report any screen whose test needed adjustment.

---

## Task 9: Server detail — Screen wrap + live net

**Files:** Modify `mobile/src/app/(app)/server/[id].tsx` + its test.

- [ ] **Step 1: Read** `mobile/src/app/(app)/server/[id].tsx` and its test. Find (a) the root layout element and (b) where the network reading (`net_rx_bps`/`net_tx_bps`, likely via `bps(...)`) is displayed.

- [ ] **Step 2: Wrap + go live**
  - Wrap the root in `<Screen>` (import it), same rule as T8.
  - Replace the static net display with a `LiveNet` cell so it updates from the shared store:
    ```tsx
    import { LiveNet } from '@/components/LiveNet'
    // where it currently shows e.g. `↓ {bps(l.net_rx_bps ?? 0)} ↑ {bps(l.net_tx_bps ?? 0)}`:
    <LiveNet id={sid} fallbackRx={l.net_rx_bps ?? 0} fallbackTx={l.net_tx_bps ?? 0}>
      {(rx, tx) => <Text style={/* keep the existing style */}>↓ {bps(rx)}  ↑ {bps(tx)}</Text>}
    </LiveNet>
    ```
    Use the screen's existing server-id variable (likely `id`/`sid`/`row.id` — match what the file uses). The WS connection already runs in `(app)/_layout.tsx` (T7), so no connection code here.

- [ ] **Step 3: Test** — add/extend a test asserting the live value renders when `useLiveNet` is mocked. In the detail test file, mock `@/api/wallLive`:
```tsx
jest.mock('@/api/wallLive', () => ({ useLiveNet: () => ({ rx_bps: 999, tx_bps: 888 }) }))
```
and assert the screen shows `bps(999)` (e.g. `getByText(/999 B\/s|1.0 KB\/s/)` — match what `bps(999)` returns: `999 B/s`). Keep the existing detail assertions passing (mock `useServers`/`useServer` as the current test does).

- [ ] **Step 4: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest "src/app/(app)/server/__tests__/detail" && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/server/[id].tsx" "mobile/src/app/(app)/server/__tests__/detail.test.tsx"
git commit -m "feat(mobile): live net + safe-area on server detail"
```

---

## Task 10: Full verification

- [ ] **Step 1: Mobile gates (clean install — CI parity)**
Run: `cd /Users/hg/project/Shepherd/mobile && rm -rf node_modules && npm ci && npx tsc --noEmit && npx eslint . && npx jest --ci`
Expected: `npm ci` exit 0 (no dep change); tsc clean; eslint no errors; all suites pass.

- [ ] **Step 2: Backend/web untouched + hygiene**
Run: `cd /Users/hg/project/Shepherd && go build ./... && (git status --porcelain | grep -i node_modules && echo LEAK || echo clean)`
Expected: build OK; "clean".

---

## Self-Review
- **Spec coverage:** wsURL → T1; wallLive store/conn/useLiveNet → T2; LiveNet → T3; countryFlag/MetricBar/OnlineDot → T4; SafeAreaProvider + Screen → T5; wall home → T6; live WS wired into shell → T7; safe-area rollout → T8; detail live net + Screen → T9; gates → T10. All spec components mapped.
- **Type consistency:** `ServerRow` extended with `public_alias/public_group/country_code` (T6) consumed by the home cards/grouping; `memPct/firstDiskPct/isOnline` reused from existing `metrics.ts`; `bps` reused, `countryFlag` added to `format.ts`; `useWallLiveStore/useLiveNet/useWallLiveConnection` (T2) used by LiveNet (T3), home (T6), shell (T7), detail (T9).
- **Placeholders:** none. The connection is mounted once in `(app)/_layout.tsx` (T7), so home/detail only subscribe — no dual-socket management. The config-editor-style set-state-in-effect trap doesn't arise here (no async-seeded form state).
- **Risk notes:** (1) The live WS is best-effort and public — if it never opens, cards show polled fallback (no error surfaced; acceptable). An opus pass reviews the WS lifecycle (reconnect on baseURL change / app resume, cleanup on logout) + the safe-area/keybar wiring before ship. (2) No new dep → lock unchanged, but T10 still runs `npm ci`. (3) T8 relies on the T5 safe-area jest mock so existing screen tests stay green with zero insets.
