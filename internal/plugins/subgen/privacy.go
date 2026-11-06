package subgen

import (
	"fmt"
	"net"
	"strings"
)

const (
	// IP-literal DoH URLs avoid a resolver-hostname bootstrap dependency.
	primaryDoH = "https://1.1.1.1/dns-query"
	backupDoH  = "https://8.8.8.8/dns-query"
	// Direct business lookups and proxy-entry bootstrap use domestic CDN answers.
	domesticDoH  = "https://223.5.5.5/dns-query"
	bootstrapDoH = domesticDoH
)

func validateRenderedConfig(body, target string) error {
	if strings.HasPrefix(body, "# Clash render error:") || strings.HasPrefix(body, "# General render error:") {
		first, _, _ := strings.Cut(body, "\n")
		return fmt.Errorf("subscription rendering failed: %s", strings.TrimPrefix(first, "# "))
	}
	if target == "clash" {
		if _, err := decodeClashMapping(body, false); err != nil {
			return fmt.Errorf("invalid rendered Clash configuration: %w", err)
		}
	}
	return nil
}

// surgeBootstrapHosts limits traditional DNS to proxy entry hostnames. Surge
// permits proxied encrypted DNS through domain nodes when they have a local
// mapping to a traditional resolver (Mac 5.6+); otherwise it can fall back to
// DIRECT to break the resolver/proxy cycle. Never map business-domain wildcards.
func surgeBootstrapHosts(nodes []Node) string {
	seen := make(map[string]bool)
	var lines []string
	add := func(host string) {
		host = strings.TrimSpace(host)
		if host == "" || net.ParseIP(strings.Trim(host, "[]")) != nil || strings.EqualFold(host, "localhost") {
			return
		}
		// Only exact DNS hostnames can be safely interpolated in [Host].
		if strings.ContainsAny(host, " \t\r\n=,*#;/:[]") || seen[strings.ToLower(host)] {
			return
		}
		seen[strings.ToLower(host)] = true
		lines = append(lines, host+" = server:223.5.5.5")
	}
	for _, n := range nodes {
		if n.SSH != nil {
			add(n.SSH.Host)
		} else {
			add(n.Server)
		}
	}
	return strings.Join(lines, "\n")
}
