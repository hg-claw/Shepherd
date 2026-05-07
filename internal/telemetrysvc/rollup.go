package telemetrysvc

import (
	"context"
	"log"
	"time"

	"github.com/jmoiron/sqlx"
)

type Rollup struct {
	DB       *sqlx.DB
	Interval time.Duration // default 1m
}

// Run blocks until ctx is canceled. Closes (server_id, bucket_start) tuples that
// are now strictly in the past.
func (r *Rollup) Run(ctx context.Context) {
	if r.Interval == 0 {
		r.Interval = time.Minute
	}
	t := time.NewTicker(r.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := r.Tick(ctx); err != nil {
				log.Printf("rollup tick: %v", err)
			}
		}
	}
}

func (r *Rollup) Tick(ctx context.Context) error {
	if err := r.rollup(ctx, "telemetry_rollup_5m", 5*time.Minute); err != nil {
		return err
	}
	return r.rollup(ctx, "telemetry_rollup_1h", time.Hour)
}

// rollup folds samples_30s into the named rollup table for any (server, bucket) that:
//  1. has at least one sample in the bucket
//  2. has bucket_end <= NOW()  (closed)
//  3. doesn't already have a row in the rollup table
func (r *Rollup) rollup(ctx context.Context, table string, bucket time.Duration) error {
	now := time.Now().UTC()
	rows, err := r.DB.QueryContext(ctx, `SELECT server_id, ts FROM telemetry_samples_30s ORDER BY server_id, ts`)
	if err != nil {
		return err
	}
	type key struct {
		sid int64
		ts  time.Time
	}
	seen := map[key]struct{}{}
	var candidates []key
	for rows.Next() {
		var sid int64
		var ts time.Time
		if err := rows.Scan(&sid, &ts); err != nil {
			_ = rows.Close()
			return err
		}
		bucketStart := ts.Truncate(bucket)
		if bucketStart.Add(bucket).After(now) {
			continue // bucket still open
		}
		k := key{sid, bucketStart}
		if _, ok := seen[k]; ok {
			continue
		}
		seen[k] = struct{}{}
		candidates = append(candidates, k)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	_ = rows.Close()

	for _, k := range candidates {
		var exists int
		_ = r.DB.GetContext(ctx, &exists, "SELECT COUNT(*) FROM "+table+" WHERE server_id=$1 AND ts=$2", k.sid, k.ts)
		if exists == 1 {
			continue
		}
		end := k.ts.Add(bucket)
		insert := `INSERT INTO ` + table + `
			(server_id, ts, cpu_avg, cpu_max, mem_used_avg, mem_used_max, mem_total,
			 load_1_avg, load_1_max, net_rx_bps_avg, net_rx_bps_max,
			 net_tx_bps_avg, net_tx_bps_max, tcp_conn_avg, tcp_conn_max, disks_json)
			SELECT $1, $2,
			  AVG(cpu_pct), MAX(cpu_pct),
			  AVG(mem_used), MAX(mem_used), MAX(mem_total),
			  AVG(load_1), MAX(load_1),
			  AVG(net_rx_bps), MAX(net_rx_bps),
			  AVG(net_tx_bps), MAX(net_tx_bps),
			  AVG(tcp_conn), MAX(tcp_conn),
			  (SELECT disks_json FROM telemetry_samples_30s
			    WHERE server_id=$1 AND ts >= $2 AND ts < $3
			    ORDER BY ts DESC LIMIT 1)
			FROM telemetry_samples_30s
			WHERE server_id=$1 AND ts >= $2 AND ts < $3`
		if _, err := r.DB.ExecContext(ctx, insert, k.sid, k.ts, end); err != nil {
			return err
		}
	}
	return nil
}
