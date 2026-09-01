package mieru

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/jmoiron/sqlx"
)

var latestFetcher = func(ctx context.Context) ([]string, error) {
	return (&Releaser{}).ListLatestTags(ctx, 5)
}

var (
	latestMu    sync.Mutex
	latestVal   []string
	latestStamp time.Time
)

const latestTTL = 24 * time.Hour

func cachedLatest(ctx context.Context) []string {
	latestMu.Lock()
	if time.Since(latestStamp) < latestTTL && latestVal != nil {
		defer latestMu.Unlock()
		return append([]string(nil), latestVal...)
	}
	latestMu.Unlock()
	tags, err := latestFetcher(ctx)
	latestMu.Lock()
	defer latestMu.Unlock()
	if err == nil {
		latestVal = tags
		latestStamp = time.Now()
	}
	return append([]string(nil), latestVal...)
}

func (p *Plugin) RegisterRoutes(mux plugins.Mux, deps plugins.Deps) {
	mux.HandleFunc("GET /versions", func(w http.ResponseWriter, r *http.Request) {
		cached, err := listCached(r.Context(), deps.DB)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		latest := cachedLatest(r.Context())
		if latest == nil {
			latest = []string{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"cached": cached,
			"latest": latest,
		})
	})
	mux.HandleFunc("POST /inbounds", postInboundHandler(deps))
	mux.HandleFunc("GET /inbounds", getInboundsHandler(deps))
	mux.HandleFunc("PATCH /inbounds/{id}", patchInboundHandler(deps))
	mux.HandleFunc("DELETE /inbounds/{id}", deleteInboundHandler(deps))
	mux.HandleFunc("PATCH /servers/{id}", patchServerVersionHandler(deps))
}

type cachedBinary struct {
	Version string `json:"version"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
}

func listCached(ctx context.Context, db *sqlx.DB) ([]cachedBinary, error) {
	var rows []struct {
		Version string `db:"deployed_version"`
	}
	err := db.SelectContext(ctx, &rows, `
		SELECT DISTINCT deployed_version FROM plugin_hosts
		 WHERE plugin_id='mieru' AND deployed_version IS NOT NULL AND deployed_version <> ''`)
	if err != nil {
		return nil, err
	}
	out := make([]cachedBinary, 0, len(rows))
	for _, r := range rows {
		out = append(out, cachedBinary{Version: r.Version, OS: "linux", Arch: "amd64"})
	}
	return out, nil
}
