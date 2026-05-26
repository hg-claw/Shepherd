package subgen

import (
	"strings"
	"testing"
)

func TestSurge_RendersProtocolsGroupsRules(t *testing.T) {
	im := Intermediate{
		Nodes: []Node{
			{Name: "ss1", Protocol: "shadowsocks", Server: "1.1.1.1", Port: 8388, SSMethod: "aes-256-gcm", Password: "p"},
			{Name: "re1", Protocol: "vless", Server: "2.2.2.2", Port: 443, UUID: "u", SNI: "s", RealityPublicKey: "PBK", RealityShortID: "aa"},
			{Name: "hy1", Protocol: "hysteria2", Server: "3.3.3.3", Port: 443, Password: "hp", SNI: "h"},
			{Name: "at1", Protocol: "anytls", Server: "4.4.4.4", Port: 443, Password: "ap", SNI: "a"},
		},
		Groups: []Group{
			{Name: "PROXY", Type: "select", Members: []string{"Auto Select", "ss1"}},
			{Name: "Auto Select", Type: "url-test", Members: []string{"ss1", "re1"}},
		},
		Rules: []string{"IP-CIDR,10.0.0.0/24,PROXY", "GEOIP,CN,DIRECT", "FINAL,PROXY"},
	}
	out := (&SurgeRenderer{}).Render(im, "https://x/sub/abc?target=surge")
	for _, want := range []string{
		"#!MANAGED-CONFIG https://x/sub/abc?target=surge",
		"[Proxy]", "DIRECT = direct",
		"ss1 = ss, 1.1.1.1, 8388, encrypt-method=aes-256-gcm, password=p",
		"re1 = vless, 2.2.2.2, 443, username=u, tls=true, sni=s, public-key=PBK, short-id=aa",
		"hy1 = hysteria2, 3.3.3.3, 443, password=hp, sni=h",
		"at1 = anytls, 4.4.4.4, 443, password=ap, sni=a",
		"[Proxy Group]",
		"PROXY = select, Auto Select, ss1, DIRECT",
		"Auto Select = url-test, ss1, re1, url=http://www.gstatic.com/generate_204, interval=300",
		"[Rule]",
		"IP-CIDR,10.0.0.0/24,PROXY",
		"GEOIP,CN,DIRECT",
		"FINAL,PROXY",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q\n---\n%s", want, out)
		}
	}
}
