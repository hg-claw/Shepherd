package singbox

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type fakeSBHostExec struct {
	pushed  map[string][]byte
	fetched []agentapi.FileFetch
	cmds    [][]string
}

func (f *fakeSBHostExec) PushFile(_ context.Context, _ int64, path string, _ uint32, content []byte) error {
	if f.pushed == nil {
		f.pushed = map[string][]byte{}
	}
	f.pushed[path] = append([]byte(nil), content...)
	return nil
}

func (f *fakeSBHostExec) FetchURL(_ context.Context, _ int64, spec agentapi.FileFetch) error {
	f.fetched = append(f.fetched, spec)
	return nil
}

func (f *fakeSBHostExec) RunCmd(_ context.Context, _ int64, name string, args ...string) ([]byte, []byte, int, error) {
	f.cmds = append(f.cmds, append([]string{name}, args...))
	return nil, nil, 0, nil
}

func (f *fakeSBHostExec) StreamCmd(context.Context, int64, string, []string, func(string)) error {
	return nil
}

func newDeployTestDB(t *testing.T) *sqlx.DB {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "dep.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	if err := plugins.RunPluginMigrations(context.Background(), d, "singbox", loadMigrations(shepdb.DriverSQLite)); err != nil {
		t.Fatal(err)
	}
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,agent_os,agent_arch,created_at)
		VALUES (1,'s1','1.1.1.1','root',22,'linux','amd64',?)`, time.Now())
	return d
}

// TestAssembleAndDeploy_NoCerts: inbound with no cert (vless-reality) → only config.json pushed + restart.
func TestAssembleAndDeploy_NoCerts(t *testing.T) {
	d := newDeployTestDB(t)
	store := &InboundStore{DB: d, Now: time.Now}
	_, _ = store.Insert(context.Background(), Inbound{
		ServerID: 1, Tag: store.GenerateTag("landing"), Port: 443,
		Role: "landing", Protocol: "vless-reality",
		UUID: ptrStr("u"), SNI: ptrStr("www.icloud.com"),
		RealityPublicKey: ptrStr("PUB"), RealityPrivateKey: ptrStr("PRIV"),
		RealityShortID:         ptrStr("aa"),
		RealityHandshakeServer: ptrStr("www.icloud.com"), RealityHandshakePort: ptrI64(443),
	})
	exec := &fakeSBHostExec{}
	deps := plugins.Deps{DB: d, HostExec: exec}
	if err := AssembleAndDeploy(context.Background(), deps, 1); err != nil {
		t.Fatal(err)
	}
	if _, ok := exec.pushed[singboxConfigRemotePath]; !ok {
		t.Fatalf("config.json not pushed; pushed=%v", keysOf(exec.pushed))
	}
	// No cert files should have been pushed.
	for k := range exec.pushed {
		if k != singboxConfigRemotePath {
			t.Errorf("unexpected file pushed: %s", k)
		}
	}
	sawRestart := false
	for _, c := range exec.cmds {
		if len(c) >= 3 && c[0] == "systemctl" && c[1] == "restart" && c[2] == singboxUnitNameLinux {
			sawRestart = true
		}
	}
	if !sawRestart {
		t.Fatalf("no restart; cmds=%v", exec.cmds)
	}
}

// TestAssembleAndDeploy_WithCert_PushesCertFiles: inbound with a cert → cert.crt + cert.key + config.json pushed + restart.
func TestAssembleAndDeploy_WithCert_PushesCertFiles(t *testing.T) {
	d := newDeployTestDB(t)
	cs := &CertStore{DB: d, Now: time.Now}
	certID, _ := cs.Insert(context.Background(), CertRow{
		Domain:    "proxy.example.com",
		CertPEM:   "CERT_PEM_DATA",
		KeyPEM:    "KEY_PEM_DATA",
		ExpiresAt: time.Now().Add(90 * 24 * time.Hour),
		Status:    "active",
	})
	store := &InboundStore{DB: d, Now: time.Now}
	_, _ = store.Insert(context.Background(), Inbound{
		ServerID: 1, Tag: store.GenerateTag("landing"), Port: 8443,
		Role: "landing", Protocol: "trojan-tls",
		Password: ptrStr("pass"), SNI: ptrStr("proxy.example.com"), CertID: &certID,
	})
	exec := &fakeSBHostExec{}
	deps := plugins.Deps{DB: d, HostExec: exec}
	if err := AssembleAndDeploy(context.Background(), deps, 1); err != nil {
		t.Fatal(err)
	}
	crtPath := singboxCertDir + "/proxy.example.com.crt"
	keyPath := singboxCertDir + "/proxy.example.com.key"
	if string(exec.pushed[crtPath]) != "CERT_PEM_DATA" {
		t.Errorf("cert not pushed; keys=%v", keysOf(exec.pushed))
	}
	if string(exec.pushed[keyPath]) != "KEY_PEM_DATA" {
		t.Errorf("key not pushed; keys=%v", keysOf(exec.pushed))
	}
	if _, ok := exec.pushed[singboxConfigRemotePath]; !ok {
		t.Fatalf("config.json not pushed; pushed=%v", keysOf(exec.pushed))
	}
	sawRestart := false
	for _, c := range exec.cmds {
		if len(c) >= 3 && c[0] == "systemctl" && c[1] == "restart" && c[2] == singboxUnitNameLinux {
			sawRestart = true
		}
	}
	if !sawRestart {
		t.Fatalf("no restart; cmds=%v", exec.cmds)
	}
}

// TestAssembleAndDeploy_ZeroInboundsStops: no inbounds → stop called, config.json NOT pushed.
func TestAssembleAndDeploy_ZeroInboundsStops(t *testing.T) {
	d := newDeployTestDB(t)
	exec := &fakeSBHostExec{}
	deps := plugins.Deps{DB: d, HostExec: exec}
	if err := AssembleAndDeploy(context.Background(), deps, 1); err != nil {
		t.Fatal(err)
	}
	sawStop := false
	for _, c := range exec.cmds {
		if len(c) >= 2 && c[0] == "systemctl" && (c[1] == "stop" || c[1] == "disable") {
			sawStop = true
		}
	}
	if !sawStop {
		t.Fatalf("expected stop/disable on zero inbounds; cmds=%v", exec.cmds)
	}
	if _, pushed := exec.pushed[singboxConfigRemotePath]; pushed {
		t.Error("config.json must not be pushed when zero inbounds")
	}
}

func keysOf(m map[string][]byte) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	return ks
}
