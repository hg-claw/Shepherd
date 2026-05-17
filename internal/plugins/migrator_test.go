package plugins

import (
	"context"
	"path/filepath"
	"testing"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/jmoiron/sqlx"
)

func openTestDB(t *testing.T) *sqlx.DB {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "m.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestRunPluginMigrations_AppliesEach(t *testing.T) {
	d := openTestDB(t)
	migs := []Migration{
		{Name: "0001_init", SQL: "CREATE TABLE foo (id INTEGER);"},
		{Name: "0002_more", SQL: "CREATE TABLE bar (id INTEGER);"},
	}
	if err := RunPluginMigrations(context.Background(), d, "x", migs); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = d.Get(&n, "SELECT COUNT(*) FROM plugin_migrations WHERE plugin_id='x'")
	if n != 2 {
		t.Fatalf("plugin_migrations rows = %d want 2", n)
	}
}

func TestRunPluginMigrations_Idempotent(t *testing.T) {
	d := openTestDB(t)
	migs := []Migration{{Name: "0001", SQL: "CREATE TABLE foo (id INTEGER);"}}
	ctx := context.Background()
	if err := RunPluginMigrations(ctx, d, "x", migs); err != nil {
		t.Fatal(err)
	}
	// Second call must NOT re-run the SQL (would error "table already exists").
	if err := RunPluginMigrations(ctx, d, "x", migs); err != nil {
		t.Fatalf("second call: %v", err)
	}
}
