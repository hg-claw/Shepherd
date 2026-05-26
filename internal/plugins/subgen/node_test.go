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
