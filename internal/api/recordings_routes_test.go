package api

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/ptysvc"
)

// The execution-log endpoint flattens the asciicast recording to plain
// text. This drives a real .cast through the handler and asserts the
// terminal output comes back without the timing metadata.
func TestRecordings_Log_ReturnsPlainOutput(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "r.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}

	castPath := filepath.Join(t.TempDir(), "1.cast")
	w, err := ptysvc.NewCastWriter(castPath, 80, 24, time.Unix(0, 0), "shepherd-pty", "kind=script")
	if err != nil {
		t.Fatal(err)
	}
	w.WriteOutput(time.Millisecond, []byte("deploy ok\n"))
	_ = w.Close()

	d.MustExec(`INSERT INTO admins(id, username, password_hash) VALUES (1, 'a', 'h')`)
	d.MustExec(`INSERT INTO servers(id, name) VALUES (1, 's1')`)
	var sid int64
	if err := d.QueryRowx(`INSERT INTO pty_sessions
		(server_id, admin_id, kind, exec_user, rows, cols, exec, started_at, recording_path)
		VALUES (1, 1, 'script', 'root', 24, 80, 'x', $1, $2) RETURNING id`,
		time.Now().UTC(), castPath).Scan(&sid); err != nil {
		t.Fatal(err)
	}

	a := &RecordingsAPI{DB: d}
	r := httptest.NewRequest("GET", "/api/admin/recordings/"+strconv.FormatInt(sid, 10)+"/log", nil)
	r.SetPathValue("id", strconv.FormatInt(sid, 10))
	wr := httptest.NewRecorder()
	a.Log(wr, r)

	if wr.Code != 200 {
		t.Fatalf("status=%d body=%s", wr.Code, wr.Body.String())
	}
	if wr.Body.String() != "deploy ok\n" {
		t.Errorf("log body = %q, want %q", wr.Body.String(), "deploy ok\n")
	}
}

func TestRecordings_Log_NoRecording_404(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "r.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	d.MustExec(`INSERT INTO admins(id, username, password_hash) VALUES (1, 'a', 'h')`)
	d.MustExec(`INSERT INTO servers(id, name) VALUES (1, 's1')`)
	var sid int64
	_ = d.QueryRowx(`INSERT INTO pty_sessions
		(server_id, admin_id, kind, exec_user, rows, cols, exec, started_at)
		VALUES (1, 1, 'script', 'root', 24, 80, 'x', $1) RETURNING id`,
		time.Now().UTC()).Scan(&sid)

	a := &RecordingsAPI{DB: d}
	r := httptest.NewRequest("GET", "/api/admin/recordings/"+strconv.FormatInt(sid, 10)+"/log", nil)
	r.SetPathValue("id", strconv.FormatInt(sid, 10))
	wr := httptest.NewRecorder()
	a.Log(wr, r)
	if wr.Code != 404 {
		t.Fatalf("status=%d, want 404 (no recording_path)", wr.Code)
	}
}
