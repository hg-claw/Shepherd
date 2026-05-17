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
		"SELECT id, enabled, config_json, enabled_at, created_at FROM plugins WHERE id=?", id)
	return r, err
}

// UpsertEnabled creates the plugin row if absent, then sets enabled flag.
// enabled_at is set on transitions to enabled.
func (s *Store) UpsertEnabled(ctx context.Context, id string, enabled bool) error {
	now := s.Now().UTC()
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO plugins(id, enabled, config_json, enabled_at, created_at)
		 VALUES (?, ?, '{}', ?, ?)
		 ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,
		   enabled_at=CASE WHEN excluded.enabled=1 THEN excluded.enabled_at ELSE NULL END`,
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
	_, err := s.DB.ExecContext(ctx, "UPDATE plugins SET config_json=? WHERE id=?", string(configJSON), id)
	return err
}

func (s *Store) UpsertHost(ctx context.Context, pluginID string, serverID int64, configJSON []byte, status string) (HostRow, error) {
	now := s.Now().UTC()
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO plugin_hosts(plugin_id, server_id, config_json, status, updated_at)
		 VALUES (?, ?, ?, ?, ?)
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
		 FROM plugin_hosts WHERE plugin_id=? AND server_id=?`, pluginID, serverID)
	return r, err
}

func (s *Store) ListHosts(ctx context.Context, pluginID string) ([]HostRow, error) {
	var rows []HostRow
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT id, plugin_id, server_id, config_json, deployed_version, status, last_error, updated_at
		 FROM plugin_hosts WHERE plugin_id=? ORDER BY server_id`, pluginID)
	return rows, err
}

func (s *Store) DeleteHost(ctx context.Context, pluginID string, serverID int64) error {
	_, err := s.DB.ExecContext(ctx,
		"DELETE FROM plugin_hosts WHERE plugin_id=? AND server_id=?", pluginID, serverID)
	return err
}

func (s *Store) SetHostStatus(ctx context.Context, pluginID string, serverID int64, status, version, lastErr string) error {
	now := s.Now().UTC()
	_, err := s.DB.ExecContext(ctx,
		`UPDATE plugin_hosts
		 SET status=?, deployed_version=NULLIF(?, ''), last_error=NULLIF(?, ''), updated_at=?
		 WHERE plugin_id=? AND server_id=?`,
		status, version, lastErr, now, pluginID, serverID)
	return err
}

func (s *Store) HostCountByPlugin(ctx context.Context) (map[string]int, error) {
	rows, err := s.DB.QueryxContext(ctx,
		"SELECT plugin_id, COUNT(*) FROM plugin_hosts GROUP BY plugin_id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
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
