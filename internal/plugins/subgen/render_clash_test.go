package subgen

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestClash_FillsTemplate(t *testing.T) {
	im := Intermediate{
		Nodes:  []Node{{Name: "🟢 A", Protocol: "trojan", Server: "1.1.1.1", Port: 443, Password: "p", SNI: "s.com"}},
		Groups: []Group{{Name: "MyGroup", Type: "select", Members: []string{"DIRECT"}, Verbatim: true}},
		Rules:  []Rule{{Match: "DOMAIN-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/Advertising/Advertising_Domain.list", Target: "AdBlock"}},
	}
	out := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase)
	if strings.Contains(out, "{{") {
		t.Fatalf("unresolved marker:\n%s", out)
	}
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("not valid YAML: %v\n%s", err, out)
	}
	if !strings.Contains(out, "🟢 A") {
		t.Errorf("node missing\n%s", out)
	}
	if !strings.Contains(out, "behavior: domain") || !strings.Contains(out, "RULE-SET,Advertising_Domain,AdBlock") {
		t.Errorf("DOMAIN-SET not converted\n%s", out)
	}
	if !strings.Contains(out, "MyGroup") {
		t.Errorf("custom group missing\n%s", out)
	}
	if !strings.Contains(out, "fastly.jsdelivr.net/gh/dler-io") {
		t.Errorf("dler.io providers missing\n%s", out)
	}
}

// TestClash_CustomGroupNodesPlaceholder: a {{NODES}} member in a custom group
// expands to every selected node name (quoted), not the literal token.
func TestClash_CustomGroupNodesPlaceholder(t *testing.T) {
	im := Intermediate{
		Nodes: []Node{
			{Name: "🟢 A", Protocol: "trojan", Server: "1.1.1.1", Port: 443, Password: "p", SNI: "s.com"},
			{Name: "🔵 B", Protocol: "trojan", Server: "2.2.2.2", Port: 443, Password: "p", SNI: "s.com"},
		},
		Groups: []Group{{Name: "All", Type: "select", Members: []string{"{{NODES}}", "DIRECT"}, Verbatim: true}},
	}
	out := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase)
	if strings.Contains(out, "{{NODES}}") {
		t.Fatalf("placeholder not expanded in custom group:\n%s", out)
	}
	if err := yaml.Unmarshal([]byte(out), &map[string]any{}); err != nil {
		t.Fatalf("not valid YAML: %v\n%s", err, out)
	}
	// The custom group line must contain both node names + DIRECT, quoted.
	if !strings.Contains(out, "name: 'All'") ||
		!strings.Contains(out, "proxies: ['🟢 A', '🔵 B', 'DIRECT']") {
		t.Errorf("custom group did not expand {{NODES}} to both nodes:\n%s", out)
	}
}

// TestClash_DeterministicProviders guards against map-iteration churn: multiple
// DOMAIN-SET custom rules must render the rule-providers block in a stable
// (first-seen) order so a regenerated subscription doesn't diff for no reason.
func TestClash_DeterministicProviders(t *testing.T) {
	base := "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/X/"
	im := Intermediate{
		Rules: []Rule{
			{Match: "DOMAIN-SET," + base + "Alpha_Domain.list", Target: "Proxy"},
			{Match: "DOMAIN-SET," + base + "Bravo_Domain.list", Target: "Proxy"},
			{Match: "DOMAIN-SET," + base + "Charlie_Domain.list", Target: "Proxy"},
		},
	}
	first := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase)
	for i := 0; i < 20; i++ {
		if got := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase); got != first {
			t.Fatalf("non-deterministic clash output on iter %d", i)
		}
	}
	// providers emitted in rule order
	a := strings.Index(first, "Alpha_Domain:")
	b := strings.Index(first, "Bravo_Domain:")
	c := strings.Index(first, "Charlie_Domain:")
	if a < 0 || a >= b || b >= c {
		t.Fatalf("providers not in first-seen order (a=%d b=%d c=%d)", a, b, c)
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
		Rules:  []Rule{{Match: "IP-CIDR,192.168.1.0/24", Target: "DEVICE:HomeMac"}},
	}
	out := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase)
	if strings.Contains(out, "DEVICE:") {
		t.Fatalf("clash must drop DEVICE refs:\n%s", out)
	}
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("invalid yaml: %v\n%s", err, out)
	}
	if !strings.Contains(out, "Home") {
		t.Fatalf("Home group missing:\n%s", out)
	}
}

func TestClash_DisabledGroupsDropped(t *testing.T) {
	im := Intermediate{DisabledGroups: []string{"Asian TV"}}
	out := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase)
	if strings.Contains(out, "name: 'Asian TV'") {
		t.Errorf("disabled proxy-group still present\n%s", out)
	}
	if strings.Contains(out, ",Asian TV'") {
		t.Errorf("rule targeting disabled group still present\n%s", out)
	}
	// Providers that were unique to Asian TV become orphaned and must be removed.
	if strings.Contains(out, "Abema TV") || strings.Contains(out, "Bahamut") {
		t.Errorf("orphaned rule-provider still present\n%s", out)
	}
	// Core groups + core-referenced providers survive.
	if !strings.Contains(out, "name: Proxy") || !strings.Contains(out, "Domestic:") {
		t.Errorf("core group/provider wrongly dropped\n%s", out)
	}
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("not valid YAML after filtering: %v\n%s", err, out)
	}
}

func TestClash_NoDisabledIsParity(t *testing.T) {
	full := (&ClashRenderer{}).Render(Intermediate{}, "", DefaultRulesetBase)
	got := (&ClashRenderer{}).Render(Intermediate{DisabledGroups: []string{}}, "", DefaultRulesetBase)
	if got != full {
		t.Fatalf("empty disabled set changed Clash output")
	}
}
