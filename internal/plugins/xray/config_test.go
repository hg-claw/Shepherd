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
	// sniffing must be enabled so xray can see SNI/host for dispatch.
	sn, ok := first["sniffing"].(map[string]any)
	if !ok || sn["enabled"] != true {
		t.Fatalf("sniffing missing or disabled: %v", first["sniffing"])
	}
	// freedom outbound must force UseIP so IPv6-only/v6-broken VPSes don't
	// stall on AsIs lookups.
	outs := m["outbounds"].([]any)
	ob := outs[0].(map[string]any)
	if ob["protocol"] != "freedom" {
		t.Fatalf("outbound protocol: %v", ob["protocol"])
	}
	settings, ok := ob["settings"].(map[string]any)
	if !ok || settings["domainStrategy"] != "UseIP" {
		t.Fatalf("outbound domainStrategy: %v", ob["settings"])
	}
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

func TestRenderTemplate_VLESSReality_Relay(t *testing.T) {
	out, err := RenderTemplate(TemplateRequest{
		Inbound: "vless-reality",
		Port:    443, UUID: "11111111-1111-1111-1111-111111111111",
		SNI: "example.com", PublicKey: "RPUB", PrivateKey: "RPRIV", ShortID: "ee",
		Topology: &TopologyRef{
			Role: "relay",
			Landing: &LandingRef{
				Address: "edge.example.com", Port: 8443,
				SNI: "www.icloud.com", UUID: "ll-uuid",
				PublicKey: "LPUB", ShortID: "ll",
			},
		},
	})
	if err != nil { t.Fatal(err) }
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil { t.Fatal(err) }

	// Inbound: relay's own creds.
	in := m["inbounds"].([]any)[0].(map[string]any)
	if in["port"].(float64) != 443 { t.Fatalf("inbound port: %v", in["port"]) }
	client := in["settings"].(map[string]any)["clients"].([]any)[0].(map[string]any)
	if client["id"] != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("relay inbound UUID = %v", client["id"])
	}

	// Outbound[0]: vless to landing.
	outs := m["outbounds"].([]any)
	o0 := outs[0].(map[string]any)
	if o0["protocol"] != "vless" || o0["tag"] != "to-landing" {
		t.Fatalf("outbound[0] = %v", o0)
	}
	vnext := o0["settings"].(map[string]any)["vnext"].([]any)[0].(map[string]any)
	if vnext["address"] != "edge.example.com" || vnext["port"].(float64) != 8443 {
		t.Fatalf("vnext addr/port: %v", vnext)
	}
	user := vnext["users"].([]any)[0].(map[string]any)
	if user["id"] != "ll-uuid" || user["flow"] != "xtls-rprx-vision" || user["encryption"] != "none" {
		t.Fatalf("vnext user: %v", user)
	}
	rs := o0["streamSettings"].(map[string]any)["realitySettings"].(map[string]any)
	if rs["serverName"] != "www.icloud.com" || rs["publicKey"] != "LPUB" || rs["shortId"] != "ll" {
		t.Fatalf("reality client fields: %v", rs)
	}
	if rs["fingerprint"] != "chrome" {
		t.Fatalf("expected fingerprint=chrome got %v", rs["fingerprint"])
	}

	// Outbound[1]: direct.
	o1 := outs[1].(map[string]any)
	if o1["protocol"] != "freedom" || o1["tag"] != "direct" {
		t.Fatalf("outbound[1] = %v", o1)
	}

	// Routing: private IPs go to direct.
	routing := m["routing"].(map[string]any)
	rules := routing["rules"].([]any)
	r0 := rules[0].(map[string]any)
	if r0["outboundTag"] != "direct" {
		t.Fatalf("private routing rule = %v", r0)
	}
}

func TestRenderTemplate_VLESSReality_Landing_UnchangedShape(t *testing.T) {
	// Without Topology (or with role=landing), output must match Task 0 shape:
	// no routing block, freedom outbound has UseIP.
	out, _ := RenderTemplate(TemplateRequest{
		Inbound: "vless-reality",
		Port: 443, UUID: "u", SNI: "s", PublicKey: "p", PrivateKey: "k", ShortID: "00",
	})
	var m map[string]any
	_ = json.Unmarshal(out, &m)
	if _, has := m["routing"]; has {
		t.Fatalf("landing config must not have routing block")
	}
	o0 := m["outbounds"].([]any)[0].(map[string]any)
	if o0["protocol"] != "freedom" {
		t.Fatalf("landing outbound must be freedom, got %v", o0["protocol"])
	}
}
