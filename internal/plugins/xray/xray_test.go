package xray

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func TestXrayMetaIsHostAware(t *testing.T) {
	p := New()
	m := p.Meta()
	if m.ID != "xray" {
		t.Fatalf("id = %s", m.ID)
	}
	if !m.HostAware {
		t.Fatal("meta.HostAware must be true")
	}
}

func TestXraySatisfiesHostAware(t *testing.T) {
	var _ plugins.HostAware = New()
}

func TestXrayMigrationsHaveContent(t *testing.T) {
	p := New()
	migs := p.Migrations()
	if len(migs) == 0 {
		t.Fatal("expected at least one migration")
	}
	if migs[0].Name == "" || migs[0].SQL == "" {
		t.Fatalf("empty migration: %+v", migs[0])
	}
}

func TestMigration0002_CreatesTopologyAndBackfillsLanding(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "p.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}

	// Seed: one server + one xray plugin_host BEFORE the topology migration runs.
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port)
		VALUES (?,?,?,?,?)`, 9, "s9", "1.2.3.4", "root", 22)
	d.MustExec(`INSERT INTO plugins(id,enabled,config_json,created_at)
		VALUES (?,?,?,?)`, "xray", 1, "{}", time.Now())
	d.MustExec(`INSERT INTO plugin_hosts(plugin_id,server_id,config_json,status,updated_at)
		VALUES (?,?,?,?,?)`, "xray", 9, "{}", "running", time.Now())

	// Apply ONLY the xray plugin migrations (0001 + 0002).
	migs := loadMigrations()
	if err := plugins.RunPluginMigrations(context.Background(), d, "xray", migs); err != nil {
		t.Fatal(err)
	}

	var n int
	if err := d.Get(&n, "SELECT COUNT(*) FROM xray_host_topology WHERE server_id=9"); err != nil {
		t.Fatalf("query topology: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected 1 backfilled landing row, got %d", n)
	}
	var role string
	_ = d.Get(&role, "SELECT role FROM xray_host_topology WHERE server_id=9")
	if role != "landing" {
		t.Fatalf("backfill role = %q want landing", role)
	}
}
