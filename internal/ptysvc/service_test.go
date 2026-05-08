package ptysvc

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/agentsvc"
	"github.com/hg-claw/Shepherd/internal/audit"
	"github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/sessionmux"
)

type fakeHub struct {
	mu      sync.Mutex
	envs    []agentapi.Envelope
	offline bool
}

func (h *fakeHub) Send(_ int64, e agentapi.Envelope) error {
	if h.offline {
		return agentsvc.ErrAgentOffline
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.envs = append(h.envs, e)
	return nil
}
func (h *fakeHub) SendBinary(_ int64, _ string, _ byte, _ []byte) error { return nil }

func TestService_OpenClose(t *testing.T) {
	d, _ := db.Open(context.Background(), db.Config{Driver: "sqlite", DSN: ":memory:"})
	t.Cleanup(func() { _ = d.Close() })
	_ = db.Migrate(d, "sqlite")
	_, _ = d.Exec(`INSERT INTO admins(id,username,password_hash) VALUES (1,'a','x')`)
	_, _ = d.Exec(`INSERT INTO servers(id,name) VALUES (10,'s1')`)

	hub := &fakeHub{}
	reg := sessionmux.New()
	svc := &Service{DB: d, Hub: hub, Reg: reg, Audit: &audit.Writer{DB: d, Now: time.Now}, Now: time.Now, RecordingsDir: t.TempDir()}
	sess, err := svc.Open(context.Background(), OpenOpts{
		AdminID: 1, ServerID: 10, Kind: "console", Rows: 24, Cols: 80, Term: "xterm",
	})
	if err != nil {
		t.Fatal(err)
	}

	hub.mu.Lock()
	if len(hub.envs) != 1 || hub.envs[0].Type != agentapi.TypePTYOpen {
		t.Fatalf("hub envs=%v", hub.envs)
	}
	hub.mu.Unlock()

	svc.OnExit(sess.SID, 0)
	var ended *time.Time
	if err := d.Get(&ended, `SELECT ended_at FROM pty_sessions WHERE id=?`, sess.PTYRowID); err != nil {
		t.Fatal(err)
	}
	if ended == nil {
		t.Fatal("ended_at not set")
	}
}

func TestService_OpenAgentOffline(t *testing.T) {
	d, _ := db.Open(context.Background(), db.Config{Driver: "sqlite", DSN: ":memory:"})
	t.Cleanup(func() { _ = d.Close() })
	_ = db.Migrate(d, "sqlite")
	_, _ = d.Exec(`INSERT INTO admins(id,username,password_hash) VALUES (1,'a','x')`)
	_, _ = d.Exec(`INSERT INTO servers(id,name) VALUES (10,'s1')`)
	hub := &fakeHub{offline: true}
	svc := &Service{DB: d, Hub: hub, Reg: sessionmux.New(), Audit: &audit.Writer{DB: d, Now: time.Now}, Now: time.Now, RecordingsDir: t.TempDir()}
	_, err := svc.Open(context.Background(), OpenOpts{AdminID: 1, ServerID: 10, Kind: "console", Rows: 24, Cols: 80})
	if !errors.Is(err, agentsvc.ErrAgentOffline) {
		t.Fatalf("err=%v", err)
	}
}
