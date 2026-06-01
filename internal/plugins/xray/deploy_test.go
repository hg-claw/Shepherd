package xray

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/ghmirror"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type captureExec struct {
	pushed   []push
	fetched  []agentapi.FileFetch
	cmds     [][]string
}
type push struct {
	path string
	mode uint32
	body []byte
}

func (c *captureExec) PushFile(_ context.Context, _ int64, path string, mode uint32, body []byte) error {
	c.pushed = append(c.pushed, push{path, mode, body})
	return nil
}
func (c *captureExec) FetchURL(_ context.Context, _ int64, spec agentapi.FileFetch) error {
	c.fetched = append(c.fetched, spec)
	return nil
}
func (c *captureExec) RunCmd(_ context.Context, _ int64, name string, args ...string) ([]byte, []byte, int, error) {
	c.cmds = append(c.cmds, append([]string{name}, args...))
	if name == "systemctl" && len(args) > 0 && args[0] == "is-active" {
		return []byte("active"), nil, 0, nil
	}
	if name == "launchctl" && len(args) > 0 && args[0] == "print" {
		return []byte("state = running"), nil, 0, nil
	}
	return nil, nil, 0, nil
}
func (c *captureExec) StreamCmd(context.Context, int64, string, []string, func(string)) error {
	return nil
}

// fakeReleaser returns a canned FetchSpec without hitting GitHub.
type fakeReleaser struct {
	url    string
	sha    string
	mirror bool
}

func (f *fakeReleaser) ResolveFetchSpec(_ context.Context, version, osStr, arch string, useMirror bool) (agentapi.FileFetch, error) {
	f.mirror = useMirror
	u := f.url
	if u == "" {
		u = "https://github.com/XTLS/Xray-core/releases/download/v" + version + "/Xray-linux-64.zip"
	}
	if useMirror {
		u = ghmirror.Prefix + u
	}
	return agentapi.FileFetch{
		URL: u, Path: xrayBinaryRemotePathUnix, Mode: 0o755, SHA256: f.sha,
		Extract: &agentapi.FetchExtract{Kind: "zip", EntryGlob: "xray"},
	}, nil
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

func newXrayTestDBDarwin(t *testing.T) *plugins.Deps {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "xray_darwin.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	_, _ = d.Exec(`INSERT INTO servers(name, agent_os, agent_arch) VALUES('m', 'darwin', 'arm64')`)
	return &plugins.Deps{DB: d}
}

func TestDeployToHost_FetchesBinaryAndPushesConfigAndUnit(t *testing.T) {
	exec := &captureExec{}
	p := New()
	p.releaser = &fakeReleaser{}
	baseDeps := newXrayTestDB(t)
	baseDeps.HostExec = exec
	deps := *baseDeps

	cfg := []byte(`{"inbounds":[],"outbounds":[]}`)
	if err := p.DeployToHost(context.Background(), deps, 1, "1.8.11", cfg, false); err != nil {
		t.Fatal(err)
	}
	if len(exec.fetched) != 1 || exec.fetched[0].Path != "/usr/local/bin/shepherd-xray" {
		t.Fatalf("FetchURL not called for binary, got fetched=%v", exec.fetched)
	}
	wantPaths := []string{
		"/etc/shepherd-xray/config.json",
		"/etc/systemd/system/shepherd-xray.service",
	}
	for i, want := range wantPaths {
		if i >= len(exec.pushed) || exec.pushed[i].path != want {
			t.Fatalf("push[%d] = %v, want %s", i, exec.pushed[i], want)
		}
	}
	if !strings.Contains(string(exec.pushed[1].body), "shepherd-xray") {
		t.Fatalf("unit body missing service name: %s", exec.pushed[1].body)
	}
}

func TestDeployToHost_UseMirror_PassedThrough(t *testing.T) {
	exec := &captureExec{}
	p := New()
	rel := &fakeReleaser{}
	p.releaser = rel
	baseDeps := newXrayTestDB(t)
	baseDeps.HostExec = exec
	deps := *baseDeps

	if err := p.DeployToHost(context.Background(), deps, 1, "1.8.11", []byte(`{}`), true); err != nil {
		t.Fatal(err)
	}
	if !rel.mirror {
		t.Fatal("useMirror=true did not propagate to Releaser.ResolveFetchSpec")
	}
	if !strings.HasPrefix(exec.fetched[0].URL, ghmirror.Prefix) {
		t.Errorf("fetched URL = %q, expected to start with %q", exec.fetched[0].URL, ghmirror.Prefix)
	}
}

func TestDeployToHost_Darwin_PushesPlistAndLaunchctl(t *testing.T) {
	exec := &captureExec{}
	p := New()
	p.releaser = &fakeReleaser{}
	baseDeps := newXrayTestDBDarwin(t)
	baseDeps.HostExec = exec
	deps := *baseDeps

	cfg := []byte(`{"inbounds":[],"outbounds":[]}`)
	if err := p.DeployToHost(context.Background(), deps, 1, "1.8.11", cfg, false); err != nil {
		t.Fatal(err)
	}

	wantPaths := []string{
		"/etc/shepherd-xray/config.json",
		"/Library/LaunchDaemons/com.shepherd.xray.plist",
	}
	for i, want := range wantPaths {
		if i >= len(exec.pushed) || exec.pushed[i].path != want {
			t.Fatalf("push[%d] = %q, want %q", i, exec.pushed[i].path, want)
		}
	}

	if !strings.Contains(string(exec.pushed[1].body), "com.shepherd.xray") {
		t.Fatalf("plist body missing label: %s", exec.pushed[1].body)
	}

	foundBootstrap := false
	for _, cmd := range exec.cmds {
		if len(cmd) >= 3 && cmd[0] == "launchctl" && cmd[1] == "bootstrap" {
			foundBootstrap = true
		}
		if cmd[0] == "systemctl" {
			t.Fatalf("unexpected systemctl command on darwin: %v", cmd)
		}
	}
	if !foundBootstrap {
		t.Fatalf("expected launchctl bootstrap, got cmds: %v", exec.cmds)
	}
}

func TestHostStatus_Active(t *testing.T) {
	exec := &captureExec{}
	p := New()
	baseDeps := newXrayTestDB(t)
	baseDeps.HostExec = exec
	deps := *baseDeps
	st, err := p.HostStatus(context.Background(), deps, 1)
	if err != nil {
		t.Fatal(err)
	}
	if st.State != "running" {
		t.Fatalf("State = %q want running", st.State)
	}
}

func TestUndeployFromHost_DisablesUnit(t *testing.T) {
	exec := &captureExec{}
	p := New()
	baseDeps := newXrayTestDB(t)
	baseDeps.HostExec = exec
	deps := *baseDeps
	if err := p.UndeployFromHost(context.Background(), deps, 1); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range exec.cmds {
		if len(c) >= 3 && c[0] == "systemctl" && c[1] == "disable" && c[2] == "--now" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected systemctl disable, got %v", exec.cmds)
	}
}
