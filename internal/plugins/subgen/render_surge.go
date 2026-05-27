package subgen

import (
	"fmt"
	"strings"
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
	case "tuic":
		fmt.Fprintf(&b, "%s = tuic, %s, %d, password=%s, uuid=%s", n.Name, n.Server, n.Port, n.Password, n.UUID)
		if n.SNI != "" {
			b.WriteString(", sni=" + n.SNI)
		}
		if cc, ok := n.Extra["congestion_control"].(string); ok && cc != "" {
			b.WriteString(", congestion-controller=" + cc)
		}
	case "anytls":
		fmt.Fprintf(&b, "%s = anytls, %s, %d, password=%s", n.Name, n.Server, n.Port, n.Password)
		if n.SNI != "" {
			b.WriteString(", sni=" + n.SNI)
		}
	}
	return b.String()
}

func (r *SurgeRenderer) Render(im Intermediate, subURL, rulesetBase string) string {
	return r.render(im, subURL, rulesetBase, false)
}

// render builds the Surge-family .conf. wgInline selects WireGuard handling:
// false → a [WireGuard <section>] block + a section-name proxy reference (Surge);
// true → a single inline [Proxy] line (ShadowRocket).
func (r *SurgeRenderer) render(im Intermediate, subURL, rulesetBase string, wgInline bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "#!MANAGED-CONFIG %s interval=43200 strict=false\n\n", subURL)

	var skipped []string
	for _, n := range im.Nodes {
		if !r.Supports(n.Protocol) {
			skipped = append(skipped, n.Name)
		}
	}
	if len(skipped) > 0 {
		fmt.Fprintf(&b, "# skipped %d node(s) not supported by surge: %s\n", len(skipped), strings.Join(skipped, ", "))
	}

	b.WriteString("[General]\n")
	if g := strings.TrimSpace(im.General); g != "" {
		b.WriteString(g + "\n\n")
	} else {
		b.WriteString("bypass-system = true\n\n")
	}

	b.WriteString("[Proxy]\nDIRECT = direct\n")
	type wgSec struct {
		n   Node
		sec string
	}
	var wgSecs []wgSec
	for _, n := range im.Nodes {
		if !r.Supports(n.Protocol) {
			continue
		}
		if n.Protocol == "wireguard" {
			if wgInline {
				b.WriteString(shadowrocketWGLine(n) + "\n")
			} else {
				sec := fmt.Sprintf("wg%d", len(wgSecs))
				fmt.Fprintf(&b, "%s = wireguard, section-name=%s\n", n.Name, sec)
				wgSecs = append(wgSecs, wgSec{n, sec})
			}
			continue
		}
		b.WriteString(r.proxyLine(n) + "\n")
	}

	b.WriteString("\n[Proxy Group]\n")
	for _, g := range im.Groups {
		b.WriteString(r.groupLine(g) + "\n")
	}
	b.WriteString("\n[Rule]\n")
	for _, rule := range im.Rules {
		b.WriteString(surgeRuleLine(rule, rulesetBase) + "\n")
	}
	if m := strings.TrimSpace(im.MITM); m != "" {
		b.WriteString("\n[MITM]\n" + m + "\n")
	}
	for _, w := range wgSecs {
		b.WriteString("\n" + surgeWGSection(w.n, w.sec))
	}
	return b.String()
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
	if mtu, ok := n.Extra["mtu"].(int); ok && mtu > 0 {
		fmt.Fprintf(&b, "mtu = %d\n", mtu)
	}
	fmt.Fprintf(&b, `peer = (public-key = %s, allowed-ips = "0.0.0.0/0, ::/0", endpoint = %s:%d`, wgField(n, "public_key"), n.Server, n.Port)
	if psk := wgField(n, "preshared_key"); psk != "" {
		b.WriteString(", preshared-key = " + psk)
	}
	b.WriteString(")\n")
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
	// select groups carry DIRECT as the conventional fallback member — append
	// it only when the group doesn't already include it (category groups do).
	members := g.Members
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
