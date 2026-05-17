package deploy

import (
	"context"
	"errors"
	"testing"
)

type recExec struct{
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
	return []byte("active"), nil, 0, nil
}
func (recExec) StreamCmd(context.Context, int64, string, []string, func(string)) error { return nil }

func TestPushAndStart(t *testing.T) {
	exec := &recExec{}
	p := &Pusher{Exec: exec}
	err := p.DeploySystemdService(context.Background(), DeployParams{
		ServerID:    7,
		BinaryPath:  "/usr/local/bin/foo",
		BinaryBytes: []byte("BIN"),
		ConfigPath:  "/etc/foo/cfg",
		ConfigBytes: []byte("cfg"),
		UnitPath:    "/etc/systemd/system/foo.service",
		UnitBytes:   []byte("[Unit]\n..."),
		UnitName:    "foo",
	})
	if err != nil { t.Fatal(err) }
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

func TestIsActiveTrue(t *testing.T) {
	exec := &recExec{}
	p := &Pusher{Exec: exec}
	active, err := p.IsActive(context.Background(), 1, "foo")
	if err != nil || !active { t.Fatalf("active=%v err=%v", active, err) }
}

func equalSlice(a, b []string) bool {
	if len(a) != len(b) { return false }
	for i := range a { if a[i] != b[i] { return false } }
	return true
}
