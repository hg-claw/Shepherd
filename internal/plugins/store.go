package plugins

import (
	"context"
	"database/sql"
	"time"

	"github.com/jmoiron/sqlx"
)

type Store struct {
	DB  *sqlx.DB
	Now func() time.Time
}

type Row struct {
	ID         string         `db:"id"`
	Enabled    bool           `db:"enabled"`
	ConfigJSON []byte         `db:"config_json"`
	EnabledAt  sql.NullTime   `db:"enabled_at"`
	CreatedAt  time.Time      `db:"created_at"`
}

type HostRow struct {
	ID              int64          `db:"id"`
	PluginID        string         `db:"plugin_id"`
	ServerID        int64          `db:"server_id"`
	ConfigJSON      []byte         `db:"config_json"`
	DeployedVersion sql.NullString `db:"deployed_version"`
	Status          string         `db:"status"`
	LastError       sql.NullString `db:"last_error"`
	UpdatedAt       time.Time      `db:"updated_at"`
}

func (s *Store) Get(ctx context.Context, id string) (Row, error) {
	var r Row
	err := s.DB.GetContext(ctx, &r,
		"SELECT id, enabled, config_json, enabled_at, created_at FROM plugins WHERE id=$1", id)
	return r, err
}

// UpsertEnabled creates the plugin row if absent, then sets enabled flag.
// enabled_at is set on transitions to enabled.
func (s *Store) UpsertEnabled(ctx context.Context, id string, enabled bool) error {
	now := s.Now().UTC()
	// Portability: `excluded.enabled=1` worked on sqlite (INTEGER 0/1) but
	// postgres rejects it as a type mismatch (the column is BOOLEAN there).
	// Bare `excluded.enabled` is truthy on both — POST /api/admin/plugins/
	// {id}/enable was 500ing on postgres deployments because of this.
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO plugins(id, enabled, config_json, enabled_at, created_at)
		 VALUES ($1, $2, '{}', $3, $4)
		 ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,
		   enabled_at=CASE WHEN excluded.enabled THEN excluded.enabled_at ELSE NULL END`,
		id, enabled, nullableTime(enabled, now), now)
	return err
}

func nullableTime(enabled bool, t time.Time) any {
	if enabled {
		return t
	}
	return nil
}

func (s *Store) PutConfig(ctx context.Context, id string, configJSON []byte) error {
	_, err := s.DB.ExecContext(ctx, "UPDATE plugins SET config_json=$1 WHERE id=$2", string(configJSON), id)
	return err
}

func (s *Store) UpsertHost(ctx context.Context, pluginID string, serverID int64, configJSON []byte, status string) (HostRow, error) {
	now := s.Now().UTC()
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO plugin_hosts(plugin_id, server_id, config_json, status, updated_at)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT(plugin_id, server_id) DO UPDATE SET
		   config_json=excluded.config_json,
		   status=excluded.status,
		   updated_at=excluded.updated_at,
		   last_error=NULL`,
		pluginID, serverID, string(configJSON), status, now)
	if err != nil {
		return HostRow{}, err
	}
	return s.GetHost(ctx, pluginID, serverID)
}

func (s *Store) GetHost(ctx context.Context, pluginID string, serverID int64) (HostRow, error) {
	var r HostRow
	err := s.DB.GetContext(ctx, &r,
		`SELECT id, plugin_id, server_id, config_json, deployed_version, status, last_error, updated_at
		 FROM plugin_hosts WHERE plugin_id=$1 AND server_id=$2`, pluginID, serverID)
	return r, err
}

func (s *Store) ListHosts(ctx context.Context, pluginID string) ([]HostRow, error) {
	var rows []HostRow
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT id, plugin_id, server_id, config_json, deployed_version, status, last_error, updated_at
		 FROM plugin_hosts WHERE plugin_id=$1 ORDER BY server_id`, pluginID)
	return rows, err
}

func (s *Store) DeleteHost(ctx context.Context, pluginID string, serverID int64) error {
	_, err := s.DB.ExecContext(ctx,
		"DELETE FROM plugin_hosts WHERE plugin_id=$1 AND server_id=$2", pluginID, serverID)
	return err
}

func (s *Store) SetHostStatus(ctx context.Context, pluginID string, serverID int64, status, version, lastErr string) error {
	now := s.Now().UTC()
	_, err := s.DB.ExecContext(ctx,
		`UPDATE plugin_hosts
		 SET status=$1,
		     deployed_version=CASE WHEN $2 = '' THEN deployed_version ELSE $2 END,
		     last_error=NULLIF($3, ''),
		     updated_at=$4
		 WHERE plugin_id=$5 AND server_id=$6`,
		status, version, lastErr, now, pluginID, serverID)
	return err
}

func (s *Store) HostCountByPlugin(ctx context.Context) (map[string]int, error) {
	rows, err := s.DB.QueryxContext(ctx,
		"SELECT plugin_id, COUNT(*) FROM plugin_hosts GROUP BY plugin_id")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]int{}
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}
