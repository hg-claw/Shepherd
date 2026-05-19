package xray

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func TestMigration0004_CreatesTrafficTables(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}

	// Seed server row for FK constraint (only columns that exist in servers table)
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at) VALUES (?,?,?,?,?,?)`,
		1, "s1", "1.1.1.1", "root", 22, time.Now())

	migs := loadMigrations()
	if err := plugins.RunPluginMigrations(context.Background(), d, "xray", migs); err != nil {
		t.Fatal(err)
	}

	for _, tbl := range []string{"xray_traffic_raw", "xray_traffic_minute", "xray_traffic_hour"} {
		var n int
		if err := d.Get(&n, "SELECT COUNT(*) FROM "+tbl); err != nil {
			t.Fatalf("table %s not found: %v", tbl, err)
		}
	}

	// Verify row can be inserted
	_, err = d.Exec(`INSERT INTO xray_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
		VALUES (1, 'vless-reality-8443', 'inbound', datetime('now'), 1024, 2048)`)
	if err != nil {
		t.Fatalf("insert xray_traffic_raw: %v", err)
	}
}
