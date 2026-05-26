package subgen

import (
	"context"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type Plugin struct {
	deps plugins.Deps // captured in RegisterRoutes
}

func New() *Plugin { return &Plugin{} }

func init() { plugins.Register(New()) }

func (p *Plugin) Meta() plugins.Meta { return meta() }
func (p *Plugin) Migrations(driver shepdb.Driver) []plugins.Migration {
	return loadMigrations(driver)
}
func (p *Plugin) RegisterRoutes(mux plugins.Mux, deps plugins.Deps) {
	p.deps = deps
	p.registerRoutes(mux) // real impl lands in a later task
}
func (p *Plugin) OnEnable(ctx context.Context, deps plugins.Deps) error {
	return seedBuiltinTemplates(ctx, deps.DB)
}
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }

// temporary stub — replaced by a later task
func (p *Plugin) registerRoutes(mux plugins.Mux) {}
