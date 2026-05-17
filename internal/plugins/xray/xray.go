package xray

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"

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
func (p *Plugin) RegisterRoutes(_ plugins.Mux, _ plugins.Deps) {}
func (p *Plugin) OnEnable(_ context.Context, _ plugins.Deps) error  { return nil }
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }

// deployBody is the per-host config admin sends.
type deployBody struct {
	Version string          `json:"version"`
	OS      string          `json:"os"`   // defaults "linux"
	Arch    string          `json:"arch"` // defaults "amd64"
	Config  json.RawMessage `json:"config"`
}

func (p *Plugin) DeployToHost(ctx context.Context, deps plugins.Deps, serverID int64, configJSON []byte) error {
	var body deployBody
	if err := json.Unmarshal(configJSON, &body); err != nil {
		return fmt.Errorf("invalid config json: %w", err)
	}
	if body.Version == "" { return fmt.Errorf("version required") }
	if body.OS == "" { body.OS = "linux" }
	if body.Arch == "" { body.Arch = "amd64" }

	r := p.releaser
	if r == nil {
		r = &Releaser{CacheDir: deps.DataDir + "/cache"}
	}
	bin, err := r.Fetch(ctx, body.Version, body.OS, body.Arch)
	if err != nil { return fmt.Errorf("fetch binary: %w", err) }

	binBytes, err := os.ReadFile(bin.Path)
	if err != nil { return fmt.Errorf("read binary: %w", err) }

	cfgBytes, err := NormaliseRaw([]byte(body.Config))
	if err != nil { return fmt.Errorf("config: %w", err) }

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
