package agentsvc

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"time"

	"github.com/jmoiron/sqlx"
)

const EnrollmentTokenTTL = 60 * time.Minute

var (
	ErrInvalidEnrollment = errors.New("invalid enrollment token")
	ErrFingerprintInUse  = errors.New("fingerprint already registered")
)

type Service struct {
	DB             *sqlx.DB
	AutoRecoverKey string // optional global key; empty = auto-register disabled
}

// IssueEnrollmentToken creates a one-shot token bound to serverID.
func (s *Service) IssueEnrollmentToken(ctx context.Context, serverID int64) (string, time.Time, error) {
	tok, err := randomToken(24)
	if err != nil {
		return "", time.Time{}, err
	}
	exp := time.Now().Add(EnrollmentTokenTTL)
	if _, err := s.DB.ExecContext(ctx, `INSERT INTO enrollment_tokens(token, server_id, expires_at) VALUES ($1,$2,$3)`,
		tok, serverID, exp); err != nil {
		return "", time.Time{}, err
	}
	return tok, exp, nil
}

// RedeemEnrollment consumes an enrollment token, mints a machine token,
// and persists the agent identity onto the bound server. Returns machine_token, server_id.
// cands (may be nil) are upserted into server_ip_candidates; the best public IP
// is written to servers.ssh_host when it is currently empty.
func (s *Service) RedeemEnrollment(ctx context.Context, enrollmentToken, fingerprint, osName, arch, kernel, agentVersion string, cands []IPCandidate) (string, int64, error) {
	tx, err := s.DB.BeginTxx(ctx, nil)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = tx.Rollback() }()

	var (
		serverID   int64
		expiresAt  time.Time
		consumedAt sql.NullTime
	)
	err = tx.QueryRowxContext(ctx,
		"SELECT server_id, expires_at, consumed_at FROM enrollment_tokens WHERE token=$1",
		enrollmentToken).Scan(&serverID, &expiresAt, &consumedAt)
	if err != nil {
		return "", 0, ErrInvalidEnrollment
	}
	if consumedAt.Valid || time.Now().After(expiresAt) {
		return "", 0, ErrInvalidEnrollment
	}

	// Reject if another server already owns this fingerprint.
	var other int64
	err = tx.QueryRowxContext(ctx, "SELECT id FROM servers WHERE agent_fingerprint=$1 AND id<>$2", fingerprint, serverID).Scan(&other)
	if err == nil {
		return "", 0, ErrFingerprintInUse
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", 0, err
	}

	machine, err := randomToken(32)
	if err != nil {
		return "", 0, err
	}
	if _, err := tx.ExecContext(ctx,
		"INSERT INTO machine_tokens(token, server_id) VALUES ($1, $2)", machine, serverID); err != nil {
		return "", 0, err
	}
	if _, err := tx.ExecContext(ctx,
		"UPDATE enrollment_tokens SET consumed_at=CURRENT_TIMESTAMP WHERE token=$1", enrollmentToken); err != nil {
		return "", 0, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE servers SET
			agent_fingerprint=$1, agent_os=$2, agent_arch=$3, agent_kernel=$4, agent_version=$5
			WHERE id=$6`,
		fingerprint, osName, arch, kernel, agentVersion, serverID); err != nil {
		return "", 0, err
	}
	if err := tx.Commit(); err != nil {
		return "", 0, err
	}

	// Persist IP candidates and auto-pick ssh_host outside the tx (best-effort).
	if len(cands) > 0 {
		_ = SaveCandidates(ctx, s.DB, serverID, cands)
		_ = ApplyBestSSHHost(ctx, s.DB, serverID, cands)
	}

	return machine, serverID, nil
}

// AuthenticateMachineToken returns server_id for a valid machine_token, or error.
func (s *Service) AuthenticateMachineToken(ctx context.Context, token string) (int64, error) {
	var sid int64
	if err := s.DB.GetContext(ctx, &sid, "SELECT server_id FROM machine_tokens WHERE token=$1", token); err != nil {
		return 0, ErrInvalidEnrollment
	}
	return sid, nil
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
