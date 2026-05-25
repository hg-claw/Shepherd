package singbox

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

// TestGetVersions_ReturnsCachedAndLatest: GET /versions returns {cached:[...], latest:[...]}.
func TestGetVersions_ReturnsCachedAndLatest(t *testing.T) {
	deps := newRouteDeps(t)

	// Seed a binary row so cached is non-empty.
	deps.DB.MustExec(`INSERT INTO singbox_binaries(version, os, arch, size_bytes, sha256, downloaded_at)
		VALUES (?, ?, ?, ?, ?, ?)`, "1.11.5", "linux", "amd64", 1024, "deadbeef", time.Now())

	// Override latestFetcherSB to avoid real HTTP.
	origFetcher := latestFetcherSB
	latestFetcherSB = func(_ context.Context) ([]string, error) {
		return []string{"1.12.0", "1.11.5"}, nil
	}
	defer func() { latestFetcherSB = origFetcher }()
	// Reset cache so override is used.
	sbLatestMu.Lock()
	sbLatestStamp = time.Time{}
	sbLatestVal = nil
	sbLatestMu.Unlock()

	req := httptest.NewRequest("GET", "/versions", nil)
	rr := httptest.NewRecorder()
	getVersionsHandler(deps)(rr, req)

	if rr.Code != 200 {
		t.Fatalf("want 200, got %d: %s", rr.Code, rr.Body)
	}
	var out struct {
		Cached []map[string]any `json:"cached"`
		Latest []string         `json:"latest"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Cached) != 1 || out.Cached[0]["version"] != "1.11.5" {
		t.Fatalf("cached = %v", out.Cached)
	}
	if len(out.Latest) < 1 || out.Latest[0] != "1.12.0" {
		t.Fatalf("latest = %v", out.Latest)
	}
}

// TestPatchServerVersion_TriggersBinaryPushAndRestart: PATCH /servers/:id with version
// calls DeployToHost + AssembleAndDeploy and returns 200.
func TestPatchServerVersion_TriggersBinaryPushAndRestart(t *testing.T) {
	deps := newRouteDeps(t)
	// plugin_hosts.plugin_id FK → plugins.id requires a plugins row.
	deps.DB.MustExec(`INSERT OR IGNORE INTO plugins(id, enabled, config_json, created_at)
		VALUES ('singbox', 1, '{}', ?)`, time.Now())

	// Override deployFunc to record that it was called (avoid real Releaser).
	origDeploy := deployToHostFunc
	deployCalled := make(chan string, 1)
	deployToHostFunc = func(_ context.Context, d plugins.Deps, serverID int64, version string, useMirror bool) error {
		deployCalled <- version
		return nil
	}
	defer func() { deployToHostFunc = origDeploy }()

	b, _ := json.Marshal(map[string]any{"version": "1.11.5"})
	req := httptest.NewRequest("PATCH", "/servers/1", strings.NewReader(string(b)))
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("id", "1")
	rr := httptest.NewRecorder()
	patchSBServerVersionHandler(deps)(rr, req)

	if rr.Code != 200 {
		t.Fatalf("want 200, got %d: %s", rr.Code, rr.Body)
	}

	select {
	case ver := <-deployCalled:
		if ver != "1.11.5" {
			t.Errorf("deployToHostFunc called with version=%q, want 1.11.5", ver)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("deployToHostFunc not called within 2s")
	}
}
