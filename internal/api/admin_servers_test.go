package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/agentsvc"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/serversvc"
	"github.com/hg-claw/Shepherd/internal/telemetrysvc"
)

func newServersAPI(t *testing.T) *ServersAPI {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
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
	t.Cleanup(func() { _ = d.Close() })
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
	t.Cleanup(func() { _ = d.Close() })
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

// newServersAPIForTest returns a ServersAPI wired with both Servers and
// Tokens (agentsvc.Service) backed by an in-memory SQLite DB.
func newServersAPIForTest(t *testing.T) *ServersAPI {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	return &ServersAPI{
		Servers: &serversvc.Service{DB: d},
		Tokens:  &agentsvc.Service{DB: d},
	}
}

func TestServersAPI_ScriptInstall(t *testing.T) {
	a := newServersAPIForTest(t)
	a.BuildVersion = "v0.5.0"
	a.PublicURL = "https://shepherd.example.com"

	body := strings.NewReader(`{"name":"vps-1","public_alias":"hk-01","show_on_public":true}`)
	req := httptest.NewRequest("POST", "/api/servers/script", body)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	a.ScriptInstall(rr, req)

	if rr.Code != 201 {
		t.Fatalf("status %d: %s", rr.Code, rr.Body)
	}
	var got struct {
		ServerID  int64  `json:"server_id"`
		Token     string `json:"token"`
		Command   string `json:"command"`
		ExpiresAt string `json:"expires_at"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ServerID == 0 || got.Token == "" {
		t.Fatalf("missing fields: %+v", got)
	}
	if !strings.Contains(got.Command, "--token "+got.Token) {
		t.Errorf("command does not embed token: %s", got.Command)
	}
	if !strings.Contains(got.Command, "v0.5.0") {
		t.Errorf("command not pinned to BuildVersion: %s", got.Command)
	}
}

func TestServersAPI_InstallCommand(t *testing.T) {
	a := newServersAPIForTest(t)
	a.BuildVersion = "v0.5.0"
	a.PublicURL = "https://shepherd.example.com"

	// Seed a server row first via ScriptInstall (so the row exists).
	req := httptest.NewRequest("POST", "/api/servers/script",
		strings.NewReader(`{"name":"vps-2","show_on_public":false}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	a.ScriptInstall(rr, req)
	var seeded struct {
		ServerID int64 `json:"server_id"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &seeded)

	// Now ask for a fresh install command on that existing server.
	icReq := httptest.NewRequest("POST", fmt.Sprintf("/api/servers/%d/install-command", seeded.ServerID), nil)
	icReq.SetPathValue("id", fmt.Sprintf("%d", seeded.ServerID))
	icRR := httptest.NewRecorder()
	a.InstallCommand(icRR, icReq)
	if icRR.Code != 200 {
		t.Fatalf("status %d: %s", icRR.Code, icRR.Body)
	}
	var got struct {
		ServerID int64  `json:"server_id"`
		Token    string `json:"token"`
		Command  string `json:"command"`
	}
	if err := json.Unmarshal(icRR.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ServerID != seeded.ServerID {
		t.Errorf("server_id = %d, want %d", got.ServerID, seeded.ServerID)
	}
	if got.Token == "" {
		t.Error("token empty")
	}
	if !strings.Contains(got.Command, "--token "+got.Token) {
		t.Errorf("command missing token: %s", got.Command)
	}
}

func TestServersAPI_InstallCommand_NotFound(t *testing.T) {
	a := newServersAPIForTest(t)
	a.BuildVersion = "v0.5.0"
	a.PublicURL = "https://x"

	req := httptest.NewRequest("POST", "/api/servers/9999/install-command", nil)
	req.SetPathValue("id", "9999")
	rr := httptest.NewRecorder()
	a.InstallCommand(rr, req)
	if rr.Code != 404 {
		t.Fatalf("want 404, got %d", rr.Code)
	}
}

func TestServersAPI_ScriptInstall_NameRequired(t *testing.T) {
	a := newServersAPIForTest(t)
	a.BuildVersion = "v0.5.0"
	a.PublicURL = "https://x"
	req := httptest.NewRequest("POST", "/api/servers/script", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	a.ScriptInstall(rr, req)
	if rr.Code != 400 {
		t.Fatalf("want 400, got %d", rr.Code)
	}
}

func TestServersAPI_Inventory(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)

	svc := &serversvc.Service{DB: d}
	q := &telemetrysvc.Query{DB: d}
	a := &ServersAPI{Servers: svc, Query: q}

	srv, _ := svc.Create(context.Background(), serversvc.CreateInput{Name: "inv-host"})
	sid := srv.ID

	ing := &telemetrysvc.Ingest{DB: d}
	_ = ing.WriteHostInventory(context.Background(), sid, agentapi.HostInventory{
		CPUPhysical: 4, CPULogical: 8, CPUModel: "Xeon", MemTotal: 1 << 30, DiskTotal: 2 << 30,
		GPUs: []agentapi.GPU{{Name: "RTX 4090", VRAMMiB: 24564}},
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/servers/"+strconv.FormatInt(sid, 10)+"/inventory", nil)
	a.Inventory(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{`"cpu_physical":4`, `"cpu_logical":8`, `"disk_total":2147483648`, `"RTX 4090"`, `"vram_mib":24564`} {
		if !strings.Contains(body, want) {
			t.Errorf("body missing %q: %s", want, body)
		}
	}

	// a different server with no inventory → null body, 200
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("GET", "/api/servers/99999/inventory", nil)
	a.Inventory(rec2, req2)
	if rec2.Code != 200 || strings.TrimSpace(rec2.Body.String()) != "null" {
		t.Fatalf("missing inventory: code=%d body=%q", rec2.Code, rec2.Body.String())
	}
}

func TestServersAPI_Traffic(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)

	svc := &serversvc.Service{DB: d}
	q := &telemetrysvc.Query{DB: d}
	a := &ServersAPI{Servers: svc, Query: q}

	srv, _ := svc.Create(context.Background(), serversvc.CreateInput{Name: "traffic-host"})
	sid := srv.ID

	rec := httptest.NewRecorder()
	a.Traffic(rec, httptest.NewRequest("GET", "/api/servers/"+strconv.FormatInt(sid, 10)+"/traffic", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"reset_day":1`) || !strings.Contains(rec.Body.String(), `"cum_bytes_up":0`) {
		t.Fatalf("default GET: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	a.SetTrafficResetDay(rec, httptest.NewRequest("POST", "/api/servers/"+strconv.FormatInt(sid, 10)+"/traffic/reset-day",
		strings.NewReader(`{"reset_day":15}`)))
	if rec.Code != 204 {
		t.Fatalf("set-day: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	a.SetTrafficResetDay(rec, httptest.NewRequest("POST", "/api/servers/"+strconv.FormatInt(sid, 10)+"/traffic/reset-day",
		strings.NewReader(`{"reset_day":31}`)))
	if rec.Code != 400 {
		t.Fatalf("set-day invalid should 400: %d", rec.Code)
	}

	ctx := context.Background()
	_, _ = a.Query.DB.ExecContext(ctx, `UPDATE host_traffic SET cum_bytes_up=99 WHERE server_id=$1`, sid)
	rec = httptest.NewRecorder()
	a.ResetTraffic(rec, httptest.NewRequest("POST", "/api/servers/"+strconv.FormatInt(sid, 10)+"/traffic/reset", nil))
	if rec.Code != 204 {
		t.Fatalf("reset: %d %s", rec.Code, rec.Body.String())
	}
	row, _ := a.Query.HostTraffic(ctx, sid)
	if row.CumBytesUp != 0 || row.PrevBytesUp != 99 || row.ResetDay != 15 {
		t.Fatalf("after reset: %+v", row)
	}
}

func TestBuildInstallCommand(t *testing.T) {
	cases := []struct {
		name           string
		buildVersion   string
		publicURL      string
		token          string
		cn             bool
		wantContains   []string
		wantNotContain []string
	}{
		{
			name:         "release version → versioned raw URL + matching --version",
			buildVersion: "v0.5.0",
			publicURL:    "https://shepherd.example.com",
			token:        "T_abc",
			wantContains: []string{
				"raw.githubusercontent.com/hg-claw/Shepherd/v0.5.0/scripts/install-agent.sh",
				"--token T_abc",
				"--server https://shepherd.example.com",
				"--version v0.5.0",
				"sudo bash -s --",
				// Detachment shim: without it the install script gets
				// killed mid-binary-swap when systemd stops shepherd-agent.
				"systemd-run --quiet --collect --unit=shepherd-agent-update",
				"setsid", // fallback path for hosts without systemd-run
			},
			wantNotContain: []string{"main", "gh-proxy.com", "--cn"},
		},
		{
			name:         "dev build → main branch + --version main",
			buildVersion: "dev",
			publicURL:    "https://shepherd.example.com",
			token:        "T_xyz",
			wantContains: []string{
				"raw.githubusercontent.com/hg-claw/Shepherd/main/scripts/install-agent.sh",
				"--token T_xyz",
				"--version main",
			},
			// Negative checks have to be precise — naive substrings like "dev"
			// false-match against the `/dev/null` redirect in the detach shim.
			wantNotContain: []string{"v0.5.0", "--version dev", "gh-proxy.com", "--cn"},
		},
		{
			name:         "cn=true → script URL wrapped in gh-proxy + --cn flag",
			buildVersion: "v0.8.4",
			publicURL:    "https://shepherd.example.com",
			token:        "T_cn",
			cn:           true,
			wantContains: []string{
				// Mirror prefix applied to the script URL itself (host
				// needs to reach raw.githubusercontent.com too).
				"https://gh-proxy.com/https://raw.githubusercontent.com/hg-claw/Shepherd/v0.8.4/scripts/install-agent.sh",
				// --cn propagates so the script applies the same prefix
				// to subsequent asset downloads.
				"--cn",
			},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := buildInstallCommand(c.buildVersion, c.publicURL, c.token, c.cn)
			for _, sub := range c.wantContains {
				if !strings.Contains(got, sub) {
					t.Errorf("missing %q in: %s", sub, got)
				}
			}
			for _, sub := range c.wantNotContain {
				if strings.Contains(got, sub) {
					t.Errorf("unwanted %q in: %s", sub, got)
				}
			}
		})
	}
}

type countingExec struct {
	mu       sync.Mutex
	cur, max int
	done     *sync.WaitGroup
}

func (c *countingExec) RunCmd(ctx context.Context, serverID int64, name string, args ...string) ([]byte, []byte, int, error) {
	c.mu.Lock()
	c.cur++
	if c.cur > c.max {
		c.max = c.cur
	}
	c.mu.Unlock()
	time.Sleep(15 * time.Millisecond)
	c.mu.Lock()
	c.cur--
	c.mu.Unlock()
	c.done.Done()
	return nil, nil, 0, nil
}

func TestDispatchInstall_BoundsConcurrency(t *testing.T) {
	const n, capacity = 12, 3
	var wg sync.WaitGroup
	wg.Add(n)
	ex := &countingExec{done: &wg}
	a := &ServersAPI{HostExec: ex}
	a.InitInstallConcurrency(capacity)
	for i := 0; i < n; i++ {
		a.dispatchInstall(int64(i), "echo hi")
	}
	wg.Wait()
	if ex.max > capacity {
		t.Fatalf("max concurrent installs = %d, want <= %d", ex.max, capacity)
	}
	if ex.max == 0 {
		t.Fatal("no installs ran")
	}
}
