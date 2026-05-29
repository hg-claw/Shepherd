# Host Cumulative Traffic + Monthly Reset Day — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Track each server's whole-server cumulative upload/download bytes (physical interfaces only) with a configurable per-server monthly reset day that snapshots-then-zeros, plus manual reset, shown on a Traffic card.

**Architecture:** The agent's `NetMeter` gains a physical-interface filter (shared by the existing bps chart and the new counters) and returns the exact per-interval byte delta in the 30s telemetry; the server upsert-accumulates it into a `host_traffic` row; a periodic `TrafficReset` job snapshots+zeros on each server's reset-day boundary (global timezone); API + a ServerDetail Traffic card expose it.

**Tech Stack:** Go, gopsutil/v3 net, sqlx, golang-migrate (core migrations), React/TS + react-query, vitest.

**Spec:** `docs/superpowers/specs/2026-05-29-host-traffic-cumulative-design.md`

Run from `/Users/hg/project/Shepherd`; never `git checkout`/`reset`/`stash` (commit on `feat/host-traffic-cumulative`). Frontend cmds from `web/`; do NOT run `npm run build`. up=tx=`BytesSent`, down=rx=`BytesRecv` throughout.

---

## Task 1: Agent — physical-interface filter + delta bytes

**Files:**
- Modify: `internal/agent/collector/net.go`
- Modify: `internal/agent/collector/collector.go`
- Modify: `internal/agentapi/types.go`
- Modify: `internal/agent/collector/collector_test.go`
- Test: `internal/agent/collector/net_test.go` (create)

- [ ] **Step 1: Write failing tests** — create `internal/agent/collector/net_test.go`:

```go
package collector

import (
	"testing"

	"github.com/shirou/gopsutil/v3/net"
)

func TestIsPhysicalIface(t *testing.T) {
	phys := []string{"eth0", "ens3", "enp0s3", "eno1"}
	virt := []string{"lo", "docker0", "veth1234", "br-abcdef", "wg0", "tun0", "tap0"}
	for _, n := range phys {
		if !isPhysicalIface(n) {
			t.Errorf("%q should be physical", n)
		}
	}
	for _, n := range virt {
		if isPhysicalIface(n) {
			t.Errorf("%q should be excluded", n)
		}
	}
}

func TestSumPhysical(t *testing.T) {
	stats := []net.IOCountersStat{
		{Name: "lo", BytesRecv: 1000, BytesSent: 1000},
		{Name: "eth0", BytesRecv: 100, BytesSent: 200},
		{Name: "docker0", BytesRecv: 50, BytesSent: 60},
		{Name: "veth9", BytesRecv: 7, BytesSent: 8},
		{Name: "ens3", BytesRecv: 300, BytesSent: 400},
	}
	rx, tx := sumPhysical(stats)
	if rx != 400 || tx != 600 { // eth0+ens3 only
		t.Fatalf("got rx=%d tx=%d, want 400/600", rx, tx)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/agent/collector/ -run 'IsPhysicalIface|SumPhysical' -v`
Expected: FAIL — `isPhysicalIface`/`sumPhysical` undefined.

- [ ] **Step 3: Add the pure helpers + delta to `net.go`**

In `internal/agent/collector/net.go`, add the two helpers (top, after imports):
```go
// isPhysicalIface reports whether name is a real uplink interface (not loopback
// or a virtual/container/VPN device). Cumulative traffic and the live rate both
// use this so container/VPN bytes aren't double-counted (counted on both the
// virtual device and the physical NIC).
func isPhysicalIface(name string) bool {
	if name == "lo" {
		return false
	}
	for _, p := range []string{"docker", "veth", "br-", "wg", "tun", "tap"} {
		if strings.HasPrefix(name, p) {
			return false
		}
	}
	return true
}

// sumPhysical sums recv/sent bytes across physical interfaces only.
func sumPhysical(stats []net.IOCountersStat) (rx, tx uint64) {
	for _, s := range stats {
		if !isPhysicalIface(s.Name) {
			continue
		}
		rx += s.BytesRecv
		tx += s.BytesSent
	}
	return rx, tx
}
```
Add `"strings"` to net.go's imports.

Change `Sample` to use `sumPhysical` and return the per-interval delta bytes. Replace the existing method body's summation + returns:
```go
// Sample returns the rx/tx bytes-per-second AND the exact per-interval byte
// delta since the last call, summed across physical interfaces. The first call
// primes counters and returns ok=false. On counter reset/wrap it re-primes and
// returns ok=false (caller drops the tick — no spurious accumulation).
func (m *NetMeter) Sample() (rxBps, txBps, rxBytes, txBytes int64, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	stats, err := net.IOCounters(true)
	if err != nil {
		return 0, 0, 0, 0, false
	}
	rx, tx := sumPhysical(stats)
	now := time.Now()
	if !m.primed {
		m.prevRx, m.prevTx, m.prevTS, m.primed = rx, tx, now, true
		return 0, 0, 0, 0, false
	}
	dt := now.Sub(m.prevTS).Seconds()
	if dt <= 0 {
		return 0, 0, 0, 0, false
	}
	if rx < m.prevRx || tx < m.prevTx {
		m.prevRx, m.prevTx, m.prevTS = rx, tx, now
		return 0, 0, 0, 0, false
	}
	dRx := rx - m.prevRx
	dTx := tx - m.prevTx
	m.prevRx, m.prevTx, m.prevTS = rx, tx, now
	return int64(float64(dRx) / dt), int64(float64(dTx) / dt), int64(dRx), int64(dTx), true
}
```

- [ ] **Step 4: Add telemetry fields** — in `internal/agentapi/types.go`, add to the `Telemetry` struct (after `NetTxBps`):
```go
	NetRxBytes int64 `json:"net_rx_bytes"` // exact bytes received this interval
	NetTxBytes int64 `json:"net_tx_bytes"` // exact bytes sent this interval
```

- [ ] **Step 5: Update the collector caller** — in `internal/agent/collector/collector.go` `sample()`, change the NetMeter call + telemetry build:
```go
	rx, tx, rxBytes, txBytes, netOK := c.netMeter.Sample()
	if !netOK {
		return agentapi.Telemetry{}, false
	}
```
and add to the returned `agentapi.Telemetry{...}` literal (after `NetTxBps: tx,`):
```go
		NetRxBytes: rxBytes,
		NetTxBytes: txBytes,
```

- [ ] **Step 6: Fix the existing NetMeter test** — in `internal/agent/collector/collector_test.go`, update `TestNetMeter_FirstCallNotPrimed` for the new 5-value signature:
```go
func TestNetMeter_FirstCallNotPrimed(t *testing.T) {
	var m NetMeter
	_, _, _, _, ok := m.Sample()
	if ok {
		t.Error("first call should return ok=false")
	}
}
```

- [ ] **Step 7: Run tests + build + gofmt/vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/agent/collector/ -v && go build ./... && gofmt -l internal/agent/collector/net.go internal/agent/collector/collector.go internal/agentapi/types.go && go vet ./internal/agent/collector/ ./internal/agentapi/`
Expected: PASS; build OK; gofmt empty; vet clean.

- [ ] **Step 8: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/agent/collector/ internal/agentapi/types.go
git commit -m "feat(agent): physical-iface filter + exact byte deltas in telemetry"
```

---

## Task 2: Server — migration + ingest accumulation

**Files:**
- Create: `internal/db/migrations/postgres/0008_host_traffic.{up,down}.sql`
- Create: `internal/db/migrations/sqlite/0008_host_traffic.{up,down}.sql`
- Modify: `internal/telemetrysvc/ingest.go`
- Test: `internal/telemetrysvc/traffic_ingest_test.go` (create)

- [ ] **Step 1: Create migrations.**

`internal/db/migrations/postgres/0008_host_traffic.up.sql`:
```sql
CREATE TABLE host_traffic (
  server_id       BIGINT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  cum_bytes_up    BIGINT  NOT NULL DEFAULT 0,
  cum_bytes_down  BIGINT  NOT NULL DEFAULT 0,
  prev_bytes_up   BIGINT  NOT NULL DEFAULT 0,
  prev_bytes_down BIGINT  NOT NULL DEFAULT 0,
  reset_day       INTEGER NOT NULL DEFAULT 1,
  last_reset_at   TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL
);
INSERT INTO settings(key, value) VALUES ('traffic_reset_tz', 'UTC');
```
`internal/db/migrations/postgres/0008_host_traffic.down.sql`:
```sql
DELETE FROM settings WHERE key='traffic_reset_tz';
DROP TABLE host_traffic;
```
`internal/db/migrations/sqlite/0008_host_traffic.up.sql`:
```sql
CREATE TABLE host_traffic (
  server_id       INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  cum_bytes_up    INTEGER NOT NULL DEFAULT 0,
  cum_bytes_down  INTEGER NOT NULL DEFAULT 0,
  prev_bytes_up   INTEGER NOT NULL DEFAULT 0,
  prev_bytes_down INTEGER NOT NULL DEFAULT 0,
  reset_day       INTEGER NOT NULL DEFAULT 1,
  last_reset_at   TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL
);
INSERT INTO settings(key, value) VALUES ('traffic_reset_tz', 'UTC');
```
`internal/db/migrations/sqlite/0008_host_traffic.down.sql`:
```sql
DELETE FROM settings WHERE key='traffic_reset_tz';
DROP TABLE host_traffic;
```

- [ ] **Step 2: Write failing test** — create `internal/telemetrysvc/traffic_ingest_test.go`. Reuse the `newIngest(t)` helper from `ingest_test.go` (same package; opens a migrated sqlite DB + seeds a server, returns `*Ingest` and the server id).

```go
package telemetrysvc

import (
	"context"
	"testing"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

func TestWriteSample_AccumulatesHostTraffic(t *testing.T) {
	ing, sid := newIngest(t)
	ctx := context.Background()
	mk := func(rx, tx int64) agentapi.Telemetry {
		return agentapi.Telemetry{TS: nowUTC(), MemTotal: 1, NetRxBytes: rx, NetTxBytes: tx}
	}
	if err := ing.WriteSample(ctx, sid, mk(100, 40)); err != nil {
		t.Fatal(err)
	}
	var up, down int64
	var lastReset *string
	row := ing.DB.QueryRowContext(ctx, `SELECT cum_bytes_up, cum_bytes_down, last_reset_at FROM host_traffic WHERE server_id=$1`, sid)
	if err := row.Scan(&up, &down, &lastReset); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if up != 40 || down != 100 {
		t.Fatalf("after 1st: up=%d down=%d want 40/100", up, down)
	}
	if lastReset == nil {
		t.Fatal("last_reset_at should be set on first insert")
	}
	if err := ing.WriteSample(ctx, sid, mk(10, 5)); err != nil {
		t.Fatal(err)
	}
	_ = ing.DB.QueryRowContext(ctx, `SELECT cum_bytes_up, cum_bytes_down FROM host_traffic WHERE server_id=$1`, sid).Scan(&up, &down)
	if up != 45 || down != 110 {
		t.Fatalf("after 2nd: up=%d down=%d want 45/110", up, down)
	}
}
```
> Implementer note: read `ingest_test.go` to confirm the helper name/return (`newIngest`) and whether a `nowUTC()`/time helper exists; if not, use `time.Now().UTC()` and add the `time` import. Confirm `*Ingest` exposes `DB` (it does — `Ingest{DB *sqlx.DB}`).

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/telemetrysvc/ -run TestWriteSample_AccumulatesHostTraffic -v`
Expected: FAIL — no `host_traffic` accumulation (table exists from migration, but WriteSample doesn't write it → `sql: no rows`).

- [ ] **Step 4: Add accumulation to `WriteSample`** — in `internal/telemetrysvc/ingest.go`, between the `telemetry_samples_30s` INSERT and the `agent_last_seen` UPDATE, add:
```go
	if t.NetRxBytes != 0 || t.NetTxBytes != 0 {
		now := t.TS.UTC()
		if _, err := i.DB.ExecContext(ctx, `INSERT INTO host_traffic
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
```
(up=tx=`$2`=`NetTxBytes`, down=rx=`$3`=`NetRxBytes`. On first insert `last_reset_at=now`; the conflict path never touches `last_reset_at`/`reset_day`/`prev_*`.)

- [ ] **Step 5: Run to verify pass + full package + gofmt/vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/telemetrysvc/ -v && gofmt -l internal/telemetrysvc/ingest.go && go vet ./internal/telemetrysvc/`
Expected: PASS; gofmt empty; vet clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/db/migrations/ internal/telemetrysvc/ingest.go internal/telemetrysvc/traffic_ingest_test.go
git commit -m "feat(telemetry): host_traffic table + accumulate byte deltas in WriteSample"
```

---

## Task 3: Server — traffic store + reset boundary (pure)

**Files:**
- Create: `internal/telemetrysvc/traffic.go`
- Test: `internal/telemetrysvc/traffic_test.go`

- [ ] **Step 1: Write failing tests** — create `internal/telemetrysvc/traffic_test.go`:

```go
package telemetrysvc

import (
	"context"
	"testing"
	"time"
)

func TestLastResetBoundary(t *testing.T) {
	utc := time.UTC
	// now after reset_day in month → this month's boundary
	now := time.Date(2026, 3, 20, 12, 0, 0, 0, utc)
	if got := lastResetBoundary(now, 1, utc); !got.Equal(time.Date(2026, 3, 1, 0, 0, 0, 0, utc)) {
		t.Errorf("after-day: %v", got)
	}
	// now before reset_day → previous month's boundary
	now = time.Date(2026, 3, 5, 12, 0, 0, 0, utc)
	if got := lastResetBoundary(now, 10, utc); !got.Equal(time.Date(2026, 2, 10, 0, 0, 0, 0, utc)) {
		t.Errorf("before-day: %v", got)
	}
	// January rollover to previous December
	now = time.Date(2026, 1, 5, 0, 0, 0, 0, utc)
	if got := lastResetBoundary(now, 10, utc); !got.Equal(time.Date(2025, 12, 10, 0, 0, 0, 0, utc)) {
		t.Errorf("jan-rollover: %v", got)
	}
	// timezone shifts the boundary instant
	sh, _ := time.LoadLocation("Asia/Shanghai")
	now = time.Date(2026, 3, 20, 12, 0, 0, 0, sh)
	got := lastResetBoundary(now, 1, sh)
	if got.In(sh) != time.Date(2026, 3, 1, 0, 0, 0, 0, sh) {
		// compare wall-clock in sh
		w := got.In(sh)
		if !(w.Year() == 2026 && w.Month() == 3 && w.Day() == 1 && w.Hour() == 0) {
			t.Errorf("tz boundary wall-clock: %v", w)
		}
	}
}

func TestQuery_HostTraffic_DefaultWhenAbsent(t *testing.T) {
	ing, sid := newIngest(t)
	q := &Query{DB: ing.DB}
	ctx := context.Background()
	row, err := q.HostTraffic(ctx, sid)
	if err != nil {
		t.Fatal(err)
	}
	if row.ResetDay != 1 || row.CumBytesUp != 0 || row.LastResetAt != nil {
		t.Fatalf("absent default: %+v", row)
	}
}

func TestQuery_SetResetDay_And_ResetNow(t *testing.T) {
	ing, sid := newIngest(t)
	q := &Query{DB: ing.DB}
	ctx := context.Background()
	if err := q.SetTrafficResetDay(ctx, sid, 15); err != nil {
		t.Fatal(err)
	}
	// seed some current usage
	_, _ = ing.DB.ExecContext(ctx, `UPDATE host_traffic SET cum_bytes_up=500, cum_bytes_down=900 WHERE server_id=$1`, sid)
	if err := q.ResetTrafficNow(ctx, sid); err != nil {
		t.Fatal(err)
	}
	row, _ := q.HostTraffic(ctx, sid)
	if row.ResetDay != 15 || row.CumBytesUp != 0 || row.CumBytesDown != 0 || row.PrevBytesUp != 500 || row.PrevBytesDown != 900 {
		t.Fatalf("after reset: %+v", row)
	}
	if row.LastResetAt == nil {
		t.Fatal("last_reset_at should be set after reset")
	}
}

func TestQuery_ResetDueTraffic(t *testing.T) {
	ing, sid := newIngest(t)
	q := &Query{DB: ing.DB}
	ctx := context.Background()
	_ = q.SetTrafficResetDay(ctx, sid, 1)
	// last_reset_at far in the past + some usage → due
	_, _ = ing.DB.ExecContext(ctx, `UPDATE host_traffic SET cum_bytes_up=10, cum_bytes_down=20, last_reset_at=$1 WHERE server_id=$2`,
		time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC), sid)
	now := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)
	if err := q.ResetDueTraffic(ctx, now, time.UTC); err != nil {
		t.Fatal(err)
	}
	row, _ := q.HostTraffic(ctx, sid)
	if row.CumBytesUp != 0 || row.PrevBytesUp != 10 {
		t.Fatalf("due not reset: %+v", row)
	}
	// running again is a no-op (already reset this period)
	if err := q.ResetDueTraffic(ctx, now, time.UTC); err != nil {
		t.Fatal(err)
	}
	row, _ = q.HostTraffic(ctx, sid)
	if row.PrevBytesUp != 10 {
		t.Fatalf("second run should be no-op: %+v", row)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/telemetrysvc/ -run 'LastResetBoundary|HostTraffic_Default|SetResetDay_And_ResetNow|ResetDueTraffic' -v`
Expected: FAIL — undefined symbols.

- [ ] **Step 3: Implement `internal/telemetrysvc/traffic.go`:**

```go
package telemetrysvc

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// HostTrafficRow is one server's cumulative-traffic state.
type HostTrafficRow struct {
	ServerID      int64      `db:"server_id"       json:"server_id"`
	CumBytesUp    int64      `db:"cum_bytes_up"    json:"cum_bytes_up"`
	CumBytesDown  int64      `db:"cum_bytes_down"  json:"cum_bytes_down"`
	PrevBytesUp   int64      `db:"prev_bytes_up"   json:"prev_bytes_up"`
	PrevBytesDown int64      `db:"prev_bytes_down" json:"prev_bytes_down"`
	ResetDay      int        `db:"reset_day"       json:"reset_day"`
	LastResetAt   *time.Time `db:"last_reset_at"   json:"last_reset_at"`
}

// lastResetBoundary returns the most recent "resetDay 00:00:00 in loc" instant
// that is <= now. resetDay is 1..28 so it always exists (no month-length clamp).
func lastResetBoundary(now time.Time, resetDay int, loc *time.Location) time.Time {
	n := now.In(loc)
	thisMonth := time.Date(n.Year(), n.Month(), resetDay, 0, 0, 0, 0, loc)
	if !thisMonth.After(n) {
		return thisMonth
	}
	// roll back one month
	prev := thisMonth.AddDate(0, -1, 0)
	return prev
}

// HostTraffic returns the server's row, or a zeroed default (reset_day=1) when
// absent so the UI always renders.
func (q *Query) HostTraffic(ctx context.Context, serverID int64) (*HostTrafficRow, error) {
	var row HostTrafficRow
	err := q.DB.GetContext(ctx, &row,
		`SELECT server_id, cum_bytes_up, cum_bytes_down, prev_bytes_up, prev_bytes_down, reset_day, last_reset_at
		   FROM host_traffic WHERE server_id=$1`, serverID)
	if errors.Is(err, sql.ErrNoRows) {
		return &HostTrafficRow{ServerID: serverID, ResetDay: 1}, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// SetTrafficResetDay upserts the per-server reset day (caller validates 1..28).
// Creates the row with last_reset_at=now if absent so the reset checker won't
// fire a spurious zero-snapshot before any traffic accumulates.
func (q *Query) SetTrafficResetDay(ctx context.Context, serverID int64, day int) error {
	now := time.Now().UTC()
	_, err := q.DB.ExecContext(ctx, `INSERT INTO host_traffic (server_id, reset_day, last_reset_at, updated_at)
		VALUES ($1,$2,$3,$3)
		ON CONFLICT (server_id) DO UPDATE SET reset_day=EXCLUDED.reset_day, updated_at=EXCLUDED.updated_at`,
		serverID, day, now)
	return err
}

// ResetTrafficNow snapshots current totals into prev_* and zeros the current
// counters for one server. Creates a zeroed row if absent (no-op zero).
func (q *Query) ResetTrafficNow(ctx context.Context, serverID int64) error {
	return q.snapshotZero(ctx, serverID, time.Now().UTC())
}

func (q *Query) snapshotZero(ctx context.Context, serverID int64, now time.Time) error {
	_, err := q.DB.ExecContext(ctx, `INSERT INTO host_traffic (server_id, last_reset_at, updated_at)
		VALUES ($1,$2,$2)
		ON CONFLICT (server_id) DO UPDATE SET
		  prev_bytes_up   = host_traffic.cum_bytes_up,
		  prev_bytes_down = host_traffic.cum_bytes_down,
		  cum_bytes_up    = 0,
		  cum_bytes_down  = 0,
		  last_reset_at   = EXCLUDED.last_reset_at,
		  updated_at      = EXCLUDED.updated_at`,
		serverID, now)
	return err
}

// ResetDueTraffic snapshots+zeros every server whose last_reset_at predates its
// most recent scheduled reset boundary (in loc). A row with NULL last_reset_at
// is treated as due.
func (q *Query) ResetDueTraffic(ctx context.Context, now time.Time, loc *time.Location) error {
	type r struct {
		ServerID    int64      `db:"server_id"`
		ResetDay    int        `db:"reset_day"`
		LastResetAt *time.Time `db:"last_reset_at"`
	}
	var rows []r
	if err := q.DB.SelectContext(ctx, &rows,
		`SELECT server_id, reset_day, last_reset_at FROM host_traffic`); err != nil {
		return err
	}
	for _, row := range rows {
		b := lastResetBoundary(now, row.ResetDay, loc)
		if row.LastResetAt == nil || row.LastResetAt.Before(b) {
			if err := q.snapshotZero(ctx, row.ServerID, now); err != nil {
				return err
			}
		}
	}
	return nil
}
```

- [ ] **Step 4: Run to verify pass + gofmt/vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/telemetrysvc/ -v && gofmt -l internal/telemetrysvc/traffic.go && go vet ./internal/telemetrysvc/`
Expected: PASS; gofmt empty; vet clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/telemetrysvc/traffic.go internal/telemetrysvc/traffic_test.go
git commit -m "feat(telemetry): host_traffic store + lastResetBoundary + reset helpers"
```

---

## Task 4: Server — periodic reset job + wiring

**Files:**
- Create: `internal/telemetrysvc/traffic_reset.go`
- Modify: `cmd/server/main.go`
- Test: `internal/telemetrysvc/traffic_reset_test.go`

- [ ] **Step 1: Write failing test** — create `internal/telemetrysvc/traffic_reset_test.go`:

```go
package telemetrysvc

import (
	"context"
	"testing"
	"time"
)

type fakeSettings struct{ tz string }

func (f fakeSettings) Get(_ context.Context, key string) (string, error) {
	if key == "traffic_reset_tz" {
		return f.tz, nil
	}
	return "", nil
}

func TestTrafficReset_TickResetsDue(t *testing.T) {
	ing, sid := newIngest(t)
	q := &Query{DB: ing.DB}
	ctx := context.Background()
	_ = q.SetTrafficResetDay(ctx, sid, 1)
	_, _ = ing.DB.ExecContext(ctx, `UPDATE host_traffic SET cum_bytes_up=7, last_reset_at=$1 WHERE server_id=$2`,
		time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC), sid)

	tr := &TrafficReset{DB: ing.DB, Settings: fakeSettings{tz: "UTC"}}
	if err := tr.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	row, _ := q.HostTraffic(ctx, sid)
	if row.CumBytesUp != 0 || row.PrevBytesUp != 7 {
		t.Fatalf("tick did not reset: %+v", row)
	}
}
```
> Implementer note: `Tick` uses `time.Now()` internally; the seeded `last_reset_at` of year 2000 is before any plausible boundary, so it's due regardless of the current date.

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/telemetrysvc/ -run TestTrafficReset_TickResetsDue -v`
Expected: FAIL — `TrafficReset` undefined.

- [ ] **Step 3: Implement `internal/telemetrysvc/traffic_reset.go`:**

```go
package telemetrysvc

import (
	"context"
	"log"
	"time"

	"github.com/jmoiron/sqlx"
)

// TrafficReset periodically zeroes per-server cumulative traffic on each
// server's monthly reset-day boundary (in the global traffic_reset_tz).
type TrafficReset struct {
	DB       *sqlx.DB
	Settings interface {
		Get(ctx context.Context, key string) (string, error)
	}
	Interval time.Duration // default 1h
}

func (r *TrafficReset) Run(ctx context.Context) {
	if r.Interval == 0 {
		r.Interval = time.Hour
	}
	t := time.NewTicker(r.Interval)
	defer t.Stop()
	if err := r.Tick(ctx); err != nil {
		log.Printf("traffic reset tick: %v", err)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := r.Tick(ctx); err != nil {
				log.Printf("traffic reset tick: %v", err)
			}
		}
	}
}

func (r *TrafficReset) Tick(ctx context.Context) error {
	tz := "UTC"
	if r.Settings != nil {
		if v, err := r.Settings.Get(ctx, "traffic_reset_tz"); err == nil && v != "" {
			tz = v
		}
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	return (&Query{DB: r.DB}).ResetDueTraffic(ctx, time.Now(), loc)
}
```

- [ ] **Step 4: Wire in `cmd/server/main.go`** — after the `go (&telemetrysvc.Retention{...}).Run(rootCtx)` block (the one ending around line 173), add:
```go
	go (&telemetrysvc.TrafficReset{DB: d, Settings: settingsStore}).Run(rootCtx)
```

- [ ] **Step 5: Run test + build + gofmt/vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/telemetrysvc/ -run TestTrafficReset_TickResetsDue -v && go build ./... && gofmt -l internal/telemetrysvc/traffic_reset.go cmd/server/main.go && go vet ./internal/telemetrysvc/ ./cmd/server/`
Expected: PASS; build OK; gofmt empty; vet clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/telemetrysvc/traffic_reset.go internal/telemetrysvc/traffic_reset_test.go cmd/server/main.go
git commit -m "feat(telemetry): hourly TrafficReset job + cmd/server wiring"
```

---

## Task 5: Server — API endpoints + settings allowlist

**Files:**
- Modify: `internal/api/admin_servers.go`
- Modify: `internal/api/admin_settings.go`
- Modify: `internal/api/router.go`
- Test: `internal/api/admin_servers_test.go`

- [ ] **Step 1: Write failing test** — in `internal/api/admin_servers_test.go`, mirror the `TestServersAPI_Inventory` harness (builds `ServersAPI` with a migrated DB + `telemetrysvc.Query` + seeds a server; reaches the DB via `a.Query.DB`):

```go
func TestServersAPI_Traffic(t *testing.T) {
	a, sid := <build ServersAPI + seed a server — mirror TestServersAPI_Inventory>
	ctx := context.Background()

	// default when absent: 200, reset_day=1, zeros
	rec := httptest.NewRecorder()
	a.Traffic(rec, httptest.NewRequest("GET", "/api/servers/"+strconv.FormatInt(sid,10)+"/traffic", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"reset_day":1`) || !strings.Contains(rec.Body.String(), `"cum_bytes_up":0`) {
		t.Fatalf("default GET: %d %s", rec.Code, rec.Body.String())
	}

	// set reset day: valid
	rec = httptest.NewRecorder()
	a.SetTrafficResetDay(rec, httptest.NewRequest("POST", "/api/servers/"+strconv.FormatInt(sid,10)+"/traffic/reset-day",
		strings.NewReader(`{"reset_day":15}`)))
	if rec.Code != 204 {
		t.Fatalf("set-day: %d %s", rec.Code, rec.Body.String())
	}
	// invalid
	rec = httptest.NewRecorder()
	a.SetTrafficResetDay(rec, httptest.NewRequest("POST", "/api/servers/"+strconv.FormatInt(sid,10)+"/traffic/reset-day",
		strings.NewReader(`{"reset_day":31}`)))
	if rec.Code != 400 {
		t.Fatalf("set-day invalid should 400: %d", rec.Code)
	}

	// seed usage, then reset
	_, _ = a.Query.DB.ExecContext(ctx, `UPDATE host_traffic SET cum_bytes_up=99 WHERE server_id=$1`, sid)
	rec = httptest.NewRecorder()
	a.ResetTraffic(rec, httptest.NewRequest("POST", "/api/servers/"+strconv.FormatInt(sid,10)+"/traffic/reset", nil))
	if rec.Code != 204 {
		t.Fatalf("reset: %d %s", rec.Code, rec.Body.String())
	}
	row, _ := a.Query.HostTraffic(ctx, sid)
	if row.CumBytesUp != 0 || row.PrevBytesUp != 99 || row.ResetDay != 15 {
		t.Fatalf("after reset: %+v", row)
	}
}
```
Imports as needed: `context`, `net/http/httptest`, `strconv`, `strings`, `testing`.

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/api/ -run TestServersAPI_Traffic -v`
Expected: FAIL — handlers undefined.

- [ ] **Step 3: Add handlers** to `internal/api/admin_servers.go` (after the `Inventory` handler):
```go
func (a *ServersAPI) Traffic(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID2(r, "/api/servers/", "/traffic")
	if !ok {
		writeError(w, 400, "bad path")
		return
	}
	row, err := a.Query.HostTraffic(r.Context(), id)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, row)
}

type resetDayReq struct {
	ResetDay int `json:"reset_day"`
}

func (a *ServersAPI) SetTrafficResetDay(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID2(r, "/api/servers/", "/traffic/reset-day")
	if !ok {
		writeError(w, 400, "bad path")
		return
	}
	var in resetDayReq
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	if in.ResetDay < 1 || in.ResetDay > 28 {
		writeError(w, 400, "reset_day must be 1..28")
		return
	}
	if err := a.Query.SetTrafficResetDay(r.Context(), id, in.ResetDay); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *ServersAPI) ResetTraffic(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID2(r, "/api/servers/", "/traffic/reset")
	if !ok {
		writeError(w, 400, "bad path")
		return
	}
	if err := a.Query.ResetTrafficNow(r.Context(), id); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```
> Implementer note: all three handlers reuse `pathID2` (do NOT add a `pathID3`). `pathID2` does `TrimPrefix`+`TrimSuffix` against literal strings then rejects a remaining `/`; for `/api/servers/42/traffic/reset-day` the suffix `/traffic/reset-day` is a literal, leaving `42` (no `/`), so it works. Confirm by reading `pathID2` in `admin_servers.go`.

- [ ] **Step 4: Register routes** — in `internal/api/router.go`, after the inventory route (`admin.HandleFunc("GET /api/servers/{id}/inventory", ...)`):
```go
	admin.HandleFunc("GET /api/servers/{id}/traffic", r.Servers.Traffic)
	admin.HandleFunc("POST /api/servers/{id}/traffic/reset-day", r.Servers.SetTrafficResetDay)
	admin.HandleFunc("POST /api/servers/{id}/traffic/reset", r.Servers.ResetTraffic)
```

- [ ] **Step 5: Allow the TZ setting key** — in `internal/api/admin_settings.go`, add to the `allowedSettingKeys` map:
```go
	"traffic_reset_tz": true,
```

- [ ] **Step 6: Run tests + full api package + gofmt/vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/api/ -run TestServersAPI_Traffic -v && go test ./internal/api/ && gofmt -l internal/api/admin_servers.go internal/api/admin_settings.go internal/api/router.go && go vet ./internal/api/`
Expected: PASS; gofmt empty; vet clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/api/admin_servers.go internal/api/admin_settings.go internal/api/router.go internal/api/admin_servers_test.go
git commit -m "feat(api): host traffic GET + reset-day + reset endpoints, allow traffic_reset_tz"
```

---

## Task 6: Admin UI — Traffic card + global TZ setting

**Files:**
- Modify: `web/src/api/servers.ts`
- Modify: `web/src/pages/admin/ServerDetail.tsx`
- Modify: `web/src/pages/admin/Settings.tsx`
- Test: `web/src/pages/admin/ServerDetail.test.tsx`

- [ ] **Step 1: Add types + hooks** to `web/src/api/servers.ts`:
```ts
export type HostTraffic = {
  server_id: number
  cum_bytes_up: number
  cum_bytes_down: number
  prev_bytes_up: number
  prev_bytes_down: number
  reset_day: number
  last_reset_at: string | null
}

export function useHostTraffic(id: number) {
  return useQuery({
    queryKey: ['host-traffic', id],
    queryFn: () => api.get<HostTraffic>(`/api/servers/${id}/traffic`),
    enabled: !!id,
    refetchInterval: 10_000,
  })
}

export function useSetTrafficResetDay(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (reset_day: number) =>
      api.post(`/api/servers/${id}/traffic/reset-day`, { reset_day }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['host-traffic', id] }),
  })
}

export function useResetTraffic(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post(`/api/servers/${id}/traffic/reset`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['host-traffic', id] }),
  })
}
```
> Implementer note: confirm `useMutation`/`useQueryClient` are imported in servers.ts (they're used by other mutations there) and that `api.post` exists (check `web/src/api/client.ts` for the method name — it may be `api.post`/`api.postJSON`; mirror an existing POST mutation in the file). Match the existing call style.

- [ ] **Step 2: Add the Traffic card** to `web/src/pages/admin/ServerDetail.tsx`. Read the file first; reuse its `Card`/`CardHeader`/`CardTitle`/`CardContent`/`KV` components and the `bytes()` humanizer from `@/lib/bytes` (already imported for the Hardware card). Add near the Hardware card:
```tsx
const traffic = useHostTraffic(id)
const setDay = useSetTrafficResetDay(id)
const resetTraffic = useResetTraffic(id)
```
and the card:
```tsx
<Card>
  <CardHeader><CardTitle>流量</CardTitle></CardHeader>
  <CardContent>
    {!traffic.data ? (
      <p className="text-muted-foreground text-[12px]">—</p>
    ) : (
      <>
        <KV k="本周期" v={`↑ ${bytes(traffic.data.cum_bytes_up)}　↓ ${bytes(traffic.data.cum_bytes_down)}`} />
        <KV k="上周期" v={`↑ ${bytes(traffic.data.prev_bytes_up)}　↓ ${bytes(traffic.data.prev_bytes_down)}`} />
        <KV k="重置日" v={
          <input type="number" min={1} max={28} defaultValue={traffic.data.reset_day}
            className="w-16 bg-transparent border rounded px-1"
            onBlur={(e) => { const d = Number(e.target.value); if (d >= 1 && d <= 28 && d !== traffic.data!.reset_day) setDay.mutate(d) }} />
        } />
        <KV k="上次重置" v={traffic.data.last_reset_at ? new Date(traffic.data.last_reset_at).toLocaleString() : '—'} />
        <button className="mt-2 text-[12px] border rounded px-2 py-1"
          onClick={() => { if (confirm('确认立即重置该服务器累计流量?')) resetTraffic.mutate() }}>
          立即重置
        </button>
      </>
    )}
  </CardContent>
</Card>
```
> Implementer note: match the file's actual `KV` signature (it may take string only — if so, render the reset-day input as a separate row/element rather than passing JSX to `v`). Mirror the existing button/input styling used elsewhere on the page rather than these placeholder classes.

- [ ] **Step 3: Add the global TZ field** to `web/src/pages/admin/Settings.tsx`. Read the file first to see how it renders existing settings (it uses `useSettings()` → `Record<string,string>` and `usePatchSettings()`). Add a labelled text input for `traffic_reset_tz` (default shown as `UTC` when unset) that patches `{ traffic_reset_tz: value }` on change/blur — mirror an existing text setting field in the file.

- [ ] **Step 4: Add/extend the ServerDetail test** in `web/src/pages/admin/ServerDetail.test.tsx`. Mirror the existing mock of `@/api/servers` (it already mocks `useHostInventory` etc.). Mock `useHostTraffic` to return a row and assert the card shows "本周期", the formatted up/down bytes, and the reset-day input value; add a `null`/loading case showing "—".

- [ ] **Step 5: Run vitest + tsc**

Run: `cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/ServerDetail.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/hg/project/Shepherd
git add web/src/api/servers.ts web/src/pages/admin/ServerDetail.tsx web/src/pages/admin/Settings.tsx web/src/pages/admin/ServerDetail.test.tsx
git commit -m "feat(web): server Traffic card + global traffic_reset_tz setting"
```

---

## Task 7: Full verification

- [ ] **Step 1: Full Go suite (with -race) + vet + build**

Run: `cd /Users/hg/project/Shepherd && go build ./... && go test -race ./internal/agent/... ./internal/telemetrysvc/... ./internal/api/... && go test ./... && go vet ./...`
Expected: build OK; race-clean; all packages PASS; vet clean.

- [ ] **Step 2: gofmt on changed Go files**

Run: `cd /Users/hg/project/Shepherd && gofmt -l internal/agent/collector/ internal/agentapi/types.go internal/telemetrysvc/ internal/api/admin_servers.go internal/api/admin_settings.go internal/api/router.go cmd/server/main.go`
Expected: prints nothing. (If a pre-existing unrelated file like `traffic_rollup.go` appears, confirm it's not in this branch's diff and ignore it.)

- [ ] **Step 3: Frontend tsc + full vitest**

Run: `cd /Users/hg/project/Shepherd/web && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all suites PASS.

- [ ] **Step 4: Restore embed artifact if touched + clean tree**

Run: `cd /Users/hg/project/Shepherd && git checkout -- internal/web/dist/.gitkeep 2>/dev/null; git status --short`
Expected: clean.

---

## Self-Review Notes

- **Spec coverage:** physical-iface filter shared by bps+cumulative (Task 1) ✓; exact byte deltas in 30s telemetry (Task 1) ✓; `host_traffic` table + `traffic_reset_tz` seed (Task 2) ✓; upsert accumulation, first-insert `last_reset_at=now` (Task 2) ✓; `lastResetBoundary` pure fn + store (snapshot-zero, prev_* snapshot, default-when-absent) (Task 3) ✓; hourly reset job + wiring (Task 4) ✓; GET/reset-day(1..28)/reset endpoints + TZ allowlist (Task 5) ✓; Traffic card + editable reset day + reset button + global TZ field (Task 6) ✓; `-race` verification (Task 7) ✓. Out-of-scope (C, per-iface, history-beyond-prev) absent.
- **Type consistency:** `agentapi.Telemetry.NetRxBytes/NetTxBytes` (Task 1) → `WriteSample` reads them, up=tx/down=rx (Task 2) → `HostTrafficRow{CumBytesUp/Down,PrevBytesUp/Down,ResetDay,LastResetAt}` (Task 3) → API serializes the row + handlers use `Query.HostTraffic/SetTrafficResetDay/ResetTrafficNow` (Task 5) → TS `HostTraffic` type fields match the json tags (Task 6). `NetMeter.Sample()` 5-value signature updated at both call sites (collector.go + collector_test.go, Task 1).
- **Migration:** core `0008` (next after `0007`), both dialects, FK CASCADE, seeds `traffic_reset_tz`; down drops table + setting.
- **Reset correctness:** accumulation never negative (agent sends only `ok=true` ticks); reset boundary uses day 1..28 (no clamp); job reset is idempotent within a period (last_reset_at advances past the boundary); all row-creation paths set `last_reset_at=now`.
- **pathID2 reuse:** the implementer note in Task 5 prevents inventing a `pathID3` — `pathID2` handles multi-segment literal suffixes.
- **CI gate:** Task 7 runs `go test -race`.
