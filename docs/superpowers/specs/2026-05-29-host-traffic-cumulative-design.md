# Host Cumulative Traffic + Monthly Reset Day — Design

**Date:** 2026-05-29
**Status:** Approved (all decisions confirmed via Q&A)

Sub-project **B** of the host-metrics initiative. Sub-project A (hardware
inventory) shipped in v0.14.0. Sub-project **C** (1s live throughput) is a
separate, later spec.

## Goal

Track each managed server's **whole-server cumulative upload/download bytes**
since the last reset, with a **configurable per-server monthly reset day** that
zeroes the counters automatically (plus a manual "reset now"). Show it on the
server detail page.

## Background (verified)

- The agent's `collector` runs a tick every `IntervalS` seconds (default 30,
  configurable per agent). Each tick builds `agentapi.Telemetry`
  (`internal/agent/collector/collector.go`) and sends it; the server's
  `WriteSample` (`internal/telemetrysvc/ingest.go`) persists it.
- `NetMeter.Sample()` (`internal/agent/collector/net.go`) already computes the
  per-interval **byte delta** (`rx-prevRx`, `tx-prevTx`) — currently it divides
  by `dt` to produce `net_rx_bps`/`net_tx_bps` and discards the raw delta. It
  already handles reboot / counter-wrap: on `rx < prevRx` it re-primes and
  returns `(…, false)`, and the collector drops the whole tick when net isn't OK.
  It currently sums **all** non-`lo` interfaces.
- Periodic server jobs follow a `Run(ctx)/Tick(ctx)` ticker pattern (`Rollup`
  1m, `Retention` 10m), started in `cmd/server/main.go` as
  `go (&X{…}).Run(rootCtx)`.
- Per-server config uses side tables keyed by `server_id` (e.g.
  `netquality_hosts`). Global key/value config is the `settings` table
  (`serversvc.SettingsStore`, `Get/Set/GetInt`). Per-server admin mutations are
  `POST /api/servers/{id}/…` handlers on `ServersAPI` (e.g. `Config`).
- `gpus_json`-style upsert (`INSERT … ON CONFLICT(server_id) DO UPDATE`) is
  portable to sqlite + postgres.

## Decisions (confirmed)

1. **Interface scope: physical only.** Exclude `lo` and virtual interfaces
   (`docker*`, `veth*`, `br-*`, `wg*`, `tun*`, `tap*`). Applied **in NetMeter**,
   so BOTH the existing live `net_rx_bps`/`net_tx_bps` chart AND the new
   cumulative counters use physical interfaces — this also fixes the existing
   chart's container/VPN double-count (the same traffic was counted on both the
   tunnel/bridge and the physical NIC). **Behavior change:** the live net chart
   becomes "physical uplink" instead of "sum of all non-lo interfaces."
2. **Reset day: 1–28 + global timezone.** Per-server `reset_day` ∈ [1,28]
   (avoids month-length edge cases — no clamping needed). A single global
   setting `traffic_reset_tz` (IANA name, default `UTC`) determines when "the
   day" begins.
3. **Keep previous period.** On reset, snapshot current totals into
   `prev_bytes_up`/`prev_bytes_down`, then zero `cum_bytes_*`. UI shows 本周期 +
   上周期. No history table.
4. **Accumulation source: exact byte deltas over the existing telemetry tick.**
   The agent sends the raw per-interval byte delta (not lossy bps×interval), so
   cumulative is **exact regardless of report cadence** — correct at 30s, no
   dependency on sub-project C / 1s sampling.

## Agent changes

`internal/agent/collector/net.go`:
- Add a shared interface filter `isPhysicalIface(name string) bool` (false for
  `lo` and names with prefix `docker`, `veth`, `br-`, `wg`, `tun`, `tap`).
  NetMeter's sum loop uses it instead of the bare `name == "lo"` skip.
- `NetMeter.Sample()` returns the per-interval **delta bytes** in addition to
  bps. New signature:
  `Sample() (rxBps, txBps, rxBytes, txBytes int64, ok bool)` where
  `rxBytes = rx-prevRx`, `txBytes = tx-prevTx` (the exact numerator already
  computed). Reset/reprime still returns `ok=false` (all zeros) → tick dropped,
  no spurious accumulation.

`internal/agentapi/types.go` — add to `Telemetry`:
```go
	NetRxBytes int64 `json:"net_rx_bytes"` // exact bytes received this interval
	NetTxBytes int64 `json:"net_tx_bytes"` // exact bytes sent this interval
```

`internal/agent/collector/collector.go` `sample()`: capture the new return
values and set `NetRxBytes`/`NetTxBytes` on the telemetry.

## Server: storage

Core migration `internal/db/migrations/{postgres,sqlite}/0008_host_traffic.{up,down}.sql`:
```sql
CREATE TABLE host_traffic (
  server_id       BIGINT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  cum_bytes_up    BIGINT  NOT NULL DEFAULT 0,   -- current period, tx (sent)
  cum_bytes_down  BIGINT  NOT NULL DEFAULT 0,   -- current period, rx (recv)
  prev_bytes_up   BIGINT  NOT NULL DEFAULT 0,   -- last period snapshot
  prev_bytes_down BIGINT  NOT NULL DEFAULT 0,
  reset_day       INTEGER NOT NULL DEFAULT 1,   -- 1..28
  last_reset_at   TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL
);
```
(sqlite: `INTEGER`/`TIMESTAMP`, `server_id INTEGER PRIMARY KEY`.)

Global setting: seed `traffic_reset_tz` = `UTC` in the settings migration
(add an `INSERT` to a new core migration row, or via `SettingsStore` default —
seed it in `0008` alongside the table).

**Naming:** up = tx = `BytesSent`, down = rx = `BytesRecv`.

## Server: accumulation (ingest)

`telemetrysvc/ingest.go` `WriteSample`: after the existing telemetry insert, if
`t.NetRxBytes != 0 || t.NetTxBytes != 0`, upsert-accumulate:
```sql
INSERT INTO host_traffic (server_id, cum_bytes_up, cum_bytes_down, last_reset_at, updated_at)
VALUES ($1, $2, $3, $4, $4)
ON CONFLICT (server_id) DO UPDATE SET
  cum_bytes_up   = host_traffic.cum_bytes_up   + EXCLUDED.cum_bytes_up,
  cum_bytes_down = host_traffic.cum_bytes_down + EXCLUDED.cum_bytes_down,
  updated_at     = EXCLUDED.updated_at;
```
where `$2=t.NetTxBytes`, `$3=t.NetRxBytes`, `$4=now`. On first insert
`last_reset_at = now` ("started counting now"), so the reset checker won't zero
freshly-accumulated bytes before the first scheduled boundary. (The
`ON CONFLICT` path does NOT touch `last_reset_at`/`reset_day`/`prev_*`.)

A negative/garbage delta can't occur: the agent only sends a tick when
`ok=true`, and `ok` is false on any counter decrease.

## Server: reset checker (periodic job)

New `internal/telemetrysvc/traffic_reset.go`:
- Pure helper `lastResetBoundary(now time.Time, resetDay int, loc *time.Location) time.Time`
  — the most recent instant `resetDay 00:00:00` in `loc` that is `≤ now`. (If
  today is past `resetDay` this month → this month's; else → previous month's.
  Day ∈ [1,28] so it always exists; no clamping.)
- `TrafficReset{DB, Settings}` with `Run(ctx)`/`Tick(ctx)`, ticking hourly
  (monthly granularity — hourly is ample). `Tick`: load `traffic_reset_tz`
  (fallback `UTC` on parse error), then for each `host_traffic` row compute
  `b := lastResetBoundary(now, reset_day, loc)`; if `last_reset_at IS NULL OR
  last_reset_at < b` → snapshot+zero:
  ```sql
  UPDATE host_traffic SET
    prev_bytes_up = cum_bytes_up, prev_bytes_down = cum_bytes_down,
    cum_bytes_up = 0, cum_bytes_down = 0,
    last_reset_at = $now, updated_at = $now
  WHERE server_id = $id;
  ```
- Wire in `cmd/server/main.go`: `go (&telemetrysvc.TrafficReset{DB: d, Settings: settingsStore}).Run(rootCtx)` after Retention.

## Server: API

On `ServersAPI` (`internal/api/admin_servers.go`), + routes in `router.go`:
- `GET /api/servers/{id}/traffic` → `{cum_bytes_up, cum_bytes_down,
  prev_bytes_up, prev_bytes_down, reset_day, last_reset_at}`; when no row, return
  a zeroed object with `reset_day` = default 1 (not null) so the UI always
  renders.
- `POST /api/servers/{id}/traffic/reset-day` `{reset_day:int}` — validate
  `1..28`; upsert the row's `reset_day` (create row with defaults +
  `last_reset_at=now` if absent, so the checker doesn't fire a spurious
  zero-snapshot before any traffic accumulates).
- `POST /api/servers/{id}/traffic/reset` — manual snapshot+zero now (same UPDATE
  as the checker; create row if absent then it's a no-op zero). 204.

Query/store methods live in a new `internal/telemetrysvc/traffic.go`
(`HostTraffic(ctx,id)`, `SetResetDay(ctx,id,day)`, `ResetNow(ctx,id)`), mirroring
`inventory.go`.

Global TZ: expose `traffic_reset_tz` through the existing admin settings
mechanism (it's a `settings` key; surface a field on the global settings page).

## Admin UI

`web/src/api/servers.ts`: `useHostTraffic(id)` (refetch ~10s — semi-live),
`useSetResetDay`, `useResetTraffic` mutations.

`web/src/pages/admin/ServerDetail.tsx`: a **流量 (Traffic)** card:
- 本周期: `↑ bytes(cum_bytes_up)  ↓ bytes(cum_bytes_down)`.
- 上周期: `↑ bytes(prev_bytes_up)  ↓ bytes(prev_bytes_down)`.
- 重置日: editable number input (1–28) → `useSetResetDay`.
- 上次重置: `last_reset_at` (— if null).
- 「立即重置」button → `useResetTraffic` (confirm dialog).

Global settings page: a `traffic_reset_tz` text/select field (IANA tz).

## Testing

- **Agent:** `isPhysicalIface` table test (eth0/ens3 → true; lo/docker0/veth123/
  br-x/wg0/tun0/tap0 → false). NetMeter delta-bytes test: prime, then a second
  sample with known counter increments returns the exact `rxBytes`/`txBytes`;
  reset (counter decrease) → `ok=false`. (Drive via an injected counter source
  or by constructing NetMeter state — match how net.go is testable; if it calls
  gopsutil directly, factor the per-interface sum into a tiny pure helper
  `sumPhysical(stats) (rx,tx)` and test that.)
- **Server ingest:** `WriteSample` with `NetRxBytes/NetTxBytes` creates the row
  (first tick, `last_reset_at` set) and accumulates on the second tick.
- **Reset boundary (pure):** `lastResetBoundary` — now after/before reset_day in
  month; month rollover (reset_day=1 on Jan 1 → Dec 1 prev); a non-UTC tz shifts
  the boundary; day=28 in February.
- **Reset checker:** row with `last_reset_at` before the boundary → snapshot+zero;
  row already reset this period → no-op; manual `ResetNow`.
- **API:** GET returns zeroed default when absent + stored values when present;
  set-reset-day validation (0/29/31 → 400; 1/28 → ok); reset → 204 + zeroed.
- **Frontend:** Traffic card renders 本/上周期, edits reset day, reset button;
  vitest.

## Out of scope (YAGNI / later)

- Sub-project C (1s live throughput) — when it lands, ensure cumulative is fed
  from exactly one source (the telemetry tick) so 1s samples don't double-count.
- Per-interface breakdown; historical period archive beyond "previous"; traffic
  caps/alerts; showing traffic in the server *list*.
- Recovering bytes transferred while the agent was offline (unrecoverable across
  a counter gap; accepted).
