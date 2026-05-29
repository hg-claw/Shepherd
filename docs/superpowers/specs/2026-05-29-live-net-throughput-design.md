# Live 1s Network Throughput — Design

**Date:** 2026-05-29
**Status:** Approved (channel + cadence + view + storage confirmed via Q&A)

Sub-project **C** of the host-metrics initiative — the final one.
A=hardware inventory (v0.14.0), B=cumulative traffic + reset day (merged).

## Goal

Show a near-real-time (~1s) network throughput readout + rolling sparkline on the
admin server-detail page, replacing the 30s-averaged net rate as the "live" view.

## Background (verified)

- The agent runs per-connection samplers started in `wsclient.dialAndRun`
  (`TrafficSampler`/`SingboxTrafficSampler`/`NetqualitySampler`), each with a
  context cancelled on disconnect. Agent→server is a WebSocket; the server-side
  `agentsvc.Hub` maps `serverID → conn`. Agent→server frames are dispatched by
  `telemetrysvc.Ingest.HandleFrame` (switch on `env.Type`).
- `collector.NetMeter` (post-B) filters to physical interfaces and returns
  `(rxBps, txBps, rxBytes, txBytes, ok)`. It has **no package/singleton state** —
  a second `&collector.NetMeter{}` instance samples independently. `NetMeter` +
  `Sample` are exported; `isPhysicalIface`/`sumPhysical` are package-private but
  used internally by `Sample`.
- Sub-project B accumulates cumulative bytes **only** in `WriteSample` (the
  `TypeTelemetry` path), reading `Telemetry.NetRxBytes/NetTxBytes`.
- The only existing browser↔server stream is the **PTY console WebSocket**
  (`internal/api/console_routes.go` `AttachWS`, route
  `GET /api/admin/console/ws`): cookie auth via `auth.AdminFromContext`,
  `websocket.Upgrader`, a read loop that detects close. Browser opens it via a
  `ws(s)://…` URL (`web/src/api/console.ts`). This is the template.
- `ServerDetail.tsx` shows net rx/tx from `useTelemetry` (30s-poll) via
  `TimeSeriesChart`. `bps()` humanizer exists.

## Decisions (confirmed)

1. **Browser channel: WebSocket** (mirror the console PTY WS — cookie auth,
   one-way server→browser).
2. **Cadence: always-on.** Every agent samples + pushes a 1s `live.net` frame
   continuously while connected (no on-demand toggle). *Accepted tradeoff:* a
   tiny (~60-byte) frame/sec per agent and a small per-server in-memory ring,
   regardless of whether anyone is watching. (A future "only-while-watched"
   toggle is possible but out of scope.)
3. **View: readout + rolling sparkline.** Current `↑/↓` bps readout plus a
   ~60s, 1s-resolution sparkline (`TimeSeriesChart`).
4. **Storage: ephemeral.** Rate-only, never persisted. No DB / migration. The
   30s history charts already cover trends.

## No double-count with B

`live.net` carries **rate only** (`rx_bps`/`tx_bps`), is handled by a **separate
ingest case** that only updates the in-memory hub, and is **never** routed
through `WriteSample`/accumulation. So B's cumulative bytes are untouched by
construction.

## Agent

New `internal/agent/livenetsampler`:
- `Sampler{ Sender, Interval (default 1s), Source func() (rxBps, txBps int64, ok bool) }`.
  `Source` defaults to a closure over a private `*collector.NetMeter` (its own
  prev counters); the seam lets tests inject a fake source.
- `Run(ctx)`: every `Interval`, call `Source()`; if `ok`, send
  `agentapi.Frame(TypeLiveNet, LiveNetSample{TS: now, RxBps, TxBps})` via `Sender`.
  First tick primes the meter (`ok=false`) and is skipped, like the others.
- Wired in `wsclient.dialAndRun` exactly like `NetqualitySampler` (always-on,
  per-connection context).

`internal/agentapi/types.go`:
```go
TypeLiveNet = "live.net" // agent → server, ~1s, rate-only (ephemeral)

type LiveNetSample struct {
	TS    time.Time `json:"ts"`
	RxBps int64     `json:"rx_bps"`
	TxBps int64     `json:"tx_bps"`
}
```

## Server

New `internal/livenet` package, `Hub`:
- Per-server state: latest sample + a fixed **60-entry ring** of recent samples +
  a set of attached browser connections (behind a mutex).
- `Publish(serverID int64, s agentapi.LiveNetSample)` — append to ring, set
  latest, broadcast JSON to that server's watchers (drop a watcher on write error).
- `Attach(serverID int64, c Conn) (backfill []agentapi.LiveNetSample, detach func())`
  — register a watcher, return the current ring for immediate paint. `Conn` is a
  tiny interface (`WriteJSON(any) error`) so the WS handler and tests both satisfy it.

`telemetrysvc.Ingest` gains a `LiveNet *livenet.Hub` field; `HandleFrame` adds:
```go
case agentapi.TypeLiveNet:
	var s agentapi.LiveNetSample
	if err := env.Decode(&s); err != nil { log…; return }
	if i.LiveNet != nil { i.LiveNet.Publish(serverID, s) }
```

Browser WS endpoint (new `internal/api/livenet_routes.go`, `LiveNetAPI{Hub}`):
- `GET /api/admin/servers/{id}/net-live/ws` (admin mux → cookie auth via
  `auth.AdminFromContext`, like console). Reject non-admin 401.
- Upgrade; `id := r.PathValue("id")`; `Attach(id, conn)`; write the backfill ring
  first, then the hub streams live frames; a read loop detects close → `detach()`.
- Each browser message is one `LiveNetSample` JSON (`{ts, rx_bps, tx_bps}`);
  backfill is just the ring replayed as the same shape, so the client treats
  every message identically.

Wiring (`cmd/server/main.go`): construct `liveNetHub := livenet.NewHub()`, inject
into `Ingest.LiveNet` and `LiveNetAPI.Hub`; register the route.

## Admin UI

`web/src/api/livenet.ts`: `liveNetWSURL(id)` + a `useLiveNet(id)` hook (mirror the
console WS hook): opens the WS, keeps a rolling buffer (last 60 `{ts, v}` for rx
and tx) + the latest sample; closes the WS on unmount. Returns `{ rx, tx, rxSeries,
txSeries, connected }`.

`ServerDetail.tsx`: a **实时网速 (Live)** card — `↑ bps(rx) ↓ bps(tx)` readout +
a `TimeSeriesChart` sparkline of the rolling rx/tx series. Shows a muted
placeholder until the first sample / when disconnected.

## Testing

- **Agent (`livenetsampler`):** with a fake `Source` and a fake `Sender`: emits a
  frame per tick when `ok=true`; skips when `ok=false`; stops on ctx cancel.
- **Server (`livenet.Hub`):** `Publish` broadcasts to attached fake `Conn`s; ring
  keeps ≤60 and `Attach` returns the backfill; `detach` removes the watcher (no
  broadcast after); a `Conn` whose `WriteJSON` errors is dropped.
- **Ingest dispatch:** a `live.net` envelope routes to `Hub.Publish` (and never to
  `WriteSample` — assert cumulative `host_traffic` is unaffected by a live.net
  frame).
- **API:** `AttachWS` returns 401 without an admin context (auth gate); the hub
  logic above covers fanout.
- **Frontend:** `useLiveNet` with a mocked `WebSocket` — feed samples → readout
  shows the latest, sparkline series grows and trims to 60; unmount closes the WS.

## Out of scope (YAGNI)

- Persisting 1s samples / 1s history beyond the live window.
- On-demand (only-while-watched) streaming — explicitly deferred; always-on chosen.
- Public (non-admin) live view; per-interface live breakdown; live CPU/mem/etc.
  (only network throughput).
