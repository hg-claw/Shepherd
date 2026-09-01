package mieru

import (
	"context"
	"fmt"

	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/hg-claw/Shepherd/internal/plugins/deploy"
)

func AssembleAndDeploy(ctx context.Context, deps plugins.Deps, serverID int64) error {
	store := &InboundStore{DB: deps.DB}
	views, err := store.ListAll(ctx)
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
	if osName != "linux" {
		return fmt.Errorf("mita server runs on Linux only (host os=%s)", osName)
	}
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	if len(mine) == 0 {
		return pusher.Stop(ctx, osName, serverID, unitNameLinux)
	}
	cfgBytes, err := RenderServerConfig(mine)
	if err != nil {
		return fmt.Errorf("render: %w", err)
	}
	if err := deps.HostExec.PushFile(ctx, serverID, configRemotePathUnix, 0600, cfgBytes); err != nil {
		return fmt.Errorf("push config: %w", err)
	}
	if _, _, _, err := deps.HostExec.RunCmd(ctx, serverID, "systemctl", "restart", unitNameLinux); err != nil {
		return fmt.Errorf("systemctl restart %s: %w", unitNameLinux, err)
	}
	return nil
}
