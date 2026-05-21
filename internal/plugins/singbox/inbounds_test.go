package singbox

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func newInboundStore(t *testing.T) *InboundStore {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "ib.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	// Run all 4 migrations: 0001 (inbounds) references singbox_certificates (0004),
	// so all must run to satisfy the FK constraint with _fk=1 enabled.
	if err := plugins.RunPluginMigrations(context.Background(), d, "singbox",
		loadMigrations()); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{1, 2, 3} {
		d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at)
			VALUES (?,?,?,?,?,?)`,
			id, fmt.Sprintf("s%d", id), fmt.Sprintf("1.2.3.%d", id), "root", 22,
			time.Now())
	}
	return &InboundStore{DB: d, Now: time.Now}
}

func TestInboundStore_GenerateTag(t *testing.T) {
	s := newInboundStore(t)
	tag := s.GenerateTag("landing")
	if len(tag) != len("landing-")+8 {
		t.Fatalf("tag length wrong: %q", tag)
	}
	if tag[:8] != "landing-" {
		t.Fatalf("tag prefix wrong: %q", tag)
	}
	tag2 := s.GenerateTag("relay")
	if tag2[:6] != "relay-" {
		t.Fatalf("relay prefix wrong: %q", tag2)
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
		UUID:     ptrStr("uuid-land"), SNI: ptrStr("www.icloud.com"),
		RealityPublicKey: ptrStr("PUB"), RealityPrivateKey: ptrStr("PRIV"),
		RealityShortID:         ptrStr("aabb1122"),
		RealityHandshakeServer: ptrStr("www.icloud.com"), RealityHandshakePort: ptrI64(443),
	})
	if err != nil {
		t.Fatal(err)
	}
	if landingID == 0 {
		t.Fatal("landingID is 0")
	}

	relayID, err := s.Insert(ctx, Inbound{
		ServerID: 2, Tag: s.GenerateTag("relay"), Port: 8443, Role: "relay",
		Protocol: "vless-reality",
		UUID:     ptrStr("uuid-relay"), SNI: ptrStr("www.apple.com"),
		RealityPublicKey:       ptrStr("PUB"),
		RealityShortID:         ptrStr("ccdd3344"),
		RealityHandshakeServer: ptrStr("www.apple.com"), RealityHandshakePort: ptrI64(443),
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
		t.Fatalf("relay row wrong: %+v", row)
	}
}

func TestInboundStore_ListByServer(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	for _, port := range []int{443, 8443} {
		_, _ = s.Insert(ctx, Inbound{
			ServerID: 1, Tag: s.GenerateTag("landing"), Port: port,
			Role: "landing", Protocol: "vmess-tcp",
		})
	}
	_, _ = s.Insert(ctx, Inbound{
		ServerID: 2, Tag: s.GenerateTag("landing"), Port: 443,
		Role: "landing", Protocol: "vmess-tcp",
	})

	rows, err := s.ListByServer(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows for server 1, want 2", len(rows))
	}
}

func TestInboundStore_ListAllWithUpstream(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	landingID, _ := s.Insert(ctx, Inbound{
		ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443,
		Role: "landing", Protocol: "vless-reality",
		UUID: ptrStr("lu"), SNI: ptrStr("www.icloud.com"),
		RealityPublicKey: ptrStr("LP"), RealityShortID: ptrStr("aa"),
		RealityHandshakeServer: ptrStr("www.icloud.com"), RealityHandshakePort: ptrI64(443),
	})
	_, _ = s.Insert(ctx, Inbound{
		ServerID: 2, Tag: s.GenerateTag("relay"), Port: 8443,
		Role: "relay", Protocol: "hysteria2",
		Password: ptrStr("secret"), SNI: ptrStr("hy2.example.com"),
		UpstreamInboundID: &landingID,
	})

	views, err := s.ListAllWithUpstream(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(views) != 2 {
		t.Fatalf("want 2 views, got %d", len(views))
	}
	var relay *InboundView
	for i := range views {
		if views[i].Role == "relay" {
			relay = &views[i]
			break
		}
	}
	if relay == nil {
		t.Fatal("no relay in views")
	}
	if !relay.UpstreamTag.Valid || relay.UpstreamServerName.String != "s1" {
		t.Fatalf("relay upstream JOIN missing: %+v", relay)
	}
}

func TestInboundStore_Update_ImmutableFieldsUnchanged(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	id, _ := s.Insert(ctx, Inbound{
		ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443,
		Role: "landing", Protocol: "vless-reality",
	})
	if err := s.Update(ctx, id, InboundPatch{
		Port: ptrInt(9443), SNI: ptrStr("new.sni"),
	}); err != nil {
		t.Fatal(err)
	}
	row, _ := s.GetByID(ctx, id)
	if row.Port != 9443 || row.SNI == nil || *row.SNI != "new.sni" {
		t.Fatalf("patch did not apply: %+v", row)
	}
	if row.Role != "landing" {
		t.Fatalf("role changed: %s", row.Role)
	}
	if row.Protocol != "vless-reality" {
		t.Fatalf("protocol changed: %s", row.Protocol)
	}
}

func TestInboundStore_Delete_RestrictLandingWithRelay(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	landingID, _ := s.Insert(ctx, Inbound{
		ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443,
		Role: "landing", Protocol: "vmess-tcp",
	})
	_, _ = s.Insert(ctx, Inbound{
		ServerID: 2, Tag: s.GenerateTag("relay"), Port: 8443,
		Role: "relay", Protocol: "vmess-tcp",
		UpstreamInboundID: &landingID,
	})
	if err := s.Delete(ctx, landingID); err == nil {
		t.Fatal("expected RESTRICT error deleting landing with dependent relay")
	}
}

func ptrStr(s string) *string { return &s }
func ptrI64(i int64) *int64   { return &i }
func ptrInt(i int) *int        { return &i }
