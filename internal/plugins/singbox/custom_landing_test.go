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
