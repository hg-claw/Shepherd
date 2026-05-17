// Package plugins defines the contract every compile-time plugin satisfies.
package plugins

import (
	"context"
	"net/http"
	"time"

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
}

// HostExec is the agent-side execution surface needed by HostAware plugins.
// Defined here (not as a concrete dep on agentsvc.Hub) so plugin tests can
// substitute a fake without booting the whole agent stack.
type HostExec interface {
	PushFile(ctx context.Context, serverID int64, path string, mode uint32, content []byte) error // mode: Unix octal (0644, 0755, etc.)
	RunCmd(ctx context.Context, serverID int64, name string, args ...string) (stdout, stderr []byte, exitCode int, err error)
	// StreamCmd runs name with args on serverID, calling onLine for each output
	// line as it arrives. onLine must not block — queue and return promptly.
	StreamCmd(ctx context.Context, serverID int64, name string, args []string, onLine func(line string)) error
}

// Plugin is the contract every compile-time plugin satisfies.
type Plugin interface {
	Meta() Meta
	Migrations() []Migration
	RegisterRoutes(mux Mux, deps Deps)
	OnEnable(ctx context.Context, deps Deps) error
	OnDisable(ctx context.Context, deps Deps) error
}

// HostAware is implemented by plugins that deploy something to managed hosts.
type HostAware interface {
	Plugin
	DeployToHost(ctx context.Context, deps Deps, serverID int64, configJSON []byte) error
	UndeployFromHost(ctx context.Context, deps Deps, serverID int64) error
	HostStatus(ctx context.Context, deps Deps, serverID int64) (HostStatus, error)
}

// LogStreamer is implemented by HostAware plugins that expose a tail-like
// log stream from each host (see spec §11.2).
type LogStreamer interface {
	HostAware
	LogStreamCommand(serverID int64) (name string, args []string, err error)
}

// HostStatus is the per-host snapshot returned by HostAware.HostStatus.
// Empty State means the check has not yet run (e.g. during initial deployment).
type HostStatus struct {
	State     string // pending | deploying | running | failed | stopped
	Version   string
	Message   string
	CheckedAt time.Time
}
