package db

import (
	"context"
	"path/filepath"
	"testing"
)

func TestMigrate_Phase3Tables(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "p3.db") + "?_fk=1"
	d, err := Open(context.Background(), Config{Driver: DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = d.Close() }()
	if err := Migrate(d, DriverSQLite); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"plugins", "plugin_hosts", "plugin_migrations"} {
		var n int
		if err := d.Get(&n, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", table); err != nil {
			t.Fatalf("query %s: %v", table, err)
		}
		if n != 1 {
			t.Fatalf("table %s not created", table)
		}
	}
}
