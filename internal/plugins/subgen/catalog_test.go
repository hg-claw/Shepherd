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

func TestRulesetURL_SurgeAndClash(t *testing.T) {
	base := "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master"
	if got := rulesetURL("Telegram", "surge", base); got != base+"/rule/Surge/Telegram/Telegram.list" {
		t.Fatalf("surge url = %s", got)
	}
	if got := rulesetURL("Telegram", "shadowrocket", base); got != base+"/rule/Surge/Telegram/Telegram.list" {
		t.Fatalf("shadowrocket url = %s", got)
	}
	if got := rulesetURL("Telegram", "clash", base); got != base+"/rule/Clash/Telegram/Telegram.yaml" {
		t.Fatalf("clash url = %s", got)
	}
}

func TestRulesetURL_CustomAbsolute(t *testing.T) {
	const want = "https://raw.githubusercontent.com/iab0x00/ProxyRules/main/Rule/AI.txt"
	for _, target := range []string{"surge", "shadowrocket", "clash"} {
		if got := rulesetURL("AI", target, DefaultRulesetBase); got != want {
			t.Fatalf("%s: rulesetURL(AI) = %s", target, got)
		}
	}
	// AI Services now references the custom "AI" ruleset, not blackmatrix7 OpenAI.
	c, _ := categoryByName("AI Services")
	if len(c.Rulesets) != 1 || c.Rulesets[0] != "AI" {
		t.Fatalf("AI Services rulesets = %v", c.Rulesets)
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
