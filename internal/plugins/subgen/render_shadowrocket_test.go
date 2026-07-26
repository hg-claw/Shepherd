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

func TestShadowrocket_SnellV5DowngradesToV4(t *testing.T) {
	n := Node{
		Name: "hk1", Protocol: "snell", Server: "1.2.3.4", Port: 8443,
		Password: "psk-abc",
		Extra:    map[string]any{"snell_version": 5},
	}
	line := (&ShadowRocketRenderer{}).proxyLine(n, "shadowrocket")
	if !strings.Contains(line, "version=4") {
		t.Errorf("shadowrocket must dial a v5 landing as v4, got %q", line)
	}
}

func TestShadowrocket_SnellV5WithObfsDowngradesToV4WithObfs(t *testing.T) {
	n := Node{
		Name: "hk1", Protocol: "snell", Server: "1.2.3.4", Port: 8443,
		Password: "psk-abc",
		Extra:    map[string]any{"snell_version": 5, "obfs_mode": "http", "obfs_host": "bing.com"},
	}
	line := (&ShadowRocketRenderer{}).proxyLine(n, "shadowrocket")
	for _, want := range []string{"version=4", "obfs=http", "obfs-host=bing.com"} {
		if !strings.Contains(line, want) {
			t.Errorf("shadowrocket v5 obfs downgrade missing %q, got %q", want, line)
		}
	}
}

func TestShadowrocket_SnellV6Skipped(t *testing.T) {
	n := Node{
		Name: "hk1", Protocol: "snell", Server: "1.2.3.4", Port: 8443,
		Password: "psk-abc",
		Extra:    map[string]any{"snell_version": 6},
	}
	if line := (&ShadowRocketRenderer{}).proxyLine(n, "shadowrocket"); line != "" {
		t.Errorf("shadowrocket must skip snell v6 (client rejects it), got %q", line)
	}
}

// TestShadowrocket_SkippedSnellNodeLeavesNoTrace guards the render loop itself:
// a node whose proxyLine comes back empty must vanish completely — no blank
// [Proxy] line, no dangling name in any group's member list. The strongest
// check for "no trace" is that including the doomed node changes nothing at
// all versus never having sent it.
func TestShadowrocket_SkippedSnellNodeLeavesNoTrace(t *testing.T) {
	withV6 := Intermediate{
		Nodes: []Node{
			{Name: "hk-v5", Protocol: "snell", Server: "5.6.7.8", Port: 8443, Password: "psk-def", Extra: map[string]any{"snell_version": 5}},
			{Name: "hk-v6", Protocol: "snell", Server: "1.2.3.4", Port: 8443, Password: "psk-abc", Extra: map[string]any{"snell_version": 6}},
		},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"{{NODES}}"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}
	withoutV6 := withV6
	withoutV6.Nodes = []Node{withV6.Nodes[0]}

	outWith := (&ShadowRocketRenderer{}).Render(withV6, "https://x", DefaultRulesetBase)
	outWithout := (&ShadowRocketRenderer{}).Render(withoutV6, "https://x", DefaultRulesetBase)
	if outWith != outWithout {
		t.Fatalf("a fully-skipped snell v6 node must leave rendering byte-identical to it never existing.\nwith v6:\n%s\n\nwithout v6:\n%s", outWith, outWithout)
	}
	if strings.Contains(outWith, "hk-v6") {
		t.Fatalf("skipped node name leaked into output:\n%s", outWith)
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
