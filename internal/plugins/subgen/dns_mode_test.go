package subgen

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDNSModeValidationAndAssemble(t *testing.T) {
	for _, mode := range []string{"", DNSModePrivate, DNSModeRuleAware} {
		data, _ := json.Marshal(TemplateSpec{DNSMode: mode})
		spec, err := ParseTemplate(string(data))
		if err != nil {
			t.Fatal(err)
		}
		if Assemble(nil, spec).DNSMode != mode {
			t.Fatal("DNS mode lost in intermediate model")
		}
	}
	if _, err := ParseTemplate(`{"dns_mode":"invented"}`); err == nil {
		t.Fatal("unknown DNS mode accepted")
	}
}

func TestRuleAwareSurgeWithRealisticProcessRules(t *testing.T) {
	im := Intermediate{
		DNSMode: DNSModeRuleAware,
		Nodes:   []Node{{Name: "Test-A", Protocol: "trojan", Server: "192.0.2.1", Port: 443, Password: "p"}},
		Groups:  []Group{{Name: "Browser", Type: "select", Members: []string{"Test-A", "DIRECT"}, Verbatim: true}},
		Rules: []Rule{
			{Match: "PROCESS-NAME,SunBrowser*", Target: "Browser"},
			{Match: "PROCESS-NAME,FlowerBrowser*", Target: "Browser"},
			{Match: "PROCESS-NAME,AdsPower*", Target: "Browser"},
			{Match: "DOMAIN-SUFFIX,taobao.com", Target: "Domestic"},
			{Match: "IP-CIDR,203.0.113.0/24", Target: "Browser"},
		},
	}
	out := (&SurgeRenderer{}).Render(im, "https://example.test/sub", "")
	for _, want := range []string{
		"encrypted-dns-server = " + domesticDoH + "\n",
		"encrypted-dns-follow-outbound-mode = false\n",
		"use-local-host-item-for-proxy = false\n",
		"always-real-ip = *.lan, *.local\n",
		"PROCESS-NAME,AdsPower*,Browser\n",
		"DOMAIN-SUFFIX,taobao.com,Domestic\n",
		"GEOIP,CN,Domestic,no-resolve\n",
		"RULE-SET,LAN,DIRECT,no-resolve\n",
		"IP-CIDR,203.0.113.0/24,Browser,no-resolve\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
	for _, forbidden := range []string{"PROTOCOL,DOH,Proxy", "taobao.com = server:", "*.stun.", "Shepherd-DNS"} {
		if strings.Contains(out, forbidden) {
			t.Errorf("rule-aware mode retained %q", forbidden)
		}
	}
	section := ""
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "[") {
			section = line
		}
		if section == "[Rule]" && strings.HasPrefix(line, "RULE-SET,") && !containsRuleOption(line, "no-resolve") {
			t.Errorf("mixed ruleset can still trigger local DNS: %s", line)
		}
	}
	if strings.Index(out, "PROCESS-NAME,AdsPower*") > strings.Index(out, "Provider/Domestic.list") {
		t.Fatal("business process rule precedence changed")
	}
}

func TestRuleAwareSurgePreservesPrivateDefaultAndExplicitOverrides(t *testing.T) {
	r := &SurgeRenderer{}
	legacy := r.Render(Intermediate{}, "x", "")
	explicit := r.Render(Intermediate{DNSMode: DNSModePrivate}, "x", "")
	if legacy != explicit || !strings.Contains(legacy, "PROTOCOL,DOH,Proxy") {
		t.Fatal("existing private templates changed without opt-in")
	}
	out := r.Render(Intermediate{DNSMode: DNSModeRuleAware, General: "encrypted-dns-server = https://resolver.example/dns-query"}, "x", "")
	if !strings.Contains(out, "encrypted-dns-server = https://resolver.example/dns-query\n") || strings.Count(out, "\nencrypted-dns-server = ") != 1 {
		t.Fatal("explicit General override was ignored/duplicated")
	}
}

func TestRuleAwareClashUsesNativeDirectResolverNotDomainScope(t *testing.T) {
	im := Intermediate{DNSMode: DNSModeRuleAware, Rules: []Rule{{Match: "PROCESS-NAME,TestBrowser", Target: "Business"}}, Groups: []Group{{Name: "Business", Type: "select", Members: []string{"DIRECT", "Proxy"}, Verbatim: true}}}
	out := (&ClashRenderer{}).Render(im, "", "")
	doc := decodeRenderedClash(t, out)
	dns := doc["dns"].(map[string]any)
	if dns["direct-nameserver"].([]any)[0] != domesticDoH+"#DIRECT" || dns["direct-nameserver-follow-policy"] != false {
		t.Fatal("native DIRECT resolver not configured")
	}
	if dns["nameserver"].([]any)[0] != primaryDoH+"#Proxy" {
		t.Fatal("safe pre-resolution lost")
	}
	if _, exists := dns["nameserver-policy"]; exists {
		t.Fatal("static domestic scope must not override final business choices")
	}
	if !strings.Contains(out, "PROCESS-NAME,TestBrowser,Business") {
		t.Fatal("process routing lost")
	}
}

func TestRuleAwareRejectsUnverifiedClientAndResolverRules(t *testing.T) {
	out := (&ShadowRocketRenderer{}).Render(Intermediate{DNSMode: DNSModeRuleAware}, "x", "")
	if validateRenderedConfig(out, "shadowrocket") == nil {
		t.Fatal("unverified client silently accepted rule-aware contract")
	}
	out = (&SurgeRenderer{}).Render(Intermediate{DNSMode: DNSModeRuleAware, Rules: []Rule{{Match: "SCRIPT,maybe-resolving-script", Target: "Proxy"}}}, "x", "")
	if validateRenderedConfig(out, "surge") == nil {
		t.Fatal("unknown DNS side effects must not be guessed")
	}
}

func TestSurgeDomainFirstNoResolvePolicyNameIsNotAnOption(t *testing.T) {
	in := "[Rule]\nGEOIP,CN,no-resolve\nIP-CIDR,192.0.2.0/24,no-resolve\nRULE-SET,https://example.test/set,no-resolve\nFINAL,Proxy\n"
	out, err := surgeDomainFirstRules(in)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(out, ",no-resolve,no-resolve\n") != 3 {
		t.Fatal("policy named no-resolve was mistaken for option")
	}
}

func TestSurgeDomainFirstIdempotentAndNoIPPayloadCorruption(t *testing.T) {
	in := "[Rule]\nDOMAIN,example.test,DIRECT\nIP-CIDR,203.0.113.0/24,Proxy\nGEOIP,CN,Domestic,no-resolve\nRULE-SET,https://example.test/rules,Proxy,extended-matching\nFINAL,Others,dns-failed\n"
	first, err := surgeDomainFirstRules(in)
	if err != nil {
		t.Fatal(err)
	}
	second, err := surgeDomainFirstRules(first)
	if err != nil || first != second {
		t.Fatalf("not idempotent: %v", err)
	}
	if !strings.Contains(first, "IP-CIDR,203.0.113.0/24,Proxy,no-resolve") || !strings.Contains(first, "extended-matching,no-resolve") {
		t.Fatal("literal IP/mixed set payload changed")
	}
}
