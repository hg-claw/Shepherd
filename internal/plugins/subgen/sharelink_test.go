package subgen

import (
	"encoding/base64"
	"net/url"
	"testing"
)

func b64raw(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
func b64std(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestParseShareLinks_AllProtocols(t *testing.T) {
	text := "ss://" + b64raw("aes-256-gcm:pass") + "@1.1.1.1:8388#🇭🇰 HK\n" +
		"# a comment\n" +
		"vless://uuid-1@2.2.2.2:443?security=reality&pbk=PBK&sid=SID&flow=xtls-rprx-vision&sni=example.com&type=ws&path=/w&host=v.com#🇺🇸 US\n" +
		"trojan://tjpass@3.3.3.3:443?sni=t.com&type=ws&path=/p&host=h.com&allowInsecure=1#JP\n" +
		"hysteria2://hy2pass@4.4.4.4:443?sni=h2.com&insecure=1#HY2\n" +
		"tuic://uuid-2:tpass@5.5.5.5:443?congestion_control=bbr&sni=tu.com&insecure=1#TUIC\n" +
		"anytls://atpass@6.6.6.6:443?sni=at.com#AT\n" +
		"\n" +
		"not-a-link\n"

	nodes, warns := ParseShareLinks(text)
	if len(nodes) != 6 {
		t.Fatalf("want 6 nodes, got %d (%+v)", len(nodes), nodes)
	}
	if len(warns) != 1 {
		t.Fatalf("want 1 warning, got %d (%v)", len(warns), warns)
	}
	by := map[string]Node{}
	for _, n := range nodes {
		by[n.Name] = n
	}

	if ss := by["🇭🇰 HK"]; ss.Protocol != "shadowsocks" || ss.Server != "1.1.1.1" || ss.Port != 8388 || ss.SSMethod != "aes-256-gcm" || ss.Password != "pass" {
		t.Fatalf("ss = %+v", ss)
	}
	if vl := by["🇺🇸 US"]; vl.Protocol != "vless" || vl.UUID != "uuid-1" || vl.SNI != "example.com" || vl.RealityPublicKey != "PBK" || vl.RealityShortID != "SID" || vl.Flow != "xtls-rprx-vision" || vl.Transport != "ws" || vl.Path != "/w" || vl.Host != "v.com" {
		t.Fatalf("vless = %+v", vl)
	}
	if tj := by["JP"]; tj.Protocol != "trojan" || tj.Password != "tjpass" || tj.SNI != "t.com" || tj.Transport != "ws" || tj.Path != "/p" || tj.Host != "h.com" || !tj.Insecure {
		t.Fatalf("trojan = %+v", tj)
	}
	if hy := by["HY2"]; hy.Protocol != "hysteria2" || hy.Password != "hy2pass" || hy.SNI != "h2.com" || !hy.Insecure {
		t.Fatalf("hy2 = %+v", hy)
	}
	if tu := by["TUIC"]; tu.Protocol != "tuic" || tu.UUID != "uuid-2" || tu.Password != "tpass" || tu.SNI != "tu.com" || tu.Extra["congestion_control"] != "bbr" || !tu.Insecure {
		t.Fatalf("tuic = %+v", tu)
	}
	if at := by["AT"]; at.Protocol != "anytls" || at.Password != "atpass" || at.SNI != "at.com" {
		t.Fatalf("anytls = %+v", at)
	}
}

func TestParseShareLinks_WireGuard(t *testing.T) {
	link := "wg://home.hg.ht:51820?publicKey=" + url.QueryEscape("PUB+KEY=") +
		"&privateKey=" + url.QueryEscape("PRIV+KEY=") +
		"&presharedKey=" + url.QueryEscape("PSK+=") +
		"&ip=10.254.253.3&udp=1&reserved=0,0,0&flag=CN#WG"

	nodes, warns := ParseShareLinks(link)
	if len(warns) != 0 || len(nodes) != 1 {
		t.Fatalf("nodes=%d warns=%v", len(nodes), warns)
	}
	n := nodes[0]
	if n.Protocol != "wireguard" || n.Server != "home.hg.ht" || n.Port != 51820 {
		t.Fatalf("endpoint = %+v", n)
	}
	if n.Name != "🇨🇳 WG" {
		t.Fatalf("name = %q", n.Name)
	}
	if n.Extra["private_key"] != "PRIV+KEY=" || n.Extra["public_key"] != "PUB+KEY=" || n.Extra["preshared_key"] != "PSK+=" {
		t.Fatalf("keys = %+v", n.Extra)
	}
	if n.Extra["ip"] != "10.254.253.3" || n.Extra["reserved"] != "0,0,0" || n.Extra["udp"] != true {
		t.Fatalf("extra = %+v", n.Extra)
	}

	// missing keys → warning, skipped
	if ns, ws := ParseShareLinks("wg://h:1?ip=1.2.3.4#X"); len(ns) != 0 || len(ws) != 1 {
		t.Fatalf("missing-keys: nodes=%d warns=%d", len(ns), len(ws))
	}
}

func TestParseShareLinks_VMessAndLegacySS(t *testing.T) {
	vmessJSON := `{"v":"2","ps":"VM","add":"7.7.7.7","port":"443","id":"vm-uuid","net":"ws","host":"vm.com","path":"/p","tls":"tls","sni":"vm.com"}`
	legacy := "ss://" + b64std("aes-128-gcm:pw@8.8.8.8:8388") + "#LEG"

	nodes, warns := ParseShareLinks("vmess://" + b64std(vmessJSON) + "\n" + legacy)
	if len(warns) != 0 {
		t.Fatalf("unexpected warnings: %v", warns)
	}
	if len(nodes) != 2 {
		t.Fatalf("want 2 nodes, got %d (%+v)", len(nodes), nodes)
	}
	by := map[string]Node{}
	for _, n := range nodes {
		by[n.Name] = n
	}
	if vm := by["VM"]; vm.Protocol != "vmess" || vm.Server != "7.7.7.7" || vm.Port != 443 || vm.UUID != "vm-uuid" || vm.Transport != "ws" || vm.Path != "/p" || vm.Host != "vm.com" || vm.SNI != "vm.com" {
		t.Fatalf("vmess = %+v", vm)
	}
	if leg := by["LEG"]; leg.Protocol != "shadowsocks" || leg.Server != "8.8.8.8" || leg.Port != 8388 || leg.SSMethod != "aes-128-gcm" || leg.Password != "pw" {
		t.Fatalf("legacy ss = %+v", leg)
	}
}
