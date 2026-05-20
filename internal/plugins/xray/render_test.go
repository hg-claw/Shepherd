package xray

import (
	"database/sql"
	"encoding/json"
	"testing"
)

func mkLandingView(id int64, tag string, port int, sni, uuid, pub, priv, sid string) InboundView {
	return InboundView{
		Inbound: Inbound{
			ID: id, ServerID: 1, Tag: tag, Port: port, Role: "landing",
			Protocol: "vless-reality",
			UUID: uuid, SNI: sni, PublicKey: pub, PrivateKey: priv, ShortID: sid,
		},
		ServerName: "s1",
	}
}

func mkRelayView(id, upstreamID int64, tag string, port int, sni, uuid, pub, priv, sid,
	upTag, upSNI, upUUID, upPub, upSID, upAddr string, upPort int64) InboundView {
	upID := upstreamID
	return InboundView{
		Inbound: Inbound{
			ID: id, ServerID: 2, Tag: tag, Port: port, Role: "relay",
			Protocol: "vless-reality",
			UUID: uuid, SNI: sni, PublicKey: pub, PrivateKey: priv, ShortID: sid,
			UpstreamInboundID: &upID,
		},
		ServerName: "s2",
		UpstreamTag:        sql.NullString{String: upTag, Valid: true},
		UpstreamPort:       sql.NullInt64{Int64: upPort, Valid: true},
		UpstreamServerID:   sql.NullInt64{Int64: 1, Valid: true},
		UpstreamServerName: sql.NullString{String: "s1", Valid: true},
		UpstreamSNI:        sql.NullString{String: upSNI, Valid: true},
		UpstreamUUID:       sql.NullString{String: upUUID, Valid: true},
		UpstreamPublicKey:  sql.NullString{String: upPub, Valid: true},
		UpstreamShortID:    sql.NullString{String: upSID, Valid: true},
		UpstreamAddress:    sql.NullString{String: upAddr, Valid: true},
	}
}

func TestRenderServerConfig_OnlyLanding(t *testing.T) {
	out, err := RenderServerConfig([]InboundView{
		mkLandingView(1, "landing-aa", 443, "www.lovelive-anime.jp", "u1", "P1", "K1", "s1"),
	})
	if err != nil { t.Fatal(err) }
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil { t.Fatal(err) }
	inbounds := m["inbounds"].([]any)
	// 1 user inbound + 1 __shepherd_api__ inbound always injected
	if len(inbounds) != 2 { t.Fatalf("inbounds count = %d, want 2 (landing + api)", len(inbounds)) }
	first := inbounds[0].(map[string]any)
	if first["tag"] != "landing-aa" { t.Fatalf("tag = %v", first["tag"]) }
	outbounds := m["outbounds"].([]any)
	if len(outbounds) != 1 || outbounds[0].(map[string]any)["protocol"] != "freedom" {
		t.Fatalf("expected only freedom outbound, got %v", outbounds)
	}
	// Landing-only config still has a routing block because the api inbound
	// always needs an explicit rule mapping its tag → api outbound.
	routing, ok := m["routing"].(map[string]any)
	if !ok {
		t.Fatalf("expected routing block (for api inbound rule)")
	}
	rules := routing["rules"].([]any)
	if len(rules) != 1 {
		t.Fatalf("landing-only should have exactly 1 routing rule (api), got %d", len(rules))
	}
	apiRule := rules[0].(map[string]any)
	if apiRule["outboundTag"] != "__shepherd_api__" {
		t.Fatalf("api rule outboundTag = %v", apiRule["outboundTag"])
	}
}

func TestRenderServerConfig_OnlyRelay(t *testing.T) {
	out, err := RenderServerConfig([]InboundView{
		mkRelayView(2, 1, "relay-bb", 8443, "www.microsoft.com", "u2", "P2", "K2", "s2",
			"landing-aa", "www.lovelive-anime.jp", "u1", "P1", "s1", "server-y.example.com", 443),
	})
	if err != nil { t.Fatal(err) }
	var m map[string]any
	_ = json.Unmarshal(out, &m)
	outbounds := m["outbounds"].([]any)
	if len(outbounds) != 2 {
		t.Fatalf("outbounds = %d, want 2 (to-landing-aa + freedom)", len(outbounds))
	}
	if outbounds[0].(map[string]any)["tag"] != "to-landing-aa" {
		t.Fatalf("outbound[0] tag = %v", outbounds[0].(map[string]any)["tag"])
	}
	rules := m["routing"].(map[string]any)["rules"].([]any)
	if len(rules) != 3 {
		t.Fatalf("rules = %d, want 3 (relay-bb + api + geoip:private)", len(rules))
	}
	r0 := rules[0].(map[string]any)
	tags := r0["inboundTag"].([]any)
	if len(tags) != 1 || tags[0] != "relay-bb" {
		t.Fatalf("rule 0 inboundTag = %v", tags)
	}
}

func TestRenderServerConfig_MixedLandingAndRelays(t *testing.T) {
	out, err := RenderServerConfig([]InboundView{
		mkLandingView(1, "landing-aa", 443, "www.lovelive-anime.jp", "ul", "PL", "KL", "sl"),
		mkRelayView(2, 10, "relay-bb", 8443, "www.microsoft.com", "u2", "P2", "K2", "s2",
			"landing-x", "www.apple.com", "u-x", "P-X", "s-x", "x.example.com", 443),
		mkRelayView(3, 11, "relay-cc", 9443, "www.apple.com", "u3", "P3", "K3", "s3",
			"landing-y", "www.swift.org", "u-y", "P-Y", "s-y", "y.example.com", 8443),
	})
	if err != nil { t.Fatal(err) }
	var m map[string]any
	_ = json.Unmarshal(out, &m)
	// 3 user inbounds (1 landing + 2 relays) + 1 __shepherd_api__ inbound always injected
	if len((m["inbounds"]).([]any)) != 4 { t.Fatalf("inbounds count = %d, want 4 (3 user + api)", len((m["inbounds"]).([]any))) }
	outs := m["outbounds"].([]any)
	if len(outs) != 3 {
		t.Fatalf("outbounds = %d, want 3 (to-landing-x + to-landing-y + freedom)", len(outs))
	}
	rules := m["routing"].(map[string]any)["rules"].([]any)
	if len(rules) != 4 {
		t.Fatalf("rules = %d, want 4 (relay-bb + relay-cc + api + geoip:private)", len(rules))
	}
}

func TestRenderServerConfig_EmptyReturnsError(t *testing.T) {
	_, err := RenderServerConfig(nil)
	if err == nil { t.Fatalf("expected error for empty inbounds") }
}

func TestRenderServerConfig_InjectsStatsAndAPIInbound(t *testing.T) {
	out, err := RenderServerConfig([]InboundView{
		mkLandingView(1, "landing-aabbccdd", 443, "www.example.com",
			"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "pubkey1", "privkey1", "aabb1122"),
	})
	if err != nil {
		t.Fatal(err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(out, &cfg); err != nil {
		t.Fatal(err)
	}
	// stats block present
	if _, ok := cfg["stats"]; !ok {
		t.Error("missing 'stats' block")
	}
	// api block present with correct tag
	apiBlock, ok := cfg["api"].(map[string]any)
	if !ok {
		t.Fatal("missing 'api' block or wrong type")
	}
	if apiBlock["tag"] != "__shepherd_api__" {
		t.Errorf("api.tag = %v, want __shepherd_api__", apiBlock["tag"])
	}
	// __shepherd_api__ inbound present in inbounds array
	inbs, _ := cfg["inbounds"].([]any)
	found := false
	for _, ib := range inbs {
		m, _ := ib.(map[string]any)
		if m["tag"] == "__shepherd_api__" {
			found = true
			listen, _ := m["listen"].(string)
			if listen != "127.0.0.1" {
				t.Errorf("api inbound listen = %q, want 127.0.0.1", listen)
			}
			port, _ := m["port"].(float64)
			if port != 28085 {
				t.Errorf("api inbound port = %v, want 28085", m["port"])
			}
		}
	}
	if !found {
		t.Error("__shepherd_api__ inbound not injected into inbounds array")
	}
	// policy.system block present with all four stats flags
	policy, _ := cfg["policy"].(map[string]any)
	system, _ := policy["system"].(map[string]any)
	for _, key := range []string{"statsInboundUplink", "statsInboundDownlink", "statsOutboundUplink", "statsOutboundDownlink"} {
		if v, _ := system[key].(bool); !v {
			t.Errorf("policy.system.%s not true", key)
		}
	}
}
