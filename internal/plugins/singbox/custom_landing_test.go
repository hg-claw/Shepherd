package singbox

import (
	"encoding/json"
	"testing"
)

func TestParseCustomLandingURL(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want customLanding
	}{
		{"anytls", "anytls://secret@example.com:443?sni=edge.example.com&insecure=1", customLanding{Scheme: "anytls", Server: "example.com", Port: 443, Username: "secret", Password: "secret", SNI: "edge.example.com", Insecure: true}},
		{"http", "http://user:pass@example.com:8080", customLanding{Scheme: "http", Server: "example.com", Port: 8080, Username: "user", Password: "pass", SNI: "example.com"}},
		{"socks", "socks5://user:pass@example.com:1080", customLanding{Scheme: "socks5", Server: "example.com", Port: 1080, Username: "user", Password: "pass", SNI: "example.com"}},
		{"tuic", "tuic://22222222-2222-2222-2222-222222222222:hexpass@tuic.example.com:8443?sni=edge.example.com", customLanding{Scheme: "tuic", Server: "tuic.example.com", Port: 8443, Username: "22222222-2222-2222-2222-222222222222", Password: "hexpass", SNI: "edge.example.com", Insecure: true}},
		{"tuic-insecure-off", "tuic://u:p@example.com:443?sni=s.example.com&insecure=0", customLanding{Scheme: "tuic", Server: "example.com", Port: 443, Username: "u", Password: "p", SNI: "s.example.com", Insecure: false}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseCustomLandingURL(tt.raw)
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("got %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestParseCustomLandingURLRejectsInvalid(t *testing.T) {
	for _, raw := range []string{
		"vless://uuid@example.com:443",
		"http://example.com",
		"anytls://example.com:443",
		"socks5://example.com:0",
		"tuic://uuid-only@example.com:443",
		"tuic://example.com:443",
		"tuic://u:p@example.com:443?congestion_control=vegas",
	} {
		if _, err := parseCustomLandingURL(raw); err == nil {
			t.Errorf("parseCustomLandingURL(%q) unexpectedly succeeded", raw)
		}
	}
}

func TestRenderCustomRelayOutbound(t *testing.T) {
	in := InboundView{Inbound: Inbound{Tag: "relay-custom", CustomUpstreamURL: "anytls://secret@example.com:443?sni=edge.example.com&insecure=true"}}
	ob, err := renderCustomRelayOutbound(in)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(ob)
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got["type"] != "anytls" || got["tag"] != "to-custom-relay-custom" || got["server"] != "example.com" {
		t.Fatalf("unexpected outbound: %s", b)
	}
	tls, ok := got["tls"].(map[string]any)
	if !ok || tls["server_name"] != "edge.example.com" || tls["insecure"] != true {
		t.Fatalf("unexpected tls block: %s", b)
	}
}

func TestRenderCustomRelayOutboundTUIC(t *testing.T) {
	in := InboundView{Inbound: Inbound{
		Tag:               "relay-tuic",
		CustomUpstreamURL: "tuic://22222222-2222-2222-2222-222222222222:hexpass@tuic.example.com:8443?sni=edge.example.com",
	}}
	ob, err := renderCustomRelayOutbound(in)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(ob)
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got["type"] != "tuic" || got["tag"] != "to-custom-relay-tuic" || got["server"] != "tuic.example.com" {
		t.Fatalf("unexpected outbound: %s", b)
	}
	if got["server_port"] != float64(8443) || got["uuid"] != "22222222-2222-2222-2222-222222222222" || got["password"] != "hexpass" {
		t.Fatalf("unexpected credentials: %s", b)
	}
	if got["congestion_control"] != "cubic" || got["udp_relay_mode"] != "native" || got["zero_rtt_handshake"] != false {
		t.Fatalf("unexpected NoBrand TUIC contract fields: %s", b)
	}
	tls, ok := got["tls"].(map[string]any)
	if !ok {
		t.Fatalf("missing tls block: %s", b)
	}
	if tls["enabled"] != true || tls["server_name"] != "edge.example.com" || tls["insecure"] != true {
		t.Fatalf("unexpected tls block: %s", b)
	}
	alpn, _ := tls["alpn"].([]any)
	if len(alpn) != 1 || alpn[0] != "h3" {
		t.Fatalf("unexpected alpn: %s", b)
	}
}

func TestRenderCustomRelayOutboundTUICCongestionOverride(t *testing.T) {
	in := InboundView{Inbound: Inbound{
		Tag:               "relay-tuic",
		CustomUpstreamURL: "tuic://u:p@example.com:443?sni=s.example.com&congestion_control=bbr&udp_relay_mode=quic",
	}}
	ob, err := renderCustomRelayOutbound(in)
	if err != nil {
		t.Fatal(err)
	}
	if ob["congestion_control"] != "bbr" || ob["udp_relay_mode"] != "quic" {
		t.Fatalf("override not applied: %#v", ob)
	}
}

func TestRenderServerConfigCustomRelayWithoutUpstream(t *testing.T) {
	views := []InboundView{
		{Inbound: Inbound{Tag: "relay-custom", Port: 8443, Role: "relay", Protocol: "vless-ws-tls", RelayMode: "proxy", CustomUpstreamURL: "http://user:pass@example.com:8080"}},
	}
	b, err := RenderServerConfig(views, nil)
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(b, &cfg); err != nil {
		t.Fatal(err)
	}
	obs := cfg["outbounds"].([]any)
	found := false
	for _, raw := range obs {
		ob := raw.(map[string]any)
		if ob["tag"] == "to-custom-relay-custom" {
			found = true
			if ob["type"] != "http" || ob["username"] != "user" || ob["password"] != "pass" {
				t.Fatalf("unexpected custom HTTP outbound: %#v", ob)
			}
		}
	}
	if !found {
		t.Fatal("custom outbound not found")
	}
}
