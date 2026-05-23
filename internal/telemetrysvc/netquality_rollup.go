package telemetrysvc

import (
	"context"
	"log"
	"time"

	"github.com/jmoiron/sqlx"
)

// NetqualityRollup folds netquality_samples_raw → _minute → _hour and
// trims aged rows. Same shape as TrafficRollup / SingboxTrafficRollup;
// kept separate because the column set differs (rtt + loss, not bytes
// up/down) and inlining would force every rollup to carry the union.
type NetqualityRollup struct {
	DB              *sqlx.DB
	MinuteInterval  time.Duration // default 1 min
	HourInterval    time.Duration // default 1 h
	CleanupInterval time.Duration // default 10 min
	// Enabled is called each tick to short-circuit on hosts where the
	// plugin was never turned on — mirrors singbox/xray rollups. nil
	// means "always run".
	Enabled func() bool
}

func (r *NetqualityRollup) shouldRun() bool {
	if r.Enabled == nil {
		return true
	}
	return r.Enabled()
}

func (r *NetqualityRollup) Run(ctx context.Context) {
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
	mt := time.NewTicker(mi)
	ht := time.NewTicker(hi)
	ct := time.NewTicker(ci)
	defer mt.Stop()
	defer ht.Stop()
	defer ct.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-mt.C:
			if !r.shouldRun() {
				continue
			}
			if err := r.rollupRawToMinute(ctx); err != nil {
				log.Printf("netquality rollup raw->minute: %v", err)
			}
		case <-ht.C:
			if !r.shouldRun() {
				continue
			}
			if err := r.rollupMinuteToHour(ctx); err != nil {
				log.Printf("netquality rollup minute->hour: %v", err)
			}
		case <-ct.C:
			if !r.shouldRun() {
				continue
			}
			if err := r.Cleanup(ctx); err != nil {
				log.Printf("netquality cleanup: %v", err)
			}
		}
	}
}

// rollupRawToMinute averages RTT and loss per (server, target, minute)
// using the driver-aware bucket helpers introduced for singbox traffic.
// AVG over RTT auto-ignores NULLs (the 'lost'/'error' rows) so the
// minute value reflects only successful probes. samples = total rows
// in the bucket (lets the UI flag thin / unreliable points).
func (r *NetqualityRollup) rollupRawToMinute(ctx context.Context) error {
	bucket := minuteBucketExpr(r.DB)
	now := minuteNowExpr(r.DB)
	_, err := r.DB.ExecContext(ctx, `
		INSERT INTO netquality_samples_minute (server_id, target_id, ts, rtt_avg_ms, loss_pct, samples)
		SELECT
			server_id,
			target_id,
			`+bucket+` AS ts,
			AVG(rtt_avg_ms),
			AVG(loss_pct),
			COUNT(*)
		FROM netquality_samples_raw
		WHERE `+bucket+` < `+now+`
		GROUP BY server_id, target_id, `+bucket+`
		ON CONFLICT (server_id, target_id, ts) DO UPDATE SET
			rtt_avg_ms = excluded.rtt_avg_ms,
			loss_pct   = excluded.loss_pct,
			samples    = excluded.samples`)
	return err
}

func (r *NetqualityRollup) rollupMinuteToHour(ctx context.Context) error {
	bucket := hourBucketExpr(r.DB)
	now := hourNowExpr(r.DB)
	_, err := r.DB.ExecContext(ctx, `
		INSERT INTO netquality_samples_hour (server_id, target_id, ts, rtt_avg_ms, loss_pct, samples)
		SELECT
			server_id,
			target_id,
			`+bucket+` AS ts,
			AVG(rtt_avg_ms),
			AVG(loss_pct),
			SUM(samples)
		FROM netquality_samples_minute
		WHERE `+bucket+` < `+now+`
		GROUP BY server_id, target_id, `+bucket+`
		ON CONFLICT (server_id, target_id, ts) DO UPDATE SET
			rtt_avg_ms = excluded.rtt_avg_ms,
			loss_pct   = excluded.loss_pct,
			samples    = excluded.samples`)
	return err
}

// Cleanup matches the retention windows declared in the migration:
// raw 24h, minute 7d, hour 90d.
func (r *NetqualityRollup) Cleanup(ctx context.Context) error {
	for _, c := range []struct {
		table string
		age   time.Duration
	}{
		{"netquality_samples_raw", 24 * time.Hour},
		{"netquality_samples_minute", 7 * 24 * time.Hour},
		{"netquality_samples_hour", 90 * 24 * time.Hour},
	} {
		cutoff := time.Now().UTC().Add(-c.age)
		if _, err := r.DB.ExecContext(ctx,
			"DELETE FROM "+c.table+" WHERE ts < $1", cutoff); err != nil {
			log.Printf("netquality cleanup %s: %v", c.table, err)
			return err
		}
	}
	return nil
}
