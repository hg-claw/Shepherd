package xray

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type captureExec struct {
	pushed []push
	cmds   [][]string
}
type push struct{ path string; mode uint32; body []byte }

func (c *captureExec) PushFile(_ context.Context, _ int64, path string, mode uint32, body []byte) error {
	c.pushed = append(c.pushed, push{path, mode, body})
	return nil
}
func (c *captureExec) RunCmd(_ context.Context, _ int64, name string, args ...string) ([]byte, []byte, int, error) {
	c.cmds = append(c.cmds, append([]string{name}, args...))
	if name == "systemctl" && len(args) > 0 && args[0] == "is-active" {
		return []byte("active"), nil, 0, nil
	}
	return nil, nil, 0, nil
}
func (c *captureExec) StreamCmd(context.Context, int64, string, []string, func(string)) error { return nil }

// fakeReleaser provides a binary "Binary" without actually downloading.
type fakeReleaser struct{ path string }

func (f *fakeReleaser) Fetch(_ context.Context, version, osStr, arch string) (Binary, error) {
	return Binary{Version: version, OS: osStr, Arch: arch, Path: f.path, SizeBytes: 3, Sha256: "deadbeef"}, nil
}

func newXrayTestDB(t *testing.T) *plugins.Deps {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "xray.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	_, _ = d.Exec(`INSERT INTO servers(name, agent_os, agent_arch) VALUES('s1', 'linux', 'amd64')`)
	return &plugins.Deps{DB: d}
}

func TestDeployToHost_PushesBinaryConfigAndUnit(t *testing.T) {
	// pre-create the fake binary file
	tmp := t.TempDir() + "/xray-fake"
	if err := os.WriteFile(tmp, []byte("BIN"), 0755); err != nil { t.Fatal(err) }

	exec := &captureExec{}
	p := New()
	p.releaser = &fakeReleaser{path: tmp}
	baseDeps := newXrayTestDB(t)
	baseDeps.HostExec = exec
	deps := *baseDeps

	cfg := []byte(`{"inbounds":[],"outbounds":[]}`)
	if err := p.DeployToHost(context.Background(), deps, 1, "1.8.11", cfg); err != nil {
		t.Fatal(err)
	}
	wantPaths := []string{
		"/usr/local/bin/shepherd-xray",
		"/etc/shepherd-xray/config.json",
		"/etc/systemd/system/shepherd-xray.service",
	}
	for i, want := range wantPaths {
		if i >= len(exec.pushed) || exec.pushed[i].path != want {
			t.Fatalf("push[%d] = %v, want %s", i, exec.pushed[i], want)
		}
	}
	if !strings.Contains(string(exec.pushed[2].body), "shepherd-xray") {
		t.Fatalf("unit body missing service name: %s", exec.pushed[2].body)
	}
}

func TestHostStatus_Active(t *testing.T) {
	exec := &captureExec{}
	p := New()
	deps := plugins.Deps{HostExec: exec}
	st, err := p.HostStatus(context.Background(), deps, 1)
	if err != nil { t.Fatal(err) }
	if st.State != "running" {
		t.Fatalf("State = %q want running", st.State)
	}
}

func TestUndeployFromHost_DisablesUnit(t *testing.T) {
	exec := &captureExec{}
	p := New()
	deps := plugins.Deps{HostExec: exec}
	if err := p.UndeployFromHost(context.Background(), deps, 1); err != nil { t.Fatal(err) }
	found := false
	for _, c := range exec.cmds {
		if len(c) >= 3 && c[0] == "systemctl" && c[1] == "disable" && c[2] == "--now" {
			found = true; break
		}
	}
	if !found { t.Fatalf("expected systemctl disable, got %v", exec.cmds) }
}
