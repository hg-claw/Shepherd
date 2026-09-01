package mieru

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

const (
	mitaBinaryRemotePath = "/usr/local/bin/shepherd-mita"
	configRemotePathUnix = "/etc/shepherd-mieru/server.json"
	unitRemotePathLinux  = "/etc/systemd/system/shepherd-mieru.service"
	unitNameLinux        = "shepherd-mieru"
)

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

func (p *Plugin) Meta() plugins.Meta { return meta() }
func (p *Plugin) Migrations(driver shepdb.Driver) []plugins.Migration {
	return loadMigrations(driver)
}
func (p *Plugin) OnEnable(_ context.Context, _ plugins.Deps) error  { return nil }
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }

func (p *Plugin) DeployToHost(ctx context.Context, deps plugins.Deps, serverID int64, version string, configJSON []byte, useMirror bool) error {
	if version == "" {
		return fmt.Errorf("version required")
	}
	if err := plugins.RequireAgentVersionAtLeast(ctx, deps.DB, serverID, plugins.MinAgentVersionForFetch); err != nil {
		return err
	}
	osName, arch := hostOSArch(ctx, deps.DB, serverID)
	if osName != "linux" {
		return fmt.Errorf("mita server runs on Linux only (host os=%s)", osName)
	}
	r := p.releaser
	if r == nil {
		r = &Releaser{}
	}
	spec, err := r.ResolveFetchSpec(ctx, version, osName, arch, useMirror)
	if err != nil {
		return fmt.Errorf("resolve fetch spec: %w", err)
	}
	cfgBytes := configJSON
	if len(cfgBytes) == 0 {
		cfgBytes = []byte("{}")
	}
	store := &InboundStore{DB: deps.DB}
	if views, err := store.ListByServer(ctx, serverID); err == nil && len(views) > 0 {
		all, _ := store.ListAll(ctx)
		mine := make([]InboundView, 0, len(views))
		for _, v := range all {
			if v.ServerID == serverID {
				mine = append(mine, v)
			}
		}
		if rendered, err := RenderServerConfig(mine); err == nil {
			cfgBytes = rendered
		}
	}
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	return pusher.DeployServiceFetch(ctx, deploy.DeployFetchParams{
		OS:          osName,
		ServerID:    serverID,
		BinaryFetch: spec,
		ConfigPath:  configRemotePathUnix,
		ConfigBytes: cfgBytes,
		UnitPath:    unitRemotePathLinux,
		UnitBytes:   unitLinux,
		UnitName:    unitNameLinux,
	})
}

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
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	return pusher.Stop(ctx, osName, serverID, unitNameLinux)
}

func (p *Plugin) HostStatus(ctx context.Context, deps plugins.Deps, serverID int64) (plugins.HostStatus, error) {
	osName, _ := hostOSArch(ctx, deps.DB, serverID)
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	active, _ := pusher.IsActive(ctx, osName, serverID, unitNameLinux)
	state := "stopped"
	if active {
		state = "running"
	}
	return plugins.HostStatus{State: state}, nil
}

func (p *Plugin) StartHost(ctx context.Context, deps plugins.Deps, serverID int64) error {
	osName, _ := hostOSArch(ctx, deps.DB, serverID)
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	return pusher.Start(ctx, osName, serverID, unitNameLinux, unitRemotePathLinux)
}

func (p *Plugin) StopHost(ctx context.Context, deps plugins.Deps, serverID int64) error {
	osName, _ := hostOSArch(ctx, deps.DB, serverID)
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	return pusher.Stop(ctx, osName, serverID, unitNameLinux)
}

func (p *Plugin) RestartHost(ctx context.Context, deps plugins.Deps, serverID int64) error {
	osName, _ := hostOSArch(ctx, deps.DB, serverID)
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	return pusher.Reload(ctx, osName, serverID, unitNameLinux, unitRemotePathLinux)
}

func (p *Plugin) LogStreamCommand(ctx context.Context, deps plugins.Deps, serverID int64) (string, []string, error) {
	return "journalctl", []string{
		"-u", unitNameLinux,
		"-f",
		"--no-pager",
		"-n", "200",
		"-o", "short-iso",
	}, nil
}
