// Package certmgr wraps go-acme/lego to issue and renew TLS certificates
// for sing-box inbounds. Certificates are persisted via the Store interface;
// the file push to hosts is done by the deploy layer (outside this package).
package certmgr

import (
	"context"
	"crypto"
	"fmt"
	"time"

	"github.com/go-acme/lego/v4/certcrypto"
	"github.com/go-acme/lego/v4/certificate"
	"github.com/go-acme/lego/v4/challenge/http01"
	"github.com/go-acme/lego/v4/lego"
	"github.com/go-acme/lego/v4/providers/dns/cloudflare"
	legoreg "github.com/go-acme/lego/v4/registration"
)

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// ChallengeType selects the ACME challenge mechanism.
type ChallengeType int

const (
	// HTTP01 uses the HTTP-01 challenge (port 80 must be reachable).
	HTTP01 ChallengeType = iota
	// DNS01CF uses DNS-01 via the Cloudflare API.
	DNS01CF
)

// CFTokenProvider fetches the Cloudflare API token at issuance time.
// The implementation lives in the wiring layer (outside certmgr) so that
// certmgr does not import the cloudflare plugin package directly.
type CFTokenProvider interface {
	Token(ctx context.Context) (string, error)
}

// Issuer is the certificate-issuance interface.
// The production implementation wraps go-acme/lego; tests inject a fake.
type Issuer interface {
	Obtain(ctx context.Context, domain string, challenge ChallengeType, cfToken string, email string) (certPEM []byte, keyPEM []byte, expiresAt time.Time, err error)
}

// Store is the subset of the singbox CertStore that certmgr needs.
type Store interface {
	UpsertCert(ctx context.Context, id int64, certPEM, keyPEM string, expiresAt time.Time) error
	UpsertStatus(ctx context.Context, id int64, status string, lastErr *string) error
	ListExpiringSoon(ctx context.Context, within time.Duration) ([]RenewalTarget, error)
}

// RenewalTarget is a cert row that needs renewal (returned by ListExpiringSoon).
type RenewalTarget struct {
	ID        int64
	Domain    string
	Challenge ChallengeType
}

// UpsertCertCall records one UpsertCert call (used in tests).
type UpsertCertCall struct {
	ID        int64
	CertPEM   string
	KeyPEM    string
	ExpiresAt time.Time
}

// UpsertStatusCall records one UpsertStatus call (used in tests).
type UpsertStatusCall struct {
	ID      int64
	Status  string
	LastErr *string
}

// Config is the dependency bundle for NewManager.
type Config struct {
	Store           Store
	Issuer          Issuer          // if nil, legoIssuer is used
	CFTokenProvider CFTokenProvider // required when DNS01CF may be used
	Email           string          // ACME account email
	HTTP01ListenAddr string         // e.g. ":80"; default ":80"
	CADirectoryURL  string          // override for staging / tests
}

// Manager issues and renews TLS certificates.
type Manager struct {
	cfg    Config
	issuer Issuer
}

// NewManager creates a Manager with the given config.
// If cfg.Issuer is nil the real lego-backed issuer is used.
func NewManager(cfg Config) *Manager {
	m := &Manager{cfg: cfg}
	if cfg.Issuer != nil {
		m.issuer = cfg.Issuer
	} else {
		m.issuer = &legoIssuer{cfg: cfg}
	}
	return m
}

// Issue requests a new certificate for domain using the given challenge type
// and stores the PEM pair via the Store interface against certID. The row
// must already exist in singbox_certificates (the route handler creates it
// with status='issuing' before kicking off async Issue).
//
// On any failure path Issue calls UpsertStatus(certID, "failed", &errMsg)
// so the UI can surface the reason — this is what makes the "no info"
// case visible. Pre-fix, certID was hardcoded to 0 and the row was
// never updated.
func (m *Manager) Issue(ctx context.Context, certID int64, domain string, challenge ChallengeType) error {
	// Validate CF token before touching the issuer. Pre-issuer failures
	// (missing token, bad provider) get reflected to the DB row too.
	var cfToken string
	if challenge == DNS01CF {
		if m.cfg.CFTokenProvider == nil {
			return m.fail(ctx, certID, domain, fmt.Errorf("DNS01CF challenge requires a CFTokenProvider"))
		}
		tok, err := m.cfg.CFTokenProvider.Token(ctx)
		if err != nil {
			return m.fail(ctx, certID, domain, fmt.Errorf("fetch CF token: %w", err))
		}
		if tok == "" {
			return m.fail(ctx, certID, domain, fmt.Errorf("DNS01CF challenge requires a non-empty Cloudflare API token (enable & configure the cloudflare plugin)"))
		}
		cfToken = tok
	}

	certPEM, keyPEM, expiresAt, err := m.issuer.Obtain(ctx, domain, challenge, cfToken, m.cfg.Email)
	if err != nil {
		return m.fail(ctx, certID, domain, fmt.Errorf("obtain: %w", err))
	}

	if err := m.cfg.Store.UpsertCert(ctx, certID, string(certPEM), string(keyPEM), expiresAt); err != nil {
		return m.fail(ctx, certID, domain, fmt.Errorf("store cert: %w", err))
	}
	return nil
}

// fail records a failure against the cert row and returns the wrapped error.
// Used by every error path in Issue so last_error is always populated.
func (m *Manager) fail(ctx context.Context, certID int64, domain string, err error) error {
	msg := err.Error()
	_ = m.cfg.Store.UpsertStatus(ctx, certID, "failed", &msg)
	return fmt.Errorf("certmgr: issue %s: %w", domain, err)
}

// Renew re-issues the certificate identified by certID / domain.
// It delegates to Issue which updates the existing DB row.
func (m *Manager) Renew(ctx context.Context, certID int64, domain string, challenge ChallengeType) error {
	return m.Issue(ctx, certID, domain, challenge)
}

// RunRenewalLoop starts a blocking renewal loop that ticks every interval.
// On each tick it calls Store.ListExpiringSoon(30 days) and renews each cert.
// Cancel ctx to stop the loop.
func (m *Manager) RunRenewalLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			targets, err := m.cfg.Store.ListExpiringSoon(ctx, 30*24*time.Hour)
			if err != nil {
				continue
			}
			for _, t := range targets {
				_ = m.Renew(ctx, t.ID, t.Domain, t.Challenge)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// legoIssuer — production implementation
// ---------------------------------------------------------------------------

// legoIssuer wraps go-acme/lego to issue real ACME certificates.
// It is not exercised in unit tests (fakeIssuer is used instead).
type legoIssuer struct {
	cfg Config
}

func (l *legoIssuer) Obtain(ctx context.Context, domain string, challenge ChallengeType, cfToken string, email string) ([]byte, []byte, time.Time, error) {
	// Generate a throw-away ECDSA P-256 key for the ACME account.
	// TODO(shepherd §7.7): persist account key in plugin config JSON blob.
	accountKey, err := certcrypto.GeneratePrivateKey(certcrypto.EC256)
	if err != nil {
		return nil, nil, time.Time{}, fmt.Errorf("gen account key: %w", err)
	}

	user := &acmeUser{email: email, key: accountKey}
	legoConfig := lego.NewConfig(user)
	if l.cfg.CADirectoryURL != "" {
		legoConfig.CADirURL = l.cfg.CADirectoryURL
	}
	legoConfig.Certificate.KeyType = certcrypto.EC256

	client, err := lego.NewClient(legoConfig)
	if err != nil {
		return nil, nil, time.Time{}, fmt.Errorf("lego client: %w", err)
	}

	switch challenge {
	case DNS01CF:
		cfCfg := cloudflare.NewDefaultConfig()
		cfCfg.AuthToken = cfToken
		provider, pErr := cloudflare.NewDNSProviderConfig(cfCfg)
		if pErr != nil {
			return nil, nil, time.Time{}, fmt.Errorf("cloudflare provider: %w", pErr)
		}
		if sErr := client.Challenge.SetDNS01Provider(provider); sErr != nil {
			return nil, nil, time.Time{}, sErr
		}
	case HTTP01:
		addr := l.cfg.HTTP01ListenAddr
		if addr == "" {
			addr = ":80"
		}
		// http01.NewProviderServer takes (iface, port) as separate args.
		// Parse the addr to split them.
		host, port := splitHostPort(addr)
		if sErr := client.Challenge.SetHTTP01Provider(http01.NewProviderServer(host, port)); sErr != nil {
			return nil, nil, time.Time{}, sErr
		}
	default:
		return nil, nil, time.Time{}, fmt.Errorf("unknown challenge %v", challenge)
	}

	// Register ACME account.
	reg, err := client.Registration.Register(legoreg.RegisterOptions{TermsOfServiceAgreed: true})
	if err != nil {
		return nil, nil, time.Time{}, fmt.Errorf("register: %w", err)
	}
	user.reg = reg

	// Obtain the certificate.
	req := certificate.ObtainRequest{Domains: []string{domain}, Bundle: true}
	res, err := client.Certificate.Obtain(req)
	if err != nil {
		return nil, nil, time.Time{}, fmt.Errorf("obtain: %w", err)
	}

	// Parse expiry from the leaf certificate.
	exp := time.Now().Add(90 * 24 * time.Hour) // safe fallback
	if certs, pErr := certcrypto.ParsePEMBundle(res.Certificate); pErr == nil && len(certs) > 0 {
		exp = certs[0].NotAfter
	}

	return res.Certificate, res.PrivateKey, exp, nil
}

// splitHostPort splits "host:port" or ":port" into host and port strings.
// Returns empty host if not present.
func splitHostPort(addr string) (host, port string) {
	for i := len(addr) - 1; i >= 0; i-- {
		if addr[i] == ':' {
			return addr[:i], addr[i+1:]
		}
	}
	return addr, ""
}

// acmeUser satisfies lego's registration.User interface.
type acmeUser struct {
	email string
	key   crypto.PrivateKey
	reg   *legoreg.Resource
}

func (u *acmeUser) GetEmail() string                   { return u.email }
func (u *acmeUser) GetRegistration() *legoreg.Resource { return u.reg }
func (u *acmeUser) GetPrivateKey() crypto.PrivateKey   { return u.key }
