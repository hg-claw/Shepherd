package singbox

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/jmoiron/sqlx"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

// latestFetcherSB can be overridden in tests to avoid real HTTP calls.
var latestFetcherSB = func(ctx context.Context) ([]string, error) {
	return (&Releaser{}).ListLatestTags(ctx, 5)
}

var (
	sbLatestMu    sync.Mutex
	sbLatestVal   []string
	sbLatestStamp time.Time
)

const sbLatestTTL = 24 * time.Hour

// sbCachedLatest returns the most recent 5 sing-box release tags, refreshing
// at most once per sbLatestTTL window.
func sbCachedLatest(ctx context.Context) []string {
	sbLatestMu.Lock()
	if time.Since(sbLatestStamp) < sbLatestTTL {
		out := append([]string(nil), sbLatestVal...)
		sbLatestMu.Unlock()
		return out
	}
	sbLatestMu.Unlock()
	tags, err := latestFetcherSB(ctx)
	sbLatestMu.Lock()
	defer sbLatestMu.Unlock()
	if err == nil {
		sbLatestVal = tags
		sbLatestStamp = time.Now()
	}
	return append([]string(nil), sbLatestVal...)
}

type sbCachedBinary struct {
	Version      string    `json:"version"`
	OS           string    `json:"os"`
	Arch         string    `json:"arch"`
	SizeBytes    int64     `json:"size_bytes"`
	Sha256       string    `json:"sha256"`
	DownloadedAt time.Time `json:"downloaded_at"`
}

func sbListCached(ctx context.Context, db *sqlx.DB) ([]sbCachedBinary, error) {
	rows, err := db.QueryxContext(ctx,
		`SELECT version, os, arch, size_bytes, sha256, downloaded_at
		 FROM singbox_binaries ORDER BY downloaded_at DESC`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []sbCachedBinary{}
	for rows.Next() {
		var c sbCachedBinary
		if err := rows.Scan(&c.Version, &c.OS, &c.Arch, &c.SizeBytes, &c.Sha256, &c.DownloadedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// getVersionsHandler handles GET /versions.
// Returns {latest: [...], cached: [...]}.
func getVersionsHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cached, err := sbListCached(r.Context(), deps.DB)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		latest := sbCachedLatest(r.Context())
		if latest == nil {
			latest = []string{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"cached": cached,
			"latest": latest,
		})
	}
}

// deployToHostFunc is a package-level var that tests override to avoid real
// binary fetching. Production impl calls Plugin.DeployToHost.
var deployToHostFunc = func(ctx context.Context, deps plugins.Deps, serverID int64, version string) error {
	p := &Plugin{}
	return p.DeployToHost(ctx, deps, serverID, version, []byte("{}"))
}

type patchSBVersionBody struct {
	Version string `json:"version"`
}

// patchSBServerVersionHandler handles PATCH /servers/{id}.
// Body: {version: "..."}. Async: DeployToHost + AssembleAndDeploy.
func patchSBServerVersionHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if sid == 0 {
			writeErr(w, 400, "id required")
			return
		}
		var body patchSBVersionBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, 400, "bad json")
			return
		}
		if body.Version == "" {
			writeErr(w, 400, "version required")
			return
		}

		// UPSERT plugin_hosts row with new version (status=deploying).
		_, err := deps.DB.ExecContext(r.Context(), `
			INSERT INTO plugin_hosts(plugin_id, server_id, config_json, deployed_version, status, updated_at)
			VALUES ('singbox', $1, '{}', $2, 'deploying', $3)
			ON CONFLICT(plugin_id, server_id) DO UPDATE
			SET deployed_version = excluded.deployed_version,
			    status           = 'deploying',
			    updated_at       = excluded.updated_at`,
			sid, body.Version, time.Now().UTC())
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}

		// Async: push new binary + restart, then reassemble config.
		go func() {
			ctx := context.Background()
			if err := deployToHostFunc(ctx, deps, sid, body.Version); err != nil {
				_, _ = deps.DB.ExecContext(ctx,
					`UPDATE plugin_hosts SET status='failed', last_error=$1
					 WHERE plugin_id='singbox' AND server_id=$2`,
					err.Error(), sid)
				return
			}
			_, _ = deps.DB.ExecContext(ctx,
				`UPDATE plugin_hosts SET status='running', last_error=''
				 WHERE plugin_id='singbox' AND server_id=$1`,
				sid)
		}()

		writeJSON(w, 200, map[string]any{"ok": true, "version": body.Version})
	}
}
