package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func TestPluginEvents_FiltersByPluginPrefix(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "ev.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	now := time.Now().UTC()
	for _, row := range []struct{ a string; res string }{
		{"plugin.xray.host.deployed", "ok"},
		{"plugin.cloudflare.dns.created", "ok"},
		{"server.created", "ok"},
		{"plugin.xray.binary.downloaded", "ok"},
	} {
		_, _ = d.Exec(`INSERT INTO audit_log(ts, action, details_json, result) VALUES (?, ?, '{}', ?)`,
			now, row.a, row.res)
	}
	api := &PluginEventsAPI{DB: d}
	r := httptest.NewRequest("GET", "/api/admin/plugins/xray/events", nil)
	r.SetPathValue("id", "xray")
	w := httptest.NewRecorder()
	api.List(w, r)
	if w.Code != 200 {
		t.Fatalf("code=%d", w.Code)
	}
	var out []map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if len(out) != 2 {
		t.Fatalf("expected 2 xray events, got %d: %v", len(out), out)
	}
	for _, e := range out {
		action := e["action"].(string)
		if action[:11] != "plugin.xray" {
			t.Fatalf("unexpected action: %s", action)
		}
	}
}
