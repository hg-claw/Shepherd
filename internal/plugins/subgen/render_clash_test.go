package subgen

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestClash_RendersYAML(t *testing.T) {
	im := Intermediate{
		Nodes: []Node{
			{Name: "🇺🇸 us trojan", Protocol: "trojan", Server: "1.1.1.1", Port: 443, Password: "p", SNI: "x.com"},
			{Name: "🇭🇰 hk ss", Protocol: "shadowsocks", Server: "2.2.2.2", Port: 8388, SSMethod: "aes-128-gcm", Password: "pw"},
		},
		Groups: []Group{
			{Name: "PROXY", Type: "select", Members: []string{"Auto Select", "🇺🇸 us trojan", "🇭🇰 hk ss"}},
			{Name: "Auto Select", Type: "url-test", Members: []string{"🇺🇸 us trojan", "🇭🇰 hk ss"}},
			{Name: "Telegram", Type: "select", Members: []string{"PROXY", "DIRECT", "REJECT", "🇺🇸 us trojan"}},
		},
		Rules: []Rule{
			{Match: "IP-CIDR,10.0.0.0/24", Target: "PROXY"},
			{Ruleset: "Telegram", Target: "Telegram"},
			{Native: "GEOIP,CN", Target: "Location:CN"},
			{Native: "RULE-SET,SYSTEM", Target: "Private"},
			{Final: true, Target: "PROXY"},
		},
		ClashGeneral: "dns:\n  enable: true",
	}
	out := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase)

	var doc map[string]any
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("invalid yaml: %v\n%s", err, out)
	}
	if _, ok := doc["dns"]; !ok {
		t.Fatalf("clash_general not injected:\n%s", out)
	}
	if doc["proxies"] == nil || doc["proxy-groups"] == nil || doc["rule-providers"] == nil {
		t.Fatalf("missing sections:\n%s", out)
	}
	for _, want := range []string{
		"RULE-SET,Telegram,Telegram",
		"GEOIP,CN,Location:CN",
		"GEOIP,PRIVATE,Private",
		"IP-CIDR,10.0.0.0/24,PROXY",
		"MATCH,PROXY",
		"behavior: classical",
		"/rule/Clash/Telegram/Telegram.yaml",
		"type: trojan",
		"type: ss",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("clash output missing %q\n---\n%s", want, out)
		}
	}
	if strings.Contains(out, "FINAL,") {
		t.Fatalf("should use MATCH not FINAL:\n%s", out)
	}

	// emoji proxy names round-trip through YAML decoding (yaml.v3 escapes
	// non-BMP runes in the raw bytes, but decoding restores them).
	proxies, _ := doc["proxies"].([]any)
	foundEmoji := false
	for _, p := range proxies {
		if pm, ok := p.(map[string]any); ok && pm["name"] == "🇺🇸 us trojan" {
			foundEmoji = true
		}
	}
	if !foundEmoji {
		t.Fatalf("emoji proxy name did not round-trip:\n%s", out)
	}

	im2 := im
	im2.ClashGeneral = ""
	out2 := (&ClashRenderer{}).Render(im2, "", DefaultRulesetBase)
	if !strings.Contains(out2, "mode: rule") {
		t.Fatalf("default mode missing:\n%s", out2)
	}
}

func TestClash_WireGuard(t *testing.T) {
	im := Intermediate{
		Nodes: []Node{{
			Name: "🇨🇳 WG", Protocol: "wireguard", Server: "home.hg.ht", Port: 51820,
			Extra: map[string]any{
				"private_key": "PRIV", "public_key": "PUB", "preshared_key": "PSK",
				"ip": "10.254.253.3", "reserved": "0,0,0", "udp": true,
			},
		}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"🇨🇳 WG"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}
	out := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase)
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("invalid yaml: %v\n%s", err, out)
	}
	for _, want := range []string{
		"type: wireguard", "private-key: PRIV", "public-key: PUB",
		"pre-shared-key: PSK", "ip: 10.254.253.3/32", "udp: true", "reserved:",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("clash WG missing %q\n%s", want, out)
		}
	}
}

func TestClash_DoesNotCorruptBackslashValues(t *testing.T) {
	im := Intermediate{
		Nodes:  []Node{{Name: "n1", Protocol: "trojan", Server: "1.1.1.1", Port: 443, Password: `secretAx`, SNI: "x.com"}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"n1"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}
	out := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase)
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("invalid yaml: %v\n%s", err, out)
	}
	proxies, _ := doc["proxies"].([]any)
	if len(proxies) != 1 {
		t.Fatalf("want 1 proxy, got %d\n%s", len(proxies), out)
	}
	pm := proxies[0].(map[string]any)
	if pm["password"] != `secretAx` {
		t.Fatalf("password corrupted: got %q want %q", pm["password"], `secretAx`)
	}
}
