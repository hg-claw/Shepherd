package telemetrysvc

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func newIngest(t *testing.T) (*Ingest, int64) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	res, _ := d.Exec("INSERT INTO servers(name) VALUES ('h')")
	id, _ := res.LastInsertId()
	return &Ingest{DB: d}, id
}

func TestWriteSample_PersistsAndBumpsLastSeen(t *testing.T) {
	ing, sid := newIngest(t)
	now := time.Now().UTC().Truncate(time.Second)
	tt := agentapi.Telemetry{
		TS: now, CPUPct: 12.5, MemUsed: 1, MemTotal: 2, Load1: 0.1,
		NetRxBps: 100, NetTxBps: 200, TCPConn: 7,
		Disks: []agentapi.Disk{{Mount: "/", Used: 10, Total: 100}},
	}
	if err := ing.WriteSample(context.Background(), sid, tt); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := ing.DB.Get(&n, "SELECT COUNT(*) FROM telemetry_samples_30s WHERE server_id=?", sid); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("rows=%d", n)
	}
	var seen time.Time
	if err := ing.DB.Get(&seen, "SELECT agent_last_seen FROM servers WHERE id=?", sid); err != nil {
		t.Fatal(err)
	}
	if seen.IsZero() {
		t.Error("agent_last_seen not bumped")
	}
}
