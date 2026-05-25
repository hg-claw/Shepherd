package xray

import (
	"context"
	"database/sql"
	_ "embed"
	"fmt"

	"github.com/jmoiron/sqlx"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/hg-claw/Shepherd/internal/plugins/deploy"
)

//go:embed unit.linux.service
var unitLinux []byte

//go:embed unit.darwin.plist
var unitDarwin []byte

const (
	// xrayBinaryRemotePathUnix is the install destination on the agent host.
	// Exported (within package) so release.go's ResolveFetchSpec can stamp
	// it into the FileFetch payload sent to the agent.
	xrayBinaryRemotePathUnix = "/usr/local/bin/shepherd-xray"
	configRemotePathUnix     = "/etc/shepherd-xray/config.json"
	unitRemotePathLinux      = "/etc/systemd/system/shepherd-xray.service"
	unitRemotePathDarwin     = "/Library/LaunchDaemons/com.shepherd.xray.plist"
	unitNameLinux            = "shepherd-xray"
	unitNameDarwin           = "com.shepherd.xray"
)

// releaserIface lets tests inject a fake.
type releaserIface interface {
	ResolveFetchSpec(ctx context.Context, version, os, arch string, useMirror bool) (agentapi.FileFetch, error)
}

type Plugin struct {
	releaser releaserIface
}

func New() *Plugin { return &Plugin{} }

func init() {
	plugins.Register(New())
}

func (p *Plugin) Meta() plugins.Meta                                     { return meta() }
func (p *Plugin) Migrations(driver shepdb.Driver) []plugins.Migration { return loadMigrations(driver) }
func (p *Plugin) OnEnable(_ context.Context, _ plugins.Deps) error  { return nil }
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }

// DeployToHost tells the agent to fetch the xray binary directly from
// the XTLS release (optionally via the CN mirror), then pushes config
// and unit and starts the service. useMirror selects per-deploy whether
// the agent goes through gh-proxy.com.
func (p *Plugin) DeployToHost(ctx context.Context, deps plugins.Deps, serverID int64, version string, configJSON []byte, useMirror bool) error {
	if version == "" {
		return fmt.Errorf("version required")
	}
	if err := plugins.RequireAgentVersionAtLeast(ctx, deps.DB, serverID, plugins.MinAgentVersionForFetch); err != nil {
		return err
	}
	osName, arch := hostOSArch(ctx, deps.DB, serverID)

	r := p.releaser
	if r == nil {
		r = &Releaser{}
	}
	spec, err := r.ResolveFetchSpec(ctx, version, osName, arch, useMirror)
	if err != nil {
		return fmt.Errorf("resolve fetch spec: %w", err)
	}
	cfgBytes, err := NormaliseRaw(configJSON)
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}

	unitBytes := unitLinux
	unitPath := unitRemotePathLinux
	unitName := unitNameLinux
	if osName == "darwin" {
		unitBytes = unitDarwin
		unitPath = unitRemotePathDarwin
		unitName = unitNameDarwin
	}

	pusher := &deploy.Pusher{Exec: deps.HostExec}
	return pusher.DeployServiceFetch(ctx, deploy.DeployFetchParams{
		OS:          osName,
		ServerID:    serverID,
		BinaryFetch: spec,
		ConfigPath:  configRemotePathUnix,
		ConfigBytes: cfgBytes,
		UnitPath:    unitPath,
		UnitBytes:   unitBytes,
		UnitName:    unitName,
	})
}

// hostOSArch reads servers.agent_os / agent_arch for the target server,
// defaulting to linux/amd64 when they are NULL (unenrolled or pre-Phase-2 row).
func hostOSArch(ctx context.Context, db *sqlx.DB, serverID int64) (string, string) {
	var osName, arch sql.NullString
	_ = db.QueryRowxContext(ctx,
		"SELECT agent_os, agent_arch FROM servers WHERE id=$1", serverID).
		Scan(&osName, &arch)
	o := "linux"
	if osName.Valid && osName.String != "" {
		o = osName.String
	}
	a := "amd64"
	if arch.Valid && arch.String != "" {
		a = arch.String
	}
	return o, a
}

func (p *Plugin) UndeployFromHost(ctx context.Context, deps plugins.Deps, serverID int64) error {
	osName, _ := hostOSArch(ctx, deps.DB, serverID)
	unitName := unitNameLinux
	if osName == "darwin" {
		unitName = unitNameDarwin
	}
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	if err := pusher.Stop(ctx, osName, serverID, unitName); err != nil {
		return err
	}
	store := &TopologyStore{DB: deps.DB}
	_ = store.Delete(ctx, serverID) // best-effort; FK RESTRICT already gated by BeforeUndeploy
	return nil
}

func (p *Plugin) HostStatus(ctx context.Context, deps plugins.Deps, serverID int64) (plugins.HostStatus, error) {
	osName, _ := hostOSArch(ctx, deps.DB, serverID)
	unitName := unitNameLinux
	if osName == "darwin" {
		unitName = unitNameDarwin
	}
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	active, _ := pusher.IsActive(ctx, osName, serverID, unitName)
	state := "stopped"
	if active {
		state = "running"
	}
	return plugins.HostStatus{State: state}, nil
}

// StartHost enables and starts xray on the given host.
func (p *Plugin) StartHost(ctx context.Context, deps plugins.Deps, serverID int64) error {
	osName, _ := hostOSArch(ctx, deps.DB, serverID)
	unitName := unitNameLinux
	unitPath := unitRemotePathLinux
	if osName == "darwin" {
		unitName = unitNameDarwin
		unitPath = unitRemotePathDarwin
	}
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	return pusher.Start(ctx, osName, serverID, unitName, unitPath)
}

// StopHost disables and stops xray on the given host.
func (p *Plugin) StopHost(ctx context.Context, deps plugins.Deps, serverID int64) error {
	osName, _ := hostOSArch(ctx, deps.DB, serverID)
	unitName := unitNameLinux
	if osName == "darwin" {
		unitName = unitNameDarwin
	}
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	return pusher.Stop(ctx, osName, serverID, unitName)
}

// RestartHost restarts xray on the given host.
func (p *Plugin) RestartHost(ctx context.Context, deps plugins.Deps, serverID int64) error {
	osName, _ := hostOSArch(ctx, deps.DB, serverID)
	unitName := unitNameLinux
	unitPath := unitRemotePathLinux
	if osName == "darwin" {
		unitName = unitNameDarwin
		unitPath = unitRemotePathDarwin
	}
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	return pusher.Reload(ctx, osName, serverID, unitName, unitPath)
}

// LogStreamCommand satisfies plugins.LogStreamer.
func (p *Plugin) LogStreamCommand(ctx context.Context, deps plugins.Deps, serverID int64) (string, []string, error) {
	osName, _ := hostOSArch(ctx, deps.DB, serverID)
	if osName == "darwin" {
		return "tail", []string{
			"-F", "-n", "200",
			"/var/log/shepherd-xray.out.log",
			"/var/log/shepherd-xray.err.log",
		}, nil
	}
	return "journalctl", []string{
		"-u", "shepherd-xray",
		"-f",
		"--no-pager",
		"-n", "200",
		"-o", "short-iso",
	}, nil
}

