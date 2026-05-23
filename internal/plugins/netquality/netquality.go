// Package netquality is the network-quality-probes plugin. It defines
// per-server ping targets and lets the agent's sampler poll them on a
// per-server cadence, then exposes the aggregated results through both
// admin endpoints and the public wall.
//
// This package owns the SCHEMA + REST + builtin seed list. The agent-
// side ping loop lives under internal/agent/netqualitysampler (added in
// the follow-up PR); the read/rollup background job lives under
// internal/telemetrysvc (also follow-up).
package netquality

import (
	"context"
	"time"

	"github.com/jmoiron/sqlx"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type Plugin struct {
	deps plugins.Deps // captured in RegisterRoutes; routes.go reads it
}

func New() *Plugin { return &Plugin{} }

func init() { plugins.Register(New()) }

func (p *Plugin) Meta() plugins.Meta                                  { return meta() }
func (p *Plugin) Migrations(driver shepdb.Driver) []plugins.Migration { return loadMigrations(driver) }

// OnEnable seeds builtin targets if the catalog is empty. We do NOT
// re-seed when rows already exist — admins may have disabled or even
// (in a future migration) hard-deleted builtin entries, and we don't
// want to undo their choices. Seeding on first enable is enough.
func (p *Plugin) OnEnable(ctx context.Context, deps plugins.Deps) error {
	return seedBuiltinTargets(ctx, deps.DB)
}

func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }

// RegisterRoutes is defined in routes.go (kept separate to give the REST
// surface its own file once it grew past a few endpoints).

// seedBuiltinTargets inserts the canonical target list once. Idempotent
// via UNIQUE(source, host) — re-running is a no-op.
func seedBuiltinTargets(ctx context.Context, db *sqlx.DB) error {
	now := time.Now().UTC()
	for _, t := range builtinTargets {
		// Postgres-friendly placeholders ($N) work in sqlite too; bare
		// "?" would fail on postgres (see project history: postgres
		// placeholder sweep landed in v0.7.10).
		_, err := db.ExecContext(ctx, `
			INSERT INTO netquality_targets
			  (source, isp, region, label, host, enabled, created_at)
			VALUES ('builtin', $1, $2, $3, $4, true, $5)
			ON CONFLICT (source, host) DO NOTHING`,
			t.ISP, t.Region, t.Label, t.Host, now)
		if err != nil {
			return err
		}
	}
	return nil
}
