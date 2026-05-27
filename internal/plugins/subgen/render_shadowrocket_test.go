package subgen

import (
	"strings"
	"testing"
)

func TestShadowRocket_WireGuard(t *testing.T) {
	im := Intermediate{
		Nodes: []Node{{
			Name: "🇨🇳 WG", Protocol: "wireguard", Server: "home.hg.ht", Port: 51820,
			Extra: map[string]any{"private_key": "PRIV", "public_key": "PUB", "preshared_key": "PSK", "ip": "10.254.253.3", "reserved": "0,0,0", "udp": true},
		}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"🇨🇳 WG"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}
	out := (&ShadowRocketRenderer{}).Render(im, "https://x?target=shadowrocket", DefaultRulesetBase)
	want := "🇨🇳 WG = wireguard, home.hg.ht, 51820, privateKey=PRIV, publicKey=PUB, ip=10.254.253.3, udp=1, presharedKey=PSK, reserved=0/0/0"
	if !strings.Contains(out, want) {
		t.Fatalf("shadowrocket missing inline WG line:\n%s", out)
	}
	if strings.Contains(out, "[WireGuard") {
		t.Fatalf("shadowrocket must NOT emit a [WireGuard] section:\n%s", out)
	}
}

func TestShadowRocket_RendersAndReportsTarget(t *testing.T) {
	r := &ShadowRocketRenderer{}
	if r.Target() != "shadowrocket" {
		t.Fatalf("target=%s", r.Target())
	}
	im := Intermediate{
		Nodes:  []Node{{Name: "tu1", Protocol: "tuic", Server: "1.1.1.1", Port: 443, Password: "p", UUID: "u", SNI: "s"}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"tu1"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}
	out := r.Render(im, "https://x/sub/t?target=shadowrocket", DefaultRulesetBase)
	for _, want := range []string{
		"[Proxy]", "tu1 = tuic, 1.1.1.1, 443, password=p, uuid=u, sni=s",
		"[Proxy Group]", "PROXY = select, tu1, DIRECT", "[Rule]", "FINAL,PROXY",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q\n%s", want, out)
		}
	}
}

func TestShadowRocket_FiltersDevice(t *testing.T) {
	im := Intermediate{
		Groups: []Group{{Name: "Home", Type: "select", Members: []string{"DEVICE:HomeMac", "DIRECT"}, Verbatim: true}},
		Rules:  []Rule{{Match: "IP-CIDR,192.168.1.0/24", Target: "DEVICE:HomeMac"}, {Final: true, Target: "PROXY"}},
	}
	out := (&ShadowRocketRenderer{}).Render(im, "x", DefaultRulesetBase)
	if !strings.Contains(out, "Home = select, DIRECT\n") {
		t.Fatalf("shadowrocket should filter DEVICE member:\n%s", out)
	}
	if strings.Contains(out, "DEVICE:") {
		t.Fatalf("shadowrocket must drop all DEVICE refs:\n%s", out)
	}
}
