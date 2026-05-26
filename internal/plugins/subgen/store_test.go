package subgen

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "s.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	if err := plugins.RunPluginMigrations(context.Background(), d, "subgen", loadMigrations(shepdb.DriverSQLite)); err != nil {
		t.Fatal(err)
	}
	return &Store{DB: d, Now: time.Now}
}

func TestStore_TemplateAndSubscriptionCRUD(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	tid, err := s.CreateTemplate(ctx, "t1", false, `{"final":"PROXY"}`)
	if err != nil {
		t.Fatal(err)
	}
	sub, err := s.CreateSubscription(ctx, "sub1", tid)
	if err != nil {
		t.Fatal(err)
	}
	if sub.Token == "" {
		t.Fatal("token not generated")
	}
	if err := s.SetInbounds(ctx, sub.ID, []Selection{{Source: "xray", InboundID: 5}}); err != nil {
		t.Fatal(err)
	}
	got, err := s.SubscriptionByToken(ctx, sub.Token)
	if err != nil || got.ID != sub.ID {
		t.Fatalf("lookup by token: %v got=%+v", err, got)
	}
	sels, _ := s.InboundsFor(ctx, sub.ID)
	if len(sels) != 1 || sels[0].Source != "xray" || sels[0].InboundID != 5 {
		t.Fatalf("inbounds = %+v", sels)
	}
}

func TestStore_RotateTokenChangesToken(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	tid, _ := s.CreateTemplate(ctx, "t", false, `{}`)
	sub, _ := s.CreateSubscription(ctx, "s", tid)
	old := sub.Token
	if err := s.RotateToken(ctx, sub.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Subscription(ctx, sub.ID)
	if got.Token == old || got.Token == "" {
		t.Fatalf("token not rotated: %q -> %q", old, got.Token)
	}
}
