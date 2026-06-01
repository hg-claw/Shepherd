package telemetrysvc

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func TestQuery_1h_UsesRawTable(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	res, _ := d.Exec("INSERT INTO servers(name) VALUES ('h')")
	sid, _ := res.LastInsertId()
	ing := &Ingest{DB: d}
	now := time.Now().UTC()
	for i := 0; i < 5; i++ {
		_ = ing.WriteSample(context.Background(), sid, agentapi.Telemetry{TS: now.Add(-time.Duration(i) * time.Minute), CPUPct: float64(i)})
	}
	q := &Query{DB: d}
	pts, err := q.Series(context.Background(), sid, Range1h)
	if err != nil {
		t.Fatal(err)
	}
	if len(pts) != 5 {
		t.Errorf("len=%d want 5", len(pts))
	}
}

func TestQuery_BadRange(t *testing.T) {
	q := &Query{}
	if _, err := q.Series(context.Background(), 1, "30d"); err == nil {
		t.Fatal("want error")
	}
}

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
	em, err := q.LatestForAll(context.Background(), nil)
	if err != nil || len(em) != 0 {
		t.Fatalf("empty ids: m=%v err=%v", em, err)
	}
}
