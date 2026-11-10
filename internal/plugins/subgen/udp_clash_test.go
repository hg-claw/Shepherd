package subgen

import (
	"reflect"
	"strings"
	"testing"

	"github.com/hg-claw/Shepherd/internal/plugins/subgen/templates"
	"gopkg.in/yaml.v3"
)

func TestGuardClashUDP_RuleOrderAndSelectGroups(t *testing.T) {
	in := `proxy-groups:
    - { name: Netflix, type: select, proxies: [Proxy, DIRECT] }
    - { name: Domestic, type: select, proxies: [DIRECT, Proxy] }
rules:
    - 'RULE-SET,Netflix,Netflix'
    - 'GEOIP,CN,DIRECT'
    - 'RULE-SET,Domestic,Domestic'
    - 'MATCH,Others'
`
	want := `proxy-groups:
    - { name: Netflix, type: select, proxies: [Proxy, DIRECT] }
    - { name: Domestic, type: select, proxies: [DIRECT, Proxy] }
rules:
    - 'RULE-SET,Netflix,Netflix'
    - 'AND,((NETWORK,udp),(RULE-SET,Netflix)),REJECT'
    - 'GEOIP,CN,DIRECT'
    - 'RULE-SET,Domestic,Domestic'
    - 'AND,((NETWORK,udp),(RULE-SET,Domestic)),REJECT'
    - 'MATCH,Others'
    - 'NETWORK,udp,REJECT'
`
	got, err := guardClashUDP(in)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("guard must precede the later domestic DIRECT rule without altering select groups:\ngot:\n%s\nwant:\n%s", got, want)
	}
	wantRules := []string{
		"RULE-SET,Netflix,Netflix",
		"AND,((NETWORK,udp),(RULE-SET,Netflix)),REJECT",
		"GEOIP,CN,DIRECT",
		"RULE-SET,Domestic,Domestic",
		"AND,((NETWORK,udp),(RULE-SET,Domestic)),REJECT",
		"MATCH,Others",
		"NETWORK,udp,REJECT",
	}
	if rules := decodeClashUDPRules(t, got); !reflect.DeepEqual(rules, wantRules) {
		t.Fatalf("wrong effective rule order: %#v", rules)
	}
}

func TestGuardClashUDP_MatchExpressions(t *testing.T) {
	cases := []struct {
		name  string
		rule  string
		guard string
	}{
		{"ruleset", "RULE-SET,Netflix,Netflix", "AND,((NETWORK,udp),(RULE-SET,Netflix)),REJECT"},
		{"match", "MATCH,Others", "NETWORK,udp,REJECT"},
		{"cidr", "IP-CIDR,198.51.100.0/24,Proxy,no-resolve", "AND,((NETWORK,udp),(IP-CIDR,198.51.100.0/24,no-resolve)),REJECT"},
		{"cidr6", "IP-CIDR6,2001:db8::/32,Proxy,no-resolve", "AND,((NETWORK,udp),(IP-CIDR6,2001:db8::/32,no-resolve)),REJECT"},
		{"geoip", "GEOIP,CN,Domestic,no-resolve", "AND,((NETWORK,udp),(GEOIP,CN,no-resolve)),REJECT"},
		{"asn", "IP-ASN,64500,Proxy,no-resolve", "AND,((NETWORK,udp),(IP-ASN,64500,no-resolve)),REJECT"},
		{"ruleset_no_resolve", "RULE-SET,Domestic IPs,Domestic,no-resolve", "AND,((NETWORK,udp),(RULE-SET,Domestic IPs,no-resolve)),REJECT"},
		{"and", "AND,((DOMAIN,example.test),(DST-PORT,443)),Proxy", "AND,((NETWORK,udp),(AND,((DOMAIN,example.test),(DST-PORT,443)))),REJECT"},
		{"or", "OR,((DOMAIN,a.test),(DOMAIN,b.test)),Select Group", "AND,((NETWORK,udp),(OR,((DOMAIN,a.test),(DOMAIN,b.test)))),REJECT"},
		{"nested", "AND,((OR,((DOMAIN,a.test),(DOMAIN,b.test))),(IP-CIDR,198.51.100.0/24,no-resolve)),Proxy", "AND,((NETWORK,udp),(AND,((OR,((DOMAIN,a.test),(DOMAIN,b.test))),(IP-CIDR,198.51.100.0/24,no-resolve)))),REJECT"},
		{"not", "NOT,((DOMAIN,example.test)),Proxy", "AND,((NETWORK,udp),(NOT,((DOMAIN,example.test)))),REJECT"},
		{"policy_parentheses", "DOMAIN,example.test,Proxy (fallback)", "AND,((NETWORK,udp),(DOMAIN,example.test)),REJECT"},
		{"quote", "RULE-SET,Bob's domains,Proxy", "AND,((NETWORK,udp),(RULE-SET,Bob's domains)),REJECT"},
		{"unicode", "DOMAIN,example.test,选择组", "AND,((NETWORK,udp),(DOMAIN,example.test)),REJECT"},
		{"regex_comma", `DOMAIN-REGEX,^(foo|bar){1,3}\.example$,Proxy`, `AND,((NETWORK,udp),(DOMAIN-REGEX,^(foo|bar){1,3}\.example$)),REJECT`},
		{"wildcard", "DOMAIN-WILDCARD,*.example,Proxy", "AND,((NETWORK,udp),(DOMAIN-WILDCARD,*.example)),REJECT"},
		{"process_wildcard", "PROCESS-NAME-WILDCARD,app*,Proxy", "AND,((NETWORK,udp),(PROCESS-NAME-WILDCARD,app*)),REJECT"},
		{"src", "IP-CIDR,198.51.100.0/24,Proxy,src,no-resolve", "AND,((NETWORK,udp),(IP-CIDR,198.51.100.0/24,src,no-resolve)),REJECT"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := "rules:\n  - '" + strings.ReplaceAll(tc.rule, "'", "''") + "'\n"
			got, err := guardClashUDP(in)
			if err != nil {
				t.Fatal(err)
			}
			want := in + "  - '" + strings.ReplaceAll(tc.guard, "'", "''") + "'\n"
			if got != want {
				t.Fatalf("got %q, want %q", got, want)
			}
			if rules := decodeClashUDPRules(t, got); !reflect.DeepEqual(rules, []string{tc.rule, tc.guard}) {
				t.Fatalf("original rule or guard changed: %#v", rules)
			}
		})
	}
}

func TestGuardClashUDP_TerminalPolicies(t *testing.T) {
	for _, policy := range []string{"DIRECT", "REJECT", "REJECT-DROP", "PASS"} {
		t.Run(policy, func(t *testing.T) {
			in := "rules:\n" +
				"  - 'RULE-SET,Netflix," + policy + "'\n" +
				"  - 'GEOIP,CN," + policy + ",no-resolve'\n" +
				"  - 'AND,((DOMAIN,a.test),(DST-PORT,443))," + policy + "'\n" +
				"  - 'MATCH," + policy + "'\n"
			got, err := guardClashUDP(in)
			if err != nil || got != in {
				t.Fatalf("terminal policy changed: got %q, err %v", got, err)
			}
		})
	}
}

func TestGuardClashUDP_PreservesBytes(t *testing.T) {
	cases := []struct {
		name   string
		before string
		after  string
	}{
		{
			"comments_and_sections",
			"# exact header\nmode: rule # keep\ndns: {enable: true, nameserver: ['1.1.1.1']}\nrules: # keep\n    # rule note\n    - \"DOMAIN,example.test,Proxy\"  # inline note\n\n    # Direct note\n    - GEOIP,CN,DIRECT\nrule-providers: {x: {type: inline, payload: []}} # keep\n",
			"# exact header\nmode: rule # keep\ndns: {enable: true, nameserver: ['1.1.1.1']}\nrules: # keep\n    # rule note\n    - \"DOMAIN,example.test,Proxy\"  # inline note\n    - 'AND,((NETWORK,udp),(DOMAIN,example.test)),REJECT'\n\n    # Direct note\n    - GEOIP,CN,DIRECT\nrule-providers: {x: {type: inline, payload: []}} # keep\n",
		},
		{"crlf", "mode: rule\r\nrules:\r\n  - 'MATCH,Others'\r\n", "mode: rule\r\nrules:\r\n  - 'MATCH,Others'\r\n  - 'NETWORK,udp,REJECT'\r\n"},
		{"no_final_newline", "rules:\n- 'MATCH,Others'", "rules:\n- 'MATCH,Others'\n- 'NETWORK,udp,REJECT'"},
		{"crlf_no_final_newline", "rules:\r\n  - 'MATCH,Others'", "rules:\r\n  - 'MATCH,Others'\r\n  - 'NETWORK,udp,REJECT'"},
		{"plain", "rules:\n  - DOMAIN,example.test,Proxy\n", "rules:\n  - DOMAIN,example.test,Proxy\n  - 'AND,((NETWORK,udp),(DOMAIN,example.test)),REJECT'\n"},
		{"empty", "# explicitly no rules\nrules: []\n", "# explicitly no rules\nrules: []\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := guardClashUDP(tc.before)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.after {
				t.Fatalf("unrelated formatting changed: got %q, want %q", got, tc.after)
			}
			decodeClashUDPRules(t, got)
		})
	}
}

func TestGuardClashUDP_Idempotent(t *testing.T) {
	in := "rules:\n" +
		"  - 'RULE-SET,Netflix,Netflix'\n" +
		"  # Existing guard separated by a comment is still adjacent in rules.\n" +
		"  - \"AND,((NETWORK,udp),(RULE-SET,Netflix)),REJECT\"\n" +
		"  - 'IP-CIDR,198.51.100.0/24,Proxy,no-resolve'\n" +
		"  - 'AND,((DOMAIN,example.test),(DST-PORT,443)),Proxy'\n" +
		"  - 'MATCH,Others'"
	first, err := guardClashUDP(in)
	if err != nil {
		t.Fatal(err)
	}
	second, err := guardClashUDP(first)
	if err != nil {
		t.Fatal(err)
	}
	if second != first {
		t.Fatalf("second invocation changed output:\nfirst:\n%s\nsecond:\n%s", first, second)
	}
	if strings.Count(first, "AND,((NETWORK,udp),(RULE-SET,Netflix)),REJECT") != 1 {
		t.Fatal("duplicated an existing adjacent guard")
	}
}

func TestGuardClashUDP_ExistingLateGuardDoesNotReplaceImmediateGuard(t *testing.T) {
	in := "rules:\n  - 'RULE-SET,Netflix,Netflix'\n  - 'GEOIP,CN,DIRECT'\n  - 'AND,((NETWORK,udp),(RULE-SET,Netflix)),REJECT'\n"
	got, err := guardClashUDP(in)
	if err != nil {
		t.Fatal(err)
	}
	if rules := decodeClashUDPRules(t, got); len(rules) != 4 || rules[1] != "AND,((NETWORK,udp),(RULE-SET,Netflix)),REJECT" || rules[2] != "GEOIP,CN,DIRECT" {
		t.Fatalf("late guard left a DIRECT fallthrough hole: %#v", rules)
	}
}

func TestGuardClashUDP_TemplateFormatting(t *testing.T) {
	in := strings.NewReplacer(
		"{{PROXIES}}", "", "proxies: [{{NODES}}]", "proxies: [REJECT]", ", {{NODES}}", "", "{{NODES}}", "",
		"{{CUSTOM_RULES}}", "", "{{CUSTOM_GROUPS}}", "", "{{CUSTOM_PROVIDERS}}", "", "{{CLASH_EXTRA}}", "",
	).Replace(templates.Clash)
	rules, err := domesticDNSRules(Intermediate{}, "clash")
	if err != nil {
		t.Fatal(err)
	}
	in = strings.ReplaceAll(in, "{{DOMESTIC_DNS_POLICY}}", domesticDNSClashPolicy(rules))
	got, err := guardClashUDP(in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "    - 'RULE-SET,Netflix,Netflix'\n    - 'AND,((NETWORK,udp),(RULE-SET,Netflix)),REJECT'\n") {
		t.Fatal("template's single-quoted rule formatting changed")
	}
	var original strings.Builder
	for _, line := range strings.SplitAfter(got, "\n") {
		if strings.HasPrefix(line, "    - 'AND,((NETWORK,udp),(") || strings.HasPrefix(line, "    - 'NETWORK,udp,REJECT'") {
			continue
		}
		original.WriteString(line)
	}
	if original.String() != in {
		t.Fatal("removing only inserted guards did not recover the exact template")
	}
	decodeClashUDPRules(t, got)
}

func TestGuardClashUDP_InvalidRules(t *testing.T) {
	cases := map[string]string{
		"mutable_negation":      "rules:\n  - 'AND,((NOT,((IP-CIDR,223.5.5.0/24,no-resolve))),(IP-CIDR,223.5.5.0/24)),Proxy'\n",
		"pass_group":            "proxy-groups:\n  - {name: Maybe, type: select, proxies: [PASS, Proxy]}\nrules:\n  - 'MATCH,Maybe'\n",
		"pass_adapter":          "proxies:\n  - {name: Passing, type: pass}\nrules:\n  - 'MATCH,Passing'\n",
		"invalid_yaml":          "rules: [\n",
		"empty_document":        "# nothing\n",
		"root_sequence":         "- 'MATCH,Proxy'\n",
		"multiple_documents":    "rules: []\n---\nrules: []\n",
		"duplicate_rules":       "rules: []\nrules: []\n",
		"missing":               "mode: rule\n",
		"null":                  "rules: null\n",
		"scalar_rules":          "rules: MATCH,Proxy\n",
		"mapping_rules":         "rules: {match: Proxy}\n",
		"flow_sequence":         "rules: ['MATCH,Proxy']\n",
		"integer":               "rules:\n  - 42\n",
		"boolean":               "rules:\n  - true\n",
		"null_item":             "rules:\n  - null\n",
		"mapping_item":          "rules:\n  - {MATCH: Proxy}\n",
		"sequence_item":         "rules:\n  - ['MATCH,Proxy']\n",
		"alias_sequence":        "other: &r ['MATCH,Proxy']\nrules: *r\n",
		"alias_item":            "other: &r 'MATCH,Proxy'\nrules:\n  - *r\n",
		"literal":               "rules:\n  - |-\n    MATCH,Proxy\n",
		"folded":                "rules:\n  - >-\n    MATCH,Proxy\n",
		"multiline_quoted":      "rules:\n  - 'DOMAIN,example.test,\n    Proxy'\n",
		"multiline_plain":       "rules:\n  - DOMAIN,example.test,\n    Proxy\n",
		"escaped_continuation":  "rules:\n  - \"DOMAIN,example.test,\\\n    Proxy\"\n",
		"escaped_newline":       "rules:\n  - \"DOMAIN,example.test,Proxy\\n\"\n",
		"empty_rule":            "rules:\n  - ''\n",
		"missing_policy":        "rules:\n  - 'DOMAIN,example.test'\n",
		"empty_policy":          "rules:\n  - 'DOMAIN,example.test,'\n",
		"empty_payload":         "rules:\n  - 'DOMAIN,,Proxy'\n",
		"extra_policy":          "rules:\n  - 'DOMAIN,example.test,Proxy,DIRECT'\n",
		"unknown_option":        "rules:\n  - 'IP-CIDR,198.51.100.0/24,Proxy,unknown'\n",
		"unsafe_parenthesis":    "rules:\n  - 'DOMAIN-REGEX,example),Proxy'\n",
		"match_extra_field":     "rules:\n  - 'MATCH,Others,no-resolve'\n",
		"unknown_matcher":       "rules:\n  - 'NOT-A-RULE,example.test,Proxy'\n",
		"sub_rule":              "rules:\n  - 'SUB-RULE,(NETWORK,udp),other-rules'\n",
		"logical_unbalanced":    "rules:\n  - 'AND,((DOMAIN,example.test),(DST-PORT,443),Proxy'\n",
		"logical_empty":         "rules:\n  - 'AND,(),Proxy'\n",
		"logical_policy_inside": "rules:\n  - 'AND,((DOMAIN,example.test,Proxy)),Proxy'\n",
		"logical_separator":     "rules:\n  - 'OR,((DOMAIN,a.test)(DOMAIN,b.test)),Proxy'\n",
		"logical_trailing":      "rules:\n  - 'OR,((DOMAIN,a.test),),Proxy'\n",
		"logical_not_multiple":  "rules:\n  - 'NOT,((DOMAIN,a.test),(DOMAIN,b.test)),Proxy'\n",
		"bare_carriage_return":  "rules:\r  - 'MATCH,Proxy'\r",
		"unicode_line_break":    "rules:\u2028  - 'MATCH,Proxy'\u2028",
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			got, err := guardClashUDP(in)
			if err == nil || got != "" {
				t.Fatalf("expected fail-closed error with no partial configuration, got %q, err %v", got, err)
			}
		})
	}
}

func decodeClashUDPRules(t *testing.T, conf string) []string {
	t.Helper()
	var doc struct {
		Rules []string `yaml:"rules"`
	}
	if err := yaml.Unmarshal([]byte(conf), &doc); err != nil {
		t.Fatalf("generated invalid YAML: %v\n%s", err, conf)
	}
	return doc.Rules
}
