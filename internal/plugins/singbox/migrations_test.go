package singbox

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/jmoiron/sqlx"
)

func newSingboxTestDB(t *testing.T) *sqlx.DB {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "sb.db") + "?_fk=1"
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

func seedSingboxServers(t *testing.T, d *sqlx.DB, ids ...int64) {
	t.Helper()
	for _, id := range ids {
		d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at)
			VALUES (?,?,?,?,?,?)`,
			id, "s"+fmt.Sprint(id), "1.2.3."+fmt.Sprint(id), "root", 22, time.Now())
	}
}

// runSingboxMigrations applies all 4 singbox migrations.
func runSingboxMigrations(t *testing.T, d *sqlx.DB) {
	t.Helper()
	if err := plugins.RunPluginMigrations(context.Background(), d, "singbox", loadMigrations()); err != nil {
		t.Fatal(err)
	}
}

// ─── 0001 singbox_inbounds ───────────────────────────────────────────────────

func TestMigration0001_SingboxInbounds(t *testing.T) {
	d := newSingboxTestDB(t)
	runSingboxMigrations(t, d)
	seedSingboxServers(t, d, 1, 2)

	// Table exists
	var n int
	if err := d.Get(&n,
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='singbox_inbounds'"); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatal("singbox_inbounds table not created")
	}

	// INSERT valid landing
	d.MustExec(`INSERT INTO singbox_inbounds
		(server_id,tag,port,role,protocol,updated_at)
		VALUES (1,'landing-aabb1122',443,'landing','vless-reality',?)`, time.Now())
	var landingID int64
	_ = d.Get(&landingID, `SELECT id FROM singbox_inbounds WHERE tag='landing-aabb1122'`)

	// CHECK: landing with non-NULL upstream_inbound_id must fail
	_, err := d.Exec(`INSERT INTO singbox_inbounds
		(server_id,tag,port,role,protocol,upstream_inbound_id,updated_at)
		VALUES (1,'landing-bad',444,'landing','vless-reality',?,?)`, landingID, time.Now())
	if err == nil {
		t.Fatal("expected CHECK violation: landing cannot have upstream_inbound_id")
	}

	// CHECK: relay with NULL upstream_inbound_id must fail
	_, err = d.Exec(`INSERT INTO singbox_inbounds
		(server_id,tag,port,role,protocol,upstream_inbound_id,updated_at)
		VALUES (1,'relay-bad',445,'relay','vless-reality',NULL,?)`, time.Now())
	if err == nil {
		t.Fatal("expected CHECK violation: relay must have upstream_inbound_id")
	}

	// Valid relay
	d.MustExec(`INSERT INTO singbox_inbounds
		(server_id,tag,port,role,protocol,upstream_inbound_id,updated_at)
		VALUES (2,'relay-ccdd3344',8443,'relay','hysteria2',?,?)`, landingID, time.Now())

	// RESTRICT: deleting landing while relay depends on it must fail
	_, err = d.Exec(`DELETE FROM singbox_inbounds WHERE id=?`, landingID)
	if err == nil {
		t.Fatal("expected RESTRICT: cannot delete landing with dependent relay")
	}

	// UNIQUE(server_id, port)
	_, err = d.Exec(`INSERT INTO singbox_inbounds
		(server_id,tag,port,role,protocol,updated_at)
		VALUES (1,'landing-dup',443,'landing','vmess-tcp',?)`, time.Now())
	if err == nil {
		t.Fatal("expected UNIQUE(server_id,port) violation")
	}

	// UNIQUE(server_id, tag)
	_, err = d.Exec(`INSERT INTO singbox_inbounds
		(server_id,tag,port,role,protocol,updated_at)
		VALUES (1,'landing-aabb1122',9443,'landing','vmess-tcp',?)`, time.Now())
	if err == nil {
		t.Fatal("expected UNIQUE(server_id,tag) violation")
	}
}

// ─── 0002 singbox_binaries ───────────────────────────────────────────────────

func TestMigration0002_SingboxBinaries(t *testing.T) {
	d := newSingboxTestDB(t)
	runSingboxMigrations(t, d)

	// Table exists
	var n int
	if err := d.Get(&n,
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='singbox_binaries'"); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatal("singbox_binaries table not created")
	}

	// Insert a binary
	d.MustExec(`INSERT INTO singbox_binaries(version,os,arch,size_bytes,sha256)
		VALUES ('1.10.0','linux','amd64',12345678,'deadbeef01234567')`)

	// Composite PK conflict (version, os, arch)
	_, err := d.Exec(`INSERT INTO singbox_binaries(version,os,arch,size_bytes,sha256)
		VALUES ('1.10.0','linux','amd64',99999,'ffffffffffffffff')`)
	if err == nil {
		t.Fatal("expected PRIMARY KEY conflict on (version,os,arch)")
	}

	// Different arch — must succeed
	d.MustExec(`INSERT INTO singbox_binaries(version,os,arch,size_bytes,sha256)
		VALUES ('1.10.0','linux','arm64',11000000,'aabb1122')`)
}

// ─── 0003 singbox_traffic ────────────────────────────────────────────────────

func TestMigration0003_SingboxTraffic(t *testing.T) {
	d := newSingboxTestDB(t)
	runSingboxMigrations(t, d)
	seedSingboxServers(t, d, 1)

	for _, tbl := range []string{"singbox_traffic_raw", "singbox_traffic_minute", "singbox_traffic_hour"} {
		var n int
		if err := d.Get(&n,
			"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", tbl); err != nil {
			t.Fatalf("checking %s: %v", tbl, err)
		}
		if n != 1 {
			t.Fatalf("table %s not created", tbl)
		}
	}

	now := time.Now().UTC().Truncate(time.Minute)

	// Insert raw row
	d.MustExec(`INSERT INTO singbox_traffic_raw(server_id,tag,kind,ts,bytes_up,bytes_down)
		VALUES (1,'landing-aabb','landing',?,1000,2000)`, now)

	// minute composite PK: ON CONFLICT idempotent UPSERT
	d.MustExec(`INSERT INTO singbox_traffic_minute(server_id,tag,kind,ts,bytes_up,bytes_down)
		VALUES (1,'landing-aabb','landing',?,1000,2000)
		ON CONFLICT(server_id,tag,kind,ts) DO UPDATE SET
			bytes_up   = bytes_up   + excluded.bytes_up,
			bytes_down = bytes_down + excluded.bytes_down`, now)
	d.MustExec(`INSERT INTO singbox_traffic_minute(server_id,tag,kind,ts,bytes_up,bytes_down)
		VALUES (1,'landing-aabb','landing',?,500,600)
		ON CONFLICT(server_id,tag,kind,ts) DO UPDATE SET
			bytes_up   = bytes_up   + excluded.bytes_up,
			bytes_down = bytes_down + excluded.bytes_down`, now)

	var up, down int
	_ = d.Get(&up, `SELECT bytes_up FROM singbox_traffic_minute WHERE server_id=1 AND tag='landing-aabb'`)
	_ = d.Get(&down, `SELECT bytes_down FROM singbox_traffic_minute WHERE server_id=1 AND tag='landing-aabb'`)
	if up != 1500 || down != 2600 {
		t.Fatalf("minute UPSERT wrong: up=%d down=%d", up, down)
	}

	// hour composite PK works the same way
	d.MustExec(`INSERT INTO singbox_traffic_hour(server_id,tag,kind,ts,bytes_up,bytes_down)
		VALUES (1,'landing-aabb','landing',?,1000,2000)
		ON CONFLICT(server_id,tag,kind,ts) DO UPDATE SET
			bytes_up   = bytes_up   + excluded.bytes_up,
			bytes_down = bytes_down + excluded.bytes_down`, now)
}

// ─── 0004 singbox_certificates ───────────────────────────────────────────────

func TestMigration0004_SingboxCertificates(t *testing.T) {
	d := newSingboxTestDB(t)
	runSingboxMigrations(t, d)

	// Table exists
	var n int
	if err := d.Get(&n,
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='singbox_certificates'"); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatal("singbox_certificates table not created")
	}

	expires := time.Now().Add(90 * 24 * time.Hour)

	// Insert a valid certificate
	d.MustExec(`INSERT INTO singbox_certificates(domain,cert_pem,key_pem,expires_at,status)
		VALUES ('proxy.example.com','CERT_PEM','KEY_PEM',?,'issuing')`, expires)

	// UNIQUE domain
	_, err := d.Exec(`INSERT INTO singbox_certificates(domain,cert_pem,key_pem,expires_at,status)
		VALUES ('proxy.example.com','CERT2','KEY2',?,'issuing')`, expires)
	if err == nil {
		t.Fatal("expected UNIQUE violation on domain")
	}

	// status CHECK: invalid value
	_, err = d.Exec(`INSERT INTO singbox_certificates(domain,cert_pem,key_pem,expires_at,status)
		VALUES ('other.example.com','C','K',?,'invalid_status')`, expires)
	if err == nil {
		t.Fatal("expected CHECK violation on status")
	}

	// All valid status values
	for _, s := range []string{"active", "failed", "revoked"} {
		dom := s + ".example.com"
		d.MustExec(`INSERT INTO singbox_certificates(domain,cert_pem,key_pem,expires_at,status)
			VALUES (?,?,?,?,?)`, dom, "C", "K", expires, s)
	}

	// cert_id FK: inbound referencing an existing cert must work,
	// then DELETE RESTRICT must block certificate deletion.
	seedSingboxServers(t, d, 10)
	var certID int64
	_ = d.Get(&certID, `SELECT id FROM singbox_certificates WHERE domain='proxy.example.com'`)

	d.MustExec(`INSERT INTO singbox_inbounds(server_id,tag,port,role,protocol,cert_id,sni,updated_at)
		VALUES (10,'landing-tls0001',443,'landing','trojan-tls',?,'proxy.example.com',?)`,
		certID, time.Now())

	// RESTRICT: deleting cert while inbound references it must fail
	_, err = d.Exec(`DELETE FROM singbox_certificates WHERE id=?`, certID)
	if err == nil {
		t.Fatal("expected RESTRICT: cannot delete cert while inbound references it")
	}
}
