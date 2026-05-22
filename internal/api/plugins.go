package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type PluginsAPI struct {
	Store        *plugins.Store
	Deps         plugins.Deps
	Driver       shepdb.Driver // for selecting per-driver plugin migrations
	// SecretFields lists, per plugin ID, top-level JSON field names to redact
	// from GET responses and preserve from PUT bodies when value equals "***".
	SecretFields map[string][]string
}

type manifestEntry struct {
	ID        string         `json:"id"`
	Meta      manifestMeta   `json:"meta"`
	Enabled   bool           `json:"enabled"`
	EnabledAt *string        `json:"enabled_at"`
	HostCount *int           `json:"host_count"`
}

type manifestMeta struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Icon        string `json:"icon"`
	Category    string `json:"category"`
	HostAware   bool   `json:"host_aware"`
}

func (a *PluginsAPI) List(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	hostCounts, _ := a.Store.HostCountByPlugin(ctx)
	out := []manifestEntry{}
	for _, p := range plugins.All() {
		meta := p.Meta()
		row, err := a.Store.Get(ctx, meta.ID)
		entry := manifestEntry{
			ID: meta.ID,
			Meta: manifestMeta{
				Name: meta.Name, Description: meta.Description,
				Icon: meta.Icon, Category: meta.Category,
				HostAware: meta.HostAware,
			},
		}
		if err == nil {
			entry.Enabled = row.Enabled
			if row.EnabledAt.Valid {
				s := row.EnabledAt.Time.UTC().Format("2006-01-02T15:04:05Z")
				entry.EnabledAt = &s
			}
		}
		if meta.HostAware {
			n := hostCounts[meta.ID]
			entry.HostCount = &n
		}
		out = append(out, entry)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func (a *PluginsAPI) Enable(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p, ok := plugins.Get(id)
	if !ok {
		writeError(w, 404, "unknown plugin")
		return
	}
	ctx := r.Context()
	row, _ := a.Store.Get(ctx, id)
	if row.Enabled {
		writeJSON(w, 200, map[string]any{"enabled": true})
		return
	}
	if err := plugins.RunPluginMigrations(ctx, a.Deps.DB, id, p.Migrations(a.Driver)); err != nil {
		writeError(w, 500, "migrations: "+err.Error())
		return
	}
	if err := p.OnEnable(ctx, a.Deps); err != nil {
		writeError(w, 500, "OnEnable: "+err.Error())
		return
	}
	if err := a.Store.UpsertEnabled(ctx, id, true); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"enabled": true})
}

func (a *PluginsAPI) Disable(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p, ok := plugins.Get(id)
	if !ok {
		writeError(w, 404, "unknown plugin")
		return
	}
	ctx := r.Context()
	row, _ := a.Store.Get(ctx, id)
	if !row.Enabled {
		writeJSON(w, 200, map[string]any{"enabled": false})
		return
	}
	// HostAware: best-effort undeploy on every host with status running|failed
	if ha, ok := p.(plugins.HostAware); ok {
		hosts, _ := a.Store.ListHosts(ctx, id)
		for _, h := range hosts {
			if h.Status == "running" || h.Status == "failed" {
				if err := ha.UndeployFromHost(ctx, a.Deps, h.ServerID); err != nil {
					_ = a.Store.SetHostStatus(ctx, id, h.ServerID, "stopped", h.DeployedVersion.String, err.Error())
				} else {
					_ = a.Store.SetHostStatus(ctx, id, h.ServerID, "stopped", h.DeployedVersion.String, "")
				}
			}
		}
	}
	if err := p.OnDisable(ctx, a.Deps); err != nil {
		writeError(w, 500, "OnDisable: "+err.Error())
		return
	}
	if err := a.Store.UpsertEnabled(ctx, id, false); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"enabled": false})
}

const redactedSentinel = "***"

func (a *PluginsAPI) GetConfig(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := plugins.Get(id); !ok {
		writeError(w, 404, "unknown plugin")
		return
	}
	row, err := a.Store.Get(r.Context(), id)
	if err != nil {
		writeError(w, 404, "not configured")
		return
	}
	out := map[string]any{}
	if len(row.ConfigJSON) > 0 {
		_ = json.Unmarshal(row.ConfigJSON, &out)
	}
	for _, k := range a.SecretFields[id] {
		if _, ok := out[k]; ok {
			out[k] = redactedSentinel
		}
	}
	writeJSON(w, 200, out)
}

func (a *PluginsAPI) PutConfig(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := plugins.Get(id); !ok {
		writeError(w, 404, "unknown plugin")
		return
	}
	var incoming map[string]any
	if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	row, _ := a.Store.Get(r.Context(), id)
	stored := map[string]any{}
	if len(row.ConfigJSON) > 0 {
		_ = json.Unmarshal(row.ConfigJSON, &stored)
	}
	secrets := map[string]bool{}
	for _, k := range a.SecretFields[id] {
		secrets[k] = true
	}
	for k, v := range incoming {
		if secrets[k] {
			if s, ok := v.(string); ok && s == redactedSentinel {
				continue
			}
		}
		stored[k] = v
	}
	merged, _ := json.Marshal(stored)
	if err := a.Store.PutConfig(r.Context(), id, merged); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

type hostBody struct {
	ServerID int64           `json:"server_id"`
	Version  string          `json:"version"`
	Config   json.RawMessage `json:"config"`
	Topology json.RawMessage `json:"topology"`
}

func (a *PluginsAPI) ListHosts(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p, ok := plugins.Get(id)
	if !ok { writeError(w, 404, "unknown plugin"); return }
	if _, ok := p.(plugins.HostAware); !ok { writeError(w, 404, "not host-aware"); return }
	hosts, err := a.Store.ListHosts(r.Context(), id)
	if err != nil { writeError(w, 500, err.Error()); return }
	out := make([]map[string]any, 0, len(hosts))
	for _, h := range hosts {
		out = append(out, hostRowToMap(h))
	}
	writeJSON(w, 200, out)
}

func (a *PluginsAPI) GetHost(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sid, _ := strconv.ParseInt(r.PathValue("server_id"), 10, 64)
	h, err := a.Store.GetHost(r.Context(), id, sid)
	if err != nil { writeError(w, 404, "no such host row"); return }
	writeJSON(w, 200, hostRowToMap(h))
}

func (a *PluginsAPI) PostHost(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "xray" {
		writeError(w, http.StatusGone, "POST /hosts is deprecated for xray; use POST /api/admin/plugins/xray/inbounds")
		return
	}
	p, ok := plugins.Get(id)
	if !ok { writeError(w, 404, "unknown plugin"); return }
	ha, ok := p.(plugins.HostAware)
	if !ok { writeError(w, 404, "not host-aware"); return }
	row, _ := a.Store.Get(r.Context(), id)
	if !row.Enabled { writeError(w, 400, "plugin disabled"); return }

	var body hostBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, 400, "bad json"); return
	}
	if body.ServerID == 0 { writeError(w, 400, "server_id required"); return }
	cfg := []byte(body.Config)
	if len(cfg) == 0 { cfg = []byte(`{}`) }

	// Sync pre-flight validation (plugin-specific).
	if v, ok := p.(plugins.DeployValidator); ok {
		if err := v.BeforeDeploy(r.Context(), a.Deps, body.ServerID, []byte(body.Topology)); err != nil {
			writeError(w, 409, err.Error())
			return
		}
	}

	host, err := a.Store.UpsertHost(r.Context(), id, body.ServerID, cfg, "deploying")
	if err != nil { writeError(w, 500, err.Error()); return }

	go func() {
		ctx := context.Background()
		if err := ha.DeployToHost(ctx, a.Deps, body.ServerID, body.Version, cfg); err != nil {
			_ = a.Store.SetHostStatus(ctx, id, body.ServerID, "failed", body.Version, err.Error())
			return
		}
		if c, ok := p.(plugins.DeployCommitter); ok {
			if err := c.AfterDeploy(ctx, a.Deps, body.ServerID, []byte(body.Topology)); err != nil {
				_ = a.Store.SetHostStatus(ctx, id, body.ServerID, "failed", body.Version,
					"deploy ok but topology persist failed: "+err.Error())
				return
			}
		}
		_ = a.Store.SetHostStatus(ctx, id, body.ServerID, "running", body.Version, "")
	}()
	writeJSON(w, 200, hostRowToMap(host))
}

func (a *PluginsAPI) DeleteHost(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "xray" {
		writeError(w, http.StatusGone, "DELETE /hosts is deprecated for xray; use DELETE /api/admin/plugins/xray/inbounds/{id}")
		return
	}
	sid, _ := strconv.ParseInt(r.PathValue("server_id"), 10, 64)
	p, ok := plugins.Get(id)
	if !ok { writeError(w, 404, "unknown plugin"); return }
	if v, ok := p.(plugins.UndeployValidator); ok {
		if err := v.BeforeUndeploy(r.Context(), a.Deps, sid); err != nil {
			writeError(w, 409, err.Error())
			return
		}
	}
	if ha, ok := p.(plugins.HostAware); ok {
		_ = ha.UndeployFromHost(r.Context(), a.Deps, sid)
	}
	if err := a.Store.DeleteHost(r.Context(), id, sid); err != nil {
		writeError(w, 500, err.Error()); return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func hostRowToMap(h plugins.HostRow) map[string]any {
	var cfg any
	_ = json.Unmarshal(h.ConfigJSON, &cfg)
	return map[string]any{
		"id":               h.ID,
		"server_id":        h.ServerID,
		"config":           cfg,
		"deployed_version": nullStringValue(h.DeployedVersion),
		"status":           h.Status,
		"last_error":       nullStringValue(h.LastError),
		"updated_at":       h.UpdatedAt.UTC().Format("2006-01-02T15:04:05Z"),
	}
}

func nullStringValue(s sql.NullString) any {
	if s.Valid { return s.String }
	return nil
}
