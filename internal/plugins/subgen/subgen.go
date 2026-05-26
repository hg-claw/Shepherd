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
	p.registerRoutes(mux) // real impl in routes.go
}
func (p *Plugin) OnEnable(ctx context.Context, deps plugins.Deps) error {
	return seedBuiltinTemplates(ctx, deps.DB)
}
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }

// LoadMigrationsForTest exposes loadMigrations to other packages' tests.
func LoadMigrationsForTest(driver shepdb.Driver) []plugins.Migration { return loadMigrations(driver) }
