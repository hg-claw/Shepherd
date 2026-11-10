package subgen

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"sort"
	"strings"

	"golang.org/x/net/publicsuffix"
)

//go:embed templates/domestic_dns.json
var domesticDNSSnapshot []byte

//go:embed templates/domestic_dns_seeds.list
var domesticDNSSeeds []byte

type domesticDNSRule struct {
	Kind   string `json:"kind"`
	Domain string `json:"domain"`
}

type domesticDNSData struct {
	Revision    string            `json:"revision"`
	SeedsSHA256 string            `json:"seeds_sha256"`
	Sources     []domesticSource  `json:"sources"`
	Rules       []domesticDNSRule `json:"rules"`
}

type domesticSource struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

func validDNSDomain(domain string) bool {
	if domain != strings.ToLower(domain) || len(domain) > 253 || net.ParseIP(domain) != nil || !strings.Contains(domain, ".") {
		return false
	}
	for _, label := range strings.Split(domain, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, r := range label {
			switch {
			case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
				continue
			default:
				return false
			}
		}
	}
	// Private suffixes such as sinaapp.com must be rejected too, not just
	// ICANN TLDs. A routing list is not permission to query all their tenants.
	suffix, _ := publicsuffix.PublicSuffix(domain)
	return suffix != domain
}

func decodeDomesticDNS(data []byte) ([]domesticDNSRule, error) {
	var snapshot domesticDNSData
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return nil, fmt.Errorf("invalid domestic DNS snapshot: %w", err)
	}
	if len(snapshot.Revision) != 40 || len(snapshot.Rules) == 0 || len(snapshot.Sources) == 0 {
		return nil, fmt.Errorf("domestic DNS snapshot lacks revision, sources or rules")
	}
	if _, err := hex.DecodeString(snapshot.Revision); err != nil {
		return nil, fmt.Errorf("invalid domestic DNS source revision")
	}
	seenSources := make(map[string]bool)
	for _, source := range snapshot.Sources {
		decoded, err := hex.DecodeString(source.SHA256)
		if source.Path == "" || seenSources[source.Path] || err != nil || len(decoded) != sha256.Size {
			return nil, fmt.Errorf("invalid domestic DNS source metadata")
		}
		seenSources[source.Path] = true
	}
	if !seenSources["Surge/Surge 3/Provider/Domestic.list"] || !seenSources["Clash/Provider/Domestic.yaml"] {
		return nil, fmt.Errorf("domestic DNS snapshot must reference both source formats")
	}
	seedHash := sha256.Sum256(domesticDNSSeeds)
	if snapshot.SeedsSHA256 != hex.EncodeToString(seedHash[:]) {
		return nil, fmt.Errorf("domestic DNS seeds changed without snapshot regeneration")
	}
	seeds := make(map[domesticDNSRule]bool)
	for _, line := range strings.Split(string(domesticDNSSeeds), "\n") {
		if strings.HasPrefix(line, "#") || strings.TrimSpace(line) == "" {
			continue
		}
		kind, domain, ok := strings.Cut(line, ",")
		if !ok || !validDNSDomain(domain) || (kind != "DOMAIN" && kind != "DOMAIN-SUFFIX") {
			return nil, fmt.Errorf("invalid reviewed DNS seed")
		}
		seeds[domesticDNSRule{Kind: kind, Domain: domain}] = true
	}
	seen := make(map[domesticDNSRule]bool)
	for _, rule := range snapshot.Rules {
		if !seeds[rule] || seen[rule] || !validDNSDomain(rule.Domain) {
			return nil, fmt.Errorf("unreviewed, duplicate or unsafe domestic DNS rule")
		}
		seen[rule] = true
	}
	return append([]domesticDNSRule(nil), snapshot.Rules...), nil
}

func dnsRuleOverlap(a, b domesticDNSRule) bool {
	return a.Domain == b.Domain ||
		(a.Kind == "DOMAIN-SUFFIX" && strings.HasSuffix(b.Domain, "."+a.Domain)) ||
		(b.Kind == "DOMAIN-SUFFIX" && strings.HasSuffix(a.Domain, "."+b.Domain))
}

// domesticDNSRules is intentionally a small static privacy exception, not a
// second routing engine. Custom proxy conditions we cannot map to domain scopes
// disable all exceptions; exact/suffix custom conditions only subtract scopes.
// Explicit DIRECT rules never enlarge the reviewed snapshot. Client-side group
// choices cannot be observed by a generated subscription, and are documented.
func domesticDNSRules(im Intermediate, target string) ([]domesticDNSRule, error) {
	if !validDNSMode(im.DNSMode) {
		return nil, fmt.Errorf("unknown DNS mode")
	}
	if ruleAwareDNS(im) {
		// Native direct/remote resolution, not a global static DNS scope.
		return nil, nil
	}
	rules, err := decodeDomesticDNS(domesticDNSSnapshot)
	if err != nil {
		return nil, err
	}
	for _, rule := range im.Rules {
		if !safeRuleText(rule.Match) || !validPolicy(rule.Target) {
			return nil, fmt.Errorf("unsafe custom rule for DNS scope")
		}
	}
	for _, group := range im.Groups {
		if !validPolicy(group.Name) {
			return nil, fmt.Errorf("unsafe custom group for DNS scope")
		}
		for _, member := range group.Members {
			if !safeRuleText(member) {
				return nil, fmt.Errorf("unsafe custom group member for DNS scope")
			}
		}
	}
	if target == "shadowrocket" {
		// Host DoH routing is not sufficiently documented/verified for SR.
		return nil, nil
	}
	// Custom groups and raw sections may change named policy semantics or
	// add sections after the base template. Do not infer a domestic DNS scope.
	if len(im.Groups) > 0 || strings.TrimSpace(im.MITM) != "" || strings.TrimSpace(im.URLRewrite) != "" {
		return nil, nil
	}
	if target == "clash" {
		override, err := decodeClashMapping(im.ClashGeneral, true)
		if err != nil {
			return nil, err
		}
		for _, key := range []string{"rules", "rule-providers", "proxy-groups"} {
			if _, changed := override[key]; changed {
				return nil, nil
			}
		}
	}
	var exclude []domesticDNSRule
	for _, rule := range im.Rules {
		kind, domain, ok := strings.Cut(rule.Match, ",")
		kind, domain = strings.TrimSpace(kind), strings.ToLower(strings.TrimSpace(domain))
		if !ok || (kind != "DOMAIN" && kind != "DOMAIN-SUFFIX") || !validDNSDomain(domain) || rule.Final || rule.Native != "" || rule.Ruleset != "" {
			return nil, nil
		}
		if rule.Target != "DIRECT" && rule.Target != "Direct" {
			exclude = append(exclude, domesticDNSRule{Kind: kind, Domain: domain})
		}
	}
	// Keep exact proxy bootstrap records independent of business exceptions.
	for _, node := range im.Nodes {
		host := node.Server
		if node.SSH != nil {
			host = node.SSH.Host
		}
		if validDNSDomain(strings.ToLower(host)) {
			exclude = append(exclude, domesticDNSRule{Kind: "DOMAIN", Domain: strings.ToLower(host)})
		}
	}
	var out []domesticDNSRule
	for _, candidate := range rules {
		blocked := false
		for _, other := range exclude {
			if dnsRuleOverlap(candidate, other) {
				blocked = true
				break
			}
		}
		if !blocked {
			out = append(out, candidate)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Domain < out[j].Domain })
	return out, nil
}

func domesticDNSHosts(rules []domesticDNSRule) string {
	var out strings.Builder
	for _, rule := range rules {
		fmt.Fprintf(&out, "%s = server:%s\n", rule.Domain, domesticDoH)
		if rule.Kind == "DOMAIN-SUFFIX" {
			fmt.Fprintf(&out, "*.%s = server:%s\n", rule.Domain, domesticDoH)
		}
	}
	return strings.TrimSuffix(out.String(), "\n")
}

func domesticDNSClashPolicy(rules []domesticDNSRule) string {
	if len(rules) == 0 {
		return ""
	}
	var out strings.Builder
	out.WriteString("    nameserver-policy:\n")
	for _, rule := range rules {
		key := rule.Domain
		if rule.Kind == "DOMAIN-SUFFIX" {
			key = "+." + key
		}
		fmt.Fprintf(&out, "        '%s': ['%s#DIRECT']\n", key, domesticDoH)
	}
	return strings.TrimSuffix(out.String(), "\n")
}
