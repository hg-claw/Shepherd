package telemetrysvc

import (
	"context"
	"log"
	"time"

	"github.com/jmoiron/sqlx"
)

// TrafficReset periodically zeroes per-server cumulative traffic on each
// server's monthly reset-day boundary (in the global traffic_reset_tz).
type TrafficReset struct {
	DB       *sqlx.DB
	Settings interface {
		Get(ctx context.Context, key string) (string, error)
	}
	Interval time.Duration // default 1h
}

func (r *TrafficReset) Run(ctx context.Context) {
	if r.Interval == 0 {
		r.Interval = time.Hour
	}
	t := time.NewTicker(r.Interval)
	defer t.Stop()
	if err := r.Tick(ctx); err != nil {
		log.Printf("traffic reset tick: %v", err)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := r.Tick(ctx); err != nil {
				log.Printf("traffic reset tick: %v", err)
			}
		}
	}
}

func (r *TrafficReset) Tick(ctx context.Context) error {
	tz := "UTC"
	if r.Settings != nil {
		if v, err := r.Settings.Get(ctx, "traffic_reset_tz"); err == nil && v != "" {
			tz = v
		}
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	return (&Query{DB: r.DB}).ResetDueTraffic(ctx, time.Now(), loc)
}
