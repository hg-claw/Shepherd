package singbox

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const (
	clashAPIAddr = "127.0.0.1:29090"
	// v2RayAPIAddr is where sing-box's gRPC stats service listens. Loopback
	// TCP rather than a unix socket because upstream hardcodes
	// net.Listen("tcp", listen) in experimental/v2rayapi/server.go — a
	// unix socket would require a patched sing-box build.
	// The agent's v2ray-api sampler dials this same address.
	v2RayAPIAddr = "127.0.0.1:29091"
	configDir    = "/etc/shepherd-singbox"
)

// CertFilePath returns host-side cert/key paths for the given domain.
// crt: <cfgDir>/certs/<domain>.crt
// key: <cfgDir>/certs/<domain>.key
func CertFilePath(cfgDir, domain string) (crt, key string) {
	return cfgDir + "/certs/" + domain + ".crt",
		cfgDir + "/certs/" + domain + ".key"
}

// RenderServerConfig assembles a complete sing-box config.json for the given
// inbounds (all belonging to the same server). Returns error if inbounds is empty.
// certs must include every CertView referenced by inbound.CertID.
func RenderServerConfig(inbounds []InboundView, certs []CertView) ([]byte, error) {
	if len(inbounds) == 0 {
		return nil, errors.New("RenderServerConfig: no inbounds")
	}
	certsByID := map[int64]CertView{}
	for _, c := range certs {
		certsByID[c.ID] = c
	}

	inboundsJSON := make([]any, 0, len(inbounds))
	outbounds := make([]any, 0)
	routeRules := make([]any, 0)
	// v2RayStatsInbounds is the list passed to experimental.v2ray_api.stats.inbounds.
	// sing-box's StatsService only attaches counters to tags in this allowlist
	// (see experimental/v2rayapi/stats.go: `countInbound := s.inbounds[inbound]`)
	// — leave any inbound off and its traffic is invisible to the gRPC sampler.
	v2RayStatsInbounds := make([]any, 0, len(inbounds))
	hasLanding := false

	for _, in := range inbounds {
		ib, err := renderInbound(in, certsByID)
		if err != nil {
			return nil, fmt.Errorf("inbound %s: %w", in.Tag, err)
		}
		inboundsJSON = append(inboundsJSON, ib)
		v2RayStatsInbounds = append(v2RayStatsInbounds, in.Tag)
		if in.Role == "landing" {
			hasLanding = true
		}
		if in.Role == "relay" {
			if in.CustomUpstreamURL != "" {
				if in.RelayMode == "forward" {
					return nil, fmt.Errorf("relay %s: custom landing only supports proxy mode", in.Tag)
				}
				ob, err := renderCustomRelayOutbound(in)
				if err != nil {
					return nil, fmt.Errorf("relay outbound %s: %w", in.Tag, err)
				}
				outbounds = append(outbounds, ob)
				routeRules = append(routeRules, map[string]any{
					"inbound":  []any{in.Tag},
					"outbound": "to-custom-" + in.Tag,
				})
				continue
			}
			if !in.UpstreamTag.Valid {
				return nil, fmt.Errorf("relay %s missing upstream JOIN fields", in.Tag)
			}
			if in.RelayMode == "forward" {
				// "direct" inbound (rendered in renderInbound below)
				// override_address/port already point at the landing.
				// All we need here is a route rule that sends this
				// inbound's traffic to the built-in "direct" outbound
				// — no per-relay outbound, no protocol-aware
				// re-encapsulation. Lighter, no per-relay keys.
				routeRules = append(routeRules, map[string]any{
					"inbound":  []any{in.Tag},
					"outbound": "direct",
				})
			} else {
				ob, err := renderRelayOutbound(in)
				if err != nil {
					return nil, fmt.Errorf("relay outbound %s: %w", in.Tag, err)
				}
				outbounds = append(outbounds, ob)
				routeRules = append(routeRules, map[string]any{
					"inbound":  []any{in.Tag},
					"outbound": "to-" + in.UpstreamTag.String,
				})
			}
		}
	}

	outbounds = append(outbounds,
		map[string]any{"type": "direct", "tag": "direct"},
		map[string]any{"type": "block", "tag": "block"},
	)
	if hasLanding {
		routeRules = append(routeRules, map[string]any{
			"ip_cidr": []any{
				"0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8",
				"169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16",
				"fc00::/7", "fe80::/10",
			},
			"outbound": "block",
		})
	}

	cfg := map[string]any{
		"log": map[string]any{"level": "warn", "timestamp": true},
		// DNS schema migrated to sing-box 1.12+ format (type+server fields).
		// Legacy {address: "tls://..."} shape was deprecated and will be
		// removed in 1.14.0. See https://sing-box.sagernet.org/migration/#migrate-to-new-dns-server-formats
		// No detour: in sing-box 1.13 a `detour` pointing at the empty
		// {type:"direct", tag:"direct"} outbound is rejected ("makes no
		// sense"). Omitting detour lets the DoT connection use the
		// system's default network — exactly what we want for the
		// resolver itself (otherwise we'd risk DNS-via-proxy loops).
		"dns": map[string]any{
			"servers": []any{
				map[string]any{
					"type":   "tls",
					"tag":    "dns-remote",
					"server": "1.1.1.1",
				},
				map[string]any{
					"type": "local",
					"tag":  "dns-local",
				},
			},
			"rules": []any{},
			"final": "dns-remote",
		},
		"inbounds":  inboundsJSON,
		"outbounds": outbounds,
		// sing-box 1.13 made the missing route.default_domain_resolver a
		// FATAL startup error (was a deprecation warning in 1.12). Point
		// to our dns-remote tag so outbound dial() can resolve hostnames.
		"route": map[string]any{
			"rules":                   routeRules,
			"final":                   "direct",
			"auto_detect_interface":   true,
			"default_domain_resolver": "dns-remote",
		},
		// sing-box 1.12+ requires the experimental.cache_file block alongside
		// clash_api for the HTTP server to actually bind external_controller.
		// Without it the daemon parses the config cleanly but never listens,
		// leaving the agent sampler with "connection refused" on 29090.
		"experimental": map[string]any{
			// path is under /var/lib (state dir, FHS convention) — pre-fix
			// it was under /etc which the systemd unit hardening
			// (ProtectSystem=full) makes read-only at runtime.
			"cache_file": map[string]any{
				"enabled": true,
				"path":    "/var/lib/shepherd-singbox/cache.db",
			},
			"clash_api": map[string]any{
				"external_controller": clashAPIAddr,
				"secret":              "",
			},
			// v2ray_api stats service — the canonical traffic counter source
			// since v0.7.6. clash_api stays alongside for the active-
			// connection UI (planned). The binary must be built with the
			// with_v2ray_api tag (Shepherd's own sing-box builds from
			// .github/workflows/sing-box-build.yml include it; upstream's
			// stock release binaries do not — a stock binary will fatal-
			// fail trying to parse this block).
			"v2ray_api": map[string]any{
				"listen": v2RayAPIAddr,
				"stats": map[string]any{
					"enabled":  true,
					"inbounds": v2RayStatsInbounds,
				},
			},
		},
	}
	return json.MarshalIndent(cfg, "", "  ")
}

// renderInbound dispatches to the per-protocol renderer.
//
// Forward-mode relays short-circuit the protocol switch: they emit a
// sing-box "direct" inbound whose override_address/port point at the
// landing's server:port. The client connecting to this relay sees raw
// bytes forwarded to the landing — no protocol parsing, no per-relay
// keys, no double encryption. The route rule in RenderServerConfig
// sends the inbound's traffic to the built-in "direct" outbound.
func renderInbound(in InboundView, certsByID map[int64]CertView) (map[string]any, error) {
	base := map[string]any{
		"tag":         in.Tag,
		"listen":      "::",
		"listen_port": in.Port,
	}
	if in.Role == "relay" && in.RelayMode == "forward" {
		if !in.UpstreamAddress.Valid || !in.UpstreamPort.Valid {
			return nil, fmt.Errorf("forward relay %s: upstream address/port missing", in.Tag)
		}
		base["type"] = "direct"
		base["override_address"] = in.UpstreamAddress.String
		base["override_port"] = in.UpstreamPort.Int64
		// network field omitted = both TCP+UDP.
		return base, nil
	}
	switch in.Protocol {
	case "vless-reality":
		return renderVlessReality(base, in)
	case "vless-ws-tls":
		return renderVlessTLS(base, in, "ws", certsByID)
	case "vless-h2-tls":
		return renderVlessTLS(base, in, "http", certsByID)
	case "vless-httpupgrade-tls":
		return renderVlessTLS(base, in, "httpupgrade", certsByID)
	case "vmess-tcp":
		return renderVmess(base, in, "", certsByID)
	case "vmess-http":
		return renderVmess(base, in, "http", certsByID)
	case "vmess-quic":
		return renderVmess(base, in, "quic", certsByID)
	case "vmess-ws-tls":
		return renderVmessTLS(base, in, "ws", certsByID)
	case "vmess-h2-tls":
		return renderVmessTLS(base, in, "http", certsByID)
	case "vmess-httpupgrade-tls":
		return renderVmessTLS(base, in, "httpupgrade", certsByID)
	case "trojan-tls":
		return renderTrojan(base, in, "", certsByID)
	case "trojan-ws-tls":
		return renderTrojan(base, in, "ws", certsByID)
	case "trojan-h2-tls":
		return renderTrojan(base, in, "http", certsByID)
	case "trojan-httpupgrade-tls":
		return renderTrojan(base, in, "httpupgrade", certsByID)
	case "hysteria2":
		return renderHysteria2(base, in, certsByID)
	case "tuic-v5":
		return renderTUIC(base, in, certsByID)
	case "anytls":
		return renderAnyTLS(base, in, certsByID)
	case "shadowsocks-2022":
		return renderSS2022(base, in)
	case "snell-v5":
		return renderSnell(base, in, 5)
	case "snell-v6":
		return renderSnell(base, in, 6)
	default:
		return nil, fmt.Errorf("unsupported protocol: %s", in.Protocol)
	}
}

// ── Per-protocol inbound renderers ──────────────────────────────────────────

func renderVlessReality(base map[string]any, in InboundView) (map[string]any, error) {
	base["type"] = "vless"
	user := map[string]any{"uuid": strVal(in.UUID)}
	// REALITY pairs with xtls-rprx-vision — sing-box rejects connections
	// with "flow mismatch: expected none, but got xtls-rprx-vision" when
	// the user has no flow set but the client uses vision. Our share URL
	// hardcodes flow=xtls-rprx-vision, so the server must match. Default
	// here when the DB row was created without one; an explicit non-empty
	// override (advanced use) still wins.
	flow := "xtls-rprx-vision"
	if in.Flow != nil && *in.Flow != "" {
		flow = *in.Flow
	}
	user["flow"] = flow
	base["users"] = []any{user}
	shortIDs := []any{}
	if in.RealityShortID != nil {
		shortIDs = []any{*in.RealityShortID}
	}
	base["tls"] = map[string]any{
		"enabled":     true,
		"server_name": strVal(in.SNI),
		"reality": map[string]any{
			"enabled": true,
			"handshake": map[string]any{
				"server":      strVal(in.RealityHandshakeServer),
				"server_port": int64Val(in.RealityHandshakePort),
			},
			"private_key": strVal(in.RealityPrivateKey),
			"short_id":    shortIDs,
		},
	}
	return base, nil
}

func renderVlessTLS(base map[string]any, in InboundView, transport string, certsByID map[int64]CertView) (map[string]any, error) {
	base["type"] = "vless"
	base["users"] = []any{map[string]any{"uuid": strVal(in.UUID)}}
	crt, key := certPaths(in.CertID, certsByID)
	base["tls"] = renderTLSBlock(strVal(in.SNI), crt, key)
	base["transport"] = renderTransport(transport, in)
	return base, nil
}

func renderVmess(base map[string]any, in InboundView, transport string, _ map[int64]CertView) (map[string]any, error) {
	base["type"] = "vmess"
	alterID := int64(0)
	if in.AlterID != nil {
		alterID = *in.AlterID
	}
	base["users"] = []any{map[string]any{"uuid": strVal(in.UUID), "alterId": alterID}}
	if transport != "" {
		base["transport"] = renderTransport(transport, in)
	}
	return base, nil
}

func renderVmessTLS(base map[string]any, in InboundView, transport string, certsByID map[int64]CertView) (map[string]any, error) {
	base, err := renderVmess(base, in, transport, certsByID)
	if err != nil {
		return nil, err
	}
	crt, key := certPaths(in.CertID, certsByID)
	base["tls"] = renderTLSBlock(strVal(in.SNI), crt, key)
	return base, nil
}

func renderTrojan(base map[string]any, in InboundView, transport string, certsByID map[int64]CertView) (map[string]any, error) {
	base["type"] = "trojan"
	base["users"] = []any{map[string]any{"password": strVal(in.Password)}}
	crt, key := certPaths(in.CertID, certsByID)
	base["tls"] = renderTLSBlock(strVal(in.SNI), crt, key)
	if transport != "" {
		base["transport"] = renderTransport(transport, in)
	}
	return base, nil
}

func renderHysteria2(base map[string]any, in InboundView, certsByID map[int64]CertView) (map[string]any, error) {
	base["type"] = "hysteria2"
	base["users"] = []any{map[string]any{"password": strVal(in.Password)}}
	crt, key := certPaths(in.CertID, certsByID)
	base["tls"] = renderTLSBlock(strVal(in.SNI), crt, key)
	if in.ExtraJSON != nil && *in.ExtraJSON != "" {
		var extra map[string]any
		if err := json.Unmarshal([]byte(*in.ExtraJSON), &extra); err == nil {
			if v, ok := extra["up_mbps"]; ok {
				base["up_mbps"] = v
			}
			if v, ok := extra["down_mbps"]; ok {
				base["down_mbps"] = v
			}
			if v, ok := extra["obfs"]; ok && v != "" {
				base["obfs"] = map[string]any{"type": v, "password": extra["obfs_password"]}
			}
		}
	}
	return base, nil
}

func renderTUIC(base map[string]any, in InboundView, certsByID map[int64]CertView) (map[string]any, error) {
	base["type"] = "tuic"
	base["users"] = []any{map[string]any{"uuid": strVal(in.UUID), "password": strVal(in.Password)}}
	crt, key := certPaths(in.CertID, certsByID)
	tls := renderTLSBlock(strVal(in.SNI), crt, key)
	tls["alpn"] = []any{"h3"}
	base["tls"] = tls
	if in.ExtraJSON != nil && *in.ExtraJSON != "" {
		var extra map[string]any
		if err := json.Unmarshal([]byte(*in.ExtraJSON), &extra); err == nil {
			if v, ok := extra["congestion_control"]; ok {
				base["congestion_control"] = v
			}
			if v, ok := extra["auth_timeout"]; ok {
				base["auth_timeout"] = v
			}
		}
	}
	return base, nil
}

func renderAnyTLS(base map[string]any, in InboundView, certsByID map[int64]CertView) (map[string]any, error) {
	base["type"] = "anytls"
	base["users"] = []any{map[string]any{"password": strVal(in.Password)}}
	crt, key := certPaths(in.CertID, certsByID)
	base["tls"] = renderTLSBlock(strVal(in.SNI), crt, key)
	return base, nil
}

func renderSS2022(base map[string]any, in InboundView) (map[string]any, error) {
	base["type"] = "shadowsocks"
	base["method"] = strVal(in.SSMethod)
	base["password"] = strVal(in.Password)
	return base, nil
}

// renderSnell builds a snell inbound. snell has no TLS layer and no
// transport layer; the psk lives in the shared password column and the
// version is carried by the protocol name (snell-v5 / snell-v6).
// Enum values are whitelisted here rather than passed through: sing-box
// 1.14 rejects unknown enum values at config-parse time with a FATAL the
// panel never sees.
func renderSnell(base map[string]any, in InboundView, version int) (map[string]any, error) {
	psk := strVal(in.Password)
	if psk == "" {
		return nil, fmt.Errorf("snell %s: psk (password) is empty", in.Tag)
	}
	if version == 6 && (len([]byte(psk)) < 12 || len([]byte(psk)) > 255) {
		return nil, fmt.Errorf("snell %s: v6 psk length must be between 12 and 255 bytes", in.Tag)
	}
	base["type"] = "snell"
	base["version"] = version
	base["psk"] = psk

	extra := map[string]any{}
	if in.ExtraJSON != nil && *in.ExtraJSON != "" {
		if err := json.Unmarshal([]byte(*in.ExtraJSON), &extra); err != nil {
			return nil, fmt.Errorf("snell %s: bad extra_json: %w", in.Tag, err)
		}
	}

	if version == 5 {
		m, err := snellObfsMode(extra)
		if err != nil {
			return nil, fmt.Errorf("snell %s: %w", in.Tag, err)
		}
		base["obfs_mode"] = m
		return base, nil
	}
	m, err := snellMode(extra)
	if err != nil {
		return nil, fmt.Errorf("snell %s: %w", in.Tag, err)
	}
	base["mode"] = m
	return base, nil
}

// snellObfsMode reads extra_json["obfs_mode"] for snell v5. Defaults to
// "none"; only "none" and "http" are valid.
func snellObfsMode(extra map[string]any) (string, error) {
	v, ok := extra["obfs_mode"]
	if !ok {
		return "none", nil
	}
	s, ok2 := v.(string)
	if !ok2 {
		return "", fmt.Errorf("obfs_mode: expected string, got %T", v)
	}
	switch s {
	case "":
		return "none", nil
	case "none", "http":
		return s, nil
	}
	return "", fmt.Errorf("obfs_mode %q invalid (want none or http)", s)
}

// snellMode reads extra_json["mode"] for snell v6 traffic shaping.
// Defaults to "default".
func snellMode(extra map[string]any) (string, error) {
	v, ok := extra["mode"]
	if !ok {
		return "default", nil
	}
	s, ok2 := v.(string)
	if !ok2 {
		return "", fmt.Errorf("mode: expected string, got %T", v)
	}
	switch s {
	case "":
		return "default", nil
	case "default", "unshaped", "unsafe-raw":
		return s, nil
	}
	return "", fmt.Errorf("mode %q invalid (want default, unshaped or unsafe-raw)", s)
}

// ── Transport block builder ──────────────────────────────────────────────────

// buildTransport renders a sing-box transport block. isInbound adds the
// inbound-only fields (http method=PUT, the quic case), preserving the existing
// inbound/upstream difference exactly.
func buildTransport(ttype, path, host string, isInbound bool) map[string]any {
	tr := map[string]any{"type": ttype}
	switch ttype {
	case "ws":
		tr["path"] = path
		if host != "" {
			tr["headers"] = map[string]any{"Host": host}
		}
	case "http":
		tr["path"] = path
		if host != "" {
			tr["host"] = []any{host}
		}
		if isInbound {
			tr["method"] = "PUT"
		}
	case "httpupgrade":
		tr["path"] = path
		if host != "" {
			tr["host"] = host
		}
	case "quic":
		// inbound only; no extra fields
	}
	return tr
}

func renderTransport(ttype string, in InboundView) map[string]any {
	return buildTransport(ttype, strVal(in.TransportPath), strVal(in.TransportHost), true)
}

// ── Relay outbound renderer ──────────────────────────────────────────────────

// relayTLS builds the TLS block used by relay outbounds. Managed certificates
// are issued for the upstream landing's certificate domain, which may differ
// from the SNI used for camouflage. In that case sing-box must skip certificate
// verification or the relay handshake fails. Unknown certificate metadata is
// treated conservatively for certificate-authenticated protocols.
func relayTLS(in InboundView, fields map[string]any) map[string]any {
	if fields == nil {
		fields = map[string]any{}
	}
	fields["enabled"] = true
	fields["server_name"] = in.UpstreamSNI.String
	if relayTLSInsecure(in.UpstreamProtocol.String, in.UpstreamCertDomain.String, in.UpstreamSNI.String) {
		fields["insecure"] = true
	}
	return fields
}

func relayTLSInsecure(protocol, certDomain, sni string) bool {
	if protocol == "vless-reality" {
		return false
	}
	if !strings.HasSuffix(protocol, "-tls") && protocol != "hysteria2" && protocol != "tuic-v5" && protocol != "anytls" {
		return false
	}
	certDomain = strings.ToLower(strings.TrimSpace(certDomain))
	sni = strings.ToLower(strings.TrimSpace(sni))
	if certDomain == "" {
		return true
	}
	if sni == "" {
		return strings.HasPrefix(certDomain, "*.")
	}
	if certDomain == sni {
		return false
	}
	if strings.HasPrefix(certDomain, "*.") {
		base := certDomain[1:]
		if strings.HasSuffix(sni, base) {
			label := sni[:len(sni)-len(base)]
			if label != "" && !strings.Contains(label, ".") {
				return false
			}
		}
	}
	return true
}

// renderRelayOutbound generates the "to-<upstream.tag>" outbound for a relay inbound.
func renderRelayOutbound(in InboundView) (map[string]any, error) {
	upTag := in.UpstreamTag.String
	ob := map[string]any{
		"tag":         "to-" + upTag,
		"server":      in.UpstreamAddress.String,
		"server_port": in.UpstreamPort.Int64,
	}
	switch in.UpstreamProtocol.String {
	case "vless-reality":
		ob["type"] = "vless"
		ob["uuid"] = in.UpstreamUUID.String
		ob["flow"] = "xtls-rprx-vision"
		ob["tls"] = relayTLS(in, map[string]any{
			"enabled":     true,
			"server_name": in.UpstreamSNI.String,
			"utls":        map[string]any{"enabled": true, "fingerprint": "chrome"},
			"reality": map[string]any{
				"enabled":    true,
				"public_key": in.UpstreamRealityPublicKey.String,
				"short_id":   in.UpstreamRealityShortID.String,
			},
		})
	case "vless-ws-tls", "vless-h2-tls", "vless-httpupgrade-tls":
		ob["type"] = "vless"
		ob["uuid"] = in.UpstreamUUID.String
		ob["tls"] = relayTLS(in, nil)
		ob["transport"] = renderUpstreamTransport(protoToTransport(in.UpstreamProtocol.String), in)
	case "vmess-tcp":
		ob["type"] = "vmess"
		ob["uuid"] = in.UpstreamUUID.String
		ob["alter_id"] = 0
		ob["security"] = "auto"
	case "vmess-http":
		ob["type"] = "vmess"
		ob["uuid"] = in.UpstreamUUID.String
		ob["alter_id"] = 0
		ob["security"] = "auto"
		ob["transport"] = renderUpstreamTransport("http", in)
	case "vmess-quic":
		ob["type"] = "vmess"
		ob["uuid"] = in.UpstreamUUID.String
		ob["alter_id"] = 0
		ob["security"] = "auto"
		ob["transport"] = map[string]any{"type": "quic"}
	case "vmess-ws-tls", "vmess-h2-tls", "vmess-httpupgrade-tls":
		ob["type"] = "vmess"
		ob["uuid"] = in.UpstreamUUID.String
		ob["alter_id"] = 0
		ob["security"] = "auto"
		ob["tls"] = relayTLS(in, nil)
		ob["transport"] = renderUpstreamTransport(protoToTransport(in.UpstreamProtocol.String), in)
	case "trojan-tls":
		ob["type"] = "trojan"
		ob["password"] = in.UpstreamPassword.String
		ob["tls"] = relayTLS(in, nil)
	case "trojan-ws-tls", "trojan-h2-tls", "trojan-httpupgrade-tls":
		ob["type"] = "trojan"
		ob["password"] = in.UpstreamPassword.String
		ob["tls"] = relayTLS(in, nil)
		ob["transport"] = renderUpstreamTransport(protoToTransport(in.UpstreamProtocol.String), in)
	case "hysteria2":
		ob["type"] = "hysteria2"
		ob["password"] = in.UpstreamPassword.String
		ob["tls"] = relayTLS(in, nil)
		if in.UpstreamExtraJSON.Valid && in.UpstreamExtraJSON.String != "" {
			var extra map[string]any
			if err := json.Unmarshal([]byte(in.UpstreamExtraJSON.String), &extra); err == nil {
				if v, ok := extra["up_mbps"]; ok {
					ob["up_mbps"] = v
				}
				if v, ok := extra["down_mbps"]; ok {
					ob["down_mbps"] = v
				}
			}
		}
	case "tuic-v5":
		ob["type"] = "tuic"
		ob["uuid"] = in.UpstreamUUID.String
		ob["password"] = in.UpstreamPassword.String
		ob["tls"] = relayTLS(in, map[string]any{
			"enabled":     true,
			"server_name": in.UpstreamSNI.String,
			"alpn":        []any{"h3"},
		})
	case "anytls":
		ob["type"] = "anytls"
		ob["password"] = in.UpstreamPassword.String
		ob["tls"] = relayTLS(in, nil)
	case "shadowsocks-2022":
		ob["type"] = "shadowsocks"
		ob["method"] = in.UpstreamSSMethod.String
		ob["password"] = in.UpstreamPassword.String
	case "snell-v5", "snell-v6":
		ob["type"] = "snell"
		ob["psk"] = in.UpstreamPassword.String
		// sing-box snell outbound accepts version 4 or 6 only. The v5
		// wire protocol is identical to v4, so a v5 landing is dialed
		// as v4; sending 5 fails config parsing outright.
		if in.UpstreamProtocol.String == "snell-v6" {
			ob["version"] = 6
			var extra map[string]any
			if in.UpstreamExtraJSON.Valid && in.UpstreamExtraJSON.String != "" {
				if err := json.Unmarshal([]byte(in.UpstreamExtraJSON.String), &extra); err != nil {
					return nil, fmt.Errorf("relay %s: bad upstream extra_json: %w", in.Tag, err)
				}
			}
			m, err := snellMode(extra)
			if err != nil {
				return nil, fmt.Errorf("relay %s: %w", in.Tag, err)
			}
			ob["mode"] = m
		} else {
			ob["version"] = 4
			var extra map[string]any
			if in.UpstreamExtraJSON.Valid && in.UpstreamExtraJSON.String != "" {
				if err := json.Unmarshal([]byte(in.UpstreamExtraJSON.String), &extra); err != nil {
					return nil, fmt.Errorf("relay %s: bad upstream extra_json: %w", in.Tag, err)
				}
			}
			m, err := snellObfsMode(extra)
			if err != nil {
				return nil, fmt.Errorf("relay %s: %w", in.Tag, err)
			}
			if m != "none" {
				ob["obfs_mode"] = m
			}
		}
	default:
		return nil, fmt.Errorf("unsupported upstream protocol: %s", in.UpstreamProtocol.String)
	}
	return ob, nil
}

// renderUpstreamTransport builds a transport block using upstream transport fields.
func renderUpstreamTransport(ttype string, in InboundView) map[string]any {
	return buildTransport(ttype, in.UpstreamTransportPath.String, in.UpstreamTransportHost.String, false)
}

// protoToTransport maps protocol suffix to sing-box transport type string.
func protoToTransport(proto string) string {
	switch {
	case strings.HasSuffix(proto, "ws-tls"):
		return "ws"
	case strings.HasSuffix(proto, "h2-tls"):
		return "http"
	case strings.HasSuffix(proto, "httpupgrade-tls"):
		return "httpupgrade"
	default:
		return ""
	}
}

// ── Shared helpers ───────────────────────────────────────────────────────────

// certPaths looks up the cert domain in certsByID and returns host-side file paths.
func certPaths(certID *int64, certsByID map[int64]CertView) (crt, key string) {
	if certID == nil {
		return "", ""
	}
	c, ok := certsByID[*certID]
	if !ok {
		return "", ""
	}
	return CertFilePath(configDir, c.Domain)
}

// renderTLSBlock builds a standard TLS block with cert/key paths.
func renderTLSBlock(sni, certPath, keyPath string) map[string]any {
	return map[string]any{
		"enabled":          true,
		"server_name":      sni,
		"certificate_path": certPath,
		"key_path":         keyPath,
	}
}

func strVal(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func int64Val(i *int64) int64 {
	if i == nil {
		return 0
	}
	return *i
}
