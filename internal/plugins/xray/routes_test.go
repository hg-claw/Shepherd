package xray

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func TestLogStreamCommand_Default(t *testing.T) {
	// Use an in-memory DB with a linux server so hostOSArch returns "linux".
	dsn := "file:" + filepath.Join(t.TempDir(), "lsc.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_, _ = d.Exec(`INSERT INTO servers(name, agent_os, agent_arch) VALUES('s', 'linux', 'amd64')`)

	p := New()
	deps := plugins.Deps{DB: d}
	name, args, err := p.LogStreamCommand(context.Background(), deps, 1)
	if err != nil {
		t.Fatal(err)
	}
	if name != "journalctl" {
		t.Fatalf("name=%s", name)
	}
	wantArgs := []string{"-u", "shepherd-xray", "-f", "--no-pager", "-n", "200", "-o", "short-iso"}
	for i, w := range wantArgs {
		if args[i] != w {
			t.Fatalf("args[%d]=%s want %s", i, args[i], w)
		}
	}
}

func TestVersionsEndpoint_ListsCache(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "v.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "xray", New().Migrations())
	_, _ = d.Exec(`INSERT INTO xray_binaries(version, os, arch, size_bytes, sha256, path, downloaded_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, "1.8.11", "linux", "amd64", 1, "x", "/p", time.Now())

	p := New()
	deps := plugins.Deps{DB: d, Now: time.Now}
	mux := &collectMux{}
	p.RegisterRoutes(mux, deps)

	h, ok := mux.handlers["GET /versions"]
	if !ok {
		t.Fatalf("versions route not registered: %v", mux.handlers)
	}
	r := httptest.NewRequest("GET", "/versions", nil)
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != 200 {
		t.Fatalf("code=%d", w.Code)
	}
	var out struct {
		Cached []map[string]any `json:"cached"`
		Latest []string         `json:"latest"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if len(out.Cached) != 1 || out.Cached[0]["version"] != "1.8.11" {
		t.Fatalf("cached = %v", out.Cached)
	}
	// latest is best-effort; httptest doesn't serve GitHub, so it may be empty but must be present.
	if out.Latest == nil {
		t.Fatalf("latest field missing from response")
	}
}

func TestCachedLatest_24hCached(t *testing.T) {
	calls := 0
	orig := latestFetcher
	latestFetcher = func(context.Context) ([]string, error) {
		calls++
		return []string{"1.0.0", "1.0.1"}, nil
	}
	defer func() {
		latestFetcher = orig
		latestStamp = time.Time{}
		latestVal = nil
	}()
	latestStamp = time.Time{} // force first call to miss
	latestVal = nil

	a := cachedLatest(context.Background())
	b := cachedLatest(context.Background())
	if calls != 1 {
		t.Fatalf("expected 1 fetch, got %d", calls)
	}
	if len(a) != 2 || len(b) != 2 {
		t.Fatalf("unexpected: %v %v", a, b)
	}
}

func TestTopologyHandler_ReturnsRowsWithUpstreamName(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "r.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "xray", New().Migrations())
	d.MustExec(`INSERT INTO servers(id, name) VALUES (1, 'landing-a'), (2, 'relay-b')`)
	store := &TopologyStore{DB: d, Now: time.Now}
	_ = store.UpsertLanding(context.Background(), 1)
	_ = store.UpsertRelay(context.Background(), 2, 1)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/topology", nil)
	topologyHandler(d)(w, req)   // exported handler factory used by RegisterRoutes
	if w.Code != 200 { t.Fatalf("status = %d body=%s", w.Code, w.Body.String()) }

	var out map[string]struct {
		Role             string  `json:"role"`
		UpstreamServerID *int64  `json:"upstream_server_id"`
		UpstreamName     *string `json:"upstream_name"`
	}
	if err := json.NewDecoder(w.Body).Decode(&out); err != nil { t.Fatal(err) }
	if out["1"].Role != "landing" { t.Fatalf("server 1: %+v", out["1"]) }
	if out["2"].Role != "relay" || out["2"].UpstreamServerID == nil || *out["2"].UpstreamServerID != 1 {
		t.Fatalf("server 2: %+v", out["2"])
	}
	if out["2"].UpstreamName == nil || *out["2"].UpstreamName != "landing-a" {
		t.Fatalf("server 2 upstream_name: %v", out["2"].UpstreamName)
	}
}

// collectMux records HandleFunc calls so tests can pull the handler out.
type collectMux struct{ handlers map[string]func(http.ResponseWriter, *http.Request) }

func (m *collectMux) HandleFunc(pat string, h func(http.ResponseWriter, *http.Request)) {
	if m.handlers == nil {
		m.handlers = map[string]func(http.ResponseWriter, *http.Request){}
	}
	m.handlers[pat] = h
}
func (m *collectMux) Handle(string, http.Handler) {}
