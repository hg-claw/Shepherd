package serversvc

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/installer"
)

type fakeInstaller struct {
	fail bool
	sink func(string)
}

func (f *fakeInstaller) Run(_ context.Context, _ installer.InstallParams) error {
	if f.sink != nil {
		f.sink("hello")
	}
	if f.fail {
		return errors.New("boom")
	}
	return nil
}
func (f *fakeInstaller) SetLogSink(s func(string)) { f.sink = s }

type fakeTokens struct{}

func (fakeTokens) IssueEnrollmentToken(context.Context, int64) (string, time.Time, error) {
	return "tok", time.Now().Add(time.Hour), nil
}

func newInstallTest(t *testing.T) (*InstallManager, *Service, int64) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	svc := &Service{DB: d}
	srv, _ := svc.Create(context.Background(), CreateInput{Name: "h", SSHHost: "h"})
	mgr := &InstallManager{Service: svc, Tokens: fakeTokens{}, ServerURL: "http://x"}
	return mgr, svc, srv.ID
}

func TestInstallManager_HappyPath(t *testing.T) {
	mgr, svc, sid := newInstallTest(t)
	mgr.Installer = &fakeInstaller{}
	mgr.Start(InstallRequest{Server: &Server{ID: sid}, Arch: "amd64"})
	for i := 0; i < 100; i++ {
		s, _ := svc.Get(context.Background(), sid)
		if s.InstallStage == "done" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	s, _ := svc.Get(context.Background(), sid)
	if s.InstallStage != "done" {
		t.Fatalf("stage=%s", s.InstallStage)
	}
	if !strings.Contains(s.InstallLog, "hello") {
		t.Errorf("log missing 'hello': %q", s.InstallLog)
	}
}

func TestInstallManager_FailureRecorded(t *testing.T) {
	mgr, svc, sid := newInstallTest(t)
	mgr.Installer = &fakeInstaller{fail: true}
	mgr.Start(InstallRequest{Server: &Server{ID: sid}, Arch: "amd64"})
	for i := 0; i < 100; i++ {
		s, _ := svc.Get(context.Background(), sid)
		if s.InstallStage == "failed" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	s, _ := svc.Get(context.Background(), sid)
	if s.InstallStage != "failed" || !s.InstallError.Valid || !strings.Contains(s.InstallError.String, "boom") {
		t.Fatalf("got stage=%s err=%+v", s.InstallStage, s.InstallError)
	}
}

func TestSweepStuck(t *testing.T) {
	mgr, svc, sid := newInstallTest(t)
	old := time.Now().Add(-time.Hour).UTC()
	_, _ = svc.DB.Exec("UPDATE servers SET install_stage='installing', install_started_at=$1 WHERE id=$2", old, sid)
	if err := mgr.SweepStuck(context.Background()); err != nil {
		t.Fatal(err)
	}
	s, _ := svc.Get(context.Background(), sid)
	if s.InstallStage != "failed" {
		t.Errorf("stage=%s", s.InstallStage)
	}
}
