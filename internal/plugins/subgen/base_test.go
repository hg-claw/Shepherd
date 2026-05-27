package subgen

import "testing"

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
	im := Assemble(nodes, spec)

	if len(im.Groups) == 0 || im.Groups[0].Name != "PROXY" {
		t.Fatalf("PROXY not first: %+v", im.Groups)
	}
	if findGroup(im.Groups, "Auto Select") == nil {
		t.Fatal("missing Auto Select group")
	}
	if findGroup(im.Groups, "🇯🇵 JP") != nil || findGroup(im.Groups, "🇸🇬 SG") != nil {
		t.Fatalf("country groups should be gone: %+v", im.Groups)
	}
	tg := findGroup(im.Groups, "Telegram")
	if tg == nil || tg.Type != "select" {
		t.Fatalf("Telegram group missing/wrong: %+v", tg)
	}
	wantTG := []string{"PROXY", "DIRECT", "REJECT", "🇯🇵 tokyo vless", "🇸🇬 sg ss"}
	if !equalStrings(tg.Members, wantTG) {
		t.Fatalf("Telegram members = %v want %v", tg.Members, wantTG)
	}

	if r0 := im.Rules[0]; r0.Match != "IP-CIDR,10.0.0.0/24" || r0.Target != "PROXY" {
		t.Fatalf("custom rule not first: %+v", r0)
	}
	if last := im.Rules[len(im.Rules)-1]; !last.Final || last.Target != "PROXY" {
		t.Fatalf("final not last: %+v", last)
	}
	if !hasRule(im.Rules, Rule{Ruleset: "Telegram", Target: "Telegram"}) {
		t.Fatalf("telegram ruleset rule missing: %+v", im.Rules)
	}
	if !hasRule(im.Rules, Rule{Native: "GEOIP,CN", Target: "Location:CN"}) {
		t.Fatalf("cn native rule missing: %+v", im.Rules)
	}

	spec2 := spec
	spec2.General = "g"
	spec2.MITM = "m"
	spec2.ClashGeneral = "mode: rule"
	im2 := Assemble(nodes, spec2)
	if im2.General != "g" || im2.MITM != "m" || im2.ClashGeneral != "mode: rule" {
		t.Fatalf("general/mitm/clash not propagated: %q/%q/%q", im2.General, im2.MITM, im2.ClashGeneral)
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

func hasRule(rules []Rule, want Rule) bool {
	for _, r := range rules {
		if r == want {
			return true
		}
	}
	return false
}

func TestAssemble_AppendsCustomGroups(t *testing.T) {
	spec := TemplateSpec{
		Final:             "PROXY",
		IncludeAutoSelect: true,
		Categories:        []CategorySel{{Name: "Telegram", Policy: "PROXY"}},
		CustomGroups:      []CustomGroup{{Name: "Home", Type: "select", Members: []string{"DEVICE:HomeMac", "DIRECT"}}},
	}
	im := Assemble(nil, spec)
	g := findGroup(im.Groups, "Home")
	if g == nil || g.Type != "select" || !g.Verbatim || !equalStrings(g.Members, []string{"DEVICE:HomeMac", "DIRECT"}) {
		t.Fatalf("Home group = %+v", g)
	}
	if hi, ti := groupIndex(im.Groups, "Home"), groupIndex(im.Groups, "Telegram"); hi < 0 || ti < 0 || hi > ti {
		t.Fatalf("custom group should precede category group: Home@%d Telegram@%d", hi, ti)
	}
}

func groupIndex(gs []Group, name string) int {
	for i := range gs {
		if gs[i].Name == name {
			return i
		}
	}
	return -1
}

func TestAssemble_AppendsCustomNodes(t *testing.T) {
	spec := TemplateSpec{
		Final:       "PROXY",
		CustomNodes: "trojan://pw@9.9.9.9:443?sni=x.com#🌟 Custom",
	}
	im := Assemble(nil, spec)
	found := false
	for _, n := range im.Nodes {
		if n.Name == "🌟 Custom" && n.Protocol == "trojan" && n.Server == "9.9.9.9" {
			found = true
		}
	}
	if !found {
		t.Fatalf("custom node not appended: %+v", im.Nodes)
	}
}
