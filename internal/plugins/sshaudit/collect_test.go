package sshaudit

import (
	"context"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"
	_ "github.com/mattn/go-sqlite3"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

// fakeHostExec is a canned HostExec. journalOut is returned for the
// journalctl call; whoOut for `who`. It records every command for assertions.
type fakeHostExec struct {
	journalOut string
	journalErr error
	whoOut     string
	whoErr     error
	whoCode    int
	cmds       [][]string
}

func (f *fakeHostExec) PushFile(context.Context, int64, string, uint32, []byte) error { return nil }
func (f *fakeHostExec) FetchURL(context.Context, int64, agentapi.FileFetch) error     { return nil }
func (f *fakeHostExec) StreamCmd(context.Context, int64, string, []string, func(string)) error {
	return nil
}

func (f *fakeHostExec) RunCmd(_ context.Context, _ int64, name string, args ...string) ([]byte, []byte, int, error) {
	f.cmds = append(f.cmds, append([]string{name}, args...))
	switch name {
	case "journalctl":
		return []byte(f.journalOut), nil, 0, f.journalErr
	case "who":
		return []byte(f.whoOut), nil, f.whoCode, f.whoErr
	case "sh":
		return []byte(""), nil, 0, nil
	}
	return nil, nil, 0, nil
}

// openTestDB mirrors netquality's harness: in-memory sqlite with the servers
// + plugin_migrations bookkeeping plus this plugin's schema applied.
func openTestDB(t *testing.T) *sqlx.DB {
	t.Helper()
	db, err := sqlx.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`
		CREATE TABLE servers (id INTEGER PRIMARY KEY, name TEXT);
		CREATE TABLE plugin_migrations (
			plugin_id TEXT, name TEXT, applied_at TIMESTAMP,
			PRIMARY KEY(plugin_id, name)
		);
	`); err != nil {
		t.Fatal(err)
	}
	for _, m := range New().Migrations(shepdb.DriverSQLite) {
		if _, err := db.Exec(m.SQL); err != nil {
			t.Fatalf("apply migration %s: %v", m.Name, err)
		}
	}
	if _, err := db.Exec(`INSERT INTO servers (id, name) VALUES (1, 's1')`); err != nil {
		t.Fatal(err)
	}
	return db
}

// fixedNow returns a clock pinned at t.
func fixedNow(t time.Time) func() time.Time { return func() time.Time { return t } }

func TestCollectHost_InsertsAndIsIdempotent(t *testing.T) {
	db := openTestDB(t)
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	exec := &fakeHostExec{journalOut: `2026-06-16T10:33:01+0000 h sshd[1]: Accepted password for root from 1.2.3.4 port 55012 ssh2
2026-06-16T10:33:03+0000 h sshd[2]: Failed password for root from 1.2.3.4 port 55014 ssh2
2026-06-16T10:33:04+0000 h sshd[3]: Failed password for invalid user admin from 5.6.7.8 port 55015 ssh2`}
	p := New()
	deps := plugins.Deps{DB: db, HostExec: exec, Now: fixedNow(now)}

	n, err := p.collectHost(context.Background(), deps, 1)
	if err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Fatalf("first collect inserted %d, want 3", n)
	}

	// Re-collect with the same output → cursor + UNIQUE constraint mean 0 new.
	n2, err := p.collectHost(context.Background(), deps, 1)
	if err != nil {
		t.Fatal(err)
	}
	if n2 != 0 {
		t.Errorf("re-collect inserted %d, want 0 (idempotent)", n2)
	}

	var total int
	_ = db.Get(&total, `SELECT COUNT(*) FROM sshaudit_events WHERE server_id=1`)
	if total != 3 {
		t.Errorf("total events=%d want 3", total)
	}
}

func TestCollectHost_AdvancesCursorAndStampsState(t *testing.T) {
	db := openTestDB(t)
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	exec := &fakeHostExec{journalOut: `2026-06-16T10:33:01+0000 h sshd[1]: Accepted password for root from 1.2.3.4 port 55012 ssh2
2026-06-16T11:00:00+0000 h sshd[2]: Failed password for root from 1.2.3.4 port 55014 ssh2`}
	p := New()
	deps := plugins.Deps{DB: db, HostExec: exec, Now: fixedNow(now)}
	if _, err := p.collectHost(context.Background(), deps, 1); err != nil {
		t.Fatal(err)
	}
	var h hostConfig
	if err := db.Get(&h, `SELECT server_id, enabled, poll_interval_seconds, cursor_ts, last_collect_at, last_error, updated_at FROM sshaudit_hosts WHERE server_id=1`); err != nil {
		t.Fatal(err)
	}
	wantCursor := time.Date(2026, 6, 16, 11, 0, 0, 0, time.UTC)
	if h.CursorTS == nil || !h.CursorTS.UTC().Equal(wantCursor) {
		t.Errorf("cursor=%v want %v", h.CursorTS, wantCursor)
	}
	if h.LastCollectAt == nil || !h.LastCollectAt.UTC().Equal(now) {
		t.Errorf("last_collect_at=%v want %v", h.LastCollectAt, now)
	}
	if h.LastError != nil {
		t.Errorf("last_error=%v want nil", *h.LastError)
	}
}

func TestCollectHost_CursorDoesNotGoBackwards(t *testing.T) {
	db := openTestDB(t)
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	// Seed a cursor in the future relative to the events we'll offer.
	future := time.Date(2026, 6, 16, 11, 30, 0, 0, time.UTC)
	if _, err := db.Exec(`INSERT INTO sshaudit_hosts (server_id, enabled, poll_interval_seconds, cursor_ts, updated_at) VALUES (1, true, 300, ?, ?)`, future, now); err != nil {
		t.Fatal(err)
	}
	exec := &fakeHostExec{journalOut: `2026-06-16T10:33:01+0000 h sshd[1]: Accepted password for root from 1.2.3.4 port 55012 ssh2`}
	p := New()
	deps := plugins.Deps{DB: db, HostExec: exec, Now: fixedNow(now)}
	n, err := p.collectHost(context.Background(), deps, 1)
	if err != nil {
		t.Fatal(err)
	}
	// Event ts (10:33) is before the cursor (11:30) → filtered out, 0 inserted.
	if n != 0 {
		t.Errorf("inserted %d, want 0 (event predates cursor)", n)
	}
	var cursor time.Time
	_ = db.Get(&cursor, `SELECT cursor_ts FROM sshaudit_hosts WHERE server_id=1`)
	if !cursor.UTC().Equal(future) {
		t.Errorf("cursor moved backwards to %v, want %v", cursor, future)
	}
}

func TestCollectHost_RecordsErrorOnHostFailure(t *testing.T) {
	db := openTestDB(t)
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	exec := &fakeHostExec{journalErr: context.DeadlineExceeded}
	p := New()
	deps := plugins.Deps{DB: db, HostExec: exec, Now: fixedNow(now)}
	_, err := p.collectHost(context.Background(), deps, 1)
	if err == nil {
		t.Fatal("expected error from failing host exec")
	}
	var le *string
	_ = db.Get(&le, `SELECT last_error FROM sshaudit_hosts WHERE server_id=1`)
	if le == nil || *le == "" {
		t.Error("last_error not recorded on failure")
	}
}

func TestCollectHost_RetentionPrunesOldEvents(t *testing.T) {
	db := openTestDB(t)
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	// Insert an event 40 days old directly.
	old := now.Add(-40 * 24 * time.Hour)
	if _, err := db.Exec(`INSERT INTO sshaudit_events (server_id, ts, result, method, invalid_user, username, source_ip, port, created_at) VALUES (1, ?, 'failed', 'password', 0, 'root', '1.2.3.4', 22, ?)`, old, old); err != nil {
		t.Fatal(err)
	}
	exec := &fakeHostExec{journalOut: `2026-06-16T10:33:01+0000 h sshd[1]: Accepted password for root from 1.2.3.4 port 55012 ssh2`}
	p := New()
	deps := plugins.Deps{DB: db, HostExec: exec, Now: fixedNow(now)}
	if _, err := p.collectHost(context.Background(), deps, 1); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = db.Get(&n, `SELECT COUNT(*) FROM sshaudit_events WHERE server_id=1`)
	// The 40-day-old row pruned; only the freshly-collected one remains.
	if n != 1 {
		t.Errorf("after retention prune: %d events, want 1", n)
	}
}

func TestCollectHost_FallsBackToAuthLog(t *testing.T) {
	db := openTestDB(t)
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	// journalctl returns empty → fallback to sh/cat path. Override sh output.
	exec := &authLogExec{auth: `Jun 16 10:33:01 host sshd[1]: Accepted password for root from 1.2.3.4 port 55012 ssh2`}
	p := New()
	deps := plugins.Deps{DB: db, HostExec: exec, Now: fixedNow(now)}
	n, err := p.collectHost(context.Background(), deps, 1)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("fallback inserted %d, want 1", n)
	}
}

// authLogExec returns empty journalctl output (forcing the fallback) and
// canned auth.log content for the sh/cat path.
type authLogExec struct {
	auth string
}

func (a *authLogExec) PushFile(context.Context, int64, string, uint32, []byte) error { return nil }
func (a *authLogExec) FetchURL(context.Context, int64, agentapi.FileFetch) error     { return nil }
func (a *authLogExec) StreamCmd(context.Context, int64, string, []string, func(string)) error {
	return nil
}
func (a *authLogExec) RunCmd(_ context.Context, _ int64, name string, _ ...string) ([]byte, []byte, int, error) {
	if name == "journalctl" {
		return []byte(""), nil, 1, nil // non-zero + empty → fallback
	}
	if name == "sh" {
		return []byte(a.auth), nil, 0, nil
	}
	return nil, nil, 0, nil
}
