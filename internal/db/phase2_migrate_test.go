package db

import (
	"context"
	"testing"
)

func TestPhase2_TablesExist(t *testing.T) {
	d, err := Open(context.Background(), Config{Driver: "sqlite", DSN: ":memory:"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := Migrate(d, "sqlite"); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"pty_sessions", "scripts", "script_runs", "script_run_targets", "audit_log"} {
		var n int
		if err := d.Get(&n, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", table); err != nil {
			t.Fatalf("query %s: %v", table, err)
		}
		if n != 1 {
			t.Fatalf("table %s missing", table)
		}
	}
	for _, key := range []string{"file_sandbox_enabled", "file_sandbox_paths", "audit_retention_days", "pty_recording_enabled", "pty_max_concurrent_per_admin", "file_upload_max_bytes", "file_chunk_bytes"} {
		var v string
		if err := d.Get(&v, "SELECT value FROM settings WHERE key=?", key); err != nil {
			t.Fatalf("setting %s missing: %v", key, err)
		}
	}
}
