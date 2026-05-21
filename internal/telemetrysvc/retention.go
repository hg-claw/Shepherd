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
	// PluginEnabled is consulted before running retention on plugin-owned
	// tables. Returning false skips that table (avoids spamming "no such
	// table" on hosts that never enabled the plugin and therefore never
	// ran its migrations). nil → always run (legacy behaviour).
	PluginEnabled func(pluginID string) bool
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
		plugin     string // empty → system table, always retain
	}{
		{"retention_30s", "telemetry_samples_30s", 24 * time.Hour, ""},
		{"retention_5m", "telemetry_rollup_5m", 7 * 24 * time.Hour, ""},
		{"retention_1h", "telemetry_rollup_1h", 90 * 24 * time.Hour, ""},
		{"traffic_raw_24h", "xray_traffic_raw", 24 * time.Hour, "xray"},
		{"traffic_minute_7d", "xray_traffic_minute", 7 * 24 * time.Hour, "xray"},
		{"traffic_hour_90d", "xray_traffic_hour", 90 * 24 * time.Hour, "xray"},
		{"singbox_traffic_raw_24h", "singbox_traffic_raw", 24 * time.Hour, "singbox"},
		{"singbox_traffic_minute_7d", "singbox_traffic_minute", 7 * 24 * time.Hour, "singbox"},
		{"singbox_traffic_hour_90d", "singbox_traffic_hour", 90 * 24 * time.Hour, "singbox"},
	} {
		if c.plugin != "" && r.PluginEnabled != nil && !r.PluginEnabled(c.plugin) {
			continue
		}
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
