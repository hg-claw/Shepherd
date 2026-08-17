package singbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/hg-claw/Shepherd/internal/httpjson"
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
		"snell-v5", "snell-v6",
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
	CustomUpstreamURL      string  `json:"custom_upstream_url"`
	Alias                  string  `json:"alias"`
	// RelayMode is honored only when role="relay". Values: "proxy"
	// (legacy dual-termination), "forward" (transparent sing-box
	// direct inbound). Empty defaults to "proxy" for backward
	// compatibility with existing clients.
	RelayMode         string `json:"relay_mode"`
	SSHForwardEnabled bool   `json:"ssh_forward_enabled"`
	SSHHost           string `json:"ssh_host"`
	SSHPort           int    `json:"ssh_port"`
	SSHUsername       string `json:"ssh_username"`
	SSHPrivateKey     string `json:"ssh_private_key"`
	SSHUseLocalhost   bool   `json:"ssh_use_localhost"`
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	httpjson.Write(w, code, body)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	httpjson.Error(w, code, msg)
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
	if err := validateSSHForward(body.SSHForwardEnabled, body.SSHHost, body.SSHPort, body.SSHUsername, body.SSHPrivateKey); err != nil {
		return err
	}
	if !isValidProtocol(body.Protocol) {
		return fmt.Errorf("unknown protocol %q", body.Protocol)
	}
	// The psk is only needed by rows that actually terminate snell. A
	// forward-mode relay renders as {"type":"direct", …} — renderInbound
	// short-circuits before the protocol switch, so the psk would never
	// be read. Forward relays deliberately carry no credentials (it is
	// the default mode in the bulk-relay UI), and demanding one here made
	// the out-of-the-box "add relays" action on a snell landing fail.
	if body.Protocol == "snell-v5" || body.Protocol == "snell-v6" {
		forwardRelay := body.Role == "relay" && body.RelayMode == "forward"
		if !forwardRelay && (body.Password == nil || *body.Password == "") {
			return errors.New("password (snell psk) required for snell inbounds")
		}
		if !forwardRelay && body.Protocol == "snell-v6" && body.Password != nil {
			if n := len([]byte(*body.Password)); n < 12 || n > 255 {
				return errors.New("snell v6 psk length must be between 12 and 255 bytes")
			}
		}
	}
	existing, _ := store.ListByServer(ctx, body.ServerID)
	for _, e := range existing {
		if e.Port == body.Port {
			return fmt.Errorf("server %d already has inbound on port %d (tag=%s)", body.ServerID, body.Port, e.Tag)
		}
	}
	if body.Role == "relay" {
		customURL := strings.TrimSpace(body.CustomUpstreamURL)
		if customURL != "" {
			if body.UpstreamInboundID != nil {
				return errors.New("custom_upstream_url and upstream_inbound_id are mutually exclusive")
			}
			if body.RelayMode == "forward" {
				return errors.New("custom landing only supports relay_mode=proxy")
			}
			if _, err := parseCustomLandingURL(customURL); err != nil {
				return err
			}
		} else {
			if body.UpstreamInboundID == nil {
				return errors.New("upstream_inbound_id or custom_upstream_url required when role=relay")
			}
			upstream, err := store.GetByID(ctx, *body.UpstreamInboundID)
			if err != nil {
				return fmt.Errorf("upstream inbound %d not found", *body.UpstreamInboundID)
			}
			if upstream.Role != "landing" {
				return fmt.Errorf("upstream inbound %d is not a landing (role=%s)", upstream.ID, upstream.Role)
			}
		}
	} else if strings.TrimSpace(body.CustomUpstreamURL) != "" || body.UpstreamInboundID != nil {
		return errors.New("landing cannot have an upstream inbound or custom landing URL")
	}
	// vless-reality needs handshake target + private key — without them
	// sing-box fails at runtime with "REALITY: failed to dial dest:
	// invalid address". Catch at the API boundary so the UI surfaces
	// the real reason instead of a sing-box crash log.
	//
	// Forward relays are exempt for the same reason snell's psk check is:
	// renderInbound short-circuits them into a "direct" inbound before the
	// protocol switch, so none of these fields is ever read. Demanding them
	// made the default bulk-relay action on a reality landing fail.
	forwardRelay := body.Role == "relay" && body.RelayMode == "forward"
	if body.Protocol == "vless-reality" && !forwardRelay {
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

func validateSSHForward(enabled bool, host string, port int, username, privateKey string) error {
	if !enabled {
		return nil
	}
	if strings.TrimSpace(host) == "" {
		return errors.New("ssh_host required when ssh forwarding is enabled")
	}
	if port <= 0 || port > 65535 {
		return errors.New("ssh_port out of range")
	}
	if strings.TrimSpace(username) == "" {
		return errors.New("ssh_username required when ssh forwarding is enabled")
	}
	if strings.TrimSpace(privateKey) == "" {
		return errors.New("ssh_private_key required when ssh forwarding is enabled")
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
		"alias":       v.Alias,
		"port":        v.Port,
		"role":        v.Role,
		"protocol":    v.Protocol,
		// pointer fields — nil → JSON null
		"uuid":                     v.UUID,
		"flow":                     v.Flow,
		"password":                 v.Password,
		"sni":                      v.SNI,
		"cert_id":                  v.CertID,
		"reality_private_key":      "[REDACTED]",
		"reality_public_key":       v.RealityPublicKey,
		"reality_short_id":         v.RealityShortID,
		"reality_handshake_server": v.RealityHandshakeServer,
		"reality_handshake_port":   v.RealityHandshakePort,
		"transport_path":           v.TransportPath,
		"transport_host":           v.TransportHost,
		"alter_id":                 v.AlterID,
		"ss_method":                v.SSMethod,
		"extra_json":               v.ExtraJSON,
		"upstream_inbound_id":      v.UpstreamInboundID,
		"custom_upstream_url":      v.CustomUpstreamURL,
		"relay_mode":               v.RelayMode,
		"ssh_forward_enabled":      v.SSHForwardEnabled,
		"ssh_host":                 v.SSHHost,
		"ssh_port":                 v.SSHPort,
		"ssh_username":             v.SSHUsername,
		"ssh_private_key":          v.SSHPrivateKey,
		"ssh_use_localhost":        v.SSHUseLocalhost,
		"created_at":               v.CreatedAt,
		"updated_at":               v.UpdatedAt,
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
		// Pre-flight the sing-box version gate. asyncDeploy discards the
		// error from AssembleAndDeploy and nothing writes
		// plugin_hosts.last_error, so a row the gate will refuse would
		// otherwise 201 and then silently freeze that server's config —
		// for this inbound *and every other inbound on the same server* —
		// with no UI signal at all. Reject at the boundary instead so the
		// dialog shows the reason.
		//
		// Create-only is sufficient: protocol/role/relay_mode are
		// immutable post-create (InboundPatch carries none of them and
		// patchInboundHandler never reads them from the body), so no
		// PATCH can introduce a snell row.
		if inboundNeeds114(body.Protocol, body.Role, body.RelayMode) {
			if err := snellVersionGate(r.Context(), deps.DB, body.ServerID, []string{body.Protocol}); err != nil {
				writeErr(w, 409, err.Error())
				return
			}
		}
		in := Inbound{
			ServerID:               body.ServerID,
			Tag:                    store.GenerateTag(body.Role),
			Alias:                  body.Alias,
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
			CustomUpstreamURL:      strings.TrimSpace(body.CustomUpstreamURL),
			RelayMode:              body.RelayMode,
			SSHForwardEnabled:      body.SSHForwardEnabled,
			SSHHost:                body.SSHHost,
			SSHPort:                body.SSHPort,
			SSHUsername:            body.SSHUsername,
			SSHPrivateKey:          body.SSHPrivateKey,
			SSHUseLocalhost:        body.SSHUseLocalhost,
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
		// Handshake fields were silently dropped here pre-fix — the
		// route accepted them but never threaded them into the patch
		// struct, so saving a new handshake host had no effect.
		if v, ok := body["reality_handshake_server"].(string); ok {
			patch.RealityHandshakeServer = &v
		}
		if v, ok := body["reality_handshake_port"].(float64); ok {
			port := int64(v)
			patch.RealityHandshakePort = &port
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
		if v, ok := body["custom_upstream_url"].(string); ok {
			patch.CustomUpstreamURL = &v
		}
		if v, ok := body["ssh_forward_enabled"].(bool); ok {
			patch.SSHForwardEnabled = &v
		}
		if v, ok := body["ssh_host"].(string); ok {
			patch.SSHHost = &v
		}
		if v, ok := body["ssh_port"].(float64); ok {
			port := int(v)
			patch.SSHPort = &port
		}
		if v, ok := body["ssh_username"].(string); ok {
			patch.SSHUsername = &v
		}
		if v, ok := body["ssh_private_key"].(string); ok {
			patch.SSHPrivateKey = &v
		}
		if v, ok := body["ssh_use_localhost"].(bool); ok {
			patch.SSHUseLocalhost = &v
		}
		if v, ok := body["alias"].(string); ok {
			patch.Alias = &v
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
		if patch.CustomUpstreamURL != nil {
			if row.Role != "relay" {
				writeErr(w, 409, "custom_upstream_url is only valid for relay inbounds")
				return
			}
			customURL := strings.TrimSpace(*patch.CustomUpstreamURL)
			if customURL == "" {
				writeErr(w, 409, "custom_upstream_url cannot be empty")
				return
			}
			if row.UpstreamInboundID != nil {
				writeErr(w, 409, "cannot add custom landing to a relay using an existing landing")
				return
			}
			if _, err := parseCustomLandingURL(customURL); err != nil {
				writeErr(w, 409, err.Error())
				return
			}
			*patch.CustomUpstreamURL = customURL
		}
		if row.Protocol == "snell-v6" && row.RelayMode != "forward" && patch.Password != nil {
			if n := len([]byte(*patch.Password)); n < 12 || n > 255 {
				writeErr(w, 409, "snell v6 psk length must be between 12 and 255 bytes")
				return
			}
		}
		sshEnabled := row.SSHForwardEnabled
		if patch.SSHForwardEnabled != nil {
			sshEnabled = *patch.SSHForwardEnabled
		}
		sshHost, sshPort, sshUsername, sshPrivateKey := row.SSHHost, row.SSHPort, row.SSHUsername, row.SSHPrivateKey
		if patch.SSHHost != nil {
			sshHost = *patch.SSHHost
		}
		if patch.SSHPort != nil {
			sshPort = *patch.SSHPort
		}
		if patch.SSHUsername != nil {
			sshUsername = *patch.SSHUsername
		}
		if patch.SSHPrivateKey != nil {
			sshPrivateKey = *patch.SSHPrivateKey
		}
		if err := validateSSHForward(sshEnabled, sshHost, sshPort, sshUsername, sshPrivateKey); err != nil {
			writeErr(w, 409, err.Error())
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
