package subgen

import "testing"

func strp(s string) *string { return &s }

func TestXrayInboundToNode_Reality(t *testing.T) {
	n := xrayInboundToNode(xrayLite{
		Tag: "r1", Port: 443, Protocol: "vless-reality",
		UUID: "uuid-1", SNI: "www.example.com", PublicKey: "PBK", ShortID: "aa",
	}, serverLite{Name: "tokyo", Host: "1.2.3.4", Country: "JP"})
	if n.Protocol != "vless" || n.Server != "1.2.3.4" || n.Port != 443 {
		t.Fatalf("bad node: %+v", n)
	}
	if n.RealityPublicKey != "PBK" || n.RealityShortID != "aa" || n.SNI != "www.example.com" {
		t.Fatalf("reality fields lost: %+v", n)
	}
	if n.Country != "JP" || n.Name == "" {
		t.Fatalf("name/country: %+v", n)
	}
}

func TestXrayInboundToNode_Shadowsocks(t *testing.T) {
	n := xrayInboundToNode(xrayLite{
		Tag: "s1", Port: 8388, Protocol: "shadowsocks",
		SSMethod: "aes-256-gcm", SSPassword: "pw",
	}, serverLite{Name: "sg", Host: "5.6.7.8", Country: "SG"})
	if n.Protocol != "shadowsocks" || n.SSMethod != "aes-256-gcm" || n.Password != "pw" {
		t.Fatalf("ss fields: %+v", n)
	}
}

func TestSingboxInboundToNode_Hysteria2(t *testing.T) {
	pw := "hpw"
	n := singboxInboundToNode(singboxLite{
		Port: 443, Protocol: "hysteria2", Password: &pw,
		SNI: strp("h.example.com"), ExtraJSON: strp(`{"up_mbps":100,"down_mbps":500}`),
	}, serverLite{Name: "hk", Host: "9.9.9.9", Country: "HK"})
	if n.Protocol != "hysteria2" || n.Password != "hpw" || n.SNI != "h.example.com" {
		t.Fatalf("hy2 fields: %+v", n)
	}
	if n.Extra["up_mbps"] == nil || n.Extra["down_mbps"] == nil {
		t.Fatalf("extra knobs lost: %+v", n.Extra)
	}
}

func TestSingboxInboundToNode_VlessWsTls(t *testing.T) {
	uuid := "u"
	n := singboxInboundToNode(singboxLite{
		Port: 443, Protocol: "vless-ws-tls", UUID: &uuid,
		SNI: strp("w.example.com"), TransportPath: strp("/ws"), TransportHost: strp("w.example.com"),
	}, serverLite{Name: "us", Host: "2.2.2.2", Country: "US"})
	if n.Protocol != "vless" || n.Transport != "ws" || n.Path != "/ws" || n.Host != "w.example.com" {
		t.Fatalf("vless-ws fields: %+v", n)
	}
}

func TestInboundToNode_AliasReplacesName(t *testing.T) {
	srv := serverLite{Name: "Tokyo", Host: "1.2.3.4", Country: "US"}

	// xray: alias set → verbatim; empty → default
	if got := xrayInboundToNode(xrayLite{Protocol: "vless-reality", Alias: "🇭🇰 香港 CIA 01"}, srv).Name; got != "🇭🇰 香港 CIA 01" {
		t.Errorf("xray alias: got %q", got)
	}
	if got := xrayInboundToNode(xrayLite{Protocol: "vless-reality", Alias: "  "}, srv).Name; got != "🇺🇸 Tokyo vless" {
		t.Errorf("xray blank alias fallback: got %q", got)
	}

	// singbox: alias set → verbatim; empty → default
	if got := singboxInboundToNode(singboxLite{Protocol: "anytls", Alias: "Home AnyTLS"}, srv).Name; got != "Home AnyTLS" {
		t.Errorf("singbox alias: got %q", got)
	}
	if got := singboxInboundToNode(singboxLite{Protocol: "anytls"}, srv).Name; got != "🇺🇸 Tokyo anytls" {
		t.Errorf("singbox empty alias fallback: got %q", got)
	}
}

func TestCertMatchesSNI(t *testing.T) {
	cases := []struct {
		cert, sni string
		want      bool
	}{
		{"vpn.example.com", "vpn.example.com", true},  // exact
		{"VPN.Example.com", "vpn.example.COM", true},  // case-insensitive
		{"vpn.example.com", "www.bing.com", false},    // mismatch (camouflage)
		{"*.example.com", "a.example.com", true},      // wildcard single-label
		{"*.example.com", "example.com", false},       // wildcard does NOT match apex
		{"*.example.com", "a.b.example.com", false},   // wildcard does NOT match multi-label
		{"*.example.com", "example.com.evil.com", false},
		{"", "a.com", false},  // empty cert
		{"a.com", "", false},  // empty sni
	}
	for _, c := range cases {
		if got := certMatchesSNI(c.cert, c.sni); got != c.want {
			t.Errorf("certMatchesSNI(%q,%q)=%v want %v", c.cert, c.sni, got, c.want)
		}
	}
}

func TestDedupeNodeNames(t *testing.T) {
	nodes := []Node{{Name: "X"}, {Name: "X"}, {Name: "X"}, {Name: "Y"}}
	dedupeNodeNames(nodes)
	got := []string{nodes[0].Name, nodes[1].Name, nodes[2].Name, nodes[3].Name}
	want := []string{"X", "X 2", "X 3", "Y"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("idx %d: got %q want %q", i, got[i], want[i])
		}
	}

	// a name that already ends in a taken suffix is skipped
	nodes2 := []Node{{Name: "A"}, {Name: "A 2"}, {Name: "A"}}
	dedupeNodeNames(nodes2)
	if nodes2[2].Name != "A 3" {
		t.Errorf("collision with pre-taken suffix: got %q want %q", nodes2[2].Name, "A 3")
	}

	// an explicit name that collides with a generated suffix must survive
	nodes3 := []Node{{Name: "X"}, {Name: "X"}, {Name: "X 2"}}
	dedupeNodeNames(nodes3)
	got3 := []string{nodes3[0].Name, nodes3[1].Name, nodes3[2].Name}
	want3 := []string{"X", "X 3", "X 2"}
	for i := range want3 {
		if got3[i] != want3[i] {
			t.Errorf("suffix-collision idx %d: got %q want %q", i, got3[i], want3[i])
		}
	}
}

func TestSingboxInboundToNode_SnellV5(t *testing.T) {
	psk := "psk-abc"
	extra := `{"obfs_mode":"http"}`
	in := singboxLite{
		Tag: "landing-snell", Port: 8443, Protocol: "snell-v5",
		Role: "landing", Password: &psk, ExtraJSON: &extra,
	}
	srv := serverLite{Host: "1.2.3.4", Name: "hk1", Country: "HK"}
	n := singboxInboundToNode(in, srv)

	if n.Protocol != "snell" {
		t.Errorf("Protocol = %q, want snell", n.Protocol)
	}
	if n.Password != psk {
		t.Errorf("Password = %q, want %q", n.Password, psk)
	}
	if n.Extra["snell_version"] != 5 {
		t.Errorf("Extra[snell_version] = %v (%T), want 5 (int)", n.Extra["snell_version"], n.Extra["snell_version"])
	}
	if n.Extra["obfs_mode"] != "http" {
		t.Errorf("Extra[obfs_mode] = %v, want http", n.Extra["obfs_mode"])
	}
}

func TestSingboxInboundToNode_SnellV6NoExtraJSON(t *testing.T) {
	psk := "psk-abc"
	in := singboxLite{
		Tag: "landing-snell6", Port: 8443, Protocol: "snell-v6",
		Role: "landing", Password: &psk,
	}
	srv := serverLite{Host: "1.2.3.4", Name: "hk1", Country: "HK"}
	n := singboxInboundToNode(in, srv)

	if n.Protocol != "snell" {
		t.Errorf("Protocol = %q, want snell", n.Protocol)
	}
	// Extra must exist even with no extra_json — the version lives there.
	if n.Extra == nil {
		t.Fatal("Extra is nil; snell_version must be set even without extra_json")
	}
	if n.Extra["snell_version"] != 6 {
		t.Errorf("Extra[snell_version] = %v, want 6", n.Extra["snell_version"])
	}
}
