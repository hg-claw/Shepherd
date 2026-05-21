package singbox

import (
	"context"
	_ "embed"
	"fmt"
	"os"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/hg-claw/Shepherd/internal/plugins/deploy"
)

//go:embed unit.linux.service
var unitLinux []byte

//go:embed unit.darwin.plist
var unitDarwin []byte

// releaserIface lets tests inject a fake.
type releaserIface interface {
	Fetch(ctx context.Context, version, osName, arch string) (Binary, error)
}

// Plugin implements plugins.Plugin, plugins.HostAware, and plugins.LogStreamer.
type Plugin struct{ releaser releaserIface }

func New() *Plugin { return &Plugin{} }

func init() {
	plugins.Register(New())
}

func (p *Plugin) Meta() plugins.Meta                                     { return meta() }
func (p *Plugin) Migrations(driver shepdb.Driver) []plugins.Migration { return loadMigrations(driver) }
func (p *Plugin) OnEnable(_ context.Context, _ plugins.Deps) error  { return nil }
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }
func (p *Plugin) RegisterRoutes(mux plugins.Mux, deps plugins.Deps) { registerRoutes(mux, deps) }

// DeployToHost pushes the binary and systemd/launchd unit file to the host,
// then calls AssembleAndDeploy to render + push the real config and restart.
// configJSON is ignored here — the rendered config comes from AssembleAndDeploy.
// Returns an error if version is empty.
func (p *Plugin) DeployToHost(ctx context.Context, deps plugins.Deps, serverID int64, version string, _ []byte) error {
	if version == "" {
		return fmt.Errorf("version required")
	}
	osName, arch := sbHostOSArch(ctx, deps.DB, serverID)

	r := p.releaser
	if r == nil {
		r = &Releaser{CacheDir: deps.DataDir + "/cache"}
	}
	bin, err := r.Fetch(ctx, version, osName, arch)
	if err != nil {
		return fmt.Errorf("fetch binary: %w", err)
	}
	binBytes, err := os.ReadFile(bin.Path)
	if err != nil {
		return fmt.Errorf("read binary: %w", err)
	}

	unitBytes := unitLinux
	unitPath := singboxUnitRemotePathLinux
	unitName := singboxUnitNameLinux
	if osName == "darwin" {
		unitBytes = unitDarwin
		unitPath = singboxUnitRemotePathDarwin
		unitName = singboxUnitNameDarwin
	}

	pusher := &deploy.Pusher{Exec: deps.HostExec}
	if err := pusher.DeployService(ctx, deploy.DeployParams{
		OS:          osName,
		ServerID:    serverID,
		BinaryPath:  singboxBinaryRemotePath,
		BinaryBytes: binBytes,
		ConfigPath:  singboxConfigRemotePath,
		ConfigBytes: []byte("{}"),
		UnitPath:    unitPath,
		UnitBytes:   unitBytes,
		UnitName:    unitName,
	}); err != nil {
		return err
	}

	// Overwrite the placeholder config with the real rendered config + restart.
	return AssembleAndDeploy(ctx, deps, serverID)
}

// UndeployFromHost stops the service and deletes all singbox_inbounds rows
// for this server (best-effort cleanup so a re-deploy starts clean).
func (p *Plugin) UndeployFromHost(ctx context.Context, deps plugins.Deps, serverID int64) error {
	osName, _ := sbHostOSArch(ctx, deps.DB, serverID)
	unitName := singboxUnitNameLinux
	if osName == "darwin" {
		unitName = singboxUnitNameDarwin
	}
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	if err := pusher.Stop(ctx, osName, serverID, unitName); err != nil {
		return err
	}
	// Best-effort: clean up inbounds so a future re-deploy starts fresh.
	_, _ = deps.DB.ExecContext(ctx, `DELETE FROM singbox_inbounds WHERE server_id=$1`, serverID)
	return nil
}

// HostStatus returns running/stopped based on whether sing-box is active.
func (p *Plugin) HostStatus(ctx context.Context, deps plugins.Deps, serverID int64) (plugins.HostStatus, error) {
	osName, _ := sbHostOSArch(ctx, deps.DB, serverID)
	unitName := singboxUnitNameLinux
	if osName == "darwin" {
		unitName = singboxUnitNameDarwin
	}
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	active, _ := pusher.IsActive(ctx, osName, serverID, unitName)
	state := "stopped"
	if active {
		state = "running"
	}
	return plugins.HostStatus{State: state}, nil
}

// LogStreamCommand satisfies plugins.LogStreamer.
// Linux:  journalctl -u shepherd-singbox -f --no-pager -n 200 -o short-iso
// Darwin: tail -F -n 200 /var/log/shepherd-singbox.{out,err}.log
func (p *Plugin) LogStreamCommand(ctx context.Context, deps plugins.Deps, serverID int64) (string, []string, error) {
	osName, _ := sbHostOSArch(ctx, deps.DB, serverID)
	if osName == "darwin" {
		return "tail", []string{
			"-F", "-n", "200",
			"/var/log/shepherd-singbox.out.log",
			"/var/log/shepherd-singbox.err.log",
		}, nil
	}
	return "journalctl", []string{
		"-u", "shepherd-singbox",
		"-f",
		"--no-pager",
		"-n", "200",
		"-o", "short-iso",
	}, nil
}
