package xray

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/jmoiron/sqlx"
)

func setupLegacyDB(t *testing.T) (*sqlx.DB, *InboundStore) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "legacy.db") + "?_fk=1"
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
	// Register the xray plugin row (required by plugin_hosts FK).
	d.MustExec(`INSERT INTO plugins(id,enabled,config_json,created_at) VALUES ('xray',1,'{}',?)`, time.Now())
	// Two servers, both with xray. Use only columns that exist in servers table.
	for _, id := range []int64{1, 2} {
		d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at)
			VALUES (?,?,?,?,?,?)`,
			id, "s"+string(rune('0'+id)), "1.1.1."+string(rune('0'+id)), "root", 22, time.Now())
	}

	// Legacy landing on server 1 (3b-shaped plugin_hosts.config_json)
	landingCfg := `{"inbounds":[{"port":443,"protocol":"vless","settings":{"clients":[{"id":"landing-uuid","flow":"xtls-rprx-vision"}],"decryption":"none"},"streamSettings":{"network":"tcp","security":"reality","realitySettings":{"serverNames":["www.lovelive-anime.jp"],"publicKey":"LPUB","privateKey":"LPRIV","shortIds":["aa"]}}}]}`
	d.MustExec(`INSERT INTO plugin_hosts(plugin_id,server_id,config_json,status,updated_at)
		VALUES ('xray',1,?,'running',?)`, landingCfg, time.Now())
	d.MustExec(`INSERT INTO xray_host_topology(server_id,role,upstream_server_id,updated_at)
		VALUES (1,'landing',NULL,?)`, time.Now())

	// Legacy relay on server 2 pointing at server 1
	relayCfg := `{"inbounds":[{"port":8443,"protocol":"vless","settings":{"clients":[{"id":"relay-uuid","flow":"xtls-rprx-vision"}],"decryption":"none"},"streamSettings":{"network":"tcp","security":"reality","realitySettings":{"serverNames":["www.microsoft.com"],"publicKey":"RPUB","privateKey":"RPRIV","shortIds":["bb"]}}}]}`
	d.MustExec(`INSERT INTO plugin_hosts(plugin_id,server_id,config_json,status,updated_at)
		VALUES ('xray',2,?,'running',?)`, relayCfg, time.Now())
	d.MustExec(`INSERT INTO xray_host_topology(server_id,role,upstream_server_id,updated_at)
		VALUES (2,'relay',1,?)`, time.Now())

	return d, &InboundStore{DB: d, Now: time.Now}
}

func TestMigrate0003_PopulatesLandingAndRelay(t *testing.T) {
	d, s := setupLegacyDB(t)
	if err := Migrate0003(context.Background(), d); err != nil {
		t.Fatal(err)
	}

	rows, err := s.ListAllWithUpstream(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 inbounds, got %d", len(rows))
	}

	var landing, relay *InboundView
	for i := range rows {
		switch rows[i].Role {
		case "landing":
			landing = &rows[i]
		case "relay":
			relay = &rows[i]
		}
	}
	if landing == nil || landing.UUID != "landing-uuid" || landing.SNI != "www.lovelive-anime.jp" || landing.Port != 443 {
		t.Fatalf("landing wrong: %+v", landing)
	}
	if relay == nil || relay.UpstreamInboundID == nil || *relay.UpstreamInboundID != landing.ID {
		t.Fatalf("relay upstream link wrong: %+v", relay)
	}

	// plugin_hosts.config_json should be cleared to {}
	var cfg string
	_ = d.Get(&cfg, `SELECT config_json FROM plugin_hosts WHERE plugin_id='xray' AND server_id=1`)
	if cfg != "{}" {
		t.Fatalf("plugin_hosts.config_json not cleared: %q", cfg)
	}
}

func TestMigrate0003_Idempotent(t *testing.T) {
	d, s := setupLegacyDB(t)
	if err := Migrate0003(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	if err := Migrate0003(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	rows, _ := s.ListAllWithUpstream(context.Background())
	if len(rows) != 2 {
		t.Fatalf("re-run inserted duplicates: %d rows", len(rows))
	}
}
