package serversvc

import (
	"context"

	"github.com/jmoiron/sqlx"
)

type SettingsStore struct {
	DB *sqlx.DB
}

func (s *SettingsStore) GetAll(ctx context.Context) (map[string]string, error) {
	rows, err := s.DB.QueryContext(ctx, "SELECT key, value FROM settings")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

func (s *SettingsStore) Get(ctx context.Context, key string) (string, error) {
	var v string
	if err := s.DB.GetContext(ctx, &v, "SELECT value FROM settings WHERE key=$1", key); err != nil {
		return "", err
	}
	return v, nil
}

func (s *SettingsStore) Set(ctx context.Context, key, value string) error {
	// Postgres UPSERT and SQLite UPSERT both accept ON CONFLICT.
	_, err := s.DB.ExecContext(ctx,
		"INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
		key, value)
	return err
}
