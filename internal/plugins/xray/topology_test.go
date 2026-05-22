package xray

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func newTopoStore(t *testing.T) *TopologyStore {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil { t.Fatal(err) }
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil { t.Fatal(err) }
	if err := plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations(shepdb.DriverSQLite)); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{1, 2, 3} {
		d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port)
			VALUES (?,?,?,?,?)`,
			id, "s"+string(rune('0'+id)), "1.2.3."+string(rune('0'+id)), "root", 22)
	}
	return &TopologyStore{DB: d, Now: time.Now}
}

func TestTopologyStore_UpsertLanding(t *testing.T) {
	s := newTopoStore(t)
	ctx := context.Background()
	if err := s.UpsertLanding(ctx, 1); err != nil { t.Fatal(err) }
	row, err := s.Get(ctx, 1)
	if err != nil { t.Fatal(err) }
	if row.Role != "landing" || row.UpstreamServerID.Valid {
		t.Fatalf("got %+v", row)
	}
}

func TestTopologyStore_UpsertRelay_AndListByUpstream(t *testing.T) {
	s := newTopoStore(t)
	ctx := context.Background()
	if err := s.UpsertLanding(ctx, 1); err != nil { t.Fatal(err) }
	if err := s.UpsertRelay(ctx, 2, 1); err != nil { t.Fatal(err) }
	if err := s.UpsertRelay(ctx, 3, 1); err != nil { t.Fatal(err) }
	relays, err := s.ListByUpstream(ctx, 1)
	if err != nil { t.Fatal(err) }
	if len(relays) != 2 { t.Fatalf("relays = %v", relays) }
}

func TestTopologyStore_DeleteCascadesOnUpstreamRestrict(t *testing.T) {
	s := newTopoStore(t)
	ctx := context.Background()
	_ = s.UpsertLanding(ctx, 1)
	_ = s.UpsertRelay(ctx, 2, 1)
	// Deleting landing while relay depends on it must fail.
	if err := s.Delete(ctx, 1); err == nil {
		t.Fatalf("expected delete to fail (RESTRICT), got nil")
	}
	// Deleting the relay first then landing works.
	if err := s.Delete(ctx, 2); err != nil { t.Fatal(err) }
	if err := s.Delete(ctx, 1); err != nil { t.Fatal(err) }
}

func TestTopologyStore_ListWithUpstreamName(t *testing.T) {
	s := newTopoStore(t)
	ctx := context.Background()
	_ = s.UpsertLanding(ctx, 1)
	_ = s.UpsertRelay(ctx, 2, 1)
	rows, err := s.ListWithUpstreamName(ctx)
	if err != nil { t.Fatal(err) }
	byID := map[int64]TopologyView{}
	for _, r := range rows { byID[r.ServerID] = r }
	if byID[2].UpstreamName.String != "s1" {
		t.Fatalf("relay row upstream_name = %q want s1", byID[2].UpstreamName.String)
	}
}

var _ = sql.NullString{} // keep import in case test trims helpers
