# Mobile app — R6: plugins + biometric app lock — Design

**Date:** 2026-06-07
**Status:** Approved (scope confirmed via Q&A)
**Initiative:** Expo mobile app for Shepherd (`mobile/`). Roadmap: R1 token-auth ✅
(v0.23.0) → R2 skeleton ✅ (v0.24.0) → R3 list+monitoring ✅ (v0.25.0) → R4 terminal
✅ (v0.26.0) → R5 files+scripts ✅ (v0.27.0) → **R6 plugins + biometric lock (this
spec)**. Push notifications were scoped OUT of R6 (deferred to a future R7 — they
need a new backend: a device-token table, an event→Expo-push dispatcher, and
agent online/offline event emission that doesn't exist yet, and delivery is
unverifiable headlessly).

## Goal

Two features in the app: a **plugin management UI** (list/enable/disable, edit
config, and per-host deployment lifecycle) over the existing admin plugins API,
and an **opt-in biometric app lock** that gates entry to the app behind Face
ID / Touch ID / fingerprint. Reuses R3's `authedFetch` + TanStack Query. The
plugins half needs **no backend change**; the lock adds one Expo native module.

## Confirmed decisions

- **Push deferred** to R7 — out of scope here.
- **Plugins depth: global layer + host deployment management.** List, enable/
  disable, view+edit JSON config, and — for `host_aware` plugins — per-host
  deploy/undeploy/start/stop/restart/status-refresh. **No** host log-stream WS
  (that was the only larger option declined).
- **Lock trigger: cold-start + background-return, opt-in toggle.** A Settings
  switch (default off; enableable only when biometric hardware is present and
  enrolled). When on: biometric prompt on cold start (process rebuild) and when
  returning to the foreground after >30s in the background. Failure stays on the
  lock screen with a retry; an explicit "Sign out" is offered. Device-passcode is
  the OS-level fallback (`expo-local-authentication` default).

## Headless constraint
Verify with `tsc --noEmit` + `eslint` + `jest` (RN logic + screen renders via
@testing-library/react-native). The actual Face ID/Touch ID prompt and the real
`AppState` background→foreground transition are **device-only** — the user
smoke-tests on a dev build. Because the lock spans the RN↔native↔AppState
boundary (the class of bug headless tests miss — see R4/R5), an opus end-to-end
review of the lock wiring runs before ship.

## Backend reuse (no change) — plugins API

Confirmed shapes (`internal/api/plugins.go`, `internal/plugins/store.go`):
- `GET /api/admin/plugins` → `manifestEntry[]`:
  `{id, meta:{name,description,icon,category,host_aware}, enabled, enabled_at?, host_count?}`.
- `POST /api/admin/plugins/{id}/enable` → `{enabled:true}`;
  `POST /api/admin/plugins/{id}/disable` → `{enabled:false}`.
- `GET /api/admin/plugins/{id}/config` → arbitrary JSON object (secrets redacted
  as `"***"`); `PUT /api/admin/plugins/{id}/config` body = JSON object → `{ok:true}`
  (a field sent back as `"***"` preserves the stored secret).
- Host-aware (only when `meta.host_aware`):
  - `GET /api/admin/plugins/{id}/hosts` → `hostRow[]`:
    `{id, plugin_id, server_id, deployed_version?, status, last_error?, updated_at, config}`
    where `status ∈ {pending,deploying,running,failed,stopped}`.
  - `POST /api/admin/plugins/{id}/hosts` body `{server_id, version?, config?}` →
    `hostRow` (async; returns `status:"deploying"`).
  - `GET /api/admin/plugins/{id}/hosts/{server_id}` → `hostRow`.
  - `DELETE /api/admin/plugins/{id}/hosts/{server_id}` → `{ok:true}`.
  - `POST /api/admin/plugins/{id}/hosts/{server_id}/start|stop|restart` → `{status}`.
  - `GET /api/admin/plugins/{id}/hosts/{server_id}/refresh-status` → `hostRow`.

(The plugin-events audit endpoint and the host-logs WS exist but are out of scope.)

## New mobile dependency
- `expo-local-authentication` (SDK 56 compatible). Native module → still works in
  a dev build (the app already requires one since R4's react-native-webview). CI
  is unaffected (typecheck/lint/test only). **Lock files must stay in sync**
  (`npm install --package-lock-only` → `rm -rf node_modules && npm ci`) — a stale
  lock has failed CI before.

---

## Components

### Part A — Plugins

#### 1. `src/api/plugins.ts`
```ts
export type PluginMeta = { name: string; description: string; icon: string; category: string; host_aware: boolean }
export type Plugin = { id: string; meta: PluginMeta; enabled: boolean; enabled_at?: string | null; host_count?: number | null }
export type HostDeployment = { id: number; plugin_id: string; server_id: number; deployed_version?: string | null; status: string; last_error?: string | null; updated_at: string; config?: unknown }

export function usePlugins(): UseQueryResult<Plugin[]>                  // GET /api/admin/plugins
export function enablePlugin(id: string): Promise<{ enabled: boolean }>  // POST …/enable
export function disablePlugin(id: string): Promise<{ enabled: boolean }> // POST …/disable
export function usePluginConfig(id: string): UseQueryResult<Record<string, unknown>>  // GET …/config
export function savePluginConfig(id: string, cfg: Record<string, unknown>): Promise<{ ok: boolean }>  // PUT …/config
export function usePluginHosts(id: string): UseQueryResult<HostDeployment[]>  // GET …/hosts, polls 2s while any status ∈ {pending,deploying}
export function deployHost(id: string, body: { server_id: number; version?: string; config?: Record<string, unknown> }): Promise<HostDeployment>
export function undeployHost(id: string, serverId: number): Promise<{ ok: boolean }>          // DELETE …/hosts/{serverId}
export function startHost(id: string, serverId: number): Promise<{ status: string }>          // POST …/start
export function stopHost(id: string, serverId: number): Promise<{ status: string }>           // POST …/stop
export function restartHost(id: string, serverId: number): Promise<{ status: string }>        // POST …/restart
export function refreshHost(id: string, serverId: number): Promise<HostDeployment>            // GET …/refresh-status
```
The list/config queries follow the R5 hook pattern; `usePluginHosts`'
`refetchInterval` returns `2000` while any host is `pending`/`deploying`, else
`false` (mirrors R5's `useRun` terminal-poll). Mutations are plain async fns the
screens call then invalidate/refetch.

#### 2. Screens under `app/(app)/plugins/`
- **`index.tsx`** — `usePlugins()` → `FlatList`: each row shows `meta.icon`
  (text/emoji), `meta.name`, `meta.category`, and a `Switch` bound to
  `enabled`. Toggling calls `enablePlugin`/`disablePlugin` then refetches (with an
  in-flight disable of the switch). Row tap → `plugins/[id]`. Loading/error/empty.
- **`[id]/index.tsx`** — detail. Reads the plugin from `usePlugins()` cache by
  `id`. Header: name + description + category; an enable/disable toggle; an "Edit
  config" row → `plugins/[id]/config`; if `meta.host_aware`, a "Hosts" row →
  `plugins/[id]/hosts` (with `host_count`). "Not found" guard.
- **`[id]/config.tsx`** — `usePluginConfig(id)` → a multiline monospace
  `TextInput` seeded with `JSON.stringify(cfg, null, 2)`. "Save" parses the text;
  on `JSON.parse` failure shows an inline error and does not submit; on success
  `savePluginConfig` then `router.back()`. Note secrets appear as `"***"` —
  re-saving them preserves the stored secret (documented in a hint line).
- **`[id]/hosts.tsx`** — `usePluginHosts(id)` → `FlatList` of deployments: each
  row shows `server #server_id`, `status` (colored; `failed`→error + `last_error`),
  `deployed_version`, and action buttons: Start/Stop/Restart (when applicable),
  Refresh (`refreshHost`), Undeploy (`undeployHost`, with confirm). A header
  "Deploy to server #…" input (numeric server_id) + Deploy button (`deployHost`).
  Each action refetches the list; the list self-polls while deploying.
- **Entry point:** a "Plugins" button in the home/servers-list header
  (`app/(app)/index.tsx` or wherever R3 put the list) → `router.push('/(app)/plugins')`.

### Part B — Biometric lock

#### 3. `src/lib/biometrics.ts` (wrapper over `expo-local-authentication`)
```ts
export async function hasHardware(): Promise<boolean>   // hasHardwareAsync()
export async function isEnrolled(): Promise<boolean>    // isEnrolledAsync()
export async function authenticate(): Promise<boolean>  // authenticateAsync({promptMessage}).success
```
Thin and mockable; no UI. Kept separate so the store/screens depend on a tiny
typed surface, not the native module directly.

#### 4. `src/store/lock.ts` (zustand)
```ts
type LockState = {
  enabled: boolean          // persisted (AsyncStorage 'shepherd_lock_enabled')
  locked: boolean           // in-memory; true at cold start when enabled
  lastBackground: number | null
  hydrate: () => Promise<void>            // load 'enabled' from AsyncStorage; set locked = enabled
  setEnabled: (on: boolean) => Promise<void>  // persist; if turning on, lock immediately
  lock: () => void
  unlock: () => void
  noteBackground: (now: number) => void   // record ts
  maybeLockOnForeground: (now: number) => void  // if enabled && now-lastBackground > 30_000 → lock()
}
```
The 30s threshold is a module constant. `maybeLockOnForeground` takes `now` as a
param (no `Date.now()` in the store body) so it is deterministically testable.

#### 5. Lock gate in the `(app)` shell
In `app/(app)/_layout.tsx` (the authed group layout): subscribe to the lock store
and an `AppState` listener. On mount, `hydrate()`. On `AppState` change:
`active`→(from background) `maybeLockOnForeground(Date.now())`;
`background`/`inactive`→`noteBackground(Date.now())`. Render order: if
`signedIn && enabled && locked`, render `<LockScreen/>` ABOVE the normal
`<Stack/>`/`<Slot/>` (so navigation state is preserved underneath); else the
normal stack. (The AppState `Date.now()` calls live in the component, not the
store — keeps the store pure.)

#### 6. `src/components/LockScreen.tsx`
Full-screen view: app name/lock icon, an "Unlock" button → `authenticate()`; on
`true` → `unlock()`; on `false` increments a local fail counter and re-prompts. After
the first failure also show a "Sign out" button → `useAuth.logout()`. Auto-invokes
`authenticate()` once on mount. (Pure component; `authenticate` is mocked in tests.)

#### 7. `app/(app)/settings.tsx`
A settings screen: a "Require biometric unlock" `Switch` bound to lock-store
`enabled`, disabled (with a hint) unless `hasHardware() && isEnrolled()` (checked
in an effect into local state). Toggling calls `setEnabled`. Below it, the
existing "Sign out" (`useAuth.logout()`). Reached from a "Settings" button in the
home header (beside "Plugins").

---

## Data flow
```
home → Plugins → usePlugins → list (Switch → enable/disable → refetch)
  row → plugins/[id] → (config → usePluginConfig → edit → savePluginConfig)
                     → (hosts → usePluginHosts polls; deploy/start/stop/restart/undeploy/refresh → refetch)
home → Settings → setEnabled(true) → lock store persists + locks
cold start (enabled) → locked=true → (app)/_layout renders LockScreen → authenticate → unlock
background >30s → foreground → maybeLockOnForeground → LockScreen
any 401 → clearSession → login (via authedFetch)
```

## Testing (jest, headless)
- **plugins API** (mock authedFetch): `usePlugins` resolves; enable/disable POST
  the right paths; `usePluginConfig` GET; `savePluginConfig` PUTs the object;
  host fns hit the right method+path (`deployHost` posts `{server_id,…}`,
  `undeployHost` DELETE, start/stop/restart POST, `refreshHost` GET); the
  `usePluginHosts` poll callback returns `2000` while a host is `deploying`,
  `false` when all are terminal.
- **biometrics lib** (mock `expo-local-authentication`): each fn maps to the SDK
  call; `authenticate` returns `.success`.
- **lock store**: `setEnabled(true)` persists + sets `locked`; `unlock` clears;
  `maybeLockOnForeground` locks when `now-lastBackground>30000` and not before;
  no-op when `enabled` is false.
- **plugins list screen** (mock `usePlugins`/enable/disable): renders rows;
  toggling a Switch calls the right mutation.
- **config screen** (mock `usePluginConfig`/`savePluginConfig`): renders seeded
  JSON; invalid JSON blocks save with an error; valid JSON calls `savePluginConfig`.
- **hosts screen** (mock `usePluginHosts` + action fns): renders statuses; an
  action button calls its fn; a `failed` row shows `last_error`.
- **LockScreen** (mock `biometrics.authenticate` + `useAuth`): mounting triggers
  `authenticate`; success calls `unlock`; failure surfaces "Sign out".
- **settings screen** (mock biometrics + lock store): toggle disabled when no
  hardware; enabling calls `setEnabled`.

## Out of scope
- Push notifications / device tokens / event dispatch (R7).
- Host **log-stream** WS; the plugin-events audit log view; plugin install/
  uninstall (plugins are compile-time registered — only enable/disable exists).
- A secondary PIN/passcode of our own (we rely on the OS biometric + its passcode
  fallback); per-screen re-auth; encrypting the token at rest beyond secure-store.

## Verification gates
`cd mobile && npx tsc --noEmit && npx eslint . && npx jest` green; **lock in sync**
(`npm ci` clean — a new dep is added this round); backend + web untouched
(`go build ./...`). **Manual (user, dev build):** toggle the lock on in Settings,
background the app >30s and confirm the biometric prompt on return + on cold
start; enable/disable a plugin, edit a config, and (for a host-aware plugin)
deploy/start/stop/undeploy on a server and watch the status settle. Ship as
**v0.28.0**.
