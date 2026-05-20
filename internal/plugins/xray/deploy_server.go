package xray

import (
	"context"
	"fmt"

	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/hg-claw/Shepherd/internal/plugins/deploy"
)

// AssembleAndDeploy gathers all inbounds for serverID, renders the full xray
// config, pushes it, and restarts xray. If serverID has zero inbounds, stops
// xray instead (without pushing a config).
func AssembleAndDeploy(ctx context.Context, deps plugins.Deps, serverID int64) error {
	store := &InboundStore{DB: deps.DB}
	views, err := store.ListAllWithUpstream(ctx)
	if err != nil {
		return fmt.Errorf("list inbounds: %w", err)
	}

	mine := make([]InboundView, 0)
	for _, v := range views {
		if v.ServerID == serverID {
			mine = append(mine, v)
		}
	}

	osName, _ := hostOSArch(ctx, deps.DB, serverID)
	unitName := unitNameLinux
	if osName == "darwin" {
		unitName = unitNameDarwin
	}
	pusher := &deploy.Pusher{Exec: deps.HostExec}

	if len(mine) == 0 {
		return pusher.Stop(ctx, osName, serverID, unitName)
	}

	cfgBytes, err := RenderServerConfig(mine)
	if err != nil {
		return fmt.Errorf("render: %w", err)
	}

	if err := deps.HostExec.PushFile(ctx, serverID, configRemotePathUnix, 0600, cfgBytes); err != nil {
		return fmt.Errorf("push config: %w", err)
	}
	// Always restart (not reload) so xray re-reads the new config from disk.
	if osName == "darwin" {
		plistPath := unitRemotePathDarwin
		_, _, _, _ = deps.HostExec.RunCmd(ctx, serverID, "launchctl", "bootout", "system", plistPath)
		if _, _, _, err := deps.HostExec.RunCmd(ctx, serverID, "launchctl", "bootstrap", "system", plistPath); err != nil {
			return fmt.Errorf("launchctl bootstrap: %w", err)
		}
		return nil
	}
	if _, _, _, err := deps.HostExec.RunCmd(ctx, serverID, "systemctl", "restart", unitName); err != nil {
		return fmt.Errorf("systemctl restart %s: %w", unitName, err)
	}
	return nil
}
