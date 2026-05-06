package db

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
)

func TestOpenSQLite_PragmasApplied(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, err := Open(context.Background(), Config{Driver: DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	var mode string
	if err := d.Get(&mode, "PRAGMA journal_mode"); err != nil {
		t.Fatal(err)
	}
	if mode != "wal" {
		t.Errorf("journal_mode=%q want wal", mode)
	}

	var fk int
	if err := d.Get(&fk, "PRAGMA foreign_keys"); err != nil {
		t.Fatal(err)
	}
	if fk != 1 {
		t.Errorf("foreign_keys=%d want 1", fk)
	}
}

func TestOpenSQLite_PragmasHoldAcrossPoolConnections(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, err := Open(context.Background(), Config{Driver: DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	// Hit the pool concurrently. Without SetMaxOpenConns(1) we'd see
	// at least one connection report foreign_keys=0.
	var wg sync.WaitGroup
	errCh := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var fk int
			if err := d.Get(&fk, "PRAGMA foreign_keys"); err != nil {
				errCh <- err
				return
			}
			if fk != 1 {
				errCh <- fmt.Errorf("foreign_keys=%d on a pool connection", fk)
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}
}

func TestOpen_UnknownDriver(t *testing.T) {
	_, err := Open(context.Background(), Config{Driver: "bogus", DSN: "x"})
	if err == nil {
		t.Fatal("want error")
	}
}

func TestMigrate_SQLite_AppliesAllTables(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, err := Open(context.Background(), Config{Driver: DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if err := Migrate(d, DriverSQLite); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"admins", "sessions", "servers", "enrollment_tokens", "machine_tokens",
		"telemetry_samples_30s", "telemetry_rollup_5m", "telemetry_rollup_1h", "settings",
	}
	for _, name := range want {
		var n int
		if err := d.Get(&n, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", name); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Errorf("missing table %q", name)
		}
	}
	var v string
	if err := d.Get(&v, "SELECT value FROM settings WHERE key='public_display_mode'"); err != nil {
		t.Fatal(err)
	}
	if v != "both" {
		t.Errorf("public_display_mode=%q want both", v)
	}
}
