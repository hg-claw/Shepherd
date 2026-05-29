# Agent Host Hardware Inventory — Design

**Date:** 2026-05-28
**Status:** Approved (fields + collection methods confirmed via Q&A)

Sub-project **A** of the host-metrics initiative (the other two — cumulative
traffic + 1s live throughput — are separate specs, built after this).

## Goal

Have the agent collect each managed server's static hardware inventory — CPU
(physical + logical cores + model), total memory, total disk capacity, and any
discrete GPU(s) — and surface it on the server detail page.

## Background (verified)

- The agent (`internal/agent/*`) already pushes `Telemetry` (CPU%/mem/load/disk/
  net/tcp) every 30s and a `Heartbeat` (OS/arch/kernel) every 1 min over a
  WebSocket; `internal/telemetrysvc/ingest.go` `HandleFrame` dispatches by
  envelope type. `gopsutil/v3 v3.24.5` is already a dependency.
- Envelope types live in `internal/agentapi/types.go`; the server ingest switch
  is in `telemetrysvc/ingest.go`. Core (non-plugin) migrations are in
  `internal/db/migrations/{sqlite,postgres}` (latest `0006`), run by
  golang-migrate.
- `ServerDetail.tsx` is a REST-poll page (identity card, SSH card, telemetry
  charts, etc.). No host_inventory table exists today.

## Data collected (agent, Linux servers; degrade gracefully elsewhere)

| Field | Source |
|-------|--------|
| `cpu_physical` | `gopsutil/v3/cpu.Counts(false)` |
| `cpu_logical` | `gopsutil/v3/cpu.Counts(true)` |
| `cpu_model` | `gopsutil/v3/cpu.Info()[0].ModelName` (empty if unavailable) |
| `mem_total` | `gopsutil/v3/mem.VirtualMemory().Total` (bytes) |
| `disk_total` | `lsblk -b -d -o NAME,TYPE,SIZE --json` → sum `SIZE` of entries with `TYPE=="disk"` (bytes) |
| `gpus` | `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` → one `{name, vram_mib}` per line; on failure/missing, fall back to `lspci` listing VGA/3D controllers whose vendor is NVIDIA or AMD (discrete), `vram_mib=0` |

**Degradation:** each source is independent and best-effort. Missing `lsblk` →
`disk_total=0`. Missing `nvidia-smi` → try `lspci`; missing both → `gpus=[]`.
gopsutil CPU/mem are cross-platform. A collection error in one field never aborts
the others or crashes the agent.

## Wire protocol & cadence

- New envelope type: `TypeHostInventory = "host.inventory"` (`agentapi/types.go`).
- New payload struct:
  ```go
  type GPU struct {
      Name    string `json:"name"`
      VRAMMiB int64  `json:"vram_mib"` // 0 when unknown (lspci fallback)
  }
  type HostInventory struct {
      CPUPhysical int    `json:"cpu_physical"`
      CPULogical  int    `json:"cpu_logical"`
      CPUModel    string `json:"cpu_model"`
      MemTotal    int64  `json:"mem_total"`
      DiskTotal   int64  `json:"disk_total"`
      GPUs        []GPU  `json:"gpus"`
  }
  ```
- **Cadence:** the agent collects inventory once at process start (cached) and
  sends it **once on every successful WS (re)connect**. Static data — no periodic
  resend; a reconnect (e.g. after agent restart / hardware change) refreshes it.
  Collection runs in a goroutine so a slow `lsblk`/`nvidia-smi` never blocks the
  connect path.

## Storage

Core migration `internal/db/migrations/{sqlite,postgres}/0007_host_inventory.{up,down}.sql`:

```sql
CREATE TABLE host_inventory (
  server_id     BIGINT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  cpu_physical  INTEGER,
  cpu_logical   INTEGER,
  cpu_model     TEXT,
  mem_total     BIGINT,
  disk_total    BIGINT,
  gpus_json     TEXT,        -- JSON array of {name, vram_mib}
  updated_at    TIMESTAMPTZ NOT NULL
);
```

(sqlite variant: `INTEGER`/`TEXT`/`TIMESTAMP`, `server_id INTEGER PRIMARY KEY`.)

Ingest: `telemetrysvc/ingest.go` `HandleFrame` gains
`case agentapi.TypeHostInventory:` → decode → `WriteHostInventory(ctx, serverID,
inv)` which UPSERTs the row (`ON CONFLICT(server_id) DO UPDATE`), `gpus_json` =
`json.Marshal(inv.GPUs)`, `updated_at=now`.

## Server API

`GET /api/servers/{id}/inventory` (admin) → the `host_inventory` row as JSON, or
`null`/404 when none reported yet. New `Inventory` handler on `ServersAPI` (mirrors
the existing `Telemetry` handler), backed by a small `telemetrysvc` query
(`HostInventory(ctx, serverID) (*HostInventoryRow, error)`). `gpus_json` is
returned parsed (as a `gpus` array) so the UI needn't re-parse.

## Admin UI

A **Hardware** card on `ServerDetail.tsx`:
- CPU: `<physical> 物理核 / <logical> 线程` + `cpu_model`.
- Memory: humanized `mem_total`.
- Disk: humanized `disk_total`.
- GPU: one line per GPU `name ×count` with VRAM when `vram_mib>0`; "无独立显卡"
  when the list is empty; "—" when inventory not yet reported.
Fetched via a `useHostInventory(id)` hook (react-query, low/no refetch — static).

## Testing

- **Agent parsers (pure, fixture-driven, the testable core):**
  - `parseLsblk(jsonBytes) (int64, error)` — sums `TYPE=="disk"` sizes; ignores
    `part`/`loop`/`rom`; handles missing/empty.
  - `parseNvidiaSMI(csv string) []GPU` — `"NVIDIA RTX 4090, 24576"` → `{name,
    24576}`; multiple lines → multiple GPUs; empty → nil.
  - `parseLspciGPUs(text string) []GPU` — extracts VGA/3D controller model
    strings for NVIDIA/AMD vendors, `vram_mib=0`; ignores Intel integrated.
  - The top-level `Collect()` is tolerant: with all external tools stubbed/absent
    it still returns CPU/mem and empty disk/gpus without error.
- **Server:** `WriteHostInventory` upsert round-trip (insert then update); ingest
  dispatch decodes `host.inventory` and writes.
- **API:** `GET /inventory` returns the stored row with parsed `gpus`; 404/null
  when absent.
- **Frontend:** Hardware card renders CPU/mem/disk/GPU; empty-GPU and
  no-inventory states; vitest.

## Out of scope (YAGNI / later sub-projects)

- 1s live network throughput (sub-project C).
- Cumulative host upload/download + reset date (sub-project B).
- Per-disk / per-DIMM detail, CPU frequency/cache, RAID topology.
- Non-NVIDIA GPU VRAM (lspci can't report it).
- Showing inventory in the server *list* (detail page only).
