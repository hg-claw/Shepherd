package audit

import (
	"context"
	"strconv"
	"time"

	"github.com/hg-claw/Shepherd/internal/serversvc"
	"github.com/jmoiron/sqlx"
)

type Retention struct {
	DB       *sqlx.DB
	Settings *serversvc.SettingsStore
	Now      func() time.Time
	Days     int
}

func (r *Retention) Once(ctx context.Context) error {
	days := r.Days
	if days == 0 && r.Settings != nil {
		v, _ := r.Settings.Get(ctx, "audit_retention_days")
		days, _ = strconv.Atoi(v)
	}
	if days <= 0 {
		days = 30
	}
	cutoff := r.Now().Add(-time.Duration(days) * 24 * time.Hour).UTC()
	_, err := r.DB.ExecContext(ctx, `DELETE FROM audit_log WHERE ts < $1`, cutoff)
	return err
}

func (r *Retention) Run(ctx context.Context) {
	t := time.NewTicker(10 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			_ = r.Once(ctx)
		}
	}
}
