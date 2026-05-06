package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/serversvc"
)

func newServersAPI(t *testing.T) *ServersAPI {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	return &ServersAPI{Servers: &serversvc.Service{DB: d}}
}

func TestServersCRUD_HTTP(t *testing.T) {
	api := newServersAPI(t)

	// Create
	body, _ := json.Marshal(createReq{Name: "h1"})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/servers", bytes.NewReader(body))
	api.Create(w, r)
	if w.Code != 201 {
		t.Fatalf("create status=%d", w.Code)
	}
	var created serversvc.Server
	_ = json.Unmarshal(w.Body.Bytes(), &created)

	// Get
	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/api/servers/"+strconv.FormatInt(created.ID, 10), nil)
	api.Get(w, r)
	if w.Code != 200 {
		t.Fatalf("get status=%d", w.Code)
	}

	// Patch
	body, _ = json.Marshal(map[string]any{"name": "renamed"})
	w = httptest.NewRecorder()
	r = httptest.NewRequest("PATCH", "/api/servers/"+strconv.FormatInt(created.ID, 10), bytes.NewReader(body))
	api.Patch(w, r)
	if w.Code != 200 {
		t.Fatalf("patch status=%d", w.Code)
	}

	// Delete
	w = httptest.NewRecorder()
	r = httptest.NewRequest("DELETE", "/api/servers/"+strconv.FormatInt(created.ID, 10), nil)
	api.Delete(w, r)
	if w.Code != 204 {
		t.Fatalf("delete status=%d", w.Code)
	}
}
