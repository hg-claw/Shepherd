package singbox

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func newCertStore(t *testing.T) *CertStore {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "cert.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	// Run all 4 migrations so cert_id FK in singbox_inbounds is valid
	if err := plugins.RunPluginMigrations(context.Background(), d, "singbox", loadMigrations()); err != nil {
		t.Fatal(err)
	}
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at)
		VALUES (1,'s1','1.1.1.1','root',22,?)`, time.Now())
	return &CertStore{DB: d, Now: time.Now}
}

func TestCertStore_InsertAndGet(t *testing.T) {
	cs := newCertStore(t)
	ctx := context.Background()
	expires := time.Now().Add(90 * 24 * time.Hour).UTC().Truncate(time.Second)
	id, err := cs.Insert(ctx, CertRow{
		Domain:    "proxy.example.com",
		CertPEM:   "CERT_PEM",
		KeyPEM:    "KEY_PEM",
		ExpiresAt: expires,
		Issuer:    "Let's Encrypt",
		Status:    "active",
	})
	if err != nil {
		t.Fatal(err)
	}
	row, err := cs.GetByDomain(ctx, "proxy.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if row.ID != id || row.Status != "active" || row.CertPEM != "CERT_PEM" {
		t.Fatalf("unexpected row: %+v", row)
	}
}

func TestCertStore_List(t *testing.T) {
	cs := newCertStore(t)
	ctx := context.Background()
	for _, d := range []string{"a.example.com", "b.example.com"} {
		_, _ = cs.Insert(ctx, CertRow{
			Domain: d, CertPEM: "C", KeyPEM: "K",
			ExpiresAt: time.Now().Add(90 * 24 * time.Hour), Status: "active",
		})
	}
	rows, err := cs.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 certs, got %d", len(rows))
	}
}

func TestCertStore_UpsertStatus(t *testing.T) {
	cs := newCertStore(t)
	ctx := context.Background()
	id, _ := cs.Insert(ctx, CertRow{
		Domain: "x.example.com", CertPEM: "C", KeyPEM: "K",
		ExpiresAt: time.Now().Add(90 * 24 * time.Hour), Status: "issuing",
	})
	errMsg := "acme: error"
	if err := cs.UpsertStatus(ctx, id, "failed", &errMsg); err != nil {
		t.Fatal(err)
	}
	row, _ := cs.Get(ctx, id)
	if row.Status != "failed" || row.LastError == nil || *row.LastError != errMsg {
		t.Fatalf("status not updated: %+v", row)
	}
}

func TestCertStore_Delete_RestrictWhenReferencedByInbound(t *testing.T) {
	cs := newCertStore(t)
	ctx := context.Background()
	certID, _ := cs.Insert(ctx, CertRow{
		Domain: "y.example.com", CertPEM: "C", KeyPEM: "K",
		ExpiresAt: time.Now().Add(90 * 24 * time.Hour), Status: "active",
	})
	// Insert inbound that references this cert
	cs.DB.MustExec(`INSERT INTO singbox_inbounds
		(server_id,tag,port,role,protocol,cert_id,updated_at)
		VALUES (1,'landing-ref1',443,'landing','trojan-tls',?,?)`, certID, time.Now())
	// Delete should fail — FK RESTRICT from singbox_inbounds.cert_id
	if err := cs.Delete(ctx, certID); err == nil {
		t.Fatal("expected RESTRICT error when cert is referenced by inbound")
	}
}

func TestCertStore_ListExpiringSoon(t *testing.T) {
	cs := newCertStore(t)
	ctx := context.Background()
	now := time.Now()

	// Insert cert expiring in 20 days (within 30 days)
	_, _ = cs.Insert(ctx, CertRow{
		Domain:    "soon.example.com",
		CertPEM:   "C",
		KeyPEM:    "K",
		ExpiresAt: now.Add(20 * 24 * time.Hour),
		Status:    "active",
	})

	// Insert cert expiring in 60 days (outside 30 days)
	_, _ = cs.Insert(ctx, CertRow{
		Domain:    "later.example.com",
		CertPEM:   "C",
		KeyPEM:    "K",
		ExpiresAt: now.Add(60 * 24 * time.Hour),
		Status:    "active",
	})

	rows, err := cs.ListExpiringSoon(ctx, 30)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("want 1 cert expiring within 30 days, got %d", len(rows))
	}
	if rows[0].Domain != "soon.example.com" {
		t.Fatalf("expected soon.example.com, got %s", rows[0].Domain)
	}
}
