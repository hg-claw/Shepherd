package deploy

import (
	"bytes"
	"context"
	"fmt"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

// Pusher bundles the common "push binary + write config + write unit + start"
// dance used by HostAware plugins.
type Pusher struct {
	Exec plugins.HostExec
}

type DeployParams struct {
	ServerID    int64
	BinaryPath  string
	BinaryBytes []byte
	ConfigPath  string
	ConfigBytes []byte
	UnitPath    string
	UnitBytes   []byte
	UnitName    string // systemd unit name without .service suffix is fine
}

func (p *Pusher) DeploySystemdService(ctx context.Context, dp DeployParams) error {
	if err := p.Exec.PushFile(ctx, dp.ServerID, dp.BinaryPath, 0755, dp.BinaryBytes); err != nil {
		return fmt.Errorf("push binary: %w", err)
	}
	if err := p.Exec.PushFile(ctx, dp.ServerID, dp.ConfigPath, 0600, dp.ConfigBytes); err != nil {
		return fmt.Errorf("push config: %w", err)
	}
	if err := p.Exec.PushFile(ctx, dp.ServerID, dp.UnitPath, 0644, dp.UnitBytes); err != nil {
		return fmt.Errorf("push unit: %w", err)
	}
	if _, _, _, err := p.Exec.RunCmd(ctx, dp.ServerID, "systemctl", "daemon-reload"); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %w", err)
	}
	if _, _, _, err := p.Exec.RunCmd(ctx, dp.ServerID, "systemctl", "enable", "--now", dp.UnitName); err != nil {
		return fmt.Errorf("systemctl enable --now %s: %w", dp.UnitName, err)
	}
	return nil
}

// IsActive returns true when `systemctl is-active <unit>` prints "active".
func (p *Pusher) IsActive(ctx context.Context, serverID int64, unit string) (bool, error) {
	stdout, _, _, err := p.Exec.RunCmd(ctx, serverID, "systemctl", "is-active", unit)
	if err != nil {
		// is-active exits non-zero when not active — treat as "not active" with
		// no error so callers can render a status pill.
		return bytes.Contains(stdout, []byte("active")), nil
	}
	return bytes.Contains(stdout, []byte("active")), nil
}

// Reload sends `systemctl reload`, falling back to restart when reload exits non-zero.
func (p *Pusher) Reload(ctx context.Context, serverID int64, unit string) error {
	if _, _, code, _ := p.Exec.RunCmd(ctx, serverID, "systemctl", "reload", unit); code == 0 {
		return nil
	}
	if _, _, _, err := p.Exec.RunCmd(ctx, serverID, "systemctl", "restart", unit); err != nil {
		return fmt.Errorf("systemctl restart %s: %w", unit, err)
	}
	return nil
}

// Stop disables and stops a unit. Errors swallowed best-effort.
func (p *Pusher) Stop(ctx context.Context, serverID int64, unit string) error {
	_, _, _, _ = p.Exec.RunCmd(ctx, serverID, "systemctl", "disable", "--now", unit)
	return nil
}
