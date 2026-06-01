# Perf Cluster (Audit Round A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the public-wall/admin-list N+1 queries, make telemetry ingest transactional, fix the file-preview goroutine leak, bound batch agent-installs to 20, and make the ServerList row click a client-side navigation.

**Architecture:** New `*ForAll(ids)` batch query helpers (window function + `sqlx.In`/`Rebind`, portable across SQLite+Postgres) return maps keyed by `server_id`; the wall/admin handlers index them with a missing→default fallback. `WriteSample` wraps its three writes in one transaction. `Preview` gets a small cancel-on-return pipe helper. `BatchUpdateAgent` routes its background installs through a shared bounded semaphore.

**Tech Stack:** Go 1.25 (sqlx, sqlite/postgres), React + react-router (vitest).

**Spec:** `docs/superpowers/specs/2026-05-31-perf-cluster-round-a-design.md`

**Order:** helpers (1–3) → consumers (4–5) → independent fixes (6–8) → frontend (9) → gates (10).

---

## File Structure

- `internal/telemetrysvc/query.go` — `LatestForAll` + `latestRow` (Task 1).
- `internal/telemetrysvc/traffic.go` — `HostTrafficForAll` (Task 2).
- `internal/plugins/netquality/public.go` — `LatestPerISPForAll` (Task 3).
- `internal/api/public.go` + `cmd/server/main.go` — batch the wall + wire `NetqualitySummaryForAll` (Task 4).
- `internal/api/admin_servers.go` — batch the admin list; install semaphore (Tasks 5, 8).
- `internal/telemetrysvc/ingest.go` — `WriteSample` transaction (Task 6).
- `internal/api/files_routes.go` — `previewRead` helper (Task 7).
- `web/src/pages/admin/ServerList.tsx` — `navigate()` (Task 9).

---

## Task 1: `LatestForAll` batch helper

**Files:**
- Modify: `internal/telemetrysvc/query.go`
- Test: `internal/telemetrysvc/query_test.go`

- [ ] **Step 1: Write the failing test**

Append to `internal/telemetrysvc/query_test.go`:

```go
func TestLatestForAll(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	mk := func(name string) int64 {
		res, _ := d.Exec("INSERT INTO servers(name) VALUES ($1)", name)
		id, _ := res.LastInsertId()
		return id
	}
	s1, s2, s3 := mk("a"), mk("b"), mk("c")
	ing := &Ingest{DB: d}
	now := time.Now().UTC()
	// s1: three samples, newest has cpu=9; s2: one sample; s3: none.
	_ = ing.WriteSample(context.Background(), s1, agentapi.Telemetry{TS: now.Add(-2 * time.Minute), CPUPct: 1})
	_ = ing.WriteSample(context.Background(), s1, agentapi.Telemetry{TS: now, CPUPct: 9})
	_ = ing.WriteSample(context.Background(), s1, agentapi.Telemetry{TS: now.Add(-1 * time.Minute), CPUPct: 5})
	_ = ing.WriteSample(context.Background(), s2, agentapi.Telemetry{TS: now, CPUPct: 7})

	q := &Query{DB: d}
	m, err := q.LatestForAll(context.Background(), []int64{s1, s2, s3})
	if err != nil {
		t.Fatal(err)
	}
	if len(m) != 2 {
		t.Fatalf("want 2 entries (s3 has no data), got %d", len(m))
	}
	if m[s1] == nil || m[s1].CPU == nil || *m[s1].CPU != 9 {
		t.Fatalf("s1 latest cpu wrong: %+v", m[s1])
	}
	if m[s2] == nil || m[s2].CPU == nil || *m[s2].CPU != 7 {
		t.Fatalf("s2 latest cpu wrong: %+v", m[s2])
	}
	if _, ok := m[s3]; ok {
		t.Fatalf("s3 should be absent")
	}
	// empty ids → empty map, no query
	em, err := q.LatestForAll(context.Background(), nil)
	if err != nil || len(em) != 0 {
		t.Fatalf("empty ids: m=%v err=%v", em, err)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/telemetrysvc/ -run TestLatestForAll -v`
Expected: FAIL — `q.LatestForAll undefined`.

- [ ] **Step 3: Implement**

In `internal/telemetrysvc/query.go`, ensure the import block has `"github.com/jmoiron/sqlx"` (the `Query` struct already uses `*sqlx.DB`, so it's imported). Add after the existing `Latest` method:

```go
// latestRow scans one server's latest sample. The embedded Point carries the
// metric columns (by their db tags); ServerID is the partition key for folding
// the flat result set into a per-server map.
type latestRow struct {
	ServerID int64 `db:"server_id"`
	Point
}

// LatestForAll returns the most recent sample per server for the given ids,
// keyed by server_id. Ids with no samples are absent from the map. Empty ids
// returns an empty map without querying. One query (window function), portable
// across the SQLite and Postgres drivers.
func (q *Query) LatestForAll(ctx context.Context, ids []int64) (map[int64]*Point, error) {
	out := map[int64]*Point{}
	if len(ids) == 0 {
		return out, nil
	}
	query, args, err := sqlx.In(`
		SELECT server_id, ts, cpu, mem_used, mem_total, load_1,
		       net_rx_bps, net_tx_bps, tcp_conn, disks_json
		FROM (
			SELECT server_id, ts, cpu_pct AS cpu, mem_used, mem_total, load_1,
			       net_rx_bps, net_tx_bps, tcp_conn, disks_json,
			       ROW_NUMBER() OVER (PARTITION BY server_id ORDER BY ts DESC) AS rn
			FROM telemetry_samples_30s
			WHERE server_id IN (?)
		) ranked
		WHERE rn = 1`, ids)
	if err != nil {
		return nil, err
	}
	query = q.DB.Rebind(query)
	var rows []latestRow
	if err := q.DB.SelectContext(ctx, &rows, query, args...); err != nil {
		return nil, err
	}
	for i := range rows {
		p := rows[i].Point
		out[rows[i].ServerID] = &p
	}
	return out, nil
}
```

- [ ] **Step 4: Run to verify pass**

Run: `go test ./internal/telemetrysvc/ -run 'TestLatestForAll|TestQuery' -v`
Expected: PASS. Then `gofmt -l internal/telemetrysvc/query.go` (nothing), `go vet ./internal/telemetrysvc/`.

- [ ] **Step 5: Commit**

```bash
git add internal/telemetrysvc/query.go internal/telemetrysvc/query_test.go
git commit -m "perf(telemetry): LatestForAll batch helper (one window query, no N+1)"
```

---

## Task 2: `HostTrafficForAll` batch helper

**Files:**
- Modify: `internal/telemetrysvc/traffic.go`
- Test: `internal/telemetrysvc/traffic_test.go`

- [ ] **Step 1: Write the failing test**

Append to `internal/telemetrysvc/traffic_test.go` (it is in `package telemetrysvc`; ensure imports include `context`, `path/filepath`, `testing`, `time`, `github.com/hg-claw/Shepherd/internal/agentapi`, `shepdb "github.com/hg-claw/Shepherd/internal/db"` — add any missing):

```go
func TestHostTrafficForAll(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	mk := func(name string) int64 {
		res, _ := d.Exec("INSERT INTO servers(name) VALUES ($1)", name)
		id, _ := res.LastInsertId()
		return id
	}
	s1, s2 := mk("a"), mk("b")
	ing := &Ingest{DB: d}
	// s1 accrues traffic; s2 never reports any.
	_ = ing.WriteSample(context.Background(), s1, agentapi.Telemetry{TS: time.Now().UTC(), NetRxBytes: 1000, NetTxBytes: 500})

	q := &Query{DB: d}
	m, err := q.HostTrafficForAll(context.Background(), []int64{s1, s2})
	if err != nil {
		t.Fatal(err)
	}
	if m[s1] == nil || m[s1].CumBytesDown != 1000 || m[s1].CumBytesUp != 500 {
		t.Fatalf("s1 traffic wrong: %+v", m[s1])
	}
	if _, ok := m[s2]; ok {
		t.Fatalf("s2 has no row, should be absent (caller defaults)")
	}
	em, err := q.HostTrafficForAll(context.Background(), nil)
	if err != nil || len(em) != 0 {
		t.Fatalf("empty ids: m=%v err=%v", em, err)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/telemetrysvc/ -run TestHostTrafficForAll -v`
Expected: FAIL — `q.HostTrafficForAll undefined`.

- [ ] **Step 3: Implement**

In `internal/telemetrysvc/traffic.go`, add `"github.com/jmoiron/sqlx"` to imports if not present, and add after `HostTraffic`:

```go
// HostTrafficForAll returns the host_traffic row per server for the given ids,
// keyed by server_id. Ids with no row are absent from the map (the caller
// supplies the same default the single-row HostTraffic uses: {ServerID, ResetDay:1}).
func (q *Query) HostTrafficForAll(ctx context.Context, ids []int64) (map[int64]*HostTrafficRow, error) {
	out := map[int64]*HostTrafficRow{}
	if len(ids) == 0 {
		return out, nil
	}
	query, args, err := sqlx.In(`SELECT server_id, cum_bytes_up, cum_bytes_down,
		prev_bytes_up, prev_bytes_down, reset_day, last_reset_at
		FROM host_traffic WHERE server_id IN (?)`, ids)
	if err != nil {
		return nil, err
	}
	query = q.DB.Rebind(query)
	var rows []HostTrafficRow
	if err := q.DB.SelectContext(ctx, &rows, query, args...); err != nil {
		return nil, err
	}
	for i := range rows {
		r := rows[i]
		out[r.ServerID] = &r
	}
	return out, nil
}
```

- [ ] **Step 4: Run to verify pass**

Run: `go test ./internal/telemetrysvc/ -run 'TestHostTraffic' -v`
Expected: PASS. Then `gofmt -l internal/telemetrysvc/traffic.go`, `go vet ./internal/telemetrysvc/`.

- [ ] **Step 5: Commit**

```bash
git add internal/telemetrysvc/traffic.go internal/telemetrysvc/traffic_test.go
git commit -m "perf(telemetry): HostTrafficForAll batch helper"
```

---

## Task 3: `LatestPerISPForAll` netquality batch helper

**Files:**
- Modify: `internal/plugins/netquality/public.go`
- Test: `internal/plugins/netquality/public_test.go` (create if absent; otherwise append)

- [ ] **Step 1: Write the failing test**

First read the TOP of `internal/plugins/netquality/public.go` for its imports and how existing tests build a DB (look for a `*_test.go` in that package using `shepdb.Open`+`Migrate`; the netquality migrations run via `shepdb.Migrate`). Create `internal/plugins/netquality/public_batch_test.go`:

```go
package netquality

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func TestLatestPerISPForAll(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	mk := func(name string) int64 {
		res, _ := d.Exec("INSERT INTO servers(name) VALUES ($1)", name)
		id, _ := res.LastInsertId()
		return id
	}
	s1, s2 := mk("a"), mk("b")
	now := time.Now().UTC()
	// Enable both hosts; add one enabled target + a recent ok sample for s1 only.
	d.Exec(`INSERT INTO netquality_hosts(server_id, enabled) VALUES ($1,true),($2,true)`, s1, s2)
	res, _ := d.Exec(`INSERT INTO netquality_targets(isp, host, enabled) VALUES ('telecom','1.1.1.1',true)`)
	tid, _ := res.LastInsertId()
	d.Exec(`INSERT INTO netquality_samples_raw(server_id, target_id, ts, rtt_avg_ms, loss_pct, status)
		VALUES ($1,$2,$3,20,0,'ok')`, s1, tid, now)

	m := LatestPerISPForAll(context.Background(), d, []int64{s1, s2})
	if len(m[s1]) != 1 || m[s1][0].ISP != "telecom" {
		t.Fatalf("s1 summary wrong: %+v", m[s1])
	}
	if len(m[s2]) != 0 {
		t.Fatalf("s2 has no samples, want empty, got %+v", m[s2])
	}
}
```

NOTE: verify the exact column names of `netquality_hosts`, `netquality_targets`, `netquality_samples_raw` against the package's migrations before running — adjust the INSERTs to match the real schema (the SELECT in `LatestPerISP` references `netquality_targets(isp, enabled)`, `netquality_samples_raw(server_id, target_id, ts, rtt_avg_ms, loss_pct, status)`, `netquality_hosts(server_id, enabled)`).

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/plugins/netquality/ -run TestLatestPerISPForAll -v`
Expected: FAIL — `LatestPerISPForAll undefined`.

- [ ] **Step 3: Implement**

In `internal/plugins/netquality/public.go` add `"github.com/jmoiron/sqlx"` to imports if missing, and add:

```go
// ispRow scans one (server, ISP) summary cell for the batch query.
type ispRow struct {
	ServerID int64   `db:"server_id"`
	ISP      string  `db:"isp"`
	RTTAvgMs float64 `db:"rtt_avg_ms"`
	LossPct  float64 `db:"loss_pct"`
}

// LatestPerISPForAll is the batch analogue of LatestPerISP: one grouped query
// over the id set, returning per-server ISP summaries keyed by server_id. Hosts
// not enabled (or with no recent ok samples) are absent from the map. Returns an
// empty map — never an error — so the public wall never 500s on us.
func LatestPerISPForAll(ctx context.Context, db *sqlx.DB, ids []int64) map[int64][]ISPSummary {
	out := map[int64][]ISPSummary{}
	if len(ids) == 0 {
		return out
	}
	cutoff := time.Now().UTC().Add(-1 * time.Duration(LookbackSeconds) * time.Second)
	query, args, err := sqlx.In(`
		SELECT s.server_id AS server_id, t.isp AS isp,
		       AVG(s.rtt_avg_ms) AS rtt_avg_ms,
		       AVG(s.loss_pct)   AS loss_pct
		  FROM netquality_targets t
		  JOIN netquality_samples_raw s ON s.target_id = t.id
		  JOIN netquality_hosts h ON h.server_id = s.server_id
		 WHERE s.server_id IN (?)
		   AND h.enabled = true
		   AND t.enabled = true
		   AND s.ts > ?
		   AND s.status = 'ok'
		 GROUP BY s.server_id, t.isp
		 ORDER BY s.server_id, t.isp`, ids, cutoff)
	if err != nil {
		return out
	}
	query = db.Rebind(query)
	var rows []ispRow
	if err := db.SelectContext(ctx, &rows, query, args...); err != nil {
		return out // tables missing / plugin never enabled → empty
	}
	for _, r := range rows {
		out[r.ServerID] = append(out[r.ServerID], ISPSummary{ISP: r.ISP, RTTAvgMs: r.RTTAvgMs, LossPct: r.LossPct})
	}
	return out
}
```

- [ ] **Step 4: Run to verify pass**

Run: `go test ./internal/plugins/netquality/ -run TestLatestPerISPForAll -v`
Expected: PASS. Then `gofmt -l` + `go vet ./internal/plugins/netquality/`.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/netquality/public.go internal/plugins/netquality/public_batch_test.go
git commit -m "perf(netquality): LatestPerISPForAll batch helper"
```

---

## Task 4: Batch the public wall + wire NetqualitySummaryForAll

**Files:**
- Modify: `internal/api/public.go` (struct field + `Servers_ListPublic`)
- Modify: `cmd/server/main.go` (wire the batch func)

- [ ] **Step 1: Add the batch func field**

In `internal/api/public.go`, next to the existing `NetqualitySummary func(...)` field on `PublicAPI`, add:

```go
	// NetqualitySummaryForAll is the batch form used by the wall list; nil when
	// the netquality plugin isn't wired. Keyed by server_id; absent → no data.
	NetqualitySummaryForAll func(ctx context.Context, ids []int64) map[int64][]NetqualityISPSummary
```

- [ ] **Step 2: Rewrite `Servers_ListPublic` to batch**

Replace the `out := []publicCard{}` loop body in `Servers_ListPublic` so the per-row `a.Query.Latest`, `a.Query.HostTraffic`, and `a.NetqualitySummary` calls become three batch lookups. The new shape:

```go
	out := []publicCard{}
	ids := make([]int64, 0, len(all))
	for _, s := range all {
		if s.ShowOnPublic {
			ids = append(ids, s.ID)
		}
	}
	latestByID, _ := a.Query.LatestForAll(r.Context(), ids)
	trafficByID, _ := a.Query.HostTrafficForAll(r.Context(), ids)
	var nqByID map[int64][]NetqualityISPSummary
	if a.NetqualitySummaryForAll != nil {
		nqByID = a.NetqualitySummaryForAll(r.Context(), ids)
	}

	for _, s := range all {
		if !s.ShowOnPublic {
			continue
		}
		alias := s.PublicAlias.String
		if !s.PublicAlias.Valid || alias == "" {
			alias = s.Name
		}
		card := publicCard{
			ID:          s.ID,
			Alias:       alias,
			Group:       s.PublicGroup.String,
			CountryCode: s.CountryCode.String,
			Online:      s.AgentLastSeen.Valid && time.Since(s.AgentLastSeen.Time) <= threshold,
		}
		if pt := latestByID[s.ID]; pt != nil {
			card.Latest = renderLatest(pt)
		}
		if s.AgentOS.Valid {
			card.Platform = s.AgentOS.String
		}
		if s.AgentArch.Valid {
			card.Arch = s.AgentArch.String
		}
		// HostTraffic absent → default {ResetDay:1}: cumulative totals are zero,
		// matching the single-row helper's ErrNoRows default.
		if tr := trafficByID[s.ID]; tr != nil {
			card.TrafficRxBytes = tr.CumBytesDown
			card.TrafficTxBytes = tr.CumBytesUp
		}
		if nq := nqByID[s.ID]; len(nq) > 0 {
			card.Netquality = nq
		}
		out = append(out, card)
	}
	writeJSON(w, 200, out)
```

(Keep the `intervalSecs`/`threshold` computation above unchanged. Remove the now-unused per-row `a.Query.Latest`/`HostTraffic`/`NetqualitySummary` calls. Leave the `a.NetqualitySummary` field and other handlers untouched — only the wall list switches to the batch form.)

- [ ] **Step 3: Wire `NetqualitySummaryForAll` in main.go**

In `cmd/server/main.go`, right after the existing `public.NetqualitySummary = func(...) {...}` assignment (~line 207–217), add:

```go
	public.NetqualitySummaryForAll = func(ctx context.Context, ids []int64) map[int64][]api.NetqualityISPSummary {
		if !isNetqualityOn() {
			return nil
		}
		byID := netqualityplugin.LatestPerISPForAll(ctx, d, ids)
		out := make(map[int64][]api.NetqualityISPSummary, len(byID))
		for sid, rows := range byID {
			conv := make([]api.NetqualityISPSummary, 0, len(rows))
			for _, r := range rows {
				conv = append(conv, api.NetqualityISPSummary{ISP: r.ISP, RTTAvgMs: r.RTTAvgMs, LossPct: r.LossPct})
			}
			out[sid] = conv
		}
		return out
	}
```

- [ ] **Step 4: Verify build + existing tests**

Run: `go build ./... && go test ./internal/api/ ./internal/telemetrysvc/ ./internal/plugins/netquality/`
Expected: build OK; existing tests PASS (behaviour-preserving rewrite). Then `gofmt -l internal/api/public.go cmd/server/main.go` (nothing), `golangci-lint run ./internal/api/...`.

- [ ] **Step 5: Commit**

```bash
git add internal/api/public.go cmd/server/main.go
git commit -m "perf(api): batch public-wall N+1 into LatestForAll/HostTrafficForAll/NetqualitySummaryForAll"
```

---

## Task 5: Batch the admin server list

**Files:**
- Modify: `internal/api/admin_servers.go` (`List`, the `with=latest` branch)

- [ ] **Step 1: Rewrite the `with=latest` loop**

In `internal/api/admin_servers.go` `List`, replace the per-row `a.Query.Latest` loop with a single `LatestForAll`:

```go
	type wrapped struct {
		*serversvc.Server
		Latest    *telemetrysvc.Point `json:"latest"`
		Connected bool                `json:"connected"`
	}
	ids := make([]int64, 0, len(servers))
	for _, s := range servers {
		ids = append(ids, s.ID)
	}
	latestByID, _ := a.Query.LatestForAll(r.Context(), ids)
	out := make([]wrapped, 0, len(servers))
	for _, s := range servers {
		out = append(out, wrapped{Server: s, Latest: latestByID[s.ID], Connected: a.hubIsOnline(s.ID)})
	}
	writeJSON(w, 200, out)
```

(`latestByID[s.ID]` is nil when absent — same as the old `a.Query.Latest` returning nil "no telemetry yet". `Connected` stays per-row; it's an in-memory hub check, not a DB call.)

- [ ] **Step 2: Verify build + tests**

Run: `go build ./... && go test ./internal/api/`
Expected: build OK; existing tests PASS. `gofmt -l internal/api/admin_servers.go`, `go vet ./internal/api/`.

- [ ] **Step 3: Commit**

```bash
git add internal/api/admin_servers.go
git commit -m "perf(api): batch admin server-list latest into one LatestForAll query"
```

---

## Task 6: `WriteSample` transaction

**Files:**
- Modify: `internal/telemetrysvc/ingest.go`
- Test: `internal/telemetrysvc/ingest_test.go`

- [ ] **Step 1: Write the failing/guard test**

Append to `internal/telemetrysvc/ingest_test.go` (it has `newIngest(t)`; ensure `database/sql` is imported there — it is):

```go
func TestWriteSample_PersistsSampleTrafficAndLiveness(t *testing.T) {
	ing, sid := newIngest(t)
	now := time.Now().UTC()
	if err := ing.WriteSample(context.Background(), sid, agentapi.Telemetry{
		TS: now, CPUPct: 42, NetRxBytes: 1000, NetTxBytes: 500,
	}); err != nil {
		t.Fatal(err)
	}
	var nSamples int
	_ = ing.DB.Get(&nSamples, "SELECT COUNT(*) FROM telemetry_samples_30s WHERE server_id=$1", sid)
	if nSamples != 1 {
		t.Fatalf("samples=%d want 1", nSamples)
	}
	q := &Query{DB: ing.DB}
	tr, _ := q.HostTraffic(context.Background(), sid)
	if tr.CumBytesDown != 1000 || tr.CumBytesUp != 500 {
		t.Fatalf("traffic up=%d down=%d want 500/1000", tr.CumBytesUp, tr.CumBytesDown)
	}
	var ls sql.NullTime
	_ = ing.DB.Get(&ls, "SELECT agent_last_seen FROM servers WHERE id=$1", sid)
	if !ls.Valid {
		t.Fatal("agent_last_seen not advanced")
	}
}
```

- [ ] **Step 2: Run to verify it passes against current code (behaviour baseline)**

Run: `go test ./internal/telemetrysvc/ -run TestWriteSample_PersistsSampleTrafficAndLiveness -v`
Expected: PASS (the current non-transactional code already produces this behaviour — this test guards that the transaction rewrite preserves it).

- [ ] **Step 3: Wrap the three writes in one transaction**

In `internal/telemetrysvc/ingest.go`, rewrite `WriteSample` to use a transaction (same SQL, `i.DB.ExecContext` → `tx.ExecContext`):

```go
// WriteSample persists one telemetry point, bumps host_traffic, and bumps
// agent_last_seen — atomically, in one transaction (one fsync instead of three).
func (i *Ingest) WriteSample(ctx context.Context, serverID int64, t agentapi.Telemetry) error {
	disksJSON, _ := json.Marshal(t.Disks)
	tx, err := i.DB.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }() // no-op after a successful Commit

	if _, err := tx.ExecContext(ctx, `INSERT INTO telemetry_samples_30s
		(server_id, ts, cpu_pct, mem_used, mem_total, load_1, load_5, load_15,
		 net_rx_bps, net_tx_bps, tcp_conn, disks_json)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		serverID, t.TS.UTC(), t.CPUPct, t.MemUsed, t.MemTotal, t.Load1, t.Load5, t.Load15,
		t.NetRxBps, t.NetTxBps, t.TCPConn, string(disksJSON)); err != nil {
		return err
	}
	if t.NetRxBytes != 0 || t.NetTxBytes != 0 {
		now := t.TS.UTC()
		if _, err := tx.ExecContext(ctx, `INSERT INTO host_traffic
			(server_id, cum_bytes_up, cum_bytes_down, last_reset_at, updated_at)
			VALUES ($1,$2,$3,$4,$4)
			ON CONFLICT (server_id) DO UPDATE SET
			  cum_bytes_up   = host_traffic.cum_bytes_up   + EXCLUDED.cum_bytes_up,
			  cum_bytes_down = host_traffic.cum_bytes_down + EXCLUDED.cum_bytes_down,
			  updated_at     = EXCLUDED.updated_at`,
			serverID, t.NetTxBytes, t.NetRxBytes, now); err != nil {
			return err
		}
	}
	// Liveness uses the server clock, NOT t.TS (a skewed agent clock would write a
	// stale last_seen and make the wall show false-offline — see commit e12434a).
	if _, err := tx.ExecContext(ctx, "UPDATE servers SET agent_last_seen=$1 WHERE id=$2",
		time.Now().UTC(), serverID); err != nil {
		return err
	}
	return tx.Commit()
}
```

- [ ] **Step 4: Run to verify pass**

Run: `go test -race ./internal/telemetrysvc/ -run 'TestWriteSample|TestQuery|TestHostTraffic|TestLatestForAll' -v`
Expected: PASS. `gofmt -l internal/telemetrysvc/ingest.go`, `go vet`.

- [ ] **Step 5: Commit**

```bash
git add internal/telemetrysvc/ingest.go internal/telemetrysvc/ingest_test.go
git commit -m "perf(telemetry): make WriteSample atomic (one tx, one fsync)"
```

---

## Task 7: `previewRead` — fix the file-preview goroutine leak

**Files:**
- Modify: `internal/api/files_routes.go`
- Test: `internal/api/files_routes_test.go` (create if absent)

- [ ] **Step 1: Write the failing test**

Create/append `internal/api/files_routes_test.go`:

```go
package api

import (
	"context"
	"io"
	"testing"
	"time"
)

func TestPreviewRead_ReturnsPrefixAndCancels(t *testing.T) {
	cancelled := make(chan struct{})
	downloadFn := func(ctx context.Context, w io.Writer) error {
		_, _ = w.Write([]byte("hello world more than five")) // pipe write blocks past 5 bytes
		<-ctx.Done()                                          // unblocked only when previewRead cancels us
		close(cancelled)
		return ctx.Err()
	}
	data := previewRead(context.Background(), 5, downloadFn)
	if string(data) != "hello" {
		t.Fatalf("data=%q want %q", data, "hello")
	}
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("download ctx not cancelled after previewRead returned (leak)")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/api/ -run TestPreviewRead -v`
Expected: FAIL — `previewRead undefined`.

- [ ] **Step 3: Add the helper + use it in `Preview`**

In `internal/api/files_routes.go` add the helper (ensure `context` + `io` are imported — `io` already is for the pipe):

```go
// previewRead pipes downloadFn's output and returns up to maxB bytes. On return
// it cancels the download context (so Download sends FileCancel and the agent
// stops streaming) and closes the pipe reader (so an in-flight write fails fast
// instead of head-of-line-blocking the agent connection's read loop).
func previewRead(ctx context.Context, maxB int, downloadFn func(context.Context, io.Writer) error) []byte {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	pr, pw := io.Pipe()
	defer pr.Close()
	go func() { _ = pw.CloseWithError(downloadFn(ctx, pw)) }()
	buf := make([]byte, maxB)
	n, _ := io.ReadFull(pr, buf)
	return buf[:n]
}
```

Then rewrite the body of `Preview` to use it (replacing the inline pipe + goroutine):

```go
func (a *FilesAPI) Preview(w http.ResponseWriter, r *http.Request) {
	sid, _ := strconv.ParseInt(r.URL.Query().Get("server_id"), 10, 64)
	path := r.URL.Query().Get("path")
	maxB, _ := strconv.Atoi(r.URL.Query().Get("max_bytes"))
	if maxB <= 0 || maxB > 256*1024 {
		maxB = 64 * 1024
	}
	data := previewRead(r.Context(), maxB, func(ctx context.Context, dst io.Writer) error {
		_, err := a.Files.Download(ctx, sid, path, dst)
		return err
	})
	for _, b := range data {
		if b == 0 {
			writeError(w, 415, "binary content")
			return
		}
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write(data)
}
```

- [ ] **Step 4: Run to verify pass**

Run: `go test -race ./internal/api/ -run TestPreviewRead -v`
Expected: PASS. `gofmt -l internal/api/files_routes.go`, `go vet ./internal/api/`.

- [ ] **Step 5: Commit**

```bash
git add internal/api/files_routes.go internal/api/files_routes_test.go
git commit -m "fix(api): cancel preview download on return (stop agent stream, no HOL block)"
```

---

## Task 8: Bound BatchUpdateAgent installs

**Files:**
- Modify: `internal/api/admin_servers.go` (`ServersAPI` struct, `dispatchInstall`, `BatchUpdateAgent`)
- Modify: `cmd/server/main.go` (init `installSem`)
- Test: `internal/api/admin_servers_test.go` (create if absent)

- [ ] **Step 1: Write the failing test**

Create/append `internal/api/admin_servers_test.go`:

```go
package api

import (
	"context"
	"sync"
	"testing"
	"time"
)

type countingExec struct {
	mu       sync.Mutex
	cur, max int
	done     *sync.WaitGroup
}

func (c *countingExec) RunCmd(ctx context.Context, serverID int64, name string, args ...string) ([]byte, []byte, int, error) {
	c.mu.Lock()
	c.cur++
	if c.cur > c.max {
		c.max = c.cur
	}
	c.mu.Unlock()
	time.Sleep(15 * time.Millisecond)
	c.mu.Lock()
	c.cur--
	c.mu.Unlock()
	c.done.Done()
	return nil, nil, 0, nil
}

func TestDispatchInstall_BoundsConcurrency(t *testing.T) {
	const n, cap = 12, 3
	var wg sync.WaitGroup
	wg.Add(n)
	ex := &countingExec{done: &wg}
	a := &ServersAPI{HostExec: ex, installSem: make(chan struct{}, cap)}
	for i := 0; i < n; i++ {
		a.dispatchInstall(int64(i), "echo hi")
	}
	wg.Wait()
	if ex.max > cap {
		t.Fatalf("max concurrent installs = %d, want <= %d", ex.max, cap)
	}
	if ex.max == 0 {
		t.Fatal("no installs ran")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/api/ -run TestDispatchInstall -v`
Expected: FAIL — `installSem` field and `dispatchInstall` method undefined.

- [ ] **Step 3: Add the field, helper, and use it**

In `internal/api/admin_servers.go`:

(a) Add to the `ServersAPI` struct (after `PublicURL string`):

```go
	// installSem bounds concurrent background agent installs across all batch
	// calls. nil → unbounded (the field is set in main.go).
	installSem chan struct{}
```

(b) Add the helper:

```go
// dispatchInstall runs an agent install in the background, bounded by installSem
// (shared across batch calls). Uses context.Background() so a client disconnect
// never cancels an in-flight install. Fire-and-forget: the caller has already
// reported "dispatched".
func (a *ServersAPI) dispatchInstall(serverID int64, cmd string) {
	go func() {
		if a.installSem != nil {
			a.installSem <- struct{}{}
			defer func() { <-a.installSem }()
		}
		_, _, _, _ = a.HostExec.RunCmd(context.Background(), serverID, "sh", "-c", cmd)
	}()
}
```

(c) In `BatchUpdateAgent`, replace the inline `go func() { ctx := context.Background(); _, _, _, _ = a.HostExec.RunCmd(ctx, serverID, "sh", "-c", cmd) }()` with:

```go
			a.dispatchInstall(serverID, cmd)
```

- [ ] **Step 4: Init `installSem` in main.go**

In `cmd/server/main.go`, in the `servers := &api.ServersAPI{...}` literal (~line 182), add the field:

```go
		HostExec:     hostExec,
		installSem:   make(chan struct{}, 20),
```

WAIT — `installSem` is unexported, so it cannot be set from package `main` via a struct literal. Instead add an exported initializer in `internal/api/admin_servers.go`:

```go
// InitInstallConcurrency caps concurrent background agent installs.
func (a *ServersAPI) InitInstallConcurrency(max int) {
	a.installSem = make(chan struct{}, max)
}
```

and in `cmd/server/main.go`, right after the `servers := &api.ServersAPI{...}` literal, call:

```go
	servers.InitInstallConcurrency(20)
```

(Do NOT put `installSem` in the literal — it's unexported.)

- [ ] **Step 5: Run to verify pass**

Run: `go build ./... && go test -race ./internal/api/ -run TestDispatchInstall -v`
Expected: build OK; PASS. `gofmt -l internal/api/admin_servers.go cmd/server/main.go`, `golangci-lint run ./internal/api/...`.

- [ ] **Step 6: Commit**

```bash
git add internal/api/admin_servers.go internal/api/admin_servers_test.go cmd/server/main.go
git commit -m "perf(api): bound concurrent batch agent installs to 20 (shared semaphore)"
```

---

## Task 9: ServerList row click → navigate()

**Files:**
- Modify: `web/src/pages/admin/ServerList.tsx`
- Test: `web/src/pages/admin/ServerList.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/admin/ServerList.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { renderWithProviders } from '@/test-utils/render'

const navigate = vi.fn()
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigate }
})

vi.mock('@/api/servers', async (orig) => {
  const actual = await orig<typeof import('@/api/servers')>()
  return {
    ...actual,
    useServers: () => ({ data: [{ id: 7, name: 'srv7', show_on_public: false, connected: true }], isLoading: false }),
    useDeleteServer: () => ({ mutate: vi.fn(), isPending: false }),
    useBatchUpdateAgent: () => ({ mutate: vi.fn(), isPending: false }),
    useReinstall: () => ({ mutate: vi.fn(), isPending: false }),
  }
})

beforeEach(() => navigate.mockClear())

describe('ServerList row navigation', () => {
  it('navigates client-side on row click (no full reload)', async () => {
    const { default: ServerList } = await import('./ServerList')
    renderWithProviders(<ServerList />)
    const row = await screen.findByText('srv7')
    fireEvent.click(row)
    expect(navigate).toHaveBeenCalledWith('/admin/servers/7')
  })
})
```

(If `ServerList` needs more from the mocked hooks to render a row — e.g. extra fields on the server object or a `useUI` selector — adapt the mock minimally so a row with the text `srv7` renders; do NOT change the assertion that `navigate('/admin/servers/7')` is called.)

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx vitest run src/pages/admin/ServerList.test.tsx`
Expected: FAIL — the row click currently calls `window.location.assign`, not `navigate`.

- [ ] **Step 3: Switch to `navigate`**

In `web/src/pages/admin/ServerList.tsx`:
- Change the react-router import (line 3) from `import { Link } from 'react-router-dom'` to `import { Link, useNavigate } from 'react-router-dom'`.
- Inside the `ServerList` component, add `const navigate = useNavigate()` near the other hooks.
- Change the row handler (line ~414) from `onClick={() => window.location.assign(\`/admin/servers/${s.id}\`)}` to `onClick={() => navigate(\`/admin/servers/${s.id}\`)}`.

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run src/pages/admin/ServerList.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/ServerList.tsx web/src/pages/admin/ServerList.test.tsx
git commit -m "perf(ui): ServerList row click uses client-side navigate(), not full reload"
```

---

## Task 10: Full verification

**Files:** none.

- [ ] **Step 1: Backend gates**

Run: `gofmt -l ./internal/... ./cmd/... && go build ./... && go test -race ./... && golangci-lint run`
Expected: no gofmt output for our files; build OK; tests PASS; linter clean.

- [ ] **Step 2: Frontend gates**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: clean; all tests pass.

- [ ] **Step 3: Behaviour spot check**

Confirm by reading the final `Servers_ListPublic` and admin `List` that each issues exactly one batch call per data source (no per-row `Query.Latest`/`HostTraffic`/`NetqualitySummary`), and that absent ids fall back to defaults (no nil-map panic). Confirm `WriteSample` returns `tx.Commit()` and `BatchUpdateAgent` calls `a.dispatchInstall`.

---

## Self-Review

- **Spec coverage:** N+1 batch → Tasks 1 (LatestForAll), 2 (HostTrafficForAll), 3 (LatestPerISPForAll), 4 (wall consumer + wiring), 5 (admin consumer). WriteSample tx → Task 6. Preview leak → Task 7. BatchUpdateAgent bound → Task 8. ServerList navigate → Task 9. Gates → Task 10. All spec items mapped.
- **Type consistency:** `LatestForAll(ctx, []int64) (map[int64]*Point, error)` and `HostTrafficForAll(...) (map[int64]*HostTrafficRow, error)` defined in Tasks 1–2 and consumed in Tasks 4–5; `LatestPerISPForAll(ctx, *sqlx.DB, []int64) map[int64][]ISPSummary` (Task 3) consumed by the main.go closure (Task 4); `NetqualitySummaryForAll func(...) map[int64][]NetqualityISPSummary` field (Task 4) matches the closure; `dispatchInstall`/`installSem`/`InitInstallConcurrency` (Task 8) consistent across struct/method/main.go.
- **Placeholders:** none — every code step is complete. Two read-first caveats (Task 3 schema column names; Task 9 mock surface) are explicit verification instructions, not deferred work.
- **Risk note:** Task 4/5 lean on the unit-tested helpers (Tasks 1–3) plus existing endpoint tests for behaviour-preservation, since a full PublicAPI integration harness is disproportionate; the Task 10 spot check + e2e gate cover the wiring.
