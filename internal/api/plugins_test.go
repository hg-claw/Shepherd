package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
	xrayplugin "github.com/hg-claw/Shepherd/internal/plugins/xray"
)

type plainP struct{ id string }

func (p plainP) Meta() plugins.Meta              { return plugins.Meta{ID: p.id, Name: p.id, Category: "x"} }
func (plainP) Migrations(_ shepdb.Driver) []plugins.Migration { return nil }
func (plainP) RegisterRoutes(_ plugins.Mux, _ plugins.Deps) {}
func (plainP) OnEnable(_ context.Context, _ plugins.Deps) error  { return nil }
func (plainP) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }

type hostP struct{ plainP }

func (h hostP) Meta() plugins.Meta { m := h.plainP.Meta(); m.HostAware = true; return m }
func (hostP) DeployToHost(context.Context, plugins.Deps, int64, string, []byte) error { return nil }
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
	enableCalls  int
	disableCalls int
}

func (r *recordingP) Meta() plugins.Meta { return plugins.Meta{ID: "r", Name: "R"} }
func (r *recordingP) OnEnable(_ context.Context, _ plugins.Deps) error  { r.enableCalls++; return nil }
func (r *recordingP) OnDisable(_ context.Context, _ plugins.Deps) error { r.disableCalls++; return nil }
func (r *recordingP) Migrations(_ shepdb.Driver) []plugins.Migration {
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

func TestPluginsConfig_RedactsSecrets(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	plugins.Register(plainP{id: "p"})
	dsn := "file:" + filepath.Join(t.TempDir(), "cfg.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	st := &plugins.Store{DB: d, Now: time.Now}
	_ = st.UpsertEnabled(context.Background(), "p", true)
	_ = st.PutConfig(context.Background(), "p", []byte(`{"api_token":"abc123","public":"x"}`))
	api := &PluginsAPI{Store: st, Deps: plugins.Deps{DB: d, Now: time.Now},
		SecretFields: map[string][]string{"p": {"api_token"}}}

	r := httptest.NewRequest("GET", "/api/admin/plugins/p/config", nil)
	r.SetPathValue("id", "p")
	w := httptest.NewRecorder()
	api.GetConfig(w, r)
	if w.Code != 200 { t.Fatalf("code=%d", w.Code) }
	var got map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if got["api_token"] != "***" {
		t.Fatalf("api_token should be redacted: %v", got)
	}
	if got["public"] != "x" {
		t.Fatalf("public field should pass through: %v", got)
	}
}

func TestPluginsConfig_PutPreservesUneditedSecrets(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	plugins.Register(plainP{id: "p"})
	dsn := "file:" + filepath.Join(t.TempDir(), "put.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	st := &plugins.Store{DB: d, Now: time.Now}
	_ = st.UpsertEnabled(context.Background(), "p", true)
	_ = st.PutConfig(context.Background(), "p", []byte(`{"api_token":"real-secret","other":"v"}`))
	api := &PluginsAPI{Store: st, Deps: plugins.Deps{DB: d, Now: time.Now},
		SecretFields: map[string][]string{"p": {"api_token"}}}

	body := strings.NewReader(`{"api_token":"***","other":"new"}`)
	r := httptest.NewRequest("PUT", "/api/admin/plugins/p/config", body)
	r.SetPathValue("id", "p")
	w := httptest.NewRecorder()
	api.PutConfig(w, r)
	if w.Code != 200 { t.Fatalf("code=%d body=%s", w.Code, w.Body.String()) }
	row, _ := st.Get(context.Background(), "p")
	var stored map[string]any
	_ = json.Unmarshal(row.ConfigJSON, &stored)
	if stored["api_token"] != "real-secret" {
		t.Fatalf("redacted *** should NOT overwrite real secret; got %v", stored)
	}
	if stored["other"] != "new" {
		t.Fatalf("other field should be updated: %v", stored)
	}
}

func TestPluginsHosts_PostThenList(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	plugins.Register(hostP{plainP: plainP{id: "h"}})
	dsn := "file:" + filepath.Join(t.TempDir(), "h.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_, _ = d.Exec(`INSERT INTO servers(name) VALUES('s1')`)
	st := &plugins.Store{DB: d, Now: time.Now}
	_ = st.UpsertEnabled(context.Background(), "h", true)
	api := &PluginsAPI{Store: st, Deps: plugins.Deps{DB: d, Now: time.Now}}

	body := strings.NewReader(`{"server_id":1,"config":{"port":443}}`)
	r := httptest.NewRequest("POST", "/api/admin/plugins/h/hosts", body)
	r.SetPathValue("id", "h")
	w := httptest.NewRecorder()
	api.PostHost(w, r)
	if w.Code != 200 { t.Fatalf("post code=%d body=%s", w.Code, w.Body.String()) }

	r = httptest.NewRequest("GET", "/api/admin/plugins/h/hosts", nil)
	r.SetPathValue("id", "h")
	w = httptest.NewRecorder()
	api.ListHosts(w, r)
	var out []map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if len(out) != 1 || out[0]["server_id"].(float64) != 1 {
		t.Fatalf("ListHosts = %v", out)
	}
}

func TestPluginsHosts_DeleteCallsUndeploy(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	plugins.Register(hostP{plainP: plainP{id: "h"}})
	dsn := "file:" + filepath.Join(t.TempDir(), "h2.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_, _ = d.Exec(`INSERT INTO servers(name) VALUES('s1')`)
	st := &plugins.Store{DB: d, Now: time.Now}
	_ = st.UpsertEnabled(context.Background(), "h", true)
	_, _ = st.UpsertHost(context.Background(), "h", 1, []byte(`{}`), "running")
	api := &PluginsAPI{Store: st, Deps: plugins.Deps{DB: d, Now: time.Now}}

	r := httptest.NewRequest("DELETE", "/api/admin/plugins/h/hosts/1", nil)
	r.SetPathValue("id", "h")
	r.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	api.DeleteHost(w, r)
	if w.Code != 200 { t.Fatalf("code=%d", w.Code) }
	hosts, _ := st.ListHosts(context.Background(), "h")
	if len(hosts) != 0 { t.Fatalf("host should be deleted: %v", hosts) }
}

type validatorP struct {
	plainP
	beforeDeployErr      error
	beforeUndeployErr    error
	beforeDeployTopology string
	afterDeployTopology  string
	beforeUndeployCalled bool
}

func (v *validatorP) Meta() plugins.Meta { return plugins.Meta{ID: "v", Name: "V", HostAware: true} }
func (v *validatorP) DeployToHost(context.Context, plugins.Deps, int64, string, []byte) error { return nil }
func (v *validatorP) UndeployFromHost(context.Context, plugins.Deps, int64) error              { return nil }
func (v *validatorP) HostStatus(context.Context, plugins.Deps, int64) (plugins.HostStatus, error) {
	return plugins.HostStatus{}, nil
}
func (v *validatorP) BeforeDeploy(_ context.Context, _ plugins.Deps, _ int64, topology []byte) error {
	v.beforeDeployTopology = string(topology); return v.beforeDeployErr
}
func (v *validatorP) AfterDeploy(_ context.Context, _ plugins.Deps, _ int64, topology []byte) error {
	v.afterDeployTopology = string(topology); return nil
}
func (v *validatorP) BeforeUndeploy(_ context.Context, _ plugins.Deps, _ int64) error {
	v.beforeUndeployCalled = true; return v.beforeUndeployErr
}

// setupValidatorAPI returns a PluginsAPI with plugin "v" registered & enabled.
func setupValidatorAPI(t *testing.T, v *validatorP) *PluginsAPI {
	t.Helper()
	plugins.ResetRegistryForTestPublic()
	plugins.Register(v)
	dsn := "file:" + filepath.Join(t.TempDir(), "vapi.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil { t.Fatal(err) }
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil { t.Fatal(err) }
	store := &plugins.Store{DB: d, Now: time.Now}
	_ = store.UpsertEnabled(context.Background(), "v", true) // bypass /enable
	return &PluginsAPI{Store: store, Deps: plugins.Deps{DB: d}}
}

func TestPostHost_BeforeDeployRejectionReturns409(t *testing.T) {
	v := &validatorP{beforeDeployErr: errors.New("role mismatch on re-deploy")}
	api := setupValidatorAPI(t, v)
	body := `{"server_id":7,"topology":{"role":"relay"}}`
	req := httptest.NewRequest("POST", "/api/admin/plugins/v/hosts", strings.NewReader(body))
	req.SetPathValue("id", "v")
	w := httptest.NewRecorder()
	api.PostHost(w, req)
	if w.Code != 409 { t.Fatalf("status = %d want 409 (body: %s)", w.Code, w.Body.String()) }
	if v.beforeDeployTopology != `{"role":"relay"}` {
		t.Fatalf("BeforeDeploy got topology %q", v.beforeDeployTopology)
	}
}

func TestDeleteHost_BeforeUndeployRejectionReturns409(t *testing.T) {
	v := &validatorP{beforeUndeployErr: errors.New("landing has 2 relays")}
	api := setupValidatorAPI(t, v)
	req := httptest.NewRequest("DELETE", "/api/admin/plugins/v/hosts/5", nil)
	req.SetPathValue("id", "v"); req.SetPathValue("server_id", "5")
	w := httptest.NewRecorder()
	api.DeleteHost(w, req)
	if w.Code != 409 { t.Fatalf("status = %d want 409", w.Code) }
	if !v.beforeUndeployCalled { t.Fatalf("BeforeUndeploy not called") }
}

func TestPostHost_XrayReturns410(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	plugins.Register(xrayplugin.New())
	dsn := "file:" + filepath.Join(t.TempDir(), "x.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	defer func() { _ = d.Close() }()
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	store := &plugins.Store{DB: d, Now: time.Now}
	_ = store.UpsertEnabled(context.Background(), "xray", true)
	api := &PluginsAPI{Store: store, Deps: plugins.Deps{DB: d}}

	req := httptest.NewRequest("POST", "/api/admin/plugins/xray/hosts", strings.NewReader(`{"server_id":1}`))
	req.SetPathValue("id", "xray")
	w := httptest.NewRecorder()
	api.PostHost(w, req)
	if w.Code != 410 { t.Fatalf("status=%d want 410, body=%s", w.Code, w.Body.String()) }
	if !strings.Contains(w.Body.String(), "/inbounds") {
		t.Fatalf("body should mention /inbounds: %s", w.Body.String())
	}
}

func TestDeleteHost_XrayReturns410(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	plugins.Register(xrayplugin.New())
	dsn := "file:" + filepath.Join(t.TempDir(), "x.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	defer func() { _ = d.Close() }()
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	store := &plugins.Store{DB: d, Now: time.Now}
	_ = store.UpsertEnabled(context.Background(), "xray", true)
	api := &PluginsAPI{Store: store, Deps: plugins.Deps{DB: d}}

	req := httptest.NewRequest("DELETE", "/api/admin/plugins/xray/hosts/1", nil)
	req.SetPathValue("id", "xray")
	req.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	api.DeleteHost(w, req)
	if w.Code != 410 { t.Fatalf("status=%d want 410", w.Code) }
}
