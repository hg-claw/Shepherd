package serversvc

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func newSettings(t *testing.T) *SettingsStore {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "settings.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	return &SettingsStore{DB: d}
}

// Old SQLite migrations stored '/tmp\n/var/log\n...' as a literal 7-byte
// sequence per separator (sqlite single-quoted strings don't process \n).
// GetLines must tolerate that and still split correctly.
func TestGetLines_ToleratesLiteralBackslashN(t *testing.T) {
	s := newSettings(t)
	ctx := context.Background()
	if err := s.Set(ctx, "test_paths", `/tmp\n/var/log\n/srv`); err != nil {
		t.Fatal(err)
	}
	got := s.GetLines(ctx, "test_paths")
	want := []string{"/tmp", "/var/log", "/srv"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// New rows (post fix) use real newlines; both flavors must work.
func TestGetLines_RealNewlines(t *testing.T) {
	s := newSettings(t)
	ctx := context.Background()
	if err := s.Set(ctx, "test_paths", "/tmp\n/var/log\n/srv"); err != nil {
		t.Fatal(err)
	}
	got := s.GetLines(ctx, "test_paths")
	want := []string{"/tmp", "/var/log", "/srv"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// The default sandbox paths set by the 0002 migration must come back as 6
// distinct entries — this would silently regress to 1 element if the
// literal-\n tolerance broke.
func TestGetLines_DefaultSandboxPaths(t *testing.T) {
	s := newSettings(t)
	got := s.GetLines(context.Background(), "file_sandbox_paths")
	// 7 baseline paths + 4 plugin-related paths added in 0002/0005.
	want := []string{
		"/tmp", "/var/log", "/etc/shepherd", "/home", "/Users", "/opt", "/srv",
		// Plugin-related (xray, systemd, launchd, binary install dir).
		"/etc/shepherd-xray", "/etc/systemd/system", "/Library/LaunchDaemons", "/usr/local/bin",
	}
	if len(got) != len(want) {
		t.Fatalf("expected %d default paths, got %d: %v", len(want), len(got), got)
	}
	for _, p := range want {
		found := false
		for _, g := range got {
			if g == p {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("missing default path %q in %v", p, got)
		}
	}
}
