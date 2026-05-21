package singbox

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const (
	clashAPIAddr = "127.0.0.1:29090"
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
	hasLanding := false

	for _, in := range inbounds {
		ib, err := renderInbound(in, certsByID)
		if err != nil {
			return nil, fmt.Errorf("inbound %s: %w", in.Tag, err)
		}
		inboundsJSON = append(inboundsJSON, ib)
		if in.Role == "landing" {
			hasLanding = true
		}
		if in.Role == "relay" {
			if !in.UpstreamTag.Valid {
				return nil, fmt.Errorf("relay %s missing upstream JOIN fields", in.Tag)
			}
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
			"cache_file": map[string]any{
				"enabled": true,
				"path":    "/etc/shepherd-singbox/cache.db",
			},
			"clash_api": map[string]any{
				"external_controller": clashAPIAddr,
				"secret":              "",
			},
		},
	}
	return json.MarshalIndent(cfg, "", "  ")
}

// renderInbound dispatches to the per-protocol renderer.
func renderInbound(in InboundView, certsByID map[int64]CertView) (map[string]any, error) {
	base := map[string]any{
		"tag":         in.Tag,
		"listen":      "::",
		"listen_port": in.Port,
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
	default:
		return nil, fmt.Errorf("unsupported protocol: %s", in.Protocol)
	}
}

// ── Per-protocol inbound renderers ──────────────────────────────────────────

func renderVlessReality(base map[string]any, in InboundView) (map[string]any, error) {
	base["type"] = "vless"
	user := map[string]any{"uuid": strVal(in.UUID)}
	if in.Flow != nil && *in.Flow != "" {
		user["flow"] = *in.Flow
	}
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

// ── Transport block builder ──────────────────────────────────────────────────

func renderTransport(ttype string, in InboundView) map[string]any {
	tr := map[string]any{"type": ttype}
	path := strVal(in.TransportPath)
	host := strVal(in.TransportHost)
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
		tr["method"] = "PUT"
	case "httpupgrade":
		tr["path"] = path
		if host != "" {
			tr["host"] = host
		}
	case "quic":
		// no extra fields
	}
	return tr
}

// ── Relay outbound renderer ──────────────────────────────────────────────────

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
		ob["tls"] = map[string]any{
			"enabled":     true,
			"server_name": in.UpstreamSNI.String,
			"utls":        map[string]any{"enabled": true, "fingerprint": "chrome"},
			"reality": map[string]any{
				"enabled":    true,
				"public_key": in.UpstreamRealityPublicKey.String,
				"short_id":   in.UpstreamRealityShortID.String,
			},
		}
	case "vless-ws-tls", "vless-h2-tls", "vless-httpupgrade-tls":
		ob["type"] = "vless"
		ob["uuid"] = in.UpstreamUUID.String
		ob["tls"] = map[string]any{"enabled": true, "server_name": in.UpstreamSNI.String}
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
		ob["tls"] = map[string]any{"enabled": true, "server_name": in.UpstreamSNI.String}
		ob["transport"] = renderUpstreamTransport(protoToTransport(in.UpstreamProtocol.String), in)
	case "trojan-tls":
		ob["type"] = "trojan"
		ob["password"] = in.UpstreamPassword.String
		ob["tls"] = map[string]any{"enabled": true, "server_name": in.UpstreamSNI.String}
	case "trojan-ws-tls", "trojan-h2-tls", "trojan-httpupgrade-tls":
		ob["type"] = "trojan"
		ob["password"] = in.UpstreamPassword.String
		ob["tls"] = map[string]any{"enabled": true, "server_name": in.UpstreamSNI.String}
		ob["transport"] = renderUpstreamTransport(protoToTransport(in.UpstreamProtocol.String), in)
	case "hysteria2":
		ob["type"] = "hysteria2"
		ob["password"] = in.UpstreamPassword.String
		ob["tls"] = map[string]any{"enabled": true, "server_name": in.UpstreamSNI.String}
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
		ob["tls"] = map[string]any{
			"enabled":     true,
			"server_name": in.UpstreamSNI.String,
			"alpn":        []any{"h3"},
		}
	case "anytls":
		ob["type"] = "anytls"
		ob["password"] = in.UpstreamPassword.String
		ob["tls"] = map[string]any{"enabled": true, "server_name": in.UpstreamSNI.String}
	case "shadowsocks-2022":
		ob["type"] = "shadowsocks"
		ob["method"] = in.UpstreamSSMethod.String
		ob["password"] = in.UpstreamPassword.String
	default:
		return nil, fmt.Errorf("unsupported upstream protocol: %s", in.UpstreamProtocol.String)
	}
	return ob, nil
}

// renderUpstreamTransport builds a transport block using upstream transport fields.
func renderUpstreamTransport(ttype string, in InboundView) map[string]any {
	tr := map[string]any{"type": ttype}
	path := in.UpstreamTransportPath.String
	host := in.UpstreamTransportHost.String
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
	case "httpupgrade":
		tr["path"] = path
		if host != "" {
			tr["host"] = host
		}
	}
	return tr
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

