package subgen

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/hg-claw/Shepherd/internal/plugins/subgen/templates"
	"gopkg.in/yaml.v3"
)

type ClashRenderer struct{}

func (*ClashRenderer) Target() string { return "clash" }

func (*ClashRenderer) Supports(p string) bool {
	switch p {
	case "shadowsocks", "vmess", "trojan", "vless", "hysteria2", "tuic", "anytls", "wireguard":
		return true
	}
	return false
}

// Render fills the embedded fixed oixCloud Clash template (templates.Clash) by
// TEXT substitution, preserving the file's exact formatting and comments. subURL
// and rulesetBase are unused — the template hard-codes the dler.io rule-providers.
// Only the user's custom nodes/groups/rules feed the {{...}} markers.
func (r *ClashRenderer) Render(im Intermediate, _ string, _ string) string {
	// {{PROXIES}}: each node as a 4-space-indented YAML block-style list item.
	var proxies strings.Builder
	var names []string
	for _, n := range im.Nodes {
		px := clashProxy(n)
		if px == nil {
			continue
		}
		names = append(names, n.Name)
		b, err := yaml.Marshal([]map[string]any{px})
		if err != nil {
			continue
		}
		for _, line := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
			proxies.WriteString("    " + line + "\n")
		}
	}

	// {{NODES}}: node names as a YAML inline-seq fragment (single-quoted).
	quoted := make([]string, 0, len(names))
	for _, nm := range names {
		quoted = append(quoted, "'"+strings.ReplaceAll(nm, "'", "''")+"'")
	}
	nodeList := strings.Join(quoted, ", ")

	// {{CUSTOM_RULES}} + {{CUSTOM_PROVIDERS}}: custom rules; DOMAIN-SET → provider.
	// im.Rules carries only the user's custom rules (Match/Target); the fixed
	// template owns the dler.io rule-sets and the catch-all, so Ruleset/Native/
	// Final on a Rule are not reachable here. Providers are emitted in first-seen
	// rule order (a map only de-dupes) so the output is deterministic.
	seen := map[string]bool{}
	var crules, cproviders strings.Builder
	for _, rl := range im.Rules {
		if strings.HasPrefix(rl.Target, "DEVICE:") {
			continue
		}
		if u, ok := domainSetURL(rl.Match); ok {
			url := clashDomainSetURL(u)
			name := domainSetName(url)
			if !seen[name] {
				seen[name] = true
				format := "yaml"
				if !strings.HasSuffix(url, ".yaml") && !strings.HasSuffix(url, ".yml") {
					format = "text"
				}
				fmt.Fprintf(&cproviders, "    %s: { type: http, behavior: domain, format: %s, url: '%s', path: ./ruleset/%s, interval: 86400 }\n",
					name, format, url, name)
			}
			crules.WriteString("    - 'RULE-SET," + name + "," + rl.Target + "'\n")
		} else {
			crules.WriteString("    - '" + rl.Match + "," + rl.Target + "'\n")
		}
	}

	// {{CUSTOM_GROUPS}}: custom groups as proxy-group list items.
	var cgroups strings.Builder
	for _, g := range im.Groups {
		members := dropDevicePolicies(g.Members)
		if len(members) == 0 {
			continue
		}
		q := make([]string, 0, len(members))
		for _, m := range members {
			q = append(q, "'"+strings.ReplaceAll(m, "'", "''")+"'")
		}
		extra := ""
		if g.Type == "url-test" {
			extra = ", url: 'http://www.gstatic.com/generate_204', interval: 300"
		}
		fmt.Fprintf(&cgroups, "    - { name: '%s', type: %s, proxies: [%s]%s }\n",
			strings.ReplaceAll(g.Name, "'", "''"), g.Type, strings.Join(q, ", "), extra)
	}

	out := filterClashGroups(templates.Clash, disabledServiceSet(im.DisabledGroups))
	out = strings.ReplaceAll(out, "{{PROXIES}}", strings.TrimRight(proxies.String(), "\n"))
	if nodeList == "" {
		out = strings.ReplaceAll(out, ", {{NODES}}", "")
		out = strings.ReplaceAll(out, "{{NODES}}", "")
	} else {
		out = strings.ReplaceAll(out, "{{NODES}}", nodeList)
	}
	out = strings.ReplaceAll(out, "{{CUSTOM_RULES}}", strings.TrimRight(crules.String(), "\n"))
	out = strings.ReplaceAll(out, "{{CUSTOM_GROUPS}}", strings.TrimRight(cgroups.String(), "\n"))
	out = strings.ReplaceAll(out, "{{CUSTOM_PROVIDERS}}", strings.TrimRight(cproviders.String(), "\n"))
	out = strings.ReplaceAll(out, "{{CLASH_EXTRA}}", strings.TrimSpace(im.ClashGeneral))
	return out
}

// filterClashGroups removes the proxy-group, rule, and rule-provider entries of
// any disabled service group from the fixed Clash template while keeping it valid
// YAML. A rule-provider is dropped only if it was referenced before filtering AND
// is no longer referenced after — so an empty disabled set returns the template
// byte-for-byte unchanged, and providers never referenced by a rule are left
// alone. proxy-groups precede rules precede rule-providers in the template, so a
// single forward pass has the full surviving-reference set ready by the time the
// rule-providers block is reached.
func filterClashGroups(tmpl string, disabled map[string]bool) string {
	if len(disabled) == 0 {
		return tmpl
	}
	lines := strings.Split(tmpl, "\n")

	// References that exist before any filtering (RULE-SET,<provider>,<group>).
	refBefore := map[string]bool{}
	for _, line := range lines {
		if p, _, ok := clashRuleRef(line); ok {
			refBefore[p] = true
		}
	}

	out := make([]string, 0, len(lines))
	refAfter := map[string]bool{}
	section := ""
	for _, line := range lines {
		if h, ok := clashTopKey(line); ok {
			section = h
			out = append(out, line)
			continue
		}
		switch section {
		case "proxy-groups":
			if name, ok := clashGroupName(line); ok && disabled[name] {
				continue
			}
		case "rules":
			if p, g, ok := clashRuleRef(line); ok {
				if disabled[g] {
					continue
				}
				refAfter[p] = true
			} else if g, ok := clashRuleTarget(line); ok && disabled[g] {
				continue
			}
		case "rule-providers":
			if key, ok := clashProviderKey(line); ok && refBefore[key] && !refAfter[key] {
				continue
			}
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// clashTopKey reports whether line is a top-level (column-0) YAML key, and
// returns the key name (without trailing ":") so the caller can track sections.
// Marker lines like {{CUSTOM_RULES}} are NOT treated as section headers (they
// live inside a section and must not reset it). Any other column-0 non-comment
// line does reset the section.
func clashTopKey(line string) (string, bool) {
	if line == "" || line[0] == ' ' || line[0] == '\t' || line[0] == '#' {
		return "", false
	}
	// {{...}} markers are inside sections; don't treat them as section resets.
	if strings.HasPrefix(line, "{{") {
		return "", false
	}
	if i := strings.Index(line, ":"); i > 0 {
		return line[:i], true
	}
	return "_", true // unexpected column-0 line — still resets section
}

// clashGroupName extracts the name of a "- { name: <G>, ... }" proxy-group item.
func clashGroupName(line string) (string, bool) {
	t := strings.TrimSpace(line)
	if !strings.HasPrefix(t, "- {") {
		return "", false
	}
	i := strings.Index(t, "name:")
	if i < 0 {
		return "", false
	}
	rest := t[i+len("name:"):]
	if j := strings.Index(rest, ","); j >= 0 {
		rest = rest[:j]
	}
	return strings.Trim(strings.TrimSpace(rest), "'"), true
}

// clashRuleBody returns the unquoted payload of a "    - '<payload>'" rule item,
// or ("", false) for non-rule lines (blank, marker, section header).
func clashRuleBody(line string) (string, bool) {
	t := strings.TrimSpace(line)
	if !strings.HasPrefix(t, "- ") {
		return "", false
	}
	t = strings.Trim(strings.TrimSpace(strings.TrimPrefix(t, "- ")), "'")
	if t == "" || strings.HasPrefix(t, "{{") {
		return "", false
	}
	return t, true
}

// clashRuleRef returns (provider, group, true) for a "RULE-SET,<provider>,<group>"
// rule, else ("", "", false).
func clashRuleRef(line string) (provider, group string, ok bool) {
	body, ok := clashRuleBody(line)
	if !ok {
		return "", "", false
	}
	fields := strings.Split(body, ",")
	if len(fields) >= 3 && strings.EqualFold(strings.TrimSpace(fields[0]), "RULE-SET") {
		return strings.TrimSpace(fields[1]), strings.TrimSpace(fields[len(fields)-1]), true
	}
	return "", "", false
}

// clashRuleTarget returns the policy a non-RULE-SET rule routes to (last field).
func clashRuleTarget(line string) (string, bool) {
	body, ok := clashRuleBody(line)
	if !ok {
		return "", false
	}
	fields := strings.Split(body, ",")
	if len(fields) < 2 {
		return "", false
	}
	return strings.TrimSpace(fields[len(fields)-1]), true
}

// clashProviderKey returns the YAML key of a "    <Key>: { ... }" rule-provider
// line, unquoting it; ("", false) for markers/comments/blank lines.
func clashProviderKey(line string) (string, bool) {
	t := strings.TrimSpace(line)
	if t == "" || strings.HasPrefix(t, "{{") || strings.HasPrefix(t, "#") {
		return "", false
	}
	i := strings.Index(t, ":")
	if i <= 0 {
		return "", false
	}
	return strings.Trim(strings.TrimSpace(t[:i]), "'"), true
}

// domainSetURL returns the list URL of a "DOMAIN-SET,<url>" custom rule, or
// ("", false) for any other custom rule. Case-insensitive on the directive.
func domainSetURL(match string) (string, bool) {
	m := strings.TrimSpace(match)
	const p = "DOMAIN-SET,"
	if len(m) < len(p) || !strings.EqualFold(m[:len(p)], p) {
		return "", false
	}
	url := strings.TrimSpace(m[len(p):])
	if url == "" {
		return "", false
	}
	return url, true
}

// clashDomainSetURL rewrites a Surge/ShadowRocket DOMAIN-SET list URL to its
// Clash equivalent (best-effort): blackmatrix7 ships the Clash variant under
// rule/Clash/<...>_Domain.yaml. A URL without the /rule/Shadowrocket/ segment is
// left unchanged (the operator owns non-blackmatrix7 URLs).
func clashDomainSetURL(u string) string {
	u = strings.Replace(u, "/rule/Shadowrocket/", "/rule/Clash/", 1)
	if strings.HasSuffix(u, ".list") {
		u = strings.TrimSuffix(u, ".list") + ".yaml"
	}
	return u
}

// domainSetName derives a rule-provider name from a list URL: the last path
// segment without extension, sanitized to [A-Za-z0-9_-].
func domainSetName(u string) string {
	seg := u
	if i := strings.LastIndex(seg, "/"); i >= 0 {
		seg = seg[i+1:]
	}
	if i := strings.LastIndex(seg, "."); i >= 0 {
		seg = seg[:i]
	}
	var b strings.Builder
	for _, r := range seg {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteRune('_')
		}
	}
	name := b.String()
	if name == "" {
		name = "domainset"
	}
	return name
}

// clashProxy maps a Node to a mihomo proxy map, or nil if unsupported.
func clashProxy(n Node) map[string]any {
	p := map[string]any{"name": n.Name, "server": n.Server, "port": n.Port}
	switch n.Protocol {
	case "shadowsocks":
		p["type"] = "ss"
		p["cipher"] = n.SSMethod
		p["password"] = n.Password
	case "vmess":
		p["type"] = "vmess"
		p["uuid"] = n.UUID
		p["alterId"] = 0
		p["cipher"] = "auto"
		if n.SNI != "" {
			p["tls"] = true
			p["servername"] = n.SNI
			if n.Insecure {
				p["skip-cert-verify"] = true
			}
		}
		if n.Transport == "ws" {
			p["network"] = "ws"
			p["ws-opts"] = clashWSOpts(n)
		}
	case "trojan":
		p["type"] = "trojan"
		p["password"] = n.Password
		if n.SNI != "" {
			p["sni"] = n.SNI
		}
		if n.Insecure {
			p["skip-cert-verify"] = true
		}
		if n.Transport == "ws" {
			p["network"] = "ws"
			p["ws-opts"] = clashWSOpts(n)
		}
	case "vless":
		p["type"] = "vless"
		p["uuid"] = n.UUID
		p["tls"] = true
		if n.SNI != "" {
			p["servername"] = n.SNI
		}
		if n.Flow != "" {
			p["flow"] = n.Flow
		}
		if n.RealityPublicKey != "" {
			p["reality-opts"] = map[string]any{"public-key": n.RealityPublicKey, "short-id": n.RealityShortID}
			p["client-fingerprint"] = "chrome"
		}
		if n.Insecure {
			p["skip-cert-verify"] = true
		}
		if n.Transport == "ws" {
			p["network"] = "ws"
			p["ws-opts"] = clashWSOpts(n)
		}
	case "hysteria2":
		p["type"] = "hysteria2"
		p["password"] = n.Password
		if n.SNI != "" {
			p["sni"] = n.SNI
		}
		if n.Insecure {
			p["skip-cert-verify"] = true
		}
	case "tuic":
		p["type"] = "tuic"
		p["uuid"] = n.UUID
		p["password"] = n.Password
		if n.SNI != "" {
			p["sni"] = n.SNI
		}
		if n.Insecure {
			p["skip-cert-verify"] = true
		}
		if cc, ok := n.Extra["congestion_control"].(string); ok && cc != "" {
			p["congestion-controller"] = cc
		}
	case "anytls":
		p["type"] = "anytls"
		p["password"] = n.Password
		if n.SNI != "" {
			p["sni"] = n.SNI
		}
		if n.Insecure {
			p["skip-cert-verify"] = true
		}
	case "wireguard":
		p["type"] = "wireguard"
		p["private-key"] = wgField(n, "private_key")
		p["public-key"] = wgField(n, "public_key")
		if psk := wgField(n, "preshared_key"); psk != "" {
			p["pre-shared-key"] = psk
		}
		if ip := wgField(n, "ip"); ip != "" {
			p["ip"] = wgIPCIDR(ip)
		}
		p["allowed-ips"] = []string{"0.0.0.0/0", "::/0"}
		if res := wgReserved(wgField(n, "reserved")); res != nil {
			p["reserved"] = res
		}
		if mtu, ok := n.Extra["mtu"].(int); ok && mtu > 0 {
			p["mtu"] = mtu
		}
		p["udp"] = true
	default:
		return nil
	}
	return p
}

func clashWSOpts(n Node) map[string]any {
	o := map[string]any{"path": n.Path}
	if n.Host != "" {
		o["headers"] = map[string]any{"Host": n.Host}
	}
	return o
}

// wgField reads a WireGuard string field from Node.Extra.
func wgField(n Node, key string) string {
	s, _ := n.Extra[key].(string)
	return s
}

// wgIPCIDR ensures the WireGuard self-ip has a CIDR mask (mihomo expects one).
func wgIPCIDR(ip string) string {
	if strings.Contains(ip, "/") {
		return ip
	}
	return ip + "/32"
}

// wgReserved parses a "a,b,c" reserved string into a 3-element []int, or nil.
func wgReserved(s string) []int {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	if len(parts) != 3 {
		return nil
	}
	out := make([]int, 0, 3)
	for _, p := range parts {
		v, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			return nil
		}
		out = append(out, v)
	}
	return out
}
