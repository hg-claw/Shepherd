package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/agentsvc"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func newAgentAPI(t *testing.T) (*AgentAPI, *agentsvc.Service) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	svc := &agentsvc.Service{DB: d, AutoRecoverKey: "k"}
	return &AgentAPI{Agents: svc, Hub: agentsvc.NewHub()}, svc
}

func TestEnroll_HTTP(t *testing.T) {
	a, svc := newAgentAPI(t)
	res, _ := svc.DB.Exec("INSERT INTO servers(name) VALUES ('h')")
	sid, _ := res.LastInsertId()
	tok, _, _ := svc.IssueEnrollmentToken(context.Background(), sid)

	body, _ := json.Marshal(agentapi.EnrollRequest{
		EnrollmentToken: tok, Fingerprint: "fp", OS: "linux", Arch: "amd64", Kernel: "6.1", AgentVersion: "v0.1.0",
	})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/agent/enroll", bytes.NewReader(body))
	a.Enroll(w, r)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestWS_RoundTrip(t *testing.T) {
	a, svc := newAgentAPI(t)
	res, _ := svc.DB.Exec("INSERT INTO servers(name) VALUES ('h')")
	_ = res
	machine, sid, _ := svc.AutoRegister(context.Background(), "k", "fp", "h", "linux", "amd64", "6.1", "v0")

	got := make(chan agentapi.Envelope, 1)
	a.OnFrame = func(_ context.Context, _ int64, env agentapi.Envelope) {
		got <- env
	}

	srv := httptest.NewServer(http.HandlerFunc(a.WS))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	hdr := http.Header{}
	hdr.Set("Authorization", "Bearer "+machine)
	c, _, err := websocket.DefaultDialer.Dial(wsURL, hdr)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()

	// agent → server: heartbeat
	env, _ := agentapi.Frame(agentapi.TypeHeartbeat, agentapi.Heartbeat{TS: time.Now().UTC(), AgentVersion: "v0"})
	if err := c.WriteJSON(env); err != nil {
		t.Fatal(err)
	}
	select {
	case e := <-got:
		if e.Type != agentapi.TypeHeartbeat {
			t.Fatalf("got %s", e.Type)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for frame")
	}

	// server → agent: config.update via Hub
	var pushed atomic.Int32
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, data, err := c.ReadMessage()
		if err == nil {
			var env agentapi.Envelope
			_ = json.Unmarshal(data, &env)
			if env.Type == agentapi.TypeConfigUpdate {
				pushed.Add(1)
			}
		}
	}()

	// Wait briefly for the WS goroutine on the server side to register the conn in the Hub.
	// httptest.NewServer + websocket.DefaultDialer.Dial races against Hub.Register; give 50ms.
	time.Sleep(50 * time.Millisecond)

	cfg, _ := agentapi.Frame(agentapi.TypeConfigUpdate, agentapi.ConfigUpdate{TelemetryIntervalSeconds: 10})
	if err := a.Hub.Send(sid, cfg); err != nil {
		t.Fatalf("hub push: %v", err)
	}

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for pushed frame on client")
	}
	if pushed.Load() != 1 {
		t.Fatal("agent did not receive pushed config.update")
	}
}
