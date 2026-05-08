package audit

import (
	"context"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/db"
)

func TestWriter_Insert(t *testing.T) {
	d, _ := db.Open(context.Background(), db.Config{Driver: "sqlite", DSN: ":memory:"})
	t.Cleanup(func() { _ = d.Close() })
	_ = db.Migrate(d, "sqlite")
	w := &Writer{DB: d, Now: time.Now}
	w.Write(context.Background(), nil, nil, "pty.open", map[string]any{"kind": "console"}, nil)
	var n int
	if err := d.Get(&n, `SELECT COUNT(*) FROM audit_log`); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("rows=%d", n)
	}
}

func TestRetention_DeletesOld(t *testing.T) {
	d, _ := db.Open(context.Background(), db.Config{Driver: "sqlite", DSN: ":memory:"})
	t.Cleanup(func() { _ = d.Close() })
	_ = db.Migrate(d, "sqlite")
	_, _ = d.Exec(`INSERT INTO audit_log(ts,action) VALUES (?, 'old')`, time.Now().Add(-40*24*time.Hour))
	_, _ = d.Exec(`INSERT INTO audit_log(ts,action) VALUES (?, 'fresh')`, time.Now())
	r := &Retention{DB: d, Days: 30, Now: time.Now}
	if err := r.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = d.Get(&n, `SELECT COUNT(*) FROM audit_log WHERE action='old'`)
	if n != 0 {
		t.Fatalf("old not deleted: %d", n)
	}
}
