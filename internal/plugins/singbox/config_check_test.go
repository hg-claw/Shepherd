package singbox

import (
	"database/sql"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestRenderedConfigPassesSingboxCheck runs the real sing-box binary
// against a rendered config. Set SINGBOX_BIN to a 1.14+ binary to
// exercise it; the test skips when unset so CI stays green without the
// binary. This is the only check that the config we generate is actually
// accepted — everything else asserts our own map shapes.
func TestRenderedConfigPassesSingboxCheck(t *testing.T) {
	bin := os.Getenv("SINGBOX_BIN")
	if bin == "" {
		t.Skip("SINGBOX_BIN not set; skipping real sing-box config check")
	}
	psk := "psk-abcdefghijklmnop"
	extraV5 := `{"obfs_mode":"http"}`
	extraV6 := `{"mode":"unshaped"}`
	upstreamID := int64(1)
	views := []InboundView{
		{Inbound: Inbound{ServerID: 1, Tag: "landing-snell5", Port: 8443, Role: "landing", Protocol: "snell-v5", Password: &psk, ExtraJSON: &extraV5}},
		{Inbound: Inbound{ServerID: 1, Tag: "landing-snell6", Port: 8444, Role: "landing", Protocol: "snell-v6", Password: &psk, ExtraJSON: &extraV6}},
		// A proxy-mode relay pointed at the obfs-enabled v5 landing. This
		// is the only thing that exercises renderRelayOutbound's snell
		// branch — in particular whether sing-box's snell *outbound*
		// accepts an "obfs_mode" key at all. sing-box rejects unknown
		// fields at parse time, so if it doesn't, this whole config
		// FATALs rather than just degrading the one relay.
		{
			Inbound: Inbound{
				ServerID: 1, Tag: "relay-snell5", Port: 8445, Role: "relay",
				Protocol: "snell-v5", Password: &psk, ExtraJSON: &extraV5,
				UpstreamInboundID: &upstreamID, RelayMode: "proxy",
			},
			UpstreamTag:       sql.NullString{String: "landing-snell5", Valid: true},
			UpstreamPort:      sql.NullInt64{Int64: 8443, Valid: true},
			UpstreamAddress:   sql.NullString{String: "203.0.113.10", Valid: true},
			UpstreamProtocol:  sql.NullString{String: "snell-v5", Valid: true},
			UpstreamPassword:  sql.NullString{String: psk, Valid: true},
			UpstreamExtraJSON: sql.NullString{String: extraV5, Valid: true},
		},
	}
	cfg, err := RenderServerConfig(views, nil)
	if err != nil {
		t.Fatalf("RenderServerConfig: %v", err)
	}
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, cfg, 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	out, err := exec.Command(bin, "check", "-c", path).CombinedOutput()
	if err != nil {
		t.Fatalf("sing-box check rejected the rendered config: %v\n%s\nconfig:\n%s", err, out, cfg)
	}
}
