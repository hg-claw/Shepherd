package xray

import (
	"encoding/json"
	"errors"
	"fmt"
)

// RenderServerConfig assembles a complete xray config.json for one server,
// given all of its inbounds (with upstream JOIN fields populated for relays).
// Output is deterministic: inbounds emitted in input order (caller should
// sort by id), outbounds emit to-{upstream.tag} for each unique upstream then
// freedom at the end, routing rules emit one per relay inbound then the
// geoip:private fallback.
func RenderServerConfig(inbounds []InboundView) ([]byte, error) {
	if len(inbounds) == 0 {
		return nil, errors.New("RenderServerConfig: no inbounds")
	}

	cfg := map[string]any{
		"log": map[string]any{"loglevel": "warning"},
	}

	inboundsJSON := make([]any, 0, len(inbounds))
	outboundsByTag := map[string]map[string]any{}
	routingRules := make([]any, 0, len(inbounds)+1)
	hasRelay := false

	for _, in := range inbounds {
		ib, err := renderInbound(in)
		if err != nil {
			return nil, fmt.Errorf("inbound %s: %w", in.Tag, err)
		}
		inboundsJSON = append(inboundsJSON, ib)

		if in.Role == "relay" {
			hasRelay = true
			if !in.UpstreamTag.Valid {
				return nil, fmt.Errorf("relay %s missing upstream JOIN fields", in.Tag)
			}
			upTag := in.UpstreamTag.String
			outTag := "to-" + upTag
			if _, exists := outboundsByTag[outTag]; !exists {
				outboundsByTag[outTag] = renderRelayOutbound(outTag, in)
			}
			routingRules = append(routingRules, map[string]any{
				"type":        "field",
				"inboundTag":  []any{in.Tag},
				"outboundTag": outTag,
			})
		}
	}

	outboundsList := make([]any, 0, len(outboundsByTag)+1)
	for _, tag := range sortedKeys(outboundsByTag) {
		outboundsList = append(outboundsList, outboundsByTag[tag])
	}
	outboundsList = append(outboundsList, map[string]any{
		"tag":      "freedom",
		"protocol": "freedom",
		"settings": map[string]any{"domainStrategy": "UseIP"},
	})

	cfg["inbounds"] = inboundsJSON
	cfg["outbounds"] = outboundsList

	// The api inbound (injected by injectStatsAndAPI below) requires an
	// explicit routing rule that maps its tag to the api outbound the xray
	// `api` block creates internally. Without this rule xray rejects the
	// config at startup → the daemon never binds APIPort → the sampler's
	// gRPC call fails with "failed to dial 127.0.0.1:28085". Always emit
	// this rule, even when there are no relay rules.
	routingRules = append(routingRules, map[string]any{
		"type":        "field",
		"inboundTag":  []any{apiInboundTag},
		"outboundTag": apiInboundTag,
	})
	if hasRelay {
		routingRules = append(routingRules, map[string]any{
			"type":        "field",
			"ip":          []any{"geoip:private"},
			"outboundTag": "freedom",
		})
	}
	cfg["routing"] = map[string]any{"rules": routingRules}
	injectStatsAndAPI(cfg)
	return json.MarshalIndent(cfg, "", "  ")
}

func renderInbound(in InboundView) (map[string]any, error) {
	switch in.Protocol {
	case "vless-reality":
		return map[string]any{
			"tag":      in.Tag,
			"port":     in.Port,
			"protocol": "vless",
			"settings": map[string]any{
				"clients":    []any{map[string]any{"id": in.UUID, "flow": "xtls-rprx-vision"}},
				"decryption": "none",
			},
			"streamSettings": map[string]any{
				"network":  "tcp",
				"security": "reality",
				"realitySettings": map[string]any{
					"show":        false,
					"dest":        in.SNI + ":443",
					"serverNames": []any{in.SNI},
					"privateKey":  in.PrivateKey,
					"publicKey":   in.PublicKey,
					"shortIds":    []any{in.ShortID},
				},
			},
			"sniffing": map[string]any{
				"enabled":      true,
				"destOverride": []any{"http", "tls"},
			},
		}, nil
	case "vmess-ws":
		path := in.WSPath
		if path == "" {
			path = "/ws"
		}
		return map[string]any{
			"tag":      in.Tag,
			"port":     in.Port,
			"protocol": "vmess",
			"settings": map[string]any{
				"clients": []any{map[string]any{"id": in.UUID}},
			},
			"streamSettings": map[string]any{
				"network":    "ws",
				"wsSettings": map[string]any{"path": path},
			},
			"sniffing": map[string]any{
				"enabled":      true,
				"destOverride": []any{"http", "tls"},
			},
		}, nil
	case "shadowsocks":
		return map[string]any{
			"tag":      in.Tag,
			"port":     in.Port,
			"protocol": "shadowsocks",
			"settings": map[string]any{"method": in.SSMethod, "password": in.SSPassword},
			"sniffing": map[string]any{
				"enabled":      true,
				"destOverride": []any{"http", "tls"},
			},
		}, nil
	default:
		return nil, fmt.Errorf("unknown protocol %q", in.Protocol)
	}
}

func renderRelayOutbound(outTag string, in InboundView) map[string]any {
	return map[string]any{
		"tag":      outTag,
		"protocol": "vless",
		"settings": map[string]any{
			"vnext": []any{map[string]any{
				"address": in.UpstreamAddress.String,
				"port":    in.UpstreamPort.Int64,
				"users": []any{map[string]any{
					"id":         in.UpstreamUUID.String,
					"encryption": "none",
					"flow":       "xtls-rprx-vision",
				}},
			}},
		},
		"streamSettings": map[string]any{
			"network":  "tcp",
			"security": "reality",
			"realitySettings": map[string]any{
				"fingerprint": "chrome",
				"serverName":  in.UpstreamSNI.String,
				"publicKey":   in.UpstreamPublicKey.String,
				"shortId":     in.UpstreamShortID.String,
			},
		},
	}
}

// apiInboundTag is the reserved tag for the shepherd stats API inbound.
const apiInboundTag = "__shepherd_api__"

// APIListen / APIPort: xray's stats API inbound is a TCP dokodemo-door
// bound to loopback. We avoid unix sockets because xray's `listen` field
// treats `unix:...` as a domain to resolve (it doesn't natively support
// the unix: prefix here). Port 28085 is high enough to rarely collide
// with user-chosen inbound ports; validatePostInbound rejects it
// explicitly so a user can't accidentally double-bind.
const (
	APIListen = "127.0.0.1"
	APIPort   = 28085
)

// injectStatsAndAPI mutates cfg in-place to add the stats, api, and
// policy.system blocks, and appends the __shepherd_api__ dokodemo inbound.
// It is idempotent: calling it twice does not duplicate entries.
func injectStatsAndAPI(cfg map[string]any) {
	// stats block
	cfg["stats"] = map[string]any{}

	// api block
	cfg["api"] = map[string]any{
		"tag":      apiInboundTag,
		"services": []any{"StatsService"},
	}

	// policy.system block (merge into existing policy if any)
	policy, _ := cfg["policy"].(map[string]any)
	if policy == nil {
		policy = map[string]any{}
	}
	policy["system"] = map[string]any{
		"statsInboundUplink":    true,
		"statsInboundDownlink":  true,
		"statsOutboundUplink":   true,
		"statsOutboundDownlink": true,
	}
	cfg["policy"] = policy

	// append __shepherd_api__ inbound if not already present
	inbs, _ := cfg["inbounds"].([]any)
	for _, ib := range inbs {
		if m, ok := ib.(map[string]any); ok && m["tag"] == apiInboundTag {
			return // already injected
		}
	}
	apiInbound := map[string]any{
		"listen":   APIListen,
		"port":     APIPort,
		"protocol": "dokodemo-door",
		"settings": map[string]any{"address": APIListen},
		"tag":      apiInboundTag,
		"sniffing": map[string]any{"enabled": false},
	}
	cfg["inbounds"] = append(inbs, apiInbound)
}

func sortedKeys(m map[string]map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j-1] > keys[j]; j-- {
			keys[j-1], keys[j] = keys[j], keys[j-1]
		}
	}
	return keys
}
