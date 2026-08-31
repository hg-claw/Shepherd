package subgen

import (
	"regexp"
	"strings"
)

// ShadowRocket consumes the Surge .conf syntax, with two differences: WireGuard
// is an inline [Proxy] line (no [WireGuard] section), and Surge-only DEVICE:
// (Ponte) members/rules are filtered out. It embeds SurgeRenderer and overrides
// only Target() and Render() (passing target="shadowrocket", which selects both).
type ShadowRocketRenderer struct{ SurgeRenderer }

func (*ShadowRocketRenderer) Target() string { return "shadowrocket" }

func (r *ShadowRocketRenderer) Render(im Intermediate, subURL, rulesetBase string) string {
	return r.render(im, subURL, rulesetBase, "shadowrocket")
}

// Shadowrocket ignores Surge's `doh-server` key and honors https:// URLs in
// `dns-server`. The shared oix template is Surge-shaped (`dns-server = system,…`
// plus a commented doh-server), which on Shadowrocket means ISP UDP/53 —
// GFW-injected answers then match GEOIP,CN and go DIRECT. Rewrite only the
// shadowrocket target: DoH primary, no system resolver, hijack CN-app DNS.
var (
	reDNSServer = regexp.MustCompile(`(?m)^dns-server = .*$`)
	reDoHServer = regexp.MustCompile(`(?m)^#? ?doh-server = .*\n`)
	reHijackDNS = regexp.MustCompile(`(?m)^hijack-dns = .*$`)
)

func applyShadowrocketDNS(conf string) string {
	conf = replaceFirst(reDNSServer, conf, strings.Join([]string{
		"dns-server = https://doh.pub/dns-query,https://dns.alidns.com/dns-query",
		"fallback-dns-server = 223.5.5.5,119.29.29.29",
		"dns-direct-system = false",
		"dns-direct-fallback-proxy = true",
	}, "\n"))
	conf = reDoHServer.ReplaceAllString(conf, "")
	return replaceFirst(reHijackDNS, conf, "hijack-dns = 8.8.8.8:53,8.8.4.4:53,1.1.1.1:53,1.0.0.1:53,9.9.9.9:53,114.114.114.114:53,114.114.115.115:53,223.5.5.5:53,223.6.6.6:53,119.29.29.29:53,119.28.28.28:53,180.76.76.76:53")
}

func replaceFirst(re *regexp.Regexp, s, repl string) string {
	loc := re.FindStringIndex(s)
	if loc == nil {
		return s
	}
	return s[:loc[0]] + repl + s[loc[1]:]
}
