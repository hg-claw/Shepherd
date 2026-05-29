package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/agentsvc"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/serversvc"
	"github.com/hg-claw/Shepherd/internal/telemetrysvc"
	"github.com/jmoiron/sqlx"
)

// newPublicAPIForTest creates a fresh in-memory SQLite DB, runs migrations,
// and returns a PublicAPI (with Servers + Tokens wired) plus the raw *sqlx.DB
// for direct SQL seeding.
func newPublicAPIForTest(t *testing.T) (*PublicAPI, *sqlx.DB) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	svc := &serversvc.Service{DB: d}
	settings := &serversvc.SettingsStore{DB: d}
	q := &telemetrysvc.Query{DB: d}
	hub := agentsvc.NewHub()
	agentSvc := &agentsvc.Service{DB: d}
	a := &PublicAPI{
		Servers:  svc,
		Settings: settings,
		Query:    q,
		Hub:      hub,
		Tokens:   agentSvc,
	}
	a.InitRateLimit(30, time.Minute)
	return a, d
}

func TestPublicAPI_AgentStatus_Online(t *testing.T) {
	a, db := newPublicAPIForTest(t)
	// Seed a server row + enrollment token + recent last_seen.
	res, _ := db.Exec(`INSERT INTO servers (name, agent_last_seen) VALUES (?, ?)`,
		"s1", time.Now().Add(-5*time.Second))
	serverID, _ := res.LastInsertId()
	tok := "tok_online"
	if _, err := db.Exec(
		`INSERT INTO enrollment_tokens (token, server_id, expires_at) VALUES (?, ?, ?)`,
		tok, serverID, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	req := httptest.NewRequest("GET", "/api/agent/status?token="+tok, nil)
	rr := httptest.NewRecorder()
	a.AgentStatus(rr, req)
	if rr.Code != 200 {
		t.Fatalf("status %d", rr.Code)
	}
	var got struct {
		Online     bool    `json:"online"`
		LastSeenAt *string `json:"last_seen_at"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	if !got.Online {
		t.Errorf("expected online=true; body=%s", rr.Body)
	}
}

func TestPublicAPI_AgentStatus_Offline(t *testing.T) {
	a, db := newPublicAPIForTest(t)
	res, _ := db.Exec(`INSERT INTO servers (name, agent_last_seen) VALUES (?, ?)`,
		"s2", time.Now().Add(-10*time.Minute))
	serverID, _ := res.LastInsertId()
	tok := "tok_offline"
	_, _ = db.Exec(
		`INSERT INTO enrollment_tokens (token, server_id, expires_at) VALUES (?, ?, ?)`,
		tok, serverID, time.Now().Add(time.Hour))
	req := httptest.NewRequest("GET", "/api/agent/status?token="+tok, nil)
	rr := httptest.NewRecorder()
	a.AgentStatus(rr, req)
	if rr.Code != 200 {
		t.Fatalf("status %d", rr.Code)
	}
	var got struct {
		Online bool `json:"online"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	if got.Online {
		t.Errorf("expected online=false")
	}
}

func TestPublicAPI_AgentStatus_UnknownToken(t *testing.T) {
	a, _ := newPublicAPIForTest(t)
	req := httptest.NewRequest("GET", "/api/agent/status?token=nope", nil)
	rr := httptest.NewRecorder()
	a.AgentStatus(rr, req)
	if rr.Code != 404 {
		t.Fatalf("want 404, got %d", rr.Code)
	}
}

func TestPublicAPI_AgentStatus_RateLimit(t *testing.T) {
	a, db := newPublicAPIForTest(t)
	res, _ := db.Exec(`INSERT INTO servers (name) VALUES (?)`, "s3")
	serverID, _ := res.LastInsertId()
	tok := "tok_rl"
	_, _ = db.Exec(
		`INSERT INTO enrollment_tokens (token, server_id, expires_at) VALUES (?, ?, ?)`,
		tok, serverID, time.Now().Add(time.Hour))
	for i := 0; i < 30; i++ {
		req := httptest.NewRequest("GET", "/api/agent/status?token="+tok, nil)
		rr := httptest.NewRecorder()
		a.AgentStatus(rr, req)
		if rr.Code != 200 {
			t.Fatalf("hit %d: status %d", i, rr.Code)
		}
	}
	// 31st should be 429.
	req := httptest.NewRequest("GET", "/api/agent/status?token="+tok, nil)
	rr := httptest.NewRecorder()
	a.AgentStatus(rr, req)
	if rr.Code != 429 {
		t.Fatalf("want 429, got %d", rr.Code)
	}
}

func TestHealthz(t *testing.T) {
	a, _ := newPublicAPIForTest(t)
	req := httptest.NewRequest("GET", "/healthz", nil)
	rr := httptest.NewRecorder()
	a.Healthz(rr, req)
	if rr.Code != 200 {
		t.Fatalf("want 200, got %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), `"ok":true`) {
		t.Errorf("body = %s", rr.Body)
	}
}

func TestPublicServers_PlatformArchTraffic(t *testing.T) {
	a, db := newPublicAPIForTest(t)
	ctx := context.Background()
	// seed a show_on_public server
	srv, err := a.Servers.Create(ctx, serversvc.CreateInput{Name: "plat-test", ShowOnPublic: true})
	if err != nil {
		t.Fatalf("seed server: %v", err)
	}
	sid := srv.ID

	// ensure agent_os/agent_arch are set on the server row
	_, _ = db.ExecContext(ctx, `UPDATE servers SET agent_os='linux', agent_arch='amd64' WHERE id=$1`, sid)
	// seed cumulative traffic (sub-project B's table)
	_, _ = db.ExecContext(ctx,
		`INSERT INTO host_traffic (server_id, cum_bytes_up, cum_bytes_down, updated_at) VALUES ($1,$2,$3,$4)`,
		sid, int64(500), int64(900), time.Now().UTC())

	rec := httptest.NewRecorder()
	a.Servers_ListPublic(rec, httptest.NewRequest("GET", "/api/public/servers", nil))
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{`"platform":"linux"`, `"arch":"amd64"`, `"traffic_rx_bytes":900`, `"traffic_tx_bytes":500`} {
		if !strings.Contains(body, want) {
			t.Errorf("body missing %q: %s", want, body)
		}
	}
}

func TestPublic_HidesPrivateAndExposesAlias(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)

	svc := &serversvc.Service{DB: d}
	settings := &serversvc.SettingsStore{DB: d}
	q := &telemetrysvc.Query{DB: d}
	hub := agentsvc.NewHub()
	api := &PublicAPI{Servers: svc, Settings: settings, Query: q, Hub: hub}

	a, _ := svc.Create(context.Background(), serversvc.CreateInput{Name: "internal-name-A", PublicAlias: "HK-1", ShowOnPublic: true, CountryCode: "HK"})
	_, _ = svc.Create(context.Background(), serversvc.CreateInput{Name: "internal-name-B", ShowOnPublic: false})

	ing := &telemetrysvc.Ingest{DB: d}
	_ = ing.WriteSample(context.Background(), a.ID, agentapi.Telemetry{TS: time.Now().UTC(), CPUPct: 5, MemUsed: 1, MemTotal: 2})
	_, _ = d.Exec("UPDATE servers SET agent_last_seen=$1 WHERE id=$2", time.Now().UTC(), a.ID)

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/public/servers", nil)
	api.Servers_ListPublic(w, r)
	if w.Code != 200 {
		t.Fatalf("status=%d", w.Code)
	}
	var cards []publicCard
	_ = json.Unmarshal(w.Body.Bytes(), &cards)
	if len(cards) != 1 || cards[0].Alias != "HK-1" || cards[0].CountryCode != "HK" {
		t.Fatalf("cards=%+v", cards)
	}
	if !cards[0].Online {
		t.Error("should be online")
	}
	body := w.Body.String()
	for _, leak := range []string{"internal-name-A", "ssh_user", "agent_fingerprint"} {
		if strings.Contains(body, leak) {
			t.Errorf("public leaked %q", leak)
		}
	}
}
