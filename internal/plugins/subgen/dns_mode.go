package subgen

import (
	"fmt"
	"strings"
)

const (
	DNSModePrivate   = "private"
	DNSModeRuleAware = "rule-aware"
)

func validDNSMode(mode string) bool {
	return mode == "" || mode == DNSModePrivate || mode == DNSModeRuleAware
}

func ruleAwareDNS(im Intermediate) bool { return im.DNSMode == DNSModeRuleAware }

// Surge has no verified final-DIRECT resolver hook. Its opt-in rule-aware mode
// instead evaluates domain/process rules without doing IP-rule DNS lookups.
// Literal IP requests still match IP rules. This deliberately changes domain
// GEOIP fallback and cannot hide application-initiated DNS queries.
func surgeDomainFirstRules(conf string) (string, error) {
	section := ""
	lines := strings.Split(conf, "\n")
	for i, line := range lines {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "[") && strings.HasSuffix(trim, "]") {
			section = trim
		}
		if section != "[Rule]" || trim == "" || strings.HasPrefix(trim, "#") || strings.HasPrefix(trim, "[") {
			continue
		}
		kind, _, ok := strings.Cut(trim, ",")
		if !ok {
			return "", fmt.Errorf("domain-first mode requires a supported single-line rule")
		}
		switch kind {
		case "RULE-SET", "IP-CIDR", "IP-CIDR6", "IP-ASN", "GEOIP":
			if !containsRuleOption(trim, "no-resolve") {
				lines[i] = line + ",no-resolve"
			}
		case "DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-SET",
			"PROCESS-NAME", "PROCESS-PATH", "USER-AGENT", "URL-REGEX",
			"DEST-PORT", "SRC-PORT", "SRC-IP", "SRC-IP-CIDR", "PROTOCOL", "IN-PORT", "FINAL":
			// These match without resolving the target domain.
		default:
			return "", fmt.Errorf("domain-first mode cannot guarantee lookup behavior for rule type %q", kind)
		}
	}
	return strings.Join(lines, "\n"), nil
}

func containsRuleOption(line, option string) bool {
	fields := strings.Split(line, ",")
	if len(fields) < 4 {
		return false
	}
	// Kind, payload and policy are not optional parameters. In particular a
	// user group named no-resolve must not suppress the real option.
	for _, field := range fields[3:] {
		if strings.TrimSpace(field) == option {
			return true
		}
	}
	return false
}

func applyRuleAwareSurgeDNS(conf string) (string, error) {
	// Restrict always-real-ip to LAN patterns. Broad public patterns would send
	// domains to local DNS before domain/process rule selection can happen.
	defaults := "encrypted-dns-server = " + domesticDoH + "\n" +
		"encrypted-dns-follow-outbound-mode = false\n" +
		"use-local-host-item-for-proxy = false\n" +
		"always-real-ip = *.lan, *.local"
	conf, err := mergeGeneral(conf, defaults)
	if err != nil {
		return "", err
	}
	return surgeDomainFirstRules(conf)
}

func ruleAwareClashGeneral() string {
	return "dns:\n  direct-nameserver: ['" + domesticDoH + "#DIRECT']\n  direct-nameserver-follow-policy: false"
}
