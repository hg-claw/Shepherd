package mieru

import (
	"encoding/json"
	"testing"
)

func TestRenderServerConfig_TCPUser(t *testing.T) {
	cfg, err := RenderServerConfig([]InboundView{{
		Inbound: Inbound{ID: 1, Tag: "landing-aa", Port: 2012, Protocol: "TCP", Username: "alice", Password: "secret", MTU: 1400},
	}})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(cfg, &out); err != nil {
		t.Fatal(err)
	}
	if out["mtu"] != float64(1400) || out["loggingLevel"] != "INFO" {
		t.Fatalf("meta: %s", cfg)
	}
	binds := out["portBindings"].([]any)
	b0 := binds[0].(map[string]any)
	if b0["port"] != float64(2012) || b0["protocol"] != "TCP" {
		t.Fatalf("bindings: %s", cfg)
	}
	users := out["users"].([]any)
	u0 := users[0].(map[string]any)
	if u0["name"] != "alice" || u0["password"] != "secret" {
		t.Fatalf("users: %s", cfg)
	}
}

func TestRenderServerConfig_BOTHExpandsUDPPlusOne(t *testing.T) {
	cfg, err := RenderServerConfig([]InboundView{{
		Inbound: Inbound{ID: 2, Tag: "landing-bb", Port: 3000, Protocol: "BOTH", Username: "bob", Password: "pw"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	binds := out["portBindings"].([]any)
	if len(binds) != 2 {
		t.Fatalf("want 2 bindings, got %s", cfg)
	}
	b0 := binds[0].(map[string]any)
	b1 := binds[1].(map[string]any)
	if b0["protocol"] != "TCP" || b0["port"] != float64(3000) {
		t.Fatalf("tcp bind: %#v", b0)
	}
	if b1["protocol"] != "UDP" || b1["port"] != float64(3001) {
		t.Fatalf("udp bind: %#v", b1)
	}
}

func TestRenderServerConfig_EmptyRejected(t *testing.T) {
	if _, err := RenderServerConfig(nil); err == nil {
		t.Fatal("expected error")
	}
}
