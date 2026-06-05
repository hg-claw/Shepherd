# Mobile app — R3: server list + monitoring — Design

**Date:** 2026-06-04
**Status:** Approved (scope confirmed via Q&A)
**Initiative:** Expo mobile app for Shepherd (`mobile/`). Roadmap: R1 token-auth ✅
(v0.23.0) → R2 skeleton+login ✅ (v0.24.0) → **R3 server list + monitoring (this
spec)** → R4 remote terminal → R5 files+scripts → R6 plugins+push. Each round is
its own spec → plan → PR → release.

## Goal

Replace R2's placeholder Home with a live server list (online state + key
telemetry), and add a per-server detail screen. Introduce the data layer
(TanStack Query over R2's `apiFetch`) and wire the deferred R2 item:
**401 → clearSession** so an expired token bounces to login.

## Headless constraint

No simulator. Verify with `tsc --noEmit` + `eslint` + `jest`
(@testing-library/react-native `render`/`renderHook` run under Node). Pure helpers
+ the data hooks + screen renders are unit-tested; device smoke-test is the user's
manual step.

## Backend reuse (no backend change)

`GET /api/servers?with=latest` (admin, bearer) returns the **raw** wrapped shape:
```
[{ id, name, public_alias, public_group, country_code, show_on_public,
   agent_os, agent_arch, agent_last_seen, ...,
   latest: { ts, cpu_pct?, mem_used?, mem_total?, load_1?, net_rx_bps?, net_tx_bps?,
             tcp_conn?, disks_json? } | null,
   connected: bool }]
```
The mobile app computes `mem_pct` from `mem_used/mem_total` and parses `disks_json`
(a JSON string) itself — distinct from the public wall's pre-computed `disks_pct`.

---

## Components

### 1. `src/api/authed.ts` — store-aware fetch + 401 handling
The single entry point for authenticated requests. Reads `baseURL`+`token` from the
auth store, delegates to R2's `apiFetch`, and on `APIError(401)` calls
`clearSession()` (so the routing gate bounces to login) before re-throwing:
```ts
import { apiFetch, APIError } from './client'
import { useAuth } from '../store/auth'

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
This closes the R2 review's carry-forward (#1): authed reads now invalidate the
session on 401.

### 2. `src/api/servers.ts` — types + query hooks
```ts
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
export function useServers(): UseQueryResult<ServerRow[]>   // queryKey ['servers'], authedFetch('/api/servers?with=latest'), refetchInterval 5000
export function useServer(id: number): ServerRow | undefined // selects from the ['servers'] cache
```
- `useServers`: `refetchInterval: 5000`, `refetchOnWindowFocus: true` (mobile:
  AppState foreground), staleTime 2s.
- `useServer(id)`: derives from the cached list (no extra endpoint) via
  `useServers().data?.find(s => s.id === id)`.

### 3. `src/api/metrics.ts` — pure helpers
```ts
export function memPct(p: Point | null): number | null        // mem_used/mem_total*100, null if absent
export function firstDiskPct(disksJSON?: string): number | null // defensive parse of disks_json; null on any failure
export function isOnline(row: ServerRow): boolean             // connected || agent_last_seen within ~90s
```
`firstDiskPct` parses `disks_json` (best-effort: expects an array of disk objects
with usable/used+total or a percent; returns the first disk's used% or null). It
must never throw.

### 4. Query provider — `app/_layout.tsx`
Wrap the existing auth-gated layout in a `QueryClientProvider` (one `QueryClient`
created once). The `restore()`/spinner/`Stack` logic from R2 is unchanged inside.

### 5. Screens
- **`app/(app)/index.tsx`** (replaces the R2 placeholder Home): the server list.
  - `FlatList` of cards: name, online dot (`isOnline`), CPU% + MEM% (small bars or
    `nn%`), net `↓ rx ↑ tx` (bps formatted). Offline rows dim + show "—".
  - Sorted online-first then by name. A header strip: total / online / offline.
  - Pull-to-refresh (`refetch`), loading spinner, error text (with the API error
    message). Tap a row → `/(app)/server/[id]`.
  - A small header action for Logout (and a hook point for future Settings).
- **`app/(app)/server/[id].tsx`** (new dynamic route): one server's detail —
  name + online; current CPU%, MEM (used/total + %), first disk %, net ↓↑,
  load_1, tcp_conn, OS·arch, last-seen relative time. Reads `useServer(id)`. If the
  id isn't in the cache (deep link / cold), show a spinner while `useServers`
  loads, then "not found" if still absent. **No history chart in R3.**

### 6. `src/lib/format.ts` — small formatters
`bps(n)` (bytes/s → "x.x MB/s"), `pct(n)` ("nn%"), `relTime(iso)` ("3m ago").
(Mirrors the web's `bps`/`bytes` intent; kept tiny.)

---

## Data flow
```
(app) screens → useServers() → authedFetch('/api/servers?with=latest')
  → apiFetch(baseURL, token, ...) → 200 rows → cache (poll 5s)
  → 401 → clearSession() → routing gate → (auth)/login
row tap → router push /(app)/server/123 → useServer(123) from cache
```

## Testing (jest, headless)
- **`metrics`**: `memPct` (computes %, null on missing), `firstDiskPct` (parses a
  valid disks_json, returns null on malformed/empty/`undefined` — never throws),
  `isOnline` (connected → true; recent last_seen → true; stale → false).
- **`format`**: `bps`/`pct`/`relTime` basic cases.
- **`authed`** (mock `./client` + the store): a 200 returns the body; a 401 calls
  `clearSession` then re-throws `APIError(401)`; a non-401 error re-throws WITHOUT
  clearing the session; missing baseURL → throws without calling fetch.
- **`useServers`** (mock `authedFetch`, `renderHook` + a `QueryClientProvider`
  wrapper): resolves to the rows; surfaces the error state on rejection.
- **list screen** (mock `useServers`): renders given rows (a name visible, an
  offline row shows "—"); empty state; error state.
- **detail screen** (mock `useServer`): renders the metrics for a given row;
  "not found" when the id is absent.

## Out of scope
- Historical telemetry charts / live-net WS (later); files/scripts (R5); terminal
  (R4); push/biometrics (R6); server create/delete/install actions (admin-write
  flows are a later round); search/filter beyond online-first sort.

## Verification gates
`cd mobile && npx tsc --noEmit && npx eslint . && npx jest` green; backend + web
untouched (their CI stays green). **Manual (user):** `npx expo start`, log in, see
the live list update, open a server's detail.
