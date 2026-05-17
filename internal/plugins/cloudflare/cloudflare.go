package cloudflare

import (
	"context"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

type Plugin struct {
	baseURL string // override for tests
	store   *plugins.Store
}

func New() *Plugin { return &Plugin{} }

func init() { plugins.Register(New()) }

func (p *Plugin) Meta() plugins.Meta              { return meta() }
func (p *Plugin) Migrations() []plugins.Migration { return nil }
func (p *Plugin) RegisterRoutes(_ plugins.Mux, _ plugins.Deps) {
	// filled in by Task 20
}
func (p *Plugin) OnEnable(_ context.Context, _ plugins.Deps) error  { return nil }
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }
