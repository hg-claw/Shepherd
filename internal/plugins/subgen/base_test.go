package subgen

import (
	"strings"
	"testing"
)

func TestAssemble_GroupsAndRules(t *testing.T) {
	nodes := []Node{
		{Name: "🇯🇵 tokyo vless", Protocol: "vless", Server: "1.1.1.1", Port: 443, Country: "JP"},
		{Name: "🇸🇬 sg ss", Protocol: "shadowsocks", Server: "2.2.2.2", Port: 8388, Country: "SG"},
	}
	spec := TemplateSpec{
		Categories:        []CategorySel{{Name: "Telegram", Policy: "PROXY"}, {Name: "Location:CN", Policy: "DIRECT"}},
		CustomRules:       []CustomRule{{Match: "IP-CIDR,10.0.0.0/24", Policy: "PROXY"}},
		Final:             "PROXY",
		IncludeAutoSelect: true,
	}
	im := Assemble(nodes, spec, "surge", DefaultRulesetBase)

	// PROXY is the first group.
	if len(im.Groups) == 0 || im.Groups[0].Name != "PROXY" {
		t.Fatalf("PROXY not first: %+v", im.Groups)
	}
	// Auto Select present; NO per-country groups.
	if findGroup(im.Groups, "Auto Select") == nil {
		t.Fatal("missing Auto Select group")
	}
	if findGroup(im.Groups, "🇯🇵 JP") != nil || findGroup(im.Groups, "🇸🇬 SG") != nil {
		t.Fatalf("country groups should be gone: %+v", im.Groups)
	}

	// Each category → a select group; first member = configured policy; deduped.
	tg := findGroup(im.Groups, "Telegram")
	if tg == nil || tg.Type != "select" {
		t.Fatalf("Telegram group missing/wrong: %+v", tg)
	}
	wantTG := []string{"PROXY", "DIRECT", "REJECT", "🇯🇵 tokyo vless", "🇸🇬 sg ss"}
	if !equalStrings(tg.Members, wantTG) {
		t.Fatalf("Telegram members = %v want %v", tg.Members, wantTG)
	}
	cn := findGroup(im.Groups, "Location:CN")
	wantCN := []string{"DIRECT", "PROXY", "REJECT", "🇯🇵 tokyo vless", "🇸🇬 sg ss"}
	if cn == nil || !equalStrings(cn.Members, wantCN) {
		t.Fatalf("Location:CN members = %v want %v", cn.Members, wantCN)
	}

	// Custom rule first, FINAL last, category rules route to the GROUP name.
	if im.Rules[0] != "IP-CIDR,10.0.0.0/24,PROXY" {
		t.Fatalf("custom rule not first: %v", im.Rules[0])
	}
	if im.Rules[len(im.Rules)-1] != "FINAL,PROXY" {
		t.Fatalf("final not last: %v", im.Rules[len(im.Rules)-1])
	}
	if !containsRule(im.Rules, "GEOIP,CN,Location:CN") {
		t.Fatalf("CN rule should route to its group: %v", im.Rules)
	}
	foundTG := false
	for _, r := range im.Rules {
		if strings.HasPrefix(r, "RULE-SET,") && strings.HasSuffix(r, ",Telegram") {
			foundTG = true
		}
	}
	if !foundTG {
		t.Fatalf("Telegram rule should route to its group: %v", im.Rules)
	}

	// General/MITM propagate onto the intermediate.
	spec2 := spec
	spec2.General = "dns-server = 1.1.1.1"
	spec2.MITM = "hostname = *.x.com"
	im2 := Assemble(nodes, spec2, "surge", DefaultRulesetBase)
	if im2.General != "dns-server = 1.1.1.1" || im2.MITM != "hostname = *.x.com" {
		t.Fatalf("general/mitm not propagated: %q / %q", im2.General, im2.MITM)
	}
}

func findGroup(gs []Group, name string) *Group {
	for i := range gs {
		if gs[i].Name == name {
			return &gs[i]
		}
	}
	return nil
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func containsRule(rules []string, want string) bool {
	for _, r := range rules {
		if r == want {
			return true
		}
	}
	return false
}
