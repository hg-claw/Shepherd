package xray

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRenderTemplate_VLESSReality(t *testing.T) {
	out, err := RenderTemplate(TemplateRequest{
		Inbound:    "vless-reality",
		Port:       443,
		UUID:       "11111111-1111-1111-1111-111111111111",
		SNI:        "example.com",
		PublicKey:  "abc",
		PrivateKey: "def",
		ShortID:    "00",
	})
	if err != nil { t.Fatal(err) }
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil { t.Fatalf("invalid json: %v\n%s", err, out) }
	inbounds := m["inbounds"].([]any)
	if len(inbounds) != 1 { t.Fatalf("expected 1 inbound, got %d", len(inbounds)) }
	first := inbounds[0].(map[string]any)
	if first["port"].(float64) != 443 { t.Fatalf("port: %v", first["port"]) }
}

func TestRenderTemplate_RejectsUnknownInbound(t *testing.T) {
	_, err := RenderTemplate(TemplateRequest{Inbound: "nope"})
	if err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("expected unknown inbound error, got %v", err)
	}
}

func TestNormaliseRaw_AcceptsValidJSON(t *testing.T) {
	out, err := NormaliseRaw([]byte(`{"inbounds":[],"outbounds":[]}`))
	if err != nil { t.Fatal(err) }
	if !strings.Contains(string(out), `"inbounds"`) {
		t.Fatalf("output lost inbounds: %s", out)
	}
}

func TestNormaliseRaw_RejectsInvalidJSON(t *testing.T) {
	_, err := NormaliseRaw([]byte(`not json`))
	if err == nil { t.Fatal("expected error") }
}
