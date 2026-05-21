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
	migs := p.Migrations(shepdb.DriverSQLite)
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
	migs := loadMigrations(shepdb.DriverSQLite)
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

func TestMigration0003_CreatesInboundsTable(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "p.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	if err := plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations(shepdb.DriverSQLite)); err != nil {
		t.Fatal(err)
	}

	// xray_inbounds table exists
	var n int
	if err := d.Get(&n,
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='xray_inbounds'"); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("xray_inbounds table not created")
	}

	// Seed two servers for the constraint test
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at)
		VALUES (1,'s1','1.1.1.1','r',22,?), (2,'s2','2.2.2.2','r',22,?)`,
		time.Now(), time.Now())

	// CHECK: landing must have NULL upstream
	_, err = d.Exec(`INSERT INTO xray_inbounds(server_id, tag, port, role, upstream_inbound_id, updated_at)
		VALUES (1, 'landing-aaaa', 443, 'landing', 99, ?)`, time.Now())
	if err == nil {
		t.Fatalf("expected CHECK violation when landing has upstream, got nil")
	}

	// CHECK: relay must have non-NULL upstream
	_, err = d.Exec(`INSERT INTO xray_inbounds(server_id, tag, port, role, upstream_inbound_id, updated_at)
		VALUES (1, 'relay-bbbb', 444, 'relay', NULL, ?)`, time.Now())
	if err == nil {
		t.Fatalf("expected CHECK violation when relay has NULL upstream, got nil")
	}

	// Valid landing + valid relay pointing at it
	d.MustExec(`INSERT INTO xray_inbounds(server_id, tag, port, role, updated_at)
		VALUES (1, 'landing-cccc', 443, 'landing', ?)`, time.Now())
	var landingID int64
	_ = d.Get(&landingID, `SELECT id FROM xray_inbounds WHERE tag='landing-cccc'`)
	d.MustExec(`INSERT INTO xray_inbounds(server_id, tag, port, role, upstream_inbound_id, updated_at)
		VALUES (2, 'relay-dddd', 8443, 'relay', ?, ?)`, landingID, time.Now())

	// RESTRICT: deleting landing while relay depends on it must fail
	_, err = d.Exec(`DELETE FROM xray_inbounds WHERE id=?`, landingID)
	if err == nil {
		t.Fatalf("expected RESTRICT to block landing delete with dependent relay")
	}

	// UNIQUE(server_id, port)
	_, err = d.Exec(`INSERT INTO xray_inbounds(server_id, tag, port, role, updated_at)
		VALUES (1, 'landing-eeee', 443, 'landing', ?)`, time.Now())
	if err == nil {
		t.Fatalf("expected UNIQUE(server_id,port) violation")
	}

	// UNIQUE(server_id, tag)
	_, err = d.Exec(`INSERT INTO xray_inbounds(server_id, tag, port, role, updated_at)
		VALUES (1, 'landing-cccc', 9443, 'landing', ?)`, time.Now())
	if err == nil {
		t.Fatalf("expected UNIQUE(server_id,tag) violation")
	}
}
