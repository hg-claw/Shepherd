package subgen

import (
	"strings"
	"testing"
)

func TestResolveRuleLines_RemoteAndNative(t *testing.T) {
	base := "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master"
	lines := ResolveRuleLines("Telegram", "PROXY", "surge", base)
	if len(lines) != 1 || !strings.HasPrefix(lines[0], "RULE-SET,") ||
		!strings.Contains(lines[0], "/rule/Surge/Telegram/Telegram.list,") ||
		!strings.HasSuffix(lines[0], ",PROXY") {
		t.Fatalf("telegram line = %v", lines)
	}
	cn := ResolveRuleLines("Location:CN", "DIRECT", "surge", base)
	if len(cn) != 1 || cn[0] != "GEOIP,CN,DIRECT" {
		t.Fatalf("cn line = %v", cn)
	}
}

func TestPredefinedTemplatesReferenceKnownCategories(t *testing.T) {
	known := map[string]bool{}
	for _, c := range UnifiedCategories {
		known[c.Name] = true
	}
	for set, names := range PredefinedTemplates {
		for _, n := range names {
			if !known[n] {
				t.Errorf("predefined %q references unknown category %q", set, n)
			}
		}
	}
}
