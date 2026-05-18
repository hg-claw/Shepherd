package deploy

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type recExec struct {
	pushedPaths []string
	cmds        [][]string
	failCmd     string
}

func (r *recExec) PushFile(_ context.Context, _ int64, path string, _ uint32, _ []byte) error {
	r.pushedPaths = append(r.pushedPaths, path)
	return nil
}
func (r *recExec) RunCmd(_ context.Context, _ int64, name string, args ...string) ([]byte, []byte, int, error) {
	r.cmds = append(r.cmds, append([]string{name}, args...))
	if r.failCmd != "" && name == r.failCmd {
		return nil, []byte("boom"), 1, errors.New("exec failed")
	}
	// launchctl print returns "state = running" so IsActive is happy
	if name == "launchctl" && len(args) > 0 && args[0] == "print" {
		return []byte("state = running"), nil, 0, nil
	}
	return []byte("active"), nil, 0, nil
}
func (recExec) StreamCmd(context.Context, int64, string, []string, func(string)) error { return nil }

// ---- Linux (systemd) tests ----

func TestPushAndStart_Linux(t *testing.T) {
	exec := &recExec{}
	p := &Pusher{Exec: exec}
	err := p.DeployService(context.Background(), DeployParams{
		OS:          "linux",
		ServerID:    7,
		BinaryPath:  "/usr/local/bin/foo",
		BinaryBytes: []byte("BIN"),
		ConfigPath:  "/etc/foo/cfg",
		ConfigBytes: []byte("cfg"),
		UnitPath:    "/etc/systemd/system/foo.service",
		UnitBytes:   []byte("[Unit]\n..."),
		UnitName:    "foo",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(exec.pushedPaths) != 3 {
		t.Fatalf("expected 3 file pushes, got %v", exec.pushedPaths)
	}
	wantCmds := [][]string{
		{"systemctl", "daemon-reload"},
		{"systemctl", "enable", "--now", "foo"},
	}
	for i, want := range wantCmds {
		if len(exec.cmds) <= i || !equalSlice(exec.cmds[i], want) {
			t.Fatalf("cmd[%d] = %v want %v", i, exec.cmds[i], want)
		}
	}
}

func TestIsActiveTrue_Linux(t *testing.T) {
	exec := &recExec{}
	p := &Pusher{Exec: exec}
	active, err := p.IsActive(context.Background(), "linux", 1, "foo")
	if err != nil || !active {
		t.Fatalf("active=%v err=%v", active, err)
	}
}

// ---- macOS (launchd) tests ----

func TestPushAndStart_Darwin(t *testing.T) {
	exec := &recExec{}
	p := &Pusher{Exec: exec}
	err := p.DeployService(context.Background(), DeployParams{
		OS:          "darwin",
		ServerID:    7,
		BinaryPath:  "/usr/local/bin/shepherd-xray",
		BinaryBytes: []byte("BIN"),
		ConfigPath:  "/etc/shepherd-xray/config.json",
		ConfigBytes: []byte("{}"),
		UnitPath:    "/Library/LaunchDaemons/com.shepherd.xray.plist",
		UnitBytes:   []byte("<plist/>"),
		UnitName:    "com.shepherd.xray",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(exec.pushedPaths) != 3 {
		t.Fatalf("expected 3 file pushes, got %v", exec.pushedPaths)
	}
	// Should have called launchctl bootstrap, NOT systemctl
	found := false
	for _, cmd := range exec.cmds {
		if len(cmd) >= 3 && cmd[0] == "launchctl" && cmd[1] == "bootstrap" {
			found = true
		}
		if cmd[0] == "systemctl" {
			t.Fatalf("unexpected systemctl call on darwin: %v", cmd)
		}
	}
	if !found {
		t.Fatalf("expected launchctl bootstrap, got cmds: %v", exec.cmds)
	}
	// bootstrap target must be "system"
	for _, cmd := range exec.cmds {
		if len(cmd) >= 3 && cmd[0] == "launchctl" && cmd[1] == "bootstrap" {
			if cmd[2] != "system" {
				t.Fatalf("launchctl bootstrap target = %q, want system", cmd[2])
			}
		}
	}
}

func TestIsActive_Darwin(t *testing.T) {
	exec := &recExec{}
	p := &Pusher{Exec: exec}
	active, err := p.IsActive(context.Background(), "darwin", 1, "com.shepherd.xray")
	if err != nil || !active {
		t.Fatalf("active=%v err=%v", active, err)
	}
	// Verify it called launchctl print system/<label>
	found := false
	for _, cmd := range exec.cmds {
		if len(cmd) >= 3 && cmd[0] == "launchctl" && cmd[1] == "print" &&
			strings.HasPrefix(cmd[2], "system/") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected launchctl print system/<label>, got %v", exec.cmds)
	}
}

func TestStop_Darwin(t *testing.T) {
	exec := &recExec{}
	p := &Pusher{Exec: exec}
	if err := p.Stop(context.Background(), "darwin", 1, "com.shepherd.xray"); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, cmd := range exec.cmds {
		if len(cmd) >= 3 && cmd[0] == "launchctl" && cmd[1] == "bootout" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected launchctl bootout, got %v", exec.cmds)
	}
}

func equalSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
