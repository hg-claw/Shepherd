package xray

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/jmoiron/sqlx"

	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/hg-claw/Shepherd/internal/plugins/deploy"
)

//go:embed unit.linux.service
var unitLinux []byte

//go:embed unit.darwin.plist
var unitDarwin []byte

const (
	binaryRemotePathUnix = "/usr/local/bin/shepherd-xray"
	configRemotePathUnix = "/etc/shepherd-xray/config.json"
	unitRemotePathLinux  = "/etc/systemd/system/shepherd-xray.service"
	unitRemotePathDarwin = "/Library/LaunchDaemons/com.shepherd.xray.plist"
	unitNameLinux        = "shepherd-xray"
	unitNameDarwin       = "com.shepherd.xray"
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

	unitBytes := unitLinux
	unitPath := unitRemotePathLinux
	unitName := unitNameLinux
	if osName == "darwin" {
		unitBytes = unitDarwin
		unitPath = unitRemotePathDarwin
		unitName = unitNameDarwin
	}

	pusher := &deploy.Pusher{Exec: deps.HostExec}
	return pusher.DeployService(ctx, deploy.DeployParams{
		OS:          osName,
		ServerID:    serverID,
		BinaryPath:  binaryRemotePathUnix,
		BinaryBytes: binBytes,
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

type topologyBody struct {
	Role             string `json:"role"`
	UpstreamServerID int64  `json:"upstream_server_id"`
}

func parseTopology(raw []byte) topologyBody {
	t := topologyBody{Role: "landing"} // default
	if len(raw) == 0 { return t }
	_ = json.Unmarshal(raw, &t)
	if t.Role == "" { t.Role = "landing" }
	return t
}

// BeforeDeploy validates topology before any deploy work begins.
// Returns a user-facing error string; generic API maps to 409.
func (p *Plugin) BeforeDeploy(ctx context.Context, deps plugins.Deps, serverID int64, topology []byte) error {
	t := parseTopology(topology)
	if t.Role != "landing" && t.Role != "relay" {
		return fmt.Errorf("topology.role must be landing or relay, got %q", t.Role)
	}

	store := &TopologyStore{DB: deps.DB}

	// Role lock + upstream lock on re-deploy.
	existing, err := store.Get(ctx, serverID)
	if err == nil {
		if existing.Role != t.Role {
			return fmt.Errorf("role is locked at %s; undeploy first to change role", existing.Role)
		}
		if t.Role == "relay" && existing.UpstreamServerID.Int64 != t.UpstreamServerID {
			return fmt.Errorf("upstream is locked at server %d; undeploy first to change",
				existing.UpstreamServerID.Int64)
		}
	}

	// Relay-specific validations.
	if t.Role == "relay" {
		if t.UpstreamServerID == 0 {
			return fmt.Errorf("topology.upstream_server_id required when role=relay")
		}
		if t.UpstreamServerID == serverID {
			return fmt.Errorf("topology.upstream_server_id must not equal server_id")
		}
		upstream, err := store.Get(ctx, t.UpstreamServerID)
		if err != nil {
			return fmt.Errorf("upstream server %d has no xray deployment", t.UpstreamServerID)
		}
		if upstream.Role != "landing" {
			return fmt.Errorf("upstream server %d is not a landing (role=%s)",
				t.UpstreamServerID, upstream.Role)
		}
	}
	return nil
}

func (p *Plugin) AfterDeploy(ctx context.Context, deps plugins.Deps, serverID int64, topology []byte) error {
	t := parseTopology(topology)
	store := &TopologyStore{DB: deps.DB}
	if t.Role == "relay" {
		return store.UpsertRelay(ctx, serverID, t.UpstreamServerID)
	}
	return store.UpsertLanding(ctx, serverID)
}

func (p *Plugin) BeforeUndeploy(ctx context.Context, deps plugins.Deps, serverID int64) error {
	store := &TopologyStore{DB: deps.DB}
	relays, err := store.ListByUpstream(ctx, serverID)
	if err != nil { return err }
	if len(relays) > 0 {
		ids := make([]string, 0, len(relays))
		for _, r := range relays { ids = append(ids, fmt.Sprint(r.ServerID)) }
		return fmt.Errorf("%d relay(s) depend on this landing: %s; undeploy them first",
			len(relays), strings.Join(ids, ", "))
	}
	return nil
}
