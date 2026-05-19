package xray

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

type postInboundBody struct {
	ServerID          int64  `json:"server_id"`
	Port              int    `json:"port"`
	Role              string `json:"role"`
	Protocol          string `json:"protocol"`
	UUID              string `json:"uuid"`
	SNI               string `json:"sni"`
	PublicKey         string `json:"public_key"`
	PrivateKey        string `json:"private_key"`
	ShortID           string `json:"short_id"`
	WSPath            string `json:"ws_path"`
	SSMethod          string `json:"ss_method"`
	SSPassword        string `json:"ss_password"`
	UpstreamInboundID *int64 `json:"upstream_inbound_id"`
}

func writeJSONResp(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func writeRouteError(w http.ResponseWriter, code int, msg string) {
	writeJSONResp(w, code, map[string]string{"error": msg})
}

func inboundToMap(v InboundView) map[string]any {
	m := map[string]any{
		"id":          v.ID,
		"server_id":   v.ServerID,
		"server_name": v.ServerName,
		"tag":         v.Tag,
		"port":        v.Port,
		"role":        v.Role,
		"protocol":    v.Protocol,
		"uuid":        v.UUID,
		"sni":         v.SNI,
		"public_key":  v.PublicKey,
		"private_key": "[REDACTED]",
		"short_id":    v.ShortID,
		"ws_path":     v.WSPath,
		"ss_method":   v.SSMethod,
		"created_at":  v.CreatedAt,
		"updated_at":  v.UpdatedAt,
	}
	if v.UpstreamInboundID != nil {
		m["upstream_inbound_id"] = *v.UpstreamInboundID
		if v.UpstreamTag.Valid        { m["upstream_tag"] = v.UpstreamTag.String }
		if v.UpstreamServerID.Valid   { m["upstream_server_id"] = v.UpstreamServerID.Int64 }
		if v.UpstreamServerName.Valid { m["upstream_server_name"] = v.UpstreamServerName.String }
	}
	return m
}

// validatePostInbound runs all sync checks. Returns nil on success.
func validatePostInbound(ctx context.Context, store *InboundStore, body postInboundBody) error {
	if body.ServerID == 0 { return errors.New("server_id required") }
	if body.Port <= 0 || body.Port > 65535 { return errors.New("port out of range") }
	if body.Role != "landing" && body.Role != "relay" {
		return fmt.Errorf("role must be landing or relay, got %q", body.Role)
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
		if err != nil { return fmt.Errorf("upstream inbound %d not found", *body.UpstreamInboundID) }
		if upstream.Role != "landing" {
			return fmt.Errorf("upstream inbound %d is not a landing (role=%s)", upstream.ID, upstream.Role)
		}
	}
	return nil
}

func postInboundHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body postInboundBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeRouteError(w, 400, "bad json"); return
		}
		store := &InboundStore{DB: deps.DB}
		if err := validatePostInbound(r.Context(), store, body); err != nil {
			writeRouteError(w, 409, err.Error()); return
		}
		if body.Protocol == "" { body.Protocol = "vless-reality" }
		in := Inbound{
			ServerID: body.ServerID, Tag: store.GenerateTag(body.Role), Port: body.Port,
			Role: body.Role, Protocol: body.Protocol,
			UUID: body.UUID, SNI: body.SNI,
			PublicKey: body.PublicKey, PrivateKey: body.PrivateKey, ShortID: body.ShortID,
			WSPath: body.WSPath, SSMethod: body.SSMethod, SSPassword: body.SSPassword,
			UpstreamInboundID: body.UpstreamInboundID,
		}
		id, err := store.Insert(r.Context(), in)
		if err != nil { writeRouteError(w, 500, err.Error()); return }

		// Trigger reassemble + restart in background
		go func() { _ = AssembleAndDeploy(context.Background(), deps, body.ServerID) }()

		views, _ := store.ListAllWithUpstream(r.Context())
		for _, v := range views {
			if v.ID == id { writeJSONResp(w, 201, inboundToMap(v)); return }
		}
		writeRouteError(w, 500, "inserted but not findable")
	}
}

func getInboundsHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		store := &InboundStore{DB: deps.DB}
		views, err := store.ListAllWithUpstream(r.Context())
		if err != nil { writeRouteError(w, 500, err.Error()); return }
		filter := r.URL.Query().Get("server_id")
		out := []map[string]any{}
		for _, v := range views {
			if filter != "" {
				want, _ := strconv.ParseInt(filter, 10, 64)
				if v.ServerID != want { continue }
			}
			out = append(out, inboundToMap(v))
		}
		writeJSONResp(w, 200, out)
	}
}

func patchInboundHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if id == 0 { writeRouteError(w, 400, "id required"); return }
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeRouteError(w, 400, "bad json"); return
		}
		patch := InboundPatch{}
		if v, ok := body["port"].(float64);       ok { p := int(v); patch.Port = &p }
		if v, ok := body["uuid"].(string);        ok { patch.UUID = &v }
		if v, ok := body["sni"].(string);         ok { patch.SNI = &v }
		if v, ok := body["public_key"].(string);  ok { patch.PublicKey = &v }
		if v, ok := body["private_key"].(string); ok && v != "[REDACTED]" { patch.PrivateKey = &v }
		if v, ok := body["short_id"].(string);    ok { patch.ShortID = &v }
		if v, ok := body["ws_path"].(string);     ok { patch.WSPath = &v }
		if v, ok := body["ss_method"].(string);   ok { patch.SSMethod = &v }
		if v, ok := body["ss_password"].(string); ok { patch.SSPassword = &v }

		store := &InboundStore{DB: deps.DB}
		row, err := store.GetByID(r.Context(), id)
		if err != nil { writeRouteError(w, 404, "inbound not found"); return }

		if patch.Port != nil && *patch.Port != row.Port {
			others, _ := store.ListByServer(r.Context(), row.ServerID)
			for _, o := range others {
				if o.ID != id && o.Port == *patch.Port {
					writeRouteError(w, 409, fmt.Sprintf("port %d already in use by tag %s", *patch.Port, o.Tag))
					return
				}
			}
		}
		if err := store.Update(r.Context(), id, patch); err != nil {
			writeRouteError(w, 500, err.Error()); return
		}
		go func() { _ = AssembleAndDeploy(context.Background(), deps, row.ServerID) }()
		views, _ := store.ListAllWithUpstream(r.Context())
		for _, v := range views {
			if v.ID == id { writeJSONResp(w, 200, inboundToMap(v)); return }
		}
		writeRouteError(w, 500, "updated but not findable")
	}
}

func deleteInboundHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if id == 0 { writeRouteError(w, 400, "id required"); return }
		store := &InboundStore{DB: deps.DB}
		row, err := store.GetByID(r.Context(), id)
		if err != nil { writeRouteError(w, 404, "inbound not found"); return }
		if row.Role == "landing" {
			dependents, _ := store.ListByUpstream(r.Context(), id)
			if len(dependents) > 0 {
				ids := make([]int64, 0, len(dependents))
				for _, d := range dependents { ids = append(ids, d.ID) }
				writeJSONResp(w, 409, map[string]any{
					"error":             fmt.Sprintf("landing inbound %s has %d relay(s) depending on it", row.Tag, len(dependents)),
					"relay_inbound_ids": ids,
				})
				return
			}
		}
		if err := store.Delete(r.Context(), id); err != nil {
			writeRouteError(w, 500, err.Error()); return
		}
		go func() { _ = AssembleAndDeploy(context.Background(), deps, row.ServerID) }()
		writeJSONResp(w, 200, map[string]any{"ok": true})
	}
}

type patchVersionBody struct {
	Version string `json:"version"`
}

func patchServerVersionHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if sid == 0 { writeRouteError(w, 400, "id required"); return }
		var body patchVersionBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeRouteError(w, 400, "bad json"); return
		}
		if body.Version == "" { writeRouteError(w, 400, "version required"); return }

		// UPSERT plugin_hosts row with new version (status=deploying)
		_, err := deps.DB.ExecContext(r.Context(), `
			INSERT INTO plugin_hosts(plugin_id, server_id, config_json, deployed_version, status, updated_at)
			VALUES ('xray', ?, '{}', ?, 'deploying', ?)
			ON CONFLICT(plugin_id, server_id) DO UPDATE
			SET deployed_version = excluded.deployed_version,
			    status           = 'deploying',
			    updated_at       = excluded.updated_at`,
			sid, body.Version, time.Now().UTC())
		if err != nil { writeRouteError(w, 500, err.Error()); return }

		// Async: push new binary + restart, then reassemble config
		go func() {
			ctx := context.Background()
			p := &Plugin{}
			// DeployToHost fetches binary + pushes binary/unit/restart.
			// We pass {} as config; AssembleAndDeploy below puts the real config in place.
			if err := p.DeployToHost(ctx, deps, sid, body.Version, []byte("{}")); err != nil {
				_, _ = deps.DB.ExecContext(ctx,
					`UPDATE plugin_hosts SET status='failed', last_error=? WHERE plugin_id='xray' AND server_id=?`,
					err.Error(), sid)
				return
			}
			if err := AssembleAndDeploy(ctx, deps, sid); err != nil {
				_, _ = deps.DB.ExecContext(ctx,
					`UPDATE plugin_hosts SET status='failed', last_error=? WHERE plugin_id='xray' AND server_id=?`,
					err.Error(), sid)
				return
			}
			_, _ = deps.DB.ExecContext(ctx,
				`UPDATE plugin_hosts SET status='running', last_error='' WHERE plugin_id='xray' AND server_id=?`,
				sid)
		}()
		writeJSONResp(w, 200, map[string]any{"ok": true, "version": body.Version})
	}
}
