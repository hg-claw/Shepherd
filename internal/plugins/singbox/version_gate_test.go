package singbox

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"
)

func TestSingboxMinorAtLeast(t *testing.T) {
	cases := []struct {
		version string
		want    bool
	}{
		{"1.14.0", true},
		{"v1.14.0", true},
		{"1.14.0-beta.2", true},
		{"v1.14.0-beta.2", true},
		{"1.15.3", true},
		{"2.0.0", true},
		{"1.13.14", false},
		{"1.13.12", false},
		{"1.9.0", false},
		{"", false},
		{"garbage", false},
	}
	for _, c := range cases {
		if got := singboxMinorAtLeast(c.version, 1, 14); got != c.want {
			t.Errorf("singboxMinorAtLeast(%q, 1, 14) = %v, want %v", c.version, got, c.want)
		}
	}
}

func TestRequiresSingbox114(t *testing.T) {
	if !requiresSingbox114("snell-v5") || !requiresSingbox114("snell-v6") {
		t.Error("snell protocols must require 1.14")
	}
	if requiresSingbox114("hysteria2") || requiresSingbox114("vless-reality") {
		t.Error("non-snell protocols must not require 1.14")
	}
}

// seedSnellHost inserts a plugin_hosts row for plugin_id="singbox" on server 1
// with the given deployed_version. plugin_hosts.plugin_id FK → plugins.id
// requires a plugins row first (same pattern as version_routes_test.go).
func seedSnellHost(t *testing.T, d *sqlx.DB, version string) {
	t.Helper()
	d.MustExec(`INSERT OR IGNORE INTO plugins(id, enabled, config_json, created_at)
		VALUES ('singbox', 1, '{}', ?)`, time.Now())
	d.MustExec(`INSERT INTO plugin_hosts(plugin_id, server_id, config_json, deployed_version, status, updated_at)
		VALUES ('singbox', 1, '{}', ?, 'running', ?)`, version, time.Now())
}

// TestCheckSnellVersionGate_NoSnellInbounds_NoOp: views with only non-snell
// protocols must return nil without touching plugin_hosts — no row exists
// for server 1 here, so any DB lookup would fail the gate closed.
func TestCheckSnellVersionGate_NoSnellInbounds_NoOp(t *testing.T) {
	d := newDeployTestDB(t)
	views := []InboundView{
		{Inbound: Inbound{Tag: "landing-1", Protocol: "vless-reality"}},
		{Inbound: Inbound{Tag: "landing-2", Protocol: "trojan-tls"}},
	}
	if err := checkSnellVersionGate(context.Background(), d, 1, views); err != nil {
		t.Fatalf("expected nil for non-snell views, got %v", err)
	}
}

// TestCheckSnellVersionGate_SnellOnSupportedHost_Allowed: a plugin_hosts row
// on sing-box 1.14+ (with a beta pre-release suffix) must pass the gate.
func TestCheckSnellVersionGate_SnellOnSupportedHost_Allowed(t *testing.T) {
	d := newDeployTestDB(t)
	seedSnellHost(t, d, "v1.14.0-beta.2")
	views := []InboundView{
		{Inbound: Inbound{Tag: "snell-1", Protocol: "snell-v5"}},
	}
	if err := checkSnellVersionGate(context.Background(), d, 1, views); err != nil {
		t.Fatalf("expected nil on sing-box 1.14, got %v", err)
	}
}

// TestCheckSnellVersionGate_SnellOnOldHost_Blocked: a plugin_hosts row below
// 1.14 must block, naming the offending tag(s) and the 1.14 requirement.
func TestCheckSnellVersionGate_SnellOnOldHost_Blocked(t *testing.T) {
	d := newDeployTestDB(t)
	seedSnellHost(t, d, "1.13.14")
	views := []InboundView{
		{Inbound: Inbound{Tag: "snell-1", Protocol: "snell-v5"}},
	}
	err := checkSnellVersionGate(context.Background(), d, 1, views)
	if err == nil {
		t.Fatal("expected error on sing-box 1.13, got nil")
	}
	if !strings.Contains(err.Error(), "snell-1") {
		t.Errorf("error must name the offending inbound tag, got: %v", err)
	}
	if !strings.Contains(err.Error(), "1.14") {
		t.Errorf("error must mention the 1.14 requirement, got: %v", err)
	}
}

// TestCheckSnellVersionGate_MissingHostRow_FailClosed: no plugin_hosts row
// (GetHost returns sql.ErrNoRows) must block the deploy rather than let it
// proceed with an unknown version.
func TestCheckSnellVersionGate_MissingHostRow_FailClosed(t *testing.T) {
	d := newDeployTestDB(t)
	views := []InboundView{
		{Inbound: Inbound{Tag: "snell-1", Protocol: "snell-v6"}},
	}
	err := checkSnellVersionGate(context.Background(), d, 1, views)
	if err == nil {
		t.Fatal("expected error when plugin_hosts row is missing, got nil")
	}
	if !strings.Contains(err.Error(), "snell-1") {
		t.Errorf("error must name the offending inbound tag, got: %v", err)
	}
}
