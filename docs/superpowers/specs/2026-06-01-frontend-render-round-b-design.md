# Frontend render cluster (audit Round B, item 8) — Design

**Date:** 2026-06-01
**Status:** Approved (scope confirmed via Q&A)
**Source:** `docs/system-optimization-audit.md` (item 8 / Round B)

## Goal

Land the frontend render/correctness cluster in one branch, then PR + release:

1. **Stop the public Wall re-rendering the whole tree on every live-net WS frame**
   (~N updates/sec re-reconcile the entire list though static metrics change only
   every 30s).
2. **Fix the plugin LogsTab pause toggle** (clicking Pause currently tears down the
   WebSocket and wipes the log buffer — the opposite of pause) and **de-duplicate**
   the two byte-identical LogsTab files.
3. **Consolidate the two parallel toast systems** (zustand `useUI.toasts` +
   shadcn `use-toast`/`ToastBridge`, whose `TOAST_LIMIT=1` drops all-but-the-last
   of rapid toasts).
4. **Memoize TimeSeriesChart** scale + path-string recomputation so a hover
   (mousemove) no longer regenerates geometry.

## Confirmed decisions

- **Wall: a per-id Zustand store**, not coalesce+memo. Leaf cells subscribe to
  their own server's `{rx,tx}`; the rest of the wall tree never re-renders on a
  live frame. (Coalesce+memo still re-renders the parent list each frame.)
- **Toast: keep `useUI.toasts` as the single source.** Rewrite the Toaster to
  render it directly and delete the shadcn bridge — zero changes to the ~35
  `useUI.toast(...)` call sites.
- **TimeSeriesChart: memoize scales + paths only.** Skip the rAF hoverX throttle
  and the bisect micro-opt (verifier-downgraded; series are small sparklines).

---

## ① Wall live-net per-id store

**Files:** `web/src/api/wallLive.ts` (rewrite), `web/src/pages/public/Wall.tsx`.

Today `useWallLiveNet` keeps a `Map` in component state and does
`setLive(new Map(prev).set(...))` per frame → new Map identity → the whole `Wall`
re-renders; `rxOf`/`txOf` closures are recreated each render and passed to
unmemoized `ServerListTable`/`WallServerCard`, so the entire list reconciles ~1Hz.

Replace with a Zustand store + per-id selector:

- **Store** (`wallLive.ts`): `create` a store holding `live: Record<number, {rx_bps, tx_bps}>`
  and `connected: boolean`, with an action `setFrame(id, rx, tx)` and
  `setConnected(b)`. (A plain object record keyed by id; updating one id replaces
  that key's value, leaving sibling values referentially stable.)
- **Connection hook** `useWallLiveConnection()`: opens the single
  `/api/public/net-live/ws`, writes frames via `setFrame`, sets `connected`, and
  closes on unmount. Called ONCE in `Wall`. Returns nothing (or `connected`).
- **Selector hook** `useLiveNet(id)`: `useWallLiveStore(s => s.live[id])` — returns
  that id's `{rx_bps,tx_bps}` (or undefined). Zustand re-renders the subscriber only
  when that id's value reference changes.
- **Leaf cell** `LiveNetCell`: a small component taking `{ id, fallbackRx, fallbackTx, variant }`
  that calls `useLiveNet(id)` and renders `↓ bps(live?.rx_bps ?? fallbackRx)` /
  `↑ bps(live?.tx_bps ?? fallbackTx)`. Used in both the table row and the card,
  replacing the `rxOf(s)`/`txOf(s)` call sites. Each cell self-subscribes; the row
  body no longer depends on `live`.
- **Totals**: a `LiveNetTotals` component (or a header cell) that subscribes to the
  whole `live` map and sums `rx/tx` over the online servers (falling back to each
  server's polled `latest.net_*`). It updates ~1Hz — acceptable, it is one small
  node, not the list. The current page-scope `sumRxBps`/`sumTxBps` move here.

Result: a live frame re-renders only the affected `LiveNetCell` (and the totals),
never the static-metric rows. `Wall` still re-renders on the 30s poll (new card
data) as before.

---

## ② LogsTab pause fix + shared component

**Files:** create `web/src/pages/admin/plugins/PluginLogsTab.tsx`; reduce
`web/src/pages/admin/plugins/xray/LogsTab.tsx` and
`web/src/pages/admin/plugins/singbox/LogsTab.tsx` to one-liners.

The two LogsTab files differ only in the plugin string (`'xray'` vs `'singbox'`).
The bug: the stream `useEffect` lists `paused` in its deps AND calls `setLines([])`
at the top, so toggling Pause closes/reopens the WS and clears the buffer.

`PluginLogsTab({ plugin }: { plugin: 'xray' | 'singbox' })`:

- `const [paused, setPaused] = useState(false)` (button label only) +
  `const pausedRef = useRef(false)`; keep them in sync with
  `useEffect(() => { pausedRef.current = paused }, [paused])`.
- The stream effect deps become `[serverID, plugin]` (NOT `paused`). `setLines([])`
  runs only on serverID/plugin change. `onmessage` does
  `if (!pausedRef.current) setLines(prev => [...prev.slice(-1999), env])`.
- The hosts query keys off `plugin`; the WS URL uses `pluginLogsWSURL(plugin, serverID)`.
  Pause/Clear buttons and rendering are otherwise unchanged.

`xray/LogsTab.tsx` → `export default function LogsTab() { return <PluginLogsTab plugin="xray" /> }`
(and `"singbox"`). Fixes: Pause stops appending without reconnecting or clearing;
Resume keeps the accumulated buffer; Clear still empties it.

---

## ③ Toast consolidation

**Files:** rewrite `web/src/components/ui/toaster.tsx` (or a new `Toaster`);
delete `web/src/components/ToastBridge.tsx` and `web/src/hooks/use-toast.ts`;
edit `web/src/main.tsx` (lines ~56–57).

Today: pages call `useUI.toast(kind, msg)` (zustand `toasts` array, ~35 sites);
`ToastBridge` re-emits each into shadcn `use-toast` (which caps at `TOAST_LIMIT=1`)
and dismisses it — two toasts in one tick drop all but the last.

- Rewrite `Toaster` to read `useUI(s => s.toasts)` and render each with the existing
  `ui/toast.tsx` primitives (`ToastProvider`/`Toast`/`ToastTitle`/`ToastDescription`/
  `ToastClose`/`ToastViewport`), mapping `kind` → title + `variant`
  (`error` → `destructive`). Render ALL active toasts (no limit-1 drop).
- Auto-dismiss: each toast schedules `useUI.dismissToast(id)` after a fixed delay
  (e.g. 5000ms) via a `useEffect`+`setTimeout` keyed on the toast id (a small
  `<ToastItem>` child owns its timer and cleans it up on unmount). `ToastClose`
  also calls `dismissToast(id)`.
- In `main.tsx`, replace `<ShadcnToaster /> + <ToastBridge />` with the single new
  `<Toaster />`. Delete `ToastBridge.tsx` and `hooks/use-toast.ts`. Keep
  `ui/toast.tsx` (the primitives). The ~35 `useUI.toast` call sites are untouched.

---

## ④ TimeSeriesChart memoization

**File:** `web/src/components/TimeSeriesChart.tsx`.

`min`/`max` (`flatMap` + `Math.min/max(...spread)`), `tMin`/`tMax`, and the
per-series SVG `d` path strings are recomputed in the render body every render —
including on every `hoverX` change (mousemove). `yTicks`/`xTicks`/`closestPoints`
are already memoized.

- Wrap `min`/`max`/`tMin`/`tMax` (and the derived `x`/`y` scale functions, or at
  least the bounds they depend on) in `useMemo` on `[series, width, yMin, yMax]`.
- Memoize the per-series `d` path strings as a `useMemo` over `[series, width,
  min, max, tMin, tMax]` (an array of `d` strings indexed by series), so the
  render body just reads them. Hovering (which only changes `hoverX`) no longer
  recomputes geometry.
- Do NOT add rAF throttling or bisect — out of scope.

---

## Testing

**Vitest (jsdom):**
- **Wall store:** `setFrame(id, rx, tx)` updates only that id's entry; a second
  id's value reference is unchanged. `useLiveNet(id)` returns the latest frame.
  `LiveNetCell` renders the live value when present, the fallback when absent.
- **LogsTab:** mock `WebSocket`. Feed two lines, click Pause → assert the existing
  lines are still rendered AND no new WebSocket was constructed (reconnect did not
  happen) AND a subsequent message is NOT appended; click Resume → a new message
  IS appended and the old lines remain. Clear empties the buffer.
- **Toast:** two `useUI.getState().toast('info', ...)` calls in one tick → both
  render (no drop); advancing fake timers past the delay dismisses them.
- **TimeSeriesChart:** renders given a small series without error; a hover state
  change does not change the computed `d` strings (assert via a stable-reference
  check or that the same path text is present before/after a simulated hover).

**Gates:** `tsc --noEmit`, `vitest run` (full suite green); no backend change.

## Out of scope

- The ServerList poll-reconcile memoization (verifier-downgraded to low/maintainability
  — folds into Round C's ServerList split).
- rAF/bisect micro-opts in TimeSeriesChart.
- Round C (refactors/dead code) and the remaining lower-priority items.

## Verification gates

`tsc --noEmit` + `vitest run` green; manual: the wall's per-server net numbers
update ~1Hz without the whole list flickering; pausing logs keeps the buffer;
rapid toasts all appear.
