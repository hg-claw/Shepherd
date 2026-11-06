package subgen

import (
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/hg-claw/Shepherd/internal/plugins/subgen/templates"
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

// decodeRenderedClash checks the emitted bytes independently of the merge helper:
// decoding to a map rejects duplicate keys, and a second Decode must reach EOF.
func decodeRenderedClash(t *testing.T, out string) map[string]any {
	t.Helper()
	dec := yaml.NewDecoder(strings.NewReader(out))
	var doc map[string]any
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("invalid final Clash YAML: %v\n%s", err, out)
	}
	if len(doc) == 0 {
		t.Fatalf("empty final Clash document:\n%s", out)
	}
	var next any
	if err := dec.Decode(&next); err != io.EOF {
		t.Fatalf("expected one final YAML document, got next=%#v err=%v", next, err)
	}
	return doc
}

func TestClash_GeneralOverridesMode(t *testing.T) {
	out := (&ClashRenderer{}).Render(Intermediate{ClashGeneral: "mode: global"}, "", "")
	doc := decodeRenderedClash(t, out)
	if doc["mode"] != "global" {
		t.Fatalf("mode = %v, want global", doc["mode"])
	}
	if n := strings.Count("\n"+out, "\nmode:"); n != 1 {
		t.Fatalf("want one top-level mode key, got %d", n)
	}
}

func TestClash_GeneralDeepMergesDNS(t *testing.T) {
	r := &ClashRenderer{}
	base := decodeRenderedClash(t, r.Render(Intermediate{}, "", ""))
	im := Intermediate{ClashGeneral: "dns:\n  listen: 127.0.0.1:5353\n  nameserver-policy:\n    example.test: https://resolver.example/dns-query\n"}
	out := r.Render(im, "", "")
	doc := decodeRenderedClash(t, out)
	dns := doc["dns"].(map[string]any)
	baseDNS := base["dns"].(map[string]any)
	if dns["listen"] != "127.0.0.1:5353" {
		t.Fatalf("listen override lost: %#v", dns)
	}
	// Future privacy defaults must survive an override of unrelated DNS keys.
	for key, want := range baseDNS {
		if key != "listen" && key != "nameserver-policy" && !reflect.DeepEqual(dns[key], want) {
			t.Errorf("base DNS key %q lost: got %#v, want %#v", key, dns[key], want)
		}
	}
	policy := dns["nameserver-policy"].(map[string]any)
	if policy["example.test"] != "https://resolver.example/dns-query" {
		t.Fatalf("new nested DNS policy lost: %#v", policy)
	}
	if basePolicy, ok := baseDNS["nameserver-policy"].(map[string]any); ok {
		for key, want := range basePolicy {
			if !reflect.DeepEqual(policy[key], want) {
				t.Errorf("base DNS policy %q lost: got %#v, want %#v", key, policy[key], want)
			}
		}
	}
	if n := strings.Count("\n"+out, "\ndns:"); n != 1 {
		t.Fatalf("want one top-level dns key, got %d", n)
	}
}

func TestClash_GeneralReplacesArraysAndPreservesUnknownKeys(t *testing.T) {
	im := Intermediate{ClashGeneral: `dns:
  default-nameserver: [9.9.9.9]
  nameserver: [https://resolver.example/dns-query]
rules: ['MATCH,REJECT']
x-future-feature:
  enabled: true
  values: [one, two]
`}
	out := (&ClashRenderer{}).Render(im, "", "")
	doc := decodeRenderedClash(t, out)
	dns := doc["dns"].(map[string]any)
	if want := []any{"9.9.9.9"}; !reflect.DeepEqual(dns["default-nameserver"], want) {
		t.Errorf("array appended rather than replaced: %#v", dns["default-nameserver"])
	}
	if want := []any{"https://resolver.example/dns-query"}; !reflect.DeepEqual(dns["nameserver"], want) {
		t.Errorf("nameserver = %#v, want %#v", dns["nameserver"], want)
	}
	if want := []any{"MATCH,REJECT"}; !reflect.DeepEqual(doc["rules"], want) {
		t.Errorf("rules array was not replaced: %#v", doc["rules"])
	}
	wantUnknown := map[string]any{"enabled": true, "values": []any{"one", "two"}}
	if !reflect.DeepEqual(doc["x-future-feature"], wantUnknown) {
		t.Errorf("unknown config changed: %#v", doc["x-future-feature"])
	}
}

func TestClash_GeneralRetainsRuleAndGroupFiltering(t *testing.T) {
	im := Intermediate{
		DisabledGroups: []string{"Asian TV"},
		Nodes:          []Node{{Name: "n1", Protocol: "trojan", Server: "proxy.example", Port: 443, Password: "p"}},
		Groups:         []Group{{Name: "Home", Type: "select", Members: []string{"DEVICE:HomeMac", "{{NODES}}", "DIRECT"}}},
		Rules: []Rule{
			{Match: "IP-CIDR,192.168.1.0/24", Target: "DEVICE:HomeMac"},
			{Match: "DOMAIN,example.test", Target: "Home"},
		},
	}
	r := &ClashRenderer{}
	base := decodeRenderedClash(t, r.Render(im, "", ""))
	im.ClashGeneral = "mode: global"
	out := r.Render(im, "", "")
	doc := decodeRenderedClash(t, out)
	for _, key := range []string{"proxies", "proxy-groups", "rules", "rule-providers"} {
		if !reflect.DeepEqual(doc[key], base[key]) {
			t.Errorf("override changed filtered %s", key)
		}
	}
	for _, forbidden := range []string{"DEVICE:", "Asian TV", "Abema TV", "Bahamut"} {
		if strings.Contains(out, forbidden) {
			t.Errorf("filtered value %q leaked into merged output", forbidden)
		}
	}
	if !strings.Contains(out, "Home") || !strings.Contains(out, "DOMAIN,example.test,Home") {
		t.Fatal("custom groups or rules were lost")
	}
	if again := r.Render(im, "", ""); again != out {
		t.Fatal("merged output is not deterministic")
	}
}

func TestClash_EmptyGeneralPreservesTemplateBytes(t *testing.T) {
	want := strings.NewReplacer(
		"{{PROXIES}}", "", "proxies: [{{NODES}}]", "proxies: [REJECT]", ", {{NODES}}", "", "{{NODES}}", "",
		"{{CUSTOM_RULES}}", "", "{{CUSTOM_GROUPS}}", "", "{{CUSTOM_PROVIDERS}}", "", "{{CLASH_EXTRA}}", "",
	).Replace(templates.Clash)
	var err error
	want, err = guardClashUDP(want)
	if err != nil {
		t.Fatal(err)
	}
	for _, extra := range []string{"", " \t\n", "{}", "# no overrides\n"} {
		got := (&ClashRenderer{}).Render(Intermediate{ClashGeneral: extra}, "", "")
		if got != want {
			t.Errorf("empty override %q changed original template bytes", extra)
		}
		decodeRenderedClash(t, got)
	}
}

func TestMergeClashGeneral_RecursiveReplacement(t *testing.T) {
	base := "dns:\n  enable: true\n  policy:\n    keep: [old]\n    replace: [old]\nsequence: [old]\nscalar: old\nremove: {nested: old}\n"
	extra := "dns:\n  policy:\n    replace: [new]\nsequence: {nested: new}\nscalar: [new]\nremove: null\n"
	out, err := mergeClashGeneral(base, extra)
	if err != nil {
		t.Fatal(err)
	}
	doc := decodeRenderedClash(t, out)
	want := map[string]any{
		"dns": map[string]any{
			"enable": true,
			"policy": map[string]any{"keep": []any{"old"}, "replace": []any{"new"}},
		},
		"sequence": map[string]any{"nested": "new"},
		"scalar":   []any{"new"},
		"remove":   nil,
	}
	if !reflect.DeepEqual(doc, want) {
		t.Fatalf("merged = %#v, want %#v", doc, want)
	}
}

func TestMergeClashGeneral_ResolvesAliasesBeforeOverlay(t *testing.T) {
	base := "dns:\n  enable: true\n  listen: 127.0.0.1:1053\n  nameserver-policy: {keep.test: 9.9.9.9}\n"
	extra := "x-dns: &dns\n  nameserver-policy: {new.test: https://resolver.example/dns-query}\ndns:\n  <<: *dns\n  listen: 127.0.0.1:5353\n"
	out, err := mergeClashGeneral(base, extra)
	if err != nil {
		t.Fatal(err)
	}
	doc := decodeRenderedClash(t, out)
	dns := doc["dns"].(map[string]any)
	wantPolicy := map[string]any{"keep.test": "9.9.9.9", "new.test": "https://resolver.example/dns-query"}
	if dns["enable"] != true || dns["listen"] != "127.0.0.1:5353" || !reflect.DeepEqual(dns["nameserver-policy"], wantPolicy) {
		t.Fatalf("alias merge lost inherited or base DNS keys: %#v", dns)
	}
	if strings.Contains(out, "<<:") || strings.Contains(out, "*dns") {
		t.Fatalf("unresolved alias/merge key in output:\n%s", out)
	}
}

func TestMergeClashGeneral_RejectsInvalidRenderedYAML(t *testing.T) {
	for _, base := range []string{
		"mode: rule\nmode: global\n",
		"dns: {enable: true, enable: false}\n",
		"mode: rule\n---\nmode: global\n",
		"rules: [unterminated\n",
	} {
		for _, extra := range []string{"", "mode: global"} {
			out, err := mergeClashGeneral(base, extra)
			if err == nil || out != "" {
				t.Errorf("invalid base %q with extra %q: out=%q err=%v", base, extra, out, err)
			}
		}
	}
}

func TestClash_RenderFailsClosedOnInvalidYAML(t *testing.T) {
	for _, im := range []Intermediate{
		{ClashGeneral: "mode: rule\nmode: global\n"},
		{ClashGeneral: "mode: rule\n---\nmode: global\n"},
		// This provider collides with a built-in name after text substitution.
		{Rules: []Rule{{Match: "DOMAIN-SET,https://example.test/AdBlock.yaml", Target: "Proxy"}}},
		{Rules: []Rule{{Match: "DOMAIN,can't.example", Target: "Proxy"}}},
	} {
		out := (&ClashRenderer{}).Render(im, "", "")
		if !strings.HasPrefix(out, "# Clash render error:") {
			t.Fatalf("invalid config returned without an error marker:\n%s", out)
		}
		var doc map[string]any
		if err := yaml.Unmarshal([]byte(out), &doc); err == nil {
			t.Fatalf("failure output could be accepted as a Clash config:\n%s", out)
		}
		if strings.Contains(out, "external-controller:") {
			t.Fatal("invalid config fell back to the base configuration")
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
