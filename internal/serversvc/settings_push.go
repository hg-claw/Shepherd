package serversvc

import (
	"context"
	"log"

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
	if err := p.Hub.Send(serverID, env); err != nil {
		log.Printf("config push to server %d failed: %v", serverID, err)
		return
	}
	log.Printf("config push to server %d: %s", serverID, snapshotSummary(cu))
}

func (p *SandboxPusher) PushAll(ctx context.Context) {
	cu := p.Snapshot(ctx)
	env, _ := agentapi.Frame(agentapi.TypeConfigUpdate, cu)
	ids := p.Hub.OnlineServers()
	log.Printf("config push fan-out to %d online agents: %s", len(ids), snapshotSummary(cu))
	for _, id := range ids {
		if err := p.Hub.Send(id, env); err != nil {
			log.Printf("config push to server %d failed: %v", id, err)
		}
	}
}

// snapshotSummary renders a one-line digest of what's about to be pushed
// so the operator log is greppable without dumping the full JSON.
func snapshotSummary(cu agentapi.ConfigUpdate) string {
	out := ""
	if cu.LogVerbose != nil {
		out += " log_verbose="
		if *cu.LogVerbose {
			out += "true"
		} else {
			out += "false"
		}
	}
	if cu.FileSandboxEnabled != nil {
		out += " sandbox_enabled="
		if *cu.FileSandboxEnabled {
			out += "true"
		} else {
			out += "false"
		}
	}
	if cu.FileSandboxPaths != nil {
		out += " sandbox_paths="
		for i, p := range cu.FileSandboxPaths {
			if i > 0 {
				out += ","
			}
			out += p
		}
	}
	if out == "" {
		return "(empty)"
	}
	return out[1:]
}
