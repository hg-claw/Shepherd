package subgen

import (
	"testing"
)

func TestAssemble_CustomOnly(t *testing.T) {
	spec := TemplateSpec{
		Categories:   []CategorySel{{Name: "AI", Policy: "PROXY"}},
		CustomRules:  []CustomRule{{Match: "DOMAIN,x.com", Policy: "DIRECT"}},
		CustomGroups: []CustomGroup{{Name: "G", Type: "select", Members: []string{"DIRECT"}}},
		Final:        "PROXY",
	}
	im := Assemble([]Node{{Name: "n1"}}, spec)
	if len(im.Nodes) != 1 || im.Nodes[0].Name != "n1" {
		t.Fatalf("nodes: %+v", im.Nodes)
	}
	if len(im.Groups) != 1 || im.Groups[0].Name != "G" || !im.Groups[0].Verbatim {
		t.Fatalf("groups should be custom-only: %+v", im.Groups)
	}
	if len(im.Rules) != 1 || im.Rules[0].Match != "DOMAIN,x.com" || im.Rules[0].Target != "DIRECT" {
		t.Fatalf("rules should be custom-only: %+v", im.Rules)
	}
}

func TestAssemble_PropagatesGeneralFields(t *testing.T) {
	nodes := []Node{
		{Name: "🇯🇵 tokyo vless", Protocol: "vless", Server: "1.1.1.1", Port: 443, Country: "JP"},
	}
	spec := TemplateSpec{
		Final:        "PROXY",
		General:      "g",
		MITM:         "m",
		ClashGeneral: "mode: rule",
	}
	im := Assemble(nodes, spec)
	if im.General != "g" || im.MITM != "m" || im.ClashGeneral != "mode: rule" {
		t.Fatalf("general/mitm/clash not propagated: %q/%q/%q", im.General, im.MITM, im.ClashGeneral)
	}
}

func TestAssemble_AppendsCustomGroups(t *testing.T) {
	spec := TemplateSpec{
		Final:        "PROXY",
		CustomGroups: []CustomGroup{{Name: "Home", Type: "select", Members: []string{"DEVICE:HomeMac", "DIRECT"}}},
	}
	im := Assemble(nil, spec)
	g := findGroup(im.Groups, "Home")
	if g == nil || g.Type != "select" || !g.Verbatim || !equalStrings(g.Members, []string{"DEVICE:HomeMac", "DIRECT"}) {
		t.Fatalf("Home group = %+v", g)
	}
}

func TestAssemble_DedupesNodeNames(t *testing.T) {
	nodes := []Node{
		{Name: "🇭🇰 香港", Protocol: "anytls"},
		{Name: "🇭🇰 香港", Protocol: "vless"},
	}
	im := Assemble(nodes, TemplateSpec{Final: "PROXY"})
	if im.Nodes[0].Name != "🇭🇰 香港" || im.Nodes[1].Name != "🇭🇰 香港 2" {
		t.Fatalf("dedupe in Assemble: got %q, %q", im.Nodes[0].Name, im.Nodes[1].Name)
	}
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

