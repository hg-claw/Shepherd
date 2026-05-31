package subgen

import (
	"fmt"
	"strings"

	"github.com/hg-claw/Shepherd/internal/plugins/subgen/templates"
)

type SurgeRenderer struct{}

func (*SurgeRenderer) Target() string { return "surge" }

func (*SurgeRenderer) Supports(p string) bool {
	switch p {
	case "shadowsocks", "vmess", "trojan", "vless", "hysteria2", "tuic", "anytls", "wireguard":
		return true
	}
	return false
}

func (r *SurgeRenderer) proxyLine(n Node) string {
	var b strings.Builder
	switch n.Protocol {
	case "shadowsocks":
		fmt.Fprintf(&b, "%s = ss, %s, %d, encrypt-method=%s, password=%s", n.Name, n.Server, n.Port, n.SSMethod, n.Password)
	case "vmess":
		fmt.Fprintf(&b, "%s = vmess, %s, %d, username=%s, vmess-aead=true", n.Name, n.Server, n.Port, n.UUID)
		if n.SNI != "" {
			b.WriteString(", tls=true, sni=" + n.SNI)
			if n.Insecure {
				b.WriteString(", skip-cert-verify=true")
			}
		}
		if n.Transport == "ws" {
			b.WriteString(", ws=true, ws-path=" + n.Path)
			if n.Host != "" {
				b.WriteString(", ws-headers=Host:" + n.Host)
			}
		}
	case "trojan":
		fmt.Fprintf(&b, "%s = trojan, %s, %d, password=%s", n.Name, n.Server, n.Port, n.Password)
		if n.SNI != "" {
			b.WriteString(", sni=" + n.SNI)
		}
		if n.Insecure {
			b.WriteString(", skip-cert-verify=true")
		}
		if n.Transport == "ws" {
			b.WriteString(", ws=true, ws-path=" + n.Path)
			if n.Host != "" {
				b.WriteString(", ws-headers=Host:" + n.Host)
			}
		}
	case "vless":
		fmt.Fprintf(&b, "%s = vless, %s, %d, username=%s, tls=true", n.Name, n.Server, n.Port, n.UUID)
		if n.SNI != "" {
			b.WriteString(", sni=" + n.SNI)
		}
		if n.RealityPublicKey != "" {
			b.WriteString(", public-key=" + n.RealityPublicKey + ", short-id=" + n.RealityShortID)
		}
		if n.Insecure {
			b.WriteString(", skip-cert-verify=true")
		}
		if n.Flow != "" {
			b.WriteString(", flow=" + n.Flow)
		}
	case "hysteria2":
		fmt.Fprintf(&b, "%s = hysteria2, %s, %d, password=%s", n.Name, n.Server, n.Port, n.Password)
		if n.SNI != "" {
			b.WriteString(", sni=" + n.SNI)
		}
		if n.Insecure {
			b.WriteString(", skip-cert-verify=true")
		}
	case "tuic":
		fmt.Fprintf(&b, "%s = tuic, %s, %d, password=%s, uuid=%s", n.Name, n.Server, n.Port, n.Password, n.UUID)
		if n.SNI != "" {
			b.WriteString(", sni=" + n.SNI)
		}
		if n.Insecure {
			b.WriteString(", skip-cert-verify=true")
		}
		if cc, ok := n.Extra["congestion_control"].(string); ok && cc != "" {
			b.WriteString(", congestion-controller=" + cc)
		}
	case "anytls":
		fmt.Fprintf(&b, "%s = anytls, %s, %d, password=%s", n.Name, n.Server, n.Port, n.Password)
		if n.SNI != "" {
			b.WriteString(", sni=" + n.SNI)
		}
		if n.Insecure {
			b.WriteString(", skip-cert-verify=true")
		}
	}
	return b.String()
}

func (r *SurgeRenderer) Render(im Intermediate, subURL, rulesetBase string) string {
	return r.render(im, subURL, rulesetBase, "surge")
}

// render builds the Surge-family .conf for target "surge" or "shadowrocket" by
// filling the embedded oixCloud template with the user's nodes + custom logic.
// ShadowRocket gets inline WireGuard ([Proxy] line) and filters out Surge-only
// DEVICE: members/rules; Surge keeps them.
func (r *SurgeRenderer) render(im Intermediate, subURL, rulesetBase, target string) string {
	wgInline := target == "shadowrocket"
	filterDevice := target != "surge"

	var proxies, wg strings.Builder
	var names []string
	wgN := 0
	for _, n := range im.Nodes {
		if !r.Supports(n.Protocol) {
			continue
		}
		names = append(names, n.Name)
		if n.Protocol == "wireguard" {
			if wgInline {
				proxies.WriteString(shadowrocketWGLine(n) + "\n")
			} else {
				sec := fmt.Sprintf("wg%d", wgN)
				wgN++
				fmt.Fprintf(&proxies, "%s = wireguard, section-name=%s\n", n.Name, sec)
				wg.WriteString("\n" + surgeWGSection(n, sec))
			}
			continue
		}
		proxies.WriteString(r.proxyLine(n) + "\n")
	}
	nodeList := strings.Join(names, ", ")

	var crules strings.Builder
	for _, rule := range im.Rules {
		if filterDevice && strings.HasPrefix(rule.Target, "DEVICE:") {
			continue
		}
		crules.WriteString(surgeRuleLine(rule, rulesetBase) + "\n")
	}

	var cgroups strings.Builder
	for _, g := range im.Groups {
		if filterDevice {
			if g.Members = dropDevicePolicies(g.Members); len(g.Members) == 0 {
				continue
			}
		}
		cgroups.WriteString(r.groupLine(g) + "\n")
	}

	mitm := ""
	if m := strings.TrimSpace(im.MITM); m != "" {
		mitm = "[MITM]\n" + m + "\n"
	}

	out := filterSurgeGroups(templates.Surge, disabledServiceSet(im.DisabledGroups))
	if nodeList == "" {
		out = strings.ReplaceAll(out, ", {{NODES}}", "")
	}
	out = strings.ReplaceAll(out, "{{PROXIES}}", strings.TrimRight(proxies.String(), "\n"))
	out = strings.ReplaceAll(out, "{{WIREGUARD}}", strings.TrimRight(wg.String(), "\n"))
	out = strings.ReplaceAll(out, "{{NODES}}", nodeList)
	out = strings.ReplaceAll(out, "{{CUSTOM_RULES}}", strings.TrimRight(crules.String(), "\n"))
	out = strings.ReplaceAll(out, "{{CUSTOM_GROUPS}}", strings.TrimRight(cgroups.String(), "\n"))
	out = strings.ReplaceAll(out, "{{GENERAL_EXTRA}}", strings.TrimSpace(im.General))
	out = strings.ReplaceAll(out, "{{URLREWRITE_EXTRA}}", strings.TrimSpace(im.URLRewrite))
	out = strings.ReplaceAll(out, "{{MITM}}", mitm)
	return fmt.Sprintf("#!MANAGED-CONFIG %s interval=43200 strict=false\n", subURL) + out
}

// surgeWGSection renders a Surge [WireGuard <sec>] block. reserved has no Surge
// field and is dropped.
func surgeWGSection(n Node, sec string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[WireGuard %s]\n", sec)
	fmt.Fprintf(&b, "private-key = %s\n", wgField(n, "private_key"))
	if ip := wgField(n, "ip"); ip != "" {
		fmt.Fprintf(&b, "self-ip = %s\n", ip)
	}
	// Fixed operational defaults for Surge WireGuard.
	b.WriteString("dns-server = 8.8.8.8, 114.114.114.114\n")
	b.WriteString("mtu = 1420\n")
	fmt.Fprintf(&b, `peer = (public-key = %s, allowed-ips = "0.0.0.0/0, ::/0", endpoint = %s:%d`, wgField(n, "public_key"), n.Server, n.Port)
	if psk := wgField(n, "preshared_key"); psk != "" {
		b.WriteString(", preshared-key = " + psk)
	}
	b.WriteString(", keepalive = 5)\n")
	return b.String()
}

// shadowrocketWGLine renders a ShadowRocket inline [Proxy] WireGuard line.
func shadowrocketWGLine(n Node) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s = wireguard, %s, %d, privateKey=%s, publicKey=%s", n.Name, n.Server, n.Port, wgField(n, "private_key"), wgField(n, "public_key"))
	if ip := wgField(n, "ip"); ip != "" {
		b.WriteString(", ip=" + ip)
	}
	b.WriteString(", udp=1")
	if psk := wgField(n, "preshared_key"); psk != "" {
		b.WriteString(", presharedKey=" + psk)
	}
	if mtu, ok := n.Extra["mtu"].(int); ok && mtu > 0 {
		fmt.Fprintf(&b, ", mtu=%d", mtu)
	}
	if res := wgField(n, "reserved"); res != "" {
		b.WriteString(", reserved=" + strings.ReplaceAll(res, ",", "/"))
	}
	return b.String()
}

func (r *SurgeRenderer) groupLine(g Group) string {
	if g.Type == "url-test" {
		return fmt.Sprintf("%s = url-test, %s, url=http://www.gstatic.com/generate_204, interval=300", g.Name, strings.Join(g.Members, ", "))
	}
	// Auto-generated select groups carry DIRECT as the conventional fallback;
	// user-defined (Verbatim) groups render their members exactly.
	members := g.Members
	if !g.Verbatim {
		hasDirect := false
		for _, m := range members {
			if m == "DIRECT" {
				hasDirect = true
				break
			}
		}
		if !hasDirect {
			members = append(append([]string{}, members...), "DIRECT")
		}
	}
	return fmt.Sprintf("%s = select, %s", g.Name, strings.Join(members, ", "))
}

// surgeRuleLine formats one semantic Rule as a Surge [Rule] line.
func surgeRuleLine(r Rule, rulesetBase string) string {
	switch {
	case r.Final:
		return "FINAL," + r.Target
	case r.Ruleset != "":
		return "RULE-SET," + rulesetURL(r.Ruleset, "surge", rulesetBase) + "," + r.Target
	case r.Native != "":
		return r.Native + "," + r.Target
	default:
		return r.Match + "," + r.Target
	}
}

// filterSurgeGroups removes the [Proxy Group] lines and [Rule] lines belonging to
// any disabled service group, leaving all other sections untouched. The link is
// the group name: a proxy-group line is "<Name> = ..."; a rule routes to the
// field before ",extended-matching" (RULE-SET) or its last comma field. An empty
// disabled set returns the template unchanged.
func filterSurgeGroups(tmpl string, disabled map[string]bool) string {
	if len(disabled) == 0 {
		return tmpl
	}
	lines := strings.Split(tmpl, "\n")
	out := make([]string, 0, len(lines))
	section := ""
	for _, line := range lines {
		if strings.HasPrefix(line, "[") && strings.HasSuffix(strings.TrimRight(line, " "), "]") {
			section = strings.TrimSpace(line)
		}
		switch section {
		case "[Proxy Group]":
			if name, ok := surgeGroupName(line); ok && disabled[name] {
				continue
			}
		case "[Rule]":
			if disabled[surgeRuleTarget(line)] {
				continue
			}
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// surgeGroupName returns the left-hand name of a "<Name> = ..." proxy-group line.
func surgeGroupName(line string) (string, bool) {
	i := strings.Index(line, " = ")
	if i <= 0 {
		return "", false
	}
	return strings.TrimSpace(line[:i]), true
}

// surgeRuleTarget returns the policy/group a Surge [Rule] line routes to, or ""
// for blank/marker lines.
func surgeRuleTarget(line string) string {
	fields := strings.Split(line, ",")
	if len(fields) < 2 {
		return ""
	}
	t := strings.TrimSpace(fields[len(fields)-1])
	if t == "extended-matching" {
		t = strings.TrimSpace(fields[len(fields)-2])
	}
	return t
}
