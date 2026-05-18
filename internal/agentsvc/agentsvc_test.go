package agentsvc

import (
	"context"
	"path/filepath"
	"testing"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func newSvc(t *testing.T) *Service {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	return &Service{DB: d, AutoRecoverKey: "secret"}
}

func mustCreateServer(t *testing.T, svc *Service, name string) int64 {
	t.Helper()
	res, err := svc.DB.Exec("INSERT INTO servers(name) VALUES ($1)", name)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	return id
}

func TestEnrollment_Redeem(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	sid := mustCreateServer(t, svc, "h1")
	tok, _, err := svc.IssueEnrollmentToken(ctx, sid)
	if err != nil {
		t.Fatal(err)
	}
	machine, gotSID, err := svc.RedeemEnrollment(ctx, tok, "fp1", "linux", "amd64", "6.1", "v0.1.0", nil)
	if err != nil {
		t.Fatal(err)
	}
	if gotSID != sid || machine == "" {
		t.Fatalf("redeem mismatch sid=%d machine=%q", gotSID, machine)
	}
	if _, _, err := svc.RedeemEnrollment(ctx, tok, "fp1", "linux", "amd64", "6.1", "v0.1.0", nil); err != ErrInvalidEnrollment {
		t.Fatalf("want ErrInvalidEnrollment, got %v", err)
	}
	authSID, err := svc.AuthenticateMachineToken(ctx, machine)
	if err != nil || authSID != sid {
		t.Fatalf("auth mismatch sid=%d err=%v", authSID, err)
	}
}

func TestEnrollment_WithIPCandidates(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	sid := mustCreateServer(t, svc, "h2")
	tok, _, err := svc.IssueEnrollmentToken(ctx, sid)
	if err != nil {
		t.Fatal(err)
	}
	cands := []IPCandidate{
		{Addr: "1.2.3.4", Kind: "public", Source: "ipify"},
		{Addr: "192.168.1.10", Kind: "private", Source: "eth0"},
	}
	_, _, err = svc.RedeemEnrollment(ctx, tok, "fp2", "linux", "amd64", "6.1", "v0.1.0", cands)
	if err != nil {
		t.Fatal(err)
	}
	// ssh_host should be auto-set to the public IP
	var sshHost string
	if err := svc.DB.QueryRowContext(ctx, "SELECT COALESCE(ssh_host,'') FROM servers WHERE id=?", sid).Scan(&sshHost); err != nil {
		t.Fatal(err)
	}
	if sshHost != "1.2.3.4" {
		t.Errorf("expected ssh_host=1.2.3.4 got %q", sshHost)
	}
	// candidates should be persisted
	rows, err := svc.ListIPCandidates(ctx, sid)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Errorf("expected 2 candidates, got %d", len(rows))
	}
}

func TestAutoRegister_NewThenRotate(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	m1, sid1, err := svc.AutoRegister(ctx, "secret", "fpA", "host-a", "linux", "amd64", "6.1", "v0.1.0", nil)
	if err != nil {
		t.Fatal(err)
	}
	m2, sid2, err := svc.AutoRegister(ctx, "secret", "fpA", "host-a", "linux", "amd64", "6.1", "v0.1.0", nil)
	if err != nil {
		t.Fatal(err)
	}
	if sid1 != sid2 {
		t.Errorf("sid changed across rotation %d -> %d", sid1, sid2)
	}
	if m1 == m2 {
		t.Error("token should rotate")
	}
	if _, err := svc.AuthenticateMachineToken(ctx, m1); err == nil {
		t.Error("old token must be invalid after rotation")
	}
	if _, err := svc.AuthenticateMachineToken(ctx, m2); err != nil {
		t.Errorf("new token: %v", err)
	}
}

func TestAutoRegister_WithIPCandidates(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	cands := []IPCandidate{
		{Addr: "203.0.114.5", Kind: "public", Source: "ipify"},
		{Addr: "10.0.0.1", Kind: "private", Source: "en0"},
	}
	_, sid, err := svc.AutoRegister(ctx, "secret", "fpB", "host-b", "linux", "amd64", "6.1", "v0.1.0", cands)
	if err != nil {
		t.Fatal(err)
	}
	var sshHost string
	if err := svc.DB.QueryRowContext(ctx, "SELECT COALESCE(ssh_host,'') FROM servers WHERE id=?", sid).Scan(&sshHost); err != nil {
		t.Fatal(err)
	}
	if sshHost != "203.0.114.5" {
		t.Errorf("expected ssh_host=203.0.114.5 got %q", sshHost)
	}
	rows, err := svc.ListIPCandidates(ctx, sid)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Errorf("expected 2 candidates, got %d", len(rows))
	}
}

func TestAutoRegister_BadKey(t *testing.T) {
	svc := newSvc(t)
	if _, _, err := svc.AutoRegister(context.Background(), "wrong", "fp", "h", "linux", "amd64", "6.1", "v0.1.0", nil); err != ErrBadAutoRecoverKey {
		t.Fatalf("want ErrBadAutoRecoverKey, got %v", err)
	}
}
