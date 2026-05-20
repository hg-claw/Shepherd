package telemetrysvc

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
	sbplugin "github.com/hg-claw/Shepherd/internal/plugins/singbox"
)

func newSingboxRollupDB(t *testing.T) (*Ingest, int64) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "sbr.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "singbox", sbplugin.Migrations())
	res, _ := d.Exec("INSERT INTO servers(name) VALUES ('h')")
	sid, _ := res.LastInsertId()
	return &Ingest{DB: d}, sid
}

func TestSingboxTrafficRollupRawToMinute(t *testing.T) {
	ing, sid := newSingboxRollupDB(t)
	ctx := context.Background()
	// Insert 4 raw samples all in the same minute bucket, 2 minutes ago.
	bucket := time.Now().UTC().Add(-2 * time.Minute).Truncate(time.Minute)
	for i := 0; i < 4; i++ {
		ts := bucket.Add(time.Duration(i) * 15 * time.Second)
		_, err := ing.DB.ExecContext(ctx,
			`INSERT INTO singbox_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
             VALUES (?, 'landing-aabb1122', 'landing', ?, 1000, 2000)`, sid, ts)
		if err != nil {
			t.Fatal(err)
		}
	}

	r := &SingboxTrafficRollup{DB: ing.DB}
	if err := r.rollupRawToMinute(ctx); err != nil {
		t.Fatal(err)
	}

	var n int
	_ = ing.DB.GetContext(ctx, &n,
		"SELECT COUNT(*) FROM singbox_traffic_minute WHERE server_id=?", sid)
	if n != 1 {
		t.Fatalf("singbox_traffic_minute rows = %d, want 1", n)
	}
	var up, down int64
	_ = ing.DB.GetContext(ctx, &up, "SELECT bytes_up   FROM singbox_traffic_minute WHERE server_id=?", sid)
	_ = ing.DB.GetContext(ctx, &down, "SELECT bytes_down FROM singbox_traffic_minute WHERE server_id=?", sid)
	if up != 4000 {
		t.Errorf("bytes_up = %d, want 4000 (4 × 1000)", up)
	}
	if down != 8000 {
		t.Errorf("bytes_down = %d, want 8000 (4 × 2000)", down)
	}
}

func TestSingboxTrafficRollupMinuteToHour(t *testing.T) {
	ing, sid := newSingboxRollupDB(t)
	ctx := context.Background()
	// Insert 60 minute rows all in the same hour bucket, 2 hours ago.
	bucket := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Hour)
	for i := 0; i < 60; i++ {
		ts := bucket.Add(time.Duration(i) * time.Minute)
		_, err := ing.DB.ExecContext(ctx,
			`INSERT INTO singbox_traffic_minute (server_id, tag, kind, ts, bytes_up, bytes_down)
             VALUES (?, 'landing-aabb1122', 'landing', ?, 100, 200)
             ON CONFLICT DO NOTHING`, sid, ts)
		if err != nil {
			t.Fatal(err)
		}
	}

	r := &SingboxTrafficRollup{DB: ing.DB}
	if err := r.rollupMinuteToHour(ctx); err != nil {
		t.Fatal(err)
	}

	var up int64
	_ = ing.DB.GetContext(ctx, &up,
		"SELECT bytes_up FROM singbox_traffic_hour WHERE server_id=?", sid)
	if up != 6000 {
		t.Errorf("bytes_up = %d, want 6000 (60 × 100)", up)
	}
}

func TestSingboxTrafficRollupIdempotent(t *testing.T) {
	ing, sid := newSingboxRollupDB(t)
	ctx := context.Background()
	bucket := time.Now().UTC().Add(-2 * time.Minute).Truncate(time.Minute)
	ing.DB.MustExec(
		`INSERT INTO singbox_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
         VALUES (?, 'landing-aabb1122', 'landing', ?, 1000, 2000)`, sid, bucket)

	r := &SingboxTrafficRollup{DB: ing.DB}
	_ = r.rollupRawToMinute(ctx)
	_ = r.rollupRawToMinute(ctx) // second run: must not double-count

	var n int
	_ = ing.DB.GetContext(ctx, &n, "SELECT COUNT(*) FROM singbox_traffic_minute WHERE server_id=?", sid)
	if n != 1 {
		t.Errorf("idempotent rollup duplicated rows: %d", n)
	}
}

func TestSingboxTrafficRollupOpenBucketSkipped(t *testing.T) {
	ing, sid := newSingboxRollupDB(t)
	ctx := context.Background()
	// Insert a raw sample timestamped "now" — bucket is still open.
	ing.DB.MustExec(
		`INSERT INTO singbox_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
         VALUES (?, 'landing-aabb1122', 'landing', datetime('now'), 500, 1000)`, sid)

	r := &SingboxTrafficRollup{DB: ing.DB}
	_ = r.rollupRawToMinute(ctx)

	var n int
	_ = ing.DB.GetContext(ctx, &n, "SELECT COUNT(*) FROM singbox_traffic_minute")
	if n != 0 {
		t.Errorf("open bucket was rolled up (rows=%d)", n)
	}
}

func TestSingboxTrafficRetention(t *testing.T) {
	ing, sid := newSingboxRollupDB(t)
	ctx := context.Background()

	// Insert old raw sample (>24h ago) and new raw sample (<24h).
	oldTS := time.Now().UTC().Add(-25 * time.Hour)
	newTS := time.Now().UTC().Add(-1 * time.Hour)
	ing.DB.MustExec(
		`INSERT INTO singbox_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
         VALUES (?, 'landing', 'landing', ?, 100, 200)`, sid, oldTS)
	ing.DB.MustExec(
		`INSERT INTO singbox_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
         VALUES (?, 'landing', 'landing', ?, 100, 200)`, sid, newTS)

	// Insert old minute row (>7d) and new minute row (<7d).
	oldMinute := time.Now().UTC().Add(-8 * 24 * time.Hour).Truncate(time.Minute)
	newMinute := time.Now().UTC().Add(-1 * 24 * time.Hour).Truncate(time.Minute)
	ing.DB.MustExec(
		`INSERT INTO singbox_traffic_minute (server_id, tag, kind, ts, bytes_up, bytes_down)
         VALUES (?, 'landing', 'landing', ?, 100, 200)`, sid, oldMinute)
	ing.DB.MustExec(
		`INSERT INTO singbox_traffic_minute (server_id, tag, kind, ts, bytes_up, bytes_down)
         VALUES (?, 'landing', 'landing', ?, 100, 200)`, sid, newMinute)

	// Insert old hour row (>90d) and new hour row (<90d).
	oldHour := time.Now().UTC().Add(-91 * 24 * time.Hour).Truncate(time.Hour)
	newHour := time.Now().UTC().Add(-30 * 24 * time.Hour).Truncate(time.Hour)
	ing.DB.MustExec(
		`INSERT INTO singbox_traffic_hour (server_id, tag, kind, ts, bytes_up, bytes_down)
         VALUES (?, 'landing', 'landing', ?, 100, 200)`, sid, oldHour)
	ing.DB.MustExec(
		`INSERT INTO singbox_traffic_hour (server_id, tag, kind, ts, bytes_up, bytes_down)
         VALUES (?, 'landing', 'landing', ?, 100, 200)`, sid, newHour)

	r := &SingboxTrafficRollup{DB: ing.DB}
	if err := r.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}

	var rawCount, minuteCount, hourCount int
	_ = ing.DB.GetContext(ctx, &rawCount,
		"SELECT COUNT(*) FROM singbox_traffic_raw WHERE server_id=?", sid)
	_ = ing.DB.GetContext(ctx, &minuteCount,
		"SELECT COUNT(*) FROM singbox_traffic_minute WHERE server_id=?", sid)
	_ = ing.DB.GetContext(ctx, &hourCount,
		"SELECT COUNT(*) FROM singbox_traffic_hour WHERE server_id=?", sid)

	if rawCount != 1 {
		t.Errorf("singbox_traffic_raw rows = %d, want 1 (old deleted)", rawCount)
	}
	if minuteCount != 1 {
		t.Errorf("singbox_traffic_minute rows = %d, want 1 (old deleted)", minuteCount)
	}
	if hourCount != 1 {
		t.Errorf("singbox_traffic_hour rows = %d, want 1 (old deleted)", hourCount)
	}
}
