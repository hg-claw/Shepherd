package filehandler

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// realPath canonicalizes via EvalSymlinks. macOS resolves /tmp to /private/tmp;
// resolving here lets tests use t.TempDir() in Allowed without false rejects.
func realPath(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatalf("evalsymlinks %q: %v", p, err)
	}
	return r
}

func TestSandbox_Disabled(t *testing.T) {
	s := &Sandbox{Enabled: false}
	if err := s.Check("/etc/passwd", true); err != nil {
		t.Fatalf("disabled but rejected: %v", err)
	}
}

func TestSandbox_Allow(t *testing.T) {
	dir := realPath(t, t.TempDir())
	s := &Sandbox{Enabled: true, Allowed: []string{dir}}
	if err := s.Check(filepath.Join(dir, "x"), false); err != nil {
		t.Fatalf("%s/x rejected: %v", dir, err)
	}
}

func TestSandbox_Reject(t *testing.T) {
	dir := realPath(t, t.TempDir())
	s := &Sandbox{Enabled: true, Allowed: []string{dir}}
	if err := s.Check("/etc/shadow", false); !errors.Is(err, ErrPathNotAllowed) {
		t.Fatalf("err=%v want ErrPathNotAllowed", err)
	}
}

func TestSandbox_PrefixBoundary(t *testing.T) {
	// A whitelisted path X must not authorize a sibling X-evil path.
	// Using TempDir-based paths so the test runs on macOS too.
	parent := realPath(t, t.TempDir())
	allowed := filepath.Join(parent, "log")
	if err := os.MkdirAll(allowed, 0o755); err != nil {
		t.Fatal(err)
	}
	s := &Sandbox{Enabled: true, Allowed: []string{allowed}}
	if err := s.Check(filepath.Join(parent, "log-evil", "x"), false); !errors.Is(err, ErrPathNotAllowed) {
		t.Fatalf("log-evil should be rejected, got %v", err)
	}
}

func TestSandbox_SymlinkEscape(t *testing.T) {
	dir := realPath(t, t.TempDir())
	allowed := filepath.Join(dir, "ok")
	outside := filepath.Join(dir, "outside")
	if err := os.MkdirAll(allowed, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(allowed, "back")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	s := &Sandbox{Enabled: true, Allowed: []string{allowed}}
	if err := s.Check(filepath.Join(link, "evil"), false); !errors.Is(err, ErrPathNotAllowed) {
		t.Fatalf("symlink escape allowed: %v", err)
	}
}
