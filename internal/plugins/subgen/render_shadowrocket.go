package subgen

import (
	"fmt"
	"regexp"
	"strings"
)

// ShadowRocket consumes the Surge .conf syntax, with three differences:
// WireGuard is an inline [Proxy] line (no [WireGuard] section), Surge-only
// DEVICE: (Ponte) members/rules are filtered out, and the group taxonomy is
// rewritten (see applyShadowrocketGroups): the "Proxy" group is removed in
// favor of ShadowRocket's built-in PROXY keyword — the record highlighted on
// the home page — and every select group defaults to its original first
// member via policy-select-name. Without this, the template's Surge-only
// `smart` group and mixed-case `Direct` policy are silently skipped and the
// home page has no working node selection.
type ShadowRocketRenderer struct{ SurgeRenderer }

func (*ShadowRocketRenderer) Target() string { return "shadowrocket" }

func (r *ShadowRocketRenderer) Render(im Intermediate, subURL, rulesetBase string) string {
	return r.render(im, subURL, rulesetBase, "shadowrocket")
}

// Shadowrocket uses DoH URLs in dns-server, with #proxy selecting the home-page
// node. An omitted/empty fallback means SYSTEM, so explicitly proxy both primary
// and backup resolvers. No global direct-dns-server is set: direct domains use
// the same private defaults; node hostnames have explicit bootstrap DNS. This is distinct from
// dns-direct-fallback-proxy (business routing on DNS failure).
var (
	reDNSServer = regexp.MustCompile(`(?m)^dns-server = .*$`)
	reDoHServer = regexp.MustCompile(`(?m)^#? ?(?:doh-server|encrypted-dns-server|encrypted-dns-follow-outbound-mode) = .*\n`)
)

func applyShadowrocketDNS(conf string) string {
	conf = replaceFirst(reDNSServer, conf, strings.Join([]string{
		"dns-server = " + primaryDoH + "#proxy," + backupDoH + "#proxy",
		"fallback-dns-server = " + backupDoH + "#proxy," + primaryDoH + "#proxy",
		"proxy-dns-server = " + bootstrapDoH,
		"dns-direct-system = false",
		"dns-direct-fallback-proxy = false",
	}, "\n"))
	return reDoHServer.ReplaceAllString(conf, "")
}

var (
	// Select-group lines in the oixCloud template, e.g.
	// "Netflix = select, Proxy, Direct, {{NODES}}". Rules never contain
	// " = select, ", and {{CUSTOM_GROUPS}} is a bare marker line, so this
	// only matches the template's own groups.
	reSelectGroupLine = regexp.MustCompile(`(?m)^([^\s=][^=\n]*?) = select, (.*)$`)
	reProxyGroupLine  = regexp.MustCompile(`(?m)^Proxy = select,.*\n?`)
	reSmartGroupLine  = regexp.MustCompile(`(?m)^Auto - Smart = smart,.*\n?`)
)

// oixCloud's Surge-style first member → the ShadowRocket policy keyword it
// means. The first member encodes the group's intended default, which the
// rewrite preserves via policy-select-name.
var shadowrocketDefaultByMember = map[string]string{
	"Direct": "DIRECT",
	"Proxy":  "PROXY",
	"Block":  "REJECT",
}

// applyShadowrocketGroups rewrites the oixCloud group taxonomy for
// ShadowRocket. Runs on the pre-substitution template text, so {{NODES}}
// stays a marker and flows through the normal expansion.
//
//   - The "Proxy" group is removed. PROXY is ShadowRocket's built-in keyword
//     for "the record currently highlighted on the home page", which is the
//     selection mechanism users expect; a select group by that name would
//     only be switchable from the groups page. Its one rule (Proxy.list) is
//     retargeted to the PROXY keyword so it follows the home-page pick.
//   - Every remaining select group becomes
//     `Name = select, <default>, <other policy>, {{NODES}}, policy-select-name=<default>`
//     where <default> is the group's CURRENT first member (Direct→DIRECT,
//     Proxy→PROXY, Block→REJECT), kept first so behavior is unchanged when
//     policy-select-name is ignored.
//   - "Auto - Smart" is dropped (`smart` is Surge-only). "Auto - UrlTest"
//     stays — url-test is a valid ShadowRocket group type.
func applyShadowrocketGroups(conf string) string {
	conf = reSmartGroupLine.ReplaceAllString(conf, "")
	conf = reProxyGroupLine.ReplaceAllString(conf, "")
	conf = strings.ReplaceAll(conf, ",Proxy,extended-matching", ",PROXY,extended-matching")
	return reSelectGroupLine.ReplaceAllStringFunc(conf, func(line string) string {
		m := reSelectGroupLine.FindStringSubmatch(line)
		name, members := m[1], m[2]
		first, _, _ := strings.Cut(members, ",")
		def, ok := shadowrocketDefaultByMember[strings.TrimSpace(first)]
		if !ok {
			return line // unknown shape — leave untouched
		}
		var core []string
		switch def {
		case "DIRECT":
			core = []string{"DIRECT", "PROXY"}
		case "PROXY":
			core = []string{"PROXY", "DIRECT"}
		default: // REJECT
			core = []string{"REJECT", "DIRECT", "PROXY"}
		}
		return fmt.Sprintf("%s = select, %s, {{NODES}}, policy-select-name=%s",
			name, strings.Join(core, ", "), def)
	})
}

func replaceFirst(re *regexp.Regexp, s, repl string) string {
	loc := re.FindStringIndex(s)
	if loc == nil {
		return s
	}
	return s[:loc[0]] + repl + s[loc[1]:]
}
