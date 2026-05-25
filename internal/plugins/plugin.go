// Package plugins defines the contract every compile-time plugin satisfies.
package plugins

import (
	"context"
	"net/http"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/jmoiron/sqlx"
)

// Mux is the subset of *http.ServeMux that plugins use to register routes.
// We pass an interface (not the concrete ServeMux) so the runtime can wrap
// each plugin's handlers with an enabled-gate middleware transparently.
type Mux interface {
	HandleFunc(pattern string, h func(http.ResponseWriter, *http.Request))
	Handle(pattern string, h http.Handler)
}

// Meta is the static, build-time description of a plugin.
type Meta struct {
	ID          string // stable identifier, used in URLs and DB. lower-snake.
	Name        string
	Description string
	Icon        string // lucide icon name, surfaced to the frontend manifest
	Category    string // "proxy" | "dns" | "system" | ...
	HostAware   bool   // mirrors interface assertion; UI hint
}

// Migration is one named SQL chunk owned by a plugin. The plugin runtime
// records applied (plugin_id, name) pairs in plugin_migrations to make
// repeated boots idempotent.
type Migration struct {
	Name string
	SQL  string
}

// Deps is the runtime-supplied bundle handed to every plugin method that
// needs it. Plugins keep no global state of their own — everything they
// touch lives here.
type Deps struct {
	DB       *sqlx.DB
	DataDir  string // e.g. "data/plugins/<id>/". Created before first call.
	HostExec HostExec
	Now      func() time.Time
	// HubSend lets a plugin push an envelope to a specific server's WS
	// connection. Returns the hub's Send error verbatim — callers
	// usually just log it. Nil in test deps that don't boot a hub.
	HubSend func(serverID int64, env agentapi.Envelope) error
}

// HostExec is the agent-side execution surface needed by HostAware plugins.
// Defined here (not as a concrete dep on agentsvc.Hub) so plugin tests can
// substitute a fake without booting the whole agent stack.
type HostExec interface {
	PushFile(ctx context.Context, serverID int64, path string, mode uint32, content []byte) error // mode: Unix octal (0644, 0755, etc.)
	// FetchURL tells the agent to download spec.URL directly (with
	// optional sha256 verify + archive extract) and install at
	// spec.Path. Replaces PushFile for large plugin binaries — the
	// WS link only carries the spec frame + one ack, not the binary
	// bytes. Path/Mode/SHA256/Extract live on the spec.
	FetchURL(ctx context.Context, serverID int64, spec agentapi.FileFetch) error
	RunCmd(ctx context.Context, serverID int64, name string, args ...string) (stdout, stderr []byte, exitCode int, err error)
	// StreamCmd runs name with args on serverID, calling onLine for each output
	// line as it arrives. onLine must not block — queue and return promptly.
	StreamCmd(ctx context.Context, serverID int64, name string, args []string, onLine func(line string)) error
}

// Plugin is the contract every compile-time plugin satisfies.
type Plugin interface {
	Meta() Meta
	// Migrations returns the migrations for the given driver. Plugins ship
	// per-driver SQL because the dialects diverge in ways that can't be
	// hidden behind a placeholder swap (e.g. INTEGER PRIMARY KEY
	// AUTOINCREMENT vs BIGSERIAL, TIMESTAMP vs TIMESTAMPTZ).
	Migrations(driver shepdb.Driver) []Migration
	RegisterRoutes(mux Mux, deps Deps)
	OnEnable(ctx context.Context, deps Deps) error
	OnDisable(ctx context.Context, deps Deps) error
}

// HostAware is implemented by plugins that deploy something to managed hosts.
//
// useMirror selects per-deploy whether the binary download URL passed
// to the agent gets wrapped with the CN mirror prefix. Each deploy
// decides independently — replaces the v0.8.7 global setting.
type HostAware interface {
	Plugin
	DeployToHost(ctx context.Context, deps Deps, serverID int64, version string, configJSON []byte, useMirror bool) error
	UndeployFromHost(ctx context.Context, deps Deps, serverID int64) error
	HostStatus(ctx context.Context, deps Deps, serverID int64) (HostStatus, error)
}

// LogStreamer is implemented by HostAware plugins that expose a tail-like
// log stream from each host (see spec §11.2).
type LogStreamer interface {
	HostAware
	LogStreamCommand(ctx context.Context, deps Deps, serverID int64) (name string, args []string, err error)
}

// DeployValidator is implemented by HostAware plugins that need to run
// sync validation (e.g. topology constraints) before the async deploy
// starts. Returning a non-nil error causes the generic /hosts POST to
// respond 409 and no deploy goroutine is spawned.
type DeployValidator interface {
	HostAware
	BeforeDeploy(ctx context.Context, deps Deps, serverID int64, topology []byte) error
}

// DeployCommitter is implemented by HostAware plugins that need to
// persist plugin-specific data after a successful deploy. Called inside
// the async deploy goroutine after DeployToHost returns nil.
type DeployCommitter interface {
	HostAware
	AfterDeploy(ctx context.Context, deps Deps, serverID int64, topology []byte) error
}

// UndeployValidator is implemented by HostAware plugins that block
// undeploy under certain conditions (e.g. landing has dependent relays).
// Returning a non-nil error causes the generic /hosts DELETE to respond
// 409 and no UndeployFromHost call is made.
type UndeployValidator interface {
	HostAware
	BeforeUndeploy(ctx context.Context, deps Deps, serverID int64) error
}

// LifecycleManager is implemented by HostAware plugins that support
// start/stop/restart of the running service (separate from deploy).
type LifecycleManager interface {
	HostAware
	StartHost(ctx context.Context, deps Deps, serverID int64) error
	StopHost(ctx context.Context, deps Deps, serverID int64) error
	RestartHost(ctx context.Context, deps Deps, serverID int64) error
}

// HostStatus is the per-host snapshot returned by HostAware.HostStatus.
// Empty State means the check has not yet run (e.g. during initial deployment).
type HostStatus struct {
	State     string // pending | deploying | running | failed | stopped
	Version   string
	Message   string
	CheckedAt time.Time
}
