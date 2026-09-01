package mieru

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func newRoutesDB(t *testing.T) plugins.Deps {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "r.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	prev := asyncDeploy
	asyncDeploy = func(plugins.Deps, int64) {}
	t.Cleanup(func() { asyncDeploy = prev })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "mieru", loadMigrations(shepdb.DriverSQLite))
	for _, id := range []int64{1, 2} {
		d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,agent_os,agent_arch,created_at)
			VALUES (?,?,?,?,?,?,?,?)`,
			id, "s"+strconv.FormatInt(id, 10), "1.1.1."+strconv.FormatInt(id, 10), "root", 22, "linux", "amd64", time.Now())
	}
	return plugins.Deps{DB: d}
}

func postJSON(t *testing.T, h http.HandlerFunc, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/inbounds", bytes.NewReader(b))
	h(w, req)
	return w
}

func TestPostInbound_CreatesLanding(t *testing.T) {
	deps := newRoutesDB(t)
	w := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 2012, "username": "alice", "password": "secret",
	})
	if w.Code != 201 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var out map[string]any
	_ = json.NewDecoder(w.Body).Decode(&out)
	if out["protocol"] != "TCP" || out["username"] != "alice" || out["password"] != "secret" {
		t.Fatalf("resp=%#v", out)
	}
	if tag, _ := out["tag"].(string); len(tag) != len("landing-")+8 {
		t.Fatalf("tag=%q", out["tag"])
	}
}

func TestPostInbound_RejectsPortConflictIncludingBOTH(t *testing.T) {
	deps := newRoutesDB(t)
	w := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 3000, "protocol": "BOTH", "username": "a", "password": "b",
	})
	if w.Code != 201 {
		t.Fatalf("first: %d %s", w.Code, w.Body.String())
	}
	w = postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 3001, "protocol": "UDP", "username": "c", "password": "d",
	})
	if w.Code != 409 {
		t.Fatalf("want 409 for UDP on BOTH's port+1, got %d %s", w.Code, w.Body.String())
	}
}

func TestPostInbound_RejectsBadUsername(t *testing.T) {
	deps := newRoutesDB(t)
	w := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 2012, "username": "", "password": "secret",
	})
	if w.Code != 409 {
		t.Fatalf("want 409, got %d", w.Code)
	}
}

func TestGetInbounds_FiltersByServer(t *testing.T) {
	deps := newRoutesDB(t)
	_ = postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 2012, "username": "a", "password": "b",
	})
	_ = postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 2, "port": 2012, "username": "c", "password": "d",
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/inbounds?server_id=1", nil)
	getInboundsHandler(deps)(w, req)
	if w.Code != 200 {
		t.Fatalf("status=%d", w.Code)
	}
	var out []map[string]any
	_ = json.NewDecoder(w.Body).Decode(&out)
	if len(out) != 1 || out[0]["server_id"] != float64(1) {
		t.Fatalf("got %#v", out)
	}
}

func TestDeleteInbound(t *testing.T) {
	deps := newRoutesDB(t)
	w := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 2012, "username": "a", "password": "b",
	})
	var created map[string]any
	_ = json.NewDecoder(w.Body).Decode(&created)
	id := int(created["id"].(float64))
	dw := httptest.NewRecorder()
	req := httptest.NewRequest("DELETE", "/inbounds/"+strconv.Itoa(id), nil)
	req.SetPathValue("id", strconv.Itoa(id))
	deleteInboundHandler(deps)(dw, req)
	if dw.Code != 204 {
		t.Fatalf("delete status=%d body=%s", dw.Code, dw.Body.String())
	}
}

func TestMetaHostAware(t *testing.T) {
	var _ plugins.HostAware = New()
	var _ plugins.LogStreamer = New()
	var _ plugins.LifecycleManager = New()
	m := New().Meta()
	if m.ID != "mieru" || !m.HostAware {
		t.Fatalf("meta=%+v", m)
	}
}
