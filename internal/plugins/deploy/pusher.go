package deploy

import (
	"bytes"
	"context"
	"fmt"
	"strings"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

// Pusher bundles the common "push binary + write config + write unit + start"
// dance used by HostAware plugins.
type Pusher struct {
	Exec plugins.HostExec
}

type DeployParams struct {
	OS          string // "linux" or "darwin"; defaults to "linux" when empty
	ServerID    int64
	BinaryPath  string
	BinaryBytes []byte
	ConfigPath  string
	ConfigBytes []byte
	UnitPath    string
	UnitBytes   []byte
	UnitName    string // systemd unit name (linux) or launchd label (darwin)
}

func (dp *DeployParams) os() string {
	if dp.OS == "" {
		return "linux"
	}
	return dp.OS
}

// DeployService pushes the binary, config, and unit file to the host then
// starts the service. It dispatches to systemd (linux) or launchd (darwin)
// based on dp.OS.
func (p *Pusher) DeployService(ctx context.Context, dp DeployParams) error {
	if err := p.Exec.PushFile(ctx, dp.ServerID, dp.BinaryPath, 0755, dp.BinaryBytes); err != nil {
		return fmt.Errorf("push binary: %w", err)
	}
	if err := p.Exec.PushFile(ctx, dp.ServerID, dp.ConfigPath, 0600, dp.ConfigBytes); err != nil {
		return fmt.Errorf("push config: %w", err)
	}
	if err := p.Exec.PushFile(ctx, dp.ServerID, dp.UnitPath, 0644, dp.UnitBytes); err != nil {
		return fmt.Errorf("push unit: %w", err)
	}

	switch dp.os() {
	case "darwin":
		// bootout first (tolerate failure: service may not be loaded yet on
		// first deploy). Then bootstrap, which loads the plist and starts
		// the service because RunAtLoad=true. This pair is the only way to
		// re-pick-up a changed plist or config on launchd.
		_, _, _, _ = p.Exec.RunCmd(ctx, dp.ServerID, "launchctl", "bootout", "system", dp.UnitPath)
		if _, _, _, err := p.Exec.RunCmd(ctx, dp.ServerID, "launchctl", "bootstrap", "system", dp.UnitPath); err != nil {
			return fmt.Errorf("launchctl bootstrap system %s: %w", dp.UnitPath, err)
		}
	default: // linux / systemd
		if _, _, _, err := p.Exec.RunCmd(ctx, dp.ServerID, "systemctl", "daemon-reload"); err != nil {
			return fmt.Errorf("systemctl daemon-reload: %w", err)
		}
		// `enable` is idempotent and registers the unit; we deliberately do
		// NOT use `--now`, because for an already-running service `--now`
		// is a no-op and would leave xray with the previous config still
		// loaded in memory. `restart` always picks up the new config.
		if _, _, _, err := p.Exec.RunCmd(ctx, dp.ServerID, "systemctl", "enable", dp.UnitName); err != nil {
			return fmt.Errorf("systemctl enable %s: %w", dp.UnitName, err)
		}
		if _, _, _, err := p.Exec.RunCmd(ctx, dp.ServerID, "systemctl", "restart", dp.UnitName); err != nil {
			return fmt.Errorf("systemctl restart %s: %w", dp.UnitName, err)
		}
	}
	return nil
}

// IsActive returns true when the service is active/running on the host.
// os is "linux" or "darwin" (empty → "linux").
func (p *Pusher) IsActive(ctx context.Context, os string, serverID int64, unit string) (bool, error) {
	if os == "" {
		os = "linux"
	}
	switch os {
	case "darwin":
		// `launchctl print system/<label>` exits 0 when loaded; stdout contains
		// "state = running" when actually running.
		stdout, _, _, err := p.Exec.RunCmd(ctx, serverID, "launchctl", "print", "system/"+unit)
		if err != nil {
			return false, nil
		}
		return bytes.Contains(stdout, []byte("state = running")), nil
	default: // linux
		stdout, _, _, err := p.Exec.RunCmd(ctx, serverID, "systemctl", "is-active", unit)
		if err != nil {
			// is-active exits non-zero when not active — treat as "not active".
			return bytes.Contains(stdout, []byte("active")), nil
		}
		return bytes.Contains(stdout, []byte("active")), nil
	}
}

// Reload restarts/reloads the service. os is "linux" or "darwin" (empty → "linux").
func (p *Pusher) Reload(ctx context.Context, os string, serverID int64, unit string, unitPath string) error {
	if os == "" {
		os = "linux"
	}
	switch os {
	case "darwin":
		// launchd has no reload concept; bootout then bootstrap.
		_, _, _, _ = p.Exec.RunCmd(ctx, serverID, "launchctl", "bootout", "system", unitPath)
		if _, _, _, err := p.Exec.RunCmd(ctx, serverID, "launchctl", "bootstrap", "system", unitPath); err != nil {
			return fmt.Errorf("launchctl bootstrap system %s: %w", unitPath, err)
		}
	default: // linux
		if _, _, code, _ := p.Exec.RunCmd(ctx, serverID, "systemctl", "reload", unit); code == 0 {
			return nil
		}
		if _, _, _, err := p.Exec.RunCmd(ctx, serverID, "systemctl", "restart", unit); err != nil {
			return fmt.Errorf("systemctl restart %s: %w", unit, err)
		}
	}
	return nil
}

// Stop disables and stops a unit. Errors swallowed best-effort.
// os is "linux" or "darwin" (empty → "linux").
func (p *Pusher) Stop(ctx context.Context, os string, serverID int64, unit string) error {
	if os == "" {
		os = "linux"
	}
	switch os {
	case "darwin":
		// For darwin we need the plist path. Derive it from the label convention.
		// com.shepherd.xray → /Library/LaunchDaemons/com.shepherd.xray.plist
		plistPath := "/Library/LaunchDaemons/" + strings.TrimSuffix(unit, ".plist") + ".plist"
		_, _, _, _ = p.Exec.RunCmd(ctx, serverID, "launchctl", "bootout", "system", plistPath)
	default: // linux
		_, _, _, _ = p.Exec.RunCmd(ctx, serverID, "systemctl", "disable", "--now", unit)
	}
	return nil
}
