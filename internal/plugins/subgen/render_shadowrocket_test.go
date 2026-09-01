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

func TestShadowrocket_MieruLine(t *testing.T) {
	im := Intermediate{
		Nodes: []Node{{
			Name: "hk-mieru", Protocol: "mieru", Server: "1.2.3.4", Port: 8964,
			Password: "secret",
			Extra: map[string]any{
				"username": "alice", "transport": "TCP",
				"multiplexing": "MULTIPLEXING_OFF", "handshake_mode": "HANDSHAKE_NO_WAIT",
				"mtu": 1400,
			},
		}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"hk-mieru"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}
	out := (&ShadowRocketRenderer{}).Render(im, "https://x?target=shadowrocket", DefaultRulesetBase)
	want := "hk-mieru = mieru, 1.2.3.4, 8964, alice, password=secret, transport=TCP, multiplexing=MULTIPLEXING_OFF, handshake-mode=HANDSHAKE_NO_WAIT, mtu=1400, udp=true"
	if !strings.Contains(out, want) {
		t.Fatalf("shadowrocket missing mieru line:\n%s", out)
	}
	if strings.Contains(out, "username=") || strings.Contains(out, "user=") {
		t.Fatalf("shadowrocket mieru username is positional, not user=/username=:\n%s", out)
	}
	if !strings.Contains(out, "PROXY = select, hk-mieru, DIRECT") {
		t.Fatalf("mieru node missing from PROXY group:\n%s", out)
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

// TestShadowrocket_UsesEncryptedDNS guards the anti-pollution contract:
// Shadowrocket ignores Surge's `doh-server` and will use whatever is in
// `dns-server`. Putting `system` (ISP DNS) first means GFW-injected A
// records win, then GEOIP,CN sends the connection DIRECT — the site looks
// blocked. dns-server must be DoH URLs with no system resolver; hijack-dns
// must also catch the 114 DNS that CN apps hardcode.
func TestShadowrocket_UsesEncryptedDNS(t *testing.T) {
	out := (&ShadowRocketRenderer{}).Render(Intermediate{}, "https://x?target=shadowrocket", DefaultRulesetBase)
	var dnsLine, hijackLine string
	for _, line := range strings.Split(out, "\n") {
		trim := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trim, "dns-server"):
			dnsLine = trim
		case strings.HasPrefix(trim, "hijack-dns"):
			hijackLine = trim
		}
	}
	if dnsLine == "" {
		t.Fatal("missing dns-server")
	}
	if strings.Contains(dnsLine, "system") {
		t.Fatalf("dns-server must not use system/ISP DNS (pollutable): %s", dnsLine)
	}
	if !strings.Contains(dnsLine, "https://") {
		t.Fatalf("dns-server must use DoH; Shadowrocket ignores Surge doh-server: %s", dnsLine)
	}
	if !strings.Contains(hijackLine, "114.114.114.114") {
		t.Fatalf("hijack-dns must catch CN-app hardcoded 114 DNS: %s", hijackLine)
	}
}
