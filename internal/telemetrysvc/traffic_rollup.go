package telemetrysvc

import (
	"context"
	"log"
	"time"

	"github.com/jmoiron/sqlx"
)

// TrafficRollup runs two periodic SQL rollups:
// raw → minute (every MinuteInterval) and minute → hour (every HourInterval).
// It also exposes Cleanup for retention of old traffic rows.
type TrafficRollup struct {
	DB             *sqlx.DB
	MinuteInterval time.Duration // default 1 min
	HourInterval   time.Duration // default 1 h
	CleanupInterval time.Duration // default 10 min
	// Enabled is called each tick to gate work on plugin enabled state.
	// nil → always on. When non-nil and returning false, every tick is
	// a no-op — prevents "no such table" log spam on hosts that never
	// enabled the xray plugin.
	Enabled func() bool
}

func (r *TrafficRollup) shouldRun() bool {
	if r.Enabled == nil {
		return true
	}
	return r.Enabled()
}

// Run blocks until ctx is canceled, running rollups and cleanup on their
// respective intervals.
func (r *TrafficRollup) Run(ctx context.Context) {
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
			if !r.shouldRun() {
				continue
			}
			if err := r.rollupRawToMinute(ctx); err != nil {
				log.Printf("traffic rollup raw->minute: %v", err)
			}
		case <-hourTicker.C:
			if !r.shouldRun() {
				continue
			}
			if err := r.rollupMinuteToHour(ctx); err != nil {
				log.Printf("traffic rollup minute->hour: %v", err)
			}
		case <-cleanupTicker.C:
			if !r.shouldRun() {
				continue
			}
			if err := r.Cleanup(ctx); err != nil {
				log.Printf("traffic rollup cleanup: %v", err)
			}
		}
	}
}

// rollupRawToMinute aggregates closed 1-minute buckets from xray_traffic_raw
// into xray_traffic_minute. Buckets that are still open (ts >= current minute)
// are excluded. Re-running is idempotent: the ON CONFLICT clause overwrites
// with the fresh SUM so no double-counting occurs.
//
// Both sides of the WHERE comparison use strftime to normalise the timestamp
// format — Go inserts RFC3339 ("T"/"Z") while SQLite datetime() uses
// space-separated format; strftime handles both correctly.
//
// TODO(postgres): strftime() is sqlite-only. On postgres this query will
// fail when the xray plugin gets enabled. Replace with a driver-branched
// or date_trunc('minute', ts)-based query once we add postgres
// integration tests for the rollup loop.
func (r *TrafficRollup) rollupRawToMinute(ctx context.Context) error {
	_, err := r.DB.ExecContext(ctx, `
		INSERT INTO xray_traffic_minute (server_id, tag, kind, ts, bytes_up, bytes_down)
		SELECT
			server_id,
			tag,
			kind,
			strftime('%Y-%m-%d %H:%M:00', ts) AS ts,
			SUM(bytes_up),
			SUM(bytes_down)
		FROM xray_traffic_raw
		WHERE strftime('%Y-%m-%d %H:%M:%S', ts) < strftime('%Y-%m-%d %H:%M:00', 'now')
		GROUP BY server_id, tag, kind, strftime('%Y-%m-%d %H:%M:00', ts)
		ON CONFLICT (server_id, tag, kind, ts) DO UPDATE SET
			bytes_up   = excluded.bytes_up,
			bytes_down = excluded.bytes_down`)
	return err
}

// rollupMinuteToHour aggregates closed 1-hour buckets from xray_traffic_minute
// into xray_traffic_hour. Open buckets are excluded. Idempotent via UPSERT.
func (r *TrafficRollup) rollupMinuteToHour(ctx context.Context) error {
	_, err := r.DB.ExecContext(ctx, `
		INSERT INTO xray_traffic_hour (server_id, tag, kind, ts, bytes_up, bytes_down)
		SELECT
			server_id,
			tag,
			kind,
			strftime('%Y-%m-%d %H:00:00', ts) AS ts,
			SUM(bytes_up),
			SUM(bytes_down)
		FROM xray_traffic_minute
		WHERE strftime('%Y-%m-%d %H:%M:%S', ts) < strftime('%Y-%m-%d %H:00:00', 'now')
		GROUP BY server_id, tag, kind, strftime('%Y-%m-%d %H:00:00', ts)
		ON CONFLICT (server_id, tag, kind, ts) DO UPDATE SET
			bytes_up   = excluded.bytes_up,
			bytes_down = excluded.bytes_down`)
	return err
}

// Cleanup deletes traffic rows older than their respective retention windows:
// raw > 24h, minute > 7d, hour > 90d.
func (r *TrafficRollup) Cleanup(ctx context.Context) error {
	for _, c := range []struct {
		table string
		age   time.Duration
	}{
		{"xray_traffic_raw", 24 * time.Hour},
		{"xray_traffic_minute", 7 * 24 * time.Hour},
		{"xray_traffic_hour", 90 * 24 * time.Hour},
	} {
		cutoff := time.Now().UTC().Add(-c.age)
		if _, err := r.DB.ExecContext(ctx,
			"DELETE FROM "+c.table+" WHERE ts < ?", cutoff); err != nil {
			log.Printf("traffic cleanup %s: %v", c.table, err)
			return err
		}
	}
	return nil
}
