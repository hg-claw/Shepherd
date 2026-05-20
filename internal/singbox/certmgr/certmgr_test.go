package certmgr_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/singbox/certmgr"
)

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type fakeStore struct {
	certCalls   []certmgr.UpsertCertCall
	statusCalls []certmgr.UpsertStatusCall
	expiring    []certmgr.RenewalTarget
}

func (f *fakeStore) UpsertCert(_ context.Context, id int64, certPEM, keyPEM string, exp time.Time) error {
	f.certCalls = append(f.certCalls, certmgr.UpsertCertCall{
		ID: id, CertPEM: certPEM, KeyPEM: keyPEM, ExpiresAt: exp,
	})
	return nil
}

func (f *fakeStore) UpsertStatus(_ context.Context, id int64, status string, lastErr *string) error {
	f.statusCalls = append(f.statusCalls, certmgr.UpsertStatusCall{
		ID: id, Status: status, LastErr: lastErr,
	})
	return nil
}

func (f *fakeStore) ListExpiringSoon(_ context.Context, within time.Duration) ([]certmgr.RenewalTarget, error) {
	return f.expiring, nil
}

// fakeIssuer returns canned cert PEMs.
type fakeIssuer struct {
	err       error
	callCount atomic.Int64
}

func (fi *fakeIssuer) Obtain(_ context.Context, domain string, _ certmgr.ChallengeType, _ string, _ string) (certPEM []byte, keyPEM []byte, expiresAt time.Time, err error) {
	fi.callCount.Add(1)
	if fi.err != nil {
		return nil, nil, time.Time{}, fi.err
	}
	c, k, exp := selfSignedCert(domain)
	return []byte(c), []byte(k), exp, nil
}

// stubCFToken always returns a non-empty token.
type stubCFToken struct{ token string }

func (s *stubCFToken) Token(_ context.Context) (string, error) { return s.token, nil }

// emptyCFToken always returns empty.
type emptyCFToken struct{}

func (e *emptyCFToken) Token(_ context.Context) (string, error) { return "", nil }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func selfSignedCert(domain string) (certPEM, keyPEM string, expiresAt time.Time) {
	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	exp := time.Now().Add(90 * 24 * time.Hour)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: domain},
		DNSNames:     []string{domain},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     exp,
	}
	certDER, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	certPEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}))
	keyDER, _ := x509.MarshalECPrivateKey(priv)
	keyPEM = string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
	return certPEM, keyPEM, exp
}

func newMgr(store certmgr.Store, issuer certmgr.Issuer, cfToken certmgr.CFTokenProvider) *certmgr.Manager {
	return certmgr.NewManager(certmgr.Config{
		Store:           store,
		Issuer:          issuer,
		CFTokenProvider: cfToken,
		Email:           "test@shepherd.local",
		HTTP01ListenAddr: ":9080",
	})
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// TestManager_Issue_Success verifies that a successful issuance writes PEM to
// the store with status='active'.
func TestManager_Issue_Success(t *testing.T) {
	store := &fakeStore{}
	issuer := &fakeIssuer{}
	mgr := newMgr(store, issuer, &stubCFToken{token: "tok"})

	if err := mgr.Issue(context.Background(), "example.local", certmgr.HTTP01); err != nil {
		t.Fatalf("Issue: %v", err)
	}

	// UpsertCert must have been called once with non-empty PEMs
	if len(store.certCalls) != 1 {
		t.Fatalf("expected 1 UpsertCert, got %d", len(store.certCalls))
	}
	c := store.certCalls[0]
	if c.CertPEM == "" || c.KeyPEM == "" {
		t.Fatalf("PEMs not written: %+v", c)
	}
	if c.ExpiresAt.Before(time.Now()) {
		t.Fatalf("expiresAt in the past: %v", c.ExpiresAt)
	}

	// Final status must be 'active' (set via UpsertCert path — no explicit 'active' UpsertStatus needed,
	// but if the impl calls UpsertStatus('active') that's fine too).
	// The key invariant: no 'failed' status call.
	for _, sc := range store.statusCalls {
		if sc.Status == "failed" {
			t.Fatalf("unexpected 'failed' status call: %+v", sc)
		}
	}
}

// TestManager_Issue_Failure verifies that when the issuer returns an error the
// store gets a UpsertStatus call with status='failed' and last_error populated.
func TestManager_Issue_Failure(t *testing.T) {
	store := &fakeStore{}
	issuer := &fakeIssuer{err: errors.New("acme: connection refused")}
	mgr := newMgr(store, issuer, &stubCFToken{token: "tok"})

	err := mgr.Issue(context.Background(), "bad.local", certmgr.HTTP01)
	if err == nil {
		t.Fatal("expected error from Issue, got nil")
	}

	// Must have a 'failed' status call with last_error set
	var failedCall *certmgr.UpsertStatusCall
	for i := range store.statusCalls {
		if store.statusCalls[i].Status == "failed" {
			failedCall = &store.statusCalls[i]
			break
		}
	}
	if failedCall == nil {
		t.Fatalf("no 'failed' UpsertStatus call; got: %+v", store.statusCalls)
	}
	if failedCall.LastErr == nil || *failedCall.LastErr == "" {
		t.Fatalf("last_error not set in failed call: %+v", failedCall)
	}

	// No UpsertCert should have been called
	if len(store.certCalls) != 0 {
		t.Fatalf("expected 0 UpsertCert calls on failure, got %d", len(store.certCalls))
	}
}

// TestManager_Renew verifies that Renew calls through to Issue which updates
// the cert PEM in the store.
func TestManager_Renew(t *testing.T) {
	store := &fakeStore{}
	issuer := &fakeIssuer{}
	mgr := newMgr(store, issuer, &stubCFToken{token: "tok"})

	const domain = "renew.local"
	// First issue to get cert ID baseline.
	if err := mgr.Issue(context.Background(), domain, certmgr.DNS01CF); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	initialCalls := int64(issuer.callCount.Load())

	// Now renew — should trigger another Obtain call.
	if err := mgr.Renew(context.Background(), 7, domain, certmgr.DNS01CF); err != nil {
		t.Fatalf("Renew: %v", err)
	}

	if issuer.callCount.Load() <= initialCalls {
		t.Fatal("Renew did not call issuer.Obtain")
	}
	if len(store.certCalls) < 2 {
		t.Fatalf("expected ≥2 UpsertCert calls after Issue+Renew, got %d", len(store.certCalls))
	}
}

// TestManager_RunRenewalLoop verifies that the loop picks up expiring certs
// and renews them within one tick.
func TestManager_RunRenewalLoop(t *testing.T) {
	store := &fakeStore{
		expiring: []certmgr.RenewalTarget{
			{ID: 1, Domain: "loop.local", Challenge: certmgr.HTTP01},
		},
	}
	issuer := &fakeIssuer{}
	mgr := newMgr(store, issuer, &stubCFToken{token: "tok"})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		// Use a very short interval so the test finishes quickly.
		mgr.RunRenewalLoop(ctx, 10*time.Millisecond)
	}()

	// Wait until at least one Obtain call is made.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if issuer.callCount.Load() > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done

	if issuer.callCount.Load() == 0 {
		t.Fatal("RunRenewalLoop did not trigger any Renew call")
	}
}

// TestManager_Issue_RequiresCFTokenForDNS01 verifies that DNS01CF challenge
// fails when the CFTokenProvider returns an empty token.
func TestManager_Issue_RequiresCFTokenForDNS01(t *testing.T) {
	store := &fakeStore{}
	issuer := &fakeIssuer{}
	mgr := newMgr(store, issuer, &emptyCFToken{})

	err := mgr.Issue(context.Background(), "dns.local", certmgr.DNS01CF)
	if err == nil {
		t.Fatal("expected error when CF token is empty for DNS01CF, got nil")
	}

	// No cert should have been written.
	if len(store.certCalls) != 0 {
		t.Fatalf("expected 0 UpsertCert calls, got %d", len(store.certCalls))
	}
}
