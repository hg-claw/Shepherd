package db

import (
	"context"
	"path/filepath"
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

func TestOpen_UnknownDriver(t *testing.T) {
	_, err := Open(context.Background(), Config{Driver: "bogus", DSN: "x"})
	if err == nil {
		t.Fatal("want error")
	}
}
