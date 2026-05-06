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
	t.Cleanup(func() { d.Close() })
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
