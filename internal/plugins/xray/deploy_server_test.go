package xray

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type fakeHostExec struct {
	pushed map[string][]byte
	cmds   [][]string
}

func (f *fakeHostExec) PushFile(_ context.Context, _ int64, path string, _ uint32, content []byte) error {
	if f.pushed == nil {
		f.pushed = map[string][]byte{}
	}
	f.pushed[path] = append([]byte(nil), content...)
	return nil
}
func (f *fakeHostExec) RunCmd(_ context.Context, _ int64, name string, args ...string) ([]byte, []byte, int, error) {
	f.cmds = append(f.cmds, append([]string{name}, args...))
	return nil, nil, 0, nil
}
func (f *fakeHostExec) StreamCmd(context.Context, int64, string, []string, func(string)) error {
	return nil
}

func TestAssembleAndDeploy_PushesConfigAndRestarts(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "ad.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations())
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,agent_os,agent_arch,created_at)
		VALUES (1,'s1','1.1.1.1','r',22,'linux','amd64',?)`, time.Now())
	store := &InboundStore{DB: d, Now: time.Now}
	_, _ = store.Insert(context.Background(), Inbound{
		ServerID: 1, Tag: store.GenerateTag("landing"), Port: 443, Role: "landing",
		Protocol: "vless-reality", UUID: "u", SNI: "www.lovelive-anime.jp",
		PublicKey: "P", PrivateKey: "K", ShortID: "aa",
	})

	exec := &fakeHostExec{}
	deps := plugins.Deps{DB: d, HostExec: exec}
	if err := AssembleAndDeploy(context.Background(), deps, 1); err != nil {
		t.Fatal(err)
	}

	if _, ok := exec.pushed["/etc/shepherd-xray/config.json"]; !ok {
		t.Fatalf("config not pushed; pushed=%v", exec.pushed)
	}
	sawRestart := false
	for _, c := range exec.cmds {
		if len(c) >= 2 && c[0] == "systemctl" && c[1] == "restart" {
			sawRestart = true
			break
		}
	}
	if !sawRestart {
		t.Fatalf("no restart cmd issued; cmds=%v", exec.cmds)
	}
}

func TestAssembleAndDeploy_NoInboundsStopsService(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "ad.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations())
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,agent_os,agent_arch,created_at)
		VALUES (1,'s1','1.1.1.1','r',22,'linux','amd64',?)`, time.Now())
	exec := &fakeHostExec{}
	deps := plugins.Deps{DB: d, HostExec: exec}
	if err := AssembleAndDeploy(context.Background(), deps, 1); err != nil {
		t.Fatal(err)
	}
	if _, ok := exec.pushed["/etc/shepherd-xray/config.json"]; ok {
		t.Fatalf("config should not be pushed when no inbounds")
	}
	sawStop := false
	for _, c := range exec.cmds {
		if len(c) >= 2 && c[0] == "systemctl" && (c[1] == "stop" || c[1] == "disable") {
			sawStop = true
			break
		}
	}
	if !sawStop {
		t.Fatalf("expected stop cmd; cmds=%v", exec.cmds)
	}
}
