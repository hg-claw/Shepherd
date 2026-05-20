package singbox

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestPostCert_CreatesRowInIssuingStatus: body validated, row inserted with status='issuing', returns 202.
func TestPostCert_CreatesRowInIssuingStatus(t *testing.T) {
	deps := newRouteDeps(t)

	// Override issueFunc to no-op so async goroutine doesn't error.
	origIssue := issueFunc
	issueFunc = func(_ context.Context, _ int64, _, _, _ string) error { return nil }
	defer func() { issueFunc = origIssue }()

	b, _ := json.Marshal(map[string]any{
		"domain":         "issue.example.com",
		"challenge_type": "http-01",
		"email":          "admin@example.com",
	})
	req := httptest.NewRequest("POST", "/certificates", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	postCertHandler(deps)(rr, req)

	if rr.Code != 202 {
		t.Fatalf("want 202, got %d: %s", rr.Code, rr.Body)
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["id"] == nil {
		t.Errorf("want id in response, got %v", resp)
	}

	// Verify row in DB with status=issuing.
	cs := &CertStore{DB: deps.DB}
	row, err := cs.GetByDomain(context.Background(), "issue.example.com")
	if err != nil {
		t.Fatalf("row not found: %v", err)
	}
	if row.Status != "issuing" {
		t.Errorf("want status=issuing, got %q", row.Status)
	}
}

// TestPostCert_RejectsBadChallenge: challenge_type not in allowed enum → 400.
func TestPostCert_RejectsBadChallenge(t *testing.T) {
	deps := newRouteDeps(t)
	b, _ := json.Marshal(map[string]any{
		"domain":         "bad.example.com",
		"challenge_type": "invalid-challenge",
		"email":          "admin@example.com",
	})
	req := httptest.NewRequest("POST", "/certificates", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	postCertHandler(deps)(rr, req)

	if rr.Code != 400 {
		t.Fatalf("want 400, got %d: %s", rr.Code, rr.Body)
	}
}

// TestGetCerts_RedactsPEMs: response contains domain/status/etc but NOT cert_pem/key_pem.
func TestGetCerts_RedactsPEMs(t *testing.T) {
	deps := newRouteDeps(t)
	cs := &CertStore{DB: deps.DB}

	_, err := cs.Insert(context.Background(), CertRow{
		Domain:    "redact.example.com",
		CertPEM:   "SECRET_CERT_PEM",
		KeyPEM:    "SECRET_KEY_PEM",
		ExpiresAt: time.Now().Add(90 * 24 * time.Hour),
		Status:    "active",
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}

	req := httptest.NewRequest("GET", "/certificates", nil)
	rr := httptest.NewRecorder()
	getCertsHandler(deps)(rr, req)

	if rr.Code != 200 {
		t.Fatalf("want 200, got %d: %s", rr.Code, rr.Body)
	}

	body := rr.Body.String()
	if strings.Contains(body, "SECRET_CERT_PEM") {
		t.Error("cert_pem must be redacted from GET /certificates response")
	}
	if strings.Contains(body, "SECRET_KEY_PEM") {
		t.Error("key_pem must be redacted from GET /certificates response")
	}
	if !strings.Contains(body, "redact.example.com") {
		t.Error("domain missing from response")
	}
	if !strings.Contains(body, "active") {
		t.Error("status missing from response")
	}
}

// TestDeleteCert_BlockedWhenInUse: seed inbound referencing cert; delete → 409.
func TestDeleteCert_BlockedWhenInUse(t *testing.T) {
	deps := newRouteDeps(t)
	cs := &CertStore{DB: deps.DB}

	certID, err := cs.Insert(context.Background(), CertRow{
		Domain:    "inuse.example.com",
		CertPEM:   "C",
		KeyPEM:    "K",
		ExpiresAt: time.Now().Add(90 * 24 * time.Hour),
		Status:    "active",
	})
	if err != nil {
		t.Fatalf("insert cert: %v", err)
	}

	// Insert inbound referencing cert (FK RESTRICT).
	deps.DB.MustExec(`INSERT INTO singbox_inbounds
		(server_id,tag,port,role,protocol,cert_id,updated_at)
		VALUES (1,'landing-cert1',8443,'landing','trojan-tls',?,?)`, certID, time.Now())

	req := httptest.NewRequest("DELETE", fmt.Sprintf("/certificates/%d", certID), nil)
	req.SetPathValue("id", fmt.Sprint(certID))
	rr := httptest.NewRecorder()
	deleteCertHandler(deps)(rr, req)

	if rr.Code != 409 {
		t.Fatalf("want 409, got %d: %s", rr.Code, rr.Body)
	}
}

// TestPostRenew_TriggersRenewal: override renewFunc to record call, verify it fires.
func TestPostRenew_TriggersRenewal(t *testing.T) {
	deps := newRouteDeps(t)
	cs := &CertStore{DB: deps.DB}

	certID, err := cs.Insert(context.Background(), CertRow{
		Domain:    "renew.example.com",
		CertPEM:   "C",
		KeyPEM:    "K",
		ExpiresAt: time.Now().Add(90 * 24 * time.Hour),
		Status:    "active",
	})
	if err != nil {
		t.Fatalf("insert cert: %v", err)
	}

	called := make(chan int64, 1)
	origRenew := renewFunc
	renewFunc = func(_ context.Context, id int64, _, _, _ string) error {
		called <- id
		return nil
	}
	defer func() { renewFunc = origRenew }()

	req := httptest.NewRequest("POST", fmt.Sprintf("/certificates/%d/renew", certID), nil)
	req.SetPathValue("id", fmt.Sprint(certID))
	rr := httptest.NewRecorder()
	postCertRenewHandler(deps)(rr, req)

	if rr.Code != 202 {
		t.Fatalf("want 202, got %d: %s", rr.Code, rr.Body)
	}

	select {
	case gotID := <-called:
		if gotID != certID {
			t.Errorf("renewFunc called with certID=%d, want %d", gotID, certID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("renewFunc not called within 2s")
	}
}

// collectSingboxMux records HandleFunc calls for route registration tests.
type collectSingboxMux struct {
	handlers map[string]http.HandlerFunc
}

func (m *collectSingboxMux) HandleFunc(pat string, h func(http.ResponseWriter, *http.Request)) {
	if m.handlers == nil {
		m.handlers = map[string]http.HandlerFunc{}
	}
	m.handlers[pat] = h
}
func (m *collectSingboxMux) Handle(string, http.Handler) {}
