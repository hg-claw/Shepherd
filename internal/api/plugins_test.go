package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type plainP struct{ id string }

func (p plainP) Meta() plugins.Meta              { return plugins.Meta{ID: p.id, Name: p.id, Category: "x"} }
func (plainP) Migrations() []plugins.Migration   { return nil }
func (plainP) RegisterRoutes(_ plugins.Mux, _ plugins.Deps) {}
func (plainP) OnEnable(_ context.Context, _ plugins.Deps) error  { return nil }
func (plainP) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }

type hostP struct{ plainP }

func (h hostP) Meta() plugins.Meta { m := h.plainP.Meta(); m.HostAware = true; return m }
func (hostP) DeployToHost(context.Context, plugins.Deps, int64, []byte) error { return nil }
func (hostP) UndeployFromHost(context.Context, plugins.Deps, int64) error      { return nil }
func (hostP) HostStatus(context.Context, plugins.Deps, int64) (plugins.HostStatus, error) {
	return plugins.HostStatus{}, nil
}

func setupPluginsAPI(t *testing.T) *PluginsAPI {
	t.Helper()
	plugins.ResetRegistryForTestPublic()
	plugins.Register(plainP{id: "a"})
	plugins.Register(hostP{plainP: plainP{id: "b"}})
	dsn := "file:" + filepath.Join(t.TempDir(), "api.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	return &PluginsAPI{Store: &plugins.Store{DB: d, Now: time.Now}}
}

func TestPluginsList_ReturnsAllRegistered(t *testing.T) {
	api := setupPluginsAPI(t)
	r := httptest.NewRequest("GET", "/api/admin/plugins", nil)
	w := httptest.NewRecorder()
	api.List(w, r)
	if w.Code != 200 {
		t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
	}
	var out []map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if len(out) != 2 || out[0]["id"] != "a" || out[1]["id"] != "b" {
		t.Fatalf("unexpected list: %v", out)
	}
	if out[1]["meta"].(map[string]any)["host_aware"] != true {
		t.Fatalf("b should be host_aware")
	}
}

type recordingP struct {
	plainP
	enableCalls  int
	disableCalls int
}

func (r *recordingP) Meta() plugins.Meta { return plugins.Meta{ID: "r", Name: "R"} }
func (r *recordingP) OnEnable(_ context.Context, _ plugins.Deps) error  { r.enableCalls++; return nil }
func (r *recordingP) OnDisable(_ context.Context, _ plugins.Deps) error { r.disableCalls++; return nil }
func (r *recordingP) Migrations() []plugins.Migration {
	return []plugins.Migration{{Name: "0001_r", SQL: "CREATE TABLE r_t (id INTEGER);"}}
}
func (*recordingP) RegisterRoutes(_ plugins.Mux, _ plugins.Deps) {}

func TestPluginsEnable_RunsMigrationsAndOnEnable(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	rec := &recordingP{}
	plugins.Register(rec)
	dsn := "file:" + filepath.Join(t.TempDir(), "en.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	api := &PluginsAPI{Store: &plugins.Store{DB: d, Now: time.Now}, Deps: plugins.Deps{DB: d, Now: time.Now}}

	r := httptest.NewRequest("POST", "/api/admin/plugins/r/enable", nil)
	r.SetPathValue("id", "r")
	w := httptest.NewRecorder()
	api.Enable(w, r)
	if w.Code != 200 { t.Fatalf("code=%d body=%s", w.Code, w.Body.String()) }
	if rec.enableCalls != 1 { t.Fatalf("enableCalls = %d", rec.enableCalls) }
	// verify migration ran by querying r_t (should not error)
	var n int
	if err := d.Get(&n, "SELECT COUNT(*) FROM r_t"); err != nil {
		t.Fatalf("r_t missing: %v", err)
	}

	// idempotency
	w = httptest.NewRecorder()
	api.Enable(w, r)
	if w.Code != 200 { t.Fatalf("re-enable code=%d", w.Code) }
	if rec.enableCalls != 1 { t.Fatalf("OnEnable re-fired: %d", rec.enableCalls) }
}

func TestPluginsDisable(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	rec := &recordingP{}
	plugins.Register(rec)
	dsn := "file:" + filepath.Join(t.TempDir(), "ds.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	api := &PluginsAPI{Store: &plugins.Store{DB: d, Now: time.Now}, Deps: plugins.Deps{DB: d, Now: time.Now}}

	r := httptest.NewRequest("POST", "/api/admin/plugins/r/enable", nil)
	r.SetPathValue("id", "r")
	api.Enable(httptest.NewRecorder(), r)

	r = httptest.NewRequest("POST", "/api/admin/plugins/r/disable", nil)
	r.SetPathValue("id", "r")
	w := httptest.NewRecorder()
	api.Disable(w, r)
	if w.Code != 200 { t.Fatalf("code=%d body=%s", w.Code, w.Body.String()) }
	if rec.disableCalls != 1 { t.Fatalf("disableCalls = %d", rec.disableCalls) }
	row, _ := api.Store.Get(context.Background(), "r")
	if row.Enabled { t.Fatal("expected enabled=false after disable") }
}
