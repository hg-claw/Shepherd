package xray

import (
	"context"
	"database/sql"
	_ "embed"
	"fmt"
	"os"

	"github.com/jmoiron/sqlx"

	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/hg-claw/Shepherd/internal/plugins/deploy"
)

//go:embed unit.tmpl
var unitTmpl []byte

const (
	binaryRemotePath = "/usr/local/bin/shepherd-xray"
	configRemotePath = "/etc/shepherd-xray/config.json"
	unitRemotePath   = "/etc/systemd/system/shepherd-xray.service"
	unitName         = "shepherd-xray"
)

// releaserIface lets tests inject a fake.
type releaserIface interface {
	Fetch(ctx context.Context, version, os, arch string) (Binary, error)
}

type Plugin struct {
	releaser releaserIface
}

func New() *Plugin { return &Plugin{} }

func init() {
	plugins.Register(New())
}

func (p *Plugin) Meta() plugins.Meta              { return meta() }
func (p *Plugin) Migrations() []plugins.Migration { return loadMigrations() }
func (p *Plugin) OnEnable(_ context.Context, _ plugins.Deps) error  { return nil }
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }

// DeployToHost deploys xray to the given host.
// configJSON is the rendered xray config (what ends up at
// /etc/shepherd-xray/config.json on the host). version is the xray release
// tag (no leading "v") used to fetch the binary.
func (p *Plugin) DeployToHost(ctx context.Context, deps plugins.Deps, serverID int64, version string, configJSON []byte) error {
	if version == "" {
		return fmt.Errorf("version required")
	}
	osName, arch := hostOSArch(ctx, deps.DB, serverID)

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
	cfgBytes, err := NormaliseRaw(configJSON)
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	return pusher.DeploySystemdService(ctx, deploy.DeployParams{
		ServerID:    serverID,
		BinaryPath:  binaryRemotePath,
		BinaryBytes: binBytes,
		ConfigPath:  configRemotePath,
		ConfigBytes: cfgBytes,
		UnitPath:    unitRemotePath,
		UnitBytes:   unitTmpl,
		UnitName:    unitName,
	})
}

// hostOSArch reads servers.agent_os / agent_arch for the target server,
// defaulting to linux/amd64 when they are NULL (unenrolled or pre-Phase-2 row).
func hostOSArch(ctx context.Context, db *sqlx.DB, serverID int64) (string, string) {
	var osName, arch sql.NullString
	_ = db.QueryRowxContext(ctx,
		"SELECT agent_os, agent_arch FROM servers WHERE id=?", serverID).
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
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	return pusher.Stop(ctx, serverID, unitName)
}

func (p *Plugin) HostStatus(ctx context.Context, deps plugins.Deps, serverID int64) (plugins.HostStatus, error) {
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	active, _ := pusher.IsActive(ctx, serverID, unitName)
	state := "stopped"
	if active { state = "running" }
	return plugins.HostStatus{State: state}, nil
}

// LogStreamCommand satisfies plugins.LogStreamer.
func (p *Plugin) LogStreamCommand(_ int64) (string, []string, error) {
	return "journalctl", []string{
		"-u", "shepherd-xray",
		"-f",
		"--no-pager",
		"-n", "200",
		"-o", "short-iso",
	}, nil
}
