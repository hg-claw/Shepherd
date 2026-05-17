package xray

import (
	"encoding/json"
	"errors"
	"fmt"
)

type TemplateRequest struct {
	Inbound    string `json:"inbound"` // vless-reality | vmess-ws | shadowsocks
	Port       int    `json:"port"`
	UUID       string `json:"uuid"`
	// VLESS+REALITY:
	SNI        string `json:"sni"`
	PublicKey  string `json:"public_key"`
	PrivateKey string `json:"private_key"`
	ShortID    string `json:"short_id"`
	// VMess+WS:
	WSPath     string `json:"ws_path"`
	// Shadowsocks:
	Method     string `json:"method"`
	Password   string `json:"password"`
}

// RenderTemplate returns canonical xray JSON for a chosen inbound preset.
func RenderTemplate(req TemplateRequest) ([]byte, error) {
	switch req.Inbound {
	case "vless-reality":
		return renderVLESSReality(req)
	case "vmess-ws":
		return renderVMessWS(req)
	case "shadowsocks":
		return renderShadowsocks(req)
	default:
		return nil, fmt.Errorf("unknown inbound %q", req.Inbound)
	}
}

func renderVLESSReality(r TemplateRequest) ([]byte, error) {
	if r.Port == 0 || r.UUID == "" || r.SNI == "" || r.PublicKey == "" {
		return nil, errors.New("vless-reality: port/uuid/sni/public_key required")
	}
	cfg := map[string]any{
		"log": map[string]any{"loglevel": "warning"},
		"inbounds": []any{map[string]any{
			"port":     r.Port,
			"protocol": "vless",
			"settings": map[string]any{
				"clients":    []any{map[string]any{"id": r.UUID, "flow": "xtls-rprx-vision"}},
				"decryption": "none",
			},
			"streamSettings": map[string]any{
				"network":  "tcp",
				"security": "reality",
				"realitySettings": map[string]any{
					"show":         false,
					"dest":         r.SNI + ":443",
					"serverNames":  []any{r.SNI},
					"privateKey":   r.PrivateKey,
					"publicKey":    r.PublicKey,
					"shortIds":     []any{r.ShortID},
				},
			},
		}},
		"outbounds": []any{map[string]any{"protocol": "freedom"}},
	}
	return json.MarshalIndent(cfg, "", "  ")
}

func renderVMessWS(r TemplateRequest) ([]byte, error) {
	if r.Port == 0 || r.UUID == "" {
		return nil, errors.New("vmess-ws: port/uuid required")
	}
	if r.WSPath == "" { r.WSPath = "/ws" }
	cfg := map[string]any{
		"inbounds": []any{map[string]any{
			"port":     r.Port,
			"protocol": "vmess",
			"settings": map[string]any{"clients": []any{map[string]any{"id": r.UUID}}},
			"streamSettings": map[string]any{
				"network":   "ws",
				"wsSettings": map[string]any{"path": r.WSPath},
			},
		}},
		"outbounds": []any{map[string]any{"protocol": "freedom"}},
	}
	return json.MarshalIndent(cfg, "", "  ")
}

func renderShadowsocks(r TemplateRequest) ([]byte, error) {
	if r.Port == 0 || r.Method == "" || r.Password == "" {
		return nil, errors.New("shadowsocks: port/method/password required")
	}
	cfg := map[string]any{
		"inbounds": []any{map[string]any{
			"port":     r.Port,
			"protocol": "shadowsocks",
			"settings": map[string]any{"method": r.Method, "password": r.Password},
		}},
		"outbounds": []any{map[string]any{"protocol": "freedom"}},
	}
	return json.MarshalIndent(cfg, "", "  ")
}

// NormaliseRaw parses arbitrary JSON and re-marshals it pretty so the
// content on disk is deterministic. It only rejects syntactically invalid
// JSON; xray's own validator runs on the host after deploy.
func NormaliseRaw(raw []byte) ([]byte, error) {
	var any any
	if err := json.Unmarshal(raw, &any); err != nil {
		return nil, fmt.Errorf("invalid json: %w", err)
	}
	return json.MarshalIndent(any, "", "  ")
}
