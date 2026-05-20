package telemetrysvc

import (
	"context"
	"log"
	"time"

	"github.com/jmoiron/sqlx"
)

// SingboxTrafficRollup aggregates singbox_traffic_raw → minute → hour.
// It mirrors TrafficRollup but operates on the singbox_traffic_* tables.
type SingboxTrafficRollup struct {
	DB              *sqlx.DB
	MinuteInterval  time.Duration // default 1 min
	HourInterval    time.Duration // default 1 h
	CleanupInterval time.Duration // default 10 min
}

// Run blocks until ctx is canceled, running rollups and cleanup on their
// respective intervals.
func (r *SingboxTrafficRollup) Run(ctx context.Context) {
	mi := r.MinuteInterval
	if mi == 0 {
		mi = time.Minute
	}
	hi := r.HourInterval
	if hi == 0 {
		hi = time.Hour
	}
	ci := r.CleanupInterval
	if ci == 0 {
		ci = 10 * time.Minute
	}
	minuteTicker := time.NewTicker(mi)
	hourTicker := time.NewTicker(hi)
	cleanupTicker := time.NewTicker(ci)
	defer minuteTicker.Stop()
	defer hourTicker.Stop()
	defer cleanupTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-minuteTicker.C:
			if err := r.rollupRawToMinute(ctx); err != nil {
				log.Printf("singbox traffic rollup raw->minute: %v", err)
			}
		case <-hourTicker.C:
			if err := r.rollupMinuteToHour(ctx); err != nil {
				log.Printf("singbox traffic rollup minute->hour: %v", err)
			}
		case <-cleanupTicker.C:
			if err := r.Cleanup(ctx); err != nil {
				log.Printf("singbox traffic rollup cleanup: %v", err)
			}
		}
	}
}

// rollupRawToMinute aggregates closed 1-minute buckets from singbox_traffic_raw
// into singbox_traffic_minute. Buckets that are still open (ts >= current minute)
// are excluded. Re-running is idempotent: the ON CONFLICT clause overwrites
// with the fresh SUM so no double-counting occurs.
//
// Both sides of the WHERE comparison use strftime to normalise the timestamp
// format — Go inserts RFC3339 ("T"/"Z") while SQLite datetime() uses
// space-separated format; strftime handles both correctly.
func (r *SingboxTrafficRollup) rollupRawToMinute(ctx context.Context) error {
	_, err := r.DB.ExecContext(ctx, `
		INSERT INTO singbox_traffic_minute (server_id, tag, kind, ts, bytes_up, bytes_down)
		SELECT
			server_id,
			tag,
			kind,
			strftime('%Y-%m-%d %H:%M:00', ts) AS ts,
			SUM(bytes_up),
			SUM(bytes_down)
		FROM singbox_traffic_raw
		WHERE strftime('%Y-%m-%d %H:%M:%S', ts) < strftime('%Y-%m-%d %H:%M:00', 'now')
		GROUP BY server_id, tag, kind, strftime('%Y-%m-%d %H:%M:00', ts)
		ON CONFLICT (server_id, tag, kind, ts) DO UPDATE SET
			bytes_up   = excluded.bytes_up,
			bytes_down = excluded.bytes_down`)
	return err
}

// rollupMinuteToHour aggregates closed 1-hour buckets from singbox_traffic_minute
// into singbox_traffic_hour. Open buckets are excluded. Idempotent via UPSERT.
func (r *SingboxTrafficRollup) rollupMinuteToHour(ctx context.Context) error {
	_, err := r.DB.ExecContext(ctx, `
		INSERT INTO singbox_traffic_hour (server_id, tag, kind, ts, bytes_up, bytes_down)
		SELECT
			server_id,
			tag,
			kind,
			strftime('%Y-%m-%d %H:00:00', ts) AS ts,
			SUM(bytes_up),
			SUM(bytes_down)
		FROM singbox_traffic_minute
		WHERE strftime('%Y-%m-%d %H:%M:%S', ts) < strftime('%Y-%m-%d %H:00:00', 'now')
		GROUP BY server_id, tag, kind, strftime('%Y-%m-%d %H:00:00', ts)
		ON CONFLICT (server_id, tag, kind, ts) DO UPDATE SET
			bytes_up   = excluded.bytes_up,
			bytes_down = excluded.bytes_down`)
	return err
}

// Cleanup deletes singbox traffic rows older than their respective retention windows:
// raw > 24h, minute > 7d, hour > 90d.
func (r *SingboxTrafficRollup) Cleanup(ctx context.Context) error {
	for _, c := range []struct {
		table string
		age   time.Duration
	}{
		{"singbox_traffic_raw", 24 * time.Hour},
		{"singbox_traffic_minute", 7 * 24 * time.Hour},
		{"singbox_traffic_hour", 90 * 24 * time.Hour},
	} {
		cutoff := time.Now().UTC().Add(-c.age)
		if _, err := r.DB.ExecContext(ctx,
			"DELETE FROM "+c.table+" WHERE ts < ?", cutoff); err != nil {
			log.Printf("singbox traffic cleanup %s: %v", c.table, err)
			return err
		}
	}
	return nil
}
