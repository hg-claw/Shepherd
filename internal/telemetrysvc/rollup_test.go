package telemetrysvc

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func TestRollup_5m_FoldsClosedBucket(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	res, _ := d.Exec("INSERT INTO servers(name) VALUES ('h')")
	sid, _ := res.LastInsertId()
	ing := &Ingest{DB: d}

	bucket := time.Now().UTC().Add(-10 * time.Minute).Truncate(5 * time.Minute)
	for i, cpu := range []float64{10, 20, 30, 40} {
		_ = ing.WriteSample(context.Background(), sid, agentapi.Telemetry{
			TS: bucket.Add(time.Duration(i) * 30 * time.Second), CPUPct: cpu, MemUsed: int64(100 * (i + 1)), MemTotal: 1000,
		})
	}
	r := &Rollup{DB: d}
	if err := r.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	var n int
	var cpuAvg, cpuMax float64
	d.Get(&n, "SELECT COUNT(*) FROM telemetry_rollup_5m WHERE server_id=?", sid)
	if n != 1 {
		t.Fatalf("rows=%d want 1", n)
	}
	d.Get(&cpuAvg, "SELECT cpu_avg FROM telemetry_rollup_5m WHERE server_id=?", sid)
	d.Get(&cpuMax, "SELECT cpu_max FROM telemetry_rollup_5m WHERE server_id=?", sid)
	if cpuAvg != 25 || cpuMax != 40 {
		t.Errorf("avg=%v max=%v want 25/40", cpuAvg, cpuMax)
	}
	// Idempotent: second tick must not duplicate.
	_ = r.Tick(context.Background())
	d.Get(&n, "SELECT COUNT(*) FROM telemetry_rollup_5m WHERE server_id=?", sid)
	if n != 1 {
		t.Errorf("rollup duplicated rows=%d", n)
	}
}

func TestRollup_OpenBucketSkipped(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	res, _ := d.Exec("INSERT INTO servers(name) VALUES ('h')")
	sid, _ := res.LastInsertId()
	ing := &Ingest{DB: d}
	_ = ing.WriteSample(context.Background(), sid, agentapi.Telemetry{TS: time.Now().UTC()})
	r := &Rollup{DB: d}
	_ = r.Tick(context.Background())
	var n int
	d.Get(&n, "SELECT COUNT(*) FROM telemetry_rollup_5m")
	if n != 0 {
		t.Errorf("open bucket was rolled up")
	}
}
