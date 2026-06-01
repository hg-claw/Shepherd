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

// Delete removes a topology row. FK RESTRICT on upstream_server_id will
// return an error if other relays still point to this server.
func (s *TopologyStore) Delete(ctx context.Context, serverID int64) error {
	_, err := s.DB.ExecContext(ctx,
		`DELETE FROM xray_host_topology WHERE server_id=$1`, serverID)
	return err
}
