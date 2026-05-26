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
	sels, err := s.InboundsFor(ctx, sub.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(sels) != 1 || sels[0].Source != "xray" || sels[0].InboundID != 5 {
		t.Fatalf("inbounds = %+v", sels)
	}
}

func TestStore_CreateSubscriptionEnabledByDefault(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	tid, err := s.CreateTemplate(ctx, "t", false, `{}`)
	if err != nil {
		t.Fatal(err)
	}
	sub, err := s.CreateSubscription(ctx, "s", tid)
	if err != nil {
		t.Fatal(err)
	}
	// Read it back through the store to guard the inserted boolean value.
	got, err := s.Subscription(ctx, sub.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Enabled {
		t.Fatalf("freshly created subscription must be enabled, got Enabled=%v", got.Enabled)
	}
}

func TestStore_UpdateTemplate(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()

	// Create a user-owned template and update it.
	tid, err := s.CreateTemplate(ctx, "original", false, `{"final":"DIRECT"}`)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateTemplate(ctx, tid, "renamed", `{"final":"PROXY"}`); err != nil {
		t.Fatal(err)
	}
	got, err := s.Template(ctx, tid)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "renamed" || got.RulesJSON != `{"final":"PROXY"}` {
		t.Fatalf("unexpected after update: %+v", got)
	}

	// UpdateTemplate on a builtin row must be a no-op (WHERE builtin=false guards it).
	btid, err := s.CreateTemplate(ctx, "builtin-tpl", true, `{}`)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateTemplate(ctx, btid, "should-not-change", `{"x":1}`); err != nil {
		t.Fatal(err)
	}
	b, err := s.Template(ctx, btid)
	if err != nil {
		t.Fatal(err)
	}
	if b.Name != "builtin-tpl" {
		t.Fatalf("builtin name mutated to %q", b.Name)
	}
}

func TestStore_TemplateByName(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()

	_, err := s.CreateTemplate(ctx, "probe", true, `{"final":"PROXY"}`)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.TemplateByName(ctx, "probe")
	if err != nil {
		t.Fatal(err)
	}
	if !got.Builtin || got.Name != "probe" {
		t.Fatalf("unexpected template: %+v", got)
	}

	// Non-builtin with same name must not be returned.
	_, err = s.CreateTemplate(ctx, "probe", false, `{}`)
	if err != nil {
		t.Fatal(err)
	}
	got2, err := s.TemplateByName(ctx, "probe")
	if err != nil {
		t.Fatal(err)
	}
	if !got2.Builtin {
		t.Fatalf("TemplateByName returned non-builtin row: %+v", got2)
	}
}

func TestStore_DeleteSubscriptionCascades(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()

	tid, err := s.CreateTemplate(ctx, "t", false, `{}`)
	if err != nil {
		t.Fatal(err)
	}
	sub, err := s.CreateSubscription(ctx, "s", tid)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetInbounds(ctx, sub.ID, []Selection{
		{Source: "xray", InboundID: 1},
		{Source: "xray", InboundID: 2},
	}); err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteSubscription(ctx, sub.ID); err != nil {
		t.Fatal(err)
	}

	// Inbound rows must be gone (cascade).
	sels, err := s.InboundsFor(ctx, sub.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(sels) != 0 {
		t.Fatalf("expected 0 inbounds after cascade delete, got %d", len(sels))
	}
}

func TestStore_SetInboundsIdempotent(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()

	tid, err := s.CreateTemplate(ctx, "t", false, `{}`)
	if err != nil {
		t.Fatal(err)
	}
	sub, err := s.CreateSubscription(ctx, "s", tid)
	if err != nil {
		t.Fatal(err)
	}

	// First call: two inbounds.
	if err := s.SetInbounds(ctx, sub.ID, []Selection{
		{Source: "xray", InboundID: 10},
		{Source: "xray", InboundID: 20},
	}); err != nil {
		t.Fatal(err)
	}

	// Second call with a different set must replace, not append.
	if err := s.SetInbounds(ctx, sub.ID, []Selection{
		{Source: "sing", InboundID: 99},
	}); err != nil {
		t.Fatal(err)
	}

	sels, err := s.InboundsFor(ctx, sub.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(sels) != 1 || sels[0].Source != "sing" || sels[0].InboundID != 99 {
		t.Fatalf("expected replacement set, got %+v", sels)
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
