package subgen

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRenderRejectsMultilineAndMarkerInjection(t *testing.T) {
	for _, im := range []Intermediate{
		{Nodes: []Node{{Name: "n", Protocol: "trojan", Server: "192.0.2.1", Password: "p\n[Rule]\nFINAL,DIRECT"}}},
		{Nodes: []Node{{Name: "{{DNS_RULES}}", Protocol: "trojan", Server: "192.0.2.1"}}},
		{Nodes: []Node{{Name: "n", Protocol: "trojan", Server: "192.0.2.1", Extra: map[string]any{"mode": "x\n[General]"}}}},
		{Rules: []Rule{{Match: "DOMAIN-SUFFIX,taobao.com,Proxy\nDOMAIN,example.net", Target: "DIRECT"}}},
		{Rules: []Rule{{Match: "DOMAIN,example.net", Target: "DIRECT\nDOMAIN-SUFFIX,taobao.com,Proxy"}}},
		{Rules: []Rule{{Match: "DOMAIN,example.net", Target: "{{DOMESTIC_DNS_HOSTS}}"}}},
		{Groups: []Group{{Name: "g", Type: "select", Members: []string{"DIRECT\n[Rule]"}}}},
	} {
		for _, target := range []string{"surge", "shadowrocket", "clash"} {
			r, _ := rendererFor(target)
			out := r.Render(im, "x", "")
			if !strings.Contains(out, "render error:") || validateRenderedConfig(out, target) == nil {
				t.Errorf("%s accepted template injection: %s", target, out)
			}
		}
	}
}

func TestTemplateRejectsCustomRuleAndGeneralLineInjection(t *testing.T) {
	for _, spec := range []TemplateSpec{
		{CustomRules: []CustomRule{{Match: "DOMAIN,a.test\nFINAL,DIRECT", Policy: "DIRECT"}}},
		{CustomRules: []CustomRule{{Match: "DOMAIN,a.test", Policy: "DIRECT\nFINAL,Proxy"}}},
		{General: "loglevel = notify\r[Rule]\rFINAL,Proxy"},
		{General: "loglevel = notify\u2028[Rule]"},
		{CustomGroups: []CustomGroup{{Name: "g\n[Rule]", Type: "select", Members: []string{"DIRECT"}}}},
	} {
		data, err := json.Marshal(spec)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ParseTemplate(string(data)); err == nil {
			t.Error("accepted injected template")
		}
	}
	// Ordinary CRLF files remain valid; CR inside a physical line does not.
	if _, _, err := parseGeneral("loglevel = notify\r\nipv6 = false\r\n"); err != nil {
		t.Fatalf("valid CRLF override rejected: %v", err)
	}
}

func TestCustomNodeDecodedCredentialsCannotAddSections(t *testing.T) {
	spec := TemplateSpec{CustomNodes: "trojan://p%0A%5BRule%5D%0AFINAL%2CDIRECT@192.0.2.1:443#n"}
	im := Assemble(nil, spec)
	if len(im.Nodes) != 1 {
		t.Fatal("test must exercise decoded share-link fields")
	}
	if err := validateRenderValues(im); err == nil {
		t.Fatal("decoded multiline password accepted")
	}
}
