package singbox

import (
	"context"
	"time"

	"github.com/jmoiron/sqlx"
)

// CertRow maps singbox_certificates.
type CertRow struct {
	ID                  int64      `db:"id"`
	Domain              string     `db:"domain"`
	CertPEM             string     `db:"cert_pem"`
	KeyPEM              string     `db:"key_pem"`
	ExpiresAt           time.Time  `db:"expires_at"`
	Issuer              string     `db:"issuer"`
	Status              string     `db:"status"`
	ChallengeType       string     `db:"challenge_type"`
	LastRenewAttemptAt  *time.Time `db:"last_renew_attempt_at"`
	LastError           *string    `db:"last_error"`
	CreatedAt           time.Time  `db:"created_at"`
	UpdatedAt           time.Time  `db:"updated_at"`
}

// CertView is the read projection used by the renderer (subset of CertRow).
type CertView struct {
	ID      int64  `db:"id"`
	Domain  string `db:"domain"`
	CertPEM string `db:"cert_pem"`
	KeyPEM  string `db:"key_pem"`
}

type CertStore struct {
	DB  *sqlx.DB
	Now func() time.Time
}

func (s *CertStore) now() time.Time {
	if s.Now == nil {
		return time.Now().UTC()
	}
	return s.Now().UTC()
}

func (s *CertStore) Insert(ctx context.Context, row CertRow) (int64, error) {
	now := s.now()
	if row.Issuer == "" {
		row.Issuer = "Let's Encrypt"
	}
	if row.ChallengeType == "" {
		row.ChallengeType = "http-01"
	}
	var id int64
	if err := s.DB.QueryRowxContext(ctx, `
		INSERT INTO singbox_certificates
		  (domain, cert_pem, key_pem, expires_at, issuer, status, challenge_type, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
		row.Domain, row.CertPEM, row.KeyPEM, row.ExpiresAt,
		row.Issuer, row.Status, row.ChallengeType, now, now).Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}

func (s *CertStore) Get(ctx context.Context, id int64) (CertRow, error) {
	var row CertRow
	err := s.DB.GetContext(ctx, &row, `SELECT * FROM singbox_certificates WHERE id=$1`, id)
	return row, err
}

func (s *CertStore) GetByDomain(ctx context.Context, domain string) (CertRow, error) {
	var row CertRow
	err := s.DB.GetContext(ctx, &row,
		`SELECT * FROM singbox_certificates WHERE domain=$1`, domain)
	return row, err
}

func (s *CertStore) List(ctx context.Context) ([]CertRow, error) {
	var rows []CertRow
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT * FROM singbox_certificates ORDER BY domain`)
	return rows, err
}

// UpsertStatus updates status and optionally last_error (nil clears it).
func (s *CertStore) UpsertStatus(ctx context.Context, id int64, status string, lastErr *string) error {
	now := s.now()
	_, err := s.DB.ExecContext(ctx,
		`UPDATE singbox_certificates
		 SET status=$1, last_error=$2, last_renew_attempt_at=$3, updated_at=$4
		 WHERE id=$5`,
		status, lastErr, now, now, id)
	return err
}

// UpsertCert stores the full cert + key PEM and marks status='active'.
func (s *CertStore) UpsertCert(ctx context.Context, id int64, certPEM, keyPEM string, expiresAt time.Time) error {
	now := s.now()
	_, err := s.DB.ExecContext(ctx,
		`UPDATE singbox_certificates
		 SET cert_pem=$1, key_pem=$2, expires_at=$3, status='active',
		     last_renew_attempt_at=$4, last_error=NULL, updated_at=$5
		 WHERE id=$6`,
		certPEM, keyPEM, expiresAt, now, now, id)
	return err
}

// Delete removes the cert row. FK RESTRICT on singbox_inbounds.cert_id will
// surface as an error if any inbound references this cert.
func (s *CertStore) Delete(ctx context.Context, id int64) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM singbox_certificates WHERE id=$1`, id)
	return err
}

// ListExpiringSoon returns certs expiring within withinDays days from now.
func (s *CertStore) ListExpiringSoon(ctx context.Context, withinDays int) ([]CertRow, error) {
	var rows []CertRow
	now := s.now()
	deadline := now.AddDate(0, 0, withinDays)
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT * FROM singbox_certificates
		 WHERE expires_at <= $1 AND status='active'
		 ORDER BY expires_at ASC`, deadline)
	return rows, err
}

// GetViewsByIDs returns CertView for the given set of cert IDs (for the renderer).
func (s *CertStore) GetViewsByIDs(ctx context.Context, ids []int64) ([]CertView, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	query, args, err := sqlx.In(
		`SELECT id, domain, cert_pem, key_pem FROM singbox_certificates WHERE id IN (?)`, ids)
	if err != nil {
		return nil, err
	}
	var rows []CertView
	err = s.DB.SelectContext(ctx, &rows, s.DB.Rebind(query), args...)
	return rows, err
}
