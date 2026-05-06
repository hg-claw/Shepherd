package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/serversvc"
	"github.com/hg-claw/Shepherd/internal/telemetrysvc"
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

func TestServersList_WithLatest(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)

	svc := &serversvc.Service{DB: d}
	ing := &telemetrysvc.Ingest{DB: d}
	q := &telemetrysvc.Query{DB: d}
	api := &ServersAPI{Servers: svc, Query: q}

	srv, _ := svc.Create(context.Background(), serversvc.CreateInput{Name: "h1"})
	now := time.Now().UTC().Truncate(time.Second)
	if err := ing.WriteSample(context.Background(), srv.ID, agentapi.Telemetry{
		TS: now, CPUPct: 12.5, MemUsed: 1, MemTotal: 2,
	}); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/servers?with=latest", nil)
	api.List(w, r)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var out []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 {
		t.Fatalf("want 1 server, got %d", len(out))
	}
	latest, ok := out[0]["latest"].(map[string]any)
	if !ok {
		t.Fatalf("missing latest object: %#v", out[0])
	}
	if latest["cpu_pct"] != 12.5 {
		t.Errorf("cpu_pct=%v want 12.5", latest["cpu_pct"])
	}
}

func TestServersList_NoLatestByDefault(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	svc := &serversvc.Service{DB: d}
	api := &ServersAPI{Servers: svc, Query: &telemetrysvc.Query{DB: d}}
	_, _ = svc.Create(context.Background(), serversvc.CreateInput{Name: "h1"})

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/servers", nil)
	api.List(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	var out []map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if _, has := out[0]["latest"]; has {
		t.Error("plain /api/servers should not include latest")
	}
}
