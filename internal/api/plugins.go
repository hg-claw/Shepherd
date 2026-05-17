package api

import (
	"encoding/json"
	"net/http"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

type PluginsAPI struct {
	Store *plugins.Store
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
