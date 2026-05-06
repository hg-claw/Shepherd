package telemetrysvc

import (
	"context"
	"errors"
	"time"

	"github.com/jmoiron/sqlx"
)

type Range string

const (
	Range1h  Range = "1h"
	Range24h Range = "24h"
	Range7d  Range = "7d"
)

func (r Range) Window() (time.Duration, error) {
	switch r {
	case Range1h:
		return time.Hour, nil
	case Range24h:
		return 24 * time.Hour, nil
	case Range7d:
		return 7 * 24 * time.Hour, nil
	}
	return 0, errors.New("invalid range")
}

// Granularity decides which table backs a range. 1h -> raw 30s; 24h -> 5m; 7d -> 1h.
func (r Range) Table() (string, error) {
	switch r {
	case Range1h:
		return "telemetry_samples_30s", nil
	case Range24h:
		return "telemetry_rollup_5m", nil
	case Range7d:
		return "telemetry_rollup_1h", nil
	}
	return "", errors.New("invalid range")
}

type Point struct {
	TS        time.Time `db:"ts"          json:"ts"`
	CPU       *float64  `db:"cpu"         json:"cpu_pct,omitempty"`
	MemUsed   *int64    `db:"mem_used"    json:"mem_used,omitempty"`
	MemTotal  *int64    `db:"mem_total"   json:"mem_total,omitempty"`
	Load1     *float64  `db:"load_1"      json:"load_1,omitempty"`
	NetRxBps  *int64    `db:"net_rx_bps"  json:"net_rx_bps,omitempty"`
	NetTxBps  *int64    `db:"net_tx_bps"  json:"net_tx_bps,omitempty"`
	TCPConn   *int      `db:"tcp_conn"    json:"tcp_conn,omitempty"`
	DisksJSON *string   `db:"disks_json"  json:"disks_json,omitempty"`
}

type Query struct {
	DB *sqlx.DB
}

func (q *Query) Series(ctx context.Context, serverID int64, rng Range) ([]Point, error) {
	win, err := rng.Window()
	if err != nil {
		return nil, err
	}
	table, _ := rng.Table()
	since := time.Now().UTC().Add(-win)

	var sql string
	switch table {
	case "telemetry_samples_30s":
		sql = `SELECT ts, cpu_pct AS cpu, mem_used, mem_total, load_1, net_rx_bps, net_tx_bps, tcp_conn, disks_json
		       FROM telemetry_samples_30s WHERE server_id=$1 AND ts>=$2 ORDER BY ts`
	default:
		sql = `SELECT ts, cpu_avg AS cpu, mem_used_avg AS mem_used, mem_total, load_1_avg AS load_1,
		              net_rx_bps_avg AS net_rx_bps, net_tx_bps_avg AS net_tx_bps,
		              tcp_conn_avg AS tcp_conn, disks_json
		       FROM ` + table + ` WHERE server_id=$1 AND ts>=$2 ORDER BY ts`
	}
	var out []Point
	if err := q.DB.SelectContext(ctx, &out, sql, serverID, since); err != nil {
		return nil, err
	}
	return out, nil
}

// Latest returns the most recent 30s sample for a server, or nil.
func (q *Query) Latest(ctx context.Context, serverID int64) (*Point, error) {
	var p Point
	err := q.DB.GetContext(ctx, &p, `SELECT ts, cpu_pct AS cpu, mem_used, mem_total, load_1,
		net_rx_bps, net_tx_bps, tcp_conn, disks_json
		FROM telemetry_samples_30s WHERE server_id=$1 ORDER BY ts DESC LIMIT 1`, serverID)
	if err != nil {
		return nil, err
	}
	return &p, nil
}
