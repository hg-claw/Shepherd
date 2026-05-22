package singbox

import (
	"database/sql"
	"encoding/json"
	"testing"
)

// ── Shared test helpers ──────────────────────────────────────────────────────

func fakeCertView(id int64, domain string) CertView {
	return CertView{ID: id, Domain: domain, CertPEM: "CERT", KeyPEM: "KEY"}
}

// ── Landing fixtures ─────────────────────────────────────────────────────────

func mkVlessRealityLanding() InboundView {
	return InboundView{
		Inbound: Inbound{
			ID: 1, ServerID: 1, Tag: "landing-a1b2c3d4", Port: 443,
			Role: "landing", Protocol: "vless-reality",
			UUID:                   ptrStr("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"),
			Flow:                   ptrStr("xtls-rprx-vision"),
			SNI:                    ptrStr("www.icloud.com"),
			RealityPrivateKey:      ptrStr("PRIVKEY"),
			RealityPublicKey:       ptrStr("PUBKEY"),
			RealityShortID:         ptrStr("aabb1122"),
			RealityHandshakeServer: ptrStr("www.icloud.com"),
			RealityHandshakePort:   ptrI64(443),
		},
		ServerName: "s1",
	}
}

// ── Core topology tests ──────────────────────────────────────────────────────

func TestRenderServerConfig_ErrorOnEmpty(t *testing.T) {
	_, err := RenderServerConfig(nil, nil)
	if err == nil {
		t.Fatal("expected error on empty inbounds")
	}
}

func TestRenderServerConfig_VlessRealityFlowDefaultsToVision(t *testing.T) {
	// REALITY pairs with xtls-rprx-vision; if the DB row has no flow set,
	// render must default it so the server matches the share URL clients
	// see (which always advertises flow=xtls-rprx-vision). Without this
	// default sing-box rejects connections with "flow mismatch".
	in := mkVlessRealityLanding()
	in.Flow = nil
	cfg, err := RenderServerConfig([]InboundView{in}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(cfg, &out); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	users := out["inbounds"].([]any)[0].(map[string]any)["users"].([]any)
	user := users[0].(map[string]any)
	if user["flow"] != "xtls-rprx-vision" {
		t.Errorf("user.flow = %v, want xtls-rprx-vision", user["flow"])
	}
}

func TestRenderServerConfig_VlessRealityLanding(t *testing.T) {
	cfg, err := RenderServerConfig([]InboundView{mkVlessRealityLanding()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(cfg, &out); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, cfg)
	}
	for _, key := range []string{"log", "dns", "inbounds", "outbounds", "route", "experimental"} {
		if _, ok := out[key]; !ok {
			t.Errorf("missing top-level key %q", key)
		}
	}
	inbounds := out["inbounds"].([]any)
	if len(inbounds) != 1 {
		t.Fatalf("want 1 inbound, got %d", len(inbounds))
	}
	ib := inbounds[0].(map[string]any)
	if ib["type"] != "vless" {
		t.Errorf("inbound type: got %v", ib["type"])
	}
	if ib["tag"] != "landing-a1b2c3d4" {
		t.Errorf("inbound tag: got %v", ib["tag"])
	}
	tls := ib["tls"].(map[string]any)
	if tls["enabled"] != true {
		t.Errorf("tls.enabled not true")
	}
	reality := tls["reality"].(map[string]any)
	if reality["enabled"] != true {
		t.Errorf("reality.enabled not true")
	}
	exp := out["experimental"].(map[string]any)
	clashAPI := exp["clash_api"].(map[string]any)
	if clashAPI["external_controller"] != "127.0.0.1:29090" {
		t.Errorf("clash_api port: got %v", clashAPI["external_controller"])
	}
	// sing-box 1.12+ requires experimental.cache_file alongside clash_api
	// for the HTTP server to actually bind.
	cacheFile, ok := exp["cache_file"].(map[string]any)
	if !ok || cacheFile["enabled"] != true {
		t.Errorf("experimental.cache_file.enabled not true: got %v", exp["cache_file"])
	}
	route := out["route"].(map[string]any)
	// sing-box 1.13 FATAL-rejects configs missing route.default_domain_resolver.
	if route["default_domain_resolver"] != "dns-remote" {
		t.Errorf("route.default_domain_resolver = %v, want \"dns-remote\"", route["default_domain_resolver"])
	}
	rules := route["rules"].([]any)
	hasGeoIP := false
	for _, r := range rules {
		rm := r.(map[string]any)
		if _, ok := rm["ip_cidr"]; ok {
			hasGeoIP = true
		}
	}
	if !hasGeoIP {
		t.Errorf("missing ip_cidr rule in route.rules")
	}
}

// ── Per-protocol landing tests ───────────────────────────────────────────────

func TestRender_VlessWSTLS(t *testing.T) {
	certID := int64(10)
	iv := InboundView{Inbound: Inbound{
		ID: 2, ServerID: 1, Tag: "landing-b2c3d4e5", Port: 8443,
		Role: "landing", Protocol: "vless-ws-tls",
		UUID:          ptrStr("uuid-vless-ws"),
		SNI:           ptrStr("proxy.example.com"),
		CertID:        &certID,
		TransportPath: ptrStr("/vless"),
		TransportHost: ptrStr("proxy.example.com"),
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, []CertView{fakeCertView(certID, "proxy.example.com")})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "vless" {
		t.Errorf("type: %v", ib["type"])
	}
	tls := ib["tls"].(map[string]any)
	if tls["certificate_path"] != "/etc/shepherd-singbox/certs/proxy.example.com.crt" {
		t.Errorf("cert path: %v", tls["certificate_path"])
	}
	tr := ib["transport"].(map[string]any)
	if tr["type"] != "ws" || tr["path"] != "/vless" {
		t.Errorf("transport: %v", tr)
	}
}

func TestRender_VlessH2TLS(t *testing.T) {
	certID := int64(11)
	iv := InboundView{Inbound: Inbound{
		ID: 3, ServerID: 1, Tag: "landing-c3d4e5f6", Port: 8444,
		Role: "landing", Protocol: "vless-h2-tls",
		UUID:          ptrStr("uuid-vless-h2"),
		SNI:           ptrStr("proxy.example.com"),
		CertID:        &certID,
		TransportPath: ptrStr("/vless"),
		TransportHost: ptrStr("proxy.example.com"),
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, []CertView{fakeCertView(certID, "proxy.example.com")})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "vless" {
		t.Errorf("type: %v", ib["type"])
	}
	tr := ib["transport"].(map[string]any)
	if tr["type"] != "http" {
		t.Errorf("h2 transport type: %v", tr["type"])
	}
	// host is []any for http transport
	host := tr["host"].([]any)
	if len(host) == 0 || host[0] != "proxy.example.com" {
		t.Errorf("h2 host: %v", host)
	}
}

func TestRender_VlessHTTPUpgradeTLS(t *testing.T) {
	certID := int64(12)
	iv := InboundView{Inbound: Inbound{
		ID: 4, ServerID: 1, Tag: "landing-d4e5f6a7", Port: 8445,
		Role: "landing", Protocol: "vless-httpupgrade-tls",
		UUID:          ptrStr("uuid-vless-hu"),
		SNI:           ptrStr("proxy.example.com"),
		CertID:        &certID,
		TransportPath: ptrStr("/vless"),
		TransportHost: ptrStr("proxy.example.com"),
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, []CertView{fakeCertView(certID, "proxy.example.com")})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	tr := ib["transport"].(map[string]any)
	if tr["type"] != "httpupgrade" {
		t.Errorf("transport type: %v", tr["type"])
	}
	// host is string for httpupgrade
	if tr["host"] != "proxy.example.com" {
		t.Errorf("host: %v", tr["host"])
	}
}

func TestRender_VmessTCP(t *testing.T) {
	iv := InboundView{Inbound: Inbound{
		ID: 5, ServerID: 1, Tag: "landing-e5f6a7b8", Port: 10086,
		Role: "landing", Protocol: "vmess-tcp",
		UUID:    ptrStr("uuid-vmess"),
		AlterID: ptrI64(0),
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "vmess" {
		t.Errorf("type: %v", ib["type"])
	}
	u := ib["users"].([]any)[0].(map[string]any)
	if u["alterId"] != float64(0) {
		t.Errorf("alterId: %v", u["alterId"])
	}
	if _, hasTLS := ib["tls"]; hasTLS {
		t.Error("vmess-tcp must not have tls block")
	}
}

func TestRender_VmessHTTP(t *testing.T) {
	iv := InboundView{Inbound: Inbound{
		ID: 6, ServerID: 1, Tag: "landing-f6a7b8c9", Port: 8080,
		Role: "landing", Protocol: "vmess-http",
		UUID:          ptrStr("uuid-vmess-http"),
		AlterID:       ptrI64(0),
		TransportPath: ptrStr("/"),
		TransportHost: ptrStr("target.example.com"),
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "vmess" {
		t.Errorf("type: %v", ib["type"])
	}
	tr := ib["transport"].(map[string]any)
	if tr["type"] != "http" {
		t.Errorf("transport type: %v", tr["type"])
	}
	if _, hasTLS := ib["tls"]; hasTLS {
		t.Error("vmess-http must not have tls block")
	}
}

func TestRender_VmessQUIC(t *testing.T) {
	iv := InboundView{Inbound: Inbound{
		ID: 7, ServerID: 1, Tag: "landing-a7b8c9d0", Port: 10443,
		Role: "landing", Protocol: "vmess-quic",
		UUID:    ptrStr("uuid-vmess-quic"),
		AlterID: ptrI64(0),
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "vmess" {
		t.Errorf("type: %v", ib["type"])
	}
	tr := ib["transport"].(map[string]any)
	if tr["type"] != "quic" {
		t.Errorf("transport type: %v", tr["type"])
	}
}

func TestRender_VmessWSTLS(t *testing.T) {
	certID := int64(20)
	iv := InboundView{Inbound: Inbound{
		ID: 8, ServerID: 1, Tag: "landing-b8c9d0e1", Port: 443,
		Role: "landing", Protocol: "vmess-ws-tls",
		UUID:          ptrStr("uuid-vmess-ws"),
		AlterID:       ptrI64(0),
		SNI:           ptrStr("proxy.example.com"),
		CertID:        &certID,
		TransportPath: ptrStr("/vmess"),
		TransportHost: ptrStr("proxy.example.com"),
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, []CertView{fakeCertView(certID, "proxy.example.com")})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "vmess" {
		t.Errorf("type: %v", ib["type"])
	}
	tls := ib["tls"].(map[string]any)
	if tls["enabled"] != true {
		t.Error("tls.enabled not true")
	}
	tr := ib["transport"].(map[string]any)
	if tr["type"] != "ws" {
		t.Errorf("transport type: %v", tr["type"])
	}
}

func TestRender_VmessH2TLS(t *testing.T) {
	certID := int64(21)
	iv := InboundView{Inbound: Inbound{
		ID: 9, ServerID: 1, Tag: "landing-c9d0e1f2", Port: 8444,
		Role: "landing", Protocol: "vmess-h2-tls",
		UUID:          ptrStr("uuid-vmess-h2"),
		AlterID:       ptrI64(0),
		SNI:           ptrStr("proxy.example.com"),
		CertID:        &certID,
		TransportPath: ptrStr("/vmess"),
		TransportHost: ptrStr("proxy.example.com"),
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, []CertView{fakeCertView(certID, "proxy.example.com")})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "vmess" {
		t.Errorf("type: %v", ib["type"])
	}
	tr := ib["transport"].(map[string]any)
	if tr["type"] != "http" {
		t.Errorf("transport type: %v", tr["type"])
	}
}

func TestRender_VmessHTTPUpgradeTLS(t *testing.T) {
	certID := int64(22)
	iv := InboundView{Inbound: Inbound{
		ID: 10, ServerID: 1, Tag: "landing-d0e1f2a3", Port: 8445,
		Role: "landing", Protocol: "vmess-httpupgrade-tls",
		UUID:          ptrStr("uuid-vmess-hu"),
		AlterID:       ptrI64(0),
		SNI:           ptrStr("proxy.example.com"),
		CertID:        &certID,
		TransportPath: ptrStr("/vmess"),
		TransportHost: ptrStr("proxy.example.com"),
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, []CertView{fakeCertView(certID, "proxy.example.com")})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "vmess" {
		t.Errorf("type: %v", ib["type"])
	}
	tr := ib["transport"].(map[string]any)
	if tr["type"] != "httpupgrade" {
		t.Errorf("transport type: %v", tr["type"])
	}
}

func TestRender_TrojanTLS(t *testing.T) {
	certID := int64(30)
	iv := InboundView{Inbound: Inbound{
		ID: 11, ServerID: 1, Tag: "landing-e1f2a3b4", Port: 443,
		Role: "landing", Protocol: "trojan-tls",
		Password: ptrStr("trojan_pass"),
		SNI:      ptrStr("proxy.example.com"),
		CertID:   &certID,
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, []CertView{fakeCertView(certID, "proxy.example.com")})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "trojan" {
		t.Errorf("type: %v", ib["type"])
	}
	u := ib["users"].([]any)[0].(map[string]any)
	if u["password"] != "trojan_pass" {
		t.Errorf("password: %v", u["password"])
	}
	if _, hasTransport := ib["transport"]; hasTransport {
		t.Error("trojan-tls must not have transport block")
	}
}

func TestRender_TrojanWSTLS(t *testing.T) {
	certID := int64(31)
	iv := InboundView{Inbound: Inbound{
		ID: 12, ServerID: 1, Tag: "landing-f2a3b4c5", Port: 443,
		Role: "landing", Protocol: "trojan-ws-tls",
		Password:      ptrStr("trojan_pass"),
		SNI:           ptrStr("proxy.example.com"),
		CertID:        &certID,
		TransportPath: ptrStr("/trojan"),
		TransportHost: ptrStr("proxy.example.com"),
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, []CertView{fakeCertView(certID, "proxy.example.com")})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	tr := ib["transport"].(map[string]any)
	if tr["type"] != "ws" || tr["path"] != "/trojan" {
		t.Errorf("transport: %v", tr)
	}
}

func TestRender_TrojanH2TLS(t *testing.T) {
	certID := int64(32)
	iv := InboundView{Inbound: Inbound{
		ID: 13, ServerID: 1, Tag: "landing-a3b4c5d6", Port: 8443,
		Role: "landing", Protocol: "trojan-h2-tls",
		Password:      ptrStr("trojan_pass"),
		SNI:           ptrStr("proxy.example.com"),
		CertID:        &certID,
		TransportPath: ptrStr("/trojan"),
		TransportHost: ptrStr("proxy.example.com"),
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, []CertView{fakeCertView(certID, "proxy.example.com")})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	tr := ib["transport"].(map[string]any)
	if tr["type"] != "http" {
		t.Errorf("transport type: %v", tr["type"])
	}
	host := tr["host"].([]any)
	if len(host) == 0 || host[0] != "proxy.example.com" {
		t.Errorf("host: %v", host)
	}
}

func TestRender_TrojanHTTPUpgradeTLS(t *testing.T) {
	certID := int64(33)
	iv := InboundView{Inbound: Inbound{
		ID: 14, ServerID: 1, Tag: "landing-b4c5d6e7", Port: 8444,
		Role: "landing", Protocol: "trojan-httpupgrade-tls",
		Password:      ptrStr("trojan_pass"),
		SNI:           ptrStr("proxy.example.com"),
		CertID:        &certID,
		TransportPath: ptrStr("/trojan"),
		TransportHost: ptrStr("proxy.example.com"),
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, []CertView{fakeCertView(certID, "proxy.example.com")})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	tr := ib["transport"].(map[string]any)
	if tr["type"] != "httpupgrade" {
		t.Errorf("transport type: %v", tr["type"])
	}
}

func TestRender_Hysteria2(t *testing.T) {
	certID := int64(40)
	extra := `{"up_mbps":100,"down_mbps":200}`
	iv := InboundView{Inbound: Inbound{
		ID: 15, ServerID: 1, Tag: "landing-c5d6e7f8", Port: 36712,
		Role: "landing", Protocol: "hysteria2",
		Password:  ptrStr("hy2_pass"),
		SNI:       ptrStr("hy2.example.com"),
		CertID:    &certID,
		ExtraJSON: &extra,
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, []CertView{fakeCertView(certID, "hy2.example.com")})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "hysteria2" {
		t.Errorf("type: %v", ib["type"])
	}
	if ib["up_mbps"] != float64(100) {
		t.Errorf("up_mbps: %v", ib["up_mbps"])
	}
	if ib["down_mbps"] != float64(200) {
		t.Errorf("down_mbps: %v", ib["down_mbps"])
	}
}

func TestRender_TUICV5(t *testing.T) {
	certID := int64(50)
	extra := `{"congestion_control":"bbr","auth_timeout":"3s"}`
	iv := InboundView{Inbound: Inbound{
		ID: 16, ServerID: 1, Tag: "landing-d6e7f8a9", Port: 36713,
		Role: "landing", Protocol: "tuic-v5",
		UUID:      ptrStr("22222222-2222-2222-2222-222222222222"),
		Password:  ptrStr("tuic_pass"),
		SNI:       ptrStr("tuic.example.com"),
		CertID:    &certID,
		ExtraJSON: &extra,
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, []CertView{fakeCertView(certID, "tuic.example.com")})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "tuic" {
		t.Errorf("type: %v", ib["type"])
	}
	if ib["congestion_control"] != "bbr" {
		t.Errorf("congestion_control: %v", ib["congestion_control"])
	}
	tls := ib["tls"].(map[string]any)
	alpn := tls["alpn"].([]any)
	if len(alpn) == 0 || alpn[0] != "h3" {
		t.Errorf("alpn: %v", alpn)
	}
}

func TestRender_AnyTLS(t *testing.T) {
	certID := int64(60)
	iv := InboundView{Inbound: Inbound{
		ID: 17, ServerID: 1, Tag: "landing-e7f8a9b0", Port: 8443,
		Role: "landing", Protocol: "anytls",
		Password: ptrStr("anytls_pass"),
		SNI:      ptrStr("anytls.example.com"),
		CertID:   &certID,
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, []CertView{fakeCertView(certID, "anytls.example.com")})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "anytls" {
		t.Errorf("type: %v", ib["type"])
	}
	u := ib["users"].([]any)[0].(map[string]any)
	if u["password"] != "anytls_pass" {
		t.Errorf("password: %v", u["password"])
	}
}

func TestRender_SS2022(t *testing.T) {
	iv := InboundView{Inbound: Inbound{
		ID: 18, ServerID: 1, Tag: "landing-f8a9b0c1", Port: 8388,
		Role: "landing", Protocol: "shadowsocks-2022",
		Password: ptrStr("base64key=="),
		SSMethod: ptrStr("2022-blake3-aes-128-gcm"),
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "shadowsocks" {
		t.Errorf("type: %v", ib["type"])
	}
	if ib["method"] != "2022-blake3-aes-128-gcm" {
		t.Errorf("method: %v", ib["method"])
	}
	if ib["password"] != "base64key==" {
		t.Errorf("password: %v", ib["password"])
	}
	if _, hasTLS := ib["tls"]; hasTLS {
		t.Error("shadowsocks-2022 must not have tls block")
	}
}

// ── Relay outbound tests ─────────────────────────────────────────────────────

func TestRender_VlessRealityRelay(t *testing.T) {
	landing := mkVlessRealityLanding()
	upID := int64(1)
	relay := InboundView{
		Inbound: Inbound{
			ID: 100, ServerID: 2, Tag: "relay-e5f6a7b8", Port: 8443,
			Role: "relay", Protocol: "vless-reality",
			UUID:                   ptrStr("relay-uuid"),
			Flow:                   ptrStr("xtls-rprx-vision"),
			SNI:                    ptrStr("relay.example.com"),
			RealityPublicKey:       ptrStr("RELAYPUB"),
			RealityShortID:         ptrStr("relay123"),
			RealityHandshakeServer: ptrStr("relay.example.com"),
			RealityHandshakePort:   ptrI64(443),
			UpstreamInboundID:      &upID,
		},
		ServerName:               "s2",
		UpstreamTag:              sql.NullString{String: "landing-a1b2c3d4", Valid: true},
		UpstreamPort:             sql.NullInt64{Int64: 443, Valid: true},
		UpstreamServerID:         sql.NullInt64{Int64: 1, Valid: true},
		UpstreamServerName:       sql.NullString{String: "s1", Valid: true},
		UpstreamAddress:          sql.NullString{String: "landing.example.com", Valid: true},
		UpstreamProtocol:         sql.NullString{String: "vless-reality", Valid: true},
		UpstreamUUID:             sql.NullString{String: "upstream-uuid", Valid: true},
		UpstreamSNI:              sql.NullString{String: "www.icloud.com", Valid: true},
		UpstreamRealityPublicKey: sql.NullString{String: "UPPUB", Valid: true},
		UpstreamRealityShortID:   sql.NullString{String: "aabb1122", Valid: true},
	}
	cfg, err := RenderServerConfig([]InboundView{landing, relay}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	outbounds := out["outbounds"].([]any)
	var relayOB map[string]any
	for _, o := range outbounds {
		om := o.(map[string]any)
		if om["tag"] == "to-landing-a1b2c3d4" {
			relayOB = om
		}
	}
	if relayOB == nil {
		t.Fatal("to-landing-a1b2c3d4 not found")
	}
	if relayOB["type"] != "vless" {
		t.Errorf("type: %v", relayOB["type"])
	}
	tls := relayOB["tls"].(map[string]any)
	reality := tls["reality"].(map[string]any)
	if reality["public_key"] != "UPPUB" {
		t.Errorf("public_key: %v", reality["public_key"])
	}
	utls := tls["utls"].(map[string]any)
	if utls["fingerprint"] != "chrome" {
		t.Errorf("utls fingerprint: %v", utls["fingerprint"])
	}
	rules := out["route"].(map[string]any)["rules"].([]any)
	found := false
	for _, r := range rules {
		if inb, ok := r.(map[string]any)["inbound"].([]any); ok {
			for _, tag := range inb {
				if tag == "relay-e5f6a7b8" {
					found = true
				}
			}
		}
	}
	if !found {
		t.Error("route rule for relay not found")
	}
}

func TestRender_Hysteria2Relay(t *testing.T) {
	certID := int64(40)
	extra := `{"up_mbps":100,"down_mbps":200}`
	landing := InboundView{Inbound: Inbound{
		ID: 15, ServerID: 1, Tag: "landing-c5d6e7f8", Port: 36712,
		Role: "landing", Protocol: "hysteria2",
		Password:  ptrStr("hy2_pass"),
		SNI:       ptrStr("hy2.example.com"),
		CertID:    &certID,
		ExtraJSON: &extra,
	}, ServerName: "s1"}
	relayUID := int64(15)
	relay := InboundView{
		Inbound: Inbound{
			ID: 200, ServerID: 2, Tag: "relay-hy2-0001", Port: 36713,
			Role: "relay", Protocol: "hysteria2",
			Password:          ptrStr("relay-hy2"),
			SNI:               ptrStr("relay.example.com"),
			CertID:            &certID,
			ExtraJSON:         &extra,
			UpstreamInboundID: &relayUID,
		},
		ServerName:         "s2",
		UpstreamTag:        sql.NullString{String: "landing-c5d6e7f8", Valid: true},
		UpstreamPort:       sql.NullInt64{Int64: 36712, Valid: true},
		UpstreamServerID:   sql.NullInt64{Int64: 1, Valid: true},
		UpstreamServerName: sql.NullString{String: "s1", Valid: true},
		UpstreamAddress:    sql.NullString{String: "landing.example.com", Valid: true},
		UpstreamProtocol:   sql.NullString{String: "hysteria2", Valid: true},
		UpstreamPassword:   sql.NullString{String: "hy2_pass", Valid: true},
		UpstreamSNI:        sql.NullString{String: "hy2.example.com", Valid: true},
		UpstreamExtraJSON:  sql.NullString{String: extra, Valid: true},
	}
	cfg, err := RenderServerConfig([]InboundView{landing, relay}, []CertView{fakeCertView(certID, "hy2.example.com")})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	var hy2OB map[string]any
	for _, o := range out["outbounds"].([]any) {
		om := o.(map[string]any)
		if om["tag"] == "to-landing-c5d6e7f8" {
			hy2OB = om
		}
	}
	if hy2OB == nil {
		t.Fatal("to-landing-c5d6e7f8 not found")
	}
	if hy2OB["type"] != "hysteria2" {
		t.Errorf("type: %v", hy2OB["type"])
	}
	if hy2OB["up_mbps"] != float64(100) {
		t.Errorf("up_mbps: %v", hy2OB["up_mbps"])
	}
}

func TestRender_SS2022Relay(t *testing.T) {
	landing := InboundView{Inbound: Inbound{
		ID: 18, ServerID: 1, Tag: "landing-f8a9b0c1", Port: 8388,
		Role: "landing", Protocol: "shadowsocks-2022",
		Password: ptrStr("base64key=="),
		SSMethod: ptrStr("2022-blake3-aes-128-gcm"),
	}, ServerName: "s1"}
	relayUID := int64(18)
	relay := InboundView{
		Inbound: Inbound{
			ID: 201, ServerID: 2, Tag: "relay-ss2022-0001", Port: 8389,
			Role: "relay", Protocol: "shadowsocks-2022",
			Password:          ptrStr("relay-key=="),
			SSMethod:          ptrStr("2022-blake3-aes-128-gcm"),
			UpstreamInboundID: &relayUID,
		},
		ServerName:         "s2",
		UpstreamTag:        sql.NullString{String: "landing-f8a9b0c1", Valid: true},
		UpstreamPort:       sql.NullInt64{Int64: 8388, Valid: true},
		UpstreamServerID:   sql.NullInt64{Int64: 1, Valid: true},
		UpstreamServerName: sql.NullString{String: "s1", Valid: true},
		UpstreamAddress:    sql.NullString{String: "landing.example.com", Valid: true},
		UpstreamProtocol:   sql.NullString{String: "shadowsocks-2022", Valid: true},
		UpstreamPassword:   sql.NullString{String: "base64key==", Valid: true},
		UpstreamSSMethod:   sql.NullString{String: "2022-blake3-aes-128-gcm", Valid: true},
	}
	cfg, err := RenderServerConfig([]InboundView{landing, relay}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	_ = json.Unmarshal(cfg, &out)
	var ssOB map[string]any
	for _, o := range out["outbounds"].([]any) {
		om := o.(map[string]any)
		if om["tag"] == "to-landing-f8a9b0c1" {
			ssOB = om
		}
	}
	if ssOB == nil {
		t.Fatal("to-landing-f8a9b0c1 not found")
	}
	if ssOB["type"] != "shadowsocks" {
		t.Errorf("type: %v", ssOB["type"])
	}
	if ssOB["method"] != "2022-blake3-aes-128-gcm" {
		t.Errorf("method: %v", ssOB["method"])
	}
}
