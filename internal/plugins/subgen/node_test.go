package subgen

import "testing"

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
