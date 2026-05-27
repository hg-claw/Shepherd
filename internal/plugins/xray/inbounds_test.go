package xray

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func newInboundStore(t *testing.T) *InboundStore {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "i.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	if err := plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations(shepdb.DriverSQLite)); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{1, 2, 3} {
		d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port)
			VALUES (?,?,?,?,?)`,
			id, "s"+string(rune('0'+id)), "1.2.3."+string(rune('0'+id)), "root", 22)
	}
	return &InboundStore{DB: d, Now: time.Now}
}

func TestInboundStore_GenerateTag(t *testing.T) {
	s := newInboundStore(t)
	tag := s.GenerateTag("landing")
	if len(tag) != len("landing-")+8 {
		t.Fatalf("tag length: %q", tag)
	}
	if tag[:8] != "landing-" {
		t.Fatalf("tag prefix: %q", tag)
	}
	tag2 := s.GenerateTag("relay")
	if tag2[:6] != "relay-" {
		t.Fatalf("relay tag prefix: %q", tag2)
	}
	if tag == tag2 {
		t.Fatalf("tags should differ: %q vs %q", tag, tag2)
	}
}

func TestInboundStore_InsertLandingThenRelay(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	landingID, err := s.Insert(ctx, Inbound{
		ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443, Role: "landing",
		Protocol: "vless-reality",
		UUID: "u1", SNI: "www.lovelive-anime.jp", PublicKey: "P", PrivateKey: "K", ShortID: "aa",
	})
	if err != nil {
		t.Fatal(err)
	}
	if landingID == 0 {
		t.Fatalf("landingID 0")
	}

	relayID, err := s.Insert(ctx, Inbound{
		ServerID: 2, Tag: s.GenerateTag("relay"), Port: 8443, Role: "relay",
		Protocol: "vless-reality",
		UUID: "u2", SNI: "www.microsoft.com", PublicKey: "P2", PrivateKey: "K2", ShortID: "bb",
		UpstreamInboundID: &landingID,
	})
	if err != nil {
		t.Fatal(err)
	}

	row, err := s.GetByID(ctx, relayID)
	if err != nil {
		t.Fatal(err)
	}
	if row.Role != "relay" || row.UpstreamInboundID == nil || *row.UpstreamInboundID != landingID {
		t.Fatalf("relay row = %+v", row)
	}
}

func TestInboundStore_ListByServer(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	_, _ = s.Insert(ctx, Inbound{ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality"})
	_, _ = s.Insert(ctx, Inbound{ServerID: 1, Tag: s.GenerateTag("landing"), Port: 8443, Role: "landing", Protocol: "vless-reality"})
	_, _ = s.Insert(ctx, Inbound{ServerID: 2, Tag: s.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality"})

	rows, err := s.ListByServer(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows for server 1, want 2", len(rows))
	}
}

func TestInboundStore_ListWithUpstream(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	landingID, _ := s.Insert(ctx, Inbound{ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality",
		UUID: "lu", SNI: "www.lovelive-anime.jp", PublicKey: "LP", ShortID: "ll"})
	_, _ = s.Insert(ctx, Inbound{ServerID: 2, Tag: s.GenerateTag("relay"), Port: 8443, Role: "relay", Protocol: "vless-reality",
		UpstreamInboundID: &landingID})

	views, err := s.ListAllWithUpstream(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(views) != 2 {
		t.Fatalf("views = %d want 2", len(views))
	}
	var relay *InboundView
	for i := range views {
		if views[i].Role == "relay" {
			relay = &views[i]
			break
		}
	}
	if relay == nil {
		t.Fatalf("no relay view")
	}
	if relay.UpstreamTag.String == "" || relay.UpstreamServerName.String != "s1" {
		t.Fatalf("relay view missing JOIN: %+v", relay)
	}
}

func TestInboundStore_Update_DoesNotChangeRoleOrUpstream(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	id, _ := s.Insert(ctx, Inbound{ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality",
		UUID: "u", SNI: "s", PublicKey: "P", PrivateKey: "K", ShortID: "aa"})
	if err := s.Update(ctx, id, InboundPatch{
		Port: ptrInt(8443), UUID: ptrString("u2"), SNI: ptrString("s2"),
	}); err != nil {
		t.Fatal(err)
	}
	row, _ := s.GetByID(ctx, id)
	if row.Port != 8443 || row.UUID != "u2" || row.SNI != "s2" {
		t.Fatalf("update did not apply: %+v", row)
	}
	if row.Role != "landing" {
		t.Fatalf("role changed unexpectedly: %s", row.Role)
	}
}

func TestInboundStore_Delete_RestrictsLandingWithRelay(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	landingID, _ := s.Insert(ctx, Inbound{ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality"})
	_, _ = s.Insert(ctx, Inbound{ServerID: 2, Tag: s.GenerateTag("relay"), Port: 8443, Role: "relay", Protocol: "vless-reality",
		UpstreamInboundID: &landingID})
	if err := s.Delete(ctx, landingID); err == nil {
		t.Fatalf("expected RESTRICT error deleting landing with relay dependent")
	}
}

func TestInbound_AliasRoundTrip(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()

	// Insert with alias
	id, err := s.Insert(ctx, Inbound{
		ServerID: 1, Role: "landing", Protocol: "vless-reality", Port: 443,
		Alias: "🇭🇰 HK 01",
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.GetByID(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Alias != "🇭🇰 HK 01" {
		t.Fatalf("Alias after Insert: got %q, want %q", got.Alias, "🇭🇰 HK 01")
	}

	// Update alias
	newAlias := "🇭🇰 HK renamed"
	if err := s.Update(ctx, id, InboundPatch{Alias: &newAlias}); err != nil {
		t.Fatal(err)
	}
	got, err = s.GetByID(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Alias != newAlias {
		t.Fatalf("Alias after Update: got %q, want %q", got.Alias, newAlias)
	}

	// Patching an unrelated field must NOT clobber alias
	port := 8443
	if err := s.Update(ctx, id, InboundPatch{Port: &port}); err != nil {
		t.Fatal(err)
	}
	got, err = s.GetByID(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Alias != newAlias {
		t.Fatalf("Alias clobbered by unrelated patch: got %q, want %q", got.Alias, newAlias)
	}
}

func ptrInt(v int) *int             { return &v }
func ptrString(v string) *string { return &v }
