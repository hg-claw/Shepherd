package subgen

import (
	"strings"
	"testing"
)

// TestSurge_FillsTemplate verifies the template-based renderer: no unresolved
// markers, proxy defs emitted, nodes referenced in group lines, custom rules
// appear before the dler.io RULE-SET block, custom groups present, and
// free-text / fixed sections ({{GENERAL_EXTRA}}/[Host]/[Panel]) intact.
func TestSurge_FillsTemplate(t *testing.T) {
	im := Intermediate{
		Nodes:   []Node{{Name: "🟢 A", Protocol: "shadowsocks", Server: "1.1.1.1", Port: 8388, SSMethod: "aes-256-gcm", Password: "p"}},
		Groups:  []Group{{Name: "MyGroup", Type: "select", Members: []string{"DIRECT"}, Verbatim: true}},
		Rules:   []Rule{{Match: "DOMAIN,x.com", Target: "DIRECT"}},
		General: "ipv6 = true",
	}
	out := (&SurgeRenderer{}).Render(im, "https://sub", DefaultRulesetBase)
	if strings.Contains(out, "{{") {
		t.Fatalf("unresolved marker:\n%s", out)
	}
	if !strings.Contains(out, "🟢 A = ss,") {
		t.Errorf("missing proxy def\n%s", out)
	}
	if !strings.Contains(out, "Proxy = select,") || !strings.Contains(out, "🟢 A") {
		t.Errorf("node not in groups\n%s", out)
	}
	ri := strings.Index(out, "DOMAIN,x.com,DIRECT")
	di := strings.Index(out, "RULE-SET,https://fastly.jsdelivr.net")
	if ri < 0 || di < 0 || ri > di {
		t.Errorf("custom rule must precede dler.io rules (ri=%d di=%d)", ri, di)
	}
	if !strings.Contains(out, "MyGroup = select, DIRECT") {
		t.Errorf("custom group missing\n%s", out)
	}
	if !strings.Contains(out, "ipv6 = true") || !strings.Contains(out, "[Host]") || !strings.Contains(out, "[Panel]") {
		t.Errorf("free-text/fixed sections missing\n%s", out)
	}
}

// TestSurge_NoResidualOwnerData guards that the embedded template's original
// owner data (the oixCloud managed-config URL + sub-info account token) was
// stripped: the output must carry exactly ONE managed-config header (ours) and
// leak no oics.net token.
func TestSurge_NoResidualOwnerData(t *testing.T) {
	out := (&SurgeRenderer{}).Render(Intermediate{}, "https://sub", DefaultRulesetBase)
	if strings.Contains(out, "oics.net") {
		t.Fatalf("leaks original owner's oics.net token:\n%s", out)
	}
	if n := strings.Count(out, "#!MANAGED-CONFIG"); n != 1 {
		t.Fatalf("want exactly 1 managed-config header, got %d", n)
	}
}

// DOMAIN-SET is native on Surge/ShadowRocket — the custom rule passes through
// verbatim with the ORIGINAL url (only Clash rewrites to a rule-provider).
func TestSurge_DomainSetVerbatim(t *testing.T) {
	url := "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/Advertising/Advertising_Domain.list"
	im := Intermediate{
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"n1"}}},
		Rules:  []Rule{{Match: "DOMAIN-SET," + url, Target: "Ad Block"}, {Final: true, Target: "PROXY"}},
	}
	out := (&SurgeRenderer{}).Render(im, "x", DefaultRulesetBase)
	if !strings.Contains(out, "DOMAIN-SET,"+url+",Ad Block") {
		t.Fatalf("surge should emit DOMAIN-SET verbatim\n%s", out)
	}
}

func TestSurge_WireGuard(t *testing.T) {
	im := Intermediate{
		Nodes: []Node{{
			Name: "🇨🇳 WG", Protocol: "wireguard", Server: "home.hg.ht", Port: 51820,
			Extra: map[string]any{"private_key": "PRIV", "public_key": "PUB", "preshared_key": "PSK", "ip": "10.254.253.3", "reserved": "0,0,0", "udp": true},
		}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"🇨🇳 WG"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}
	out := (&SurgeRenderer{}).Render(im, "https://x?target=surge", DefaultRulesetBase)
	for _, want := range []string{
		"🇨🇳 WG = wireguard, section-name=wg0",
		"[WireGuard wg0]",
		"private-key = PRIV",
		"self-ip = 10.254.253.3",
		"dns-server = 8.8.8.8, 114.114.114.114",
		"mtu = 1420",
		`peer = (public-key = PUB, allowed-ips = "0.0.0.0/0, ::/0", endpoint = home.hg.ht:51820, preshared-key = PSK, keepalive = 5)`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("surge WG missing %q\n%s", want, out)
		}
	}
	if strings.Contains(out, "reserved") {
		t.Errorf("surge should drop reserved\n%s", out)
	}
}

func TestSurge_ProxyLine_VmessTrojanTuic(t *testing.T) {
	im := Intermediate{
		Nodes: []Node{
			{Name: "vm1", Protocol: "vmess", Server: "1.1.1.1", Port: 443, UUID: "uu", SNI: "v.com", Transport: "ws", Path: "/p", Host: "v.com"},
			{Name: "tj1", Protocol: "trojan", Server: "2.2.2.2", Port: 443, Password: "tp", SNI: "t.com"},
			{Name: "tu1", Protocol: "tuic", Server: "3.3.3.3", Port: 443, Password: "up", UUID: "uid", SNI: "u.com", Extra: map[string]any{"congestion_control": "bbr"}},
		},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"vm1"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}
	out := (&SurgeRenderer{}).Render(im, "https://x/sub/t?target=surge", DefaultRulesetBase)
	for _, want := range []string{
		"vm1 = vmess, 1.1.1.1, 443, username=uu, vmess-aead=true, tls=true, sni=v.com, ws=true, ws-path=/p, ws-headers=Host:v.com",
		"tj1 = trojan, 2.2.2.2, 443, password=tp, sni=t.com",
		"tu1 = tuic, 3.3.3.3, 443, password=up, uuid=uid, sni=u.com, congestion-controller=bbr",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q\n---\n%s", want, out)
		}
	}
}

func TestSurge_CustomGroupVerbatimKeepsDevice(t *testing.T) {
	im := Intermediate{
		Groups: []Group{{Name: "Home", Type: "select", Members: []string{"DEVICE:HomeMac", "PROXY"}, Verbatim: true}},
		Rules:  []Rule{{Match: "IP-CIDR,192.168.1.0/24", Target: "DEVICE:HomeMac"}, {Final: true, Target: "PROXY"}},
	}
	out := (&SurgeRenderer{}).Render(im, "x", DefaultRulesetBase)
	if !strings.Contains(out, "Home = select, DEVICE:HomeMac, PROXY\n") {
		t.Fatalf("surge verbatim group:\n%s", out)
	}
	if strings.Contains(out, "DEVICE:HomeMac, PROXY, DIRECT") {
		t.Fatalf("verbatim group must not get auto-DIRECT:\n%s", out)
	}
	if !strings.Contains(out, "IP-CIDR,192.168.1.0/24,DEVICE:HomeMac") {
		t.Fatalf("surge keeps DEVICE rule:\n%s", out)
	}
}

func TestSurge_InsecureSkipCertVerify(t *testing.T) {
	mk := func(proto string, insecure bool) string {
		im := Intermediate{
			Nodes:  []Node{{Name: "n", Protocol: proto, Server: "1.1.1.1", Port: 443, Password: "p", UUID: "u", SNI: "s.com", Insecure: insecure}},
			Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"n"}}},
			Rules:  []Rule{{Final: true, Target: "PROXY"}},
		}
		return (&SurgeRenderer{}).Render(im, "x", DefaultRulesetBase)
	}
	for _, proto := range []string{"anytls", "hysteria2", "tuic"} {
		if out := mk(proto, true); !strings.Contains(out, "skip-cert-verify=true") {
			t.Errorf("%s insecure: missing skip-cert-verify\n%s", proto, out)
		}
		if out := mk(proto, false); strings.Contains(out, "skip-cert-verify=true") {
			t.Errorf("%s secure: unexpected skip-cert-verify\n%s", proto, out)
		}
	}
}

func TestSurge_DisabledGroupsDropped(t *testing.T) {
	im := Intermediate{
		Nodes:          []Node{{Name: "🟢 A", Protocol: "shadowsocks", Server: "1.1.1.1", Port: 8388, SSMethod: "aes-256-gcm", Password: "p"}},
		DisabledGroups: []string{"Netflix", "AdBlock"},
	}
	out := (&SurgeRenderer{}).Render(im, "https://sub", DefaultRulesetBase)
	if strings.Contains(out, "\nNetflix = select") || strings.Contains(out, "\nAdBlock = select") {
		t.Errorf("disabled group line still present\n%s", out)
	}
	if strings.Contains(out, "/Media/Netflix.list,Netflix") || strings.Contains(out, "/AdBlock.list,AdBlock") {
		t.Errorf("disabled group rule still present\n%s", out)
	}
	if !strings.Contains(out, "\nProxy = select") || !strings.Contains(out, "\nOthers = select") {
		t.Errorf("core group wrongly dropped\n%s", out)
	}
	if !strings.Contains(out, "GEOIP,CN,Domestic") || !strings.Contains(out, "FINAL,Others") {
		t.Errorf("structural rule wrongly dropped\n%s", out)
	}
	if !strings.Contains(out, "\nYouTube = select") {
		t.Errorf("non-disabled service group wrongly dropped\n%s", out)
	}
	if strings.Contains(out, "{{") {
		t.Errorf("unresolved marker\n%s", out)
	}
}

func TestSurge_NoDisabledIsParity(t *testing.T) {
	full := (&SurgeRenderer{}).Render(Intermediate{}, "x", DefaultRulesetBase)
	got := (&SurgeRenderer{}).Render(Intermediate{DisabledGroups: []string{}}, "x", DefaultRulesetBase)
	if got != full {
		t.Fatalf("empty disabled set changed Surge output")
	}
}

func TestSurge_SkipProxyDrops10Net(t *testing.T) {
	out := (&SurgeRenderer{}).Render(Intermediate{}, "https://sub", DefaultRulesetBase)
	if strings.Contains(out, "10.0.0.0/8") {
		t.Fatalf("skip-proxy must not contain 10.0.0.0/8\n%s", out)
	}
	// neighbouring private ranges must remain
	if !strings.Contains(out, "172.16.0.0/12") || !strings.Contains(out, "192.168.0.0/16") {
		t.Fatalf("skip-proxy lost other private ranges\n%s", out)
	}
}
