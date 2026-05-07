package serversvc

import (
	"context"
	"path/filepath"
	"testing"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func newSvc(t *testing.T) *Service {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	return &Service{DB: d}
}

func TestCreateGetListPatchDelete(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	srv, err := svc.Create(ctx, CreateInput{Name: "h1", SSHHost: "1.2.3.4", SSHUser: "root"})
	if err != nil {
		t.Fatal(err)
	}
	if srv.ID == 0 || srv.SSHPort != 22 {
		t.Fatalf("bad create %+v", srv)
	}

	got, err := svc.Get(ctx, srv.ID)
	if err != nil || got.Name != "h1" {
		t.Fatalf("get fail: %v %+v", err, got)
	}

	all, _ := svc.List(ctx)
	if len(all) != 1 {
		t.Fatalf("list len=%d", len(all))
	}

	alias := "hk-1"
	show := true
	if _, err := svc.Patch(ctx, srv.ID, PatchInput{PublicAlias: &alias, ShowOnPublic: &show}); err != nil {
		t.Fatal(err)
	}
	got, _ = svc.Get(ctx, srv.ID)
	if got.PublicAlias.String != "hk-1" || !got.ShowOnPublic {
		t.Errorf("patch fail %+v", got)
	}

	if err := svc.Delete(ctx, srv.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Get(ctx, srv.ID); err != ErrNotFound {
		t.Errorf("want ErrNotFound, got %v", err)
	}
}
