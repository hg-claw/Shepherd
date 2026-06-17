package sshaudit

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

// collectMux captures each handler by its method+path string for direct
// invocation, the same pattern netquality/cloudflare tests use.
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

func setupRoutes(t *testing.T, exec plugins.HostExec, now time.Time) (*Plugin, *collectMux) {
	t.Helper()
	db := openTestDB(t)
	p := New()
	mux := &collectMux{}
	p.RegisterRoutes(mux, plugins.Deps{DB: db, HostExec: exec, Now: fixedNow(now)})
	return p, mux
}

func TestRoutes_PluginSatisfiesInterface(t *testing.T) {
	var _ plugins.Plugin = New()
	m := New().Meta()
	if m.ID != "sshaudit" || m.HostAware {
		t.Fatalf("meta mismatch: %+v", m)
	}
}

func TestRoutes_UpsertAndListHosts(t *testing.T) {
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	exec := &fakeHostExec{journalOut: ""}
	p, mux := setupRoutes(t, exec, now)

	// PUT enable with sub-60 interval → clamps to 60.
	req := httptest.NewRequest("PUT", "/hosts/1", bytes.NewBufferString(`{"enabled":true,"poll_interval_seconds":5}`))
	req.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	mux.h["PUT /hosts/{server_id}"](w, req)
	if w.Code != 200 {
		t.Fatalf("upsert status=%d body=%s", w.Code, w.Body.String())
	}
	p.wg.Wait() // let the enable-kick collect finish so the DB settles

	var interval int
	_ = p.deps.DB.Get(&interval, `SELECT poll_interval_seconds FROM sshaudit_hosts WHERE server_id=1`)
	if interval != 60 {
		t.Errorf("interval=%d want 60 (clamped)", interval)
	}

	// GET /hosts returns the row.
	w = httptest.NewRecorder()
	mux.h["GET /hosts"](w, httptest.NewRequest("GET", "/hosts", nil))
	if w.Code != 200 {
		t.Fatalf("list status=%d", w.Code)
	}
	var rows []hostRow
	if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ServerID != 1 || !rows[0].Enabled {
		t.Errorf("rows=%+v", rows)
	}
}

func TestRoutes_CollectThenEventsAndSummary(t *testing.T) {
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	exec := &fakeHostExec{journalOut: `2026-06-16T10:33:01+0000 h sshd[1]: Accepted password for root from 1.2.3.4 port 55012 ssh2
2026-06-16T10:33:03+0000 h sshd[2]: Failed password for root from 1.2.3.4 port 55014 ssh2
2026-06-16T10:33:04+0000 h sshd[3]: Failed password for invalid user admin from 5.6.7.8 port 55015 ssh2
2026-06-16T10:33:05+0000 h sshd[4]: Failed password for invalid user admin from 5.6.7.8 port 55016 ssh2`}
	p, mux := setupRoutes(t, exec, now)
	_ = p

	// POST collect.
	req := httptest.NewRequest("POST", "/hosts/1/collect", nil)
	req.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	mux.h["POST /hosts/{server_id}/collect"](w, req)
	if w.Code != 200 {
		t.Fatalf("collect status=%d body=%s", w.Code, w.Body.String())
	}
	var cres struct {
		OK       bool `json:"ok"`
		Inserted int  `json:"inserted"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &cres)
	if !cres.OK || cres.Inserted != 4 {
		t.Errorf("collect result=%+v want ok+4", cres)
	}

	// GET events (all).
	req = httptest.NewRequest("GET", "/hosts/1/events", nil)
	req.SetPathValue("server_id", "1")
	w = httptest.NewRecorder()
	mux.h["GET /hosts/{server_id}/events"](w, req)
	var all []eventRow
	_ = json.Unmarshal(w.Body.Bytes(), &all)
	if len(all) != 4 {
		t.Fatalf("events(all)=%d want 4", len(all))
	}
	// Newest first.
	if !all[0].TS.After(all[len(all)-1].TS) {
		t.Errorf("events not newest-first: %v ... %v", all[0].TS, all[len(all)-1].TS)
	}

	// GET events filtered to failed.
	req = httptest.NewRequest("GET", "/hosts/1/events?result=failed", nil)
	req.SetPathValue("server_id", "1")
	w = httptest.NewRecorder()
	mux.h["GET /hosts/{server_id}/events"](w, req)
	var failed []eventRow
	_ = json.Unmarshal(w.Body.Bytes(), &failed)
	if len(failed) != 3 {
		t.Errorf("events(failed)=%d want 3", len(failed))
	}
	for _, e := range failed {
		if e.Result != "failed" {
			t.Errorf("filter leaked a %q row", e.Result)
		}
	}

	// limit=1.
	req = httptest.NewRequest("GET", "/hosts/1/events?limit=1", nil)
	req.SetPathValue("server_id", "1")
	w = httptest.NewRecorder()
	mux.h["GET /hosts/{server_id}/events"](w, req)
	var lim []eventRow
	_ = json.Unmarshal(w.Body.Bytes(), &lim)
	if len(lim) != 1 {
		t.Errorf("events(limit=1)=%d want 1", len(lim))
	}

	// GET summary.
	req = httptest.NewRequest("GET", "/hosts/1/summary", nil)
	req.SetPathValue("server_id", "1")
	w = httptest.NewRecorder()
	mux.h["GET /hosts/{server_id}/summary"](w, req)
	if w.Code != 200 {
		t.Fatalf("summary status=%d body=%s", w.Code, w.Body.String())
	}
	var s summary
	_ = json.Unmarshal(w.Body.Bytes(), &s)
	if s.WindowHours != 24 {
		t.Errorf("window_hours=%d want 24", s.WindowHours)
	}
	if s.Accepted != 1 || s.Failed != 3 {
		t.Errorf("summary counts accepted=%d failed=%d want 1/3", s.Accepted, s.Failed)
	}
	if s.UniqueSourceIPs != 2 {
		t.Errorf("unique_source_ips=%d want 2", s.UniqueSourceIPs)
	}
	// 5.6.7.8 made 2 failed attempts → top source.
	if len(s.TopSources) == 0 || s.TopSources[0].SourceIP != "5.6.7.8" || s.TopSources[0].Count != 2 {
		t.Errorf("top_sources=%+v want 5.6.7.8 x2 first", s.TopSources)
	}
	// admin failed twice → top failed user.
	if len(s.TopFailedUsers) == 0 || s.TopFailedUsers[0].Username != "admin" || s.TopFailedUsers[0].Count != 2 {
		t.Errorf("top_failed_users=%+v want admin x2 first", s.TopFailedUsers)
	}
}

func TestRoutes_EventsBadResultRejected(t *testing.T) {
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	_, mux := setupRoutes(t, &fakeHostExec{}, now)
	req := httptest.NewRequest("GET", "/hosts/1/events?result=bogus", nil)
	req.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	mux.h["GET /hosts/{server_id}/events"](w, req)
	if w.Code != 400 {
		t.Errorf("status=%d want 400", w.Code)
	}
}

func TestRoutes_LiveSessions_ParsesWho(t *testing.T) {
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	exec := &fakeHostExec{whoOut: `root     pts/0        2026-06-16 09:00 (1.2.3.4)
ubuntu   pts/1        2026-06-16 09:01 (5.6.7.8)
console  tty1         2026-06-16 08:00`}
	_, mux := setupRoutes(t, exec, now)

	req := httptest.NewRequest("GET", "/hosts/1/sessions", nil)
	req.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	mux.h["GET /hosts/{server_id}/sessions"](w, req)
	if w.Code != 200 {
		t.Fatalf("sessions status=%d body=%s", w.Code, w.Body.String())
	}
	var res struct {
		CollectedAt string    `json:"collected_at"`
		Sessions    []session `json:"sessions"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.CollectedAt == "" {
		t.Error("collected_at empty")
	}
	if len(res.Sessions) != 3 {
		t.Fatalf("sessions=%d want 3: %+v", len(res.Sessions), res.Sessions)
	}
	if res.Sessions[0].User != "root" || res.Sessions[0].TTY != "pts/0" || res.Sessions[0].SourceIP != "1.2.3.4" {
		t.Errorf("session[0]=%+v", res.Sessions[0])
	}
	if res.Sessions[0].LoginAt != "2026-06-16 09:00" {
		t.Errorf("login_at=%q want '2026-06-16 09:00'", res.Sessions[0].LoginAt)
	}
	// Local console session has no source ip.
	if res.Sessions[2].SourceIP != "" {
		t.Errorf("local session got source_ip=%q want empty", res.Sessions[2].SourceIP)
	}
}

func TestRoutes_LiveSessions_502OnHostError(t *testing.T) {
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	exec := &fakeHostExec{whoErr: context.DeadlineExceeded}
	_, mux := setupRoutes(t, exec, now)
	req := httptest.NewRequest("GET", "/hosts/1/sessions", nil)
	req.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	mux.h["GET /hosts/{server_id}/sessions"](w, req)
	if w.Code != 502 {
		t.Errorf("status=%d want 502 (agent offline)", w.Code)
	}
}

func TestRoutes_Collect_502OnHostError(t *testing.T) {
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	exec := &fakeHostExec{journalErr: context.DeadlineExceeded}
	_, mux := setupRoutes(t, exec, now)
	req := httptest.NewRequest("POST", "/hosts/1/collect", nil)
	req.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	mux.h["POST /hosts/{server_id}/collect"](w, req)
	if w.Code != 502 {
		t.Errorf("status=%d want 502", w.Code)
	}
}
