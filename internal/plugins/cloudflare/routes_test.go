package cloudflare

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

type collectMux struct{ h map[string]func(http.ResponseWriter, *http.Request) }
func (m *collectMux) HandleFunc(pat string, h func(http.ResponseWriter, *http.Request)) {
	if m.h == nil { m.h = map[string]func(http.ResponseWriter, *http.Request){} }
	m.h[pat] = h
}
func (m *collectMux) Handle(string, http.Handler) {}

func TestZonesEndpoint_UsesStoredToken(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "cf.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	st := &plugins.Store{DB: d, Now: time.Now}
	_ = st.UpsertEnabled(context.Background(), "cloudflare", true)
	_ = st.PutConfig(context.Background(), "cloudflare", []byte(`{"api_token":"abc"}`))

	cfSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer abc" {
			http.Error(w, "bad token", http.StatusUnauthorized); return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"result":  []map[string]any{{"id": "z1", "name": "example.com"}},
		})
	}))
	defer cfSrv.Close()

	p := New()
	p.baseURL = cfSrv.URL
	p.store = st
	mux := &collectMux{}
	p.RegisterRoutes(mux, plugins.Deps{DB: d})
	h := mux.h["GET /zones"]
	if h == nil { t.Fatal("GET /zones not registered") }

	r := httptest.NewRequest("GET", "/zones", nil)
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != 200 { t.Fatalf("code=%d body=%s", w.Code, w.Body.String()) }
	var out []map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if len(out) != 1 || out[0]["name"] != "example.com" {
		t.Fatalf("zones = %v", out)
	}
}
