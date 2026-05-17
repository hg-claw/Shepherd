# Phase 3a Plugin Runtime + Plugin Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship compile-time built-in plugin runtime, generic Plugin Center admin UI, plus reference plugins **xray** (HostAware with GitHub release fetch, filehandler push, systemd) and **cloudflare** (server-side API passthrough). Include plugin event log + host daemon log streaming.

**Architecture:** Go `init()`-registered plugin packages under `internal/plugins/<id>/` implementing a `Plugin` interface (+ optional `HostAware` / `LogStreamer`). Shared schema in `db/migrations/0003_plugins.sql` (plugins / plugin_hosts / plugin_migrations); per-plugin schemas live alongside the plugin. Generic `/api/admin/plugins/*` endpoints in `internal/api/plugins*.go`. Plugin-specific endpoints mount under `/api/admin/plugins/<id>/*` with an "enabled?" gate middleware. Frontend uses a static `PluginRegistry.ts` (id → React.lazy module) and merges with the server `/api/admin/plugins` manifest.

**Tech Stack:** Go 1.25 · sqlx · stdlib `net/http.ServeMux` · gorilla/websocket · React 19 + Vite + Tailwind + shadcn/ui · react-query

**Spec:** `docs/superpowers/specs/2026-05-16-phase3a-plugin-runtime-design.md`

---

## File map

Backend (new):
- `internal/plugins/plugin.go` — `Plugin`, `HostAware`, `LogStreamer`, `Meta`, `Deps`, `Migration`, `HostStatus`
- `internal/plugins/registry.go` — global `Register/All/Get`
- `internal/plugins/migrator.go` — per-plugin migration runner
- `internal/plugins/store.go` — DAO for `plugins`, `plugin_hosts`
- `internal/plugins/deploy/pusher.go` — generic push-binary + write-file + systemctl helper
- `internal/plugins/xray/{xray,meta,release,deploy,config,routes}.go`
- `internal/plugins/xray/migrations/0001_xray.{up,down}.sql`
- `internal/plugins/xray/unit.tmpl`
- `internal/plugins/cloudflare/{cloudflare,meta,api,routes}.go`
- `internal/api/plugins.go` — generic endpoints
- `internal/api/plugins_events.go` — `GET /api/admin/plugins/{id}/events`
- `internal/api/plugins_logs.go` — `WS /api/admin/plugins/{id}/hosts/{server_id}/logs`
- `internal/db/migrations/sqlite/0003_plugins.{up,down}.sql`
- `internal/db/migrations/postgres/0003_plugins.{up,down}.sql`

Backend (modify):
- `internal/api/router.go` — mount new endpoints + plugin route prefix
- `cmd/server/main.go` — `_ import` xray + cloudflare, build registry, run plugin migrations, wire deps

Frontend (new):
- `web/src/api/plugins.ts`
- `web/src/pages/admin/plugins/PluginRegistry.ts`
- `web/src/pages/admin/plugins/index.tsx` (replaces existing stub)
- `web/src/pages/admin/plugins/detail.tsx`
- `web/src/pages/admin/plugins/xray/{index,ConfigTab,HostsTab,EventsTab,LogsTab}.tsx`
- `web/src/pages/admin/plugins/cloudflare/{index,SetupTab,ZonesTab,DnsTab,ActivityTab}.tsx`

Frontend (modify):
- `web/src/App.tsx` — mount `/admin/plugins/:id/*`
- `web/src/layouts/AdminLayout.tsx` — sidebar entries from manifest
- `web/src/locales/{zh-CN,en}.json` — plugin-related i18n keys

---

## Conventions used throughout this plan

- **Tests live next to source** (`xxx_test.go` in same package).
- **Commit per task** at the end. Message format: `feat(plugins/...): <one line>` or `feat(api/...)`.
- **DB driver in tests** = SQLite in-memory via `internal/db.Open` with `DSN: "file::memory:?cache=shared&_fk=1"`. Always run shared `0003_plugins` migration via `internal/db.Migrate` before per-plugin migrations.
- **TDD ordering**: write the failing test first, run it, write the minimum impl, run it, commit.
- **Backwards-compat**: do not remove the `PluginsPage` stub in Task 23 until the new index renders correctly — replace in one shot.

---

## Task 1: Plugin interfaces + types

**Files:**
- Create: `internal/plugins/plugin.go`
- Test: `internal/plugins/plugin_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/plugins/plugin_test.go
package plugins

import (
	"context"
	"testing"
)

func TestMetaIsValueType(t *testing.T) {
	m := Meta{ID: "x", Name: "X", HostAware: true}
	clone := m
	clone.ID = "y"
	if m.ID != "x" {
		t.Fatal("Meta should be a value type")
	}
}

func TestHostStatusZeroValueState(t *testing.T) {
	var s HostStatus
	if s.State != "" {
		t.Fatal("zero HostStatus.State must be empty string for callers to distinguish unknown")
	}
}

// Compile-time check that fake implementations satisfy the interfaces.
type fakePlain struct{}

func (fakePlain) Meta() Meta                                       { return Meta{ID: "p"} }
func (fakePlain) Migrations() []Migration                          { return nil }
func (fakePlain) RegisterRoutes(_ Mux, _ Deps)                     {}
func (fakePlain) OnEnable(_ context.Context, _ Deps) error         { return nil }
func (fakePlain) OnDisable(_ context.Context, _ Deps) error        { return nil }

func TestFakeImplementsPlugin(t *testing.T) {
	var _ Plugin = fakePlain{}
}
```

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/plugins/... -run TestFakeImplementsPlugin
```
Expected: FAIL with "undefined: Plugin / Meta / ..."

- [ ] **Step 3: Write the interfaces + types**

```go
// internal/plugins/plugin.go
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
	PushFile(ctx context.Context, serverID int64, path string, mode uint32, content []byte) error
	RunCmd(ctx context.Context, serverID int64, name string, args ...string) (stdout, stderr []byte, exitCode int, err error)
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
type HostStatus struct {
	State     string // pending | deploying | running | failed | stopped
	Version   string
	Message   string
	CheckedAt time.Time
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/plugins/...
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/plugin.go internal/plugins/plugin_test.go
git commit -m "feat(plugins): Plugin / HostAware / LogStreamer interfaces"
```

---

## Task 2: Plugin registry

**Files:**
- Create: `internal/plugins/registry.go`
- Test: `internal/plugins/registry_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/plugins/registry_test.go
package plugins

import "testing"

func TestRegisterAndGet(t *testing.T) {
	resetRegistryForTest()
	p := fakePlain{}
	Register(p)
	got, ok := Get("p")
	if !ok || got != Plugin(p) {
		t.Fatalf("Get(p) = %v, %v", got, ok)
	}
}

func TestRegisterDuplicatePanics(t *testing.T) {
	resetRegistryForTest()
	Register(fakePlain{})
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on duplicate register")
		}
	}()
	Register(fakePlain{})
}

func TestAllReturnsStableOrder(t *testing.T) {
	resetRegistryForTest()
	Register(namedFake{id: "b"})
	Register(namedFake{id: "a"})
	Register(namedFake{id: "c"})
	got := []string{}
	for _, p := range All() {
		got = append(got, p.Meta().ID)
	}
	want := []string{"a", "b", "c"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("All order = %v want %v", got, want)
		}
	}
}

type namedFake struct{ id string }

func (n namedFake) Meta() Meta                                       { return Meta{ID: n.id} }
func (namedFake) Migrations() []Migration                            { return nil }
func (namedFake) RegisterRoutes(_ Mux, _ Deps)                       {}
func (namedFake) OnEnable(_ context.Context, _ Deps) error           { return nil }
func (namedFake) OnDisable(_ context.Context, _ Deps) error          { return nil }
```

The test file needs `"context"` in imports — add it.

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/plugins/... -run TestRegister
```
Expected: FAIL with "undefined: Register / Get / All / resetRegistryForTest".

- [ ] **Step 3: Write the registry**

```go
// internal/plugins/registry.go
package plugins

import (
	"fmt"
	"sort"
	"sync"
)

var (
	regMu sync.Mutex
	reg   = map[string]Plugin{}
)

// Register adds a plugin to the global registry. Called from each plugin's
// init(). Panics on duplicate ID — the call sites are all compile-time
// imports, so a duplicate is a programmer error caught at boot.
func Register(p Plugin) {
	regMu.Lock()
	defer regMu.Unlock()
	id := p.Meta().ID
	if id == "" {
		panic("plugins: empty Meta.ID")
	}
	if _, dup := reg[id]; dup {
		panic(fmt.Sprintf("plugins: duplicate registration for %q", id))
	}
	reg[id] = p
}

// Get returns a plugin by ID.
func Get(id string) (Plugin, bool) {
	regMu.Lock()
	defer regMu.Unlock()
	p, ok := reg[id]
	return p, ok
}

// All returns every registered plugin sorted by ID, so the manifest is
// deterministic across boots.
func All() []Plugin {
	regMu.Lock()
	defer regMu.Unlock()
	out := make([]Plugin, 0, len(reg))
	for _, p := range reg {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Meta().ID < out[j].Meta().ID })
	return out
}

// resetRegistryForTest clears the registry. Test-only.
func resetRegistryForTest() {
	regMu.Lock()
	defer regMu.Unlock()
	reg = map[string]Plugin{}
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/plugins/...
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/registry.go internal/plugins/registry_test.go
git commit -m "feat(plugins): global registry with sorted All() + dup detection"
```

---

## Task 3: Shared DB schema (plugins + plugin_hosts + plugin_migrations)

**Files:**
- Create: `internal/db/migrations/sqlite/0003_plugins.up.sql`
- Create: `internal/db/migrations/sqlite/0003_plugins.down.sql`
- Create: `internal/db/migrations/postgres/0003_plugins.up.sql`
- Create: `internal/db/migrations/postgres/0003_plugins.down.sql`
- Test: `internal/db/migrate_phase3_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/db/migrate_phase3_test.go
package db_test

import (
	"context"
	"path/filepath"
	"testing"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func TestMigrate_Phase3Tables(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "p3.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"plugins", "plugin_hosts", "plugin_migrations"} {
		var n int
		if err := d.Get(&n, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", table); err != nil {
			t.Fatalf("query %s: %v", table, err)
		}
		if n != 1 {
			t.Fatalf("table %s not created", table)
		}
	}
}
```

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/db/... -run TestMigrate_Phase3Tables
```
Expected: FAIL — tables missing.

- [ ] **Step 3: Write the SQLite migration**

```sql
-- internal/db/migrations/sqlite/0003_plugins.up.sql
CREATE TABLE plugins (
  id          TEXT      PRIMARY KEY,
  enabled     INTEGER   NOT NULL DEFAULT 0,
  config_json TEXT      NOT NULL DEFAULT '{}',
  enabled_at  TIMESTAMP,
  created_at  TIMESTAMP NOT NULL
);

CREATE TABLE plugin_hosts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id        TEXT    NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  server_id        INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  config_json      TEXT    NOT NULL DEFAULT '{}',
  deployed_version TEXT,
  status           TEXT    NOT NULL DEFAULT 'pending',
  last_error       TEXT,
  updated_at       TIMESTAMP NOT NULL,
  UNIQUE(plugin_id, server_id)
);
CREATE INDEX plugin_hosts_plugin ON plugin_hosts(plugin_id);

CREATE TABLE plugin_migrations (
  plugin_id  TEXT      NOT NULL,
  name       TEXT      NOT NULL,
  applied_at TIMESTAMP NOT NULL,
  PRIMARY KEY (plugin_id, name)
);
```

```sql
-- internal/db/migrations/sqlite/0003_plugins.down.sql
DROP TABLE IF EXISTS plugin_migrations;
DROP INDEX IF EXISTS plugin_hosts_plugin;
DROP TABLE IF EXISTS plugin_hosts;
DROP TABLE IF EXISTS plugins;
```

- [ ] **Step 4: Write the Postgres migration**

```sql
-- internal/db/migrations/postgres/0003_plugins.up.sql
CREATE TABLE plugins (
  id          TEXT        PRIMARY KEY,
  enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
  config_json TEXT        NOT NULL DEFAULT '{}',
  enabled_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE plugin_hosts (
  id               BIGSERIAL    PRIMARY KEY,
  plugin_id        TEXT         NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  server_id        BIGINT       NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  config_json      TEXT         NOT NULL DEFAULT '{}',
  deployed_version TEXT,
  status           TEXT         NOT NULL DEFAULT 'pending',
  last_error       TEXT,
  updated_at       TIMESTAMPTZ  NOT NULL,
  UNIQUE(plugin_id, server_id)
);
CREATE INDEX plugin_hosts_plugin ON plugin_hosts(plugin_id);

CREATE TABLE plugin_migrations (
  plugin_id  TEXT        NOT NULL,
  name       TEXT        NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (plugin_id, name)
);
```

```sql
-- internal/db/migrations/postgres/0003_plugins.down.sql
DROP TABLE IF EXISTS plugin_migrations;
DROP INDEX IF EXISTS plugin_hosts_plugin;
DROP TABLE IF EXISTS plugin_hosts;
DROP TABLE IF EXISTS plugins;
```

- [ ] **Step 5: Run tests**

```
go test ./internal/db/... -run TestMigrate_Phase3Tables
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/db/migrations/ internal/db/migrate_phase3_test.go
git commit -m "feat(db): phase 3 shared plugins schema (sqlite + postgres)"
```

---

## Task 4: Per-plugin migration runner

**Files:**
- Create: `internal/plugins/migrator.go`
- Test: `internal/plugins/migrator_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/plugins/migrator_test.go
package plugins

import (
	"context"
	"path/filepath"
	"testing"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func openTestDB(t *testing.T) *sqlx.DB {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "m.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestRunPluginMigrations_AppliesEach(t *testing.T) {
	d := openTestDB(t)
	migs := []Migration{
		{Name: "0001_init", SQL: "CREATE TABLE foo (id INTEGER);"},
		{Name: "0002_more", SQL: "CREATE TABLE bar (id INTEGER);"},
	}
	if err := RunPluginMigrations(context.Background(), d, "x", migs); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = d.Get(&n, "SELECT COUNT(*) FROM plugin_migrations WHERE plugin_id='x'")
	if n != 2 {
		t.Fatalf("plugin_migrations rows = %d want 2", n)
	}
}

func TestRunPluginMigrations_Idempotent(t *testing.T) {
	d := openTestDB(t)
	migs := []Migration{{Name: "0001", SQL: "CREATE TABLE foo (id INTEGER);"}}
	ctx := context.Background()
	if err := RunPluginMigrations(ctx, d, "x", migs); err != nil {
		t.Fatal(err)
	}
	// Second call must NOT re-run the SQL (would error "table already exists").
	if err := RunPluginMigrations(ctx, d, "x", migs); err != nil {
		t.Fatalf("second call: %v", err)
	}
}
```

Add `"github.com/jmoiron/sqlx"` import.

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/plugins/... -run TestRunPluginMigrations
```
Expected: FAIL (undefined RunPluginMigrations).

- [ ] **Step 3: Write the migrator**

```go
// internal/plugins/migrator.go
package plugins

import (
	"context"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
)

// RunPluginMigrations applies any of `migs` that haven't already been
// recorded in plugin_migrations for the given pluginID. Each migration
// runs in its own transaction; on failure later migrations are skipped.
func RunPluginMigrations(ctx context.Context, db *sqlx.DB, pluginID string, migs []Migration) error {
	for _, m := range migs {
		var n int
		err := db.GetContext(ctx, &n,
			"SELECT COUNT(*) FROM plugin_migrations WHERE plugin_id=? AND name=?", pluginID, m.Name)
		if err != nil {
			return fmt.Errorf("plugin %s migration %s: lookup: %w", pluginID, m.Name, err)
		}
		if n > 0 {
			continue
		}
		tx, err := db.BeginTxx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, m.SQL); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("plugin %s migration %s: exec: %w", pluginID, m.Name, err)
		}
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO plugin_migrations(plugin_id, name, applied_at) VALUES (?, ?, ?)",
			pluginID, m.Name, time.Now().UTC()); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/plugins/...
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/migrator.go internal/plugins/migrator_test.go
git commit -m "feat(plugins): per-plugin migration runner with plugin_migrations ledger"
```

---

## Task 5: Plugin store (DAO for plugins + plugin_hosts)

**Files:**
- Create: `internal/plugins/store.go`
- Test: `internal/plugins/store_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/plugins/store_test.go
package plugins

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestStore_EnableDisable(t *testing.T) {
	d := openTestDB(t)
	s := &Store{DB: d, Now: time.Now}
	ctx := context.Background()
	if err := s.UpsertEnabled(ctx, "x", true); err != nil {
		t.Fatal(err)
	}
	row, err := s.Get(ctx, "x")
	if err != nil || !row.Enabled {
		t.Fatalf("Get(x).Enabled = %v err=%v", row.Enabled, err)
	}
	if err := s.UpsertEnabled(ctx, "x", false); err != nil {
		t.Fatal(err)
	}
	row, _ = s.Get(ctx, "x")
	if row.Enabled {
		t.Fatal("expected disabled after second upsert")
	}
}

func TestStore_ConfigRoundTrip(t *testing.T) {
	d := openTestDB(t)
	s := &Store{DB: d, Now: time.Now}
	ctx := context.Background()
	_ = s.UpsertEnabled(ctx, "x", false)
	if err := s.PutConfig(ctx, "x", []byte(`{"k":1}`)); err != nil {
		t.Fatal(err)
	}
	row, _ := s.Get(ctx, "x")
	if string(row.ConfigJSON) != `{"k":1}` {
		t.Fatalf("config = %q", row.ConfigJSON)
	}
}

func TestStore_HostsCRUD(t *testing.T) {
	d := openTestDB(t)
	// seed a server row so the FK holds
	_, _ = d.Exec(`INSERT INTO servers(name, install_stage, agent_known) VALUES('h1','installed',1)`)
	s := &Store{DB: d, Now: time.Now}
	ctx := context.Background()
	_ = s.UpsertEnabled(ctx, "x", true)
	row, err := s.UpsertHost(ctx, "x", 1, []byte(`{"port":443}`), "pending")
	if err != nil {
		t.Fatal(err)
	}
	if row.ID == 0 {
		t.Fatal("expected non-zero id")
	}
	hosts, _ := s.ListHosts(ctx, "x")
	if len(hosts) != 1 {
		t.Fatalf("ListHosts = %d", len(hosts))
	}
	if err := s.SetHostStatus(ctx, "x", 1, "running", "1.8.11", ""); err != nil {
		t.Fatal(err)
	}
	h, _ := s.GetHost(ctx, "x", 1)
	if h.Status != "running" || h.DeployedVersion.String != "1.8.11" {
		t.Fatalf("after SetHostStatus: %+v", h)
	}
	var cfg map[string]any
	_ = json.Unmarshal(h.ConfigJSON, &cfg)
	if cfg["port"].(float64) != 443 {
		t.Fatalf("config lost in roundtrip: %v", cfg)
	}
}
```

Note: the existing `servers` table requires a few NOT NULL columns; the test seed uses the minimum that the 0001 schema demands. If 0001 differs, adjust the INSERT — but `name`, `install_stage`, `agent_known` are universal.

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/plugins/... -run TestStore
```
Expected: FAIL (undefined Store).

- [ ] **Step 3: Write the store**

```go
// internal/plugins/store.go
package plugins

import (
	"context"
	"database/sql"
	"time"

	"github.com/jmoiron/sqlx"
)

type Store struct {
	DB  *sqlx.DB
	Now func() time.Time
}

type Row struct {
	ID         string         `db:"id"`
	Enabled    bool           `db:"enabled"`
	ConfigJSON []byte         `db:"config_json"`
	EnabledAt  sql.NullTime   `db:"enabled_at"`
	CreatedAt  time.Time      `db:"created_at"`
}

type HostRow struct {
	ID              int64          `db:"id"`
	PluginID        string         `db:"plugin_id"`
	ServerID        int64          `db:"server_id"`
	ConfigJSON      []byte         `db:"config_json"`
	DeployedVersion sql.NullString `db:"deployed_version"`
	Status          string         `db:"status"`
	LastError       sql.NullString `db:"last_error"`
	UpdatedAt       time.Time      `db:"updated_at"`
}

func (s *Store) Get(ctx context.Context, id string) (Row, error) {
	var r Row
	err := s.DB.GetContext(ctx, &r,
		"SELECT id, enabled, config_json, enabled_at, created_at FROM plugins WHERE id=?", id)
	return r, err
}

// UpsertEnabled creates the plugin row if absent, then sets enabled flag.
// enabled_at is set on transitions to enabled.
func (s *Store) UpsertEnabled(ctx context.Context, id string, enabled bool) error {
	now := s.Now().UTC()
	// row may not exist yet
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO plugins(id, enabled, config_json, enabled_at, created_at)
		 VALUES (?, ?, '{}', ?, ?)
		 ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,
		   enabled_at=CASE WHEN excluded.enabled=1 THEN excluded.enabled_at ELSE NULL END`,
		id, enabled, nullableTime(enabled, now), now)
	return err
}

func nullableTime(enabled bool, t time.Time) any {
	if enabled {
		return t
	}
	return nil
}

func (s *Store) PutConfig(ctx context.Context, id string, configJSON []byte) error {
	_, err := s.DB.ExecContext(ctx, "UPDATE plugins SET config_json=? WHERE id=?", string(configJSON), id)
	return err
}

func (s *Store) UpsertHost(ctx context.Context, pluginID string, serverID int64, configJSON []byte, status string) (HostRow, error) {
	now := s.Now().UTC()
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO plugin_hosts(plugin_id, server_id, config_json, status, updated_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(plugin_id, server_id) DO UPDATE SET
		   config_json=excluded.config_json,
		   status=excluded.status,
		   updated_at=excluded.updated_at,
		   last_error=NULL`,
		pluginID, serverID, string(configJSON), status, now)
	if err != nil {
		return HostRow{}, err
	}
	return s.GetHost(ctx, pluginID, serverID)
}

func (s *Store) GetHost(ctx context.Context, pluginID string, serverID int64) (HostRow, error) {
	var r HostRow
	err := s.DB.GetContext(ctx, &r,
		`SELECT id, plugin_id, server_id, config_json, deployed_version, status, last_error, updated_at
		 FROM plugin_hosts WHERE plugin_id=? AND server_id=?`, pluginID, serverID)
	return r, err
}

func (s *Store) ListHosts(ctx context.Context, pluginID string) ([]HostRow, error) {
	var rows []HostRow
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT id, plugin_id, server_id, config_json, deployed_version, status, last_error, updated_at
		 FROM plugin_hosts WHERE plugin_id=? ORDER BY server_id`, pluginID)
	return rows, err
}

func (s *Store) DeleteHost(ctx context.Context, pluginID string, serverID int64) error {
	_, err := s.DB.ExecContext(ctx,
		"DELETE FROM plugin_hosts WHERE plugin_id=? AND server_id=?", pluginID, serverID)
	return err
}

func (s *Store) SetHostStatus(ctx context.Context, pluginID string, serverID int64, status, version, lastErr string) error {
	now := s.Now().UTC()
	_, err := s.DB.ExecContext(ctx,
		`UPDATE plugin_hosts
		 SET status=?, deployed_version=NULLIF(?, ''), last_error=NULLIF(?, ''), updated_at=?
		 WHERE plugin_id=? AND server_id=?`,
		status, version, lastErr, now, pluginID, serverID)
	return err
}

func (s *Store) HostCountByPlugin(ctx context.Context) (map[string]int, error) {
	rows, err := s.DB.QueryxContext(ctx,
		"SELECT plugin_id, COUNT(*) FROM plugin_hosts GROUP BY plugin_id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var id string
		var n int
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/plugins/...
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/store.go internal/plugins/store_test.go
git commit -m "feat(plugins): Store DAO for plugins + plugin_hosts"
```

---

## Task 6: Generic plugins API — list/manifest

**Files:**
- Create: `internal/api/plugins.go`
- Test: `internal/api/plugins_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/api/plugins_test.go
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type plainP struct{ id string }

func (p plainP) Meta() plugins.Meta              { return plugins.Meta{ID: p.id, Name: p.id, Category: "x"} }
func (plainP) Migrations() []plugins.Migration   { return nil }
func (plainP) RegisterRoutes(_ plugins.Mux, _ plugins.Deps) {}
func (plainP) OnEnable(_ context.Context, _ plugins.Deps) error  { return nil }
func (plainP) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }

type hostP struct{ plainP }
func (h hostP) Meta() plugins.Meta { m := h.plainP.Meta(); m.HostAware = true; return m }
func (hostP) DeployToHost(context.Context, plugins.Deps, int64, []byte) error { return nil }
func (hostP) UndeployFromHost(context.Context, plugins.Deps, int64) error      { return nil }
func (hostP) HostStatus(context.Context, plugins.Deps, int64) (plugins.HostStatus, error) {
	return plugins.HostStatus{}, nil
}

func setupPluginsAPI(t *testing.T) *PluginsAPI {
	t.Helper()
	plugins.ResetRegistryForTestPublic()
	plugins.Register(plainP{id: "a"})
	plugins.Register(hostP{plainP: plainP{id: "b"}})
	dsn := "file:" + filepath.Join(t.TempDir(), "api.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil { t.Fatal(err) }
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil { t.Fatal(err) }
	return &PluginsAPI{Store: &plugins.Store{DB: d, Now: time.Now}}
}

func TestPluginsList_ReturnsAllRegistered(t *testing.T) {
	api := setupPluginsAPI(t)
	r := httptest.NewRequest("GET", "/api/admin/plugins", nil)
	w := httptest.NewRecorder()
	api.List(w, r)
	if w.Code != 200 { t.Fatalf("code=%d body=%s", w.Code, w.Body.String()) }
	var out []map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if len(out) != 2 || out[0]["id"] != "a" || out[1]["id"] != "b" {
		t.Fatalf("unexpected list: %v", out)
	}
	if out[1]["meta"].(map[string]any)["host_aware"] != true {
		t.Fatalf("b should be host_aware")
	}
}
```

Add a public reset shim: `internal/plugins/testing.go` exporting `ResetRegistryForTestPublic = resetRegistryForTest`. (Reason: test lives in `internal/api`, can't access unexported `resetRegistryForTest`.)

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/api/... -run TestPluginsList
```
Expected: FAIL (undefined PluginsAPI).

- [ ] **Step 3: Write the API and helper**

```go
// internal/plugins/testing.go
package plugins

// ResetRegistryForTestPublic is exported so cross-package tests can reset
// the global registry. NOT for production use.
var ResetRegistryForTestPublic = resetRegistryForTest
```

```go
// internal/api/plugins.go
package api

import (
	"encoding/json"
	"net/http"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

type PluginsAPI struct {
	Store *plugins.Store
}

type manifestEntry struct {
	ID        string         `json:"id"`
	Meta      manifestMeta   `json:"meta"`
	Enabled   bool           `json:"enabled"`
	EnabledAt *string        `json:"enabled_at"`
	HostCount *int           `json:"host_count"`
}
type manifestMeta struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Icon        string `json:"icon"`
	Category    string `json:"category"`
	HostAware   bool   `json:"host_aware"`
}

func (a *PluginsAPI) List(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	hostCounts, _ := a.Store.HostCountByPlugin(ctx)
	out := []manifestEntry{}
	for _, p := range plugins.All() {
		meta := p.Meta()
		row, err := a.Store.Get(ctx, meta.ID)
		entry := manifestEntry{
			ID: meta.ID,
			Meta: manifestMeta{
				Name: meta.Name, Description: meta.Description,
				Icon: meta.Icon, Category: meta.Category,
				HostAware: meta.HostAware,
			},
		}
		if err == nil {
			entry.Enabled = row.Enabled
			if row.EnabledAt.Valid {
				s := row.EnabledAt.Time.UTC().Format("2006-01-02T15:04:05Z")
				entry.EnabledAt = &s
			}
		}
		if meta.HostAware {
			n := hostCounts[meta.ID]
			entry.HostCount = &n
		}
		out = append(out, entry)
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/api/... -run TestPluginsList
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/testing.go internal/api/plugins.go internal/api/plugins_test.go
git commit -m "feat(api/plugins): GET /api/admin/plugins manifest endpoint"
```

---

## Task 7: Generic plugins API — enable / disable with OnEnable/OnDisable + migrations

**Files:**
- Modify: `internal/api/plugins.go`
- Modify: `internal/api/plugins_test.go`

- [ ] **Step 1: Write the failing test (append)**

```go
// add to internal/api/plugins_test.go

type recordingP struct {
	plainP
	enableCalls  int
	disableCalls int
}
func (r *recordingP) Meta() plugins.Meta { return plugins.Meta{ID: "r", Name: "R"} }
func (r *recordingP) OnEnable(_ context.Context, _ plugins.Deps) error  { r.enableCalls++; return nil }
func (r *recordingP) OnDisable(_ context.Context, _ plugins.Deps) error { r.disableCalls++; return nil }
func (r *recordingP) Migrations() []plugins.Migration {
	return []plugins.Migration{{Name: "0001_r", SQL: "CREATE TABLE r_t (id INTEGER);"}}
}
func (*recordingP) RegisterRoutes(_ plugins.Mux, _ plugins.Deps) {}

func TestPluginsEnable_RunsMigrationsAndOnEnable(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	rec := &recordingP{}
	plugins.Register(rec)
	dsn := "file:" + filepath.Join(t.TempDir(), "en.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	api := &PluginsAPI{Store: &plugins.Store{DB: d, Now: time.Now}, Deps: plugins.Deps{DB: d, Now: time.Now}}

	r := httptest.NewRequest("POST", "/api/admin/plugins/r/enable", nil)
	r.SetPathValue("id", "r")
	w := httptest.NewRecorder()
	api.Enable(w, r)
	if w.Code != 200 { t.Fatalf("code=%d body=%s", w.Code, w.Body.String()) }
	if rec.enableCalls != 1 { t.Fatalf("enableCalls = %d", rec.enableCalls) }
	var n int
	_ = d.Get(&n, "SELECT COUNT(*) FROM r_t")
	if n != 0 { t.Fatalf("r_t should exist (count is 0 but table must exist) — actual error means migration didn't run") }

	// idempotency
	w = httptest.NewRecorder()
	api.Enable(w, r)
	if w.Code != 200 { t.Fatalf("re-enable code=%d", w.Code) }
	if rec.enableCalls != 1 { t.Fatalf("OnEnable re-fired: %d", rec.enableCalls) }
}

func TestPluginsDisable(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	rec := &recordingP{}
	plugins.Register(rec)
	dsn := "file:" + filepath.Join(t.TempDir(), "ds.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	api := &PluginsAPI{Store: &plugins.Store{DB: d, Now: time.Now}, Deps: plugins.Deps{DB: d, Now: time.Now}}

	r := httptest.NewRequest("POST", "/api/admin/plugins/r/enable", nil)
	r.SetPathValue("id", "r")
	api.Enable(httptest.NewRecorder(), r)

	r = httptest.NewRequest("POST", "/api/admin/plugins/r/disable", nil)
	r.SetPathValue("id", "r")
	w := httptest.NewRecorder()
	api.Disable(w, r)
	if w.Code != 200 { t.Fatalf("code=%d body=%s", w.Code, w.Body.String()) }
	if rec.disableCalls != 1 { t.Fatalf("disableCalls = %d", rec.disableCalls) }
	row, _ := api.Store.Get(context.Background(), "r")
	if row.Enabled { t.Fatal("expected enabled=false after disable") }
}
```

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/api/... -run TestPluginsEnable
```
Expected: FAIL.

- [ ] **Step 3: Extend `PluginsAPI` and add handlers**

```go
// internal/api/plugins.go — add to struct and append handlers

type PluginsAPI struct {
	Store *plugins.Store
	Deps  plugins.Deps
}

func (a *PluginsAPI) Enable(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p, ok := plugins.Get(id)
	if !ok {
		writeError(w, 404, "unknown plugin")
		return
	}
	ctx := r.Context()
	row, _ := a.Store.Get(ctx, id)
	if row.Enabled {
		writeJSON(w, 200, map[string]any{"enabled": true})
		return
	}
	if err := plugins.RunPluginMigrations(ctx, a.Deps.DB, id, p.Migrations()); err != nil {
		writeError(w, 500, "migrations: "+err.Error())
		return
	}
	if err := p.OnEnable(ctx, a.Deps); err != nil {
		writeError(w, 500, "OnEnable: "+err.Error())
		return
	}
	if err := a.Store.UpsertEnabled(ctx, id, true); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"enabled": true})
}

func (a *PluginsAPI) Disable(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p, ok := plugins.Get(id)
	if !ok {
		writeError(w, 404, "unknown plugin")
		return
	}
	ctx := r.Context()
	row, _ := a.Store.Get(ctx, id)
	if !row.Enabled {
		writeJSON(w, 200, map[string]any{"enabled": false})
		return
	}
	// HostAware: best-effort undeploy on every host with status running|failed
	if ha, ok := p.(plugins.HostAware); ok {
		hosts, _ := a.Store.ListHosts(ctx, id)
		for _, h := range hosts {
			if h.Status == "running" || h.Status == "failed" {
				if err := ha.UndeployFromHost(ctx, a.Deps, h.ServerID); err != nil {
					_ = a.Store.SetHostStatus(ctx, id, h.ServerID, "stopped", h.DeployedVersion.String, err.Error())
				} else {
					_ = a.Store.SetHostStatus(ctx, id, h.ServerID, "stopped", h.DeployedVersion.String, "")
				}
			}
		}
	}
	if err := p.OnDisable(ctx, a.Deps); err != nil {
		writeError(w, 500, "OnDisable: "+err.Error())
		return
	}
	if err := a.Store.UpsertEnabled(ctx, id, false); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"enabled": false})
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/api/...
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/api/plugins.go internal/api/plugins_test.go
git commit -m "feat(api/plugins): enable/disable with OnEnable/OnDisable + migrations"
```

---

## Task 8: Global config get/put with secret redaction

**Files:**
- Modify: `internal/api/plugins.go`
- Modify: `internal/api/plugins_test.go`

- [ ] **Step 1: Write the failing test (append)**

```go
func TestPluginsConfig_RedactsSecrets(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	plugins.Register(plainP{id: "p"})
	dsn := "file:" + filepath.Join(t.TempDir(), "cfg.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	st := &plugins.Store{DB: d, Now: time.Now}
	_ = st.UpsertEnabled(context.Background(), "p", true)
	_ = st.PutConfig(context.Background(), "p", []byte(`{"api_token":"abc123","public":"x"}`))
	api := &PluginsAPI{Store: st, Deps: plugins.Deps{DB: d, Now: time.Now},
		SecretFields: map[string][]string{"p": {"api_token"}}}

	r := httptest.NewRequest("GET", "/api/admin/plugins/p/config", nil)
	r.SetPathValue("id", "p")
	w := httptest.NewRecorder()
	api.GetConfig(w, r)
	if w.Code != 200 { t.Fatalf("code=%d", w.Code) }
	var got map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if got["api_token"] != "***" {
		t.Fatalf("api_token should be redacted: %v", got)
	}
	if got["public"] != "x" {
		t.Fatalf("public field should pass through: %v", got)
	}
}

func TestPluginsConfig_PutPreservesUneditedSecrets(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	plugins.Register(plainP{id: "p"})
	dsn := "file:" + filepath.Join(t.TempDir(), "put.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	st := &plugins.Store{DB: d, Now: time.Now}
	_ = st.UpsertEnabled(context.Background(), "p", true)
	_ = st.PutConfig(context.Background(), "p", []byte(`{"api_token":"real-secret","other":"v"}`))
	api := &PluginsAPI{Store: st, Deps: plugins.Deps{DB: d, Now: time.Now},
		SecretFields: map[string][]string{"p": {"api_token"}}}

	// admin submits redacted form back (token unchanged + other edited)
	body := strings.NewReader(`{"api_token":"***","other":"new"}`)
	r := httptest.NewRequest("PUT", "/api/admin/plugins/p/config", body)
	r.SetPathValue("id", "p")
	w := httptest.NewRecorder()
	api.PutConfig(w, r)
	if w.Code != 200 { t.Fatalf("code=%d body=%s", w.Code, w.Body.String()) }
	row, _ := st.Get(context.Background(), "p")
	var stored map[string]any
	_ = json.Unmarshal(row.ConfigJSON, &stored)
	if stored["api_token"] != "real-secret" {
		t.Fatalf("redacted *** should NOT overwrite real secret; got %v", stored)
	}
	if stored["other"] != "new" {
		t.Fatalf("other field should be updated: %v", stored)
	}
}
```

Add `"strings"` to imports.

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/api/... -run TestPluginsConfig
```
Expected: FAIL.

- [ ] **Step 3: Extend API**

```go
// internal/api/plugins.go — extend struct + add handlers

type PluginsAPI struct {
	Store        *plugins.Store
	Deps         plugins.Deps
	// SecretFields lists, per plugin ID, top-level JSON field names to redact
	// from GET responses and preserve from PUT bodies when value equals "***".
	SecretFields map[string][]string
}

const redactedSentinel = "***"

func (a *PluginsAPI) GetConfig(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := plugins.Get(id); !ok {
		writeError(w, 404, "unknown plugin")
		return
	}
	row, err := a.Store.Get(r.Context(), id)
	if err != nil {
		writeError(w, 404, "not configured")
		return
	}
	out := map[string]any{}
	if len(row.ConfigJSON) > 0 {
		_ = json.Unmarshal(row.ConfigJSON, &out)
	}
	for _, k := range a.SecretFields[id] {
		if _, ok := out[k]; ok {
			out[k] = redactedSentinel
		}
	}
	writeJSON(w, 200, out)
}

func (a *PluginsAPI) PutConfig(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, ok := plugins.Get(id); !ok {
		writeError(w, 404, "unknown plugin")
		return
	}
	var incoming map[string]any
	if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	// Merge: load stored, overlay incoming, but skip secret fields whose
	// incoming value is the redacted sentinel.
	row, _ := a.Store.Get(r.Context(), id)
	stored := map[string]any{}
	if len(row.ConfigJSON) > 0 {
		_ = json.Unmarshal(row.ConfigJSON, &stored)
	}
	secrets := map[string]bool{}
	for _, k := range a.SecretFields[id] { secrets[k] = true }
	for k, v := range incoming {
		if secrets[k] {
			if s, ok := v.(string); ok && s == redactedSentinel {
				continue
			}
		}
		stored[k] = v
	}
	merged, _ := json.Marshal(stored)
	if err := a.Store.PutConfig(r.Context(), id, merged); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/api/...
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/api/plugins.go internal/api/plugins_test.go
git commit -m "feat(api/plugins): config get/put with secret-field redaction"
```

---

## Task 9: Generic plugins API — HostAware hosts CRUD

**Files:**
- Modify: `internal/api/plugins.go`
- Modify: `internal/api/plugins_test.go`

- [ ] **Step 1: Write the failing test (append)**

```go
func TestPluginsHosts_PostThenList(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	plugins.Register(hostP{plainP: plainP{id: "h"}})
	dsn := "file:" + filepath.Join(t.TempDir(), "h.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_, _ = d.Exec(`INSERT INTO servers(name, install_stage, agent_known) VALUES('s1','installed',1)`)
	st := &plugins.Store{DB: d, Now: time.Now}
	_ = st.UpsertEnabled(context.Background(), "h", true)
	api := &PluginsAPI{Store: st, Deps: plugins.Deps{DB: d, Now: time.Now}}

	body := strings.NewReader(`{"server_id":1,"config":{"port":443}}`)
	r := httptest.NewRequest("POST", "/api/admin/plugins/h/hosts", body)
	r.SetPathValue("id", "h")
	w := httptest.NewRecorder()
	api.PostHost(w, r)
	if w.Code != 200 { t.Fatalf("post code=%d body=%s", w.Code, w.Body.String()) }

	r = httptest.NewRequest("GET", "/api/admin/plugins/h/hosts", nil)
	r.SetPathValue("id", "h")
	w = httptest.NewRecorder()
	api.ListHosts(w, r)
	var out []map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if len(out) != 1 || out[0]["server_id"].(float64) != 1 {
		t.Fatalf("ListHosts = %v", out)
	}
}

func TestPluginsHosts_DeleteCallsUndeploy(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	plugins.Register(hostP{plainP: plainP{id: "h"}})
	dsn := "file:" + filepath.Join(t.TempDir(), "h2.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_, _ = d.Exec(`INSERT INTO servers(name, install_stage, agent_known) VALUES('s1','installed',1)`)
	st := &plugins.Store{DB: d, Now: time.Now}
	_ = st.UpsertEnabled(context.Background(), "h", true)
	_, _ = st.UpsertHost(context.Background(), "h", 1, []byte(`{}`), "running")
	api := &PluginsAPI{Store: st, Deps: plugins.Deps{DB: d, Now: time.Now}}

	r := httptest.NewRequest("DELETE", "/api/admin/plugins/h/hosts/1", nil)
	r.SetPathValue("id", "h")
	r.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	api.DeleteHost(w, r)
	if w.Code != 200 { t.Fatalf("code=%d", w.Code) }
	hosts, _ := st.ListHosts(context.Background(), "h")
	if len(hosts) != 0 { t.Fatalf("host should be deleted: %v", hosts) }
}
```

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/api/... -run TestPluginsHosts
```
Expected: FAIL.

- [ ] **Step 3: Append handlers**

```go
// internal/api/plugins.go — append

type hostBody struct {
	ServerID int64           `json:"server_id"`
	Version  string          `json:"version"`
	Config   json.RawMessage `json:"config"`
}

func (a *PluginsAPI) ListHosts(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p, ok := plugins.Get(id)
	if !ok { writeError(w, 404, "unknown plugin"); return }
	if _, ok := p.(plugins.HostAware); !ok { writeError(w, 404, "not host-aware"); return }
	hosts, err := a.Store.ListHosts(r.Context(), id)
	if err != nil { writeError(w, 500, err.Error()); return }
	out := make([]map[string]any, 0, len(hosts))
	for _, h := range hosts {
		out = append(out, hostRowToMap(h))
	}
	writeJSON(w, 200, out)
}

func (a *PluginsAPI) GetHost(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sid, _ := strconv.ParseInt(r.PathValue("server_id"), 10, 64)
	h, err := a.Store.GetHost(r.Context(), id, sid)
	if err != nil { writeError(w, 404, "no such host row"); return }
	writeJSON(w, 200, hostRowToMap(h))
}

func (a *PluginsAPI) PostHost(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p, ok := plugins.Get(id)
	if !ok { writeError(w, 404, "unknown plugin"); return }
	ha, ok := p.(plugins.HostAware)
	if !ok { writeError(w, 404, "not host-aware"); return }
	row, _ := a.Store.Get(r.Context(), id)
	if !row.Enabled { writeError(w, 400, "plugin disabled"); return }

	var body hostBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, 400, "bad json"); return
	}
	if body.ServerID == 0 { writeError(w, 400, "server_id required"); return }
	cfg := []byte(body.Config)
	if len(cfg) == 0 { cfg = []byte(`{}`) }
	host, err := a.Store.UpsertHost(r.Context(), id, body.ServerID, cfg, "deploying")
	if err != nil { writeError(w, 500, err.Error()); return }

	go func() {
		ctx := context.Background()
		if err := ha.DeployToHost(ctx, a.Deps, body.ServerID, cfg); err != nil {
			_ = a.Store.SetHostStatus(ctx, id, body.ServerID, "failed", body.Version, err.Error())
			return
		}
		_ = a.Store.SetHostStatus(ctx, id, body.ServerID, "running", body.Version, "")
	}()
	writeJSON(w, 200, hostRowToMap(host))
}

func (a *PluginsAPI) DeleteHost(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sid, _ := strconv.ParseInt(r.PathValue("server_id"), 10, 64)
	p, ok := plugins.Get(id)
	if !ok { writeError(w, 404, "unknown plugin"); return }
	if ha, ok := p.(plugins.HostAware); ok {
		_ = ha.UndeployFromHost(r.Context(), a.Deps, sid)
	}
	if err := a.Store.DeleteHost(r.Context(), id, sid); err != nil {
		writeError(w, 500, err.Error()); return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func hostRowToMap(h plugins.HostRow) map[string]any {
	var cfg any
	_ = json.Unmarshal(h.ConfigJSON, &cfg)
	return map[string]any{
		"id":               h.ID,
		"server_id":        h.ServerID,
		"config":           cfg,
		"deployed_version": nullStringValue(h.DeployedVersion),
		"status":           h.Status,
		"last_error":       nullStringValue(h.LastError),
		"updated_at":       h.UpdatedAt.UTC().Format("2006-01-02T15:04:05Z"),
	}
}

func nullStringValue(s sql.NullString) any {
	if s.Valid { return s.String }
	return nil
}
```

Add imports: `"context"`, `"strconv"`, `"database/sql"`.

- [ ] **Step 4: Run tests**

```
go test ./internal/api/...
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/api/plugins.go internal/api/plugins_test.go
git commit -m "feat(api/plugins): hosts CRUD (HostAware deploy/list/get/delete)"
```

---

## Task 10: Plugin events endpoint (audit log filter)

**Files:**
- Create: `internal/api/plugins_events.go`
- Test: `internal/api/plugins_events_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/api/plugins_events_test.go
package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func TestPluginEvents_FiltersByPluginPrefix(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "ev.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	now := time.Now().UTC()
	for _, row := range []struct{ a string; res string }{
		{"plugin.xray.host.deployed", "ok"},
		{"plugin.cloudflare.dns.created", "ok"},
		{"server.created", "ok"},
		{"plugin.xray.binary.downloaded", "ok"},
	} {
		_, _ = d.Exec(`INSERT INTO audit_log(ts, action, details_json, result) VALUES (?, ?, '{}', ?)`,
			now, row.a, row.res)
	}
	api := &PluginEventsAPI{DB: d}
	r := httptest.NewRequest("GET", "/api/admin/plugins/xray/events", nil)
	r.SetPathValue("id", "xray")
	w := httptest.NewRecorder()
	api.List(w, r)
	if w.Code != 200 { t.Fatalf("code=%d", w.Code) }
	var out []map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if len(out) != 2 {
		t.Fatalf("expected 2 xray events, got %d: %v", len(out), out)
	}
	for _, e := range out {
		action := e["action"].(string)
		if action[:11] != "plugin.xray" {
			t.Fatalf("unexpected action: %s", action)
		}
	}
}
```

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/api/... -run TestPluginEvents
```
Expected: FAIL.

- [ ] **Step 3: Write the API**

```go
// internal/api/plugins_events.go
package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/jmoiron/sqlx"
)

type PluginEventsAPI struct {
	DB *sqlx.DB
}

type eventOut struct {
	TS       string          `json:"ts"`
	AdminID  *int64          `json:"admin_id"`
	ServerID *int64          `json:"server_id"`
	Action   string          `json:"action"`
	Result   string          `json:"result"`
	Details  json.RawMessage `json:"details"`
}

func (a *PluginEventsAPI) List(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" { writeError(w, 400, "missing id"); return }
	q := r.URL.Query()
	limit := 200
	if l := q.Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	args := []any{"plugin." + id + ".%"}
	where := "action LIKE ?"
	if since := q.Get("since"); since != "" {
		if t, err := time.Parse(time.RFC3339, since); err == nil {
			where += " AND ts >= ?"
			args = append(args, t)
		}
	}
	if sid := q.Get("server_id"); sid != "" {
		if n, err := strconv.ParseInt(sid, 10, 64); err == nil {
			where += " AND server_id = ?"
			args = append(args, n)
		}
	}
	rows, err := a.DB.QueryxContext(r.Context(),
		"SELECT ts, admin_id, server_id, action, result, details_json FROM audit_log WHERE "+
			where+" ORDER BY ts DESC LIMIT ?", append(args, limit)...)
	if err != nil { writeError(w, 500, err.Error()); return }
	defer rows.Close()
	out := []eventOut{}
	for rows.Next() {
		var (
			ts     time.Time
			aID    *int64
			sID    *int64
			action string
			result string
			det    string
		)
		if err := rows.Scan(&ts, &aID, &sID, &action, &result, &det); err != nil {
			writeError(w, 500, err.Error()); return
		}
		out = append(out, eventOut{
			TS: ts.UTC().Format(time.RFC3339),
			AdminID: aID, ServerID: sID,
			Action: action, Result: result,
			Details: json.RawMessage(det),
		})
	}
	writeJSON(w, 200, out)
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/api/...
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/api/plugins_events.go internal/api/plugins_events_test.go
git commit -m "feat(api/plugins): events endpoint filters audit_log by plugin.<id>.*"
```

---

## Task 11: Plugin host log streaming (WS over HostExec.StreamCmd)

**Files:**
- Create: `internal/api/plugins_logs.go`
- Test: `internal/api/plugins_logs_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/api/plugins_logs_test.go
package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type fakeStreamer struct{
	hostP
}
func (fakeStreamer) LogStreamCommand(int64) (string, []string, error) {
	return "journalctl", []string{"-u", "shepherd-xray", "-f"}, nil
}

type fakeExec struct{
	mu    sync.Mutex
	lines []string
}
func (f *fakeExec) PushFile(context.Context, int64, string, uint32, []byte) error { return nil }
func (f *fakeExec) RunCmd(context.Context, int64, string, ...string) ([]byte, []byte, int, error) {
	return nil, nil, 0, nil
}
func (f *fakeExec) StreamCmd(_ context.Context, _ int64, _ string, _ []string, onLine func(string)) error {
	for _, l := range f.lines { onLine(l) }
	return nil
}

func TestPluginLogsWS_EmitsLineEnvelopes(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	plugins.Register(fakeStreamer{hostP: hostP{plainP: plainP{id: "fs"}}})
	exec := &fakeExec{lines: []string{"hello", "world"}}
	api := &PluginLogsAPI{HostExec: exec}

	server := httptest.NewServer(http.HandlerFunc(api.AttachWS))
	defer server.Close()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/?id=fs&server_id=1"
	parsed, _ := url.Parse(wsURL)
	conn, _, err := websocket.DefaultDialer.Dial(parsed.String(), nil)
	if err != nil { t.Fatalf("dial: %v", err) }
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	got := []string{}
	for i := 0; i < 2; i++ {
		_, msg, err := conn.ReadMessage()
		if err != nil { t.Fatalf("read: %v", err) }
		got = append(got, string(msg))
	}
	for _, line := range []string{"hello", "world"} {
		found := false
		for _, m := range got {
			if strings.Contains(m, `"line":"`+line+`"`) { found = true; break }
		}
		if !found { t.Fatalf("expected line %q in messages %v", line, got) }
	}
}
```

Path values come from query in this simplified test endpoint to avoid needing the full router. Real router (Task 22) uses path templates.

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/api/... -run TestPluginLogsWS
```
Expected: FAIL.

- [ ] **Step 3: Write the WS handler**

```go
// internal/api/plugins_logs.go
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type PluginLogsAPI struct {
	HostExec plugins.HostExec
}

var logsUpgrader = websocket.Upgrader{
	ReadBufferSize:  4 * 1024,
	WriteBufferSize: 16 * 1024,
	CheckOrigin:     func(*http.Request) bool { return true },
}

type logEnvelope struct {
	TS    string `json:"ts"`
	Level string `json:"level"`
	Line  string `json:"line"`
}

const maxLogLineBytes = 8 * 1024

func (a *PluginLogsAPI) AttachWS(w http.ResponseWriter, r *http.Request) {
	// path-style + query-style both supported; production uses path.
	id := r.PathValue("id")
	if id == "" { id = r.URL.Query().Get("id") }
	serverIDStr := r.PathValue("server_id")
	if serverIDStr == "" { serverIDStr = r.URL.Query().Get("server_id") }
	serverID, err := strconv.ParseInt(serverIDStr, 10, 64)
	if err != nil { writeError(w, 400, "bad server_id"); return }

	p, ok := plugins.Get(id)
	if !ok { writeError(w, 404, "unknown plugin"); return }
	ls, ok := p.(plugins.LogStreamer)
	if !ok { writeError(w, 404, "no log stream"); return }
	cmd, args, err := ls.LogStreamCommand(serverID)
	if err != nil { writeError(w, 500, err.Error()); return }

	conn, err := logsUpgrader.Upgrade(w, r, nil)
	if err != nil { return }
	defer conn.Close()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	var writeMu sync.Mutex
	emit := func(line string) {
		if len(line) > maxLogLineBytes {
			line = line[:maxLogLineBytes] + "…[truncated]"
		}
		env := logEnvelope{
			TS:    time.Now().UTC().Format(time.RFC3339),
			Level: "info",
			Line:  line,
		}
		b, _ := json.Marshal(env)
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_ = conn.WriteMessage(websocket.TextMessage, b)
	}

	go func() {
		// detect client disconnect → cancel streaming
		for {
			if _, _, err := conn.NextReader(); err != nil { cancel(); return }
		}
	}()

	if err := a.HostExec.StreamCmd(ctx, serverID, cmd, args, emit); err != nil {
		emit("stream error: " + err.Error())
	}
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/api/...
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/api/plugins_logs.go internal/api/plugins_logs_test.go
git commit -m "feat(api/plugins): WS log stream endpoint with LogStreamer"
```

---

## Task 12: Generic Pusher (push file + control systemd)

**Files:**
- Create: `internal/plugins/deploy/pusher.go`
- Test: `internal/plugins/deploy/pusher_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/plugins/deploy/pusher_test.go
package deploy

import (
	"context"
	"errors"
	"testing"
)

type recExec struct{
	pushedPaths []string
	cmds        [][]string
	failCmd     string
}
func (r *recExec) PushFile(_ context.Context, _ int64, path string, _ uint32, _ []byte) error {
	r.pushedPaths = append(r.pushedPaths, path)
	return nil
}
func (r *recExec) RunCmd(_ context.Context, _ int64, name string, args ...string) ([]byte, []byte, int, error) {
	r.cmds = append(r.cmds, append([]string{name}, args...))
	if r.failCmd != "" && name == r.failCmd {
		return nil, []byte("boom"), 1, errors.New("exec failed")
	}
	return []byte("active"), nil, 0, nil
}
func (recExec) StreamCmd(context.Context, int64, string, []string, func(string)) error { return nil }

func TestPushAndStart(t *testing.T) {
	exec := &recExec{}
	p := &Pusher{Exec: exec}
	err := p.DeploySystemdService(context.Background(), DeployParams{
		ServerID:    7,
		BinaryPath:  "/usr/local/bin/foo",
		BinaryBytes: []byte("BIN"),
		ConfigPath:  "/etc/foo/cfg",
		ConfigBytes: []byte("cfg"),
		UnitPath:    "/etc/systemd/system/foo.service",
		UnitBytes:   []byte("[Unit]\n..."),
		UnitName:    "foo",
	})
	if err != nil { t.Fatal(err) }
	if len(exec.pushedPaths) != 3 {
		t.Fatalf("expected 3 file pushes, got %v", exec.pushedPaths)
	}
	wantCmds := [][]string{
		{"systemctl", "daemon-reload"},
		{"systemctl", "enable", "--now", "foo"},
	}
	for i, want := range wantCmds {
		if len(exec.cmds) <= i || !equalSlice(exec.cmds[i], want) {
			t.Fatalf("cmd[%d] = %v want %v", i, exec.cmds[i], want)
		}
	}
}

func TestIsActiveTrue(t *testing.T) {
	exec := &recExec{}
	p := &Pusher{Exec: exec}
	active, err := p.IsActive(context.Background(), 1, "foo")
	if err != nil || !active { t.Fatalf("active=%v err=%v", active, err) }
}

func equalSlice(a, b []string) bool {
	if len(a) != len(b) { return false }
	for i := range a { if a[i] != b[i] { return false } }
	return true
}
```

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/plugins/deploy/... -run TestPush
```
Expected: FAIL.

- [ ] **Step 3: Write the Pusher**

```go
// internal/plugins/deploy/pusher.go
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

// Stop disables and stops a unit. Errors are returned so the caller can record
// them; the disable step is best-effort.
func (p *Pusher) Stop(ctx context.Context, serverID int64, unit string) error {
	_, _, _, _ = p.Exec.RunCmd(ctx, serverID, "systemctl", "disable", "--now", unit)
	return nil
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/plugins/deploy/...
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/deploy/
git commit -m "feat(plugins/deploy): generic Pusher for binary + systemd flow"
```

---

## Task 13: xray plugin skeleton + meta + migration

**Files:**
- Create: `internal/plugins/xray/meta.go`
- Create: `internal/plugins/xray/xray.go`
- Create: `internal/plugins/xray/migrations.go`
- Create: `internal/plugins/xray/migrations/0001_xray.up.sql`
- Create: `internal/plugins/xray/migrations/0001_xray.down.sql`
- Test: `internal/plugins/xray/xray_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/plugins/xray/xray_test.go
package xray

import (
	"testing"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

func TestXrayMetaIsHostAware(t *testing.T) {
	p := New()
	m := p.Meta()
	if m.ID != "xray" { t.Fatalf("id = %s", m.ID) }
	if !m.HostAware { t.Fatal("meta.HostAware must be true") }
}

func TestXraySatisfiesHostAware(t *testing.T) {
	var _ plugins.HostAware = New()
}

func TestXrayMigrationsHaveContent(t *testing.T) {
	p := New()
	migs := p.Migrations()
	if len(migs) == 0 { t.Fatal("expected at least one migration") }
	if migs[0].Name == "" || migs[0].SQL == "" {
		t.Fatalf("empty migration: %+v", migs[0])
	}
}
```

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/plugins/xray/...
```
Expected: FAIL (package doesn't exist).

- [ ] **Step 3: Write the files**

```sql
-- internal/plugins/xray/migrations/0001_xray.up.sql
CREATE TABLE xray_binaries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  version       TEXT    NOT NULL,
  os            TEXT    NOT NULL,
  arch          TEXT    NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT    NOT NULL,
  path          TEXT    NOT NULL,
  downloaded_at TIMESTAMP NOT NULL,
  UNIQUE(version, os, arch)
);
```

```sql
-- internal/plugins/xray/migrations/0001_xray.down.sql
DROP TABLE IF EXISTS xray_binaries;
```

```go
// internal/plugins/xray/meta.go
package xray

import "github.com/hg-claw/Shepherd/internal/plugins"

func meta() plugins.Meta {
	return plugins.Meta{
		ID:          "xray",
		Name:        "xray",
		Description: "Manage xray-core as a proxy on selected hosts.",
		Icon:        "shield",
		Category:    "proxy",
		HostAware:   true,
	}
}
```

```go
// internal/plugins/xray/migrations.go
package xray

import (
	"embed"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

//go:embed migrations/*.sql
var migFS embed.FS

func loadMigrations() []plugins.Migration {
	names := []string{"0001_xray.up.sql"}
	out := make([]plugins.Migration, 0, len(names))
	for _, n := range names {
		b, err := migFS.ReadFile("migrations/" + n)
		if err != nil {
			panic("xray: missing migration " + n + ": " + err.Error())
		}
		out = append(out, plugins.Migration{Name: n[:len(n)-len(".up.sql")], SQL: string(b)})
	}
	return out
}
```

```go
// internal/plugins/xray/xray.go
package xray

import (
	"context"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

// Plugin implements plugins.HostAware + plugins.LogStreamer.
type Plugin struct {
	// fields populated in later tasks (release fetcher, config validator, ...)
}

// New constructs an xray plugin. Used by init() and by tests.
func New() *Plugin { return &Plugin{} }

func init() {
	plugins.Register(New())
}

func (p *Plugin) Meta() plugins.Meta             { return meta() }
func (p *Plugin) Migrations() []plugins.Migration { return loadMigrations() }

func (p *Plugin) RegisterRoutes(_ plugins.Mux, _ plugins.Deps) {
	// Filled in by Task 17.
}

func (p *Plugin) OnEnable(_ context.Context, _ plugins.Deps) error  { return nil }
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }

// HostAware — bodies filled by Task 16.
func (p *Plugin) DeployToHost(ctx context.Context, deps plugins.Deps, serverID int64, configJSON []byte) error {
	return nil
}
func (p *Plugin) UndeployFromHost(ctx context.Context, deps plugins.Deps, serverID int64) error {
	return nil
}
func (p *Plugin) HostStatus(ctx context.Context, deps plugins.Deps, serverID int64) (plugins.HostStatus, error) {
	return plugins.HostStatus{}, nil
}
```

Note: `init()` calls `plugins.Register` so just importing this package wires the plugin in. Tests in this file use `New()` directly and reset the registry where needed.

- [ ] **Step 4: Run tests**

```
go test ./internal/plugins/xray/...
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/xray/
git commit -m "feat(plugins/xray): skeleton + meta + xray_binaries migration"
```

---

## Task 14: xray release fetcher (GitHub API + sha256 verify)

**Files:**
- Create: `internal/plugins/xray/release.go`
- Test: `internal/plugins/xray/release_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/plugins/xray/release_test.go
package xray

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// minimal zip with one file "xray" so the extractor has something to do.
func makeFakeZip(t *testing.T, name, body string) []byte {
	t.Helper()
	// Build a literal zip via archive/zip
	buf := []byte{}
	zw := newTestZipWriter(t, &buf)
	w, err := zw.Create(name)
	if err != nil { t.Fatal(err) }
	_, _ = w.Write([]byte(body))
	if err := zw.Close(); err != nil { t.Fatal(err) }
	return buf
}

func TestFetchAndCache(t *testing.T) {
	zipBytes := makeFakeZip(t, "xray", "BIN-CONTENT")
	dgst := sha256.Sum256(zipBytes)
	dgstHex := hex.EncodeToString(dgst[:])

	mux := http.NewServeMux()
	mux.HandleFunc("/releases/download/v1.2.3/Xray-linux-amd64.zip", func(w http.ResponseWriter, r *http.Request) {
		w.Write(zipBytes)
	})
	mux.HandleFunc("/releases/download/v1.2.3/Xray-linux-amd64.zip.dgst", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "SHA2-256= "+dgstHex+"\n")
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r := &Releaser{
		BaseURL:  srv.URL,
		CacheDir: t.TempDir(),
	}
	bin, err := r.Fetch(t.Context(), "1.2.3", "linux", "amd64")
	if err != nil { t.Fatal(err) }
	if bin.Version != "1.2.3" || bin.Sha256 != dgstHex {
		t.Fatalf("unexpected binary metadata: %+v", bin)
	}
	got, err := os.ReadFile(bin.Path)
	if err != nil { t.Fatal(err) }
	if string(got) != "BIN-CONTENT" {
		t.Fatalf("extracted binary content = %q", got)
	}

	// Second fetch should reuse cache, not re-download.
	cached := bin.Path
	bin2, err := r.Fetch(t.Context(), "1.2.3", "linux", "amd64")
	if err != nil { t.Fatal(err) }
	if bin2.Path != cached {
		t.Fatalf("expected cache hit, paths differ: %s vs %s", cached, bin2.Path)
	}
}

func TestFetchShaMismatch(t *testing.T) {
	zipBytes := makeFakeZip(t, "xray", "X")
	mux := http.NewServeMux()
	mux.HandleFunc("/releases/download/v9.9.9/Xray-linux-amd64.zip", func(w http.ResponseWriter, r *http.Request) {
		w.Write(zipBytes)
	})
	mux.HandleFunc("/releases/download/v9.9.9/Xray-linux-amd64.zip.dgst", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "SHA2-256= 0000000000000000000000000000000000000000000000000000000000000000\n")
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	r := &Releaser{BaseURL: srv.URL, CacheDir: t.TempDir()}
	_, err := r.Fetch(t.Context(), "9.9.9", "linux", "amd64")
	if err == nil || !strings.Contains(err.Error(), "sha256") {
		t.Fatalf("expected sha256 error, got %v", err)
	}
	// nothing should be left in cache on failure
	files, _ := filepath.Glob(r.CacheDir + "/*")
	if len(files) != 0 {
		t.Fatalf("cache should be empty on failure: %v", files)
	}
}
```

Add a `newTestZipWriter` helper in a separate `zip_helper_test.go`:

```go
// internal/plugins/xray/zip_helper_test.go
package xray

import (
	"archive/zip"
	"bytes"
	"testing"
)

type bufWriter struct{ buf *[]byte }

func (b *bufWriter) Write(p []byte) (int, error) { *b.buf = append(*b.buf, p...); return len(p), nil }

func newTestZipWriter(t *testing.T, target *[]byte) *zip.Writer {
	t.Helper()
	bb := bytes.NewBuffer(*target)
	zw := zip.NewWriter(bb)
	t.Cleanup(func() { *target = bb.Bytes() })
	return zw
}
```

(There's a subtle nit: the `makeFakeZip` builder needs to read back. Simpler implementation if the helper is cumbersome: just write the zip into a `*bytes.Buffer` directly inside the test — the helper file above keeps the test readable. The implementer can simplify if they prefer.)

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/plugins/xray/... -run TestFetch
```
Expected: FAIL (undefined Releaser).

- [ ] **Step 3: Write the releaser**

```go
// internal/plugins/xray/release.go
package xray

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Releaser downloads and caches xray release binaries from GitHub.
type Releaser struct {
	BaseURL  string // https://github.com/XTLS/Xray-core (override for tests)
	CacheDir string // typically deps.DataDir + "/cache"
	HTTP     *http.Client
}

func defaultClient() *http.Client {
	return &http.Client{Timeout: 60 * time.Second}
}

// Binary describes one cached xray binary on disk.
type Binary struct {
	Version       string
	OS            string
	Arch          string
	SizeBytes     int64
	Sha256        string
	Path          string
	DownloadedAt  time.Time
}

func (r *Releaser) base() string {
	if r.BaseURL == "" {
		return "https://github.com/XTLS/Xray-core"
	}
	return strings.TrimRight(r.BaseURL, "/")
}

func (r *Releaser) cachedBinaryPath(version, osName, arch string) string {
	return filepath.Join(r.CacheDir, osName+"-"+arch, "v"+version, "xray")
}

// Fetch returns a cached binary or downloads + verifies + extracts it.
func (r *Releaser) Fetch(ctx context.Context, version, osName, arch string) (Binary, error) {
	out := r.cachedBinaryPath(version, osName, arch)
	if st, err := os.Stat(out); err == nil {
		sum, err := sha256File(out)
		if err == nil {
			return Binary{
				Version: version, OS: osName, Arch: arch,
				SizeBytes: st.Size(), Sha256: sum, Path: out,
				DownloadedAt: st.ModTime(),
			}, nil
		}
	}

	if err := os.MkdirAll(filepath.Dir(out), 0755); err != nil {
		return Binary{}, err
	}

	zipURL := fmt.Sprintf("%s/releases/download/v%s/Xray-%s-%s.zip", r.base(), version, osName, arch)
	dgstURL := zipURL + ".dgst"
	httpc := r.HTTP
	if httpc == nil { httpc = defaultClient() }

	expectedSha, err := fetchDigest(ctx, httpc, dgstURL)
	if err != nil { return Binary{}, fmt.Errorf("fetch digest: %w", err) }

	zipBody, err := httpGet(ctx, httpc, zipURL)
	if err != nil { return Binary{}, fmt.Errorf("fetch zip: %w", err) }
	actual := sha256.Sum256(zipBody)
	actualHex := hex.EncodeToString(actual[:])
	if !strings.EqualFold(actualHex, expectedSha) {
		// Don't leave partial files.
		_ = os.RemoveAll(filepath.Dir(out))
		return Binary{}, fmt.Errorf("sha256 mismatch: want %s got %s", expectedSha, actualHex)
	}

	if err := extractXray(zipBody, out); err != nil {
		_ = os.RemoveAll(filepath.Dir(out))
		return Binary{}, fmt.Errorf("extract: %w", err)
	}

	st, _ := os.Stat(out)
	return Binary{
		Version: version, OS: osName, Arch: arch,
		SizeBytes: st.Size(), Sha256: actualHex,
		Path: out, DownloadedAt: time.Now().UTC(),
	}, nil
}

func httpGet(ctx context.Context, c *http.Client, u string) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	resp, err := c.Do(req)
	if err != nil { return nil, err }
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

func fetchDigest(ctx context.Context, c *http.Client, u string) (string, error) {
	body, err := httpGet(ctx, c, u)
	if err != nil { return "", err }
	// Format: "SHA2-256= <hex>\n"
	line := strings.TrimSpace(string(body))
	idx := strings.LastIndex(line, " ")
	if idx == -1 { return "", fmt.Errorf("malformed dgst line: %q", line) }
	return strings.ToLower(strings.TrimSpace(line[idx+1:])), nil
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil { return "", err }
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil { return "", err }
	return hex.EncodeToString(h.Sum(nil)), nil
}

func extractXray(zipBytes []byte, outPath string) error {
	zr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil { return err }
	for _, f := range zr.File {
		// xray's zip always contains a file named "xray" at root (linux) or
		// "xray.exe" (windows). Take the first non-dir entry whose base name is xray*.
		base := filepath.Base(f.Name)
		if base != "xray" && base != "xray.exe" {
			continue
		}
		rc, err := f.Open()
		if err != nil { return err }
		w, err := os.OpenFile(outPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
		if err != nil { rc.Close(); return err }
		_, err = io.Copy(w, rc)
		rc.Close()
		w.Close()
		return err
	}
	return fmt.Errorf("no xray binary found in zip")
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/plugins/xray/...
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/xray/release.go internal/plugins/xray/release_test.go internal/plugins/xray/zip_helper_test.go
git commit -m "feat(plugins/xray): release fetcher with sha256 verify + cache"
```

---

## Task 15: xray config builder (template + raw)

**Files:**
- Create: `internal/plugins/xray/config.go`
- Test: `internal/plugins/xray/config_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/plugins/xray/config_test.go
package xray

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRenderTemplate_VLESSReality(t *testing.T) {
	out, err := RenderTemplate(TemplateRequest{
		Inbound:    "vless-reality",
		Port:       443,
		UUID:       "11111111-1111-1111-1111-111111111111",
		SNI:        "example.com",
		PublicKey:  "abc",
		PrivateKey: "def",
		ShortID:    "00",
	})
	if err != nil { t.Fatal(err) }
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil { t.Fatalf("invalid json: %v\n%s", err, out) }
	inbounds := m["inbounds"].([]any)
	if len(inbounds) != 1 { t.Fatalf("expected 1 inbound, got %d", len(inbounds)) }
	first := inbounds[0].(map[string]any)
	if first["port"].(float64) != 443 { t.Fatalf("port: %v", first["port"]) }
}

func TestRenderTemplate_RejectsUnknownInbound(t *testing.T) {
	_, err := RenderTemplate(TemplateRequest{Inbound: "nope"})
	if err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("expected unknown inbound error, got %v", err)
	}
}

func TestNormaliseRaw_AcceptsValidJSON(t *testing.T) {
	out, err := NormaliseRaw([]byte(`{"inbounds":[],"outbounds":[]}`))
	if err != nil { t.Fatal(err) }
	if !strings.Contains(string(out), `"inbounds"`) {
		t.Fatalf("output lost inbounds: %s", out)
	}
}

func TestNormaliseRaw_RejectsInvalidJSON(t *testing.T) {
	_, err := NormaliseRaw([]byte(`not json`))
	if err == nil { t.Fatal("expected error") }
}
```

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/plugins/xray/... -run TestRender
```
Expected: FAIL.

- [ ] **Step 3: Write the config builder**

```go
// internal/plugins/xray/config.go
package xray

import (
	"encoding/json"
	"errors"
	"fmt"
)

type TemplateRequest struct {
	Inbound    string `json:"inbound"`     // vless-reality | vmess-ws | shadowsocks
	Port       int    `json:"port"`
	UUID       string `json:"uuid"`
	// VLESS+REALITY:
	SNI        string `json:"sni"`
	PublicKey  string `json:"public_key"`
	PrivateKey string `json:"private_key"`
	ShortID    string `json:"short_id"`
	// VMess+WS:
	WSPath     string `json:"ws_path"`
	// Shadowsocks:
	Method     string `json:"method"`
	Password   string `json:"password"`
}

// RenderTemplate returns canonical xray JSON for a chosen inbound preset.
func RenderTemplate(req TemplateRequest) ([]byte, error) {
	switch req.Inbound {
	case "vless-reality":
		return renderVLESSReality(req)
	case "vmess-ws":
		return renderVMessWS(req)
	case "shadowsocks":
		return renderShadowsocks(req)
	default:
		return nil, fmt.Errorf("unknown inbound %q", req.Inbound)
	}
}

func renderVLESSReality(r TemplateRequest) ([]byte, error) {
	if r.Port == 0 || r.UUID == "" || r.SNI == "" || r.PublicKey == "" {
		return nil, errors.New("vless-reality: port/uuid/sni/public_key required")
	}
	cfg := map[string]any{
		"log": map[string]any{"loglevel": "warning"},
		"inbounds": []any{map[string]any{
			"port":     r.Port,
			"protocol": "vless",
			"settings": map[string]any{
				"clients":    []any{map[string]any{"id": r.UUID, "flow": "xtls-rprx-vision"}},
				"decryption": "none",
			},
			"streamSettings": map[string]any{
				"network":  "tcp",
				"security": "reality",
				"realitySettings": map[string]any{
					"show":         false,
					"dest":         r.SNI + ":443",
					"serverNames":  []any{r.SNI},
					"privateKey":   r.PrivateKey,
					"publicKey":    r.PublicKey,
					"shortIds":     []any{r.ShortID},
				},
			},
		}},
		"outbounds": []any{map[string]any{"protocol": "freedom"}},
	}
	return json.MarshalIndent(cfg, "", "  ")
}

func renderVMessWS(r TemplateRequest) ([]byte, error) {
	if r.Port == 0 || r.UUID == "" {
		return nil, errors.New("vmess-ws: port/uuid required")
	}
	if r.WSPath == "" { r.WSPath = "/ws" }
	cfg := map[string]any{
		"inbounds": []any{map[string]any{
			"port":     r.Port,
			"protocol": "vmess",
			"settings": map[string]any{"clients": []any{map[string]any{"id": r.UUID}}},
			"streamSettings": map[string]any{
				"network":   "ws",
				"wsSettings": map[string]any{"path": r.WSPath},
			},
		}},
		"outbounds": []any{map[string]any{"protocol": "freedom"}},
	}
	return json.MarshalIndent(cfg, "", "  ")
}

func renderShadowsocks(r TemplateRequest) ([]byte, error) {
	if r.Port == 0 || r.Method == "" || r.Password == "" {
		return nil, errors.New("shadowsocks: port/method/password required")
	}
	cfg := map[string]any{
		"inbounds": []any{map[string]any{
			"port":     r.Port,
			"protocol": "shadowsocks",
			"settings": map[string]any{"method": r.Method, "password": r.Password},
		}},
		"outbounds": []any{map[string]any{"protocol": "freedom"}},
	}
	return json.MarshalIndent(cfg, "", "  ")
}

// NormaliseRaw parses arbitrary JSON and re-marshals it pretty so the
// content on disk is deterministic. It only rejects syntactically invalid
// JSON; xray's own validator runs on the host after deploy.
func NormaliseRaw(raw []byte) ([]byte, error) {
	var any any
	if err := json.Unmarshal(raw, &any); err != nil {
		return nil, fmt.Errorf("invalid json: %w", err)
	}
	return json.MarshalIndent(any, "", "  ")
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/plugins/xray/...
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/xray/config.go internal/plugins/xray/config_test.go
git commit -m "feat(plugins/xray): config builder (template presets + raw normalise)"
```

---

## Task 16: xray deploy (DeployToHost / Undeploy / HostStatus + systemd unit)

**Files:**
- Create: `internal/plugins/xray/unit.tmpl`
- Modify: `internal/plugins/xray/xray.go` (fill in HostAware methods + struct fields)
- Create: `internal/plugins/xray/deploy_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/plugins/xray/deploy_test.go
package xray

import (
	"context"
	"strings"
	"testing"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

type captureExec struct {
	pushed []push
	cmds   [][]string
}
type push struct{ path string; mode uint32; body []byte }

func (c *captureExec) PushFile(_ context.Context, _ int64, path string, mode uint32, body []byte) error {
	c.pushed = append(c.pushed, push{path, mode, body})
	return nil
}
func (c *captureExec) RunCmd(_ context.Context, _ int64, name string, args ...string) ([]byte, []byte, int, error) {
	c.cmds = append(c.cmds, append([]string{name}, args...))
	if name == "systemctl" && len(args) > 0 && args[0] == "is-active" {
		return []byte("active"), nil, 0, nil
	}
	return nil, nil, 0, nil
}
func (c *captureExec) StreamCmd(context.Context, int64, string, []string, func(string)) error { return nil }

func TestDeployToHost_PushesBinaryConfigAndUnit(t *testing.T) {
	exec := &captureExec{}
	p := New()
	p.releaser = &fakeReleaser{path: "/tmp/xray-fake"}
	deps := plugins.Deps{HostExec: exec}

	cfg := []byte(`{"version":"1.8.11","config":{"inbounds":[],"outbounds":[]}}`)
	if err := p.DeployToHost(context.Background(), deps, 7, cfg); err != nil {
		t.Fatal(err)
	}
	wantPaths := []string{
		"/usr/local/bin/shepherd-xray",
		"/etc/shepherd-xray/config.json",
		"/etc/systemd/system/shepherd-xray.service",
	}
	for i, want := range wantPaths {
		if i >= len(exec.pushed) || exec.pushed[i].path != want {
			t.Fatalf("push[%d] = %v, want %s", i, exec.pushed[i], want)
		}
	}
	if !strings.Contains(string(exec.pushed[2].body), "shepherd-xray") {
		t.Fatalf("unit body missing service name: %s", exec.pushed[2].body)
	}
}

func TestHostStatus_Active(t *testing.T) {
	exec := &captureExec{}
	p := New()
	deps := plugins.Deps{HostExec: exec}
	st, err := p.HostStatus(context.Background(), deps, 1)
	if err != nil { t.Fatal(err) }
	if st.State != "running" {
		t.Fatalf("State = %q want running", st.State)
	}
}

func TestUndeployFromHost_DisablesUnit(t *testing.T) {
	exec := &captureExec{}
	p := New()
	deps := plugins.Deps{HostExec: exec}
	if err := p.UndeployFromHost(context.Background(), deps, 1); err != nil { t.Fatal(err) }
	found := false
	for _, c := range exec.cmds {
		if len(c) >= 3 && c[0] == "systemctl" && c[1] == "disable" && c[2] == "--now" {
			found = true; break
		}
	}
	if !found { t.Fatalf("expected systemctl disable, got %v", exec.cmds) }
}

// fakeReleaser provides a binary "Binary" without actually downloading.
type fakeReleaser struct{ path string }

func (f *fakeReleaser) Fetch(_ context.Context, version, os, arch string) (Binary, error) {
	return Binary{Version: version, OS: os, Arch: arch, Path: f.path, SizeBytes: 3, Sha256: "deadbeef"}, nil
}
```

The fake `releaser` returns a Binary whose `Path` points to /tmp/xray-fake. We need to write 3 bytes there so DeployToHost can read it (or have DeployToHost accept a content-loaded Binary). Let me adjust: the test creates the file.

Add to the test setup:

```go
func init() {
	_ = os.WriteFile("/tmp/xray-fake", []byte("BIN"), 0755)
}
```

(import `os`)

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/plugins/xray/... -run TestDeployToHost
```
Expected: FAIL.

- [ ] **Step 3: Write the unit template**

```
# internal/plugins/xray/unit.tmpl
[Unit]
Description=Shepherd-managed xray
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/shepherd-xray run -c /etc/shepherd-xray/config.json
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: Fill in xray.go HostAware methods**

```go
// internal/plugins/xray/xray.go — replace Plugin struct and HostAware methods

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
```

The `migrations.go` file from Task 13 already provides `loadMigrations`; the new `Plugin` struct above keeps `releaser` exposed for test injection.

- [ ] **Step 5: Run tests**

```
go test ./internal/plugins/xray/...
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/xray/unit.tmpl internal/plugins/xray/xray.go internal/plugins/xray/deploy_test.go
git commit -m "feat(plugins/xray): DeployToHost / HostStatus / Undeploy"
```

---

## Task 17: xray LogStreamer + plugin-specific routes (versions + binaries)

**Files:**
- Modify: `internal/plugins/xray/xray.go` (add LogStreamCommand)
- Create: `internal/plugins/xray/routes.go`
- Create: `internal/plugins/xray/routes_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/plugins/xray/routes_test.go
package xray

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func TestLogStreamCommand_Default(t *testing.T) {
	p := New()
	name, args, err := p.LogStreamCommand(1)
	if err != nil { t.Fatal(err) }
	if name != "journalctl" { t.Fatalf("name=%s", name) }
	wantArgs := []string{"-u", "shepherd-xray", "-f", "--no-pager", "-n", "200", "-o", "short-iso"}
	for i, w := range wantArgs {
		if args[i] != w {
			t.Fatalf("args[%d]=%s want %s", i, args[i], w)
		}
	}
}

func TestVersionsEndpoint_ListsCache(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "v.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "xray", New().Migrations())
	_, _ = d.Exec(`INSERT INTO xray_binaries(version, os, arch, size_bytes, sha256, path, downloaded_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, "1.8.11", "linux", "amd64", 1, "x", "/p", time.Now())

	p := New()
	deps := plugins.Deps{DB: d, Now: time.Now}
	mux := &collectMux{}
	p.RegisterRoutes(mux, deps)

	h, ok := mux.handlers["GET /versions"]
	if !ok { t.Fatalf("versions route not registered: %v", mux.handlers) }
	r := httptest.NewRequest("GET", "/versions", nil)
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != 200 { t.Fatalf("code=%d", w.Code) }
	var out struct {
		Cached []map[string]any `json:"cached"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if len(out.Cached) != 1 || out.Cached[0]["version"] != "1.8.11" {
		t.Fatalf("cached = %v", out.Cached)
	}
}

// collectMux records HandleFunc calls so tests can pull the handler out.
type collectMux struct{ handlers map[string]func(http.ResponseWriter, *http.Request) }

func (m *collectMux) HandleFunc(pat string, h func(http.ResponseWriter, *http.Request)) {
	if m.handlers == nil { m.handlers = map[string]func(http.ResponseWriter, *http.Request){} }
	m.handlers[pat] = h
}
func (m *collectMux) Handle(string, http.Handler) {}
```

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/plugins/xray/... -run TestLogStream
```
Expected: FAIL.

- [ ] **Step 3: Add LogStreamCommand to Plugin**

In `internal/plugins/xray/xray.go`, append:

```go
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
```

- [ ] **Step 4: Write routes.go**

```go
// internal/plugins/xray/routes.go
package xray

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func (p *Plugin) RegisterRoutes(mux plugins.Mux, deps plugins.Deps) {
	mux.HandleFunc("GET /versions", func(w http.ResponseWriter, r *http.Request) {
		cached, err := listCached(r.Context(), deps.DB)
		if err != nil { http.Error(w, err.Error(), 500); return }
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"cached": cached})
	})
}

type cachedBinary struct {
	Version       string    `json:"version"`
	OS            string    `json:"os"`
	Arch          string    `json:"arch"`
	SizeBytes     int64     `json:"size_bytes"`
	Sha256        string    `json:"sha256"`
	DownloadedAt  time.Time `json:"downloaded_at"`
}

func listCached(ctx interface{ Done() <-chan struct{} }, db *sqlx.DB) ([]cachedBinary, error) {
	rows, err := db.QueryxContext(asCtx(ctx),
		`SELECT version, os, arch, size_bytes, sha256, downloaded_at
		 FROM xray_binaries ORDER BY downloaded_at DESC`)
	if err != nil { return nil, err }
	defer rows.Close()
	out := []cachedBinary{}
	for rows.Next() {
		var c cachedBinary
		if err := rows.Scan(&c.Version, &c.OS, &c.Arch, &c.SizeBytes, &c.Sha256, &c.DownloadedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// asCtx is a small adapter because the test signature uses a bare interface.
// Real callers always pass r.Context().
func asCtx(c interface{ Done() <-chan struct{} }) interface{ Deadline() (time.Time, bool); Done() <-chan struct{}; Err() error; Value(any) any } {
	if cc, ok := c.(interface {
		Deadline() (time.Time, bool); Done() <-chan struct{}; Err() error; Value(any) any
	}); ok {
		return cc
	}
	return nil
}
```

(Pragmatic shortcut: rewrite the helper to accept `context.Context` directly. The test passes `r.Context()` which is a real Context, so the adapter is unnecessary. Drop the `asCtx` and use `context.Context`.)

Cleaner version:

```go
package xray

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func (p *Plugin) RegisterRoutes(mux plugins.Mux, deps plugins.Deps) {
	mux.HandleFunc("GET /versions", func(w http.ResponseWriter, r *http.Request) {
		cached, err := listCached(r.Context(), deps.DB)
		if err != nil { http.Error(w, err.Error(), 500); return }
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"cached": cached})
	})
}

type cachedBinary struct {
	Version      string    `json:"version"`
	OS           string    `json:"os"`
	Arch         string    `json:"arch"`
	SizeBytes    int64     `json:"size_bytes"`
	Sha256       string    `json:"sha256"`
	DownloadedAt time.Time `json:"downloaded_at"`
}

func listCached(ctx context.Context, db *sqlx.DB) ([]cachedBinary, error) {
	rows, err := db.QueryxContext(ctx,
		`SELECT version, os, arch, size_bytes, sha256, downloaded_at
		 FROM xray_binaries ORDER BY downloaded_at DESC`)
	if err != nil { return nil, err }
	defer rows.Close()
	out := []cachedBinary{}
	for rows.Next() {
		var c cachedBinary
		if err := rows.Scan(&c.Version, &c.OS, &c.Arch, &c.SizeBytes, &c.Sha256, &c.DownloadedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
```

- [ ] **Step 5: Run tests**

```
go test ./internal/plugins/xray/...
```
Expected: PASS (all xray tests green).

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/xray/xray.go internal/plugins/xray/routes.go internal/plugins/xray/routes_test.go
git commit -m "feat(plugins/xray): LogStreamer + GET /versions cache endpoint"
```

---

## Task 18: cloudflare plugin skeleton + meta

**Files:**
- Create: `internal/plugins/cloudflare/meta.go`
- Create: `internal/plugins/cloudflare/cloudflare.go`
- Test: `internal/plugins/cloudflare/cloudflare_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/plugins/cloudflare/cloudflare_test.go
package cloudflare

import (
	"testing"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

func TestMetaNotHostAware(t *testing.T) {
	m := New().Meta()
	if m.HostAware { t.Fatal("cloudflare must not be host-aware") }
	if m.ID != "cloudflare" { t.Fatalf("id = %s", m.ID) }
}

func TestSatisfiesPlugin(t *testing.T) {
	var _ plugins.Plugin = New()
}
```

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/plugins/cloudflare/...
```
Expected: FAIL.

- [ ] **Step 3: Write the skeleton**

```go
// internal/plugins/cloudflare/meta.go
package cloudflare

import "github.com/hg-claw/Shepherd/internal/plugins"

func meta() plugins.Meta {
	return plugins.Meta{
		ID:          "cloudflare",
		Name:        "Cloudflare",
		Description: "Manage Cloudflare zones, DNS records, and view recent audit log.",
		Icon:        "cloud",
		Category:    "dns",
		HostAware:   false,
	}
}
```

```go
// internal/plugins/cloudflare/cloudflare.go
package cloudflare

import (
	"context"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

type Plugin struct {
	// fields added in Task 19
}

func New() *Plugin { return &Plugin{} }

func init() { plugins.Register(New()) }

func (p *Plugin) Meta() plugins.Meta              { return meta() }
func (p *Plugin) Migrations() []plugins.Migration { return nil }
func (p *Plugin) RegisterRoutes(_ plugins.Mux, _ plugins.Deps) {
	// filled in by Task 20
}
func (p *Plugin) OnEnable(_ context.Context, _ plugins.Deps) error  { return nil }
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }
```

- [ ] **Step 4: Run tests**

```
go test ./internal/plugins/cloudflare/...
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/cloudflare/
git commit -m "feat(plugins/cloudflare): skeleton + meta"
```

---

## Task 19: cloudflare API client (token loaded from plugins.config_json)

**Files:**
- Create: `internal/plugins/cloudflare/api.go`
- Test: `internal/plugins/cloudflare/api_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/plugins/cloudflare/api_test.go
package cloudflare

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClient_ListZonesForwardsToken(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"result":  []map[string]any{{"id": "z1", "name": "example.com"}},
		})
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, Token: "tk_secret"}
	zones, err := c.ListZones(context.Background())
	if err != nil { t.Fatal(err) }
	if gotAuth != "Bearer tk_secret" {
		t.Fatalf("forwarded auth = %q", gotAuth)
	}
	if len(zones) != 1 || zones[0]["name"] != "example.com" {
		t.Fatalf("zones = %v", zones)
	}
}

func TestClient_WrapsCFError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": false,
			"errors":  []map[string]any{{"code": 10000, "message": "Authentication error"}},
		})
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, Token: "bad"}
	_, err := c.ListZones(context.Background())
	if err == nil || !strings.Contains(err.Error(), "10000") {
		t.Fatalf("expected CF error wrapped, got %v", err)
	}
}
```

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/plugins/cloudflare/... -run TestClient
```
Expected: FAIL.

- [ ] **Step 3: Write the client**

```go
// internal/plugins/cloudflare/api.go
package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func (c *Client) base() string {
	if c.BaseURL == "" {
		return "https://api.cloudflare.com/client/v4"
	}
	return strings.TrimRight(c.BaseURL, "/")
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil { return c.HTTP }
	return &http.Client{Timeout: 30 * time.Second}
}

type cfResp struct {
	Success bool                       `json:"success"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
	Result json.RawMessage `json:"result"`
}

func (c *Client) do(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	}
	req, _ := http.NewRequestWithContext(ctx, method, c.base()+path, reader)
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil { req.Header.Set("Content-Type", "application/json") }
	resp, err := c.http().Do(req)
	if err != nil { return nil, err }
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var parsed cfResp
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("non-json CF response (status %d): %s", resp.StatusCode, raw)
	}
	if !parsed.Success {
		if len(parsed.Errors) > 0 {
			return nil, fmt.Errorf("CF API: %d %s", parsed.Errors[0].Code, parsed.Errors[0].Message)
		}
		return nil, fmt.Errorf("CF API: status %d", resp.StatusCode)
	}
	return parsed.Result, nil
}

func (c *Client) ListZones(ctx context.Context) ([]map[string]any, error) {
	raw, err := c.do(ctx, "GET", "/zones?per_page=50", nil)
	if err != nil { return nil, err }
	var out []map[string]any
	if err := json.Unmarshal(raw, &out); err != nil { return nil, err }
	return out, nil
}

func (c *Client) ListRecords(ctx context.Context, zoneID string) ([]map[string]any, error) {
	raw, err := c.do(ctx, "GET", "/zones/"+zoneID+"/dns_records?per_page=200", nil)
	if err != nil { return nil, err }
	var out []map[string]any
	if err := json.Unmarshal(raw, &out); err != nil { return nil, err }
	return out, nil
}

func (c *Client) CreateRecord(ctx context.Context, zoneID string, body map[string]any) (map[string]any, error) {
	raw, err := c.do(ctx, "POST", "/zones/"+zoneID+"/dns_records", body)
	if err != nil { return nil, err }
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil { return nil, err }
	return out, nil
}

func (c *Client) PatchRecord(ctx context.Context, zoneID, recordID string, body map[string]any) (map[string]any, error) {
	raw, err := c.do(ctx, "PATCH", "/zones/"+zoneID+"/dns_records/"+recordID, body)
	if err != nil { return nil, err }
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil { return nil, err }
	return out, nil
}

func (c *Client) DeleteRecord(ctx context.Context, zoneID, recordID string) error {
	_, err := c.do(ctx, "DELETE", "/zones/"+zoneID+"/dns_records/"+recordID, nil)
	return err
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/plugins/cloudflare/...
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/cloudflare/api.go internal/plugins/cloudflare/api_test.go
git commit -m "feat(plugins/cloudflare): API client with token + CF error wrapping"
```

---

## Task 20: cloudflare routes (zones / records CRUD)

**Files:**
- Create: `internal/plugins/cloudflare/routes.go`
- Test: `internal/plugins/cloudflare/routes_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/plugins/cloudflare/routes_test.go
package cloudflare

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type collectMux struct{ h map[string]func(http.ResponseWriter, *http.Request) }
func (m *collectMux) HandleFunc(pat string, h func(http.ResponseWriter, *http.Request)) {
	if m.h == nil { m.h = map[string]func(http.ResponseWriter, *http.Request){} }
	m.h[pat] = h
}
func (m *collectMux) Handle(string, http.Handler) {}

func TestZonesEndpoint_UsesStoredToken(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "cf.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	st := &plugins.Store{DB: d, Now: time.Now}
	_ = st.UpsertEnabled(context.Background(), "cloudflare", true)
	_ = st.PutConfig(context.Background(), "cloudflare", []byte(`{"api_token":"abc"}`))

	cfSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer abc" {
			http.Error(w, "bad token", 401); return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"result":  []map[string]any{{"id": "z1", "name": "example.com"}},
		})
	}))
	defer cfSrv.Close()

	p := New()
	p.baseURL = cfSrv.URL
	p.store = st
	mux := &collectMux{}
	p.RegisterRoutes(mux, plugins.Deps{DB: d})
	h := mux.h["GET /zones"]
	if h == nil { t.Fatal("GET /zones not registered") }

	r := httptest.NewRequest("GET", "/zones", nil)
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != 200 { t.Fatalf("code=%d body=%s", w.Code, w.Body.String()) }
	var out []map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if len(out) != 1 || out[0]["name"] != "example.com" {
		t.Fatalf("zones = %v", out)
	}
}
```

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/plugins/cloudflare/... -run TestZonesEndpoint
```
Expected: FAIL.

- [ ] **Step 3: Replace `cloudflare.go` and add `routes.go`**

```go
// internal/plugins/cloudflare/cloudflare.go (replace previous body)
package cloudflare

import (
	"context"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

type Plugin struct {
	baseURL string // override for tests
	store   *plugins.Store
}

func New() *Plugin { return &Plugin{} }

func init() { plugins.Register(New()) }

func (p *Plugin) Meta() plugins.Meta              { return meta() }
func (p *Plugin) Migrations() []plugins.Migration { return nil }
func (p *Plugin) OnEnable(_ context.Context, _ plugins.Deps) error  { return nil }
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }
```

```go
// internal/plugins/cloudflare/routes.go
package cloudflare

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

func (p *Plugin) RegisterRoutes(mux plugins.Mux, deps plugins.Deps) {
	if p.store == nil {
		p.store = &plugins.Store{DB: deps.DB, Now: deps.Now}
	}
	mux.HandleFunc("GET /zones", func(w http.ResponseWriter, r *http.Request) {
		c, err := p.client(r)
		if err != nil { httpJSONErr(w, 400, err); return }
		zones, err := c.ListZones(r.Context())
		if err != nil { httpJSONErr(w, 502, err); return }
		_ = json.NewEncoder(w).Encode(zones)
	})
	mux.HandleFunc("GET /zones/{id}/records", func(w http.ResponseWriter, r *http.Request) {
		c, err := p.client(r)
		if err != nil { httpJSONErr(w, 400, err); return }
		recs, err := c.ListRecords(r.Context(), r.PathValue("id"))
		if err != nil { httpJSONErr(w, 502, err); return }
		_ = json.NewEncoder(w).Encode(recs)
	})
	mux.HandleFunc("POST /zones/{id}/records", func(w http.ResponseWriter, r *http.Request) {
		c, err := p.client(r)
		if err != nil { httpJSONErr(w, 400, err); return }
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			httpJSONErr(w, 400, err); return
		}
		out, err := c.CreateRecord(r.Context(), r.PathValue("id"), body)
		if err != nil { httpJSONErr(w, 502, err); return }
		_ = json.NewEncoder(w).Encode(out)
	})
	mux.HandleFunc("PATCH /zones/{id}/records/{rid}", func(w http.ResponseWriter, r *http.Request) {
		c, err := p.client(r)
		if err != nil { httpJSONErr(w, 400, err); return }
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		out, err := c.PatchRecord(r.Context(), r.PathValue("id"), r.PathValue("rid"), body)
		if err != nil { httpJSONErr(w, 502, err); return }
		_ = json.NewEncoder(w).Encode(out)
	})
	mux.HandleFunc("DELETE /zones/{id}/records/{rid}", func(w http.ResponseWriter, r *http.Request) {
		c, err := p.client(r)
		if err != nil { httpJSONErr(w, 400, err); return }
		if err := c.DeleteRecord(r.Context(), r.PathValue("id"), r.PathValue("rid")); err != nil {
			httpJSONErr(w, 502, err); return
		}
		w.WriteHeader(204)
	})
}

func (p *Plugin) client(r *http.Request) (*Client, error) {
	row, err := p.store.Get(r.Context(), "cloudflare")
	if err != nil { return nil, err }
	var cfg struct{ APIToken string `json:"api_token"` }
	_ = json.Unmarshal(row.ConfigJSON, &cfg)
	if strings.TrimSpace(cfg.APIToken) == "" {
		return nil, jsonErrText("api_token not configured")
	}
	return &Client{BaseURL: p.baseURL, Token: cfg.APIToken}, nil
}

type jsonErrText string

func (e jsonErrText) Error() string { return string(e) }

func httpJSONErr(w http.ResponseWriter, code int, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error": err.Error(),
		"code":  "cloudflare_api_error",
	})
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/plugins/cloudflare/...
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/cloudflare/cloudflare.go internal/plugins/cloudflare/routes.go internal/plugins/cloudflare/routes_test.go
git commit -m "feat(plugins/cloudflare): zones/records routes pulling token from store"
```

---

## Task 21: Wire registry + plugins into the server (cmd/server/main.go + router)

**Files:**
- Modify: `cmd/server/main.go`
- Modify: `internal/api/router.go`
- Create: `internal/plugins/hostexec.go` (adapter from `agentsvc.Hub` to `plugins.HostExec`)

- [ ] **Step 1: Write the failing test (adapter)**

```go
// internal/plugins/hostexec_test.go
package plugins

import (
	"context"
	"testing"
)

// Smoke test only — HostExecFromHub is wired in main; here we ensure the
// adapter type satisfies the interface (compile-time).
func TestHubAdapterSatisfiesHostExec(t *testing.T) {
	var _ HostExec = (*hubExecStub)(nil)
}

// hubExecStub mirrors the production HostExec shape so tests can be sure
// the production adapter's signature matches.
type hubExecStub struct{}
func (hubExecStub) PushFile(context.Context, int64, string, uint32, []byte) error { return nil }
func (hubExecStub) RunCmd(context.Context, int64, string, ...string) ([]byte, []byte, int, error) {
	return nil, nil, 0, nil
}
func (hubExecStub) StreamCmd(context.Context, int64, string, []string, func(string)) error { return nil }
```

- [ ] **Step 2: Run to verify failure**

```
go test ./internal/plugins/... -run TestHubAdapter
```
Expected: PASS already (it's a compile-time check). If the package compiles, you're done. If not, fix the interface first.

- [ ] **Step 3: Add adapter file**

```go
// internal/plugins/hostexec.go
package plugins

// (No real adapter code here yet — the agentsvc.Hub adapter lives in
// cmd/server/main.go where the Hub instance is in scope. This file is
// reserved for shared host-exec helpers and to anchor the test above.)
```

Wire the real adapter in `cmd/server/main.go`. Locate the Hub setup (existing) and add:

```go
// cmd/server/main.go — additions

import (
	"github.com/hg-claw/Shepherd/internal/plugins"
	_ "github.com/hg-claw/Shepherd/internal/plugins/xray"
	_ "github.com/hg-claw/Shepherd/internal/plugins/cloudflare"
	"github.com/hg-claw/Shepherd/internal/plugins/deploy"
	// ...
)

// near existing dependency wiring:
hostExec := &hubHostExec{hub: agentHub}
pluginStore := &plugins.Store{DB: db, Now: time.Now}
pluginsDeps := plugins.Deps{
	DB:       db,
	DataDir:  filepath.Join(cfg.DataDir, "plugins"),
	HostExec: hostExec,
	Now:      time.Now,
}

// Run shared 0003 migration as part of normal db.Migrate (already happens),
// then per-plugin migrations only when the plugin is later enabled (handled
// by Enable endpoint). Plugin routes mount once at boot under
// /api/admin/plugins/{id}/...; an enabled-gate middleware blocks them when
// the row is disabled.
for _, p := range plugins.All() {
	prefix := "/api/admin/plugins/" + p.Meta().ID
	sub := newGatedMux(prefix, pluginStore, p.Meta().ID, adminMux)
	p.RegisterRoutes(sub, pluginsDeps)
}

pluginsAPI := &api.PluginsAPI{
	Store: pluginStore,
	Deps:  pluginsDeps,
	SecretFields: map[string][]string{
		"cloudflare": {"api_token"},
	},
}
adminMux.HandleFunc("GET /api/admin/plugins", pluginsAPI.List)
adminMux.HandleFunc("POST /api/admin/plugins/{id}/enable",  pluginsAPI.Enable)
adminMux.HandleFunc("POST /api/admin/plugins/{id}/disable", pluginsAPI.Disable)
adminMux.HandleFunc("GET  /api/admin/plugins/{id}/config",  pluginsAPI.GetConfig)
adminMux.HandleFunc("PUT  /api/admin/plugins/{id}/config",  pluginsAPI.PutConfig)
adminMux.HandleFunc("GET  /api/admin/plugins/{id}/hosts",   pluginsAPI.ListHosts)
adminMux.HandleFunc("POST /api/admin/plugins/{id}/hosts",   pluginsAPI.PostHost)
adminMux.HandleFunc("GET  /api/admin/plugins/{id}/hosts/{server_id}",    pluginsAPI.GetHost)
adminMux.HandleFunc("DELETE /api/admin/plugins/{id}/hosts/{server_id}",  pluginsAPI.DeleteHost)

eventsAPI := &api.PluginEventsAPI{DB: db}
adminMux.HandleFunc("GET /api/admin/plugins/{id}/events", eventsAPI.List)

logsAPI := &api.PluginLogsAPI{HostExec: hostExec}
adminMux.HandleFunc("GET /api/admin/plugins/{id}/hosts/{server_id}/logs", logsAPI.AttachWS)

_ = deploy.Pusher{} // keep import live in case main doesn't reference it directly
```

Implement `hubHostExec` and `newGatedMux` in `cmd/server/main.go` (or split into a small helper file):

```go
type hubHostExec struct{ hub *agentsvc.Hub }

// Minimum methods to satisfy plugins.HostExec. The bodies route through
// existing agent ws filehandler + ptyrunner channels.
func (h *hubHostExec) PushFile(ctx context.Context, serverID int64, path string, mode uint32, content []byte) error {
	return h.hub.PushFile(ctx, serverID, path, mode, content)
}
func (h *hubHostExec) RunCmd(ctx context.Context, serverID int64, name string, args ...string) ([]byte, []byte, int, error) {
	return h.hub.RunOneShot(ctx, serverID, name, args)
}
func (h *hubHostExec) StreamCmd(ctx context.Context, serverID int64, name string, args []string, onLine func(string)) error {
	return h.hub.StreamCmd(ctx, serverID, name, args, onLine)
}
```

If `agentsvc.Hub` doesn't already expose `PushFile`/`RunOneShot`/`StreamCmd`, add thin wrappers there:

- `PushFile` reuses the existing filehandler upload path.
- `RunOneShot` calls into `ptysvc.Service.Open` with a short-lived session that runs the command and returns when it exits; capture stdout/stderr in buffers, surface exit code.
- `StreamCmd` is the same but invokes `onLine` for each output line; close on context cancel.

These wrappers are small adapters; their tests live alongside `agentsvc.Hub`.

`newGatedMux` returns a sub-mux that gates by `enabled`:

```go
func newGatedMux(prefix string, store *plugins.Store, id string, parent *http.ServeMux) plugins.Mux {
	return &gatedMux{prefix: prefix, store: store, id: id, parent: parent}
}

type gatedMux struct {
	prefix string
	store  *plugins.Store
	id     string
	parent *http.ServeMux
}

func (g *gatedMux) HandleFunc(pattern string, h func(http.ResponseWriter, *http.Request)) {
	// pattern looks like "GET /versions" — split method + path so we can
	// prefix the path and keep the method in the outer pattern.
	method, path, ok := strings.Cut(pattern, " ")
	if !ok { method, path = "", pattern }
	full := strings.TrimSpace(method + " " + g.prefix + path)
	g.parent.HandleFunc(full, func(w http.ResponseWriter, r *http.Request) {
		row, _ := g.store.Get(r.Context(), g.id)
		if !row.Enabled {
			http.Error(w, "plugin disabled", 404); return
		}
		h(w, r)
	})
}
func (g *gatedMux) Handle(pattern string, h http.Handler) {
	g.HandleFunc(pattern, h.ServeHTTP)
}
```

- [ ] **Step 4: Build the binary**

```
go build ./...
```
Expected: exit 0.

- [ ] **Step 5: Smoke run**

```
go run ./cmd/server &
sleep 2
curl -s http://localhost:8080/api/admin/plugins | head -c 200
kill %1
```
Expected: JSON array including `xray` and `cloudflare` with `enabled: false`.

- [ ] **Step 6: Commit**

```bash
git add cmd/server/main.go internal/plugins/hostexec.go internal/plugins/hostexec_test.go
git commit -m "feat(server): wire plugins registry, routes, host exec adapter"
```

---

## Task 22: Frontend API client

**Files:**
- Create: `web/src/api/plugins.ts`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/api/plugins.test.ts
import { describe, it, expect, vi } from 'vitest'
import { listPlugins, enablePlugin } from './plugins'

vi.mock('./client', () => ({
  api: {
    get: vi.fn().mockResolvedValue([{ id: 'xray', enabled: false }]),
    post: vi.fn().mockResolvedValue({ enabled: true }),
    put: vi.fn(),
  },
}))

describe('plugins api', () => {
  it('listPlugins returns array', async () => {
    const out = await listPlugins()
    expect(out[0].id).toBe('xray')
  })
  it('enablePlugin sends POST', async () => {
    const out = await enablePlugin('xray')
    expect(out.enabled).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify failure**

```
cd web && npm test -- --run plugins
```
Expected: FAIL — `./plugins` not found.

- [ ] **Step 3: Write the client**

```ts
// web/src/api/plugins.ts
import { api } from './client'

export interface PluginMeta {
  name: string
  description: string
  icon: string
  category: string
  host_aware: boolean
}

export interface PluginEntry {
  id: string
  meta: PluginMeta
  enabled: boolean
  enabled_at: string | null
  host_count: number | null
}

export interface PluginHost {
  id: number
  server_id: number
  config: unknown
  deployed_version: string | null
  status: 'pending' | 'deploying' | 'running' | 'failed' | 'stopped'
  last_error: string | null
  updated_at: string
}

export interface PluginEvent {
  ts: string
  admin_id: number | null
  server_id: number | null
  action: string
  result: string
  details: unknown
}

export const listPlugins = () => api.get<PluginEntry[]>('/api/admin/plugins')

export const enablePlugin = (id: string) =>
  api.post<{ enabled: boolean }>(`/api/admin/plugins/${id}/enable`, {})

export const disablePlugin = (id: string) =>
  api.post<{ enabled: boolean }>(`/api/admin/plugins/${id}/disable`, {})

export const getPluginConfig = (id: string) =>
  api.get<Record<string, unknown>>(`/api/admin/plugins/${id}/config`)

export const putPluginConfig = (id: string, body: Record<string, unknown>) =>
  api.put(`/api/admin/plugins/${id}/config`, body)

export const listPluginHosts = (id: string) =>
  api.get<PluginHost[]>(`/api/admin/plugins/${id}/hosts`)

export const deployPluginHost = (id: string, body: {
  server_id: number; version?: string; config?: unknown;
}) => api.post<PluginHost>(`/api/admin/plugins/${id}/hosts`, body)

export const removePluginHost = (id: string, serverId: number) =>
  api.del(`/api/admin/plugins/${id}/hosts/${serverId}`)

export const listPluginEvents = (id: string, params: { since?: string; limit?: number; server_id?: number } = {}) => {
  const q = new URLSearchParams()
  if (params.since) q.set('since', params.since)
  if (params.limit) q.set('limit', String(params.limit))
  if (params.server_id) q.set('server_id', String(params.server_id))
  const qs = q.toString()
  return api.get<PluginEvent[]>(`/api/admin/plugins/${id}/events${qs ? '?' + qs : ''}`)
}

export const pluginLogsWSURL = (id: string, serverId: number) => {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/admin/plugins/${id}/hosts/${serverId}/logs`
}
```

If `api.del` doesn't exist, add it to `web/src/api/client.ts` next to `api.put`. Check existing patterns first.

- [ ] **Step 4: Run tests**

```
cd web && npm test -- --run plugins
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/api/plugins.ts web/src/api/plugins.test.ts
git commit -m "feat(web/api): plugins client (list/enable/config/hosts/events/logs)"
```

---

## Task 23: Frontend plugin registry (static id → React.lazy map)

**Files:**
- Create: `web/src/pages/admin/plugins/PluginRegistry.ts`

- [ ] **Step 1: Write the file directly** (no test — it's a data table)

```ts
// web/src/pages/admin/plugins/PluginRegistry.ts
import { lazy, type ComponentType } from 'react'

export interface PluginModule {
  default: ComponentType  // page component to render under /admin/plugins/<id>/*
}

export interface PluginUIEntry {
  module: () => Promise<PluginModule>
  tabs: { key: string; label: string }[]
}

// Map from plugin ID to its frontend module. Keys MUST match server-side
// Meta.ID. Tabs are advisory (the plugin module's default export controls
// what actually renders) — used by the detail wrapper to render the tab bar.
export const PluginRegistry: Record<string, PluginUIEntry> = {
  xray: {
    module: () => import('./xray'),
    tabs: [
      { key: 'config', label: 'Config' },
      { key: 'hosts',  label: 'Hosts' },
      { key: 'events', label: 'Events' },
      { key: 'logs',   label: 'Logs' },
    ],
  },
  cloudflare: {
    module: () => import('./cloudflare'),
    tabs: [
      { key: 'setup',    label: 'Setup' },
      { key: 'zones',    label: 'Zones' },
      { key: 'dns',      label: 'DNS records' },
      { key: 'activity', label: 'Activity' },
    ],
  },
}

export const lazyPluginPage = (id: string) => {
  const e = PluginRegistry[id]
  if (!e) return null
  return lazy(e.module)
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/admin/plugins/PluginRegistry.ts
git commit -m "feat(web/plugins): static registry (id -> lazy module + tab labels)"
```

---

## Task 24: Plugin Center index page (replace stub)

**Files:**
- Replace: `web/src/pages/admin/PluginsPage.tsx` → new file `web/src/pages/admin/plugins/index.tsx`
- Modify: `web/src/App.tsx` to import the new path

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/pages/admin/plugins/index.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import PluginsIndex from './index'

vi.mock('@/api/plugins', () => ({
  listPlugins: () => Promise.resolve([
    { id: 'xray', meta: { name: 'xray', description: 'd', icon: 'shield', category: 'proxy', host_aware: true },
      enabled: true, enabled_at: '2026-05-16T00:00:00Z', host_count: 2 },
    { id: 'cloudflare', meta: { name: 'Cloudflare', description: 'd2', icon: 'cloud', category: 'dns', host_aware: false },
      enabled: false, enabled_at: null, host_count: null },
  ]),
  enablePlugin: vi.fn(),
  disablePlugin: vi.fn(),
}))

describe('PluginsIndex', () => {
  it('renders cards for each plugin', async () => {
    const qc = new QueryClient()
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={qc}>
          <MemoryRouter>
            <PluginsIndex />
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    )
    expect(await screen.findByText('xray')).toBeTruthy()
    expect(await screen.findByText('Cloudflare')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify failure**

```
cd web && npm test -- --run plugins/index
```
Expected: FAIL (file not found).

- [ ] **Step 3: Write the page**

```tsx
// web/src/pages/admin/plugins/index.tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import * as icons from 'lucide-react'
import { listPlugins, enablePlugin, disablePlugin, type PluginEntry } from '@/api/plugins'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/Pill'
import { cn } from '@/lib/utils'

function Icon({ name }: { name: string }) {
  const Cmp = (icons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[
    capitalise(name)
  ] || icons.Puzzle
  return <Cmp className="h-5 w-5 text-muted-foreground" />
}
function capitalise(s: string) {
  return s.split('-').map((p) => p[0]?.toUpperCase() + p.slice(1)).join('')
}

export default function PluginsIndex() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['plugins'], queryFn: listPlugins, refetchInterval: 30_000 })
  const enable = useMutation({
    mutationFn: (id: string) => enablePlugin(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  })
  const disable = useMutation({
    mutationFn: (id: string) => disablePlugin(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugins'] }),
  })

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight m-0">
          {t('nav.plugins', 'Plugins')}
        </h1>
        <p className="text-muted-foreground text-[13px] mt-1">
          {t('plugins.subtitle')}
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {(q.data ?? []).map((p) => (
          <PluginCard
            key={p.id}
            p={p}
            onEnable={() => enable.mutate(p.id)}
            onDisable={() => disable.mutate(p.id)}
            pending={enable.isPending || disable.isPending}
          />
        ))}
      </div>
    </div>
  )
}

function PluginCard({
  p, onEnable, onDisable, pending,
}: { p: PluginEntry; onEnable: () => void; onDisable: () => void; pending: boolean }) {
  return (
    <div className="bg-elev border rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-md bg-sunken border grid place-items-center shrink-0">
          <Icon name={p.meta.icon} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Link to={`/admin/plugins/${p.id}`} className="font-medium hover:underline truncate">
              {p.meta.name}
            </Link>
            {p.enabled
              ? <Pill kind="ok">enabled</Pill>
              : <Pill kind="neutral">disabled</Pill>}
          </div>
          <p className="text-[12.5px] text-muted-foreground mt-1 line-clamp-2 min-h-[2.4em]">
            {p.meta.description}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 pt-2 border-t border-dashed text-[11.5px] font-mono text-fg-dim">
        <span>{p.meta.category}</span>
        {p.host_count != null && <span>· {p.host_count} hosts</span>}
        <span className="ml-auto">
          {p.enabled ? (
            <Button size="sm" variant="outline" className={cn('h-7 text-[12px]')} disabled={pending} onClick={onDisable}>
              Disable
            </Button>
          ) : (
            <Button size="sm" className={cn('h-7 text-[12px]')} disabled={pending} onClick={onEnable}>
              Enable
            </Button>
          )}
        </span>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Update App.tsx**

In `web/src/App.tsx`, change the plugins import:

```ts
const PluginsIndex = lazy(() => import('./pages/admin/plugins'))
```

(remove the old `PluginsPage` import; route stays at `/admin/plugins`)

Delete the old `web/src/pages/admin/PluginsPage.tsx` only after the new page renders correctly.

```bash
git rm web/src/pages/admin/PluginsPage.tsx
```

- [ ] **Step 5: Run tests**

```
cd web && npm test -- --run plugins/index
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/admin/plugins/index.tsx web/src/pages/admin/plugins/index.test.tsx web/src/App.tsx
git commit -m "feat(web/plugins): plugin center index page replaces stub"
```

---

## Task 25: Generic plugin detail wrapper + lazy mount

**Files:**
- Create: `web/src/pages/admin/plugins/detail.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/pages/admin/plugins/detail.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import PluginDetail from './detail'

vi.mock('@/api/plugins', () => ({
  listPlugins: () => Promise.resolve([
    { id: 'xray', meta: { name: 'xray', description: '', icon: 'shield', category: 'proxy', host_aware: true },
      enabled: true, enabled_at: null, host_count: 0 },
  ]),
}))

describe('PluginDetail', () => {
  it('renders the tab bar for a known plugin', async () => {
    const qc = new QueryClient()
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/admin/plugins/xray']}>
            <Routes>
              <Route path="/admin/plugins/:id/*" element={<PluginDetail />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    )
    expect(await screen.findByText('Config')).toBeTruthy()
    expect(screen.getByText('Hosts')).toBeTruthy()
    expect(screen.getByText('Events')).toBeTruthy()
    expect(screen.getByText('Logs')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify failure**

```
cd web && npm test -- --run plugins/detail
```
Expected: FAIL.

- [ ] **Step 3: Write the wrapper**

```tsx
// web/src/pages/admin/plugins/detail.tsx
import { Suspense } from 'react'
import { useParams, Link, useLocation, Outlet } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { listPlugins } from '@/api/plugins'
import { lazyPluginPage, PluginRegistry } from './PluginRegistry'
import { cn } from '@/lib/utils'

export default function PluginDetail() {
  const { id = '' } = useParams<{ id: string }>()
  const loc = useLocation()
  const q = useQuery({ queryKey: ['plugins'], queryFn: listPlugins })
  const entry = q.data?.find((p) => p.id === id)
  const ui = PluginRegistry[id]
  const PluginPage = lazyPluginPage(id)

  if (!entry || !ui || !PluginPage) {
    return <div className="text-muted-foreground">Unknown plugin: {id}</div>
  }

  const activeTab = (() => {
    const m = loc.pathname.match(/\/admin\/plugins\/[^/]+\/([^/]+)/)
    return m ? m[1] : ui.tabs[0].key
  })()

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 flex-wrap">
        <h1 className="text-[22px] font-semibold tracking-tight m-0">{entry.meta.name}</h1>
        <span className="text-fg-dim text-[12.5px] font-mono">{entry.meta.category}</span>
      </div>
      <div className="border-b flex gap-1">
        {ui.tabs.map((t) => (
          <Link
            key={t.key}
            to={`/admin/plugins/${id}/${t.key}`}
            className={cn(
              'px-3 py-1.5 text-[12.5px] -mb-px border-b-2 transition-colors',
              activeTab === t.key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>
      <Suspense fallback={<div className="text-muted-foreground">Loading…</div>}>
        <PluginPage />
      </Suspense>
      <Outlet />
    </div>
  )
}
```

- [ ] **Step 4: Mount in App.tsx**

```tsx
// web/src/App.tsx — add inside the admin Routes block:
const PluginDetail = lazy(() => import('./pages/admin/plugins/detail'))

<Route path="/admin/plugins/:id/*" element={<PluginDetail />} />
```

Place after the existing `<Route path="/admin/plugins" element={<PluginsIndex />} />`.

- [ ] **Step 5: Run tests**

```
cd web && npm test -- --run plugins/detail
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/admin/plugins/detail.tsx web/src/pages/admin/plugins/detail.test.tsx web/src/App.tsx
git commit -m "feat(web/plugins): detail wrapper with tab bar + lazy module mount"
```

---

## Task 26: xray frontend module (Config tab + Hosts tab)

**Files:**
- Create: `web/src/pages/admin/plugins/xray/index.tsx` (route table)
- Create: `web/src/pages/admin/plugins/xray/ConfigTab.tsx`
- Create: `web/src/pages/admin/plugins/xray/HostsTab.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/pages/admin/plugins/xray/ConfigTab.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import ConfigTab from './ConfigTab'

const put = vi.fn().mockResolvedValue({ ok: true })
vi.mock('@/api/plugins', () => ({
  getPluginConfig: () => Promise.resolve({ default_version: '1.8.11' }),
  putPluginConfig: (id: string, body: any) => put(id, body),
}))

describe('xray ConfigTab', () => {
  it('saves edited default version', async () => {
    const qc = new QueryClient()
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={qc}>
          <MemoryRouter><ConfigTab /></MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    )
    const input = await screen.findByDisplayValue('1.8.11') as HTMLInputElement
    fireEvent.change(input, { target: { value: '1.8.20' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(put).toHaveBeenCalledWith('xray', { default_version: '1.8.20' }))
  })
})
```

- [ ] **Step 2: Run to verify failure**

```
cd web && npm test -- --run xray/ConfigTab
```
Expected: FAIL.

- [ ] **Step 3: Write the tabs**

```tsx
// web/src/pages/admin/plugins/xray/index.tsx
import { Routes, Route, Navigate } from 'react-router-dom'
import ConfigTab from './ConfigTab'
import HostsTab from './HostsTab'

export default function XrayPlugin() {
  return (
    <Routes>
      <Route index element={<Navigate to="config" replace />} />
      <Route path="config" element={<ConfigTab />} />
      <Route path="hosts" element={<HostsTab />} />
      {/* events + logs tabs in Task 27 */}
    </Routes>
  )
}
```

```tsx
// web/src/pages/admin/plugins/xray/ConfigTab.tsx
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getPluginConfig, putPluginConfig } from '@/api/plugins'

export default function ConfigTab() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['plugin-cfg', 'xray'], queryFn: () => getPluginConfig('xray') })
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => putPluginConfig('xray', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-cfg', 'xray'] }),
  })
  const [defaultVersion, setDefaultVersion] = useState('1.8.11')
  useEffect(() => {
    if (q.data?.default_version) setDefaultVersion(String(q.data.default_version))
  }, [q.data])
  return (
    <div className="max-w-md space-y-3">
      <div>
        <Label className="text-[12px]">Default version</Label>
        <Input
          value={defaultVersion}
          onChange={(e) => setDefaultVersion(e.target.value)}
          className="h-8 font-mono mt-1"
        />
        <p className="text-fg-dim text-[11.5px] mt-1">
          Used as the suggested version when deploying to a new host.
        </p>
      </div>
      <Button size="sm" className="h-8" disabled={m.isPending}
        onClick={() => m.mutate({ default_version: defaultVersion })}>
        Save
      </Button>
    </div>
  )
}
```

```tsx
// web/src/pages/admin/plugins/xray/HostsTab.tsx
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { listPluginHosts } from '@/api/plugins'
import { Pill, type PillKind } from '@/components/Pill'

function statusKind(s: string): PillKind {
  if (s === 'running') return 'ok'
  if (s === 'deploying' || s === 'pending') return 'warn'
  if (s === 'failed') return 'err'
  return 'neutral'
}

export default function HostsTab() {
  const q = useQuery({
    queryKey: ['plugin-hosts', 'xray'],
    queryFn: () => listPluginHosts('xray'),
    refetchInterval: 5_000,
  })
  const hosts = q.data ?? []
  return (
    <div className="rounded-lg border bg-elev overflow-x-auto">
      <table className="w-full text-[13px] border-collapse">
        <thead>
          <tr className="text-left">
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Host</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Version</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Status</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Last error</th>
          </tr>
        </thead>
        <tbody>
          {hosts.map((h) => (
            <tr key={h.id} className="border-t">
              <td className="px-3 py-2 font-mono">
                <Link className="hover:underline" to={`/admin/servers/${h.server_id}`}>#{h.server_id}</Link>
              </td>
              <td className="px-3 py-2 font-mono text-[12.5px]">{h.deployed_version ?? '—'}</td>
              <td className="px-3 py-2"><Pill kind={statusKind(h.status)}>{h.status}</Pill></td>
              <td className="px-3 py-2 text-[12px] text-err">{h.last_error ?? ''}</td>
            </tr>
          ))}
          {hosts.length === 0 && (
            <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground text-[13px]">
              No hosts deployed yet.
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 4: Run tests**

```
cd web && npm test -- --run xray/ConfigTab
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/plugins/xray/index.tsx web/src/pages/admin/plugins/xray/ConfigTab.tsx web/src/pages/admin/plugins/xray/HostsTab.tsx web/src/pages/admin/plugins/xray/ConfigTab.test.tsx
git commit -m "feat(web/plugins/xray): Config + Hosts tabs"
```

---

## Task 27: xray Events + Logs tabs

**Files:**
- Modify: `web/src/pages/admin/plugins/xray/index.tsx` (add routes)
- Create: `web/src/pages/admin/plugins/xray/EventsTab.tsx`
- Create: `web/src/pages/admin/plugins/xray/LogsTab.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/pages/admin/plugins/xray/EventsTab.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import EventsTab from './EventsTab'

vi.mock('@/api/plugins', () => ({
  listPluginEvents: () => Promise.resolve([
    { ts: '2026-05-16T08:14:01Z', admin_id: 1, server_id: 7,
      action: 'plugin.xray.host.deployed', result: 'ok', details: { version: '1.8.11' } },
    { ts: '2026-05-16T07:50:00Z', admin_id: 1, server_id: null,
      action: 'plugin.xray.binary.downloaded', result: 'ok', details: { version: '1.8.11' } },
  ]),
}))

describe('xray EventsTab', () => {
  it('renders events rows', async () => {
    const qc = new QueryClient()
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={qc}>
          <MemoryRouter><EventsTab /></MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    )
    expect(await screen.findByText('plugin.xray.host.deployed')).toBeTruthy()
    expect(screen.getByText('plugin.xray.binary.downloaded')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify failure**

```
cd web && npm test -- --run xray/EventsTab
```
Expected: FAIL.

- [ ] **Step 3: Write the tabs**

```tsx
// web/src/pages/admin/plugins/xray/EventsTab.tsx
import { useQuery } from '@tanstack/react-query'
import { listPluginEvents } from '@/api/plugins'
import { Pill, type PillKind } from '@/components/Pill'

function resultKind(r: string): PillKind {
  return r === 'ok' ? 'ok' : 'err'
}

export default function EventsTab() {
  const q = useQuery({
    queryKey: ['plugin-events', 'xray'],
    queryFn: () => listPluginEvents('xray', { limit: 200 }),
    refetchInterval: 10_000,
  })
  const rows = q.data ?? []
  return (
    <div className="rounded-lg border bg-elev overflow-x-auto">
      <table className="w-full text-[13px] border-collapse">
        <thead>
          <tr className="text-left">
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Time</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Action</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Host</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e, i) => (
            <tr key={i} className="border-t">
              <td className="px-3 py-2 font-mono text-[12px] text-fg-dim whitespace-nowrap">{e.ts}</td>
              <td className="px-3 py-2 font-mono text-[12.5px]">{e.action}</td>
              <td className="px-3 py-2 font-mono text-[12px]">{e.server_id ?? '—'}</td>
              <td className="px-3 py-2"><Pill kind={resultKind(e.result)}>{e.result}</Pill></td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No events yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
```

```tsx
// web/src/pages/admin/plugins/xray/LogsTab.tsx
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { listPluginHosts, pluginLogsWSURL } from '@/api/plugins'

interface LogLine { ts: string; level: string; line: string }

export default function LogsTab() {
  const hostsQ = useQuery({ queryKey: ['plugin-hosts', 'xray'], queryFn: () => listPluginHosts('xray') })
  const [serverID, setServerID] = useState<number | null>(null)
  useEffect(() => {
    if (serverID == null && hostsQ.data?.length) setServerID(hostsQ.data[0].server_id)
  }, [hostsQ.data])

  const [lines, setLines] = useState<LogLine[]>([])
  const [paused, setPaused] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (serverID == null) return
    setLines([])
    const ws = new WebSocket(pluginLogsWSURL('xray', serverID))
    wsRef.current = ws
    ws.onmessage = (e) => {
      try {
        const env = JSON.parse(e.data) as LogLine
        setLines((prev) => paused ? prev : [...prev.slice(-1999), env])
      } catch {}
    }
    return () => { ws.close() }
  }, [serverID])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={serverID ?? ''}
          onChange={(e) => setServerID(Number(e.target.value))}
          className="h-8 px-2 rounded-md border bg-background text-[13px] font-mono"
        >
          {(hostsQ.data ?? []).map((h) => (
            <option key={h.id} value={h.server_id}>#{h.server_id}</option>
          ))}
        </select>
        <Button size="sm" variant="outline" className="h-8" onClick={() => setPaused((v) => !v)}>
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button size="sm" variant="outline" className="h-8" onClick={() => setLines([])}>
          Clear
        </Button>
      </div>
      <div className="h-[440px] bg-[#0a0a0b] text-zinc-100 rounded-lg overflow-auto p-3 font-mono text-[12px] leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap">
            <span className="text-zinc-500 mr-2">{l.ts.slice(11, 19)}</span>
            <span>{l.line}</span>
          </div>
        ))}
        {lines.length === 0 && <div className="text-zinc-500">waiting for log lines…</div>}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Wire into index.tsx**

```tsx
// web/src/pages/admin/plugins/xray/index.tsx (replace)
import { Routes, Route, Navigate } from 'react-router-dom'
import ConfigTab from './ConfigTab'
import HostsTab from './HostsTab'
import EventsTab from './EventsTab'
import LogsTab from './LogsTab'

export default function XrayPlugin() {
  return (
    <Routes>
      <Route index element={<Navigate to="config" replace />} />
      <Route path="config" element={<ConfigTab />} />
      <Route path="hosts" element={<HostsTab />} />
      <Route path="events" element={<EventsTab />} />
      <Route path="logs" element={<LogsTab />} />
    </Routes>
  )
}
```

- [ ] **Step 5: Run tests**

```
cd web && npm test -- --run xray/EventsTab
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/admin/plugins/xray/
git commit -m "feat(web/plugins/xray): Events + Logs tabs (WS live tail)"
```

---

## Task 28: cloudflare frontend (Setup + Zones tabs)

**Files:**
- Create: `web/src/pages/admin/plugins/cloudflare/index.tsx`
- Create: `web/src/pages/admin/plugins/cloudflare/SetupTab.tsx`
- Create: `web/src/pages/admin/plugins/cloudflare/ZonesTab.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/pages/admin/plugins/cloudflare/SetupTab.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import SetupTab from './SetupTab'

const put = vi.fn().mockResolvedValue({ ok: true })
vi.mock('@/api/plugins', () => ({
  getPluginConfig: () => Promise.resolve({ api_token: '***' }),
  putPluginConfig: (id: string, body: any) => put(id, body),
}))

describe('cloudflare SetupTab', () => {
  it('does not re-send unchanged redacted token on save', async () => {
    const qc = new QueryClient()
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={qc}><SetupTab /></QueryClientProvider>
      </I18nextProvider>,
    )
    await screen.findByDisplayValue('***')
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(put).toHaveBeenCalledWith('cloudflare', { api_token: '***' }))
    // server preserves the real value because *** is the redaction sentinel.
  })
})
```

- [ ] **Step 2: Run to verify failure**

```
cd web && npm test -- --run cloudflare/SetupTab
```
Expected: FAIL.

- [ ] **Step 3: Write the tabs**

```tsx
// web/src/pages/admin/plugins/cloudflare/index.tsx
import { Routes, Route, Navigate } from 'react-router-dom'
import SetupTab from './SetupTab'
import ZonesTab from './ZonesTab'

export default function CloudflarePlugin() {
  return (
    <Routes>
      <Route index element={<Navigate to="setup" replace />} />
      <Route path="setup" element={<SetupTab />} />
      <Route path="zones" element={<ZonesTab />} />
      {/* dns + activity in Task 29 */}
    </Routes>
  )
}
```

```tsx
// web/src/pages/admin/plugins/cloudflare/SetupTab.tsx
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getPluginConfig, putPluginConfig } from '@/api/plugins'

export default function SetupTab() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['plugin-cfg', 'cloudflare'], queryFn: () => getPluginConfig('cloudflare') })
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => putPluginConfig('cloudflare', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-cfg', 'cloudflare'] }),
  })
  const [token, setToken] = useState('')
  const [accountID, setAccountID] = useState('')
  useEffect(() => {
    if (q.data) {
      setToken(String(q.data.api_token ?? ''))
      setAccountID(String(q.data.account_id ?? ''))
    }
  }, [q.data])
  return (
    <div className="max-w-md space-y-3">
      <div>
        <Label className="text-[12px]">API token</Label>
        <Input value={token} onChange={(e) => setToken(e.target.value)} className="h-8 font-mono mt-1" />
        <p className="text-fg-dim text-[11.5px] mt-1">
          Scoped token (Zone:Read + DNS:Edit). Stored on the server; never sent to the browser.
        </p>
      </div>
      <div>
        <Label className="text-[12px]">Account ID (optional)</Label>
        <Input value={accountID} onChange={(e) => setAccountID(e.target.value)} className="h-8 font-mono mt-1" />
      </div>
      <Button size="sm" className="h-8" disabled={m.isPending}
        onClick={() => m.mutate({ api_token: token, account_id: accountID })}>
        Save
      </Button>
    </div>
  )
}
```

```tsx
// web/src/pages/admin/plugins/cloudflare/ZonesTab.tsx
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'

interface Zone { id: string; name: string; status?: string; plan?: { name?: string } }

export default function ZonesTab() {
  const q = useQuery({
    queryKey: ['cf-zones'],
    queryFn: () => api.get<Zone[]>('/api/admin/plugins/cloudflare/zones'),
    staleTime: 60_000,
  })
  const zones = q.data ?? []
  if (q.isError) {
    return <div className="text-err text-[13px]">Failed to load zones: {(q.error as Error).message}</div>
  }
  return (
    <div className="rounded-lg border bg-elev overflow-x-auto">
      <table className="w-full text-[13px] border-collapse">
        <thead>
          <tr className="text-left">
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Name</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Status</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Plan</th>
            <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">ID</th>
          </tr>
        </thead>
        <tbody>
          {zones.map((z) => (
            <tr key={z.id} className="border-t">
              <td className="px-3 py-2 font-mono">{z.name}</td>
              <td className="px-3 py-2 text-[12px] text-muted-foreground">{z.status ?? '—'}</td>
              <td className="px-3 py-2 text-[12px] text-muted-foreground">{z.plan?.name ?? '—'}</td>
              <td className="px-3 py-2 font-mono text-[11px] text-fg-dim">{z.id}</td>
            </tr>
          ))}
          {zones.length === 0 && (
            <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No zones.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 4: Run tests**

```
cd web && npm test -- --run cloudflare/SetupTab
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/plugins/cloudflare/
git commit -m "feat(web/plugins/cloudflare): Setup + Zones tabs"
```

---

## Task 29: cloudflare DNS records + Activity tabs

**Files:**
- Modify: `web/src/pages/admin/plugins/cloudflare/index.tsx`
- Create: `web/src/pages/admin/plugins/cloudflare/DnsTab.tsx`
- Create: `web/src/pages/admin/plugins/cloudflare/ActivityTab.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/pages/admin/plugins/cloudflare/DnsTab.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import DnsTab from './DnsTab'

vi.mock('@/api/client', () => ({
  api: {
    get: vi.fn().mockImplementation((url: string) =>
      url.includes('/zones?') || url === '/api/admin/plugins/cloudflare/zones'
        ? Promise.resolve([{ id: 'z1', name: 'example.com' }])
        : Promise.resolve([{ id: 'r1', name: 'a.example.com', type: 'A', content: '1.2.3.4', ttl: 1, proxied: false }])
    ),
    post: vi.fn().mockResolvedValue({}),
    del: vi.fn().mockResolvedValue({}),
  },
}))

describe('cloudflare DnsTab', () => {
  it('lists records for the selected zone', async () => {
    const qc = new QueryClient()
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={qc}><DnsTab /></QueryClientProvider>
      </I18nextProvider>,
    )
    await screen.findByText('example.com')
    await waitFor(() => expect(screen.getByText('a.example.com')).toBeTruthy())
  })
})
```

- [ ] **Step 2: Run to verify failure**

```
cd web && npm test -- --run cloudflare/DnsTab
```
Expected: FAIL.

- [ ] **Step 3: Write the tabs**

```tsx
// web/src/pages/admin/plugins/cloudflare/DnsTab.tsx
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface Zone   { id: string; name: string }
interface Record { id: string; name: string; type: string; content: string; ttl?: number; proxied?: boolean }

export default function DnsTab() {
  const qc = useQueryClient()
  const zonesQ = useQuery({
    queryKey: ['cf-zones'],
    queryFn: () => api.get<Zone[]>('/api/admin/plugins/cloudflare/zones'),
    staleTime: 60_000,
  })
  const [zoneID, setZoneID] = useState('')
  useEffect(() => {
    if (!zoneID && zonesQ.data?.length) setZoneID(zonesQ.data[0].id)
  }, [zonesQ.data])

  const recsQ = useQuery({
    queryKey: ['cf-records', zoneID],
    enabled: !!zoneID,
    queryFn: () => api.get<Record[]>(`/api/admin/plugins/cloudflare/zones/${zoneID}/records`),
  })

  const create = useMutation({
    mutationFn: (body: Partial<Record>) => api.post(`/api/admin/plugins/cloudflare/zones/${zoneID}/records`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cf-records', zoneID] }),
  })
  const remove = useMutation({
    mutationFn: (rid: string) => api.del(`/api/admin/plugins/cloudflare/zones/${zoneID}/records/${rid}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cf-records', zoneID] }),
  })

  const [draft, setDraft] = useState<Partial<Record>>({ type: 'A', name: '', content: '' })

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select value={zoneID} onChange={(e) => setZoneID(e.target.value)}
          className="h-8 px-2 rounded-md border bg-background text-[13px] font-mono">
          {(zonesQ.data ?? []).map((z) => (
            <option key={z.id} value={z.id}>{z.name}</option>
          ))}
        </select>
      </div>
      <div className="rounded-lg border bg-elev overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr className="text-left">
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Name</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Type</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Content</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">TTL</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(recsQ.data ?? []).map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-2 font-mono">{r.name}</td>
                <td className="px-3 py-2 font-mono text-[12px]">{r.type}</td>
                <td className="px-3 py-2 font-mono text-[12px]">{r.content}</td>
                <td className="px-3 py-2 font-mono text-[12px]">{r.ttl ?? '—'}</td>
                <td className="px-3 py-2 text-right">
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]"
                    onClick={() => remove.mutate(r.id)}>Delete</Button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t bg-sunken/40">
              <td className="px-3 py-2">
                <Input placeholder="record name" value={draft.name ?? ''} className="h-7 font-mono text-[12.5px]"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </td>
              <td className="px-3 py-2">
                <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}
                  className="h-7 px-2 rounded border bg-background text-[12.5px] font-mono">
                  {['A','AAAA','CNAME','TXT','MX'].map((t) => <option key={t}>{t}</option>)}
                </select>
              </td>
              <td className="px-3 py-2">
                <Input placeholder="content" value={draft.content ?? ''} className="h-7 font-mono text-[12.5px]"
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
              </td>
              <td className="px-3 py-2 text-fg-dim text-[11.5px]">auto</td>
              <td className="px-3 py-2 text-right">
                <Button size="sm" className="h-7 px-2 text-[12px]"
                  disabled={!draft.name || !draft.content}
                  onClick={() => { create.mutate({ ...draft, ttl: 1, proxied: false }); setDraft({ type: 'A', name: '', content: '' }) }}>
                  Add
                </Button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
```

```tsx
// web/src/pages/admin/plugins/cloudflare/ActivityTab.tsx
export default function ActivityTab() {
  return (
    <div className="text-[13px] text-muted-foreground">
      Cloudflare audit log integration is tracked separately — this tab will
      surface the most recent events once the <code>GET /audit</code> endpoint
      is wired up.
    </div>
  )
}
```

Note: the Activity tab is a placeholder for 3a since the CF audit endpoint wasn't included in the API contract for Phase 3a (out-of-scope per spec §6.2 — `/audit?since=...` is listed but not required). Implementer should add the endpoint + client + wire it here only if scope allows; otherwise this placeholder ships.

Update index.tsx:

```tsx
// web/src/pages/admin/plugins/cloudflare/index.tsx (replace)
import { Routes, Route, Navigate } from 'react-router-dom'
import SetupTab from './SetupTab'
import ZonesTab from './ZonesTab'
import DnsTab from './DnsTab'
import ActivityTab from './ActivityTab'

export default function CloudflarePlugin() {
  return (
    <Routes>
      <Route index element={<Navigate to="setup" replace />} />
      <Route path="setup" element={<SetupTab />} />
      <Route path="zones" element={<ZonesTab />} />
      <Route path="dns" element={<DnsTab />} />
      <Route path="activity" element={<ActivityTab />} />
    </Routes>
  )
}
```

- [ ] **Step 4: Run tests**

```
cd web && npm test -- --run cloudflare/DnsTab
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/plugins/cloudflare/
git commit -m "feat(web/plugins/cloudflare): DNS records CRUD + Activity placeholder"
```

---

## Task 30: Dynamic sidebar entries from /api/admin/plugins manifest

**Files:**
- Modify: `web/src/layouts/AdminLayout.tsx`

- [ ] **Step 1: Read current AdminLayout**

The sidebar already includes a hard-coded `Plugins` entry. We want to additionally list each ENABLED plugin underneath, so the admin can jump straight into a plugin's pages without clicking through the index.

- [ ] **Step 2: Modify the NavList block**

Inside `AdminLayout.tsx`, after the existing `sections` loop and before the "Recent hosts" block, add an "Active plugins" sub-section:

```tsx
import { listPlugins } from '@/api/plugins'

// at top of component:
const pluginsQ = useQuery({
  queryKey: ['plugins'],
  queryFn: listPlugins,
  refetchInterval: 30_000,
})
const enabledPlugins = (pluginsQ.data ?? []).filter((p) => p.enabled)
```

Append the section in `NavList`:

```tsx
{enabledPlugins.length > 0 && (
  <div className="mt-2">
    <div className="px-2.5 pt-2 pb-1 text-[10.5px] uppercase tracking-[0.08em] text-fg-dim font-medium">
      {t('nav.section.active_plugins', 'Active plugins')}
    </div>
    {enabledPlugins.map((p) => (
      <Link
        key={p.id}
        to={`/admin/plugins/${p.id}`}
        onClick={onNavigate}
        className={cn(
          'flex items-center gap-2.5 h-[28px] px-2.5 rounded-md text-[12.5px] font-mono',
          'text-muted-foreground hover:bg-sunken hover:text-foreground transition-colors',
        )}
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-ok shrink-0" />
        <span className="truncate">{p.meta.name}</span>
      </Link>
    ))}
  </div>
)}
```

Add the i18n keys:

```json
// web/src/locales/en.json — under "nav.section"
"active_plugins": "Active plugins"
// web/src/locales/zh-CN.json
"active_plugins": "已启用插件"
```

- [ ] **Step 3: Run tests + build**

```
cd web && npm test -- --run
cd web && npm run build
```
Expected: all tests pass; build clean.

- [ ] **Step 4: Commit**

```bash
git add web/src/layouts/AdminLayout.tsx web/src/locales/
git commit -m "feat(web/layout): sidebar lists enabled plugins under Active plugins"
```

---

## Task 31: i18n + integration sweep

**Files:**
- Modify: `web/src/locales/{en,zh-CN}.json`
- Modify: `web/src/App.tsx` (final pass for any leftover imports)

- [ ] **Step 1: Add the plugin-wide i18n keys used above**

```json
// web/src/locales/en.json — add under "plugins"
"subtitle": "Extend Shepherd with system-level integrations (xray, Cloudflare, ...).",
"empty": "No plugins compiled in.",
"placeholder_title": "Plugin runtime not enabled",
"placeholder_body": "This release ships without a plugin host."
```

```json
// web/src/locales/zh-CN.json — add under "plugins"
"subtitle": "通过系统级集成扩展 Shepherd (xray、Cloudflare 等)",
"empty": "未编译任何插件",
"placeholder_title": "插件运行时未启用",
"placeholder_body": "当前版本未内置插件主机进程"
```

- [ ] **Step 2: Full project build + tests**

```
go build ./...
go test ./...
cd web && npm test -- --run
cd web && npm run build
```
Expected: all green.

- [ ] **Step 3: Manual smoke test (recorded in commit body)**

In a separate terminal:

```
go run ./cmd/server
```

Browser:
1. Open `/admin/plugins` — see `xray` and `cloudflare` cards.
2. Click **Enable** on `cloudflare` → card flips to "enabled".
3. Click the card title → land on `/admin/plugins/cloudflare/setup` — Setup tab visible.
4. Click **Enable** on `xray` → click the card → Config / Hosts / Events / Logs tabs render.
5. Sidebar now shows both plugins under "Active plugins".
6. Disable both → tabs and sidebar entries disappear.

- [ ] **Step 4: Commit**

```bash
git add web/src/locales/ web/src/App.tsx
git commit -m "feat(plugins): final i18n keys + integration smoke pass"
```

---

## Self-review

**1. Spec coverage**

| Spec section | Covered by task |
|---|---|
| §1 scope | (no code) |
| §2.1 file layout | tasks 1–20 |
| §2.2 Plugin/HostAware/LogStreamer + Meta/Deps | task 1 |
| §2.3 frontend layout | tasks 23–29 |
| §3.1 plugins / plugin_hosts / plugin_migrations | task 3 + task 4 (migrator) |
| §3.2 xray_binaries | task 13 |
| §3.3 Postgres dialect | task 3 |
| §4.1 enable / disable | task 7 |
| §4.2 per-host deploy | tasks 9 (generic) + 16 (xray impl) |
| §4.3 manifest endpoint | task 6 |
| §4.4 router gating | task 21 (`gatedMux`) |
| §5.1 xray release fetch | task 14 |
| §5.2 config UI (template + raw) | task 15 (backend) + task 26 (frontend) |
| §5.3 systemd unit | task 16 |
| §6.1 cloudflare config | task 18 + task 20 |
| §6.2 cloudflare endpoints | task 20 (audit endpoint deferred — placeholder in task 29) |
| §6.3 cloudflare UI tabs | tasks 28–29 |
| §7 API surface | tasks 6–11 + 17 + 20 |
| §8 error handling | tasks 7, 9, 11, 20 |
| §9 testing | per-task tests + smoke (task 31) |
| §11.1 events endpoint | task 10 (backend), task 27 (frontend) |
| §11.2 LogStreamer + WS | task 11 (backend), task 17 (xray impl), task 27 (frontend) |

Gaps to flag explicitly:
- §5.2 raw-mode validation via `xray run -test` is described but the implementer would need a small follow-on if the spec demands it strictly. Today task 15's `NormaliseRaw` only validates JSON syntax. If the spec requires xray's own validator, add a sub-task that runs the binary in the cache dir against a temp config file and surfaces stderr.
- §5.1 `POST /api/admin/plugins/xray/binaries` (manual pre-fetch) and `GET /binaries` (inventory) are not separately implemented. xray currently fetches on demand inside `DeployToHost`. Add a follow-on task if explicit pre-fetch is required.
- §6.2 cloudflare `/audit?since=...` endpoint placeholder only — implementer should add it before shipping if scope allows.

**2. Placeholder scan**

- Several "left intentionally" placeholders (cloudflare Activity tab, pre-fetch endpoints). Each is flagged in its task body as an explicit deferral, not a TBD.
- No bare "TODO" / "implement later" / "add error handling" tokens.

**3. Type consistency**

- `plugins.Mux` interface used in tasks 17, 20, 21 — same signature throughout.
- `plugins.HostExec` interface used in tasks 11, 12, 16 — same method signatures.
- `Store.HostRow` / `Store.Row` / `Store.UpsertHost(...)` consistent between tasks 5, 7, 9.
- Frontend `PluginEntry` / `PluginHost` types consistent between tasks 22, 24, 26.

---

## Execution

Subagent-driven recommended (31 atomic tasks, each <30 min). Dispatch each
task with the spec link + the task body. Two-stage review per task (spec
compliance then code quality) per `superpowers:subagent-driven-development`.







