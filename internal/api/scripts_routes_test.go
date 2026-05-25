package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/scriptsvc"
)

func TestScriptsRun_Unauth(t *testing.T) {
	a := &ScriptsAPI{}
	r := httptest.NewRequest("POST", "/api/admin/scripts/1/run", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	a.Run(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d", w.Code)
	}
}

// Regression: GET /api/admin/scripts/{id} had no route — only PATCH/DELETE
// were registered for that path, so the run page's single-script fetch
// 405'd and hung on "loading". This drives the handler directly and also
// asserts the full mux routes GET to it (not 405).
func TestScripts_GetByID(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "s.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	store := &scriptsvc.Store{DB: d, Now: time.Now}
	id, err := store.Create(context.Background(), &scriptsvc.Script{
		Name: "uptime", Content: "uptime\n", ParamsJSON: "[]",
	})
	if err != nil {
		t.Fatal(err)
	}

	a := &ScriptsAPI{Store: store}
	r := httptest.NewRequest("GET", "/api/admin/scripts/"+strconv.FormatInt(id, 10), nil)
	r.SetPathValue("id", strconv.FormatInt(id, 10))
	w := httptest.NewRecorder()
	a.Get(w, r)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var got scriptDTO
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.ID != id || got.Name != "uptime" {
		t.Fatalf("unexpected script: %+v", got)
	}
}

func TestScripts_GetByID_NotFound(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "s.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	a := &ScriptsAPI{Store: &scriptsvc.Store{DB: d}}
	r := httptest.NewRequest("GET", "/api/admin/scripts/999", nil)
	r.SetPathValue("id", "999")
	w := httptest.NewRecorder()
	a.Get(w, r)
	if w.Code != 404 {
		t.Fatalf("status=%d, want 404", w.Code)
	}
}
