package singbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

const clashAPIPort = 29090

// asyncDeploy is the seam used by POST/PATCH/DELETE handlers to kick off
// AssembleAndDeploy without blocking the HTTP response. Tests override it
// with a no-op so they don't race against t.Cleanup closing the DB while
// the background goroutine is mid-query (caught by `go test -race` in CI).
var asyncDeploy = func(deps plugins.Deps, serverID int64) {
	go func() { _ = AssembleAndDeploy(context.Background(), deps, serverID) }()
}

func isValidProtocol(p string) bool {
	for _, v := range []string{
		"vless-reality", "vless-ws-tls", "vless-h2-tls", "vless-httpupgrade-tls",
		"vmess-tcp", "vmess-http", "vmess-quic", "vmess-ws-tls", "vmess-h2-tls", "vmess-httpupgrade-tls",
		"trojan-tls", "trojan-ws-tls", "trojan-h2-tls", "trojan-httpupgrade-tls",
		"hysteria2", "tuic-v5", "anytls", "shadowsocks-2022",
	} {
		if p == v {
			return true
		}
	}
	return false
}

type postInboundBody struct {
	ServerID               int64   `json:"server_id"`
	Port                   int     `json:"port"`
	Role                   string  `json:"role"`
	Protocol               string  `json:"protocol"`
	UUID                   *string `json:"uuid"`
	Flow                   *string `json:"flow"`
	Password               *string `json:"password"`
	SNI                    *string `json:"sni"`
	CertID                 *int64  `json:"cert_id"`
	RealityPrivateKey      *string `json:"reality_private_key"`
	RealityPublicKey       *string `json:"reality_public_key"`
	RealityShortID         *string `json:"reality_short_id"`
	RealityHandshakeServer *string `json:"reality_handshake_server"`
	RealityHandshakePort   *int64  `json:"reality_handshake_port"`
	TransportPath          *string `json:"transport_path"`
	TransportHost          *string `json:"transport_host"`
	AlterID                *int64  `json:"alter_id"`
	SSMethod               *string `json:"ss_method"`
	Extra                  *string `json:"extra"`
	UpstreamInboundID      *int64  `json:"upstream_inbound_id"`
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func validatePostInbound(ctx context.Context, store *InboundStore, body postInboundBody) error {
	if body.ServerID == 0 {
		return errors.New("server_id required")
	}
	if body.Port <= 0 || body.Port > 65535 {
		return errors.New("port out of range")
	}
	if body.Port == clashAPIPort {
		return fmt.Errorf("port %d is reserved for the sing-box clash-api", clashAPIPort)
	}
	if body.Role != "landing" && body.Role != "relay" {
		return fmt.Errorf("role must be landing or relay, got %q", body.Role)
	}
	if !isValidProtocol(body.Protocol) {
		return fmt.Errorf("unknown protocol %q", body.Protocol)
	}
	existing, _ := store.ListByServer(ctx, body.ServerID)
	for _, e := range existing {
		if e.Port == body.Port {
			return fmt.Errorf("server %d already has inbound on port %d (tag=%s)", body.ServerID, body.Port, e.Tag)
		}
	}
	if body.Role == "relay" {
		if body.UpstreamInboundID == nil {
			return errors.New("upstream_inbound_id required when role=relay")
		}
		upstream, err := store.GetByID(ctx, *body.UpstreamInboundID)
		if err != nil {
			return fmt.Errorf("upstream inbound %d not found", *body.UpstreamInboundID)
		}
		if upstream.Role != "landing" {
			return fmt.Errorf("upstream inbound %d is not a landing (role=%s)", upstream.ID, upstream.Role)
		}
	}
	// vless-reality needs handshake target + private key — without them
	// sing-box fails at runtime with "REALITY: failed to dial dest:
	// invalid address". Catch at the API boundary so the UI surfaces
	// the real reason instead of a sing-box crash log.
	if body.Protocol == "vless-reality" {
		if body.RealityPrivateKey == nil || *body.RealityPrivateKey == "" {
			return errors.New("reality_private_key required for vless-reality")
		}
		if body.RealityHandshakeServer == nil || *body.RealityHandshakeServer == "" {
			return errors.New("reality_handshake_server required for vless-reality (e.g. www.microsoft.com)")
		}
		if body.RealityHandshakePort == nil || *body.RealityHandshakePort <= 0 {
			return errors.New("reality_handshake_port required for vless-reality (typically 443)")
		}
	}
	return nil
}

// inboundToMap converts an InboundView to a JSON-serialisable map.
// reality_private_key is always redacted. All other pointer fields are included as-is
// (nil becomes JSON null), so callers see the full schema shape.
func inboundToMap(v InboundView) map[string]any {
	m := map[string]any{
		"id":          v.ID,
		"server_id":   v.ServerID,
		"server_name": v.ServerName,
		"tag":         v.Tag,
		"port":        v.Port,
		"role":        v.Role,
		"protocol":    v.Protocol,
		// pointer fields — nil → JSON null
		"uuid":                    v.UUID,
		"flow":                    v.Flow,
		"password":                v.Password,
		"sni":                     v.SNI,
		"cert_id":                 v.CertID,
		"reality_private_key":     "[REDACTED]",
		"reality_public_key":      v.RealityPublicKey,
		"reality_short_id":        v.RealityShortID,
		"reality_handshake_server": v.RealityHandshakeServer,
		"reality_handshake_port":  v.RealityHandshakePort,
		"transport_path":          v.TransportPath,
		"transport_host":          v.TransportHost,
		"alter_id":                v.AlterID,
		"ss_method":               v.SSMethod,
		"extra_json":              v.ExtraJSON,
		"upstream_inbound_id":     v.UpstreamInboundID,
		"created_at":              v.CreatedAt,
		"updated_at":              v.UpdatedAt,
	}
	if v.UpstreamTag.Valid {
		m["upstream_tag"] = v.UpstreamTag.String
	}
	if v.UpstreamServerID.Valid {
		m["upstream_server_id"] = v.UpstreamServerID.Int64
	}
	if v.UpstreamServerName.Valid {
		m["upstream_server_name"] = v.UpstreamServerName.String
	}
	return m
}

func postInboundHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body postInboundBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, 400, "bad json")
			return
		}
		store := &InboundStore{DB: deps.DB}
		if err := validatePostInbound(r.Context(), store, body); err != nil {
			writeErr(w, 409, err.Error())
			return
		}
		in := Inbound{
			ServerID:               body.ServerID,
			Tag:                    store.GenerateTag(body.Role),
			Port:                   body.Port,
			Role:                   body.Role,
			Protocol:               body.Protocol,
			UUID:                   body.UUID,
			Flow:                   body.Flow,
			Password:               body.Password,
			SNI:                    body.SNI,
			CertID:                 body.CertID,
			RealityPrivateKey:      body.RealityPrivateKey,
			RealityPublicKey:       body.RealityPublicKey,
			RealityShortID:         body.RealityShortID,
			RealityHandshakeServer: body.RealityHandshakeServer,
			RealityHandshakePort:   body.RealityHandshakePort,
			TransportPath:          body.TransportPath,
			TransportHost:          body.TransportHost,
			AlterID:                body.AlterID,
			SSMethod:               body.SSMethod,
			ExtraJSON:              body.Extra,
			UpstreamInboundID:      body.UpstreamInboundID,
		}
		id, err := store.Insert(r.Context(), in)
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		asyncDeploy(deps, body.ServerID)
		views, _ := store.ListAllWithUpstream(r.Context())
		for _, v := range views {
			if v.ID == id {
				writeJSON(w, 201, inboundToMap(v))
				return
			}
		}
		writeErr(w, 500, "inserted but not findable")
	}
}

func getInboundsHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		store := &InboundStore{DB: deps.DB}
		views, err := store.ListAllWithUpstream(r.Context())
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		filter := r.URL.Query().Get("server_id")
		out := []map[string]any{}
		for _, v := range views {
			if filter != "" {
				want, _ := strconv.ParseInt(filter, 10, 64)
				if v.ServerID != want {
					continue
				}
			}
			out = append(out, inboundToMap(v))
		}
		writeJSON(w, 200, out)
	}
}

func patchInboundHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if id == 0 {
			writeErr(w, 400, "id required")
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, 400, "bad json")
			return
		}
		patch := InboundPatch{}
		if v, ok := body["port"].(float64); ok {
			p := int(v)
			patch.Port = &p
		}
		if v, ok := body["uuid"].(string); ok {
			patch.UUID = &v
		}
		if v, ok := body["flow"].(string); ok {
			patch.Flow = &v
		}
		if v, ok := body["password"].(string); ok {
			patch.Password = &v
		}
		if v, ok := body["sni"].(string); ok {
			patch.SNI = &v
		}
		if v, ok := body["reality_public_key"].(string); ok {
			patch.RealityPublicKey = &v
		}
		if v, ok := body["reality_short_id"].(string); ok {
			patch.RealityShortID = &v
		}
		if v, ok := body["transport_path"].(string); ok {
			patch.TransportPath = &v
		}
		if v, ok := body["transport_host"].(string); ok {
			patch.TransportHost = &v
		}
		if v, ok := body["ss_method"].(string); ok {
			patch.SSMethod = &v
		}
		if v, ok := body["extra"].(string); ok {
			patch.ExtraJSON = &v
		}
		// Skip the REDACTED placeholder AND empty string — the dialog
		// starts the field empty and a save without touching it must
		// preserve the existing key. Pre-fix an empty body value
		// silently wiped the column, breaking the REALITY handshake.
		if v, ok := body["reality_private_key"].(string); ok && v != "[REDACTED]" && v != "" {
			patch.RealityPrivateKey = &v
		}
		store := &InboundStore{DB: deps.DB}
		row, err := store.GetByID(r.Context(), id)
		if err != nil {
			writeErr(w, 404, "inbound not found")
			return
		}
		if patch.Port != nil && *patch.Port != row.Port {
			if *patch.Port == clashAPIPort {
				writeErr(w, 409, fmt.Sprintf("port %d reserved for clash-api", clashAPIPort))
				return
			}
			others, _ := store.ListByServer(r.Context(), row.ServerID)
			for _, o := range others {
				if o.ID != id && o.Port == *patch.Port {
					writeErr(w, 409, fmt.Sprintf("port %d in use by %s", *patch.Port, o.Tag))
					return
				}
			}
		}
		if err := store.Update(r.Context(), id, patch); err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		asyncDeploy(deps, row.ServerID)
		views, _ := store.ListAllWithUpstream(r.Context())
		for _, v := range views {
			if v.ID == id {
				writeJSON(w, 200, inboundToMap(v))
				return
			}
		}
		writeErr(w, 500, "updated but not findable")
	}
}

func deleteInboundHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if id == 0 {
			writeErr(w, 400, "id required")
			return
		}
		store := &InboundStore{DB: deps.DB}
		row, err := store.GetByID(r.Context(), id)
		if err != nil {
			writeErr(w, 404, "inbound not found")
			return
		}
		if row.Role == "landing" {
			relays, _ := store.ListByUpstream(r.Context(), id)
			if len(relays) > 0 {
				ids := make([]int64, len(relays))
				for i, rel := range relays {
					ids[i] = rel.ID
				}
				writeJSON(w, 409, map[string]any{
					"error": fmt.Sprintf("landing inbound %s has %d relay(s) depending on it",
						row.Tag, len(relays)),
					"relay_inbound_ids": ids,
				})
				return
			}
		}
		if err := store.Delete(r.Context(), id); err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		asyncDeploy(deps, row.ServerID)
		w.WriteHeader(204)
	}
}
