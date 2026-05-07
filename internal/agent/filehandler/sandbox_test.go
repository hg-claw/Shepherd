//go:build linux

package filehandler

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestSandbox_Disabled(t *testing.T) {
	s := &Sandbox{Enabled: false}
	if err := s.Check("/etc/passwd", true); err != nil {
		t.Fatalf("disabled but rejected: %v", err)
	}
}

func TestSandbox_Allow(t *testing.T) {
	s := &Sandbox{Enabled: true, Allowed: []string{"/tmp", "/var/log"}}
	if err := s.Check("/tmp/x", false); err != nil {
		t.Fatalf("/tmp/x rejected: %v", err)
	}
	if err := s.Check("/var/log/syslog", false); err != nil {
		t.Fatalf("/var/log/syslog rejected: %v", err)
	}
}

func TestSandbox_Reject(t *testing.T) {
	s := &Sandbox{Enabled: true, Allowed: []string{"/tmp"}}
	if err := s.Check("/etc/shadow", false); !errors.Is(err, ErrPathNotAllowed) {
		t.Fatalf("err=%v want ErrPathNotAllowed", err)
	}
}

func TestSandbox_PrefixBoundary(t *testing.T) {
	s := &Sandbox{Enabled: true, Allowed: []string{"/var/log"}}
	if err := s.Check("/var/log-evil/x", false); !errors.Is(err, ErrPathNotAllowed) {
		t.Fatalf("/var/log-evil should be rejected, got %v", err)
	}
}

func TestSandbox_SymlinkEscape(t *testing.T) {
	dir := t.TempDir()
	allowed := filepath.Join(dir, "ok")
	outside := filepath.Join(dir, "outside")
	if err := os.MkdirAll(allowed, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0755); err != nil {
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
