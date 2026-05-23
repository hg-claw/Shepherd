package netquality

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

// collectMux is the cloudflare-test pattern: capture each handler by its
// method+path string, then invoke directly in test cases. Avoids having
// to spin a real ServeMux + GatedMux + auth chain.
type collectMux struct {
	h map[string]http.HandlerFunc
}

func (m *collectMux) HandleFunc(pat string, h func(http.ResponseWriter, *http.Request)) {
	if m.h == nil {
		m.h = map[string]http.HandlerFunc{}
	}
	m.h[pat] = h
}
func (m *collectMux) Handle(string, http.Handler) {}

func setupForRoutes(t *testing.T) (*Plugin, *collectMux) {
	t.Helper()
	db := openTestDB(t)
	for _, m := range New().Migrations(shepdb.DriverSQLite) {
		if _, err := db.Exec(m.SQL); err != nil {
			t.Fatal(err)
		}
	}
	if err := seedBuiltinTargets(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	// Insert one server row so /hosts upsert FK resolves.
	if _, err := db.Exec(`INSERT INTO servers (id, name) VALUES (1, 's1')`); err != nil {
		t.Fatal(err)
	}
	p := New()
	mux := &collectMux{}
	p.RegisterRoutes(mux, plugins.Deps{DB: db, Now: time.Now})
	return p, mux
}

func TestRoutes_ListTargets_ReturnsSeed(t *testing.T) {
	_, mux := setupForRoutes(t)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/targets", nil)
	mux.h["GET /targets"](w, r)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var rows []targetRow
	if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != len(builtinTargets) {
		t.Errorf("rows=%d want %d", len(rows), len(builtinTargets))
	}
}

func TestRoutes_CreateCustomTarget_AppearsInList(t *testing.T) {
	_, mux := setupForRoutes(t)
	body := `{"isp":"overseas","region":"AU","label":"Test Sydney","host":"203.0.113.5"}`
	w := httptest.NewRecorder()
	mux.h["POST /targets"](w, httptest.NewRequest("POST", "/targets", bytes.NewBufferString(body)))
	if w.Code != 201 {
		t.Fatalf("create status=%d body=%s", w.Code, w.Body.String())
	}
	w2 := httptest.NewRecorder()
	mux.h["GET /targets"](w2, httptest.NewRequest("GET", "/targets", nil))
	var rows []targetRow
	_ = json.Unmarshal(w2.Body.Bytes(), &rows)
	found := false
	for _, r := range rows {
		if r.Source == "custom" && r.Host == "203.0.113.5" {
			found = true
		}
	}
	if !found {
		t.Error("custom target missing from list after create")
	}
}

func TestRoutes_CreateCustomTarget_RejectsBadISP(t *testing.T) {
	_, mux := setupForRoutes(t)
	w := httptest.NewRecorder()
	mux.h["POST /targets"](w, httptest.NewRequest(
		"POST", "/targets", bytes.NewBufferString(`{"isp":"verizon","host":"x","label":"y"}`)))
	if w.Code != 400 {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestRoutes_PatchTarget_DisablesBuiltin(t *testing.T) {
	p, mux := setupForRoutes(t)
	// Grab any builtin target's id.
	var id int64
	_ = p.deps.DB.Get(&id, `SELECT id FROM netquality_targets WHERE source='builtin' LIMIT 1`)
	req := httptest.NewRequest("PATCH", "/targets/"+itoa(id), bytes.NewBufferString(`{"enabled":false}`))
	req.SetPathValue("id", itoa(id))
	w := httptest.NewRecorder()
	mux.h["PATCH /targets/{id}"](w, req)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var enabled bool
	_ = p.deps.DB.Get(&enabled, `SELECT enabled FROM netquality_targets WHERE id=?`, id)
	if enabled {
		t.Error("builtin target still enabled after PATCH")
	}
}

func TestRoutes_DeleteCustomTarget_RefusesBuiltin(t *testing.T) {
	p, mux := setupForRoutes(t)
	var id int64
	_ = p.deps.DB.Get(&id, `SELECT id FROM netquality_targets WHERE source='builtin' LIMIT 1`)
	req := httptest.NewRequest("DELETE", "/targets/"+itoa(id), nil)
	req.SetPathValue("id", itoa(id))
	w := httptest.NewRecorder()
	mux.h["DELETE /targets/{id}"](w, req)
	if w.Code != 404 {
		// 404 because the DELETE has `source='custom'` predicate — builtin
		// rows simply aren't matched. The error message tells the UI to
		// PATCH enabled=false instead.
		t.Errorf("status=%d body=%s; want 404 (builtin protected)", w.Code, w.Body.String())
	}
}

func TestRoutes_UpsertHost_InsertsThenUpdates(t *testing.T) {
	p, mux := setupForRoutes(t)
	body := `{"enabled":true,"sample_interval_seconds":120}`
	req := httptest.NewRequest("PUT", "/hosts/1", bytes.NewBufferString(body))
	req.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	mux.h["PUT /hosts/{server_id}"](w, req)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var got struct {
		Enabled  bool `db:"enabled"`
		Interval int  `db:"sample_interval_seconds"`
	}
	_ = p.deps.DB.Get(&got, `SELECT enabled, sample_interval_seconds FROM netquality_hosts WHERE server_id=1`)
	if !got.Enabled || got.Interval != 120 {
		t.Errorf("first upsert: %+v", got)
	}

	// Second call flips off and lowers interval — UPSERT path.
	body2 := `{"enabled":false,"sample_interval_seconds":60}`
	req = httptest.NewRequest("PUT", "/hosts/1", bytes.NewBufferString(body2))
	req.SetPathValue("server_id", "1")
	w = httptest.NewRecorder()
	mux.h["PUT /hosts/{server_id}"](w, req)
	_ = p.deps.DB.Get(&got, `SELECT enabled, sample_interval_seconds FROM netquality_hosts WHERE server_id=1`)
	if got.Enabled || got.Interval != 60 {
		t.Errorf("second upsert (update): %+v", got)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
