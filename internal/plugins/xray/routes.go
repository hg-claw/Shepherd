package xray

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

// latestFetcher can be overridden in tests.
var latestFetcher = func(ctx context.Context) ([]string, error) {
	return (&Releaser{}).ListLatestTags(ctx, 5)
}

var (
	latestMu    sync.Mutex
	latestVal   []string
	latestStamp time.Time
)

const latestTTL = 24 * time.Hour

// cachedLatest returns the most recent 5 xray release tags, refreshing at most
// once per latestTTL window. Cache miss / error falls back to whatever's
// cached (possibly empty). The 24h cap matches "list updates daily".
func cachedLatest(ctx context.Context) []string {
	latestMu.Lock()
	if time.Since(latestStamp) < latestTTL {
		out := append([]string(nil), latestVal...)
		latestMu.Unlock()
		return out
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

	mux.HandleFunc("POST /keys/x25519", func(w http.ResponseWriter, r *http.Request) {
		priv, pub, err := GenerateX25519()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"private_key": priv,
			"public_key":  pub,
		})
	})

	mux.HandleFunc("POST /keys/short-id", func(w http.ResponseWriter, r *http.Request) {
		id, err := GenerateShortID()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"short_id": id})
	})
}

type cachedBinary struct {
	Version      string    `json:"version"`
	OS           string    `json:"os"`
	Arch         string    `json:"arch"`
	SizeBytes    int64     `json:"size_bytes"`
	Sha256       string    `json:"sha256"`
	DownloadedAt time.Time `json:"downloaded_at"`
}

func listCached(ctx context.Context, db *sqlx.DB) ([]cachedBinary, error) {
	rows, err := db.QueryxContext(ctx,
		`SELECT version, os, arch, size_bytes, sha256, downloaded_at
		 FROM xray_binaries ORDER BY downloaded_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []cachedBinary{}
	for rows.Next() {
		var c cachedBinary
		if err := rows.Scan(&c.Version, &c.OS, &c.Arch, &c.SizeBytes, &c.Sha256, &c.DownloadedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
