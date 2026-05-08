package serversvc

import (
	"context"
	"strconv"
	"strings"

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

func (s *SettingsStore) GetBool(ctx context.Context, key string, def bool) bool {
	v, err := s.Get(ctx, key)
	if err != nil {
		return def
	}
	return v == "true" || v == "1"
}

func (s *SettingsStore) GetInt(ctx context.Context, key string, def int) int {
	v, err := s.Get(ctx, key)
	if err != nil {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func (s *SettingsStore) GetLines(ctx context.Context, key string) []string {
	v, _ := s.Get(ctx, key)
	if v == "" {
		return nil
	}
	parts := strings.Split(v, "\n")
	out := parts[:0]
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
