package subgen

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func hasDomesticDNS(rules []domesticDNSRule, domain string) bool {
	for _, rule := range rules {
		if rule.Domain == domain {
			return true
		}
	}
	return false
}

func TestDomesticDNSSnapshotReviewedAndDeterministic(t *testing.T) {
	rules, err := domesticDNSRules(Intermediate{}, "surge")
	if err != nil {
		t.Fatal(err)
	}
	if len(rules) != 24 {
		t.Fatalf("reviewed scope unexpectedly changed: %d", len(rules))
	}
	for _, domain := range []string{"taobao.com", "alicdn.com", "jd.com", "baidu.com", "gtimg.com", "bytednsdoc.com", "xhscdn.com"} {
		if !hasDomesticDNS(rules, domain) {
			t.Errorf("missing reviewed CDN %s", domain)
		}
	}
	for _, domain := range []string{"cn", "com.cn", "sinaapp.com", "qq.com", "163.com", "digicert.com", "googleapis.cn", "example.net"} {
		if hasDomesticDNS(rules, domain) {
			t.Errorf("unsafe or unreviewed DNS exception %s", domain)
		}
	}
	again, err := domesticDNSRules(Intermediate{}, "clash")
	if err != nil || !reflect.DeepEqual(rules, again) {
		t.Fatalf("scope drift between supported formats: %v", err)
	}
	// Disabling a service never widens the reviewed exception set.
	disabled, err := domesticDNSRules(Intermediate{DisabledGroups: []string{"CN Mainland TV", "Apple TV"}}, "surge")
	if err != nil || !reflect.DeepEqual(rules, disabled) {
		t.Fatalf("disabled services enlarged or changed DNS scope: %v", err)
	}
}

func TestDomesticDNSRejectsUnsafeDomainScopes(t *testing.T) {
	for _, domain := range []string{"cn", "com.cn", "sinaapp.com", "github.io", "*.taobao.com", "taobao.com.", "TAOBAO.com", "a..com", "-a.com", "a-.com", "a/b.com", "a,b.com", "a com", "127.0.0.1", "a\n.com"} {
		if validDNSDomain(domain) {
			t.Errorf("accepted unsafe DNS domain %q", domain)
		}
	}
	for _, domain := range []string{"taobao.com", "a.taobao.com", "xn--example-9d0b.com"} {
		if !validDNSDomain(domain) {
			t.Errorf("rejected valid domain %q", domain)
		}
	}
}

func TestDomesticDNSCustomRulesOnlySubtract(t *testing.T) {
	for _, target := range []string{"surge", "clash"} {
		for _, match := range []string{"DOMAIN,www.taobao.com", "DOMAIN-SUFFIX,taobao.com", "DOMAIN-SUFFIX,com"} {
			rules, err := domesticDNSRules(Intermediate{Rules: []Rule{{Match: match, Target: "Proxy"}}}, target)
			if err != nil {
				t.Fatal(err)
			}
			if hasDomesticDNS(rules, "taobao.com") {
				t.Errorf("%s leaked custom proxy overlap %s", target, match)
			}
		}
		rules, err := domesticDNSRules(Intermediate{Rules: []Rule{{Match: "DOMAIN,nottaobao.com", Target: "Proxy"}}}, target)
		if err != nil || !hasDomesticDNS(rules, "taobao.com") {
			t.Errorf("%s suffix boundary was not respected: %v", target, err)
		}
		rules, err = domesticDNSRules(Intermediate{Rules: []Rule{{Match: "DOMAIN-SUFFIX,unknown.test", Target: "DIRECT"}}}, target)
		if err != nil || hasDomesticDNS(rules, "unknown.test") {
			t.Errorf("%s custom DIRECT enlarged DNS scope: %v", target, err)
		}
	}
}

func TestDomesticDNSUncertainCustomProxyRulesDisableExceptions(t *testing.T) {
	for _, match := range []string{"PROCESS-NAME,AdsPower*", "RULE-SET,https://example.test/rules", "DOMAIN-SET,https://example.test/domains", "IP-CIDR,10.0.0.0/8", "GEOIP,CN", "DOMAIN-KEYWORD,shop", "AND,((DOMAIN,example.net),(DST-PORT,443))"} {
		for _, target := range []string{"surge", "clash"} {
			rules, err := domesticDNSRules(Intermediate{Rules: []Rule{{Match: match, Target: "Proxy"}}}, target)
			if err != nil || len(rules) != 0 {
				t.Errorf("%s accepted uncertain scope %s: %v", target, match, err)
			}
		}
	}
	for _, key := range []string{"rules", "rule-providers", "proxy-groups"} {
		rules, err := domesticDNSRules(Intermediate{ClashGeneral: key + ": []"}, "clash")
		if err != nil || len(rules) != 0 {
			t.Errorf("overlay %s must disable automatic exceptions: %v", key, err)
		}
	}
}

func TestDomesticDNSProxyEntryAndGroupOverridesDisableOverlaps(t *testing.T) {
	rules, err := domesticDNSRules(Intermediate{Nodes: []Node{{Server: "proxy.taobao.com"}}}, "surge")
	if err != nil || hasDomesticDNS(rules, "taobao.com") || !hasDomesticDNS(rules, "alicdn.com") {
		t.Fatalf("node bootstrap overlap not isolated: %v", err)
	}
	for _, group := range []string{"Domestic", "AdBlock", "Direct"} {
		rules, err = domesticDNSRules(Intermediate{Groups: []Group{{Name: group}}}, "surge")
		if err != nil || len(rules) != 0 {
			t.Errorf("overridden %s should disable domestic DNS: %v", group, err)
		}
	}
}

func TestDomesticDNSHostAndPolicyBoundaries(t *testing.T) {
	rules := []domesticDNSRule{{Kind: "DOMAIN", Domain: "exact.example.test"}, {Kind: "DOMAIN-SUFFIX", Domain: "suffix.example.test"}}
	hosts := domesticDNSHosts(rules)
	if strings.Contains(hosts, "*.exact.example.test") || !strings.Contains(hosts, "exact.example.test = server:"+domesticDoH) {
		t.Fatalf("exact domain expanded: %s", hosts)
	}
	for _, host := range []string{"suffix.example.test", "*.suffix.example.test"} {
		if !strings.Contains(hosts, host+" = server:"+domesticDoH) {
			t.Errorf("missing root/wildcard %s", host)
		}
	}
	policy := domesticDNSClashPolicy(rules)
	if !strings.Contains(policy, "'exact.example.test':") || !strings.Contains(policy, "'+.suffix.example.test':") || strings.Contains(policy, "'+.exact") {
		t.Fatalf("bad DNS policy scopes: %s", policy)
	}
}

func TestDomesticDNSRejectsRuleInjection(t *testing.T) {
	for _, rule := range []Rule{
		{Match: "DOMAIN-SUFFIX,taobao.com,Proxy\nDOMAIN,example.net", Target: "DIRECT"},
		{Match: "DOMAIN,example.net", Target: "DIRECT\nDOMAIN-SUFFIX,taobao.com,Proxy"},
		{Match: "DOMAIN,example.net\u2028FINAL,DIRECT", Target: "DIRECT"},
	} {
		for _, target := range []string{"surge", "clash", "shadowrocket"} {
			if rules, err := domesticDNSRules(Intermediate{Rules: []Rule{rule}}, target); err == nil || len(rules) != 0 {
				t.Errorf("%s accepted rule injection", target)
			}
		}
	}
	for _, extra := range []Intermediate{{MITM: "[Rule]\nFINAL,Proxy"}, {URLRewrite: "[Rule]\nFINAL,Proxy"}, {Groups: []Group{{Name: "custom"}}}} {
		if rules, err := domesticDNSRules(extra, "surge"); err != nil || len(rules) != 0 {
			t.Errorf("raw/custom scope must disable auto domestic DNS: %v", err)
		}
	}
}

func TestDomesticDNSInvalidSnapshotFailsClosed(t *testing.T) {
	var snapshot domesticDNSData
	if err := json.Unmarshal(domesticDNSSnapshot, &snapshot); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*domesticDNSData){
		func(s *domesticDNSData) { s.Revision = "main" },
		func(s *domesticDNSData) { s.SeedsSHA256 = "invalid" },
		func(s *domesticDNSData) {
			s.Rules = append(s.Rules, domesticDNSRule{Kind: "DOMAIN-SUFFIX", Domain: "cn"})
		},
		func(s *domesticDNSData) { s.Rules = append(s.Rules, s.Rules[0]) },
		func(s *domesticDNSData) { s.Rules = nil },
	} {
		copy := snapshot
		copy.Rules = append([]domesticDNSRule(nil), snapshot.Rules...)
		mutate(&copy)
		bad, err := json.Marshal(copy)
		if err != nil {
			t.Fatal(err)
		}
		if rules, err := decodeDomesticDNS(bad); err == nil || len(rules) != 0 {
			t.Fatal("invalid snapshot silently accepted")
		}
	}
}
