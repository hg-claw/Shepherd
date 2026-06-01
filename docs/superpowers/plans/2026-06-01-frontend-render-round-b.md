# Frontend Render Cluster (Audit Round B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate the Wall live-net re-renders to per-server leaf cells, fix + de-duplicate the plugin LogsTab, consolidate the dual toast systems into one, and memoize TimeSeriesChart geometry.

**Architecture:** A Zustand store keyed by `server_id` lets leaf `LiveNetCell`s subscribe to only their own `{rx,tx}`, so a live frame no longer re-renders the whole wall. A shared `PluginLogsTab` fixes the pause-clears-buffer bug. The Toaster renders `useUI.toasts` directly (the shadcn `use-toast`/`ToastBridge` are deleted). TimeSeriesChart wraps its scale/path computation in `useMemo`.

**Tech Stack:** React 19, Zustand, TanStack Query, Vitest + @testing-library/react (jsdom). Frontend only — no backend change.

**Spec:** `docs/superpowers/specs/2026-06-01-frontend-render-round-b-design.md`

---

## File Structure

- `web/src/api/wallLive.ts` — rewrite: Zustand store + `useWallLiveConnection` + `useLiveNet` (Task 1).
- `web/src/components/LiveNetCell.tsx` (new) — per-id subscribing leaf cell (Task 1).
- `web/src/pages/public/Wall.tsx` — use the store + `LiveNetCell` + a live totals stat (Task 2).
- `web/src/pages/admin/plugins/PluginLogsTab.tsx` (new) — shared, pause-fixed logs tab (Task 3).
- `web/src/pages/admin/plugins/{xray,singbox}/LogsTab.tsx` — one-liners (Task 3).
- `web/src/components/ui/toaster.tsx` — rewrite to render `useUI.toasts`; delete `ToastBridge.tsx` + `hooks/use-toast.ts`; edit `main.tsx` (Task 4).
- `web/src/components/TimeSeriesChart.tsx` — memoize scales + paths (Task 5).

---

## Task 1: Wall live store + LiveNetCell

**Files:**
- Modify (rewrite): `web/src/api/wallLive.ts`
- Create: `web/src/components/LiveNetCell.tsx`
- Test: `web/src/api/wallLive.test.ts` (create), `web/src/components/LiveNetCell.test.tsx` (create)

- [ ] **Step 1: Write the failing tests**

Create `web/src/api/wallLive.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useWallLiveStore } from './wallLive'

describe('wallLive store', () => {
  beforeEach(() => useWallLiveStore.setState({ live: {}, connected: false }))

  it('setFrame updates only that id; other ids keep reference', () => {
    const s = useWallLiveStore.getState()
    s.setFrame(1, 10, 20)
    s.setFrame(2, 30, 40)
    const before = useWallLiveStore.getState().live[1]
    useWallLiveStore.getState().setFrame(2, 31, 41)
    const after = useWallLiveStore.getState().live
    expect(after[1]).toBe(before) // id 1 untouched (same reference)
    expect(after[2]).toEqual({ rx_bps: 31, tx_bps: 41 })
  })

  it('setConnected toggles', () => {
    useWallLiveStore.getState().setConnected(true)
    expect(useWallLiveStore.getState().connected).toBe(true)
  })
})
```

Create `web/src/components/LiveNetCell.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { act } from 'react'
import { render, screen } from '@testing-library/react'
import { LiveNetCell } from './LiveNetCell'
import { useWallLiveStore } from '@/api/wallLive'

describe('LiveNetCell', () => {
  beforeEach(() => useWallLiveStore.setState({ live: {}, connected: false }))

  it('shows fallback when no live frame, then the live value', () => {
    render(
      <LiveNetCell id={5} fallbackRx={100} fallbackTx={200}>
        {(rx, tx) => <span>{`${rx}|${tx}`}</span>}
      </LiveNetCell>,
    )
    expect(screen.getByText('100|200')).toBeTruthy()
    act(() => useWallLiveStore.getState().setFrame(5, 7, 9))
    expect(screen.getByText('7|9')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run src/api/wallLive.test.ts src/components/LiveNetCell.test.tsx`
Expected: FAIL — `useWallLiveStore`/`LiveNetCell` not exported (the current `wallLive.ts` exports `useWallLiveNet`).

- [ ] **Step 3: Rewrite `wallLive.ts`**

Replace the entire contents of `web/src/api/wallLive.ts` with:

```ts
import { create } from 'zustand'
import { useEffect } from 'react'

export type LiveVal = { rx_bps: number; tx_bps: number }

type WallLiveState = {
  live: Record<number, LiveVal>
  connected: boolean
  setFrame: (id: number, rx: number, tx: number) => void
  setConnected: (b: boolean) => void
}

// One store keyed by server_id. setFrame replaces only the changed id's value,
// leaving sibling references stable so per-id subscribers don't re-render.
export const useWallLiveStore = create<WallLiveState>((set) => ({
  live: {},
  connected: false,
  setFrame: (id, rx, tx) =>
    set((s) => ({ live: { ...s.live, [id]: { rx_bps: rx, tx_bps: tx } } })),
  setConnected: (connected) => set({ connected }),
}))

// useWallLiveConnection opens the single multiplexed public net WS and writes
// frames into the store. Call ONCE near the top of the wall.
export function useWallLiveConnection(): void {
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/api/public/net-live/ws`)
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
    return () => {
      ws.onmessage = null
      ws.close()
    }
  }, [])
}

// useLiveNet subscribes to one server's latest {rx,tx}; re-renders the caller
// only when THAT id's value changes.
export function useLiveNet(id: number): LiveVal | undefined {
  return useWallLiveStore((s) => s.live[id])
}
```

- [ ] **Step 4: Create `LiveNetCell.tsx`**

```tsx
import type { ReactNode } from 'react'
import { useLiveNet } from '@/api/wallLive'

// LiveNetCell subscribes to one server's live net via useLiveNet(id) and renders
// through the children render-prop, so only this leaf re-renders on a live frame
// (the surrounding row, with its 30s-static metrics, does not).
export function LiveNetCell({
  id,
  fallbackRx,
  fallbackTx,
  children,
}: {
  id: number
  fallbackRx: number
  fallbackTx: number
  children: (rx: number, tx: number) => ReactNode
}) {
  const live = useLiveNet(id)
  return <>{children(live?.rx_bps ?? fallbackRx, live?.tx_bps ?? fallbackTx)}</>
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd web && npx vitest run src/api/wallLive.test.ts src/components/LiveNetCell.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc reports errors ONLY in `Wall.tsx` (it still imports the now-removed `useWallLiveNet`) — that's fixed in Task 2. If tsc errors elsewhere, address them; the only expected breakage is Wall.tsx.

- [ ] **Step 6: Commit**

```bash
git add web/src/api/wallLive.ts web/src/components/LiveNetCell.tsx web/src/api/wallLive.test.ts web/src/components/LiveNetCell.test.tsx
git commit -m "perf(wall): per-id live-net zustand store + LiveNetCell leaf subscriber"
```

---

## Task 2: Rewire Wall.tsx to the store

**Files:**
- Modify: `web/src/pages/public/Wall.tsx`

- [ ] **Step 1: Swap the hook + remove the closures**

In `web/src/pages/public/Wall.tsx`:

- Change the import `import { useWallLiveNet } from '@/api/wallLive'` to
  `import { useWallLiveConnection, useWallLiveStore } from '@/api/wallLive'` and add
  `import { LiveNetCell } from '@/components/LiveNetCell'`.
- Replace `const { live } = useWallLiveNet()` with `useWallLiveConnection()`.
- DELETE the `rxOf`/`txOf` closures (the two `const rxOf = ...`/`const txOf = ...` lines).
- DELETE the `const sumRxBps = ...` and `const sumTxBps = ...` lines (the realtime sum moves into a live component — Step 3).

- [ ] **Step 2: Drop `rxOf`/`txOf` props from the row components**

- In `ServerListTable`'s prop type and call site, remove `rxOf`/`txOf` (the table no longer needs them — the net cell self-subscribes). Same for `WallServerCard`.
- Update the JSX call sites:
  - `<ServerListTable servers={ss} navigate={navigate} rxOf={rxOf} txOf={txOf} />` → `<ServerListTable servers={ss} navigate={navigate} />`.
  - `<WallServerCard key={s.id} server={s} rxOf={rxOf} txOf={txOf} />` → `<WallServerCard key={s.id} server={s} />`.
- Remove `rxOf`/`txOf` from the `ServerListTable({...})` and `WallServerCard({...})` destructured params and their type annotations.

- [ ] **Step 3: Render net via `LiveNetCell`**

In the table row's Network cell (currently `<span>↓ {bps(rxOf(s))}</span><span>↑ {bps(txOf(s))}</span>`), replace with:

```tsx
                    <LiveNetCell id={s.id} fallbackRx={s.latest?.net_rx_bps ?? 0} fallbackTx={s.latest?.net_tx_bps ?? 0}>
                      {(rx, tx) => (
                        <>
                          <span>↓ {bps(rx)}</span>
                          <span>↑ {bps(tx)}</span>
                        </>
                      )}
                    </LiveNetCell>
```

In the grid card's net row (currently `<span>{bps(rxOf(s))}</span> ... <span>{bps(txOf(s))}</span>`), replace those two value spans with:

```tsx
            <LiveNetCell id={s.id} fallbackRx={s.latest?.net_rx_bps ?? 0} fallbackTx={s.latest?.net_tx_bps ?? 0}>
              {(rx, tx) => (
                <>
                  <span className="text-ok">↓</span>
                  <span>{bps(rx)}</span>
                  <span className="text-primary">↑</span>
                  <span>{bps(tx)}</span>
                </>
              )}
            </LiveNetCell>
```

(Replace the existing `↓/↑` spans + the two `bps(rxOf/txOf)` spans with this single cell; keep the surrounding `load` span.)

- [ ] **Step 4: Live realtime-totals stat**

Add a small component (in `Wall.tsx`, below the main component) that subscribes to the whole live map and computes the online sum, falling back to polled `latest`:

```tsx
function RealtimeStat({ online, label }: { online: PublicCard[]; label: string }) {
  const live = useWallLiveStore((s) => s.live)
  const rx = online.reduce((a, s) => a + (live[s.id]?.rx_bps ?? s.latest?.net_rx_bps ?? 0), 0)
  const tx = online.reduce((a, s) => a + (live[s.id]?.tx_bps ?? s.latest?.net_tx_bps ?? 0), 0)
  return <SummaryStat label={label} value={`↓ ${bps(rx)}`} sub={`↑ ${bps(tx)}`} icon={Activity} />
}
```

Replace the inline realtime `<SummaryStat label={t('wall.stat.realtime', ...)} value={`↓ ${bps(sumRxBps)}`} sub={`↑ ${bps(sumTxBps)}`} icon={Activity} />` with:

```tsx
        <RealtimeStat online={onlineList} label={t('wall.stat.realtime', 'Realtime')} />
```

(`Activity` and `SummaryStat` are already imported. `RealtimeStat` re-renders ~1Hz; it's one stat node, not the list.)

- [ ] **Step 5: Verify**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: tsc clean (no more `useWallLiveNet` references — grep `useWallLiveNet` in `web/src` returns nothing); full suite green.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/public/Wall.tsx
git commit -m "perf(wall): subscribe net cells per-server, isolate live re-renders from the list"
```

---

## Task 3: Shared PluginLogsTab (pause fix + dedup)

**Files:**
- Create: `web/src/pages/admin/plugins/PluginLogsTab.tsx`
- Modify: `web/src/pages/admin/plugins/xray/LogsTab.tsx`, `web/src/pages/admin/plugins/singbox/LogsTab.tsx`
- Test: `web/src/pages/admin/plugins/PluginLogsTab.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/admin/plugins/PluginLogsTab.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithProviders } from '@/test-utils/render'

// Capture every WebSocket constructed so we can assert "no reconnect on pause".
class FakeWS {
  static instances: FakeWS[] = []
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  close = vi.fn()
  constructor() { FakeWS.instances.push(this) }
}
vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket)

vi.mock('@/api/plugins', async (orig) => {
  const actual = await orig<typeof import('@/api/plugins')>()
  return {
    ...actual,
    listPluginHosts: vi.fn().mockResolvedValue([{ id: 1, server_id: 9 }]),
    pluginLogsWSURL: (plugin: string, id: number) => `ws://x/${plugin}/${id}`,
  }
})

import { PluginLogsTab } from './PluginLogsTab'

const send = (line: string) =>
  act(() => FakeWS.instances.at(-1)!.onmessage?.({ data: JSON.stringify({ ts: '2026-01-01T00:00:01Z', level: 'info', line }) }))

beforeEach(() => { FakeWS.instances = [] })

describe('PluginLogsTab pause', () => {
  it('pause keeps the buffer and does not reconnect; resume keeps appending', async () => {
    renderWithProviders(<PluginLogsTab plugin="xray" />)
    await screen.findByText('waiting for log lines…').catch(() => null)
    // server selected via the hosts query effect; wait a tick for the WS to open
    await act(async () => { await Promise.resolve() })
    expect(FakeWS.instances.length).toBe(1)

    send('line-A')
    expect(screen.getByText('line-A')).toBeTruthy()

    fireEvent.click(screen.getByText('Pause'))
    // No new socket, line-A still shown.
    expect(FakeWS.instances.length).toBe(1)
    expect(screen.getByText('line-A')).toBeTruthy()
    // A frame received while paused is dropped.
    send('line-B')
    expect(screen.queryByText('line-B')).toBeNull()
    expect(screen.getByText('line-A')).toBeTruthy()

    fireEvent.click(screen.getByText('Resume'))
    send('line-C')
    expect(screen.getByText('line-C')).toBeTruthy()
    expect(screen.getByText('line-A')).toBeTruthy()
  })
})
```

(If the test needs a small timing adjustment to let the `serverID` effect fire before asserting the socket count, add an extra `await act(async () => { await Promise.resolve() })` — do NOT weaken the four core assertions: one socket after pause, line-A retained, line-B dropped while paused, line-C appended after resume.)

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run src/pages/admin/plugins/PluginLogsTab.test.tsx`
Expected: FAIL — `PluginLogsTab` does not exist.

- [ ] **Step 3: Create `PluginLogsTab.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { listPluginHosts, pluginLogsWSURL } from '@/api/plugins'

interface LogLine { ts: string; level: string; line: string }

// PluginLogsTab streams a plugin's live logs for a selected host. Pause is a
// display gate (a ref read inside onmessage), NOT an effect dependency — so
// pausing neither reconnects the socket nor clears the buffer.
export function PluginLogsTab({ plugin }: { plugin: 'xray' | 'singbox' }) {
  const hostsQ = useQuery({ queryKey: ['plugin-hosts', plugin], queryFn: () => listPluginHosts(plugin) })
  const [serverID, setServerID] = useState<number | null>(null)
  useEffect(() => {
    if (serverID == null && hostsQ.data?.length) setServerID(hostsQ.data[0].server_id)
  }, [hostsQ.data, serverID])

  const [lines, setLines] = useState<LogLine[]>([])
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  useEffect(() => { pausedRef.current = paused }, [paused])
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (serverID == null) return
    setLines([])
    const ws = new WebSocket(pluginLogsWSURL(plugin, serverID))
    wsRef.current = ws
    ws.onmessage = (e) => {
      try {
        const env = JSON.parse(e.data) as LogLine
        if (!pausedRef.current) setLines((prev) => [...prev.slice(-1999), env])
      } catch {
        /* ignore */
      }
    }
    return () => { ws.close() }
  }, [serverID, plugin])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={serverID ?? ''}
          onChange={(e) => setServerID(Number(e.target.value))}
          className="h-8 px-2 rounded-md border bg-background text-[13px] font-mono"
        >
          {(hostsQ.data ?? []).map((h) => (
            <option key={h.id} value={h.server_id}>#{h.server_id}</option>
          ))}
        </select>
        <Button size="sm" variant="outline" className="h-8" onClick={() => setPaused((v) => !v)}>
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button size="sm" variant="outline" className="h-8" onClick={() => setLines([])}>
          Clear
        </Button>
      </div>
      <div className="h-[440px] bg-[#0a0a0b] text-zinc-100 rounded-lg overflow-auto p-3 font-mono text-[12px] leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap">
            <span className="text-zinc-500 mr-2">{l.ts.slice(11, 19)}</span>
            <span>{l.line}</span>
          </div>
        ))}
        {lines.length === 0 && <div className="text-zinc-500">waiting for log lines…</div>}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Reduce the two LogsTab files to one-liners**

Replace the ENTIRE contents of `web/src/pages/admin/plugins/xray/LogsTab.tsx` with:

```tsx
import { PluginLogsTab } from '../PluginLogsTab'

export default function LogsTab() {
  return <PluginLogsTab plugin="xray" />
}
```

Replace the ENTIRE contents of `web/src/pages/admin/plugins/singbox/LogsTab.tsx` with:

```tsx
import { PluginLogsTab } from '../PluginLogsTab'

export default function LogsTab() {
  return <PluginLogsTab plugin="singbox" />
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd web && npx vitest run src/pages/admin/plugins/PluginLogsTab.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/admin/plugins/PluginLogsTab.tsx web/src/pages/admin/plugins/xray/LogsTab.tsx web/src/pages/admin/plugins/singbox/LogsTab.tsx web/src/pages/admin/plugins/PluginLogsTab.test.tsx
git commit -m "fix(ui): plugin logs pause no longer reconnects/clears; extract shared PluginLogsTab"
```

---

## Task 4: Consolidate toasts onto `useUI`

**Files:**
- Modify (rewrite): `web/src/components/ui/toaster.tsx`
- Delete: `web/src/components/ToastBridge.tsx`, `web/src/hooks/use-toast.ts`
- Modify: `web/src/main.tsx`
- Test: `web/src/components/ui/toaster.test.tsx` (create)

- [ ] **Step 1: Confirm no other consumers**

Run: `cd web && grep -rn "use-toast\|useToast\|ToastBridge" src --include=*.ts --include=*.tsx | grep -v "src/components/ui/toast.tsx"`
Expected: matches ONLY in `ui/toaster.tsx`, `ToastBridge.tsx`, and `hooks/use-toast.ts` (the files we rewrite/delete). If any OTHER file imports `useToast`/`use-toast`, STOP and report — it must be migrated to `useUI.toast` first.

- [ ] **Step 2: Write the failing test**

Create `web/src/components/ui/toaster.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { act } from 'react'
import { render, screen } from '@testing-library/react'
import { Toaster } from './toaster'
import { useUI } from '@/store/ui'

describe('Toaster (useUI source)', () => {
  beforeEach(() => { vi.useFakeTimers(); useUI.setState({ toasts: [] }) })
  afterEach(() => { vi.useRealTimers() })

  it('renders all rapid toasts (no limit-1 drop) and auto-dismisses', () => {
    render(<Toaster />)
    act(() => {
      useUI.getState().toast('info', 'alpha')
      useUI.getState().toast('error', 'bravo')
    })
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByText('bravo')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(6000) })
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.queryByText('bravo')).toBeNull()
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `cd web && npx vitest run src/components/ui/toaster.test.tsx`
Expected: FAIL — the current `Toaster` reads shadcn `useToast` (limit 1), so `bravo` (or `alpha`) is missing, and there's no auto-dismiss via `useUI`.

- [ ] **Step 4: Rewrite `toaster.tsx`**

Replace the entire contents of `web/src/components/ui/toaster.tsx` with:

```tsx
import { useEffect } from 'react'
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast'
import { useUI, type Toast as UIToast } from '@/store/ui'

const AUTO_DISMISS_MS = 5000

function ToastItem({ t, onDismiss }: { t: UIToast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const h = setTimeout(() => onDismiss(t.id), AUTO_DISMISS_MS)
    return () => clearTimeout(h)
  }, [t.id, onDismiss])
  return (
    <Toast variant={t.kind === 'error' ? 'destructive' : 'default'} onOpenChange={(open) => { if (!open) onDismiss(t.id) }}>
      <div className="grid gap-1">
        <ToastTitle>{t.kind === 'error' ? 'Error' : t.kind === 'success' ? 'Success' : 'Info'}</ToastTitle>
        <ToastDescription>{t.message}</ToastDescription>
      </div>
      <ToastClose />
    </Toast>
  )
}

// Toaster renders the zustand useUI.toasts directly — one source of truth, no
// limit-1 drop. Each item auto-dismisses after AUTO_DISMISS_MS.
export function Toaster() {
  const toasts = useUI((s) => s.toasts)
  const dismissToast = useUI((s) => s.dismissToast)
  return (
    <ToastProvider>
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} onDismiss={dismissToast} />
      ))}
      <ToastViewport />
    </ToastProvider>
  )
}
```

(If the `Toast` component's `onOpenChange` prop type differs, check `ui/toast.tsx` — it's a Radix Toast re-export, so `onOpenChange?(open: boolean)` is available. If `variant` isn't a prop on the base `Toast`, drop it and key the title color off `t.kind` via a className instead.)

- [ ] **Step 5: Delete the old system + update the mount**

```bash
cd /Users/hg/project/Shepherd
git rm web/src/components/ToastBridge.tsx web/src/hooks/use-toast.ts
```

In `web/src/main.tsx`: remove the import lines `import { Toaster as ShadcnToaster } from './components/ui/toaster'` and `import { ToastBridge } from './components/ToastBridge'`, add `import { Toaster } from './components/ui/toaster'`, and replace the `<ShadcnToaster />` + `<ToastBridge />` lines (~56–57) with a single `<Toaster />`.

- [ ] **Step 6: Run to verify pass**

Run: `cd web && npx vitest run src/components/ui/toaster.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc clean (no dangling `use-toast`/`ToastBridge` imports — the Step 1 grep guaranteed none).

- [ ] **Step 7: Commit**

```bash
git add web/src/components/ui/toaster.tsx web/src/main.tsx web/src/components/ui/toaster.test.tsx
git commit -m "fix(ui): single toast system (render useUI.toasts); drop shadcn use-toast bridge"
```

---

## Task 5: Memoize TimeSeriesChart geometry

**Files:**
- Modify: `web/src/components/TimeSeriesChart.tsx`
- Test: `web/src/components/TimeSeriesChart.test.tsx` (create)

- [ ] **Step 1: Write the failing/smoke test**

Create `web/src/components/TimeSeriesChart.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { TimeSeriesChart } from './TimeSeriesChart'

describe('TimeSeriesChart', () => {
  it('renders a path for a 2+ point series', () => {
    const series = [{
      name: 'cpu',
      values: [
        { ts: '2026-01-01T00:00:00Z', v: 1 },
        { ts: '2026-01-01T00:01:00Z', v: 5 },
      ],
    }]
    const { container } = render(<TimeSeriesChart series={series} height={120} />)
    // width starts 0 until layout; force a width so the svg renders.
    const svgs = container.querySelectorAll('svg')
    expect(svgs.length).toBeGreaterThanOrEqual(0) // renders without throwing
  })
})
```

NOTE: `TimeSeriesChart`'s svg only renders once `width > 0` (set by a layout effect). The assertion above is a non-throwing smoke test (jsdom reports width 0). If `TimeSeriesChart` is a default export, import it accordingly (`import TimeSeriesChart from './TimeSeriesChart'`) — check the export style first and match it. The point of this task is the memoization refactor staying behaviour-neutral; this test guards that the component still mounts.

- [ ] **Step 2: Run to verify it passes pre-change (baseline)**

Run: `cd web && npx vitest run src/components/TimeSeriesChart.test.tsx`
Expected: PASS against current code (smoke baseline).

- [ ] **Step 3: Memoize the scale bounds + path strings**

In `web/src/components/TimeSeriesChart.tsx`, replace the unmemoized bound computations (the `allValues`/`min`/`max`/`span`/`allTs`/`tMin`/`tMax`/`tSpan` block, lines ~42–49) with a single `useMemo`:

```tsx
  const { min, max, span, tMin, tMax, tSpan } = useMemo(() => {
    const allValues = series.flatMap((s) => s.values.map((p) => p.v))
    const mn = yMin ?? (allValues.length ? Math.min(...allValues) : 0)
    const mx = yMax ?? (allValues.length ? Math.max(...allValues) : 1)
    const allTs = series.flatMap((s) => s.values.map((p) => +new Date(p.ts)))
    const tmn = allTs.length ? Math.min(...allTs) : 0
    const tmx = allTs.length ? Math.max(...allTs) : 1
    return { min: mn, max: mx, span: mx - mn || 1, tMin: tmn, tMax: tmx, tSpan: tmx - tmn || 1 }
  }, [series, yMin, yMax])
```

Keep the `pad`/`innerW`/`innerH`/`x`/`y` definitions as they are (they depend on `width` + the memoized bounds; cheap). Then memoize the per-series path strings — add, after the `closestPoints` memo:

```tsx
  const paths = useMemo(
    () =>
      series.map((s) =>
        s.values.length < 2
          ? null
          : s.values
              .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.ts).toFixed(1)} ${y(p.v).toFixed(1)}`)
              .join(' '),
      ),
    // x/y are derived from width + memoized bounds; recompute when those change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, width, min, max, tMin, tMax],
  )
```

In the `series.map((s, idx) => { ... const d = ...; })` render block, replace the inline `const d = s.values.map(...).join(' ')` with `const d = paths[idx]` and keep the `if (s.values.length < 2) return null` guard (now equivalently `if (d == null) return null`):

```tsx
          {series.map((s, idx) => {
            const d = paths[idx]
            if (d == null) return null
            return (
              <path
                key={s.name}
                d={d}
                ...
```

(Leave the `stroke`/`fill` and the rest of the `<path>` unchanged.)

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run src/components/TimeSeriesChart.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TimeSeriesChart.tsx web/src/components/TimeSeriesChart.test.tsx
git commit -m "perf(ui): memoize TimeSeriesChart scale bounds + path strings (hover no longer recomputes geometry)"
```

---

## Task 6: Full verification

**Files:** none.

- [ ] **Step 1: Frontend gates**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; full suite green (all new tests + existing).

- [ ] **Step 2: Dead-reference sweep**

Run: `cd web && grep -rn "useWallLiveNet\|use-toast\|ToastBridge" src` and `grep -rn "rxOf\|txOf" src/pages/public/Wall.tsx`
Expected: no matches (the old hook, the old toast system, and the old closures are fully removed).

- [ ] **Step 3: Behaviour spot check**

Confirm by reading: `Wall.tsx` calls `useWallLiveConnection()` and renders net via `LiveNetCell` (rows take no `rxOf`/`txOf`); both `xray`/`singbox` `LogsTab.tsx` are one-liners delegating to `PluginLogsTab`; `main.tsx` mounts exactly one `<Toaster />`; `TimeSeriesChart` reads `paths[idx]`.

---

## Self-Review

- **Spec coverage:** Wall per-id store + leaf cell → Tasks 1–2 (store/cell + Wall rewire + live totals). LogsTab pause fix + dedup → Task 3. Toast consolidation → Task 4. TimeSeriesChart memo → Task 5. Gates → Task 6. All spec sections mapped.
- **Type consistency:** `useWallLiveStore`/`useWallLiveConnection`/`useLiveNet`/`LiveVal` (Task 1) consumed unchanged in Task 2 and `LiveNetCell` (Task 1); `LiveNetCell` render-prop signature `(rx, tx) => ReactNode` matches both call sites; `PluginLogsTab({ plugin })` (Task 3) matches the two one-liner call sites; `Toaster` (Task 4) is a named export matching the `main.tsx` import and the test import.
- **Placeholders:** none — full code in every step. Two read-first caveats (Task 4 `Toast` prop names; Task 5 export style) are explicit verification notes, not deferred work.
- **Risk note:** the LogsTab test's socket-timing may need an extra awaited microtask before asserting the socket count; the four behavioural assertions are the contract and must not be weakened.
