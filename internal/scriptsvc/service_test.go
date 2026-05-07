package scriptsvc

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/audit"
	"github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/ptysvc"
	"github.com/hg-claw/Shepherd/internal/sessionmux"
)

func TestService_Convergence(t *testing.T) {
	d, _ := db.Open(context.Background(), db.Config{Driver: "sqlite", DSN: ":memory:"})
	t.Cleanup(func() { _ = d.Close() })
	_ = db.Migrate(d, "sqlite")
	_, _ = d.Exec(`INSERT INTO admins(id,username,password_hash) VALUES (1,'a','x')`)
	_, _ = d.Exec(`INSERT INTO servers(id,name) VALUES (10,'s1')`)
	store := &Store{DB: d, Now: time.Now}
	pj, _ := json.Marshal([]Param{})
	id, _ := store.Create(context.Background(), &Script{Name: "x", Content: "echo hi", ParamsJSON: string(pj)})
	_, _ = d.Exec(`INSERT INTO script_runs(id, script_id, admin_id, args_json, started_at) VALUES (1, ?, 1, '{}', ?)`, id, time.Now())
	_, _ = d.Exec(`INSERT INTO pty_sessions(id, server_id, admin_id, kind, started_at) VALUES (5, 10, 1, 'script', ?)`, time.Now())
	_, _ = d.Exec(`INSERT INTO script_run_targets(id, run_id, server_id, pty_session_id, status) VALUES (1, 1, 10, 5, 'running')`)
	svc := &Service{
		DB: d, Store: store, Audit: &audit.Writer{DB: d, Now: time.Now}, Now: time.Now,
		PTY: &ptysvc.Service{}, Reg: sessionmux.New(),
	}
	svc.OnPTYExit(5, 0, "exit")
	var fin *time.Time
	_ = d.Get(&fin, `SELECT finished_at FROM script_runs WHERE id=1`)
	if fin == nil {
		t.Fatal("script_runs.finished_at not set")
	}
	var status string
	_ = d.Get(&status, `SELECT status FROM script_run_targets WHERE id=1`)
	if status != "succeeded" {
		t.Fatalf("status=%q", status)
	}
}
