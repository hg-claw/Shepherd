package singbox

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
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	if err := plugins.RunPluginMigrations(context.Background(), d, "singbox", loadMigrations()); err != nil {
		t.Fatal(err)
	}
	res, _ := d.Exec("INSERT INTO servers(name) VALUES ('h')")
	sid, _ := res.LastInsertId()
	// Seed one raw row 10 min ago
	ts := time.Now().UTC().Add(-10 * time.Minute).Truncate(time.Second)
	d.MustExec(`INSERT INTO singbox_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
		VALUES (?, 'landing-aabb1122', 'landing', ?, 1024, 2048)`, sid, ts)
	return d, sid
}

func TestTrafficQueryHandler_SingleTag(t *testing.T) {
	d, sid := newTrafficDB(t)
	h := trafficQueryHandler(d)

	from := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
	to := time.Now().UTC().Format(time.RFC3339)
	url := fmt.Sprintf("/traffic?server_id=%d&tag=landing-aabb1122&kind=landing&from=%s&to=%s", sid, from, to)
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

func TestTrafficQueryHandler_AutoResolution_Raw(t *testing.T) {
	d, sid := newTrafficDB(t)
	h := trafficQueryHandler(d)

	// Time range <= 2h → should auto-select "raw"
	from := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
	to := time.Now().UTC().Format(time.RFC3339)
	url := fmt.Sprintf("/traffic?server_id=%d&tag=landing-aabb1122&kind=landing&from=%s&to=%s", sid, from, to)
	req := httptest.NewRequest("GET", url, nil)
	w := httptest.NewRecorder()
	h(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var resp trafficResponse
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if resp.Resolution != "raw" {
		t.Errorf("resolution = %q, want 'raw'", resp.Resolution)
	}
}

func TestTrafficQueryHandler_AutoResolution_Minute(t *testing.T) {
	d, sid := newTrafficDB(t)
	h := trafficQueryHandler(d)

	// 2h < span <= 7d → "minute"
	from := time.Now().UTC().Add(-3 * time.Hour).Format(time.RFC3339)
	to := time.Now().UTC().Format(time.RFC3339)
	url := fmt.Sprintf("/traffic?server_id=%d&tag=landing-aabb1122&kind=landing&from=%s&to=%s", sid, from, to)
	req := httptest.NewRequest("GET", url, nil)
	w := httptest.NewRecorder()
	h(w, req)

	var resp trafficResponse
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if resp.Resolution != "minute" {
		t.Errorf("resolution = %q, want 'minute'", resp.Resolution)
	}
}

func TestTrafficQueryHandler_AutoResolution_Hour(t *testing.T) {
	d, sid := newTrafficDB(t)
	h := trafficQueryHandler(d)

	// Time range > 7d → should auto-select "hour"
	from := time.Now().UTC().Add(-8 * 24 * time.Hour).Format(time.RFC3339)
	to := time.Now().UTC().Format(time.RFC3339)
	url := fmt.Sprintf("/traffic?server_id=%d&tag=landing-aabb1122&kind=landing&from=%s&to=%s", sid, from, to)
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

func TestTrafficBatchQueryHandler_MultipleTags(t *testing.T) {
	d, sid := newTrafficDB(t)
	h := trafficBatchQueryHandler(d)

	from := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
	to := time.Now().UTC().Format(time.RFC3339)
	url := fmt.Sprintf("/traffic/batch?server_id=%d&tags=landing-aabb1122,relay-ccdd3344&kind=landing&from=%s&to=%s", sid, from, to)
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
		if s.Tag == "landing-aabb1122" {
			found = true
			if len(s.Points) != 1 {
				t.Errorf("landing-aabb1122 points = %d, want 1", len(s.Points))
			}
			if s.Points[0].BytesDown != 2048 {
				t.Errorf("BytesDown = %d, want 2048", s.Points[0].BytesDown)
			}
		}
	}
	if !found {
		t.Error("series missing tag landing-aabb1122")
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
