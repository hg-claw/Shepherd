package telemetrysvc

import (
	"context"
	"log"
	"time"

	"github.com/jmoiron/sqlx"
)

type Retention struct {
	DB       *sqlx.DB
	Settings interface {
		Get(ctx context.Context, key string) (string, error)
	}
	Interval time.Duration // default 10m
}

func (r *Retention) Run(ctx context.Context) {
	if r.Interval == 0 {
		r.Interval = 10 * time.Minute
	}
	t := time.NewTicker(r.Interval)
	defer t.Stop()
	r.Tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.Tick(ctx)
		}
	}
}

func (r *Retention) Tick(ctx context.Context) {
	for _, c := range []struct {
		key, table string
		def        time.Duration
	}{
		{"retention_30s", "telemetry_samples_30s", 24 * time.Hour},
		{"retention_5m", "telemetry_rollup_5m", 7 * 24 * time.Hour},
		{"retention_1h", "telemetry_rollup_1h", 90 * 24 * time.Hour},
	} {
		dur := c.def
		if v, err := r.Settings.Get(ctx, c.key); err == nil {
			if d, err := time.ParseDuration(v); err == nil {
				dur = d
			}
		}
		cutoff := time.Now().UTC().Add(-dur)
		if _, err := r.DB.ExecContext(ctx, "DELETE FROM "+c.table+" WHERE ts < $1", cutoff); err != nil {
			log.Printf("retention %s: %v", c.table, err)
		}
	}
}
