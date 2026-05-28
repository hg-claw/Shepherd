# Agent Host Hardware Inventory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Agent collects each server's static hardware inventory (CPU physical/logical + model, total memory, total disk via lsblk, discrete GPUs via nvidia-smi→lspci) and the admin UI shows it on a Hardware card.

**Architecture:** New `host.inventory` envelope produced once per WS (re)connect by the agent; ingested into a new core `host_inventory` table (upsert per server); served via `GET /api/servers/{id}/inventory`; rendered as a Hardware card on ServerDetail. Pure parsers are the testable core.

**Tech Stack:** Go, gopsutil/v3 (already a dep), `lsblk`/`nvidia-smi`/`lspci` (best-effort exec), sqlx, golang-migrate (core migrations), React/TS + react-query, vitest.

**Spec:** `docs/superpowers/specs/2026-05-28-agent-host-inventory-design.md`

Run from `/Users/hg/project/Shepherd`; never `git checkout`/`reset`/`stash` (commit on `feat/agent-host-inventory`). Frontend cmds from `web/`; do NOT run `npm run build`.

---

## Task 1: agentapi wire types + `hostinfo` collector (parsers)

**Files:**
- Modify: `internal/agentapi/types.go`
- Create: `internal/agent/hostinfo/hostinfo.go`
- Test: `internal/agent/hostinfo/hostinfo_test.go`

- [ ] **Step 1: Add wire types** to `internal/agentapi/types.go`.

Add to the `const (...)` block (after `TypeNetqualityBatch`):
```go
	// TypeHostInventory: agent → server. Static hardware inventory, sent once
	// on each WS (re)connect.
	TypeHostInventory = "host.inventory"
```
Add the payload structs (near `Telemetry`):
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

- [ ] **Step 2: Write failing parser tests** in `internal/agent/hostinfo/hostinfo_test.go`:

```go
package hostinfo

import "testing"

func TestParseLsblk(t *testing.T) {
	// newer util-linux: size as number; older: size as quoted string. Both supported.
	num := []byte(`{"blockdevices":[{"name":"sda","type":"disk","size":512110190592},{"name":"sr0","type":"rom","size":1073741824},{"name":"loop0","type":"loop","size":100}]}`)
	if got, err := parseLsblk(num); err != nil || got != 512110190592 {
		t.Fatalf("num: got %d err %v", got, err)
	}
	str := []byte(`{"blockdevices":[{"name":"nvme0n1","type":"disk","size":"512110190592"},{"name":"nvme1n1","type":"disk","size":"1000000000000"}]}`)
	if got, err := parseLsblk(str); err != nil || got != 1512110190592 {
		t.Fatalf("str: got %d err %v", got, err)
	}
	if _, err := parseLsblk([]byte(`not json`)); err == nil {
		t.Fatal("expected error on bad json")
	}
}

func TestParseNvidiaSMI(t *testing.T) {
	out := "NVIDIA GeForce RTX 4090, 24564\nNVIDIA GeForce RTX 4090, 24564\n\n"
	g := parseNvidiaSMI(out)
	if len(g) != 2 || g[0].Name != "NVIDIA GeForce RTX 4090" || g[0].VRAMMiB != 24564 {
		t.Fatalf("got %+v", g)
	}
	if parseNvidiaSMI("") != nil {
		t.Fatal("empty → nil")
	}
}

func TestParseLspciGPUs(t *testing.T) {
	out := `00:02.0 VGA compatible controller: Intel Corporation UHD Graphics 630 (rev 02)
01:00.0 VGA compatible controller: NVIDIA Corporation AD102 [GeForce RTX 4090] (rev a1)
02:00.0 3D controller: NVIDIA Corporation GA100 [A100]
03:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31
04:00.0 Ethernet controller: Intel Corporation I210`
	g := parseLspciGPUs(out)
	// Intel UHD (integrated) excluded; NVIDIA x2 + AMD x1 kept; ethernet ignored.
	if len(g) != 3 {
		t.Fatalf("got %d: %+v", len(g), g)
	}
	for _, x := range g {
		if x.VRAMMiB != 0 {
			t.Errorf("lspci vram should be 0: %+v", x)
		}
	}
	if g[0].Name == "" || g[1].Name == "" {
		t.Fatalf("names empty: %+v", g)
	}
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/agent/hostinfo/ -v`
Expected: FAIL — package/functions don't exist.

- [ ] **Step 4: Implement `internal/agent/hostinfo/hostinfo.go`**

```go
// Package hostinfo collects a server's static hardware inventory. All external
// commands are best-effort with a short timeout; a failure in one field never
// aborts the others.
package hostinfo

import (
	"context"
	"encoding/json"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/mem"
)

const cmdTimeout = 5 * time.Second

// Collect gathers the host inventory, best-effort. Missing tools/fields yield
// zero values rather than errors.
func Collect(ctx context.Context) agentapi.HostInventory {
	var inv agentapi.HostInventory
	if n, err := cpu.Counts(false); err == nil {
		inv.CPUPhysical = n
	}
	if n, err := cpu.Counts(true); err == nil {
		inv.CPULogical = n
	}
	if ci, err := cpu.Info(); err == nil && len(ci) > 0 {
		inv.CPUModel = strings.TrimSpace(ci[0].ModelName)
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		inv.MemTotal = int64(vm.Total)
	}
	if out, err := run(ctx, "lsblk", "-b", "-d", "-o", "NAME,TYPE,SIZE", "--json"); err == nil {
		if total, perr := parseLsblk(out); perr == nil {
			inv.DiskTotal = total
		}
	}
	inv.GPUs = collectGPUs(ctx)
	return inv
}

func collectGPUs(ctx context.Context) []agentapi.GPU {
	if out, err := run(ctx, "nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"); err == nil {
		if g := parseNvidiaSMI(string(out)); len(g) > 0 {
			return g
		}
	}
	if out, err := run(ctx, "lspci"); err == nil {
		return parseLspciGPUs(string(out))
	}
	return nil
}

func run(ctx context.Context, name string, args ...string) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, cmdTimeout)
	defer cancel()
	return exec.CommandContext(cctx, name, args...).Output()
}

func parseLsblk(data []byte) (int64, error) {
	var out struct {
		BlockDevices []struct {
			Type string          `json:"type"`
			Size json.RawMessage `json:"size"`
		} `json:"blockdevices"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return 0, err
	}
	var total int64
	for _, d := range out.BlockDevices {
		if d.Type != "disk" {
			continue
		}
		total += rawToInt64(d.Size)
	}
	return total, nil
}

// rawToInt64 accepts either a JSON number (512) or a quoted string ("512").
func rawToInt64(raw json.RawMessage) int64 {
	s := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

func parseNvidiaSMI(s string) []agentapi.GPU {
	var gpus []agentapi.GPU
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, ",", 2)
		g := agentapi.GPU{Name: strings.TrimSpace(parts[0])}
		if len(parts) == 2 {
			g.VRAMMiB, _ = strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
		}
		if g.Name != "" {
			gpus = append(gpus, g)
		}
	}
	return gpus
}

// parseLspciGPUs extracts discrete-GPU controller descriptions from `lspci`
// output: lines that are a "VGA compatible controller" or "3D controller" whose
// vendor is NVIDIA or AMD/ATI (Intel integrated graphics are excluded).
func parseLspciGPUs(s string) []agentapi.GPU {
	var gpus []agentapi.GPU
	for _, line := range strings.Split(s, "\n") {
		if !strings.Contains(line, "VGA compatible controller") && !strings.Contains(line, "3D controller") {
			continue
		}
		// description is after the second colon: "<slot> <class>: <desc>"
		i := strings.Index(line, ": ")
		if i < 0 {
			continue
		}
		desc := strings.TrimSpace(line[i+2:])
		low := strings.ToLower(desc)
		if strings.Contains(low, "nvidia") || strings.Contains(low, "amd") || strings.Contains(low, "ati") || strings.Contains(low, "advanced micro devices") {
			gpus = append(gpus, agentapi.GPU{Name: desc})
		}
	}
	return gpus
}
```

- [ ] **Step 5: Add a tolerance sanity test** (Collect works with no external tools — CPU/mem still populate). Append to `hostinfo_test.go`:

```go
func TestCollect_PopulatesCPUMem(t *testing.T) {
	inv := Collect(testContext())
	if inv.CPULogical <= 0 {
		t.Fatalf("expected logical CPUs > 0, got %d", inv.CPULogical)
	}
	if inv.MemTotal <= 0 {
		t.Fatalf("expected mem total > 0, got %d", inv.MemTotal)
	}
	// disk/gpu may be 0 on CI (no lsblk/nvidia-smi) — not asserted.
}
```
Add the import `"context"` and a helper at the top of the test file:
```go
func testContext() context.Context { return context.Background() }
```

- [ ] **Step 6: Run to verify pass + vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/agent/hostinfo/ -v && go vet ./internal/agent/hostinfo/ ./internal/agentapi/`
Expected: PASS; vet clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/agentapi/types.go internal/agent/hostinfo/
git commit -m "feat(agent): hostinfo collector + host.inventory wire types"
```

---

## Task 2: Agent sends inventory on WS connect

**Files:**
- Modify: `internal/agent/wsclient/client.go`
- Modify: `cmd/agent/main.go`

- [ ] **Step 1: Add a `HostInventory` field to the wsclient Client**

In `internal/agent/wsclient/client.go`, add to the `Client` struct (near the other injected fields like `TrafficSampler`):
```go
	// HostInventory is the static hardware inventory, collected once at startup
	// and sent on each WS (re)connect.
	HostInventory agentapi.HostInventory
```

- [ ] **Step 2: Send it once per connect** — in `dialAndRun`, immediately AFTER the first-heartbeat write block (the `if err := c.writeJSON(hb); err != nil { return err }` that sends the heartbeat with IPCandidates), add:
```go
	if env, err := agentapi.Frame(agentapi.TypeHostInventory, c.HostInventory); err == nil {
		_ = c.writeJSON(env) // best-effort; inventory is static and re-sent next connect
	}
```

- [ ] **Step 3: Collect inventory at agent startup** — in `cmd/agent/main.go`, where the `wsclient.Client` is constructed (search for `wsclient.Client{` or `&wsclient.Client{`), set the field from `hostinfo.Collect`. Add the import `"github.com/hg-claw/Shepherd/internal/agent/hostinfo"`, and after the client is built (before `client.Run(ctx)` / the run loop), set:
```go
	client.HostInventory = hostinfo.Collect(ctx)
```
(If the client is constructed as a composite literal, instead set `HostInventory: hostinfo.Collect(ctx)` inline — but a slow collect should not block construction of unrelated fields, so a separate assignment line right before the run loop is preferred. `Collect` is bounded by `cmdTimeout` per external command.)

> Implementer note: read `cmd/agent/main.go` to find the exact construction site and the `ctx` in scope. If the agent has no long-lived `ctx` at that point, use `context.Background()`.

- [ ] **Step 4: Build + vet**

Run: `cd /Users/hg/project/Shepherd && go build ./... && go vet ./internal/agent/wsclient/ ./cmd/agent/`
Expected: build OK; vet clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/agent/wsclient/client.go cmd/agent/main.go
git commit -m "feat(agent): collect host inventory at startup, send on WS connect"
```

---

## Task 3: Server migration + ingest + query

**Files:**
- Create: `internal/db/migrations/postgres/0007_host_inventory.up.sql`
- Create: `internal/db/migrations/postgres/0007_host_inventory.down.sql`
- Create: `internal/db/migrations/sqlite/0007_host_inventory.up.sql`
- Create: `internal/db/migrations/sqlite/0007_host_inventory.down.sql`
- Modify: `internal/telemetrysvc/ingest.go`
- Create: `internal/telemetrysvc/inventory.go`
- Test: `internal/telemetrysvc/inventory_test.go`

- [ ] **Step 1: Create the migrations**

`internal/db/migrations/postgres/0007_host_inventory.up.sql`:
```sql
CREATE TABLE host_inventory (
  server_id     BIGINT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  cpu_physical  INTEGER,
  cpu_logical   INTEGER,
  cpu_model     TEXT,
  mem_total     BIGINT,
  disk_total    BIGINT,
  gpus_json     TEXT,
  updated_at    TIMESTAMPTZ NOT NULL
);
```
`internal/db/migrations/postgres/0007_host_inventory.down.sql`:
```sql
DROP TABLE host_inventory;
```
`internal/db/migrations/sqlite/0007_host_inventory.up.sql`:
```sql
CREATE TABLE host_inventory (
  server_id     INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  cpu_physical  INTEGER,
  cpu_logical   INTEGER,
  cpu_model     TEXT,
  mem_total     INTEGER,
  disk_total    INTEGER,
  gpus_json     TEXT,
  updated_at    TIMESTAMP NOT NULL
);
```
`internal/db/migrations/sqlite/0007_host_inventory.down.sql`:
```sql
DROP TABLE host_inventory;
```

- [ ] **Step 2: Write failing ingest+query test** in `internal/telemetrysvc/inventory_test.go`. First read an existing telemetrysvc test (e.g. an ingest test) to learn the test-DB helper (how it opens a migrated DB + seeds a `servers` row). Mirror it. The test must:
```go
func TestHostInventory_UpsertAndQuery(t *testing.T) {
	// <build a migrated test DB `db` + insert a servers row id=1 — mirror sibling tests>
	ing := &Ingest{DB: db}
	q := &Query{DB: db}
	ctx := context.Background()

	inv := agentapi.HostInventory{
		CPUPhysical: 4, CPULogical: 8, CPUModel: "Xeon E5",
		MemTotal: 16 << 30, DiskTotal: 512 << 30,
		GPUs: []agentapi.GPU{{Name: "RTX 4090", VRAMMiB: 24564}},
	}
	if err := ing.WriteHostInventory(ctx, 1, inv); err != nil {
		t.Fatal(err)
	}
	row, err := q.HostInventory(ctx, 1)
	if err != nil || row == nil {
		t.Fatalf("query: row=%v err=%v", row, err)
	}
	if row.CPUPhysical != 4 || row.CPULogical != 8 || row.MemTotal != 16<<30 || row.DiskTotal != 512<<30 {
		t.Fatalf("row mismatch: %+v", row)
	}
	if row.GPUsJSON == "" || !strings.Contains(row.GPUsJSON, "RTX 4090") {
		t.Fatalf("gpus_json: %q", row.GPUsJSON)
	}
	// upsert: a second write updates in place (no duplicate-PK error)
	inv.CPULogical = 16
	if err := ing.WriteHostInventory(ctx, 1, inv); err != nil {
		t.Fatal(err)
	}
	row, _ = q.HostInventory(ctx, 1)
	if row.CPULogical != 16 {
		t.Fatalf("upsert did not update: %+v", row)
	}
	// missing server → nil, no error
	if r, err := q.HostInventory(ctx, 999); err != nil || r != nil {
		t.Fatalf("missing: r=%v err=%v", r, err)
	}
}
```
(Add imports `context`, `strings`, `testing`, and the agentapi import + the test-DB helper package the sibling tests use.)

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/telemetrysvc/ -run TestHostInventory_UpsertAndQuery -v`
Expected: FAIL — `WriteHostInventory`/`HostInventory`/`HostInventoryRow` undefined.

- [ ] **Step 4: Add the query + row type** — create `internal/telemetrysvc/inventory.go`:
```go
package telemetrysvc

import (
	"context"
	"database/sql"
	"errors"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// HostInventoryRow is the stored inventory for one server.
type HostInventoryRow struct {
	ServerID    int64  `db:"server_id"    json:"server_id"`
	CPUPhysical int    `db:"cpu_physical" json:"cpu_physical"`
	CPULogical  int    `db:"cpu_logical"  json:"cpu_logical"`
	CPUModel    string `db:"cpu_model"    json:"cpu_model"`
	MemTotal    int64  `db:"mem_total"    json:"mem_total"`
	DiskTotal   int64  `db:"disk_total"   json:"disk_total"`
	GPUsJSON    string `db:"gpus_json"    json:"-"`
}

// HostInventory returns the stored inventory for a server, or nil if none.
func (q *Query) HostInventory(ctx context.Context, serverID int64) (*HostInventoryRow, error) {
	var row HostInventoryRow
	err := q.DB.GetContext(ctx, &row,
		`SELECT server_id, cpu_physical, cpu_logical, cpu_model, mem_total, disk_total, gpus_json
		   FROM host_inventory WHERE server_id=$1`, serverID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}
```

- [ ] **Step 5: Add `WriteHostInventory` + the ingest case** — in `internal/telemetrysvc/ingest.go`:

Add the write function (near `WriteSample`):
```go
// WriteHostInventory upserts the static hardware inventory for a server.
func (i *Ingest) WriteHostInventory(ctx context.Context, serverID int64, inv agentapi.HostInventory) error {
	gpusJSON, _ := json.Marshal(inv.GPUs)
	_, err := i.DB.ExecContext(ctx, `INSERT INTO host_inventory
		(server_id, cpu_physical, cpu_logical, cpu_model, mem_total, disk_total, gpus_json, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (server_id) DO UPDATE SET
		  cpu_physical=EXCLUDED.cpu_physical, cpu_logical=EXCLUDED.cpu_logical,
		  cpu_model=EXCLUDED.cpu_model, mem_total=EXCLUDED.mem_total,
		  disk_total=EXCLUDED.disk_total, gpus_json=EXCLUDED.gpus_json,
		  updated_at=EXCLUDED.updated_at`,
		serverID, inv.CPUPhysical, inv.CPULogical, inv.CPUModel, inv.MemTotal, inv.DiskTotal,
		string(gpusJSON), time.Now().UTC())
	return err
}
```
Add a case to the `HandleFrame` switch (after `TypeNetqualityBatch`):
```go
	case agentapi.TypeHostInventory:
		var inv agentapi.HostInventory
		if err := env.Decode(&inv); err != nil {
			log.Printf("host.inventory decode (server=%d): %v", serverID, err)
			return
		}
		if err := i.WriteHostInventory(ctx, serverID, inv); err != nil {
			log.Printf("host.inventory write (server=%d): %v", serverID, err)
		}
```
(`encoding/json` and `time` are already imported in ingest.go.)

- [ ] **Step 6: Run to verify pass + full package**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/telemetrysvc/ -v && gofmt -l internal/telemetrysvc/ && go vet ./internal/telemetrysvc/`
Expected: PASS; gofmt empty; vet clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/db/migrations/ internal/telemetrysvc/ingest.go internal/telemetrysvc/inventory.go internal/telemetrysvc/inventory_test.go
git commit -m "feat(telemetry): host_inventory table + upsert ingest + query"
```

---

## Task 4: Server API endpoint

**Files:**
- Modify: `internal/api/admin_servers.go`
- Modify: `internal/api/router.go`
- Test: `internal/api/admin_servers_test.go`

- [ ] **Step 1: Write failing handler test** in `internal/api/admin_servers_test.go` (mirror the existing telemetry/servers test harness in that file — read it for how it builds `ServersAPI` + a migrated DB + seeds a server). The test:
```go
func TestServersAPI_Inventory(t *testing.T) {
	// <build ServersAPI `a` with a migrated DB + a servers row id=1 — mirror sibling tests>
	// seed an inventory row
	ing := &telemetrysvc.Ingest{DB: a.Query.DB}
	_ = ing.WriteHostInventory(context.Background(), 1, agentapi.HostInventory{
		CPUPhysical: 4, CPULogical: 8, CPUModel: "Xeon", MemTotal: 1 << 30, DiskTotal: 2 << 30,
		GPUs: []agentapi.GPU{{Name: "RTX 4090", VRAMMiB: 24564}},
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/servers/1/inventory", nil)
	a.Inventory(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{`"cpu_physical":4`, `"cpu_logical":8`, `"disk_total":2147483648`, `"RTX 4090"`, `"vram_mib":24564`} {
		if !strings.Contains(body, want) {
			t.Errorf("body missing %q: %s", want, body)
		}
	}

	// no inventory → null body, 200
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("GET", "/api/servers/2/inventory", nil)
	a.Inventory(rec2, req2)
	if rec2.Code != 200 || strings.TrimSpace(rec2.Body.String()) != "null" {
		t.Fatalf("missing inventory: code=%d body=%q", rec2.Code, rec2.Body.String())
	}
}
```
(`a.Query.DB` accessor: if `Query` is unexported-DB, instead reuse whatever DB handle the harness exposes — mirror how sibling tests reach the DB. The essential checks: 200 + the fields incl. parsed `gpus`; null for a server with no inventory.)

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/api/ -run TestServersAPI_Inventory -v`
Expected: FAIL — `a.Inventory` undefined.

- [ ] **Step 3: Add the `Inventory` handler** to `internal/api/admin_servers.go` (after `Telemetry`):
```go
// inventoryResponse is the inventory row with GPUs parsed for the client.
type inventoryResponse struct {
	*telemetrysvc.HostInventoryRow
	GPUs []agentapi.GPU `json:"gpus"`
}

func (a *ServersAPI) Inventory(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID2(r, "/api/servers/", "/inventory")
	if !ok {
		writeError(w, 400, "bad path")
		return
	}
	row, err := a.Query.HostInventory(r.Context(), id)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	if row == nil {
		writeJSON(w, 200, nil)
		return
	}
	var gpus []agentapi.GPU
	_ = json.Unmarshal([]byte(row.GPUsJSON), &gpus)
	writeJSON(w, 200, inventoryResponse{HostInventoryRow: row, GPUs: gpus})
}
```
Add imports to `admin_servers.go` if missing: `"encoding/json"` and `"github.com/hg-claw/Shepherd/internal/agentapi"`.

- [ ] **Step 4: Register the route** — in `internal/api/router.go`, immediately after the line `admin.HandleFunc("GET /api/servers/{id}/telemetry", r.Servers.Telemetry)`:
```go
	admin.HandleFunc("GET /api/servers/{id}/inventory", r.Servers.Inventory)
```

- [ ] **Step 5: Run to verify pass + vet/gofmt**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/api/ -run TestServersAPI_Inventory -v && go test ./internal/api/ && gofmt -l internal/api/admin_servers.go internal/api/router.go && go vet ./internal/api/`
Expected: PASS; gofmt empty; vet clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/api/admin_servers.go internal/api/router.go internal/api/admin_servers_test.go
git commit -m "feat(api): GET /api/servers/{id}/inventory"
```

---

## Task 5: Admin UI — Hardware card

**Files:**
- Modify: `web/src/api/servers.ts`
- Modify: `web/src/pages/admin/ServerDetail.tsx`
- Test: `web/src/pages/admin/ServerDetail.test.tsx` (create if absent; else extend)

- [ ] **Step 1: Add types + hook** to `web/src/api/servers.ts`:
```ts
export type GPU = { name: string; vram_mib: number }
export type HostInventory = {
  server_id: number
  cpu_physical: number
  cpu_logical: number
  cpu_model: string
  mem_total: number
  disk_total: number
  gpus: GPU[]
}

export function useHostInventory(id: number) {
  return useQuery({
    queryKey: ['host-inventory', id],
    queryFn: () => api.get<HostInventory | null>(`/api/servers/${id}/inventory`),
    enabled: !!id,
    staleTime: 60_000, // static; no aggressive refetch
  })
}
```

- [ ] **Step 2: Render a Hardware card** in `web/src/pages/admin/ServerDetail.tsx`. First read the file to match the existing Card/KV markup (it uses a Card with rows of key/value). Add, near the Identity card:
```tsx
const inv = useHostInventory(id)
```
and a card (mirror the identity card's components/classes; helper `bytes()`/humanizer likely already exists in the file or a util — reuse it; if not, format with a small inline helper):
```tsx
<Card>
  <CardHeader><CardTitle>Hardware</CardTitle></CardHeader>
  <CardContent>
    {!inv.data ? (
      <p className="text-muted-foreground text-[12px]">—</p>
    ) : (
      <>
        <KV k="CPU" v={`${inv.data.cpu_physical} 物理核 / ${inv.data.cpu_logical} 线程${inv.data.cpu_model ? ` · ${inv.data.cpu_model}` : ''}`} />
        <KV k="Memory" v={bytes(inv.data.mem_total)} />
        <KV k="Disk" v={bytes(inv.data.disk_total)} />
        <KV k="GPU" v={inv.data.gpus.length === 0 ? '无独立显卡' : inv.data.gpus.map((g) => g.vram_mib > 0 ? `${g.name} (${Math.round(g.vram_mib / 1024)}GB)` : g.name).join(', ')} />
      </>
    )}
  </CardContent>
</Card>
```
> Implementer note: use the file's ACTUAL `Card`/`CardHeader`/`CardContent`/`CardTitle`/`KV` components and its existing byte-humanizer (check imports at the top of ServerDetail.tsx). If there is no `KV` component, mirror however the identity card renders key/value rows. If no byte humanizer exists, add a tiny local `function bytes(n: number)` (GiB/MiB).

- [ ] **Step 3: Add a vitest** to `web/src/pages/admin/ServerDetail.test.tsx` (mirror the file's existing render harness + how it mocks `api.get` per path). The test: mock `/api/servers/{id}/inventory` to return an inventory with one GPU; assert the card shows "物理核", the CPU model, and the GPU name. Add a second case: inventory `null` → card shows "—"; and an empty-`gpus` case → "无独立显卡".
> Implementer note: match how sibling ServerDetail tests stub fetches (the file may mock the `useHostInventory`/`api` layer). If ServerDetail has no existing test file/harness, add a focused test that renders the Hardware card subtree with a mocked hook return, asserting the three states (data / null / empty-gpus).

- [ ] **Step 4: Run vitest + tsc**

Run: `cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/ServerDetail.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add web/src/api/servers.ts web/src/pages/admin/ServerDetail.tsx web/src/pages/admin/ServerDetail.test.tsx
git commit -m "feat(web): Hardware inventory card on ServerDetail"
```

---

## Task 6: Full verification

- [ ] **Step 1: Full Go suite (with -race) + vet + build**

Run: `cd /Users/hg/project/Shepherd && go build ./... && go test -race ./internal/telemetrysvc/... ./internal/agent/... ./internal/api/... && go test ./... && go vet ./...`
Expected: build OK; race-clean; all packages PASS; vet clean.

- [ ] **Step 2: gofmt on changed Go files**

Run: `cd /Users/hg/project/Shepherd && gofmt -l internal/agentapi/types.go internal/agent/hostinfo/ internal/agent/wsclient/client.go cmd/agent/main.go internal/telemetrysvc/ internal/api/admin_servers.go internal/api/router.go`
Expected: prints nothing.

- [ ] **Step 3: Frontend tsc + full vitest**

Run: `cd /Users/hg/project/Shepherd/web && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all suites PASS.

- [ ] **Step 4: Restore embed artifact if touched + clean tree**

Run: `cd /Users/hg/project/Shepherd && git checkout -- internal/web/dist/.gitkeep 2>/dev/null; git status --short`
Expected: clean.

---

## Self-Review Notes

- **Spec coverage:** CPU phys/logical/model + mem + disk(lsblk) + GPU(nvidia-smi→lspci) collection (Task 1) ✓; degrade-gracefully best-effort (Task 1 Collect, each source independent) ✓; `host.inventory` envelope sent once per WS connect (Task 2) ✓; core `0007_host_inventory` upsert table + ingest case + query (Task 3) ✓; `GET /api/servers/{id}/inventory` with parsed gpus + null when absent (Task 4) ✓; Hardware card with no-inventory/"无独立显卡" states (Task 5) ✓; verification incl. `-race` (Task 6) ✓. Out-of-scope (B/C, per-disk detail, server-list display) intentionally absent.
- **Type consistency:** `agentapi.HostInventory{CPUPhysical,CPULogical,CPUModel,MemTotal,DiskTotal,GPUs []GPU}` + `agentapi.GPU{Name,VRAMMiB}` used identically in hostinfo (Task 1), wsclient (Task 2), ingest/query (Task 3 `HostInventoryRow.GPUsJSON`), API (Task 4 parses `GPUsJSON`→`gpus`), TS `HostInventory`/`GPU` (Task 5). Envelope const `TypeHostInventory="host.inventory"` shared agent↔server.
- **Migration:** core `0007` (next after `0006`), both dialects, FK to servers ON DELETE CASCADE, portable `INSERT ... ON CONFLICT(server_id) DO UPDATE` upsert (sqlite + postgres both support it).
- **Degradation/safety:** external commands use a 5s `CommandContext` timeout; parser errors → zero values; CI (no lsblk/nvidia-smi) still passes via the CPU/mem sanity test.
- **CI gate:** Task 6 runs `go test -race`.
