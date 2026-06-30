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

func TestRoutes_ListHostsPerHost24hCounts(t *testing.T) {
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	p, mux := setupRoutes(t, &fakeHostExec{}, now)
	if _, err := p.deps.DB.Exec(`INSERT INTO servers (id, name) VALUES (2, 's2')`); err != nil {
		t.Fatal(err)
	}

	// Two enabled hosts with distinct tallies; one event older than 24h is excluded.
	for _, sid := range []string{"1", "2"} {
		req := httptest.NewRequest("PUT", "/hosts/"+sid, bytes.NewBufferString(`{"enabled":true}`))
		req.SetPathValue("server_id", sid)
		w := httptest.NewRecorder()
		mux.h["PUT /hosts/{server_id}"](w, req)
		if w.Code != 200 {
			t.Fatalf("upsert %s status=%d body=%s", sid, w.Code, w.Body.String())
		}
	}
	p.wg.Wait()
	seedEvent(t, p, 1, now.Add(-1*time.Hour), "accepted", "root", "1.1.1.1")
	seedEvent(t, p, 1, now.Add(-2*time.Hour), "failed", "alice", "2.2.2.2")
	seedEvent(t, p, 1, now.Add(-3*time.Hour), "failed", "bob", "3.3.3.3")
	seedEvent(t, p, 2, now.Add(-1*time.Hour), "accepted", "root", "4.4.4.4")
	seedEvent(t, p, 1, now.Add(-30*time.Hour), "failed", "old", "9.9.9.9") // outside 24h

	w := httptest.NewRecorder()
	mux.h["GET /hosts"](w, httptest.NewRequest("GET", "/hosts", nil))
	var rows []hostRow
	if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	byID := map[int64]hostRow{}
	for _, r := range rows {
		byID[r.ServerID] = r
	}
	if byID[1].Accepted24h != 1 || byID[1].Failed24h != 2 {
		t.Errorf("host 1 = ✓%d ✗%d, want ✓1 ✗2 (30h-old excluded)", byID[1].Accepted24h, byID[1].Failed24h)
	}
	if byID[2].Accepted24h != 1 || byID[2].Failed24h != 0 {
		t.Errorf("host 2 = ✓%d ✗%d, want ✓1 ✗0", byID[2].Accepted24h, byID[2].Failed24h)
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

// seedEvent inserts one stored event directly, bypassing collect, so windowed
// queries can be exercised against events at controlled ages.
func seedEvent(t *testing.T, p *Plugin, sid int64, ts time.Time, result, user, ip string) {
	t.Helper()
	if _, err := p.deps.DB.Exec(`
		INSERT INTO sshaudit_events
		  (server_id, ts, result, method, invalid_user, username, source_ip, port, created_at)
		VALUES (?, ?, ?, 'password', 0, ?, ?, 22, ?)`,
		sid, ts.UTC(), result, user, ip, ts.UTC()); err != nil {
		t.Fatal(err)
	}
}

func TestRoutes_FleetOverview24h(t *testing.T) {
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	p, mux := setupRoutes(t, &fakeHostExec{}, now)
	// Two hosts; mixed results within and outside the 24h window.
	seedEvent(t, p, 1, now.Add(-1*time.Hour), "accepted", "root", "1.1.1.1")
	seedEvent(t, p, 1, now.Add(-2*time.Hour), "failed", "alice", "2.2.2.2")
	seedEvent(t, p, 2, now.Add(-3*time.Hour), "failed", "bob", "3.3.3.3")
	seedEvent(t, p, 2, now.Add(-30*time.Hour), "failed", "old", "4.4.4.4") // outside 24h

	req := httptest.NewRequest("GET", "/overview", nil)
	w := httptest.NewRecorder()
	mux.h["GET /overview"](w, req)
	if w.Code != 200 {
		t.Fatalf("overview status=%d body=%s", w.Code, w.Body.String())
	}
	var o struct {
		WindowHours int `json:"window_hours"`
		Accepted    int `json:"accepted"`
		Failed      int `json:"failed"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &o)
	if o.WindowHours != 24 || o.Accepted != 1 || o.Failed != 2 {
		t.Errorf("fleet overview = %+v, want {24 1 2} (fleet-wide, 24h only)", o)
	}
}

func TestRoutes_SummaryWindowSelectsRange(t *testing.T) {
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	p, mux := setupRoutes(t, &fakeHostExec{}, now)

	// Three failed events from distinct IPs at increasing ages: within 24h,
	// within 7d (but not 24h), within 30d (but not 7d).
	seedEvent(t, p, 1, now.Add(-1*time.Hour), "failed", "alice", "1.1.1.1")     // 24h window
	seedEvent(t, p, 1, now.Add(-3*24*time.Hour), "failed", "bob", "2.2.2.2")    // 7d window
	seedEvent(t, p, 1, now.Add(-10*24*time.Hour), "failed", "carol", "3.3.3.3") // 30d window

	get := func(window string) summary {
		req := httptest.NewRequest("GET", "/hosts/1/summary?window="+window, nil)
		req.SetPathValue("server_id", "1")
		w := httptest.NewRecorder()
		mux.h["GET /hosts/{server_id}/summary"](w, req)
		if w.Code != 200 {
			t.Fatalf("summary(%s) status=%d body=%s", window, w.Code, w.Body.String())
		}
		var s summary
		_ = json.Unmarshal(w.Body.Bytes(), &s)
		return s
	}

	s24 := get("24h")
	if s24.WindowHours != 24 || s24.Failed != 1 || s24.UniqueSourceIPs != 1 {
		t.Errorf("24h: window=%d failed=%d uniq=%d want 24/1/1", s24.WindowHours, s24.Failed, s24.UniqueSourceIPs)
	}
	s7 := get("7d")
	if s7.WindowHours != 168 || s7.Failed != 2 || s7.UniqueSourceIPs != 2 {
		t.Errorf("7d: window=%d failed=%d uniq=%d want 168/2/2", s7.WindowHours, s7.Failed, s7.UniqueSourceIPs)
	}
	s30 := get("30d")
	if s30.WindowHours != 720 || s30.Failed != 3 || s30.UniqueSourceIPs != 3 {
		t.Errorf("30d: window=%d failed=%d uniq=%d want 720/3/3", s30.WindowHours, s30.Failed, s30.UniqueSourceIPs)
	}

	// Unknown/absent window → default 24h.
	def := get("bogus")
	if def.WindowHours != 24 || def.Failed != 1 {
		t.Errorf("bogus window: window=%d failed=%d want 24/1", def.WindowHours, def.Failed)
	}
}

func TestRoutes_EventsWindowFilters(t *testing.T) {
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	p, mux := setupRoutes(t, &fakeHostExec{}, now)

	seedEvent(t, p, 1, now.Add(-1*time.Hour), "failed", "alice", "1.1.1.1")
	seedEvent(t, p, 1, now.Add(-3*24*time.Hour), "failed", "bob", "2.2.2.2")
	seedEvent(t, p, 1, now.Add(-10*24*time.Hour), "failed", "carol", "3.3.3.3")

	count := func(url string) int {
		req := httptest.NewRequest("GET", url, nil)
		req.SetPathValue("server_id", "1")
		w := httptest.NewRecorder()
		mux.h["GET /hosts/{server_id}/events"](w, req)
		if w.Code != 200 {
			t.Fatalf("events %q status=%d body=%s", url, w.Code, w.Body.String())
		}
		var rows []eventRow
		_ = json.Unmarshal(w.Body.Bytes(), &rows)
		return len(rows)
	}

	if n := count("/hosts/1/events?window=24h"); n != 1 {
		t.Errorf("window=24h → %d events, want 1", n)
	}
	if n := count("/hosts/1/events?window=7d"); n != 2 {
		t.Errorf("window=7d → %d events, want 2", n)
	}
	if n := count("/hosts/1/events?window=30d"); n != 3 {
		t.Errorf("window=30d → %d events, want 3", n)
	}
	// No window → no time filter (all rows).
	if n := count("/hosts/1/events"); n != 3 {
		t.Errorf("no window → %d events, want 3 (unfiltered)", n)
	}
	// window combined with result filter still applies both.
	if n := count("/hosts/1/events?window=24h&result=accepted"); n != 0 {
		t.Errorf("window=24h&result=accepted → %d events, want 0", n)
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
