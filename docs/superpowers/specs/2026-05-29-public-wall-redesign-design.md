# Public Wall Redesign (Dstatus-style) + 1s Live Net — Design

**Date:** 2026-05-29
**Status:** Approved (scope confirmed via Q&A)

Redesign the public status Wall (`web/src/pages/public/Wall.tsx`) to the
Dstatus/Nezha-style probe layout from the handed-off Shepherd design-system
bundle (`shepherd-design-system/project/ui_kits/shepherd-web/Wall.jsx`), and wire
the per-server network rate to **1s live** updates (reusing sub-project C).

## Goal

A denser, probe-dashboard public Wall: List (default) + Grid toggle, a summary
strip, region groups with online counts, and per-server CPU/MEM/DISK bars +
**1s-live** network ↓↑ + cumulative traffic ↓↑ + load + platform·arch + country
flag. Still **redacted**: alias only, no IP/hostname/datacenter; only
`show_on_public` servers appear.

## Background (verified)

- Public list endpoint `GET /api/public/servers` → `PublicAPI.Servers_ListPublic`
  (`internal/api/public.go`): filters `ShowOnPublic`, builds `publicCard{ID,
  Alias, Group, CountryCode, Online, Latest, Netquality}` where `Latest` is the
  newest telemetry point (cpu/mem/disk %/`net_rx_bps`/`net_tx_bps`/`load_1`/
  `tcp_conn`). 30s `refetchInterval` on the client.
- `agent_os`/`agent_arch` are columns on the servers row (`s.AgentOS`,
  `s.AgentArch`), set from heartbeat — available in the same loop, mild
  sensitivity.
- Sub-project B: `telemetrysvc.Query.HostTraffic(ctx, id) (*HostTrafficRow, error)`
  returns cumulative `CumBytesUp`/`CumBytesDown` (zeroed default when absent).
- Sub-project C: `livenet.Hub` is populated **always-on** by every connected
  agent (rate-only `LiveNetSample{TS,RxBps,TxBps}` per ~1s). `Hub.Attach(id,
  Conn) func()` replays the 60-ring then streams; `Conn = WriteJSON(v any)`.
  The existing browser WS (`/api/servers/{id}/net-live/ws`) is **admin-cookie**
  only. `wsLiveConn` (api) serializes its own writes via a mutex.
- Frontend has: `OnlineDot`, `CountryFlag` (flag emoji — an established repo
  convention), `bps()`/`bytes()` humanizers (`lib/bytes.ts`), a List/Grid
  segmented toggle pattern in `admin/ServerList.tsx`, and 80/92 threshold tile
  status in `MetricCard.tsx`. Public routes register on the raw `mux`
  (`router.go:69-72`), no admin middleware; the public-path allowlist is
  `router.go:171`.

## Decisions (confirmed)

1. **Data scope:** existing public fields **+ platform·arch + cumulative traffic
   ↓↑** (joined from B's `host_traffic`). Exposing aggregate traffic + OS/arch on
   opted-in servers is accepted. **No** monthly-plan/quota (a separate feature).
   **No** uptime (not tracked; platform·arch fills that column).
2. **Default view:** **List** (dense table); Grid toggle; choice persisted to
   `localStorage['shep_wall_view']`.
3. **1s live network:** per-server net rate updates live via a **single
   multiplexed public WebSocket**; all other metrics stay 30s-poll.

## Part 1 — Backend: extend the public card

`internal/api/public.go`:
- Add four **top-level** fields to `publicCard` (NOT under `latest` — they come
  from the server row + host_traffic, not the telemetry point):
  `platform string json:"platform,omitempty"`, `arch string json:"arch,omitempty"`,
  `traffic_rx_bytes int64 json:"traffic_rx_bytes"`, `traffic_tx_bytes int64
  json:"traffic_tx_bytes"`.
- In `Servers_ListPublic`'s loop: set `platform = s.AgentOS.String`, `arch =
  s.AgentArch.String` (guard `.Valid`); and `if tr, err :=
  a.Query.HostTraffic(ctx, s.ID); err == nil && tr != nil { rx = tr.CumBytesDown;
  tx = tr.CumBytesUp }` (down=rx, up=tx). Zeroed when absent.
- Redaction unchanged: still gated on `ShowOnPublic`; no IP/hostname/kernel.

## Part 2 — Backend: public multiplexed live-net WebSocket

`internal/livenet/hub.go` — add a backfill-free subscribe (the wall feed wants
only the latest per server, not each server's 60-ring):
```go
// Subscribe registers c as a watcher WITHOUT replaying the ring (for
// multiplexed consumers that only want live samples). Returns a detach func.
func (h *Hub) Subscribe(serverID int64, c Conn) func() {
	h.mu.Lock()
	st := h.stateLocked(serverID)
	st.watchers[c] = struct{}{}
	h.mu.Unlock()
	return func() { h.remove(serverID, c) }
}
```
(Detail page keeps using `Attach` with backfill; `Subscribe` is `Attach` minus
the backfill loop. `remove` already exists.)

`internal/api/public.go` — add `LiveNet *livenet.Hub` field to `PublicAPI` and a
handler:
- `LiveNetWS(w, r)` — **no auth** (public). Upgrade (a public upgrader, or reuse
  the existing one). List opted-in servers (`Servers.List` → filter
  `ShowOnPublic`). Build ONE shared `wsLiveConn{conn}` (the api adapter, with its
  write-deadline + mutex). For each opted-in `id`, `Subscribe(id, &taggingConn{
  serverID: id, inner: shared})`; collect detaches. Read-loop to detect close →
  detach all + close.
- `taggingConn` (api) implements `livenet.Conn`: `WriteJSON(v any)` wraps the
  sample as `{server_id, ts, rx_bps, tx_bps}` and writes via the shared
  `wsLiveConn` (whose mutex serializes the concurrent writes from N
  per-server watchers). It marshals to a small struct
  `wallLiveFrame{ServerID int64, ...}` — or asserts `v.(agentapi.LiveNetSample)`
  and re-wraps. (Hub only ever passes `LiveNetSample`.)
- Route: `mux.HandleFunc("GET /api/public/net-live/ws", r.Public.LiveNetWS)`
  (`router.go`, beside the other `/api/public/*` routes — already in the
  public allowlist by prefix).
- Wiring: `cmd/server/main.go` already has `liveNetHub`; set
  `publicAPI.LiveNet = liveNetHub` (mirror how `Ingest.LiveNet` is wired).

**Redaction:** only opted-in servers are subscribed, so the public feed only ever
carries opted-in `server_id`s + rate numbers. A frame has no identifying data.

## Part 3 — Frontend: API types + live hook

`web/src/api/public.ts`:
- Extend `PublicCard`: `platform?: string`, `arch?: string`, `traffic_rx_bytes?:
  number`, `traffic_tx_bytes?: number`.
- Add `useWallLiveNet()` — opens `/api/public/net-live/ws`, keeps a
  `Map<number, { rx_bps: number; tx_bps: number }>` (latest per server), updates
  on each `{server_id, rx_bps, tx_bps}` frame; closes on unmount. Returns the map
  + a `connected` flag. (Mirror C's `useLiveNet` WS lifecycle: null `onmessage`
  before `close()`.)

## Part 4 — Frontend: Wall redesign

`web/src/pages/public/Wall.tsx` (+ small co-located components):
- **Header:** `Server status` H1 + redaction subtitle + a List/Grid segmented
  toggle (mirror `admin/ServerList.tsx`), persisted to
  `localStorage['shep_wall_view']`, default `'list'`.
- **Summary strip:** 5 stat cards — Nodes, Online (ok), Offline (err when >0),
  Realtime (`↓ bps(Σ live rx) / ↑ bps(Σ live tx)`), Traffic (`↓ bytes(Σ
  traffic_rx) / ↑ bytes(Σ traffic_tx)`). Icon + uppercase label + mono value.
- **Region groups:** group header with dashed bottom border + `X/Y online`.
- **List view (default):** dense table, horizontally scrollable on narrow
  screens. Columns: Node (`OnlineDot` + `CountryFlag` + alias), Platform·arch,
  CPU, Memory, Disk (each a thin `MetricBar`, 80/92 threshold colors), Network ↓↑
  (live `bps()`), Traffic ↓↑ (`bytes()`), Load. Rows link to
  `/public/servers/:id`. Offline rows show `—`.
- **Grid view:** richer cards (evolve `MetricCard`): online dot + flag + alias +
  platform·arch, CPU/MEM/DISK bars, live net ↓↑ + load line, cumulative traffic
  ↓↑ line. Status-colored border via the existing 80/92 logic.
- **Live wiring:** `useWallLiveNet()` map overrides the Network cell/line per
  server — live value when present, else the 30s-polled `latest.net_rx_bps`/
  `net_tx_bps`. The Realtime summary stat sums the live map (falling back to
  polled for servers without a live sample yet). All other metrics stay 30s-poll.
- **New small components:** `MetricBar` (labeled thin progress bar, threshold
  colors) and `SummaryStat` (icon + label + value + optional sub), co-located or
  under `web/src/components/`.

### Omitted from the design bundle (explicit)
- **Uptime** column/field — no uptime data; Platform·arch occupies that slot.
- **Monthly-plan progress bar** — no quota concept; grid card shows cumulative
  ↓↑ readout, no progress bar.
- Net/traffic formatting uses the repo's `bps()`/`bytes()` (app-wide
  consistency), not the bundle's custom `fmtMbps`/`fmtGB`.

## Testing

- **Backend (`internal/api/public_test.go`):** `Servers_ListPublic` includes
  `platform`/`arch` from the server row and `traffic_rx_bytes`/`traffic_tx_bytes`
  from a seeded `host_traffic` row (rx=cum_down, tx=cum_up); a non-opted-in
  server is still excluded.
- **Backend live WS:** unit-test the `taggingConn.WriteJSON` wraps a
  `LiveNetSample` into `{server_id,...}` (table/marshal assert). The handler's
  opted-in subscription set is covered by the list redaction test; the WS upgrade
  itself is thin.
- **Hub:** `Subscribe` registers without backfill (a freshly-subscribed conn gets
  no ring replay, then receives the next `Publish`); detach stops delivery. Add
  to `internal/livenet/hub_test.go` (race-clean).
- **Frontend:** `useWallLiveNet` with a mocked WebSocket → map updates per
  `server_id`. Wall renders List + Grid, toggle persists, summary stats compute,
  groups show `X/Y online`, live net overrides polled value, empty state. tsc +
  vitest.

## Out of scope

- Monthly-plan/bandwidth-quota feature (model + admin UI).
- Uptime tracking (agent boot-time field).
- Live CPU/mem/disk on the wall (only network goes 1s; rest stay 30s).
- Admin pages, the public detail page (`public/ServerDetail.tsx`) beyond what the
  shared `PublicCard` type change forces (keep it compiling).
