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

func TestInboundNeeds114(t *testing.T) {
	cases := []struct {
		name                      string
		protocol, role, relayMode string
		want                      bool
	}{
		{"snell landing", "snell-v5", "landing", "proxy", true},
		{"snell proxy relay terminates snell", "snell-v6", "relay", "proxy", true},
		{"snell relay with empty mode defaults to proxy", "snell-v5", "relay", "", true},
		// The carve-out: renders as type:"direct", nothing snell-aware runs.
		{"snell forward relay", "snell-v5", "relay", "forward", false},
		{"snell v6 forward relay", "snell-v6", "relay", "forward", false},
		{"non-snell landing", "hysteria2", "landing", "proxy", false},
		{"non-snell forward relay", "vless-reality", "relay", "forward", false},
	}
	for _, c := range cases {
		if got := inboundNeeds114(c.protocol, c.role, c.relayMode); got != c.want {
			t.Errorf("%s: inboundNeeds114(%q,%q,%q) = %v, want %v",
				c.name, c.protocol, c.role, c.relayMode, got, c.want)
		}
	}
}

// TestDescribeDeployedVersion: the gate's message is the one every 1.13
// operator reads, so an empty/garbage deployed_version must not render as
// the nonsense `has ""`.
func TestDescribeDeployedVersion(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", "has no recorded version"},
		{"   ", "has no recorded version"},
		{"garbage", `has an unrecognised version "garbage"`},
		{"1", `has an unrecognised version "1"`},
		{"1.13.14", `has "1.13.14"`},
		{"v1.13.14", `has "v1.13.14"`},
	}
	for _, c := range cases {
		if got := describeDeployedVersion(c.in); got != c.want {
			t.Errorf("describeDeployedVersion(%q) = %q, want %q", c.in, got, c.want)
		}
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

// TestCheckSnellVersionGate_ForwardRelayOnOldHost_Allowed: a forward-mode
// relay carries protocol="snell-v5" to describe its landing, but renders
// as {"type":"direct"} — nothing snell-aware runs on the relay host, so a
// 1.13 host must still deploy. Without the carve-out the default
// bulk-relay flow would demand a 1.14 upgrade on every relay.
func TestCheckSnellVersionGate_ForwardRelayOnOldHost_Allowed(t *testing.T) {
	d := newDeployTestDB(t)
	seedSnellHost(t, d, "1.13.14")
	views := []InboundView{
		{Inbound: Inbound{Tag: "relay-fwd", Protocol: "snell-v5", Role: "relay", RelayMode: "forward"}},
	}
	if err := checkSnellVersionGate(context.Background(), d, 1, views); err != nil {
		t.Fatalf("forward relay must not need 1.14, got %v", err)
	}
}

// TestCheckSnellVersionGate_ProxyRelayOnOldHost_Blocked: the sibling case
// — a proxy-mode relay really does terminate snell on the relay host
// (renderInbound emits type:"snell"), so 1.13 must still be refused.
func TestCheckSnellVersionGate_ProxyRelayOnOldHost_Blocked(t *testing.T) {
	d := newDeployTestDB(t)
	seedSnellHost(t, d, "1.13.14")
	views := []InboundView{
		{Inbound: Inbound{Tag: "relay-proxy", Protocol: "snell-v5", Role: "relay", RelayMode: "proxy"}},
	}
	if err := checkSnellVersionGate(context.Background(), d, 1, views); err == nil {
		t.Fatal("proxy relay terminates snell — expected a 1.14 error, got nil")
	}
}

// TestCheckSnellVersionGate_EmptyVersion_ReadableMessage: the common 1.13
// case has a NULL deployed_version; the message must not read `has ""`.
func TestCheckSnellVersionGate_EmptyVersion_ReadableMessage(t *testing.T) {
	d := newDeployTestDB(t)
	seedSnellHost(t, d, "")
	views := []InboundView{
		{Inbound: Inbound{Tag: "snell-1", Protocol: "snell-v5", Role: "landing"}},
	}
	err := checkSnellVersionGate(context.Background(), d, 1, views)
	if err == nil {
		t.Fatal("expected error for an empty deployed_version, got nil")
	}
	if !strings.Contains(err.Error(), "has no recorded version") {
		t.Errorf("want the empty-version wording, got: %v", err)
	}
	if strings.Contains(err.Error(), `has ""`) {
		t.Errorf(`message still renders the bare has "": %v`, err)
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
