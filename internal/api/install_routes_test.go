package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentsvc"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/installer"
	"github.com/hg-claw/Shepherd/internal/serversvc"
	"github.com/hg-claw/Shepherd/internal/telemetrysvc"
)

type fakeInstaller2 struct{ sink func(string) }

func (f *fakeInstaller2) Run(context.Context, installer.InstallParams) error {
	if f.sink != nil {
		f.sink("ok")
	}
	return nil
}
func (f *fakeInstaller2) SetLogSink(s func(string)) { f.sink = s }

func TestInstall_HappyPath_HTTP(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)

	svc := &serversvc.Service{DB: d}
	tokens := &agentsvc.Service{DB: d}
	mgr := &serversvc.InstallManager{Service: svc, Installer: &fakeInstaller2{}, Tokens: tokens, ServerURL: "http://x"}
	api := &ServersAPI{
		Servers: svc, Tokens: tokens, Hub: agentsvc.NewHub(),
		Query: &telemetrysvc.Query{DB: d}, InstallManager: mgr,
	}
	body, _ := json.Marshal(installReq{
		Name: "h", SSHHost: "h", SSHUser: "root", SSHPassword: "p", Arch: "amd64",
	})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/servers/install", bytes.NewReader(body))
	api.Install(w, r)
	if w.Code != 202 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	for i := 0; i < 100; i++ {
		var stage string
		_ = d.Get(&stage, "SELECT install_stage FROM servers ORDER BY id DESC LIMIT 1")
		if stage == "done" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("install did not reach 'done'")
}

func TestConfig_OfflineAgent_Returns409(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	svc := &serversvc.Service{DB: d}
	srv, _ := svc.Create(context.Background(), serversvc.CreateInput{Name: "h"})

	api := &ServersAPI{
		Servers: svc, Tokens: &agentsvc.Service{DB: d}, Hub: agentsvc.NewHub(),
		Query: &telemetrysvc.Query{DB: d},
	}
	body, _ := json.Marshal(configReq{TelemetryIntervalSeconds: 60})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/servers/"+strconv.FormatInt(srv.ID, 10)+"/config", bytes.NewReader(body))
	api.Config(w, r)
	if w.Code != 409 {
		t.Fatalf("status=%d", w.Code)
	}
}
