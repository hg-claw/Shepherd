package netquality

import (
	"context"
	"testing"

	"github.com/jmoiron/sqlx"
	_ "github.com/mattn/go-sqlite3"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func TestMetaHostAware(t *testing.T) {
	m := New().Meta()
	if !m.HostAware {
		t.Fatal("netquality must be host-aware (per-server enable + cadence)")
	}
	if m.ID != "netquality" {
		t.Fatalf("id = %s", m.ID)
	}
}

func TestSatisfiesPlugin(t *testing.T) {
	var _ plugins.Plugin = New()
}

func TestMigrationsBothDriversLoad(t *testing.T) {
	// We need each driver's SQL to at least parse + embed cleanly. Real
	// schema validation runs against a live sqlite db below.
	for _, d := range []shepdb.Driver{shepdb.DriverSQLite, shepdb.DriverPostgres} {
		migs := New().Migrations(d)
		if len(migs) == 0 {
			t.Errorf("driver %s: no migrations loaded", d)
		}
	}
}

// TestSeedBuiltinTargets runs the full schema migration against an in-
// memory sqlite, then exercises seedBuiltinTargets — including the
// idempotency property (second call MUST NOT duplicate rows).
func TestSeedBuiltinTargets(t *testing.T) {
	db := openTestDB(t)
	for _, m := range New().Migrations(shepdb.DriverSQLite) {
		if _, err := db.Exec(m.SQL); err != nil {
			t.Fatalf("apply migration %s: %v", m.Name, err)
		}
	}

	ctx := context.Background()
	if err := seedBuiltinTargets(ctx, db); err != nil {
		t.Fatalf("first seed: %v", err)
	}
	var n1 int
	if err := db.Get(&n1, `SELECT COUNT(*) FROM netquality_targets WHERE source='builtin'`); err != nil {
		t.Fatal(err)
	}
	if n1 != len(builtinTargets) {
		t.Errorf("after first seed: count=%d, want %d", n1, len(builtinTargets))
	}

	if err := seedBuiltinTargets(ctx, db); err != nil {
		t.Fatalf("second seed: %v", err)
	}
	var n2 int
	_ = db.Get(&n2, `SELECT COUNT(*) FROM netquality_targets WHERE source='builtin'`)
	if n2 != n1 {
		t.Errorf("second seed duplicated rows: %d → %d", n1, n2)
	}

	// Sanity: each ISP bucket has at least one entry. A future seed PR
	// that accidentally drops e.g. "mobile" should fail here loudly.
	for _, isp := range []string{"telecom", "unicom", "mobile", "overseas"} {
		var c int
		_ = db.Get(&c, `SELECT COUNT(*) FROM netquality_targets WHERE isp=?`, isp)
		if c == 0 {
			t.Errorf("isp %q has zero seeded targets", isp)
		}
	}
}

// openTestDB returns a fresh in-memory sqlite with both the plugin's
// table-of-record (servers) and the plugin_migrations bookkeeping that
// loadMigrations expects upstream. We don't go through the full plugin
// migrator here — that lives in package plugins — but we do need
// `servers` so the FK in netquality_hosts resolves.
func openTestDB(t *testing.T) *sqlx.DB {
	t.Helper()
	db, err := sqlx.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`
		CREATE TABLE servers (id INTEGER PRIMARY KEY, name TEXT);
		CREATE TABLE plugin_migrations (
			plugin_id TEXT, name TEXT, applied_at TIMESTAMP,
			PRIMARY KEY(plugin_id, name)
		);
	`); err != nil {
		t.Fatal(err)
	}
	return db
}
