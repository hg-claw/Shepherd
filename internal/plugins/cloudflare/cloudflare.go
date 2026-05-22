package cloudflare

import (
	"context"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type Plugin struct {
	baseURL string // override for tests
	store   *plugins.Store
}

func New() *Plugin { return &Plugin{} }

func init() { plugins.Register(New()) }

func (p *Plugin) Meta() plugins.Meta              { return meta() }
func (p *Plugin) Migrations(driver shepdb.Driver) []plugins.Migration {
	return loadMigrations(driver)
}
func (p *Plugin) OnEnable(_ context.Context, _ plugins.Deps) error  { return nil }
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }
