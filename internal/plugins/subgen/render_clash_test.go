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

func TestClash_MieruHandshakeMode(t *testing.T) {
	im := Intermediate{
		Nodes: []Node{{
			Name: "m", Protocol: "mieru", Server: "1.2.3.4", Port: 8964, Password: "p",
			Extra: map[string]any{"username": "alice", "transport": "TCP", "multiplexing": "MULTIPLEXING_OFF", "handshake_mode": "HANDSHAKE_NO_WAIT"},
		}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"m"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}
	out := (&ClashRenderer{}).Render(im, "x", DefaultRulesetBase)
	for _, want := range []string{"type: mieru", "username: alice", "handshake-mode: HANDSHAKE_NO_WAIT", "multiplexing: MULTIPLEXING_OFF"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q\n%s", want, out)
		}
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

func TestClash_SnellV5DowngradesToV4(t *testing.T) {
	n := Node{
		Name: "hk1", Protocol: "snell", Server: "1.2.3.4", Port: 8443,
		Password: "psk-abc",
		Extra:    map[string]any{"snell_version": 5, "obfs_mode": "http", "obfs_host": "bing.com"},
	}
	p := clashProxy(n)
	if p == nil {
		t.Fatal("clashProxy returned nil for snell v5")
	}
	if p["type"] != "snell" {
		t.Errorf("type = %v, want snell", p["type"])
	}
	if p["psk"] != "psk-abc" {
		t.Errorf("psk = %v, want psk-abc", p["psk"])
	}
	// mihomo silently rewrites 5 to 4; writing 4 ourselves keeps the
	// emitted config honest. Omitting version entirely would default to
	// v1 in mihomo and fail to connect.
	if p["version"] != 4 {
		t.Errorf("version = %v, want 4", p["version"])
	}
	obfs, ok := p["obfs-opts"].(map[string]any)
	if !ok {
		t.Fatalf("obfs-opts missing or wrong type: %#v", p["obfs-opts"])
	}
	if obfs["mode"] != "http" || obfs["host"] != "bing.com" {
		t.Errorf("obfs-opts = %#v, want mode=http host=bing.com", obfs)
	}
}

func TestClash_SnellV6Skipped(t *testing.T) {
	n := Node{
		Name: "hk1", Protocol: "snell", Server: "1.2.3.4", Port: 8443,
		Password: "psk-abc",
		Extra:    map[string]any{"snell_version": 6},
	}
	// mihomo hard-errors on version 6 ("snell version error: 6"), so the
	// node must be omitted rather than downgraded.
	if p := clashProxy(n); p != nil {
		t.Errorf("clashProxy must return nil for snell v6, got %#v", p)
	}
}

// TestClash_SkippedSnellNodeLeavesNoTrace guards the Render loop itself: a
// node whose clashProxy comes back nil must vanish completely — absent from
// the proxies list AND absent from every proxy-group's member list (both the
// {{NODES}}-expanded custom group and the fixed template's own groups, which
// also expand through {{NODES}}). The strongest check for "no trace" is that
// including the doomed node changes nothing at all versus never having sent
// it.
func TestClash_SkippedSnellNodeLeavesNoTrace(t *testing.T) {
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

	outWith := (&ClashRenderer{}).Render(withV6, "", DefaultRulesetBase)
	outWithout := (&ClashRenderer{}).Render(withoutV6, "", DefaultRulesetBase)
	if outWith != outWithout {
		t.Fatalf("a fully-skipped snell v6 node must leave rendering byte-identical to it never existing.\nwith v6:\n%s\n\nwithout v6:\n%s", outWith, outWithout)
	}
	if strings.Contains(outWith, "hk-v6") {
		t.Fatalf("skipped node name leaked into output:\n%s", outWith)
	}
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(outWith), &doc); err != nil {
		t.Fatalf("invalid yaml: %v\n%s", err, outWith)
	}
	groups, _ := doc["proxy-groups"].([]any)
	for _, g := range groups {
		gm := g.(map[string]any)
		members, _ := gm["proxies"].([]any)
		for _, m := range members {
			if m == "hk-v6" {
				t.Fatalf("skipped node leaked into proxy-group %v member list:\n%s", gm["name"], outWith)
			}
		}
	}
}
