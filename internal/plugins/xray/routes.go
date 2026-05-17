package xray

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func (p *Plugin) RegisterRoutes(mux plugins.Mux, deps plugins.Deps) {
	mux.HandleFunc("GET /versions", func(w http.ResponseWriter, r *http.Request) {
		cached, err := listCached(r.Context(), deps.DB)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"cached": cached})
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
