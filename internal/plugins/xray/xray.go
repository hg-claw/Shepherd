package xray

import (
	"context"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

// Plugin implements plugins.HostAware + plugins.LogStreamer.
type Plugin struct {
	// fields populated in later tasks (release fetcher, config validator, ...)
}

// New constructs an xray plugin. Used by init() and by tests.
func New() *Plugin { return &Plugin{} }

func init() {
	plugins.Register(New())
}

func (p *Plugin) Meta() plugins.Meta             { return meta() }
func (p *Plugin) Migrations() []plugins.Migration { return loadMigrations() }

func (p *Plugin) RegisterRoutes(_ plugins.Mux, _ plugins.Deps) {
	// Filled in by Task 17.
}

func (p *Plugin) OnEnable(_ context.Context, _ plugins.Deps) error  { return nil }
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }

// HostAware — bodies filled by Task 16.
func (p *Plugin) DeployToHost(ctx context.Context, deps plugins.Deps, serverID int64, configJSON []byte) error {
	return nil
}
func (p *Plugin) UndeployFromHost(ctx context.Context, deps plugins.Deps, serverID int64) error {
	return nil
}
func (p *Plugin) HostStatus(ctx context.Context, deps plugins.Deps, serverID int64) (plugins.HostStatus, error) {
	return plugins.HostStatus{}, nil
}
