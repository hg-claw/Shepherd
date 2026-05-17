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
	p := New()
	name, args, err := p.LogStreamCommand(1)
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

// collectMux records HandleFunc calls so tests can pull the handler out.
type collectMux struct{ handlers map[string]func(http.ResponseWriter, *http.Request) }

func (m *collectMux) HandleFunc(pat string, h func(http.ResponseWriter, *http.Request)) {
	if m.handlers == nil {
		m.handlers = map[string]func(http.ResponseWriter, *http.Request){}
	}
	m.handlers[pat] = h
}
func (m *collectMux) Handle(string, http.Handler) {}
