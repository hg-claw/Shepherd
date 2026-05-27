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
		Rules: []Rule{
			{Match: "IP-CIDR,10.0.0.0/24", Target: "PROXY"},
			{Ruleset: "Telegram", Target: "Telegram"},
			{Native: "GEOIP,CN", Target: "DIRECT"},
			{Final: true, Target: "PROXY"},
		},
	}
	out := (&SurgeRenderer{}).Render(im, "https://x/sub/abc?target=surge", DefaultRulesetBase)
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
		"RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Telegram/Telegram.list,Telegram",
		"GEOIP,CN,DIRECT",
		"FINAL,PROXY",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q\n---\n%s", want, out)
		}
	}
}

func TestSurge_GeneralAndMITM(t *testing.T) {
	base := Intermediate{
		Nodes:  []Node{{Name: "n1", Protocol: "trojan", Server: "1.1.1.1", Port: 443, Password: "p"}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"n1"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}

	out := (&SurgeRenderer{}).Render(base, "https://x/sub/t?target=surge", DefaultRulesetBase)
	if !strings.Contains(out, "[General]\nbypass-system = true") {
		t.Fatalf("default [General] missing:\n%s", out)
	}
	if strings.Contains(out, "[MITM]") {
		t.Fatalf("[MITM] should be absent when unset:\n%s", out)
	}

	im := base
	im.General = "dns-server = 1.1.1.1\nskip-proxy = 10.0.0.0/8"
	im.MITM = "hostname = *.googlevideo.com"
	out = (&SurgeRenderer{}).Render(im, "https://x/sub/t?target=surge", DefaultRulesetBase)
	if !strings.Contains(out, "[General]\ndns-server = 1.1.1.1\nskip-proxy = 10.0.0.0/8") {
		t.Fatalf("custom [General] missing:\n%s", out)
	}
	if strings.Contains(out, "bypass-system = true") {
		t.Fatalf("default [General] should be replaced:\n%s", out)
	}
	if !strings.Contains(out, "[MITM]\nhostname = *.googlevideo.com") {
		t.Fatalf("[MITM] missing:\n%s", out)
	}
}

func TestSurge_SelectGroupDirectFallback(t *testing.T) {
	im := Intermediate{
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"Auto Select", "n1"}}},
	}
	out := (&SurgeRenderer{}).Render(im, "x", DefaultRulesetBase)
	if !strings.Contains(out, "PROXY = select, Auto Select, n1, DIRECT\n") {
		t.Fatalf("missing DIRECT fallback:\n%s", out)
	}

	im2 := Intermediate{
		Groups: []Group{{Name: "Telegram", Type: "select", Members: []string{"PROXY", "DIRECT", "REJECT", "n1"}}},
	}
	out2 := (&SurgeRenderer{}).Render(im2, "x", DefaultRulesetBase)
	if !strings.Contains(out2, "Telegram = select, PROXY, DIRECT, REJECT, n1\n") {
		t.Fatalf("Telegram group wrong:\n%s", out2)
	}
	if strings.Contains(out2, "REJECT, n1, DIRECT") {
		t.Fatalf("DIRECT duplicated:\n%s", out2)
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
		`peer = (public-key = PUB, allowed-ips = "0.0.0.0/0, ::/0", endpoint = home.hg.ht:51820, preshared-key = PSK)`,
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

func TestSurge_CustomRulesetURL(t *testing.T) {
	im := Intermediate{
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"n1"}}},
		Rules:  []Rule{{Ruleset: "AI", Target: "AI Services"}},
	}
	out := (&SurgeRenderer{}).Render(im, "x", DefaultRulesetBase)
	if !strings.Contains(out, "RULE-SET,https://raw.githubusercontent.com/iab0x00/ProxyRules/main/Rule/AI.txt,AI Services") {
		t.Fatalf("surge AI rule missing:\n%s", out)
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
