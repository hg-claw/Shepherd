# Mobile app — R7: wall-style home + live traffic + safe-area — Design

**Date:** 2026-06-08
**Status:** Approved (scope confirmed via Q&A)
**Initiative:** Expo mobile app for Shepherd (`mobile/`). Roadmap: R1–R6 shipped
(v0.23.0–v0.28.0). **R7 (this spec)** is a follow-up polish round addressing three
gaps the user flagged: 全面屏兼容 (safe-area) not done, 实时流量 (live traffic) not
done, and the home should follow the web **public wall** form.

## Goal

Rebuild the mobile home into the web "wall" form — grouped server cards with a
summary strip — wire **live network traffic** via the existing public
multiplexed WebSocket, and make every screen **safe-area aware** (notch / status
bar / home indicator). No backend change.

## Confirmed decisions

- **Live-traffic source: reuse the public multiplexed WS** `/api/public/net-live/ws`
  (one connection, frames `{server_id, ts, rx_bps, tx_bps}`, no auth — same as the
  web wall). Servers not opted into the public wall fall back to the 5s-polled
  `latest.net_rx_bps/tx_bps`. (Rejected: per-server admin WS = N sockets; a new
  backend admin multiplexed WS = backend work, out of this round's scope.)
- **Home form: single-column cards + grouping + summary strip** (mobile-friendly).
  No cumulative-traffic stat/column (would need an extra `/api/servers/{id}/traffic`
  call per server). No list/grid toggle. No netquality.
- **Safe-area is a non-negotiable fix** bundled into this round via a reusable
  `Screen` wrapper + a root `SafeAreaProvider`.

## Headless constraint
Verify with `tsc --noEmit` + `eslint` + `jest`. The real notch insets and the live
WS stream are device-only; an opus pass reviews the WS lifecycle (connect/reconnect/
cleanup) and the safe-area wiring before ship.

## Backend reuse (no change) — confirmed shapes

- `GET /api/servers?with=latest` (bearer) already returns, per row:
  `id, name, public_alias, public_group, country_code, agent_os, agent_arch,
  agent_last_seen, connected, latest:{ts, cpu_pct, mem_used, mem_total, load_1,
  net_rx_bps, net_tx_bps, tcp_conn, disks_json}}`. So `mem_pct` =
  `mem_used/mem_total*100` and `disks_pct[]` (parse `disks_json` =
  `[{mount,used,total}]`) are computed CLIENT-SIDE; grouping uses `public_group`;
  alias = `public_alias || name`.
- `GET /api/public/net-live/ws` — **public** (no bearer), multiplexed, pushes
  `{server_id, ts, rx_bps, tx_bps}` ~1/s for servers with `show_on_public=true`.
  IDs are the same `servers.id` as the admin list.

---

## Components

### Part A — Safe-area

#### 1. Root `SafeAreaProvider` — `src/app/_layout.tsx` (modify)
Wrap the existing tree in `<SafeAreaProvider>` (from `react-native-safe-area-context`,
already a dependency). The loading view and `<Stack>` render inside it.

#### 2. `src/components/Screen.tsx` (new)
A reusable screen wrapper that pads for insets:
```tsx
// <Screen> applies top+bottom safe-area insets and the app background, so screens
// don't have to repeat the boilerplate. edges defaults to top+bottom; a screen with
// its own scroll can pass edges={['top']} and pad the bottom itself.
export function Screen({ children, edges = ['top', 'bottom'] }: { children: React.ReactNode; edges?: ('top' | 'bottom')[] }): JSX.Element
// impl: const i = useSafeAreaInsets(); <View style={{ flex:1, backgroundColor: theme.bg,
//   paddingTop: edges.includes('top') ? i.top : 0, paddingBottom: edges.includes('bottom') ? i.bottom : 0 }}>{children}</View>
```
Apply `<Screen>` as the root of each authed screen: home, `server/[id]`,
`console/[id]`, files (browser + preview), scripts (list/form/run), plugins
(list/detail/config/hosts), settings. The **console** screen wraps its body with
`edges={['top']}` and keeps the keybar above the bottom inset (pass the inset into
the keybar padding) so keys aren't under the home indicator. `LockScreen` already
uses a full-screen `Modal`; give its inner `View` top/bottom inset padding too.

### Part B — Live traffic

#### 3. `src/lib/wsurl.ts` (new) — generic ws URL helper
```ts
// wsURL turns the https/http baseURL + a path into a ws/wss URL.
export function wsURL(baseURL: string, path: string): string
// https://h → wss://h+path ; http://h → ws://h+path
```
(The R4 console has a route-specific `consoleWSURL`; this is the generic sibling.)

#### 4. `src/api/wallLive.ts` (new) — port of the web store
```ts
export type LiveVal = { rx_bps: number; tx_bps: number }
// zustand store keyed by server_id; setFrame replaces only the changed id's value
// (stable sibling refs → per-id subscribers don't re-render).
export const useWallLiveStore = create<{
  live: Record<number, LiveVal>; connected: boolean
  setFrame: (id: number, rx: number, tx: number) => void
  setConnected: (b: boolean) => void
}>(...)
// Opens the single public multiplexed WS from the auth store's baseURL and writes
// frames into the store. Call ONCE near the top of the wall. Closes on unmount.
export function useWallLiveConnection(): void
// Subscribes to one server's latest {rx,tx}; re-renders only when THAT id changes.
export function useLiveNet(id: number): LiveVal | undefined
```
`useWallLiveConnection` reads `baseURL` from `useAuth.getState()`, builds
`wsURL(baseURL, '/api/public/net-live/ws')`, opens a `WebSocket`, sets `connected`,
parses each message `{server_id, rx_bps, tx_bps}` → `setFrame`, and on cleanup nulls
the handler + closes. Malformed frames are ignored. (No bearer — the endpoint is
public.) The connection is best-effort: if the WS never opens, cards just show the
polled fallback.

#### 5. `src/components/LiveNet.tsx` (new) — render-prop live cell
```tsx
// Subscribes to one server's live net via useLiveNet(id); renders through children
// so only this leaf re-renders on a frame. Falls back to the polled values.
export function LiveNet({ id, fallbackRx, fallbackTx, children }:
  { id: number; fallbackRx: number; fallbackTx: number; children: (rx: number, tx: number) => React.ReactNode }): JSX.Element
```

### Part C — Wall home

#### 6. Metric helpers — `src/lib/metrics.ts` (new) or extend `src/api/metrics.ts`
```ts
export function memPctOf(p: Point | null): number | null   // mem_used/mem_total*100
export function disksPctOf(p: Point | null): number[]      // parse disks_json → pct[]
export function countryFlag(code?: string | null): string  // ISO-2 → 🇺🇸 emoji, '' if absent
```
(`memPct` may already exist in `src/api/metrics.ts` — reuse/rename consistently.)

#### 7. Small UI atoms — `src/components/MetricBar.tsx`, `src/components/OnlineDot.tsx` (new)
- `MetricBar({ label, value }: { label: string; value: number | null })` — a labeled
  horizontal bar; tints warn ≥80, err ≥92 (mirror the web thresholds), dim when null.
- `OnlineDot({ online }: { online: boolean })` — a small green/grey dot.

#### 8. `src/app/(app)/index.tsx` (rewrite) — the wall
- `const q = useServers()` (existing 5s poll); `useWallLiveConnection()` once.
- Derive per row: `online = row.connected`, `alias = public_alias || name`,
  `group = public_group || ''`, `platform = agent_os`, `arch = agent_arch`,
  `mem = memPctOf(latest)`, `disks = disksPctOf(latest)`.
- **Summary strip** (a wrap row of stat chips): Nodes (total), Online, Offline,
  **Realtime** (`↓ bps(Σ live.rx ?? latest.net_rx_bps) ↑ …` over online servers).
- **Grouping:** build `Map<group, rows[]>`, sort group keys; each group renders a
  header (`group || 'Ungrouped'` + `online/total`) then its cards (online-first,
  then alias-sorted).
- **Card** (`ServerCard`): header row = `OnlineDot` + `countryFlag` + alias (+ `platform·arch`);
  if online+latest: `MetricBar CPU/MEM/DSK`, a net row `<LiveNet>↓{bps} ↑{bps}</LiveNet>`
  + `load`; else a dim `offline`. Whole card `Pressable` → `router.push('/(app)/server/'+id)`.
- Header bar (inside `<Screen>`): title "Servers" + `onlineCount/total` + Plugins /
  Settings / Log out (unchanged entries).
- Loading / error / empty states preserved.

#### 9. `src/app/(app)/server/[id].tsx` (modify) — live net on detail
Where the detail shows the network reading, wrap it in `<LiveNet id={id} …>` so it
updates live from the same store (the wall connection persists while navigating
within the `(app)` group; if the detail can be reached without mounting the wall,
call `useWallLiveConnection()` here too — it's idempotent per the store, but to keep
one socket, gate it: only open if not already `connected`).

---

## Data flow
```
home mounts → useWallLiveConnection() opens wss://baseURL/api/public/net-live/ws (public)
  WS frame {server_id,rx,tx} → wallLiveStore.setFrame → useLiveNet(id) re-renders that card's LiveNet only
useServers() 5s poll → rows (name/group/country/agent/latest) → grouped cards + summary
  card LiveNet shows live rx/tx, falls back to latest.net_*_bps when no frame yet / non-public server
tap card → (app)/server/[id] (live net via same store)
SafeAreaProvider (root) + <Screen> insets on every screen
```

## Testing (jest, headless)
- **`wsURL`**: https→wss, http→ws, path appended.
- **`wallLive`** (mock global `WebSocket`): `setFrame` updates one id and leaves
  siblings ref-stable; `useLiveNet` returns that id's value; `useWallLiveConnection`
  opens the URL from the auth store, an incoming message calls `setFrame`, cleanup
  closes. (Mirror the web `wallLive.test`.)
- **metrics**: `memPctOf` (used/total, null when missing), `disksPctOf` (parse
  `disks_json`, skip total=0), `countryFlag` ('US'→🇺🇸, ''/undefined→'').
- **`MetricBar`/`OnlineDot`**: render + threshold tint (value 85→warn, 95→err).
- **wall home** (mock `useServers` + `useLiveNet` + `useWallLiveConnection` noop):
  renders grouped cards with the summary counts; online sorts before offline; a card
  with a live frame shows the live bps over the fallback; tapping a card pushes the
  detail route; empty/error states.
- **safe-area**: `Screen` applies insets (render within `SafeAreaProvider`/mocked
  `useSafeAreaInsets`); home renders inside it.

## Out of scope
- Cumulative traffic bytes (stat or column) — needs per-server `/traffic` calls.
- list/grid view toggle; netquality (RTT/loss) cells; per-group collapse.
- A new backend admin multiplexed live-net WS (kept the public one).

## Verification gates
`cd mobile && npx tsc --noEmit && npx eslint . && npx jest` green; lock unchanged
(no new dep — `react-native-safe-area-context` already present); backend + web
untouched (`go build ./...`). **Manual (user, dev build):** on a notched device,
confirm headers/keybar clear the notch + home indicator; watch the home cards'
↓↑ update ~once/second live; tap into a server and see its net update live. Ship as
**v0.29.0**.
