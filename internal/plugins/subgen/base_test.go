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
		GroupByCountry:    true,
	}
	im := Assemble(nodes, spec, "surge", DefaultRulesetBase)
	if len(im.Nodes) != 2 {
		t.Fatalf("nodes=%d", len(im.Nodes))
	}
	if findGroup(im.Groups, "PROXY") == nil || findGroup(im.Groups, "Auto Select") == nil {
		t.Fatalf("missing core groups: %+v", im.Groups)
	}
	if im.Rules[0] != "IP-CIDR,10.0.0.0/24,PROXY" {
		t.Fatalf("custom rule not first: %v", im.Rules[0])
	}
	if im.Rules[len(im.Rules)-1] != "FINAL,PROXY" {
		t.Fatalf("final not last: %v", im.Rules[len(im.Rules)-1])
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
