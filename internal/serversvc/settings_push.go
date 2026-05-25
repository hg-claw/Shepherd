package serversvc

import (
	"context"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/agentsvc"
)

type SandboxPusher struct {
	Settings *SettingsStore
	Hub      *agentsvc.Hub
}

func (p *SandboxPusher) Snapshot(ctx context.Context) agentapi.ConfigUpdate {
	enabled := p.Settings.GetBool(ctx, "file_sandbox_enabled", true)
	paths := p.Settings.GetLines(ctx, "file_sandbox_paths")
	verbose := p.Settings.GetBool(ctx, "agent_log_verbose", false)
	return agentapi.ConfigUpdate{
		FileSandboxEnabled: &enabled,
		FileSandboxPaths:   paths,
		LogVerbose:         &verbose,
	}
}

func (p *SandboxPusher) PushOne(ctx context.Context, serverID int64) {
	cu := p.Snapshot(ctx)
	env, _ := agentapi.Frame(agentapi.TypeConfigUpdate, cu)
	_ = p.Hub.Send(serverID, env)
}

func (p *SandboxPusher) PushAll(ctx context.Context) {
	cu := p.Snapshot(ctx)
	env, _ := agentapi.Frame(agentapi.TypeConfigUpdate, cu)
	for _, id := range p.Hub.OnlineServers() {
		_ = p.Hub.Send(id, env)
	}
}
