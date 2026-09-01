package mieru

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"
	"unicode"

	"github.com/hg-claw/Shepherd/internal/httpjson"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

var asyncDeploy = func(deps plugins.Deps, serverID int64) {
	go func() { _ = AssembleAndDeploy(context.Background(), deps, serverID) }()
}

type postInboundBody struct {
	ServerID      int64  `json:"server_id"`
	Port          int    `json:"port"`
	Alias         string `json:"alias"`
	Username      string `json:"username"`
	Password      string `json:"password"`
	Protocol      string `json:"protocol"`
	MTU           int    `json:"mtu"`
	Multiplexing  string `json:"multiplexing"`
	HandshakeMode string `json:"handshake_mode"`
}

func writeJSONResp(w http.ResponseWriter, code int, body any) {
	httpjson.Write(w, code, body)
}

func writeRouteError(w http.ResponseWriter, code int, msg string) {
	writeJSONResp(w, code, map[string]string{"error": msg})
}

func inboundToMap(v InboundView) map[string]any {
	return map[string]any{
		"id":             v.ID,
		"server_id":      v.ServerID,
		"server_name":    v.ServerName,
		"tag":            v.Tag,
		"alias":          v.Alias,
		"port":           v.Port,
		"protocol":       v.Protocol,
		"username":       v.Username,
		"password":       v.Password,
		"mtu":            v.MTU,
		"multiplexing":   v.Multiplexing,
		"handshake_mode": v.HandshakeMode,
		"created_at":     v.CreatedAt,
		"updated_at":     v.UpdatedAt,
	}
}

func validCred(s, field string) error {
	n := len(s)
	if n < 1 || n > 64 {
		return fmt.Errorf("%s must be 1-64 bytes", field)
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return fmt.Errorf("%s must not contain control characters", field)
		}
	}
	return nil
}

func validProtocol(p string) bool {
	return p == "TCP" || p == "UDP" || p == "BOTH"
}

func portsUsed(in Inbound) []int {
	if in.Protocol == "BOTH" {
		return []int{in.Port, in.Port + 1}
	}
	return []int{in.Port}
}

func validateEndpoints(ctx context.Context, store *InboundStore, serverID, exceptID int64, port int, proto string) error {
	if port < 1025 || port > 65535 {
		return errors.New("port must be 1025-65535")
	}
	if proto == "" {
		proto = "TCP"
	}
	if !validProtocol(proto) {
		return fmt.Errorf("protocol must be TCP, UDP, or BOTH, got %q", proto)
	}
	if proto == "BOTH" && port >= 65535 {
		return errors.New("BOTH requires port+1 <= 65535")
	}
	want := map[int]struct{}{}
	for _, p := range portsUsed(Inbound{Port: port, Protocol: proto}) {
		want[p] = struct{}{}
	}
	existing, err := store.ListByServer(ctx, serverID)
	if err != nil {
		return err
	}
	for _, e := range existing {
		if e.ID == exceptID {
			continue
		}
		for _, p := range portsUsed(e) {
			if _, ok := want[p]; ok {
				return fmt.Errorf("server %d already has inbound on port %d (tag=%s)", serverID, p, e.Tag)
			}
		}
	}
	return nil
}

func validatePostInbound(ctx context.Context, store *InboundStore, body postInboundBody) error {
	if body.ServerID == 0 {
		return errors.New("server_id required")
	}
	if err := validCred(body.Username, "username"); err != nil {
		return err
	}
	if err := validCred(body.Password, "password"); err != nil {
		return err
	}
	return validateEndpoints(ctx, store, body.ServerID, 0, body.Port, body.Protocol)
}

func postInboundHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body postInboundBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeRouteError(w, 400, "bad json")
			return
		}
		store := &InboundStore{DB: deps.DB}
		if err := validatePostInbound(r.Context(), store, body); err != nil {
			writeRouteError(w, 409, err.Error())
			return
		}
		if body.Protocol == "" {
			body.Protocol = "TCP"
		}
		in := Inbound{
			ServerID: body.ServerID, Port: body.Port, Alias: body.Alias,
			Protocol: body.Protocol, Username: body.Username, Password: body.Password,
			MTU: body.MTU, Multiplexing: body.Multiplexing, HandshakeMode: body.HandshakeMode,
		}
		id, err := store.Insert(r.Context(), in)
		if err != nil {
			writeRouteError(w, 500, err.Error())
			return
		}
		asyncDeploy(deps, body.ServerID)
		views, _ := store.ListAll(r.Context())
		for _, v := range views {
			if v.ID == id {
				writeJSONResp(w, 201, inboundToMap(v))
				return
			}
		}
		writeRouteError(w, 500, "inserted but not findable")
	}
}

func getInboundsHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		store := &InboundStore{DB: deps.DB}
		views, err := store.ListAll(r.Context())
		if err != nil {
			writeRouteError(w, 500, err.Error())
			return
		}
		var sid int64
		if raw := r.URL.Query().Get("server_id"); raw != "" {
			sid, _ = strconv.ParseInt(raw, 10, 64)
		}
		out := make([]map[string]any, 0, len(views))
		for _, v := range views {
			if sid != 0 && v.ServerID != sid {
				continue
			}
			out = append(out, inboundToMap(v))
		}
		writeJSONResp(w, 200, out)
	}
}

func patchInboundHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if id == 0 {
			writeRouteError(w, 400, "id required")
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeRouteError(w, 400, "bad json")
			return
		}
		store := &InboundStore{DB: deps.DB}
		row, err := store.GetByID(r.Context(), id)
		if err != nil {
			writeRouteError(w, 404, "not found")
			return
		}
		var patch InboundPatch
		if v, ok := body["port"].(float64); ok {
			p := int(v)
			patch.Port = &p
		}
		if v, ok := body["alias"].(string); ok {
			patch.Alias = &v
		}
		if v, ok := body["username"].(string); ok {
			if err := validCred(v, "username"); err != nil {
				writeRouteError(w, 409, err.Error())
				return
			}
			patch.Username = &v
		}
		if v, ok := body["password"].(string); ok && v != "" && v != "[REDACTED]" {
			if err := validCred(v, "password"); err != nil {
				writeRouteError(w, 409, err.Error())
				return
			}
			patch.Password = &v
		}
		if v, ok := body["protocol"].(string); ok {
			if !validProtocol(v) {
				writeRouteError(w, 409, "protocol must be TCP, UDP, or BOTH")
				return
			}
			patch.Protocol = &v
		}
		if v, ok := body["mtu"].(float64); ok {
			m := int(v)
			patch.MTU = &m
		}
		if v, ok := body["multiplexing"].(string); ok {
			patch.Multiplexing = &v
		}
		if v, ok := body["handshake_mode"].(string); ok {
			patch.HandshakeMode = &v
		}
		port := row.Port
		proto := row.Protocol
		if patch.Port != nil {
			port = *patch.Port
		}
		if patch.Protocol != nil {
			proto = *patch.Protocol
		}
		if err := validateEndpoints(r.Context(), store, row.ServerID, id, port, proto); err != nil {
			writeRouteError(w, 409, err.Error())
			return
		}
		if err := store.Update(r.Context(), id, patch); err != nil {
			writeRouteError(w, 500, err.Error())
			return
		}
		asyncDeploy(deps, row.ServerID)
		views, _ := store.ListAll(r.Context())
		for _, v := range views {
			if v.ID == id {
				writeJSONResp(w, 200, inboundToMap(v))
				return
			}
		}
		writeRouteError(w, 500, "updated but not findable")
	}
}

func deleteInboundHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if id == 0 {
			writeRouteError(w, 400, "id required")
			return
		}
		store := &InboundStore{DB: deps.DB}
		row, err := store.GetByID(r.Context(), id)
		if err != nil {
			writeRouteError(w, 404, "not found")
			return
		}
		if err := store.Delete(r.Context(), id); err != nil {
			writeRouteError(w, 500, err.Error())
			return
		}
		asyncDeploy(deps, row.ServerID)
		w.WriteHeader(http.StatusNoContent)
	}
}

type patchVersionBody struct {
	Version   string `json:"version"`
	UseMirror bool   `json:"use_mirror,omitempty"`
}

func patchServerVersionHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if sid == 0 {
			writeRouteError(w, 400, "id required")
			return
		}
		var body patchVersionBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeRouteError(w, 400, "bad json")
			return
		}
		if body.Version == "" {
			writeRouteError(w, 400, "version required")
			return
		}
		_, err := deps.DB.ExecContext(r.Context(), `
			INSERT INTO plugin_hosts(plugin_id, server_id, config_json, deployed_version, status, updated_at)
			VALUES ('mieru', $1, '{}', $2, 'deploying', $3)
			ON CONFLICT(plugin_id, server_id) DO UPDATE
			SET deployed_version = excluded.deployed_version,
			    status           = 'deploying',
			    updated_at       = excluded.updated_at`,
			sid, body.Version, time.Now().UTC())
		if err != nil {
			writeRouteError(w, 500, err.Error())
			return
		}
		go func() {
			ctx := context.Background()
			p := &Plugin{}
			if err := p.DeployToHost(ctx, deps, sid, body.Version, []byte("{}"), body.UseMirror); err != nil {
				_, _ = deps.DB.ExecContext(ctx,
					`UPDATE plugin_hosts SET status='failed', last_error=$1 WHERE plugin_id='mieru' AND server_id=$2`,
					err.Error(), sid)
				return
			}
			if err := AssembleAndDeploy(ctx, deps, sid); err != nil {
				_, _ = deps.DB.ExecContext(ctx,
					`UPDATE plugin_hosts SET status='failed', last_error=$1 WHERE plugin_id='mieru' AND server_id=$2`,
					err.Error(), sid)
				return
			}
			_, _ = deps.DB.ExecContext(ctx,
				`UPDATE plugin_hosts SET status='running', last_error='' WHERE plugin_id='mieru' AND server_id=$1`,
				sid)
		}()
		writeJSONResp(w, 200, map[string]any{"ok": true, "version": body.Version})
	}
}
