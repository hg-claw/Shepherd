package xray

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func newRoutesDB(t *testing.T) (interface {
	MustExec(string, ...interface{}) sql.Result
}, plugins.Deps) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "r.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations(shepdb.DriverSQLite))
	for _, id := range []int64{1, 2, 3} {
		d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,agent_os,agent_arch,created_at)
			VALUES (?,?,?,?,?,?,?,?)`,
			id, "s"+strconv.FormatInt(id, 10), "1.1.1."+strconv.FormatInt(id, 10), "root", 22, "linux", "amd64", time.Now())
	}
	return d, plugins.Deps{DB: d, HostExec: &fakeHostExec{}}
}

func TestPostInbound_CreatesLandingAndAssignsTag(t *testing.T) {
	dRaw, deps := newRoutesDB(t)
	body := map[string]any{
		"server_id": 1, "port": 443, "role": "landing", "protocol": "vless-reality",
		"uuid": "u", "sni": "www.lovelive-anime.jp",
		"public_key": "P", "private_key": "K", "short_id": "aa",
	}
	b, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/inbounds", bytes.NewReader(b))
	postInboundHandler(deps)(w, req)
	if w.Code != 201 { t.Fatalf("status = %d body=%s", w.Code, w.Body.String()) }
	var out map[string]any
	_ = json.NewDecoder(w.Body).Decode(&out)
	if tag, _ := out["tag"].(string); len(tag) != len("landing-")+8 {
		t.Fatalf("tag = %q", out["tag"])
	}
	if out["private_key"] != "[REDACTED]" {
		t.Fatalf("private_key not redacted: %v", out["private_key"])
	}
	// DB row exists
	store := &InboundStore{DB: deps.DB}
	rows, _ := store.ListByServer(context.Background(), 1)
	if len(rows) != 1 { t.Fatalf("inbounds in DB = %d", len(rows)) }
	_ = dRaw
}

func TestPostInbound_RejectsPortConflict(t *testing.T) {
	_, deps := newRoutesDB(t)
	store := &InboundStore{DB: deps.DB}
	_, _ = store.Insert(context.Background(), Inbound{
		ServerID: 1, Tag: store.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality",
		UUID: "u", SNI: "s", PublicKey: "P", PrivateKey: "K", ShortID: "aa",
	})
	body := map[string]any{
		"server_id": 1, "port": 443, "role": "landing", "protocol": "vless-reality",
		"uuid": "u2", "sni": "s2", "public_key": "P2", "private_key": "K2", "short_id": "bb",
	}
	b, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/inbounds", bytes.NewReader(b))
	postInboundHandler(deps)(w, req)
	if w.Code != 409 { t.Fatalf("status = %d, want 409", w.Code) }
}

func TestPostInbound_RejectsRelayWithoutUpstream(t *testing.T) {
	_, deps := newRoutesDB(t)
	body := map[string]any{
		"server_id": 1, "port": 8443, "role": "relay", "protocol": "vless-reality",
		"uuid": "u", "sni": "s", "public_key": "P", "private_key": "K", "short_id": "aa",
	}
	b, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/inbounds", bytes.NewReader(b))
	postInboundHandler(deps)(w, req)
	if w.Code != 409 { t.Fatalf("status = %d, want 409", w.Code) }
}

func TestPostInbound_RejectsRelayPointingAtRelay(t *testing.T) {
	_, deps := newRoutesDB(t)
	store := &InboundStore{DB: deps.DB}
	landingID, _ := store.Insert(context.Background(), Inbound{
		ServerID: 1, Tag: store.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality",
		UUID: "u", SNI: "s", PublicKey: "P", PrivateKey: "K", ShortID: "aa",
	})
	relayID, _ := store.Insert(context.Background(), Inbound{
		ServerID: 2, Tag: store.GenerateTag("relay"), Port: 8443, Role: "relay", Protocol: "vless-reality",
		UUID: "u2", UpstreamInboundID: &landingID,
	})
	body := map[string]any{
		"server_id": 3, "port": 9443, "role": "relay", "protocol": "vless-reality",
		"uuid": "u3", "upstream_inbound_id": relayID,
	}
	b, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/inbounds", bytes.NewReader(b))
	postInboundHandler(deps)(w, req)
	if w.Code != 409 { t.Fatalf("status = %d, want 409", w.Code) }
}

func TestGetInbounds_FiltersByServer(t *testing.T) {
	_, deps := newRoutesDB(t)
	store := &InboundStore{DB: deps.DB}
	_, _ = store.Insert(context.Background(), Inbound{ServerID: 1, Tag: store.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality"})
	_, _ = store.Insert(context.Background(), Inbound{ServerID: 2, Tag: store.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality"})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/inbounds?server_id=1", nil)
	getInboundsHandler(deps)(w, req)
	if w.Code != 200 { t.Fatalf("code=%d", w.Code) }
	var out []map[string]any
	_ = json.NewDecoder(w.Body).Decode(&out)
	if len(out) != 1 { t.Fatalf("expected 1 inbound for server 1, got %d", len(out)) }
}

func TestPatchInbound_IgnoresImmutableFields(t *testing.T) {
	_, deps := newRoutesDB(t)
	store := &InboundStore{DB: deps.DB}
	id, _ := store.Insert(context.Background(), Inbound{
		ServerID: 1, Tag: store.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality",
		UUID: "u", SNI: "s", PublicKey: "P", PrivateKey: "K", ShortID: "aa",
	})
	body := map[string]any{
		"port": 8443, "uuid": "u-new",
		"role": "relay", "server_id": 99, "tag": "tag-new", "upstream_inbound_id": 7,
	}
	b, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("PATCH", "/inbounds/"+strconv.FormatInt(id, 10), bytes.NewReader(b))
	req.SetPathValue("id", strconv.FormatInt(id, 10))
	patchInboundHandler(deps)(w, req)
	if w.Code != 200 { t.Fatalf("status=%d body=%s", w.Code, w.Body.String()) }
	row, _ := store.GetByID(context.Background(), id)
	if row.Port != 8443 || row.UUID != "u-new" { t.Fatalf("mutable fields not applied: %+v", row) }
	if row.Role != "landing" || row.ServerID != 1 { t.Fatalf("immutable changed: %+v", row) }
}

func TestDeleteInbound_RejectsLandingWithRelays(t *testing.T) {
	_, deps := newRoutesDB(t)
	store := &InboundStore{DB: deps.DB}
	landingID, _ := store.Insert(context.Background(), Inbound{
		ServerID: 1, Tag: store.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality",
	})
	_, _ = store.Insert(context.Background(), Inbound{
		ServerID: 2, Tag: store.GenerateTag("relay"), Port: 8443, Role: "relay", Protocol: "vless-reality",
		UpstreamInboundID: &landingID,
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("DELETE", "/inbounds/"+strconv.FormatInt(landingID, 10), nil)
	req.SetPathValue("id", strconv.FormatInt(landingID, 10))
	deleteInboundHandler(deps)(w, req)
	if w.Code != 409 { t.Fatalf("status = %d, want 409", w.Code) }
}

func TestPatchServerVersion_TriggersBinaryPushAndRestart(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "v.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations(shepdb.DriverSQLite))

	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,agent_os,agent_arch,created_at)
		VALUES (1,'s1','1.1.1.1','r',22,'linux','amd64',?)`, time.Now())
	// plugins row required by plugin_hosts FK
	d.MustExec(`INSERT INTO plugins(id,enabled,created_at)
		VALUES ('xray',1,?)`, time.Now())
	// plugin_hosts row with old version (config_json default empty)
	d.MustExec(`INSERT INTO plugin_hosts(plugin_id,server_id,config_json,deployed_version,status,updated_at)
		VALUES ('xray',1,'{}','1.8.10','running',?)`, time.Now())

	exec := &fakeHostExec{}
	deps := plugins.Deps{DB: d, HostExec: exec}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("PATCH", "/servers/1", strings.NewReader(`{"version":"1.8.11"}`))
	req.SetPathValue("id", "1")
	patchServerVersionHandler(deps)(w, req)
	if w.Code != 200 { t.Fatalf("status=%d body=%s", w.Code, w.Body.String()) }

	var v string
	_ = d.Get(&v, `SELECT deployed_version FROM plugin_hosts WHERE server_id=1 AND plugin_id='xray'`)
	if v != "1.8.11" { t.Fatalf("deployed_version=%q", v) }
}

func TestRoutes_InboundAlias(t *testing.T) {
	_, deps := newRoutesDB(t)

	// POST: create inbound with alias
	createBody := map[string]any{
		"server_id": 1, "port": 443, "role": "landing", "protocol": "vless-reality",
		"uuid": "u", "sni": "www.lovelive-anime.jp",
		"public_key": "P", "private_key": "K", "short_id": "aa",
		"alias": "🇭🇰 HK 01",
	}
	b, _ := json.Marshal(createBody)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/inbounds", bytes.NewReader(b))
	postInboundHandler(deps)(w, req)
	if w.Code != 201 {
		t.Fatalf("create status = %d body=%s", w.Code, w.Body.String())
	}
	var created map[string]any
	_ = json.NewDecoder(w.Body).Decode(&created)
	if created["alias"] != "🇭🇰 HK 01" {
		t.Fatalf("create: alias = %v, want 🇭🇰 HK 01", created["alias"])
	}

	// Determine created id
	id := int64(created["id"].(float64))

	// PATCH: rename alias
	patchBody := map[string]any{"alias": "🇭🇰 HK renamed"}
	bp, _ := json.Marshal(patchBody)
	wp := httptest.NewRecorder()
	reqp := httptest.NewRequest("PATCH", "/inbounds/"+strconv.FormatInt(id, 10), bytes.NewReader(bp))
	reqp.SetPathValue("id", strconv.FormatInt(id, 10))
	patchInboundHandler(deps)(wp, reqp)
	if wp.Code != 200 {
		t.Fatalf("patch status = %d body=%s", wp.Code, wp.Body.String())
	}

	// GET list: confirm alias persisted
	wg := httptest.NewRecorder()
	reqg := httptest.NewRequest("GET", "/inbounds?server_id=1", nil)
	getInboundsHandler(deps)(wg, reqg)
	if wg.Code != 200 {
		t.Fatalf("list status = %d body=%s", wg.Code, wg.Body.String())
	}
	var list []map[string]any
	_ = json.NewDecoder(wg.Body).Decode(&list)
	if len(list) == 0 {
		t.Fatal("list: no inbounds returned")
	}
	if list[0]["alias"] != "🇭🇰 HK renamed" {
		t.Fatalf("list: alias = %v, want 🇭🇰 HK renamed", list[0]["alias"])
	}
}

// silence unused-import / unused-var compiler errors
var _ = http.StatusOK
