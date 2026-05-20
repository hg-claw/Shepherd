package xray

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/jmoiron/sqlx"
)

func newTrafficDB(t *testing.T) (*sqlx.DB, int64) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "q.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations())
	res, _ := d.Exec("INSERT INTO servers(name) VALUES ('h')")
	sid, _ := res.LastInsertId()
	// Seed one raw row 10 min ago
	ts := time.Now().UTC().Add(-10 * time.Minute).Truncate(time.Second)
	d.MustExec(`INSERT INTO xray_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
		VALUES (?, 'vless-reality-8443', 'inbound', ?, 1024, 2048)`, sid, ts)
	return d, sid
}

func TestTrafficQueryHandler_SingleTag(t *testing.T) {
	d, sid := newTrafficDB(t)
	h := trafficQueryHandler(d)

	from := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
	to := time.Now().UTC().Format(time.RFC3339)
	url := fmt.Sprintf("/traffic?server_id=%d&tag=vless-reality-8443&kind=inbound&from=%s&to=%s", sid, from, to)
	req := httptest.NewRequest("GET", url, nil)
	w := httptest.NewRecorder()
	h(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var resp trafficResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Points) != 1 {
		t.Errorf("points = %d, want 1", len(resp.Points))
	}
	if resp.Points[0].BytesUp != 1024 {
		t.Errorf("BytesUp = %d, want 1024", resp.Points[0].BytesUp)
	}
	if resp.Resolution != "raw" {
		t.Errorf("resolution = %q, want 'raw'", resp.Resolution)
	}
}

func TestTrafficQueryHandler_AutoResolution(t *testing.T) {
	d, sid := newTrafficDB(t)
	h := trafficQueryHandler(d)

	// Time range > 7d → should auto-select "hour"
	from := time.Now().UTC().Add(-8 * 24 * time.Hour).Format(time.RFC3339)
	to := time.Now().UTC().Format(time.RFC3339)
	url := fmt.Sprintf("/traffic?server_id=%d&tag=vless-reality-8443&kind=inbound&from=%s&to=%s", sid, from, to)
	req := httptest.NewRequest("GET", url, nil)
	w := httptest.NewRecorder()
	h(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var resp trafficResponse
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if resp.Resolution != "hour" {
		t.Errorf("resolution = %q, want 'hour'", resp.Resolution)
	}
}

func TestTrafficQueryHandler_AutoResolution_Minute(t *testing.T) {
	d, sid := newTrafficDB(t)
	h := trafficQueryHandler(d)

	// 2h < span < 7d → "minute"
	from := time.Now().UTC().Add(-3 * time.Hour).Format(time.RFC3339)
	to := time.Now().UTC().Format(time.RFC3339)
	url := fmt.Sprintf("/traffic?server_id=%d&tag=vless-reality-8443&kind=inbound&from=%s&to=%s", sid, from, to)
	req := httptest.NewRequest("GET", url, nil)
	w := httptest.NewRecorder()
	h(w, req)

	var resp trafficResponse
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if resp.Resolution != "minute" {
		t.Errorf("resolution = %q, want 'minute'", resp.Resolution)
	}
}

func TestTrafficQueryHandler_ExplicitResolution(t *testing.T) {
	d, sid := newTrafficDB(t)
	h := trafficQueryHandler(d)

	from := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
	to := time.Now().UTC().Format(time.RFC3339)
	url := fmt.Sprintf("/traffic?server_id=%d&tag=vless-reality-8443&kind=inbound&from=%s&to=%s&resolution=minute", sid, from, to)
	req := httptest.NewRequest("GET", url, nil)
	w := httptest.NewRecorder()
	h(w, req)

	var resp trafficResponse
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if resp.Resolution != "minute" {
		t.Errorf("resolution = %q, want 'minute'", resp.Resolution)
	}
}

func TestTrafficQueryHandler_MissingParams(t *testing.T) {
	d, _ := newTrafficDB(t)
	h := trafficQueryHandler(d)

	cases := []struct {
		name string
		url  string
	}{
		{"no server_id", "/traffic?tag=x&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z"},
		{"no tag", "/traffic?server_id=1&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z"},
		{"no from/to", "/traffic?server_id=1&tag=x"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", tc.url, nil)
			w := httptest.NewRecorder()
			h(w, req)
			if w.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400", w.Code)
			}
		})
	}
}

func TestTrafficBatchQueryHandler(t *testing.T) {
	d, sid := newTrafficDB(t)
	h := trafficBatchQueryHandler(d)

	from := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
	to := time.Now().UTC().Format(time.RFC3339)
	url := fmt.Sprintf("/traffic/batch?server_id=%d&tags=vless-reality-8443,vmess-ws-443&kind=inbound&from=%s&to=%s", sid, from, to)
	req := httptest.NewRequest("GET", url, nil)
	w := httptest.NewRecorder()
	h(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var resp trafficBatchResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Series) == 0 {
		t.Error("expected at least one series")
	}
	// Find the seeded tag
	found := false
	for _, s := range resp.Series {
		if s.Tag == "vless-reality-8443" {
			found = true
			if len(s.Points) != 1 {
				t.Errorf("vless-reality-8443 points = %d, want 1", len(s.Points))
			}
			if s.Points[0].BytesDown != 2048 {
				t.Errorf("BytesDown = %d, want 2048", s.Points[0].BytesDown)
			}
		}
	}
	if !found {
		t.Error("series missing tag vless-reality-8443")
	}
}

func TestTrafficBatchQueryHandler_MissingTags(t *testing.T) {
	d, sid := newTrafficDB(t)
	h := trafficBatchQueryHandler(d)

	from := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
	to := time.Now().UTC().Format(time.RFC3339)
	url := fmt.Sprintf("/traffic/batch?server_id=%d&from=%s&to=%s", sid, from, to)
	req := httptest.NewRequest("GET", url, nil)
	w := httptest.NewRecorder()
	h(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestChooseResolution(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name     string
		from, to time.Time
		explicit string
		want     string
	}{
		{"explicit raw", now.Add(-1 * time.Hour), now, "raw", "raw"},
		{"explicit minute", now.Add(-1 * time.Hour), now, "minute", "minute"},
		{"explicit hour", now.Add(-1 * time.Hour), now, "hour", "hour"},
		{"auto raw <2h", now.Add(-90 * time.Minute), now, "", "raw"},
		{"auto minute 2h-7d", now.Add(-3 * time.Hour), now, "", "minute"},
		{"auto hour >7d", now.Add(-8 * 24 * time.Hour), now, "", "hour"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := chooseResolution(tc.from, tc.to, tc.explicit)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Errorf("chooseResolution() = %q, want %q", got, tc.want)
			}
		})
	}
}
