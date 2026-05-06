package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"time"

	"github.com/jmoiron/sqlx"
)

const SessionTTL = 30 * 24 * time.Hour

var ErrInvalidSession = errors.New("invalid session")

type Session struct {
	Token     string    `db:"token"`
	AdminID   int64     `db:"admin_id"`
	ExpiresAt time.Time `db:"expires_at"`
	CreatedAt time.Time `db:"created_at"`
}

type Admin struct {
	ID           int64     `db:"id"`
	Username     string    `db:"username"`
	PasswordHash string    `db:"password_hash"`
	CreatedAt    time.Time `db:"created_at"`
}

type Store struct {
	DB *sqlx.DB
}

func (s *Store) FindAdminByUsername(ctx context.Context, username string) (*Admin, error) {
	var a Admin
	if err := s.DB.GetContext(ctx, &a, "SELECT id, username, password_hash, created_at FROM admins WHERE username=$1", username); err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Store) CreateAdmin(ctx context.Context, username, plainPassword string) (*Admin, error) {
	hash, err := HashPassword(plainPassword)
	if err != nil {
		return nil, err
	}
	res, err := s.DB.ExecContext(ctx, "INSERT INTO admins(username, password_hash) VALUES ($1, $2)", username, hash)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Admin{ID: id, Username: username, PasswordHash: hash, CreatedAt: time.Now()}, nil
}

func (s *Store) IssueSession(ctx context.Context, adminID int64) (*Session, error) {
	tok, err := randomToken(32)
	if err != nil {
		return nil, err
	}
	exp := time.Now().Add(SessionTTL)
	if _, err := s.DB.ExecContext(ctx, "INSERT INTO sessions(token, admin_id, expires_at) VALUES ($1, $2, $3)", tok, adminID, exp); err != nil {
		return nil, err
	}
	return &Session{Token: tok, AdminID: adminID, ExpiresAt: exp, CreatedAt: time.Now()}, nil
}

func (s *Store) LookupSession(ctx context.Context, token string) (*Session, *Admin, error) {
	var sess Session
	if err := s.DB.GetContext(ctx, &sess, "SELECT token, admin_id, expires_at, created_at FROM sessions WHERE token=$1", token); err != nil {
		return nil, nil, ErrInvalidSession
	}
	if time.Now().After(sess.ExpiresAt) {
		return nil, nil, ErrInvalidSession
	}
	var a Admin
	if err := s.DB.GetContext(ctx, &a, "SELECT id, username, password_hash, created_at FROM admins WHERE id=$1", sess.AdminID); err != nil {
		return nil, nil, ErrInvalidSession
	}
	return &sess, &a, nil
}

func (s *Store) RevokeSession(ctx context.Context, token string) error {
	_, err := s.DB.ExecContext(ctx, "DELETE FROM sessions WHERE token=$1", token)
	return err
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
