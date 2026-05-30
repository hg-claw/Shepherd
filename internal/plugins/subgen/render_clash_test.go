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

func TestClash_CustomRulesetTextFormat(t *testing.T) {
	im := Intermediate{
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"n1"}}},
		Rules:  []Rule{{Ruleset: "AI", Target: "AI Services"}, {Final: true, Target: "PROXY"}},
	}
	out := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase)
	for _, want := range []string{
		"RULE-SET,AI,AI Services",
		"format: text",
		"https://raw.githubusercontent.com/iab0x00/ProxyRules/main/Rule/AI.txt",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("clash custom ruleset missing %q\n%s", want, out)
		}
	}
}

func TestClashDomainSetURL(t *testing.T) {
	cases := []struct{ in, want string }{
		{
			"https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/Advertising/Advertising_Domain.list",
			"https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Advertising/Advertising_Domain.yaml",
		},
		// already a Clash .yaml — unchanged
		{
			"https://example.com/rule/Clash/Foo/Foo_Domain.yaml",
			"https://example.com/rule/Clash/Foo/Foo_Domain.yaml",
		},
		// non-blackmatrix7 host: no /Shadowrocket/ segment → left as-is
		{"https://example.com/lists/ads.txt", "https://example.com/lists/ads.txt"},
	}
	for _, c := range cases {
		if got := clashDomainSetURL(c.in); got != c.want {
			t.Errorf("clashDomainSetURL(%q)=%q want %q", c.in, got, c.want)
		}
	}
}

func TestClash_DomainSetToRuleSet(t *testing.T) {
	url := "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/Advertising/Advertising_Domain.list"
	im := Intermediate{
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"n1"}}},
		Rules:  []Rule{{Match: "DOMAIN-SET," + url, Target: "Ad Block"}, {Final: true, Target: "PROXY"}},
	}
	out := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase)
	for _, want := range []string{
		"RULE-SET,Advertising_Domain,Ad Block",
		"behavior: domain",
		"https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Clash/Advertising/Advertising_Domain.yaml",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("clash DOMAIN-SET missing %q\n%s", want, out)
		}
	}
	// the bug: a verbatim DOMAIN-SET rule must NOT be emitted into the clash config
	if strings.Contains(out, "DOMAIN-SET,") {
		t.Errorf("clash should not emit a verbatim DOMAIN-SET rule\n%s", out)
	}
}

func TestClash_TUICInsecureSkipCertVerify(t *testing.T) {
	im := Intermediate{
		Nodes:  []Node{{Name: "t", Protocol: "tuic", Server: "1.1.1.1", Port: 443, Password: "p", UUID: "u", SNI: "s.com", Insecure: true}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"t"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}
	out := (&ClashRenderer{}).Render(im, "x", DefaultRulesetBase)
	if !strings.Contains(out, "skip-cert-verify: true") {
		t.Fatalf("tuic insecure: missing skip-cert-verify\n%s", out)
	}
}

func TestClash_FiltersDevice(t *testing.T) {
	im := Intermediate{
		Groups: []Group{{Name: "Home", Type: "select", Members: []string{"DEVICE:HomeMac", "DIRECT"}, Verbatim: true}},
		Rules:  []Rule{{Match: "IP-CIDR,192.168.1.0/24", Target: "DEVICE:HomeMac"}, {Final: true, Target: "PROXY"}},
	}
	out := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase)
	if strings.Contains(out, "DEVICE:") {
		t.Fatalf("clash must drop DEVICE refs:\n%s", out)
	}
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("invalid yaml: %v\n%s", err, out)
	}
	if !strings.Contains(out, "name: Home") {
		t.Fatalf("Home group missing:\n%s", out)
	}
}
