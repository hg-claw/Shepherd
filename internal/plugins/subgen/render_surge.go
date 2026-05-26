package subgen

import (
	"fmt"
	"strings"
)

type SurgeRenderer struct{}

func (*SurgeRenderer) Target() string { return "surge" }

func (*SurgeRenderer) Supports(p string) bool {
	switch p {
	case "shadowsocks", "vmess", "trojan", "vless", "hysteria2", "tuic", "anytls":
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

func (r *SurgeRenderer) Render(im Intermediate, subURL string) string {
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
	for _, n := range im.Nodes {
		if r.Supports(n.Protocol) {
			b.WriteString(r.proxyLine(n) + "\n")
		}
	}
	b.WriteString("\n[Proxy Group]\n")
	for _, g := range im.Groups {
		b.WriteString(r.groupLine(g) + "\n")
	}
	b.WriteString("\n[Rule]\n")
	for _, rule := range im.Rules {
		b.WriteString(rule + "\n")
	}
	if m := strings.TrimSpace(im.MITM); m != "" {
		b.WriteString("\n[MITM]\n" + m + "\n")
	}
	return b.String()
}

func (r *SurgeRenderer) groupLine(g Group) string {
	members := strings.Join(g.Members, ", ")
	if g.Type == "url-test" {
		return fmt.Sprintf("%s = url-test, %s, url=http://www.gstatic.com/generate_204, interval=300", g.Name, members)
	}
	// select groups append DIRECT as the conventional fallback member.
	return fmt.Sprintf("%s = select, %s, DIRECT", g.Name, members)
}
