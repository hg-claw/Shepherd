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
	if len(inbounds) != 1 { t.Fatalf("inbounds count = %d", len(inbounds)) }
	first := inbounds[0].(map[string]any)
	if first["tag"] != "landing-aa" { t.Fatalf("tag = %v", first["tag"]) }
	outbounds := m["outbounds"].([]any)
	if len(outbounds) != 1 || outbounds[0].(map[string]any)["protocol"] != "freedom" {
		t.Fatalf("expected only freedom outbound, got %v", outbounds)
	}
	if _, has := m["routing"]; has {
		t.Fatalf("landing-only config must not have routing block")
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
	if len(rules) != 2 {
		t.Fatalf("rules = %d, want 2 (relay-bb + geoip:private)", len(rules))
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
	if len((m["inbounds"]).([]any)) != 3 { t.Fatalf("inbounds count") }
	outs := m["outbounds"].([]any)
	if len(outs) != 3 {
		t.Fatalf("outbounds = %d, want 3 (to-landing-x + to-landing-y + freedom)", len(outs))
	}
	rules := m["routing"].(map[string]any)["rules"].([]any)
	if len(rules) != 3 {
		t.Fatalf("rules = %d, want 3 (relay-bb + relay-cc + geoip:private)", len(rules))
	}
}

func TestRenderServerConfig_EmptyReturnsError(t *testing.T) {
	_, err := RenderServerConfig(nil)
	if err == nil { t.Fatalf("expected error for empty inbounds") }
}
