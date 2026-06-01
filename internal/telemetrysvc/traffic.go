package telemetrysvc

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/jmoiron/sqlx"
)

// HostTrafficRow is one server's cumulative-traffic state.
type HostTrafficRow struct {
	ServerID      int64      `db:"server_id"       json:"server_id"`
	CumBytesUp    int64      `db:"cum_bytes_up"    json:"cum_bytes_up"`
	CumBytesDown  int64      `db:"cum_bytes_down"  json:"cum_bytes_down"`
	PrevBytesUp   int64      `db:"prev_bytes_up"   json:"prev_bytes_up"`
	PrevBytesDown int64      `db:"prev_bytes_down" json:"prev_bytes_down"`
	ResetDay      int        `db:"reset_day"       json:"reset_day"`
	LastResetAt   *time.Time `db:"last_reset_at"   json:"last_reset_at"`
}

// lastResetBoundary returns the most recent "resetDay 00:00:00 in loc" instant
// that is <= now. resetDay is 1..28 so it always exists (no month-length clamp).
func lastResetBoundary(now time.Time, resetDay int, loc *time.Location) time.Time {
	n := now.In(loc)
	thisMonth := time.Date(n.Year(), n.Month(), resetDay, 0, 0, 0, 0, loc)
	if !thisMonth.After(n) {
		return thisMonth
	}
	return thisMonth.AddDate(0, -1, 0)
}

// HostTraffic returns the server's row, or a zeroed default (reset_day=1) when
// absent so the UI always renders.
func (q *Query) HostTraffic(ctx context.Context, serverID int64) (*HostTrafficRow, error) {
	var row HostTrafficRow
	err := q.DB.GetContext(ctx, &row,
		`SELECT server_id, cum_bytes_up, cum_bytes_down, prev_bytes_up, prev_bytes_down, reset_day, last_reset_at
		   FROM host_traffic WHERE server_id=$1`, serverID)
	if errors.Is(err, sql.ErrNoRows) {
		return &HostTrafficRow{ServerID: serverID, ResetDay: 1}, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// HostTrafficForAll returns the host_traffic row per server for the given ids,
// keyed by server_id. Ids with no row are absent from the map (the caller
// supplies the same default the single-row HostTraffic uses: {ServerID, ResetDay:1}).
func (q *Query) HostTrafficForAll(ctx context.Context, ids []int64) (map[int64]*HostTrafficRow, error) {
	out := map[int64]*HostTrafficRow{}
	if len(ids) == 0 {
		return out, nil
	}
	query, args, err := sqlx.In(`SELECT server_id, cum_bytes_up, cum_bytes_down,
		prev_bytes_up, prev_bytes_down, reset_day, last_reset_at
		FROM host_traffic WHERE server_id IN (?)`, ids)
	if err != nil {
		return nil, err
	}
	query = q.DB.Rebind(query)
	var rows []HostTrafficRow
	if err := q.DB.SelectContext(ctx, &rows, query, args...); err != nil {
		return nil, err
	}
	for i := range rows {
		r := rows[i]
		out[r.ServerID] = &r
	}
	return out, nil
}

// SetTrafficResetDay upserts the per-server reset day (caller validates 1..28).
// Creates the row with last_reset_at=now if absent so the reset checker won't
// fire a spurious zero-snapshot before any traffic accumulates.
func (q *Query) SetTrafficResetDay(ctx context.Context, serverID int64, day int) error {
	now := time.Now().UTC()
	_, err := q.DB.ExecContext(ctx, `INSERT INTO host_traffic (server_id, reset_day, last_reset_at, updated_at)
		VALUES ($1,$2,$3,$3)
		ON CONFLICT (server_id) DO UPDATE SET reset_day=EXCLUDED.reset_day, updated_at=EXCLUDED.updated_at`,
		serverID, day, now)
	return err
}

// ResetTrafficNow snapshots current totals into prev_* and zeros the current
// counters for one server. Creates a zeroed row if absent (no-op zero).
func (q *Query) ResetTrafficNow(ctx context.Context, serverID int64) error {
	return q.snapshotZero(ctx, serverID, time.Now().UTC())
}

func (q *Query) snapshotZero(ctx context.Context, serverID int64, now time.Time) error {
	_, err := q.DB.ExecContext(ctx, `INSERT INTO host_traffic (server_id, last_reset_at, updated_at)
		VALUES ($1,$2,$2)
		ON CONFLICT (server_id) DO UPDATE SET
		  prev_bytes_up   = host_traffic.cum_bytes_up,
		  prev_bytes_down = host_traffic.cum_bytes_down,
		  cum_bytes_up    = 0,
		  cum_bytes_down  = 0,
		  last_reset_at   = EXCLUDED.last_reset_at,
		  updated_at      = EXCLUDED.updated_at`,
		serverID, now)
	return err
}

// ResetDueTraffic snapshots+zeros every server whose last_reset_at predates its
// most recent scheduled reset boundary (in loc). A row with NULL last_reset_at
// is treated as due.
func (q *Query) ResetDueTraffic(ctx context.Context, now time.Time, loc *time.Location) error {
	type r struct {
		ServerID    int64      `db:"server_id"`
		ResetDay    int        `db:"reset_day"`
		LastResetAt *time.Time `db:"last_reset_at"`
	}
	var rows []r
	if err := q.DB.SelectContext(ctx, &rows,
		`SELECT server_id, reset_day, last_reset_at FROM host_traffic`); err != nil {
		return err
	}
	for _, row := range rows {
		b := lastResetBoundary(now, row.ResetDay, loc)
		if row.LastResetAt == nil || row.LastResetAt.Before(b) {
			if err := q.snapshotZero(ctx, row.ServerID, now); err != nil {
				return err
			}
		}
	}
	return nil
}
