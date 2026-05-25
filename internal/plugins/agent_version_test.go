package plugins

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jmoiron/sqlx"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func newVersionTestDB(t *testing.T) *sqlx.DB {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "v.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestCompareSemver(t *testing.T) {
	cases := []struct {
		a, b string
		want int
		ok   bool
	}{
		{"0.8.9", "0.9.0", -1, true},
		{"0.9.0", "0.9.0", 0, true},
		{"0.9.1", "0.9.0", 1, true},
		{"v0.9.0", "0.9.0", 0, true}, // leading v tolerated
		{"1.0.0-rc1", "1.0.0", 0, true}, // suffix ignored
		{"0.10.0", "0.9.9", 1, true}, // numeric (not lex) ordering
		{"dev", "0.9.0", 0, false},
		{"1.2", "1.2.3", 0, false},
	}
	for _, c := range cases {
		got, ok := compareSemver(c.a, c.b)
		if ok != c.ok {
			t.Errorf("compareSemver(%q, %q) ok = %v want %v", c.a, c.b, ok, c.ok)
		}
		if ok && got != c.want {
			t.Errorf("compareSemver(%q, %q) = %d want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestRequireAgentVersionAtLeast(t *testing.T) {
	d := newVersionTestDB(t)
	t.Cleanup(func() { _ = d.Close() })
	d.MustExec(`INSERT INTO servers(id, name, agent_version) VALUES (1, 'old', '0.8.5')`)
	d.MustExec(`INSERT INTO servers(id, name, agent_version) VALUES (2, 'new', '0.9.0')`)
	d.MustExec(`INSERT INTO servers(id, name, agent_version) VALUES (3, 'dev', 'dev')`)
	d.MustExec(`INSERT INTO servers(id, name) VALUES (4, 'no-version-yet')`)

	if err := RequireAgentVersionAtLeast(context.Background(), d, 1, "0.9.0"); err == nil {
		t.Error("expected error for v0.8.5 vs min 0.9.0")
	} else if !strings.Contains(err.Error(), "upgrade") {
		t.Errorf("error should mention upgrade, got: %v", err)
	}

	if err := RequireAgentVersionAtLeast(context.Background(), d, 2, "0.9.0"); err != nil {
		t.Errorf("v0.9.0 should pass min 0.9.0: %v", err)
	}
	if err := RequireAgentVersionAtLeast(context.Background(), d, 3, "0.9.0"); err != nil {
		t.Errorf("dev build should be allowed: %v", err)
	}
	if err := RequireAgentVersionAtLeast(context.Background(), d, 4, "0.9.0"); err != nil {
		t.Errorf("empty agent_version should pass (not enrolled yet): %v", err)
	}
}
