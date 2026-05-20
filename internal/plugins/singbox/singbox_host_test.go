package singbox

import (
	"context"
	"testing"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

type activeHostExec struct{ *fakeSBHostExec }

func (a *activeHostExec) RunCmd(_ context.Context, _ int64, name string, args ...string) ([]byte, []byte, int, error) {
	a.cmds = append(a.cmds, append([]string{name}, args...))
	return []byte("active\n"), nil, 0, nil
}

func TestPlugin_HostStatus_Running(t *testing.T) {
	d := newDeployTestDB(t)
	exec := &fakeSBHostExec{}
	p := New()
	deps := plugins.Deps{DB: d, HostExec: &activeHostExec{fakeSBHostExec: exec}}
	status, err := p.HostStatus(context.Background(), deps, 1)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != "running" {
		t.Errorf("expected running, got %s", status.State)
	}
}

func TestPlugin_UndeployFromHost_Stop(t *testing.T) {
	d := newDeployTestDB(t)
	exec := &fakeSBHostExec{}
	p := New()
	deps := plugins.Deps{DB: d, HostExec: exec}
	if err := p.UndeployFromHost(context.Background(), deps, 1); err != nil {
		t.Fatal(err)
	}
	sawStop := false
	for _, c := range exec.cmds {
		if len(c) >= 2 && c[0] == "systemctl" && (c[1] == "stop" || c[1] == "disable") {
			sawStop = true
		}
	}
	if !sawStop {
		t.Fatalf("expected stop/disable; cmds=%v", exec.cmds)
	}
}

func TestPlugin_LogStreamCommand_Linux(t *testing.T) {
	d := newDeployTestDB(t)
	d.MustExec(`UPDATE servers SET agent_os='linux' WHERE id=1`)
	p := New()
	deps := plugins.Deps{DB: d, HostExec: &fakeSBHostExec{}}
	name, args, err := p.LogStreamCommand(context.Background(), deps, 1)
	if err != nil {
		t.Fatal(err)
	}
	if name != "journalctl" {
		t.Errorf("expected journalctl, got %s", name)
	}
	found := false
	for _, a := range args {
		if a == "shepherd-singbox" {
			found = true
		}
	}
	if !found {
		t.Errorf("shepherd-singbox not in args: %v", args)
	}
}

func TestPlugin_LogStreamCommand_Darwin(t *testing.T) {
	d := newDeployTestDB(t)
	d.MustExec(`UPDATE servers SET agent_os='darwin' WHERE id=1`)
	p := New()
	deps := plugins.Deps{DB: d, HostExec: &fakeSBHostExec{}}
	name, args, err := p.LogStreamCommand(context.Background(), deps, 1)
	if err != nil {
		t.Fatal(err)
	}
	if name != "tail" {
		t.Errorf("expected tail, got %s", name)
	}
	found := false
	for _, a := range args {
		if a == "/var/log/shepherd-singbox.out.log" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected out.log path in args: %v", args)
	}
}

func TestPlugin_DeployToHost_VersionRequired(t *testing.T) {
	d := newDeployTestDB(t)
	exec := &fakeSBHostExec{}
	p := New()
	deps := plugins.Deps{DB: d, HostExec: exec}
	err := p.DeployToHost(context.Background(), deps, 1, "", nil)
	if err == nil {
		t.Fatal("expected error for empty version, got nil")
	}
}
