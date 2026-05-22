package xray

import (
	"context"
	"database/sql"
	"time"

	"github.com/jmoiron/sqlx"
)

// Topology is the on-disk row.
type Topology struct {
	ServerID         int64         `db:"server_id"`
	Role             string        `db:"role"` // "landing" | "relay"
	UpstreamServerID sql.NullInt64 `db:"upstream_server_id"`
	UpdatedAt        time.Time     `db:"updated_at"`
}

// TopologyView extends Topology with the upstream landing's server name
// (NULL for landings; populated for relays via servers.name JOIN).
type TopologyView struct {
	Topology
	UpstreamName sql.NullString `db:"upstream_name"`
}

type TopologyStore struct {
	DB  *sqlx.DB
	Now func() time.Time
}

func (s *TopologyStore) now() time.Time {
	if s.Now == nil { return time.Now().UTC() }
	return s.Now().UTC()
}

// Get returns ErrNoRows when no row exists for serverID.
func (s *TopologyStore) Get(ctx context.Context, serverID int64) (Topology, error) {
	var t Topology
	err := s.DB.GetContext(ctx, &t,
		`SELECT server_id, role, upstream_server_id, updated_at
		 FROM xray_host_topology WHERE server_id=$1`, serverID)
	return t, err
}

func (s *TopologyStore) UpsertLanding(ctx context.Context, serverID int64) error {
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO xray_host_topology(server_id, role, upstream_server_id, updated_at)
		 VALUES ($1, 'landing', NULL, $2)
		 ON CONFLICT(server_id) DO UPDATE SET
		   role='landing', upstream_server_id=NULL, updated_at=excluded.updated_at`,
		serverID, s.now())
	return err
}

func (s *TopologyStore) UpsertRelay(ctx context.Context, serverID, upstreamServerID int64) error {
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO xray_host_topology(server_id, role, upstream_server_id, updated_at)
		 VALUES ($1, 'relay', $2, $3)
		 ON CONFLICT(server_id) DO UPDATE SET
		   role='relay', upstream_server_id=excluded.upstream_server_id,
		   updated_at=excluded.updated_at`,
		serverID, upstreamServerID, s.now())
	return err
}

// Delete removes a topology row. FK RESTRICT on upstream_server_id will
// return an error if other relays still point to this server.
func (s *TopologyStore) Delete(ctx context.Context, serverID int64) error {
	_, err := s.DB.ExecContext(ctx,
		`DELETE FROM xray_host_topology WHERE server_id=$1`, serverID)
	return err
}

func (s *TopologyStore) ListByUpstream(ctx context.Context, upstreamServerID int64) ([]Topology, error) {
	rows := []Topology{}
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT server_id, role, upstream_server_id, updated_at
		 FROM xray_host_topology WHERE upstream_server_id=$1`, upstreamServerID)
	return rows, err
}

func (s *TopologyStore) ListWithUpstreamName(ctx context.Context) ([]TopologyView, error) {
	rows := []TopologyView{}
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT t.server_id, t.role, t.upstream_server_id, t.updated_at,
		        up.name AS upstream_name
		 FROM xray_host_topology t
		 LEFT JOIN servers up ON up.id = t.upstream_server_id`)
	return rows, err
}
