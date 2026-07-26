package singbox

import (
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
	views := []InboundView{
		{Inbound: Inbound{ServerID: 1, Tag: "landing-snell5", Port: 8443, Role: "landing", Protocol: "snell-v5", Password: &psk, ExtraJSON: &extraV5}},
		{Inbound: Inbound{ServerID: 1, Tag: "landing-snell6", Port: 8444, Role: "landing", Protocol: "snell-v6", Password: &psk, ExtraJSON: &extraV6}},
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
