package subgen

import (
	"strconv"
	"strings"

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

// Render produces a mihomo (Clash.Meta) YAML config. subURL is unused (Clash has
// no managed-config header). The ClashGeneral preamble supplies top-level keys
// (dns, mode, …); when empty the default is {mode: rule}.
func (r *ClashRenderer) Render(im Intermediate, _ string, rulesetBase string) string {
	base := map[string]any{"mode": "rule"}
	if g := strings.TrimSpace(im.ClashGeneral); g != "" {
		var m map[string]any
		if err := yaml.Unmarshal([]byte(g), &m); err == nil && m != nil {
			base = m
		}
	}

	proxies := []map[string]any{}
	for _, n := range im.Nodes {
		if px := clashProxy(n); px != nil {
			proxies = append(proxies, px)
		}
	}
	if len(proxies) > 0 {
		base["proxies"] = proxies
	}

	groups := []map[string]any{}
	for _, g := range im.Groups {
		members := dropDevicePolicies(g.Members) // Clash has no Ponte
		if len(members) == 0 {
			continue
		}
		m := map[string]any{"name": g.Name, "type": g.Type, "proxies": members}
		if g.Type == "url-test" {
			m["url"] = "http://www.gstatic.com/generate_204"
			m["interval"] = 300
		}
		groups = append(groups, m)
	}
	if len(groups) > 0 {
		base["proxy-groups"] = groups
	}

	providers := map[string]any{}
	rules := []string{}
	for _, rl := range im.Rules {
		if strings.HasPrefix(rl.Target, "DEVICE:") {
			continue
		}
		switch {
		case rl.Final:
			rules = append(rules, "MATCH,"+rl.Target)
		case rl.Ruleset != "":
			if _, ok := providers[rl.Ruleset]; !ok {
				url := rulesetURL(rl.Ruleset, "clash", rulesetBase)
				// blackmatrix7 ships .yaml rule-providers; custom URLs (e.g. a
				// classical .txt list) use the text format.
				format, ext := "yaml", "yaml"
				if !strings.HasSuffix(url, ".yaml") && !strings.HasSuffix(url, ".yml") {
					format, ext = "text", "txt"
				}
				providers[rl.Ruleset] = map[string]any{
					"type":     "http",
					"behavior": "classical",
					"format":   format,
					"url":      url,
					"path":     "./ruleset/" + rl.Ruleset + "." + ext,
					"interval": 86400,
				}
			}
			rules = append(rules, "RULE-SET,"+rl.Ruleset+","+rl.Target)
		case rl.Native != "":
			rules = append(rules, nativeToClash(rl.Native)+","+rl.Target)
		default:
			rules = append(rules, rl.Match+","+rl.Target)
		}
	}
	if len(providers) > 0 {
		base["rule-providers"] = providers
	}
	base["rules"] = rules

	out, err := yaml.Marshal(base)
	if err != nil {
		return "# clash render error: " + err.Error()
	}
	return string(out)
}

// nativeToClash maps a catalog Native directive to its Clash rule prefix. Clash
// has no SYSTEM rule-set, so the Private category maps to GEOIP,PRIVATE (mihomo's
// LAN/loopback group); everything else (e.g. GEOIP,CN) is identical.
func nativeToClash(native string) string {
	if native == "RULE-SET,SYSTEM" {
		return "GEOIP,PRIVATE"
	}
	return native
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
