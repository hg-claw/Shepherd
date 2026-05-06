# Shepherd Phase 1.A — Backend & Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Go server + Linux agent that together fulfil spec §3–8: HTTP/WS server with admin auth, server CRUD, async SSH installer, agent enrollment & reverse-WS transport, and telemetry pipeline (samples + 5m/1h rollups + retention). End state: `go run ./cmd/server` boots; an admin can log in via curl, install the agent on a target host, and watch telemetry flow through `/api/servers/:id/telemetry`.

**Out of scope (later plans):** React SPA (`web/`) → Plan 1.B. Docker Compose, Caddyfile, GitHub release CI, cross-compile Makefile targets → Plan 1.C.

**Architecture:** Single Go process, single port (`:8080` default). HTTP + WS coexist. Agent is a separate Go binary that reverse-WS-connects to `/agent/ws`. Bidirectional `Envelope{Sid, Type, P}` JSON frames over WS. SQLite default, Postgres switchable via `DATABASE_DRIVER`. golang-migrate runs migrations on startup; per-dialect migration directories.

**Tech Stack:** Go 1.22+, sqlx, golang-migrate (sqlite3 + postgres dialects), gopsutil, gorilla/websocket, golang.org/x/crypto/{bcrypt, ssh}.

**Spec:** `docs/superpowers/specs/2026-05-06-shepherd-platform-core-design.md`

**Owner placeholder:** the plan uses `<owner>` for the GitHub user/org. Pick the real value at Task 1 and grep-replace before any other task runs.

---

## File Map

```
go.mod
go.sum
Makefile
.gitignore
.editorconfig
cmd/
  server/main.go
  agent/main.go
internal/
  config/config.go              # server env parsing
  agentconfig/config.go         # agent env parsing
  db/
    db.go                       # Open(), driver switching, WAL/FK pragma
    migrate.go                  # embed FS, run migrations
    migrations/sqlite/0001_init.up.sql
    migrations/sqlite/0001_init.down.sql
    migrations/postgres/0001_init.up.sql
    migrations/postgres/0001_init.down.sql
  agentapi/
    envelope.go                 # Envelope{Sid,Type,P}, helpers
    types.go                    # payload structs (Telemetry, Heartbeat, ConfigUpdate, ...)
  auth/
    bcrypt.go                   # Hash/Verify
    sessions.go                 # Issue/Lookup/Revoke
    middleware.go               # RequireAdmin
  serversvc/
    service.go                  # CRUD + status helpers
    install.go                  # async install state machine + watchdog
    settings.go                 # global settings KV
  agentsvc/
    enroll.go                   # token issue + redeem
    auto_register.go            # AUTO_RECOVER_KEY flow
    hub.go                      # in-memory online registry + push
  installer/
    installer.go                # one-shot SSH session, run install commands
    distribution.go             # AGENT_DISTRIBUTION dispatch (embedded vs github)
    embedded.go                 # go:embed agent binaries (real bytes wired in 1.C)
  telemetrysvc/
    ingest.go                   # accept telemetry, write samples_30s, update last_seen
    rollup.go                   # minute-tick aggregator into rollup_5m / rollup_1h
    retention.go                # 10-min-tick prune
    query.go                    # range -> granularity selector + reads
  api/
    router.go                   # mount everything
    middleware.go                # JSON helpers, error handling
    admin_auth.go               # /api/login, /api/logout, /api/admins/me
    admin_servers.go            # /api/servers/*, /api/servers/install, /repair, /config
    admin_settings.go            # /api/settings
    public.go                    # /api/public/*
    agent_routes.go              # /agent/enroll, /agent/auto-register, /agent/ws
  agent/
    state/state.go               # /etc/shepherd/agent.state.json read/write
    fingerprint/fingerprint.go   # machine-id + MAC -> sha256
    collector/
      collector.go               # gopsutil orchestration
      net.go                     # rx/tx delta -> bps
      disks.go                   # filter tmpfs/squashfs/overlay
    wsclient/
      client.go                  # enroll/auto-register, WS connect, dispatch loop, reconnect
```

---

## Conventions

- **Test placement.** Tests live next to the code: `internal/foo/foo_test.go`. Integration tests that need a DB use a `t.TempDir()` SQLite file; Postgres parity is checked by a single `internal/db/integration_test.go` gated on `DATABASE_DSN_PG` env.
- **JSON payloads** in HTTP responses use snake_case keys.
- **Time.** Always store UTC in DB; serialize as RFC 3339.
- **Errors crossing the API boundary** become `{"error": "<message>"}` with the right status code; no stack traces leaked.
- **One commit per task** unless a task explicitly says otherwise.

---

## Milestone 1 — Repo scaffold

### Task 1: Initialise Go module + dev scaffold

**Files:**
- Create: `go.mod`
- Create: `.gitignore`
- Create: `Makefile`
- Create: `.editorconfig`

- [ ] **Step 1: Verify clean tree**

```
ls
```
Expected: `docs`.

- [ ] **Step 2: Init Go module** (replace `<owner>` with the real GitHub user/org)

```
go mod init github.com/<owner>/shepherd
```

- [ ] **Step 3: Write `.gitignore`**

```gitignore
# Binaries
/bin/
/shepherd-server
/shepherd-agent
*.exe

# Data
/data/
*.db
*.db-shm
*.db-wal

# Editor
.idea/
.vscode/
*.swp

# Frontend (Plan 1.B)
/web/node_modules/
/web/dist/

# OS
.DS_Store
```

- [ ] **Step 4: Write `Makefile`** (full release/cross-compile targets land in Plan 1.C)

```make
.PHONY: server agent test fmt vet tidy

server:
	go build -o bin/shepherd-server ./cmd/server

agent:
	go build -o bin/shepherd-agent ./cmd/agent

test:
	go test ./...

fmt:
	gofmt -w .

vet:
	go vet ./...

tidy:
	go mod tidy
```

- [ ] **Step 5: Write `.editorconfig`**

```ini
root = true

[*]
indent_style = tab
indent_size = 4
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.{md,yml,yaml,json,sql}]
indent_style = space
indent_size = 2

[*.{ts,tsx,js,jsx,css,html}]
indent_style = space
indent_size = 2
```

- [ ] **Step 6: Commit**

```
git add go.mod .gitignore Makefile .editorconfig
git commit -m "chore: init go module and dev scaffold"
```

---

## Milestone 2 — DB layer

### Task 2: `internal/db` — connection + migration runner

**Files:**
- Create: `internal/db/db.go`
- Create: `internal/db/migrate.go`
- Create: `internal/db/db_test.go`
- Create: `internal/db/migrations/sqlite/.gitkeep`
- Create: `internal/db/migrations/postgres/.gitkeep`

- [ ] **Step 1: Add deps**

```
go get github.com/jmoiron/sqlx
go get github.com/golang-migrate/migrate/v4
go get github.com/golang-migrate/migrate/v4/database/sqlite3
go get github.com/golang-migrate/migrate/v4/database/postgres
go get github.com/golang-migrate/migrate/v4/source/iofs
go get github.com/mattn/go-sqlite3
go get github.com/lib/pq
```

- [ ] **Step 2: Write `internal/db/db.go`**

```go
package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"
	_ "github.com/mattn/go-sqlite3"
)

type Driver string

const (
	DriverSQLite   Driver = "sqlite"
	DriverPostgres Driver = "postgres"
)

type Config struct {
	Driver Driver
	DSN    string
}

var ErrInvalidConfig = errors.New("invalid db config")

func Open(ctx context.Context, cfg Config) (*sqlx.DB, error) {
	var goDriver string
	switch cfg.Driver {
	case DriverSQLite:
		goDriver = "sqlite3"
	case DriverPostgres:
		goDriver = "postgres"
	default:
		return nil, fmt.Errorf("%w: unknown driver %q", ErrInvalidConfig, cfg.Driver)
	}
	d, err := sqlx.Open(goDriver, cfg.DSN)
	if err != nil {
		return nil, err
	}
	if err := d.PingContext(ctx); err != nil {
		_ = d.Close()
		return nil, err
	}
	if cfg.Driver == DriverSQLite {
		if _, err := d.Exec("PRAGMA journal_mode=WAL"); err != nil {
			return nil, err
		}
		if _, err := d.Exec("PRAGMA foreign_keys=ON"); err != nil {
			return nil, err
		}
	}
	return d, nil
}
```

- [ ] **Step 3: Write `internal/db/migrate.go`**

```go
package db

import (
	"embed"
	"errors"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	migratePostgres "github.com/golang-migrate/migrate/v4/database/postgres"
	migrateSQLite "github.com/golang-migrate/migrate/v4/database/sqlite3"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jmoiron/sqlx"
)

//go:embed migrations/sqlite/*.sql migrations/postgres/*.sql
var migrationsFS embed.FS

func Migrate(d *sqlx.DB, driver Driver) error {
	subdir := "migrations/sqlite"
	if driver == DriverPostgres {
		subdir = "migrations/postgres"
	}
	src, err := iofs.New(migrationsFS, subdir)
	if err != nil {
		return err
	}
	defer src.Close()

	var dbDriver migrate.Driver
	switch driver {
	case DriverSQLite:
		dbDriver, err = migrateSQLite.WithInstance(d.DB, &migrateSQLite.Config{})
	case DriverPostgres:
		dbDriver, err = migratePostgres.WithInstance(d.DB, &migratePostgres.Config{})
	default:
		return fmt.Errorf("unknown driver %q", driver)
	}
	if err != nil {
		return err
	}

	m, err := migrate.NewWithInstance("iofs", src, string(driver), dbDriver)
	if err != nil {
		return err
	}
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return err
	}
	return nil
}
```

- [ ] **Step 4: Stub migration directories so `go:embed` patterns match**

```
mkdir -p internal/db/migrations/sqlite internal/db/migrations/postgres
touch internal/db/migrations/sqlite/.gitkeep
touch internal/db/migrations/postgres/.gitkeep
```

> The `go:embed` directive errors if zero files match. Real migrations land in Task 3; the `.gitkeep` files are removed once `0001_init.up.sql` exists.

- [ ] **Step 5: Write `internal/db/db_test.go`**

```go
package db

import (
	"context"
	"path/filepath"
	"testing"
)

func TestOpenSQLite_PragmasApplied(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, err := Open(context.Background(), Config{Driver: DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	var mode string
	if err := d.Get(&mode, "PRAGMA journal_mode"); err != nil {
		t.Fatal(err)
	}
	if mode != "wal" {
		t.Errorf("journal_mode=%q want wal", mode)
	}

	var fk int
	if err := d.Get(&fk, "PRAGMA foreign_keys"); err != nil {
		t.Fatal(err)
	}
	if fk != 1 {
		t.Errorf("foreign_keys=%d want 1", fk)
	}
}

func TestOpen_UnknownDriver(t *testing.T) {
	_, err := Open(context.Background(), Config{Driver: "bogus", DSN: "x"})
	if err == nil {
		t.Fatal("want error")
	}
}
```

- [ ] **Step 6: Run tests**

```
go test ./internal/db -v
```
Expected: `TestOpenSQLite_PragmasApplied PASS`, `TestOpen_UnknownDriver PASS`.

- [ ] **Step 7: Commit**

```
git add go.mod go.sum internal/db
git commit -m "feat(db): sqlx connection + golang-migrate with sqlite/postgres switching"
```

---

### Task 3: First migration — admins, sessions, servers, tokens

**Files:**
- Create: `internal/db/migrations/sqlite/0001_init.up.sql`
- Create: `internal/db/migrations/sqlite/0001_init.down.sql`
- Create: `internal/db/migrations/postgres/0001_init.up.sql`
- Create: `internal/db/migrations/postgres/0001_init.down.sql`
- Modify: `internal/db/db_test.go` (append migration test)
- Delete: `internal/db/migrations/sqlite/.gitkeep`, `internal/db/migrations/postgres/.gitkeep`

- [ ] **Step 1: Write `internal/db/migrations/sqlite/0001_init.up.sql`**

```sql
CREATE TABLE admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,
  admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at  TIMESTAMP NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE servers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT    NOT NULL,
  public_alias       TEXT,
  public_group       TEXT,
  country_code       TEXT,
  show_on_public     INTEGER NOT NULL DEFAULT 0,

  ssh_host           TEXT,
  ssh_port           INTEGER NOT NULL DEFAULT 22,
  ssh_user           TEXT,
  install_stage      TEXT    NOT NULL DEFAULT 'pending',
  install_log        TEXT    NOT NULL DEFAULT '',
  install_error      TEXT,
  install_started_at TIMESTAMP,

  agent_version      TEXT,
  agent_os           TEXT,
  agent_arch         TEXT,
  agent_kernel       TEXT,
  agent_last_seen    TIMESTAMP,
  agent_fingerprint  TEXT UNIQUE,

  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_servers_show_on_public ON servers(show_on_public);

CREATE TABLE enrollment_tokens (
  token       TEXT PRIMARY KEY,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  expires_at  TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE machine_tokens (
  token       TEXT PRIMARY KEY,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  rotated_at  TIMESTAMP
);

CREATE TABLE telemetry_samples_30s (
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts          TIMESTAMP NOT NULL,
  cpu_pct     REAL,
  mem_used    INTEGER,
  mem_total   INTEGER,
  load_1      REAL,
  load_5      REAL,
  load_15     REAL,
  net_rx_bps  INTEGER,
  net_tx_bps  INTEGER,
  tcp_conn    INTEGER,
  disks_json  TEXT,
  PRIMARY KEY (server_id, ts)
);

CREATE TABLE telemetry_rollup_5m (
  server_id      INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts             TIMESTAMP NOT NULL,
  cpu_avg        REAL, cpu_max REAL,
  mem_used_avg   INTEGER, mem_used_max INTEGER, mem_total INTEGER,
  load_1_avg     REAL, load_1_max REAL,
  net_rx_bps_avg INTEGER, net_rx_bps_max INTEGER,
  net_tx_bps_avg INTEGER, net_tx_bps_max INTEGER,
  tcp_conn_avg   INTEGER, tcp_conn_max INTEGER,
  disks_json     TEXT,
  PRIMARY KEY (server_id, ts)
);

CREATE TABLE telemetry_rollup_1h (
  server_id      INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts             TIMESTAMP NOT NULL,
  cpu_avg        REAL, cpu_max REAL,
  mem_used_avg   INTEGER, mem_used_max INTEGER, mem_total INTEGER,
  load_1_avg     REAL, load_1_max REAL,
  net_rx_bps_avg INTEGER, net_rx_bps_max INTEGER,
  net_tx_bps_avg INTEGER, net_tx_bps_max INTEGER,
  tcp_conn_avg   INTEGER, tcp_conn_max INTEGER,
  disks_json     TEXT,
  PRIMARY KEY (server_id, ts)
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings(key, value) VALUES
  ('public_display_mode', 'both'),
  ('retention_30s', '24h'),
  ('retention_5m', '7d'),
  ('retention_1h', '90d'),
  ('default_telemetry_interval_seconds', '30');
```

- [ ] **Step 2: Write `internal/db/migrations/sqlite/0001_init.down.sql`**

```sql
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS telemetry_rollup_1h;
DROP TABLE IF EXISTS telemetry_rollup_5m;
DROP TABLE IF EXISTS telemetry_samples_30s;
DROP TABLE IF EXISTS machine_tokens;
DROP TABLE IF EXISTS enrollment_tokens;
DROP TABLE IF EXISTS servers;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS admins;
```

- [ ] **Step 3: Write `internal/db/migrations/postgres/0001_init.up.sql`** (Postgres dialect — `BIGSERIAL`, `BOOLEAN`, `BIGINT`)

```sql
CREATE TABLE admins (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,
  admin_id    BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE servers (
  id                 BIGSERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  public_alias       TEXT,
  public_group       TEXT,
  country_code       TEXT,
  show_on_public     BOOLEAN NOT NULL DEFAULT FALSE,

  ssh_host           TEXT,
  ssh_port           INTEGER NOT NULL DEFAULT 22,
  ssh_user           TEXT,
  install_stage      TEXT NOT NULL DEFAULT 'pending',
  install_log        TEXT NOT NULL DEFAULT '',
  install_error      TEXT,
  install_started_at TIMESTAMPTZ,

  agent_version      TEXT,
  agent_os           TEXT,
  agent_arch         TEXT,
  agent_kernel       TEXT,
  agent_last_seen    TIMESTAMPTZ,
  agent_fingerprint  TEXT UNIQUE,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_servers_show_on_public ON servers(show_on_public);

CREATE TABLE enrollment_tokens (
  token       TEXT PRIMARY KEY,
  server_id   BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE machine_tokens (
  token       TEXT PRIMARY KEY,
  server_id   BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at  TIMESTAMPTZ
);

CREATE TABLE telemetry_samples_30s (
  server_id   BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL,
  cpu_pct     DOUBLE PRECISION,
  mem_used    BIGINT,
  mem_total   BIGINT,
  load_1      DOUBLE PRECISION,
  load_5      DOUBLE PRECISION,
  load_15     DOUBLE PRECISION,
  net_rx_bps  BIGINT,
  net_tx_bps  BIGINT,
  tcp_conn    INTEGER,
  disks_json  TEXT,
  PRIMARY KEY (server_id, ts)
);

CREATE TABLE telemetry_rollup_5m (
  server_id      BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts             TIMESTAMPTZ NOT NULL,
  cpu_avg        DOUBLE PRECISION, cpu_max DOUBLE PRECISION,
  mem_used_avg   BIGINT, mem_used_max BIGINT, mem_total BIGINT,
  load_1_avg     DOUBLE PRECISION, load_1_max DOUBLE PRECISION,
  net_rx_bps_avg BIGINT, net_rx_bps_max BIGINT,
  net_tx_bps_avg BIGINT, net_tx_bps_max BIGINT,
  tcp_conn_avg   INTEGER, tcp_conn_max INTEGER,
  disks_json     TEXT,
  PRIMARY KEY (server_id, ts)
);

CREATE TABLE telemetry_rollup_1h (
  server_id      BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts             TIMESTAMPTZ NOT NULL,
  cpu_avg        DOUBLE PRECISION, cpu_max DOUBLE PRECISION,
  mem_used_avg   BIGINT, mem_used_max BIGINT, mem_total BIGINT,
  load_1_avg     DOUBLE PRECISION, load_1_max DOUBLE PRECISION,
  net_rx_bps_avg BIGINT, net_rx_bps_max BIGINT,
  net_tx_bps_avg BIGINT, net_tx_bps_max BIGINT,
  tcp_conn_avg   INTEGER, tcp_conn_max INTEGER,
  disks_json     TEXT,
  PRIMARY KEY (server_id, ts)
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings(key, value) VALUES
  ('public_display_mode', 'both'),
  ('retention_30s', '24h'),
  ('retention_5m', '7d'),
  ('retention_1h', '90d'),
  ('default_telemetry_interval_seconds', '30');
```

- [ ] **Step 4: Write `internal/db/migrations/postgres/0001_init.down.sql`**

```sql
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS telemetry_rollup_1h;
DROP TABLE IF EXISTS telemetry_rollup_5m;
DROP TABLE IF EXISTS telemetry_samples_30s;
DROP TABLE IF EXISTS machine_tokens;
DROP TABLE IF EXISTS enrollment_tokens;
DROP TABLE IF EXISTS servers;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS admins;
```

- [ ] **Step 5: Remove `.gitkeep` placeholders**

```
rm internal/db/migrations/sqlite/.gitkeep internal/db/migrations/postgres/.gitkeep
```

- [ ] **Step 6: Append migration test to `internal/db/db_test.go`**

```go
func TestMigrate_SQLite_AppliesAllTables(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, err := Open(context.Background(), Config{Driver: DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if err := Migrate(d, DriverSQLite); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"admins", "sessions", "servers", "enrollment_tokens", "machine_tokens",
		"telemetry_samples_30s", "telemetry_rollup_5m", "telemetry_rollup_1h", "settings",
	}
	for _, name := range want {
		var n int
		if err := d.Get(&n, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", name); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Errorf("missing table %q", name)
		}
	}
	var v string
	if err := d.Get(&v, "SELECT value FROM settings WHERE key='public_display_mode'"); err != nil {
		t.Fatal(err)
	}
	if v != "both" {
		t.Errorf("public_display_mode=%q want both", v)
	}
}
```

- [ ] **Step 7: Run tests**

```
go test ./internal/db -v
```
Expected: all pass, including `TestMigrate_SQLite_AppliesAllTables`.

- [ ] **Step 8: Commit**

```
git add internal/db
git commit -m "feat(db): initial schema migration (sqlite + postgres dialects)"
```

---

## Milestone 3 — Server config + auth

### Task 4: `internal/config` — server env parsing

**Files:**
- Create: `internal/config/config.go`
- Create: `internal/config/config_test.go`

- [ ] **Step 1: Write `internal/config/config.go`**

```go
package config

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/<owner>/shepherd/internal/db"
)

const (
	DistributionEmbedded = "embedded"
	DistributionGitHub   = "github"
)

type Config struct {
	HTTPAddr              string
	DBDriver              db.Driver
	DBDSN                 string
	AutoRecoverKey        string
	InitialAdminUsername  string
	InitialAdminPassword  string
	AgentDistribution     string // embedded | github
	AgentDownloadTag      string // overrides BuildVersion when AgentDistribution=github
	BuildVersion          string // injected via -ldflags at release time, defaults to "dev"
	CookieSecure          bool   // set true behind TLS reverse proxy
}

func FromEnv() (Config, error) {
	c := Config{
		HTTPAddr:             getEnvDefault("SERVER_HTTP_ADDR", ":8080"),
		DBDriver:             db.Driver(getEnvDefault("DATABASE_DRIVER", "sqlite")),
		DBDSN:                os.Getenv("DATABASE_DSN"),
		AutoRecoverKey:       os.Getenv("AUTO_RECOVER_KEY"),
		InitialAdminUsername: os.Getenv("INITIAL_ADMIN_USERNAME"),
		InitialAdminPassword: os.Getenv("INITIAL_ADMIN_PASSWORD"),
		AgentDistribution:    strings.ToLower(getEnvDefault("AGENT_DISTRIBUTION", DistributionEmbedded)),
		AgentDownloadTag:     os.Getenv("AGENT_DOWNLOAD_TAG"),
		BuildVersion:         BuildVersion,
		CookieSecure:         getEnvDefault("COOKIE_SECURE", "false") == "true",
	}
	if c.DBDSN == "" {
		if c.DBDriver == db.DriverSQLite {
			c.DBDSN = "file:./shepherd.db?_fk=1"
		} else {
			return c, errors.New("DATABASE_DSN required when DATABASE_DRIVER=postgres")
		}
	}
	switch c.DBDriver {
	case db.DriverSQLite, db.DriverPostgres:
	default:
		return c, fmt.Errorf("DATABASE_DRIVER %q invalid", c.DBDriver)
	}
	switch c.AgentDistribution {
	case DistributionEmbedded, DistributionGitHub:
	default:
		return c, fmt.Errorf("AGENT_DISTRIBUTION %q invalid", c.AgentDistribution)
	}
	return c, nil
}

// BuildVersion is overridden at link time:
//   go build -ldflags "-X github.com/<owner>/shepherd/internal/config.BuildVersion=v0.1.0" ...
var BuildVersion = "dev"

func getEnvDefault(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}
```

- [ ] **Step 2: Write `internal/config/config_test.go`**

```go
package config

import (
	"testing"
)

func TestFromEnv_DefaultsSQLite(t *testing.T) {
	t.Setenv("SERVER_HTTP_ADDR", "")
	t.Setenv("DATABASE_DRIVER", "")
	t.Setenv("DATABASE_DSN", "")
	t.Setenv("AGENT_DISTRIBUTION", "")
	c, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.HTTPAddr != ":8080" {
		t.Errorf("HTTPAddr=%q want :8080", c.HTTPAddr)
	}
	if string(c.DBDriver) != "sqlite" {
		t.Errorf("DBDriver=%q want sqlite", c.DBDriver)
	}
	if c.DBDSN == "" {
		t.Error("DBDSN should default for sqlite")
	}
	if c.AgentDistribution != "embedded" {
		t.Errorf("AgentDistribution=%q want embedded", c.AgentDistribution)
	}
}

func TestFromEnv_PostgresRequiresDSN(t *testing.T) {
	t.Setenv("DATABASE_DRIVER", "postgres")
	t.Setenv("DATABASE_DSN", "")
	if _, err := FromEnv(); err == nil {
		t.Fatal("want error")
	}
}

func TestFromEnv_RejectsBadDistribution(t *testing.T) {
	t.Setenv("AGENT_DISTRIBUTION", "carrierpigeon")
	if _, err := FromEnv(); err == nil {
		t.Fatal("want error")
	}
}
```

- [ ] **Step 3: Run tests**

```
go test ./internal/config -v
```
Expected: all pass.

- [ ] **Step 4: Commit**

```
git add internal/config
git commit -m "feat(config): server env parsing with sqlite default + distribution validation"
```

---

### Task 5: `internal/auth` — bcrypt + sessions + middleware

**Files:**
- Create: `internal/auth/bcrypt.go`
- Create: `internal/auth/sessions.go`
- Create: `internal/auth/middleware.go`
- Create: `internal/auth/auth_test.go`

- [ ] **Step 1: Add bcrypt dep**

```
go get golang.org/x/crypto/bcrypt
```

- [ ] **Step 2: Write `internal/auth/bcrypt.go`**

```go
package auth

import "golang.org/x/crypto/bcrypt"

const bcryptCost = 12

func HashPassword(plain string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func VerifyPassword(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}
```

- [ ] **Step 3: Write `internal/auth/sessions.go`**

```go
package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"time"

	"github.com/jmoiron/sqlx"
)

const SessionTTL = 30 * 24 * time.Hour

var ErrInvalidSession = errors.New("invalid session")

type Session struct {
	Token     string    `db:"token"`
	AdminID   int64     `db:"admin_id"`
	ExpiresAt time.Time `db:"expires_at"`
	CreatedAt time.Time `db:"created_at"`
}

type Admin struct {
	ID           int64     `db:"id"`
	Username     string    `db:"username"`
	PasswordHash string    `db:"password_hash"`
	CreatedAt    time.Time `db:"created_at"`
}

type Store struct {
	DB *sqlx.DB
}

func (s *Store) FindAdminByUsername(ctx context.Context, username string) (*Admin, error) {
	var a Admin
	if err := s.DB.GetContext(ctx, &a, "SELECT id, username, password_hash, created_at FROM admins WHERE username=$1", username); err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Store) CreateAdmin(ctx context.Context, username, plainPassword string) (*Admin, error) {
	hash, err := HashPassword(plainPassword)
	if err != nil {
		return nil, err
	}
	res, err := s.DB.ExecContext(ctx, "INSERT INTO admins(username, password_hash) VALUES ($1, $2)", username, hash)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return &Admin{ID: id, Username: username, PasswordHash: hash, CreatedAt: time.Now()}, nil
}

func (s *Store) IssueSession(ctx context.Context, adminID int64) (*Session, error) {
	tok, err := randomToken(32)
	if err != nil {
		return nil, err
	}
	exp := time.Now().Add(SessionTTL)
	if _, err := s.DB.ExecContext(ctx, "INSERT INTO sessions(token, admin_id, expires_at) VALUES ($1, $2, $3)", tok, adminID, exp); err != nil {
		return nil, err
	}
	return &Session{Token: tok, AdminID: adminID, ExpiresAt: exp, CreatedAt: time.Now()}, nil
}

func (s *Store) LookupSession(ctx context.Context, token string) (*Session, *Admin, error) {
	var sess Session
	if err := s.DB.GetContext(ctx, &sess, "SELECT token, admin_id, expires_at, created_at FROM sessions WHERE token=$1", token); err != nil {
		return nil, nil, ErrInvalidSession
	}
	if time.Now().After(sess.ExpiresAt) {
		return nil, nil, ErrInvalidSession
	}
	var a Admin
	if err := s.DB.GetContext(ctx, &a, "SELECT id, username, password_hash, created_at FROM admins WHERE id=$1", sess.AdminID); err != nil {
		return nil, nil, ErrInvalidSession
	}
	return &sess, &a, nil
}

func (s *Store) RevokeSession(ctx context.Context, token string) error {
	_, err := s.DB.ExecContext(ctx, "DELETE FROM sessions WHERE token=$1", token)
	return err
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
```

> **Note:** `$1`/`$2` placeholders work for both Postgres (native) and SQLite (`go-sqlite3` accepts numbered placeholders). Stick to numbered placeholders throughout the codebase to keep dialect parity.

- [ ] **Step 4: Write `internal/auth/middleware.go`**

```go
package auth

import (
	"context"
	"net/http"
)

const cookieName = "__Host-shepherd_session"

type ctxKey int

const ctxKeyAdmin ctxKey = 0

func AdminFromContext(ctx context.Context) (*Admin, bool) {
	a, ok := ctx.Value(ctxKeyAdmin).(*Admin)
	return a, ok
}

type Handler struct {
	Store  *Store
	Secure bool // set true when behind TLS reverse proxy
}

func (h *Handler) RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(cookieName)
		if err != nil || c.Value == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_, admin, err := h.Store.LookupSession(r.Context(), c.Value)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), ctxKeyAdmin, admin)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (h *Handler) SetSessionCookie(w http.ResponseWriter, sess *Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    sess.Token,
		Path:     "/",
		Expires:  sess.ExpiresAt,
		HttpOnly: true,
		Secure:   h.Secure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (h *Handler) ClearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   h.Secure,
		SameSite: http.SameSiteLaxMode,
	})
}
```

> **`__Host-` prefix caveat:** browsers require `Secure=true` and no `Domain` attribute for `__Host-` cookies. While `h.Secure=false` (dev), the prefix is still in the name but the cookie won't be retained by browsers over plain HTTP. So for dev round-trips, fall back to non-prefixed `shepherd_session` when `!h.Secure`. Replace the `cookieName` constant block above with the following exported method (other packages need to read the cookie name to revoke sessions on logout), and replace every `cookieName` reference in this file with `h.CookieName()`:

```go
const (
	cookieNameSecure = "__Host-shepherd_session"
	cookieNameDev    = "shepherd_session"
)

// CookieName is exported because the api package reads the cookie value on logout.
func (h *Handler) CookieName() string {
	if h.Secure {
		return cookieNameSecure
	}
	return cookieNameDev
}
```

- [ ] **Step 5: Write `internal/auth/auth_test.go`**

```go
package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	shepdb "github.com/<owner>/shepherd/internal/db"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	return &Store{DB: d}
}

func TestAdminCreateAndVerify(t *testing.T) {
	s := newTestStore(t)
	a, err := s.CreateAdmin(context.Background(), "alice", "hunter2")
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.FindAdminByUsername(context.Background(), "alice")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != a.ID {
		t.Errorf("id mismatch")
	}
	if !VerifyPassword(got.PasswordHash, "hunter2") {
		t.Error("password should verify")
	}
	if VerifyPassword(got.PasswordHash, "wrong") {
		t.Error("wrong password should not verify")
	}
}

func TestSessionRoundTrip(t *testing.T) {
	s := newTestStore(t)
	a, _ := s.CreateAdmin(context.Background(), "bob", "pw")
	sess, err := s.IssueSession(context.Background(), a.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, got, err := s.LookupSession(context.Background(), sess.Token)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != a.ID {
		t.Error("id mismatch")
	}
	if err := s.RevokeSession(context.Background(), sess.Token); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.LookupSession(context.Background(), sess.Token); err == nil {
		t.Fatal("want error")
	}
}

func TestRequireAdminRejectsAnonymous(t *testing.T) {
	s := newTestStore(t)
	h := &Handler{Store: s, Secure: false}
	called := false
	final := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true })
	srv := h.RequireAdmin(final)

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status=%d want 401", w.Code)
	}
	if called {
		t.Error("handler should not have been called")
	}
}
```

- [ ] **Step 6: Run tests**

```
go test ./internal/auth -v
```
Expected: all pass.

- [ ] **Step 7: Commit**

```
git add go.mod go.sum internal/auth
git commit -m "feat(auth): bcrypt + DB-backed sessions + RequireAdmin middleware"
```

---

## Milestone 4 — Admin auth API

### Task 6: `internal/api/admin_auth.go` — login / logout / me

**Files:**
- Create: `internal/api/jsonio.go`
- Create: `internal/api/admin_auth.go`
- Create: `internal/api/admin_auth_test.go`

- [ ] **Step 1: Write `internal/api/jsonio.go`** (shared helpers)

```go
package api

import (
	"encoding/json"
	"net/http"
)

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if body != nil {
		_ = json.NewEncoder(w).Encode(body)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}
```

- [ ] **Step 2: Write `internal/api/admin_auth.go`**

```go
package api

import (
	"errors"
	"net/http"

	"github.com/<owner>/shepherd/internal/auth"
)

type AuthAPI struct {
	Auth *auth.Handler
}

type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (a *AuthAPI) Login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	admin, err := a.Auth.Store.FindAdminByUsername(r.Context(), req.Username)
	if err != nil || !auth.VerifyPassword(admin.PasswordHash, req.Password) {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	sess, err := a.Auth.Store.IssueSession(r.Context(), admin.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "session error")
		return
	}
	a.Auth.SetSessionCookie(w, sess)
	writeJSON(w, http.StatusOK, map[string]any{
		"id":       admin.ID,
		"username": admin.Username,
	})
}

func (a *AuthAPI) Logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(a.Auth.CookieName()); err == nil && c.Value != "" {
		_ = a.Auth.Store.RevokeSession(r.Context(), c.Value)
	}
	a.Auth.ClearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (a *AuthAPI) Me(w http.ResponseWriter, r *http.Request) {
	admin, ok := auth.AdminFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":       admin.ID,
		"username": admin.Username,
	})
}

var _ = errors.New // silence unused if errors trimmed later
```

> `a.Auth.CookieName()` is the exported method already defined in `internal/auth/middleware.go` from Task 5.

- [ ] **Step 3: Write `internal/api/admin_auth_test.go`**

```go
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/<owner>/shepherd/internal/auth"
	shepdb "github.com/<owner>/shepherd/internal/db"
)

func newAuthAPI(t *testing.T) (*AuthAPI, *auth.Store) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	store := &auth.Store{DB: d}
	_, _ = store.CreateAdmin(context.Background(), "alice", "hunter2")
	h := &auth.Handler{Store: store, Secure: false}
	return &AuthAPI{Auth: h}, store
}

func TestLogin_OK(t *testing.T) {
	a, _ := newAuthAPI(t)
	body, _ := json.Marshal(loginReq{Username: "alice", Password: "hunter2"})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/login", bytes.NewReader(body))
	a.Login(w, r)
	if w.Code != 200 {
		t.Fatalf("status=%d", w.Code)
	}
	if len(w.Result().Cookies()) == 0 {
		t.Fatal("missing session cookie")
	}
}

func TestLogin_BadCreds(t *testing.T) {
	a, _ := newAuthAPI(t)
	body, _ := json.Marshal(loginReq{Username: "alice", Password: "wrong"})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/login", bytes.NewReader(body))
	a.Login(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d want 401", w.Code)
	}
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/auth ./internal/api -v
```
Expected: green.

- [ ] **Step 5: Commit**

```
git add internal/auth internal/api
git commit -m "feat(api): /api/login, /api/logout, /api/admins/me"
```

---

## Milestone 5 — Server CRUD + settings

### Task 7: `internal/serversvc` — CRUD + settings KV

**Files:**
- Create: `internal/serversvc/service.go`
- Create: `internal/serversvc/settings.go`
- Create: `internal/serversvc/service_test.go`

- [ ] **Step 1: Write `internal/serversvc/service.go`**

```go
package serversvc

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/jmoiron/sqlx"
)

var ErrNotFound = errors.New("server not found")

type Server struct {
	ID                int64          `db:"id"                  json:"id"`
	Name              string         `db:"name"                json:"name"`
	PublicAlias       sql.NullString `db:"public_alias"        json:"public_alias"`
	PublicGroup       sql.NullString `db:"public_group"        json:"public_group"`
	CountryCode       sql.NullString `db:"country_code"        json:"country_code"`
	ShowOnPublic      bool           `db:"show_on_public"      json:"show_on_public"`

	SSHHost           sql.NullString `db:"ssh_host"            json:"ssh_host"`
	SSHPort           int            `db:"ssh_port"            json:"ssh_port"`
	SSHUser           sql.NullString `db:"ssh_user"            json:"ssh_user"`
	InstallStage      string         `db:"install_stage"       json:"install_stage"`
	InstallLog        string         `db:"install_log"         json:"install_log"`
	InstallError      sql.NullString `db:"install_error"       json:"install_error"`
	InstallStartedAt  sql.NullTime   `db:"install_started_at"  json:"install_started_at"`

	AgentVersion      sql.NullString `db:"agent_version"       json:"agent_version"`
	AgentOS           sql.NullString `db:"agent_os"            json:"agent_os"`
	AgentArch         sql.NullString `db:"agent_arch"          json:"agent_arch"`
	AgentKernel       sql.NullString `db:"agent_kernel"        json:"agent_kernel"`
	AgentLastSeen     sql.NullTime   `db:"agent_last_seen"     json:"agent_last_seen"`
	AgentFingerprint  sql.NullString `db:"agent_fingerprint"   json:"agent_fingerprint"`

	CreatedAt         time.Time      `db:"created_at"          json:"created_at"`
}

const selectAllCols = `id, name, public_alias, public_group, country_code, show_on_public,
	ssh_host, ssh_port, ssh_user, install_stage, install_log, install_error, install_started_at,
	agent_version, agent_os, agent_arch, agent_kernel, agent_last_seen, agent_fingerprint, created_at`

type Service struct {
	DB *sqlx.DB
}

type CreateInput struct {
	Name         string
	PublicAlias  string
	PublicGroup  string
	CountryCode  string
	ShowOnPublic bool
	SSHHost      string
	SSHPort      int
	SSHUser      string
}

func (s *Service) Create(ctx context.Context, in CreateInput) (*Server, error) {
	if in.SSHPort == 0 {
		in.SSHPort = 22
	}
	res, err := s.DB.ExecContext(ctx, `INSERT INTO servers
		(name, public_alias, public_group, country_code, show_on_public,
		 ssh_host, ssh_port, ssh_user, install_stage, install_log)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending','')`,
		in.Name, nullable(in.PublicAlias), nullable(in.PublicGroup), nullable(in.CountryCode),
		in.ShowOnPublic, nullable(in.SSHHost), in.SSHPort, nullable(in.SSHUser))
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	return s.Get(ctx, id)
}

func (s *Service) Get(ctx context.Context, id int64) (*Server, error) {
	var srv Server
	err := s.DB.GetContext(ctx, &srv, "SELECT "+selectAllCols+" FROM servers WHERE id=$1", id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &srv, err
}

func (s *Service) List(ctx context.Context) ([]*Server, error) {
	var out []*Server
	err := s.DB.SelectContext(ctx, &out, "SELECT "+selectAllCols+" FROM servers ORDER BY id")
	return out, err
}

type PatchInput struct {
	Name         *string
	PublicAlias  *string
	PublicGroup  *string
	CountryCode  *string
	ShowOnPublic *bool
}

func (s *Service) Patch(ctx context.Context, id int64, in PatchInput) (*Server, error) {
	if in.Name != nil {
		if _, err := s.DB.ExecContext(ctx, "UPDATE servers SET name=$1 WHERE id=$2", *in.Name, id); err != nil {
			return nil, err
		}
	}
	if in.PublicAlias != nil {
		if _, err := s.DB.ExecContext(ctx, "UPDATE servers SET public_alias=$1 WHERE id=$2", nullable(*in.PublicAlias), id); err != nil {
			return nil, err
		}
	}
	if in.PublicGroup != nil {
		if _, err := s.DB.ExecContext(ctx, "UPDATE servers SET public_group=$1 WHERE id=$2", nullable(*in.PublicGroup), id); err != nil {
			return nil, err
		}
	}
	if in.CountryCode != nil {
		if _, err := s.DB.ExecContext(ctx, "UPDATE servers SET country_code=$1 WHERE id=$2", nullable(*in.CountryCode), id); err != nil {
			return nil, err
		}
	}
	if in.ShowOnPublic != nil {
		if _, err := s.DB.ExecContext(ctx, "UPDATE servers SET show_on_public=$1 WHERE id=$2", *in.ShowOnPublic, id); err != nil {
			return nil, err
		}
	}
	return s.Get(ctx, id)
}

func (s *Service) Delete(ctx context.Context, id int64) error {
	res, err := s.DB.ExecContext(ctx, "DELETE FROM servers WHERE id=$1", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func nullable(s string) sql.NullString {
	if s == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: s, Valid: true}
}
```

- [ ] **Step 2: Write `internal/serversvc/settings.go`**

```go
package serversvc

import (
	"context"

	"github.com/jmoiron/sqlx"
)

type SettingsStore struct {
	DB *sqlx.DB
}

func (s *SettingsStore) GetAll(ctx context.Context) (map[string]string, error) {
	rows, err := s.DB.QueryContext(ctx, "SELECT key, value FROM settings")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

func (s *SettingsStore) Get(ctx context.Context, key string) (string, error) {
	var v string
	if err := s.DB.GetContext(ctx, &v, "SELECT value FROM settings WHERE key=$1", key); err != nil {
		return "", err
	}
	return v, nil
}

func (s *SettingsStore) Set(ctx context.Context, key, value string) error {
	// Postgres UPSERT and SQLite UPSERT both accept ON CONFLICT.
	_, err := s.DB.ExecContext(ctx,
		"INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
		key, value)
	return err
}
```

- [ ] **Step 3: Write `internal/serversvc/service_test.go`**

```go
package serversvc

import (
	"context"
	"path/filepath"
	"testing"

	shepdb "github.com/<owner>/shepherd/internal/db"
)

func newSvc(t *testing.T) *Service {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	return &Service{DB: d}
}

func TestCreateGetListPatchDelete(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	srv, err := svc.Create(ctx, CreateInput{Name: "h1", SSHHost: "1.2.3.4", SSHUser: "root"})
	if err != nil {
		t.Fatal(err)
	}
	if srv.ID == 0 || srv.SSHPort != 22 {
		t.Fatalf("bad create %+v", srv)
	}

	got, err := svc.Get(ctx, srv.ID)
	if err != nil || got.Name != "h1" {
		t.Fatalf("get fail: %v %+v", err, got)
	}

	all, _ := svc.List(ctx)
	if len(all) != 1 {
		t.Fatalf("list len=%d", len(all))
	}

	alias := "hk-1"
	show := true
	if _, err := svc.Patch(ctx, srv.ID, PatchInput{PublicAlias: &alias, ShowOnPublic: &show}); err != nil {
		t.Fatal(err)
	}
	got, _ = svc.Get(ctx, srv.ID)
	if got.PublicAlias.String != "hk-1" || !got.ShowOnPublic {
		t.Errorf("patch fail %+v", got)
	}

	if err := svc.Delete(ctx, srv.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Get(ctx, srv.ID); err != ErrNotFound {
		t.Errorf("want ErrNotFound, got %v", err)
	}
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/serversvc -v
```
Expected: green.

- [ ] **Step 5: Commit**

```
git add internal/serversvc
git commit -m "feat(serversvc): server CRUD + settings KV store"
```

---

### Task 8: `internal/api/admin_servers.go` + `admin_settings.go` — REST routes

**Files:**
- Create: `internal/api/admin_servers.go` (CRUD only; install/repair/config land in later tasks)
- Create: `internal/api/admin_settings.go`
- Create: `internal/api/admin_servers_test.go`

- [ ] **Step 1: Write `internal/api/admin_servers.go`**

```go
package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/<owner>/shepherd/internal/serversvc"
)

type ServersAPI struct {
	Servers *serversvc.Service
}

func (a *ServersAPI) List(w http.ResponseWriter, r *http.Request) {
	out, err := a.Servers.List(r.Context())
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, out)
}

type createReq struct {
	Name         string `json:"name"`
	PublicAlias  string `json:"public_alias"`
	PublicGroup  string `json:"public_group"`
	CountryCode  string `json:"country_code"`
	ShowOnPublic bool   `json:"show_on_public"`
}

func (a *ServersAPI) Create(w http.ResponseWriter, r *http.Request) {
	var in createReq
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeError(w, 400, "name required")
		return
	}
	srv, err := a.Servers.Create(r.Context(), serversvc.CreateInput{
		Name: in.Name, PublicAlias: in.PublicAlias, PublicGroup: in.PublicGroup,
		CountryCode: in.CountryCode, ShowOnPublic: in.ShowOnPublic,
	})
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 201, srv)
}

func (a *ServersAPI) Get(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "/api/servers/")
	if !ok {
		writeError(w, 400, "bad id")
		return
	}
	srv, err := a.Servers.Get(r.Context(), id)
	if errors.Is(err, serversvc.ErrNotFound) {
		writeError(w, 404, "not found")
		return
	}
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, srv)
}

type patchReq struct {
	Name         *string `json:"name"`
	PublicAlias  *string `json:"public_alias"`
	PublicGroup  *string `json:"public_group"`
	CountryCode  *string `json:"country_code"`
	ShowOnPublic *bool   `json:"show_on_public"`
}

func (a *ServersAPI) Patch(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "/api/servers/")
	if !ok {
		writeError(w, 400, "bad id")
		return
	}
	var in patchReq
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	srv, err := a.Servers.Patch(r.Context(), id, serversvc.PatchInput{
		Name: in.Name, PublicAlias: in.PublicAlias, PublicGroup: in.PublicGroup,
		CountryCode: in.CountryCode, ShowOnPublic: in.ShowOnPublic,
	})
	if errors.Is(err, serversvc.ErrNotFound) {
		writeError(w, 404, "not found")
		return
	}
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, srv)
}

func (a *ServersAPI) Delete(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "/api/servers/")
	if !ok {
		writeError(w, 400, "bad id")
		return
	}
	if err := a.Servers.Delete(r.Context(), id); err != nil {
		if errors.Is(err, serversvc.ErrNotFound) {
			writeError(w, 404, "not found")
			return
		}
		writeError(w, 500, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// pathID extracts the trailing numeric segment after `prefix`. Returns (0,false) if
// the request path doesn't match `prefix<digits>` (no trailing slash, no extra segments).
func pathID(r *http.Request, prefix string) (int64, bool) {
	if !strings.HasPrefix(r.URL.Path, prefix) {
		return 0, false
	}
	rest := strings.TrimPrefix(r.URL.Path, prefix)
	if rest == "" || strings.ContainsRune(rest, '/') {
		return 0, false
	}
	id, err := strconv.ParseInt(rest, 10, 64)
	if err != nil {
		return 0, false
	}
	return id, true
}
```

- [ ] **Step 2: Write `internal/api/admin_settings.go`**

```go
package api

import (
	"net/http"

	"github.com/<owner>/shepherd/internal/serversvc"
)

type SettingsAPI struct {
	Settings *serversvc.SettingsStore
}

func (a *SettingsAPI) GetAll(w http.ResponseWriter, r *http.Request) {
	m, err := a.Settings.GetAll(r.Context())
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, m)
}

func (a *SettingsAPI) Patch(w http.ResponseWriter, r *http.Request) {
	var in map[string]string
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	for k, v := range in {
		if err := a.Settings.Set(r.Context(), k, v); err != nil {
			writeError(w, 500, err.Error())
			return
		}
	}
	a.GetAll(w, r)
}
```

- [ ] **Step 3: Write `internal/api/admin_servers_test.go`** — exercise CRUD via the handlers

```go
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	shepdb "github.com/<owner>/shepherd/internal/db"
	"github.com/<owner>/shepherd/internal/serversvc"
)

func newServersAPI(t *testing.T) *ServersAPI {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	return &ServersAPI{Servers: &serversvc.Service{DB: d}}
}

func TestServersCRUD_HTTP(t *testing.T) {
	api := newServersAPI(t)

	// Create
	body, _ := json.Marshal(createReq{Name: "h1"})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/servers", bytes.NewReader(body))
	api.Create(w, r)
	if w.Code != 201 {
		t.Fatalf("create status=%d", w.Code)
	}
	var created serversvc.Server
	_ = json.Unmarshal(w.Body.Bytes(), &created)

	// Get
	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/api/servers/"+strconv.FormatInt(created.ID, 10), nil)
	api.Get(w, r)
	if w.Code != 200 {
		t.Fatalf("get status=%d", w.Code)
	}

	// Patch
	body, _ = json.Marshal(map[string]any{"name": "renamed"})
	w = httptest.NewRecorder()
	r = httptest.NewRequest("PATCH", "/api/servers/"+strconv.FormatInt(created.ID, 10), bytes.NewReader(body))
	api.Patch(w, r)
	if w.Code != 200 {
		t.Fatalf("patch status=%d", w.Code)
	}

	// Delete
	w = httptest.NewRecorder()
	r = httptest.NewRequest("DELETE", "/api/servers/"+strconv.FormatInt(created.ID, 10), nil)
	api.Delete(w, r)
	if w.Code != 204 {
		t.Fatalf("delete status=%d", w.Code)
	}
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/api -v
```

- [ ] **Step 5: Commit**

```
git add internal/api
git commit -m "feat(api): /api/servers CRUD + /api/settings"
```

---

## Milestone 6 — Wire types

### Task 9: `internal/agentapi` — envelope + payload structs

**Files:**
- Create: `internal/agentapi/envelope.go`
- Create: `internal/agentapi/types.go`
- Create: `internal/agentapi/envelope_test.go`

- [ ] **Step 1: Write `internal/agentapi/envelope.go`**

```go
package agentapi

import (
	"encoding/json"
)

// Envelope is the single wire frame for both directions on /agent/ws.
// Sid is reserved for session-correlated frames (Phase 2 PTY/stream); empty in Phase 1.
type Envelope struct {
	Sid  string          `json:"sid,omitempty"`
	Type string          `json:"type"`
	P    json.RawMessage `json:"p"`
}

// Frame builds an Envelope with payload `p` marshaled to JSON.
func Frame(typ string, p any) (Envelope, error) {
	raw, err := json.Marshal(p)
	if err != nil {
		return Envelope{}, err
	}
	return Envelope{Type: typ, P: raw}, nil
}

// Decode unmarshals e.P into out.
func (e Envelope) Decode(out any) error {
	return json.Unmarshal(e.P, out)
}
```

- [ ] **Step 2: Write `internal/agentapi/types.go`**

```go
package agentapi

import "time"

// Type constants — keep in lockstep with spec §5.
const (
	TypeConfigUpdate = "config.update"
	TypePing         = "ping"
	TypePong         = "pong"
	TypeHeartbeat    = "heartbeat"
	TypeTelemetry    = "telemetry"
)

type ConfigUpdate struct {
	TelemetryIntervalSeconds int `json:"telemetry_interval_seconds"`
}

type Heartbeat struct {
	TS           time.Time `json:"ts"`
	AgentVersion string    `json:"agent_version"`
	OS           string    `json:"os"`
	Arch         string    `json:"arch"`
	Kernel       string    `json:"kernel"`
}

type Disk struct {
	Mount string `json:"mount"`
	Used  int64  `json:"used"`
	Total int64  `json:"total"`
}

type Telemetry struct {
	TS       time.Time `json:"ts"`
	CPUPct   float64   `json:"cpu_pct"`
	MemUsed  int64     `json:"mem_used"`
	MemTotal int64     `json:"mem_total"`
	Load1    float64   `json:"load_1"`
	Load5    float64   `json:"load_5"`
	Load15   float64   `json:"load_15"`
	NetRxBps int64     `json:"net_rx_bps"`
	NetTxBps int64     `json:"net_tx_bps"`
	TCPConn  int       `json:"tcp_conn"`
	Disks    []Disk    `json:"disks"`
}

type EnrollRequest struct {
	EnrollmentToken string `json:"enrollment_token"`
	Fingerprint     string `json:"fingerprint"`
	OS              string `json:"os"`
	Arch            string `json:"arch"`
	Kernel          string `json:"kernel"`
	AgentVersion    string `json:"agent_version"`
}

type EnrollResponse struct {
	MachineToken string `json:"machine_token"`
	ServerID     int64  `json:"server_id"`
}

type AutoRegisterRequest struct {
	AutoRecoverKey string `json:"auto_recover_key"`
	Fingerprint    string `json:"fingerprint"`
	Hostname       string `json:"hostname"`
	OS             string `json:"os"`
	Arch           string `json:"arch"`
	Kernel         string `json:"kernel"`
	AgentVersion   string `json:"agent_version"`
}
```

- [ ] **Step 3: Write `internal/agentapi/envelope_test.go`**

```go
package agentapi

import (
	"encoding/json"
	"testing"
	"time"
)

func TestFrameAndDecode(t *testing.T) {
	src := Telemetry{TS: time.Unix(1700000000, 0).UTC(), CPUPct: 12.5, Disks: []Disk{{Mount: "/", Used: 1, Total: 2}}}
	e, err := Frame(TypeTelemetry, src)
	if err != nil {
		t.Fatal(err)
	}
	if e.Type != TypeTelemetry {
		t.Fatal("bad type")
	}
	var out Telemetry
	if err := e.Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.CPUPct != 12.5 || len(out.Disks) != 1 {
		t.Fatalf("decode mismatch %+v", out)
	}
}

func TestEnvelope_OmitsEmptySid(t *testing.T) {
	e, _ := Frame("ping", struct{}{})
	b, _ := json.Marshal(e)
	if got := string(b); got == "" || (len(got) > 0 && contains(got, `"sid"`)) {
		t.Errorf("unexpected sid in %s", got)
	}
}

func contains(s, sub string) bool { return len(s) >= len(sub) && (func() bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}()) }
```

- [ ] **Step 4: Run + commit**

```
go test ./internal/agentapi -v
git add internal/agentapi
git commit -m "feat(agentapi): envelope + payload types for server/agent wire protocol"
```

---

## Milestone 7 — Agent enrollment + auto-register

### Task 10: `internal/agentsvc` — enrollment + auto-register

**Files:**
- Create: `internal/agentsvc/enroll.go`
- Create: `internal/agentsvc/auto_register.go`
- Create: `internal/agentsvc/agentsvc_test.go`

- [ ] **Step 1: Write `internal/agentsvc/enroll.go`**

```go
package agentsvc

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"time"

	"github.com/jmoiron/sqlx"
)

const EnrollmentTokenTTL = 60 * time.Minute

var (
	ErrInvalidEnrollment = errors.New("invalid enrollment token")
	ErrFingerprintInUse  = errors.New("fingerprint already registered")
)

type Service struct {
	DB             *sqlx.DB
	AutoRecoverKey string // optional global key; empty = auto-register disabled
}

// IssueEnrollmentToken creates a one-shot token bound to serverID.
func (s *Service) IssueEnrollmentToken(ctx context.Context, serverID int64) (string, time.Time, error) {
	tok, err := randomToken(24)
	if err != nil {
		return "", time.Time{}, err
	}
	exp := time.Now().Add(EnrollmentTokenTTL)
	if _, err := s.DB.ExecContext(ctx, `INSERT INTO enrollment_tokens(token, server_id, expires_at) VALUES ($1,$2,$3)`,
		tok, serverID, exp); err != nil {
		return "", time.Time{}, err
	}
	return tok, exp, nil
}

// RedeemEnrollment consumes an enrollment token, mints a machine token,
// and persists the agent identity onto the bound server. Returns machine_token, server_id.
func (s *Service) RedeemEnrollment(ctx context.Context, enrollmentToken, fingerprint, osName, arch, kernel, agentVersion string) (string, int64, error) {
	tx, err := s.DB.BeginTxx(ctx, nil)
	if err != nil {
		return "", 0, err
	}
	defer tx.Rollback()

	var (
		serverID   int64
		expiresAt  time.Time
		consumedAt sql.NullTime
	)
	err = tx.QueryRowxContext(ctx,
		"SELECT server_id, expires_at, consumed_at FROM enrollment_tokens WHERE token=$1",
		enrollmentToken).Scan(&serverID, &expiresAt, &consumedAt)
	if err != nil {
		return "", 0, ErrInvalidEnrollment
	}
	if consumedAt.Valid || time.Now().After(expiresAt) {
		return "", 0, ErrInvalidEnrollment
	}

	// Reject if another server already owns this fingerprint.
	var other int64
	err = tx.QueryRowxContext(ctx, "SELECT id FROM servers WHERE agent_fingerprint=$1 AND id<>$2", fingerprint, serverID).Scan(&other)
	if err == nil {
		return "", 0, ErrFingerprintInUse
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", 0, err
	}

	machine, err := randomToken(32)
	if err != nil {
		return "", 0, err
	}
	if _, err := tx.ExecContext(ctx,
		"INSERT INTO machine_tokens(token, server_id) VALUES ($1, $2)", machine, serverID); err != nil {
		return "", 0, err
	}
	if _, err := tx.ExecContext(ctx,
		"UPDATE enrollment_tokens SET consumed_at=CURRENT_TIMESTAMP WHERE token=$1", enrollmentToken); err != nil {
		return "", 0, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE servers SET
			agent_fingerprint=$1, agent_os=$2, agent_arch=$3, agent_kernel=$4, agent_version=$5
			WHERE id=$6`,
		fingerprint, osName, arch, kernel, agentVersion, serverID); err != nil {
		return "", 0, err
	}
	if err := tx.Commit(); err != nil {
		return "", 0, err
	}
	return machine, serverID, nil
}

// AuthenticateMachineToken returns server_id for a valid machine_token, or error.
func (s *Service) AuthenticateMachineToken(ctx context.Context, token string) (int64, error) {
	var sid int64
	if err := s.DB.GetContext(ctx, &sid, "SELECT server_id FROM machine_tokens WHERE token=$1", token); err != nil {
		return 0, ErrInvalidEnrollment
	}
	return sid, nil
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
```

- [ ] **Step 2: Write `internal/agentsvc/auto_register.go`**

```go
package agentsvc

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
)

var ErrAutoRegisterDisabled = errors.New("auto-register disabled")
var ErrBadAutoRecoverKey = errors.New("bad auto recover key")

// AutoRegister either rotates the machine token of an existing server
// (matched by fingerprint) or creates a new server row and mints a fresh token.
func (s *Service) AutoRegister(ctx context.Context, key, fingerprint, hostname, osName, arch, kernel, agentVersion string) (string, int64, error) {
	if s.AutoRecoverKey == "" {
		return "", 0, ErrAutoRegisterDisabled
	}
	if subtle.ConstantTimeCompare([]byte(key), []byte(s.AutoRecoverKey)) != 1 {
		return "", 0, ErrBadAutoRecoverKey
	}

	tx, err := s.DB.BeginTxx(ctx, nil)
	if err != nil {
		return "", 0, err
	}
	defer tx.Rollback()

	var serverID int64
	err = tx.QueryRowxContext(ctx,
		"SELECT id FROM servers WHERE agent_fingerprint=$1", fingerprint).Scan(&serverID)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		// Create new server. Use hostname for name; fingerprint stays unique.
		res, err := tx.ExecContext(ctx, `INSERT INTO servers
			(name, agent_fingerprint, agent_os, agent_arch, agent_kernel, agent_version, install_stage)
			VALUES ($1, $2, $3, $4, $5, $6, 'done')`,
			hostname, fingerprint, osName, arch, kernel, agentVersion)
		if err != nil {
			return "", 0, err
		}
		serverID, _ = res.LastInsertId()
	case err != nil:
		return "", 0, err
	default:
		// Existing server — refresh metadata.
		if _, err := tx.ExecContext(ctx, `UPDATE servers SET
				agent_os=$1, agent_arch=$2, agent_kernel=$3, agent_version=$4
				WHERE id=$5`, osName, arch, kernel, agentVersion, serverID); err != nil {
			return "", 0, err
		}
		// Rotate: drop existing tokens for this server.
		if _, err := tx.ExecContext(ctx, "DELETE FROM machine_tokens WHERE server_id=$1", serverID); err != nil {
			return "", 0, err
		}
	}

	machine, err := randomToken(32)
	if err != nil {
		return "", 0, err
	}
	if _, err := tx.ExecContext(ctx,
		"INSERT INTO machine_tokens(token, server_id, rotated_at) VALUES ($1,$2,CURRENT_TIMESTAMP)",
		machine, serverID); err != nil {
		return "", 0, err
	}
	if err := tx.Commit(); err != nil {
		return "", 0, err
	}
	return machine, serverID, nil
}
```

- [ ] **Step 3: Write `internal/agentsvc/agentsvc_test.go`**

```go
package agentsvc

import (
	"context"
	"path/filepath"
	"testing"

	shepdb "github.com/<owner>/shepherd/internal/db"
)

func newSvc(t *testing.T) *Service {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	return &Service{DB: d, AutoRecoverKey: "secret"}
}

func mustCreateServer(t *testing.T, svc *Service, name string) int64 {
	t.Helper()
	res, err := svc.DB.Exec("INSERT INTO servers(name) VALUES ($1)", name)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := res.LastInsertId()
	return id
}

func TestEnrollment_Redeem(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	sid := mustCreateServer(t, svc, "h1")
	tok, _, err := svc.IssueEnrollmentToken(ctx, sid)
	if err != nil {
		t.Fatal(err)
	}
	machine, gotSID, err := svc.RedeemEnrollment(ctx, tok, "fp1", "linux", "amd64", "6.1", "v0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	if gotSID != sid || machine == "" {
		t.Fatalf("redeem mismatch sid=%d machine=%q", gotSID, machine)
	}
	// Second redeem of same token must fail.
	if _, _, err := svc.RedeemEnrollment(ctx, tok, "fp1", "linux", "amd64", "6.1", "v0.1.0"); err != ErrInvalidEnrollment {
		t.Fatalf("want ErrInvalidEnrollment, got %v", err)
	}
	// Authenticate works.
	authSID, err := svc.AuthenticateMachineToken(ctx, machine)
	if err != nil || authSID != sid {
		t.Fatalf("auth mismatch sid=%d err=%v", authSID, err)
	}
}

func TestAutoRegister_NewThenRotate(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	m1, sid1, err := svc.AutoRegister(ctx, "secret", "fpA", "host-a", "linux", "amd64", "6.1", "v0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	m2, sid2, err := svc.AutoRegister(ctx, "secret", "fpA", "host-a", "linux", "amd64", "6.1", "v0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	if sid1 != sid2 {
		t.Errorf("sid changed across rotation %d -> %d", sid1, sid2)
	}
	if m1 == m2 {
		t.Error("token should rotate")
	}
	// Old token rejected.
	if _, err := svc.AuthenticateMachineToken(ctx, m1); err == nil {
		t.Error("old token must be invalid after rotation")
	}
	// New token works.
	if _, err := svc.AuthenticateMachineToken(ctx, m2); err != nil {
		t.Errorf("new token: %v", err)
	}
}

func TestAutoRegister_BadKey(t *testing.T) {
	svc := newSvc(t)
	if _, _, err := svc.AutoRegister(context.Background(), "wrong", "fp", "h", "linux", "amd64", "6.1", "v0.1.0"); err != ErrBadAutoRecoverKey {
		t.Fatalf("want ErrBadAutoRecoverKey, got %v", err)
	}
}
```

- [ ] **Step 4: Run + commit**

```
go test ./internal/agentsvc -v
git add internal/agentsvc
git commit -m "feat(agentsvc): enrollment + auto-register flows with token rotation"
```

---

## Milestone 8 — Hub + WS

### Task 11: `internal/agentsvc/hub.go` — in-memory online registry

**Files:**
- Create: `internal/agentsvc/hub.go`
- Create: `internal/agentsvc/hub_test.go`

- [ ] **Step 1: Write `internal/agentsvc/hub.go`**

```go
package agentsvc

import (
	"errors"
	"sync"

	"github.com/<owner>/shepherd/internal/agentapi"
)

var ErrAgentOffline = errors.New("agent offline")

// Conn is the minimal interface an agent connection must satisfy. Implemented
// by the WebSocket handler in api/agent_routes.go.
type Conn interface {
	Send(env agentapi.Envelope) error
	Close() error
}

type Hub struct {
	mu    sync.Mutex
	conns map[int64]Conn // server_id -> conn
}

func NewHub() *Hub {
	return &Hub{conns: map[int64]Conn{}}
}

// Register replaces any existing conn for serverID and returns the previous conn (if any)
// so the caller can close it. Last-writer-wins keeps the registry consistent across
// reconnects without leaking goroutines.
func (h *Hub) Register(serverID int64, c Conn) Conn {
	h.mu.Lock()
	defer h.mu.Unlock()
	prev := h.conns[serverID]
	h.conns[serverID] = c
	return prev
}

// Unregister removes the entry for serverID *only if* the current conn matches `c`.
// This avoids races where a stale goroutine evicts a fresher reconnect.
func (h *Hub) Unregister(serverID int64, c Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conns[serverID] == c {
		delete(h.conns, serverID)
	}
}

func (h *Hub) Send(serverID int64, env agentapi.Envelope) error {
	h.mu.Lock()
	c := h.conns[serverID]
	h.mu.Unlock()
	if c == nil {
		return ErrAgentOffline
	}
	return c.Send(env)
}

func (h *Hub) IsOnline(serverID int64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.conns[serverID]
	return ok
}
```

- [ ] **Step 2: Write `internal/agentsvc/hub_test.go`**

```go
package agentsvc

import (
	"errors"
	"testing"

	"github.com/<owner>/shepherd/internal/agentapi"
)

type fakeConn struct {
	sent   []agentapi.Envelope
	closed bool
	fail   error
}

func (f *fakeConn) Send(e agentapi.Envelope) error {
	if f.fail != nil {
		return f.fail
	}
	f.sent = append(f.sent, e)
	return nil
}
func (f *fakeConn) Close() error { f.closed = true; return nil }

func TestHub_RegisterReplacesPrev(t *testing.T) {
	h := NewHub()
	c1 := &fakeConn{}
	c2 := &fakeConn{}
	if prev := h.Register(7, c1); prev != nil {
		t.Errorf("first register prev=%v", prev)
	}
	prev := h.Register(7, c2)
	if prev != c1 {
		t.Errorf("second register prev mismatch")
	}
}

func TestHub_SendDelivers(t *testing.T) {
	h := NewHub()
	c := &fakeConn{}
	h.Register(7, c)
	env, _ := agentapi.Frame("ping", struct{}{})
	if err := h.Send(7, env); err != nil {
		t.Fatal(err)
	}
	if len(c.sent) != 1 || c.sent[0].Type != "ping" {
		t.Fatalf("sent=%+v", c.sent)
	}
}

func TestHub_SendOffline(t *testing.T) {
	h := NewHub()
	env, _ := agentapi.Frame("ping", struct{}{})
	if err := h.Send(99, env); !errors.Is(err, ErrAgentOffline) {
		t.Fatalf("err=%v", err)
	}
}

func TestHub_UnregisterOnlyIfCurrent(t *testing.T) {
	h := NewHub()
	c1 := &fakeConn{}
	c2 := &fakeConn{}
	h.Register(7, c1)
	h.Register(7, c2)
	h.Unregister(7, c1) // stale; should NOT remove c2
	if !h.IsOnline(7) {
		t.Error("stale unregister evicted current conn")
	}
	h.Unregister(7, c2)
	if h.IsOnline(7) {
		t.Error("real unregister failed")
	}
}
```

- [ ] **Step 3: Run + commit**

```
go test ./internal/agentsvc -v
git add internal/agentsvc
git commit -m "feat(agentsvc): in-memory hub for online-agent push (last-writer-wins)"
```

---

### Task 12: `internal/api/agent_routes.go` — `/agent/enroll`, `/agent/auto-register`, `/agent/ws`

**Files:**
- Create: `internal/api/agent_routes.go`
- Create: `internal/api/agent_routes_test.go`

- [ ] **Step 1: Add WS dep**

```
go get github.com/gorilla/websocket
```

- [ ] **Step 2: Write `internal/api/agent_routes.go`**

```go
package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/<owner>/shepherd/internal/agentapi"
	"github.com/<owner>/shepherd/internal/agentsvc"
)

const (
	wsWriteTimeout    = 10 * time.Second
	wsPingInterval    = 30 * time.Second
	wsPongWait        = 90 * time.Second
)

type AgentAPI struct {
	Agents     *agentsvc.Service
	Hub        *agentsvc.Hub
	OnFrame    FrameHandler // injected by router; receives agent->server envelopes
}

// FrameHandler dispatches agent→server frames. Implemented by ingest pipeline (Task 14).
type FrameHandler func(ctx context.Context, serverID int64, env agentapi.Envelope)

func (a *AgentAPI) Enroll(w http.ResponseWriter, r *http.Request) {
	var req agentapi.EnrollRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	machine, sid, err := a.Agents.RedeemEnrollment(r.Context(), req.EnrollmentToken,
		req.Fingerprint, req.OS, req.Arch, req.Kernel, req.AgentVersion)
	if err != nil {
		// Permanent failure: 401 so agent exits and operator regenerates.
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}
	writeJSON(w, 200, agentapi.EnrollResponse{MachineToken: machine, ServerID: sid})
}

func (a *AgentAPI) AutoRegister(w http.ResponseWriter, r *http.Request) {
	var req agentapi.AutoRegisterRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	machine, sid, err := a.Agents.AutoRegister(r.Context(), req.AutoRecoverKey,
		req.Fingerprint, req.Hostname, req.OS, req.Arch, req.Kernel, req.AgentVersion)
	if err != nil {
		status := http.StatusUnauthorized
		if errors.Is(err, agentsvc.ErrAutoRegisterDisabled) {
			status = http.StatusForbidden
		}
		writeError(w, status, err.Error())
		return
	}
	writeJSON(w, 200, agentapi.EnrollResponse{MachineToken: machine, ServerID: sid})
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true }, // agent has bearer auth instead
}

// WS handles /agent/ws upgrade. Bearer machine_token in Authorization header.
func (a *AgentAPI) WS(w http.ResponseWriter, r *http.Request) {
	tok := bearerToken(r.Header.Get("Authorization"))
	if tok == "" {
		writeError(w, 401, "missing bearer")
		return
	}
	sid, err := a.Agents.AuthenticateMachineToken(r.Context(), tok)
	if err != nil {
		writeError(w, 401, "bad token")
		return
	}

	c, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}

	conn := &wsConn{c: c}
	if prev := a.Hub.Register(sid, conn); prev != nil {
		_ = prev.Close()
	}
	defer func() {
		a.Hub.Unregister(sid, conn)
		_ = conn.Close()
	}()

	c.SetReadDeadline(time.Now().Add(wsPongWait))
	c.SetPongHandler(func(string) error {
		c.SetReadDeadline(time.Now().Add(wsPongWait))
		return nil
	})

	stop := make(chan struct{})
	go a.pingLoop(conn, stop)
	defer close(stop)

	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			return
		}
		var env agentapi.Envelope
		if err := envDecode(data, &env); err != nil {
			log.Printf("ws decode: %v", err)
			continue
		}
		switch env.Type {
		case agentapi.TypePong:
			c.SetReadDeadline(time.Now().Add(wsPongWait))
		default:
			if a.OnFrame != nil {
				a.OnFrame(r.Context(), sid, env)
			}
		}
	}
}

func (a *AgentAPI) pingLoop(c *wsConn, stop <-chan struct{}) {
	t := time.NewTicker(wsPingInterval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			env, _ := agentapi.Frame(agentapi.TypePing, struct{}{})
			_ = c.Send(env)
		}
	}
}

func bearerToken(h string) string {
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return ""
	}
	return strings.TrimSpace(h[len(prefix):])
}

// wsConn satisfies agentsvc.Conn.
type wsConn struct {
	c    *websocket.Conn
	mu   sync.Mutex
}

func (w *wsConn) Send(env agentapi.Envelope) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.c.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
	return w.c.WriteJSON(env)
}

func (w *wsConn) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.c.Close()
}
```

- [ ] **Step 3: Add envDecode helper** — append to `internal/api/jsonio.go`:

```go
func envDecode(data []byte, v any) error {
	return json.Unmarshal(data, v)
}
```

- [ ] **Step 4: Write `internal/api/agent_routes_test.go`** — covers HTTP enroll + WS round-trip

```go
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/<owner>/shepherd/internal/agentapi"
	"github.com/<owner>/shepherd/internal/agentsvc"
	shepdb "github.com/<owner>/shepherd/internal/db"
)

func newAgentAPI(t *testing.T) (*AgentAPI, *agentsvc.Service) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	svc := &agentsvc.Service{DB: d, AutoRecoverKey: "k"}
	return &AgentAPI{Agents: svc, Hub: agentsvc.NewHub()}, svc
}

func TestEnroll_HTTP(t *testing.T) {
	a, svc := newAgentAPI(t)
	res, _ := svc.DB.Exec("INSERT INTO servers(name) VALUES ('h')")
	sid, _ := res.LastInsertId()
	tok, _, _ := svc.IssueEnrollmentToken(context.Background(), sid)

	body, _ := json.Marshal(agentapi.EnrollRequest{
		EnrollmentToken: tok, Fingerprint: "fp", OS: "linux", Arch: "amd64", Kernel: "6.1", AgentVersion: "v0.1.0",
	})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/agent/enroll", bytes.NewReader(body))
	a.Enroll(w, r)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestWS_RoundTrip(t *testing.T) {
	a, svc := newAgentAPI(t)
	res, _ := svc.DB.Exec("INSERT INTO servers(name) VALUES ('h')")
	sid, _ := res.LastInsertId()
	machine, _, _ := svc.AutoRegister(context.Background(), "k", "fp", "h", "linux", "amd64", "6.1", "v0")
	_ = sid
	_ = machine

	got := make(chan agentapi.Envelope, 1)
	a.OnFrame = func(_ context.Context, _ int64, env agentapi.Envelope) {
		got <- env
	}

	srv := httptest.NewServer(http.HandlerFunc(a.WS))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	hdr := http.Header{}
	hdr.Set("Authorization", "Bearer "+machine)
	c, _, err := websocket.DefaultDialer.Dial(wsURL, hdr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	// Send a heartbeat envelope and ensure handler received it.
	env, _ := agentapi.Frame(agentapi.TypeHeartbeat, agentapi.Heartbeat{TS: time.Now().UTC(), AgentVersion: "v0"})
	if err := c.WriteJSON(env); err != nil {
		t.Fatal(err)
	}
	select {
	case e := <-got:
		if e.Type != agentapi.TypeHeartbeat {
			t.Fatalf("got %s", e.Type)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for frame")
	}

	// Verify push works in the reverse direction via Hub.
	var pushed atomic.Int32
	go func() {
		_, data, err := c.ReadMessage()
		if err == nil {
			var env agentapi.Envelope
			_ = json.Unmarshal(data, &env)
			if env.Type == agentapi.TypeConfigUpdate {
				pushed.Add(1)
			}
		}
	}()
	cfg, _ := agentapi.Frame(agentapi.TypeConfigUpdate, agentapi.ConfigUpdate{TelemetryIntervalSeconds: 10})
	if err := a.Hub.Send(int64(1), cfg); err != nil {
		t.Fatalf("hub push: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	if pushed.Load() != 1 {
		t.Fatal("agent did not receive pushed config.update")
	}
}
```

- [ ] **Step 5: Run + commit**

```
go test ./internal/api -v -run "Enroll|WS_"
git add go.mod go.sum internal/api
git commit -m "feat(api): /agent/enroll, /agent/auto-register, /agent/ws with hub registration"
```

---

## Milestone 9 — Telemetry pipeline

### Task 13: `internal/telemetrysvc/ingest.go` — accept telemetry frames

**Files:**
- Create: `internal/telemetrysvc/ingest.go`
- Create: `internal/telemetrysvc/ingest_test.go`

- [ ] **Step 1: Write `internal/telemetrysvc/ingest.go`**

```go
package telemetrysvc

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/<owner>/shepherd/internal/agentapi"
)

type Ingest struct {
	DB *sqlx.DB
}

// HandleFrame is the FrameHandler injected into AgentAPI. It dispatches by envelope type.
func (i *Ingest) HandleFrame(ctx context.Context, serverID int64, env agentapi.Envelope) {
	switch env.Type {
	case agentapi.TypeTelemetry:
		var t agentapi.Telemetry
		if err := env.Decode(&t); err != nil {
			log.Printf("telemetry decode (server=%d): %v", serverID, err)
			return
		}
		if err := i.WriteSample(ctx, serverID, t); err != nil {
			log.Printf("telemetry write (server=%d): %v", serverID, err)
		}
	case agentapi.TypeHeartbeat:
		var h agentapi.Heartbeat
		if err := env.Decode(&h); err != nil {
			return
		}
		_, _ = i.DB.ExecContext(ctx, `UPDATE servers SET
				agent_last_seen=$1, agent_version=$2, agent_os=$3, agent_arch=$4, agent_kernel=$5
				WHERE id=$6`,
			time.Now().UTC(), h.AgentVersion, h.OS, h.Arch, h.Kernel, serverID)
	}
}

// WriteSample persists one telemetry point and bumps agent_last_seen.
func (i *Ingest) WriteSample(ctx context.Context, serverID int64, t agentapi.Telemetry) error {
	disksJSON, _ := json.Marshal(t.Disks)
	if _, err := i.DB.ExecContext(ctx, `INSERT INTO telemetry_samples_30s
		(server_id, ts, cpu_pct, mem_used, mem_total, load_1, load_5, load_15,
		 net_rx_bps, net_tx_bps, tcp_conn, disks_json)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
		serverID, t.TS.UTC(), t.CPUPct, t.MemUsed, t.MemTotal, t.Load1, t.Load5, t.Load15,
		t.NetRxBps, t.NetTxBps, t.TCPConn, string(disksJSON)); err != nil {
		return err
	}
	_, err := i.DB.ExecContext(ctx, "UPDATE servers SET agent_last_seen=$1 WHERE id=$2", t.TS.UTC(), serverID)
	return err
}
```

- [ ] **Step 2: Write `internal/telemetrysvc/ingest_test.go`**

```go
package telemetrysvc

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/<owner>/shepherd/internal/agentapi"
	shepdb "github.com/<owner>/shepherd/internal/db"
)

func newIngest(t *testing.T) (*Ingest, int64) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	res, _ := d.Exec("INSERT INTO servers(name) VALUES ('h')")
	id, _ := res.LastInsertId()
	return &Ingest{DB: d}, id
}

func TestWriteSample_PersistsAndBumpsLastSeen(t *testing.T) {
	ing, sid := newIngest(t)
	now := time.Now().UTC().Truncate(time.Second)
	tt := agentapi.Telemetry{
		TS: now, CPUPct: 12.5, MemUsed: 1, MemTotal: 2, Load1: 0.1,
		NetRxBps: 100, NetTxBps: 200, TCPConn: 7,
		Disks: []agentapi.Disk{{Mount: "/", Used: 10, Total: 100}},
	}
	if err := ing.WriteSample(context.Background(), sid, tt); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := ing.DB.Get(&n, "SELECT COUNT(*) FROM telemetry_samples_30s WHERE server_id=?", sid); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("rows=%d", n)
	}
	var seen time.Time
	if err := ing.DB.Get(&seen, "SELECT agent_last_seen FROM servers WHERE id=?", sid); err != nil {
		t.Fatal(err)
	}
	if seen.IsZero() {
		t.Error("agent_last_seen not bumped")
	}
}
```

- [ ] **Step 3: Run + commit**

```
go test ./internal/telemetrysvc -v
git add internal/telemetrysvc
git commit -m "feat(telemetry): ingest telemetry+heartbeat envelopes, persist samples"
```

---

### Task 14: `internal/telemetrysvc/rollup.go` — minute-tick aggregator

**Files:**
- Create: `internal/telemetrysvc/rollup.go`
- Create: `internal/telemetrysvc/rollup_test.go`

- [ ] **Step 1: Write `internal/telemetrysvc/rollup.go`**

```go
package telemetrysvc

import (
	"context"
	"log"
	"time"

	"github.com/jmoiron/sqlx"
)

type Rollup struct {
	DB       *sqlx.DB
	Interval time.Duration // default 1m
}

// Run blocks until ctx is canceled. Closes (server_id, bucket_start) tuples that
// are now strictly in the past.
func (r *Rollup) Run(ctx context.Context) {
	if r.Interval == 0 {
		r.Interval = time.Minute
	}
	t := time.NewTicker(r.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := r.Tick(ctx); err != nil {
				log.Printf("rollup tick: %v", err)
			}
		}
	}
}

func (r *Rollup) Tick(ctx context.Context) error {
	if err := r.rollup(ctx, "telemetry_rollup_5m", 5*time.Minute); err != nil {
		return err
	}
	return r.rollup(ctx, "telemetry_rollup_1h", time.Hour)
}

// rollup folds samples_30s into the named rollup table for any (server, bucket) that:
//   1. has at least one sample in the bucket
//   2. has bucket_end <= NOW()  (closed)
//   3. doesn't already have a row in the rollup table
func (r *Rollup) rollup(ctx context.Context, table string, bucket time.Duration) error {
	bucketSecs := int64(bucket.Seconds())
	now := time.Now().UTC()
	// "bucket_start = ts - (ts % bucket)" via integer math on unixepoch (sqlite) /
	// EXTRACT(epoch FROM ts) (postgres). Compute candidates server-side in Go: fetch
	// distinct (server, bucket_start) from samples_30s where bucket_end<=now.
	rows, err := r.DB.QueryContext(ctx, `SELECT server_id, ts FROM telemetry_samples_30s ORDER BY server_id, ts`)
	if err != nil {
		return err
	}
	type key struct {
		sid int64
		ts  time.Time
	}
	seen := map[key]struct{}{}
	var candidates []key
	for rows.Next() {
		var sid int64
		var ts time.Time
		if err := rows.Scan(&sid, &ts); err != nil {
			rows.Close()
			return err
		}
		bucketStart := ts.Truncate(bucket)
		if bucketStart.Add(bucket).After(now) {
			continue // bucket still open
		}
		k := key{sid, bucketStart}
		if _, ok := seen[k]; ok {
			continue
		}
		seen[k] = struct{}{}
		candidates = append(candidates, k)
	}
	rows.Close()

	for _, k := range candidates {
		var exists int
		_ = r.DB.GetContext(ctx, &exists, "SELECT COUNT(*) FROM "+table+" WHERE server_id=$1 AND ts=$2", k.sid, k.ts)
		if exists == 1 {
			continue
		}
		end := k.ts.Add(bucket)
		insert := `INSERT INTO ` + table + `
			(server_id, ts, cpu_avg, cpu_max, mem_used_avg, mem_used_max, mem_total,
			 load_1_avg, load_1_max, net_rx_bps_avg, net_rx_bps_max,
			 net_tx_bps_avg, net_tx_bps_max, tcp_conn_avg, tcp_conn_max, disks_json)
			SELECT $1, $2,
			  AVG(cpu_pct), MAX(cpu_pct),
			  AVG(mem_used), MAX(mem_used), MAX(mem_total),
			  AVG(load_1), MAX(load_1),
			  AVG(net_rx_bps), MAX(net_rx_bps),
			  AVG(net_tx_bps), MAX(net_tx_bps),
			  AVG(tcp_conn), MAX(tcp_conn),
			  -- pick the latest disks_json in the bucket
			  (SELECT disks_json FROM telemetry_samples_30s
			    WHERE server_id=$1 AND ts >= $2 AND ts < $3
			    ORDER BY ts DESC LIMIT 1)
			FROM telemetry_samples_30s
			WHERE server_id=$1 AND ts >= $2 AND ts < $3`
		if _, err := r.DB.ExecContext(ctx, insert, k.sid, k.ts, end); err != nil {
			return err
		}
		_ = bucketSecs
	}
	return nil
}
```

- [ ] **Step 2: Write `internal/telemetrysvc/rollup_test.go`**

```go
package telemetrysvc

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/<owner>/shepherd/internal/agentapi"
	shepdb "github.com/<owner>/shepherd/internal/db"
)

func TestRollup_5m_FoldsClosedBucket(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	res, _ := d.Exec("INSERT INTO servers(name) VALUES ('h')")
	sid, _ := res.LastInsertId()
	ing := &Ingest{DB: d}

	// Insert four samples in the 5-minute bucket starting 10 min ago (closed bucket).
	bucket := time.Now().UTC().Add(-10 * time.Minute).Truncate(5 * time.Minute)
	for i, cpu := range []float64{10, 20, 30, 40} {
		_ = ing.WriteSample(context.Background(), sid, agentapi.Telemetry{
			TS: bucket.Add(time.Duration(i) * 30 * time.Second), CPUPct: cpu, MemUsed: int64(100 * (i + 1)), MemTotal: 1000,
		})
	}
	r := &Rollup{DB: d}
	if err := r.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	var (
		cpuAvg, cpuMax float64
		n              int
	)
	d.Get(&n, "SELECT COUNT(*) FROM telemetry_rollup_5m WHERE server_id=?", sid)
	if n != 1 {
		t.Fatalf("rows=%d want 1", n)
	}
	d.Get(&cpuAvg, "SELECT cpu_avg FROM telemetry_rollup_5m WHERE server_id=?", sid)
	d.Get(&cpuMax, "SELECT cpu_max FROM telemetry_rollup_5m WHERE server_id=?", sid)
	if cpuAvg != 25 || cpuMax != 40 {
		t.Errorf("avg=%v max=%v want 25/40", cpuAvg, cpuMax)
	}
	// Idempotent: second tick must not duplicate.
	_ = r.Tick(context.Background())
	d.Get(&n, "SELECT COUNT(*) FROM telemetry_rollup_5m WHERE server_id=?", sid)
	if n != 1 {
		t.Errorf("rollup duplicated rows=%d", n)
	}
}

func TestRollup_OpenBucketSkipped(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	res, _ := d.Exec("INSERT INTO servers(name) VALUES ('h')")
	sid, _ := res.LastInsertId()
	ing := &Ingest{DB: d}
	_ = ing.WriteSample(context.Background(), sid, agentapi.Telemetry{TS: time.Now().UTC()})
	r := &Rollup{DB: d}
	_ = r.Tick(context.Background())
	var n int
	d.Get(&n, "SELECT COUNT(*) FROM telemetry_rollup_5m")
	if n != 0 {
		t.Errorf("open bucket was rolled up")
	}
}
```

- [ ] **Step 3: Run + commit**

```
go test ./internal/telemetrysvc -v
git add internal/telemetrysvc
git commit -m "feat(telemetry): minute-tick rollup into 5m/1h tables, idempotent"
```

---

### Task 15: `internal/telemetrysvc/retention.go` + `query.go`

**Files:**
- Create: `internal/telemetrysvc/retention.go`
- Create: `internal/telemetrysvc/query.go`
- Create: `internal/telemetrysvc/query_test.go`

- [ ] **Step 1: Write `internal/telemetrysvc/retention.go`**

```go
package telemetrysvc

import (
	"context"
	"log"
	"time"

	"github.com/jmoiron/sqlx"
)

type Retention struct {
	DB       *sqlx.DB
	Settings interface {
		Get(ctx context.Context, key string) (string, error)
	}
	Interval time.Duration // default 10m
}

func (r *Retention) Run(ctx context.Context) {
	if r.Interval == 0 {
		r.Interval = 10 * time.Minute
	}
	t := time.NewTicker(r.Interval)
	defer t.Stop()
	r.Tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.Tick(ctx)
		}
	}
}

func (r *Retention) Tick(ctx context.Context) {
	for _, c := range []struct {
		key, table string
		def        time.Duration
	}{
		{"retention_30s", "telemetry_samples_30s", 24 * time.Hour},
		{"retention_5m", "telemetry_rollup_5m", 7 * 24 * time.Hour},
		{"retention_1h", "telemetry_rollup_1h", 90 * 24 * time.Hour},
	} {
		dur := c.def
		if v, err := r.Settings.Get(ctx, c.key); err == nil {
			if d, err := time.ParseDuration(v); err == nil {
				dur = d
			}
		}
		cutoff := time.Now().UTC().Add(-dur)
		if _, err := r.DB.ExecContext(ctx, "DELETE FROM "+c.table+" WHERE ts < $1", cutoff); err != nil {
			log.Printf("retention %s: %v", c.table, err)
		}
	}
}
```

- [ ] **Step 2: Write `internal/telemetrysvc/query.go`**

```go
package telemetrysvc

import (
	"context"
	"errors"
	"time"

	"github.com/jmoiron/sqlx"
)

type Range string

const (
	Range1h  Range = "1h"
	Range24h Range = "24h"
	Range7d  Range = "7d"
)

func (r Range) Window() (time.Duration, error) {
	switch r {
	case Range1h:
		return time.Hour, nil
	case Range24h:
		return 24 * time.Hour, nil
	case Range7d:
		return 7 * 24 * time.Hour, nil
	}
	return 0, errors.New("invalid range")
}

// Granularity decides which table backs a range. 1h -> raw 30s; 24h -> 5m; 7d -> 1h.
func (r Range) Table() (string, error) {
	switch r {
	case Range1h:
		return "telemetry_samples_30s", nil
	case Range24h:
		return "telemetry_rollup_5m", nil
	case Range7d:
		return "telemetry_rollup_1h", nil
	}
	return "", errors.New("invalid range")
}

type Point struct {
	TS         time.Time `db:"ts"             json:"ts"`
	CPU        *float64  `db:"cpu"            json:"cpu_pct,omitempty"`
	MemUsed    *int64    `db:"mem_used"       json:"mem_used,omitempty"`
	MemTotal   *int64    `db:"mem_total"      json:"mem_total,omitempty"`
	Load1      *float64  `db:"load_1"         json:"load_1,omitempty"`
	NetRxBps   *int64    `db:"net_rx_bps"     json:"net_rx_bps,omitempty"`
	NetTxBps   *int64    `db:"net_tx_bps"     json:"net_tx_bps,omitempty"`
	TCPConn    *int      `db:"tcp_conn"       json:"tcp_conn,omitempty"`
	DisksJSON  *string   `db:"disks_json"     json:"disks_json,omitempty"`
}

type Query struct {
	DB *sqlx.DB
}

func (q *Query) Series(ctx context.Context, serverID int64, rng Range) ([]Point, error) {
	win, err := rng.Window()
	if err != nil {
		return nil, err
	}
	table, _ := rng.Table()
	since := time.Now().UTC().Add(-win)

	var sql string
	switch table {
	case "telemetry_samples_30s":
		sql = `SELECT ts, cpu_pct AS cpu, mem_used, mem_total, load_1, net_rx_bps, net_tx_bps, tcp_conn, disks_json
		       FROM telemetry_samples_30s WHERE server_id=$1 AND ts>=$2 ORDER BY ts`
	default:
		sql = `SELECT ts, cpu_avg AS cpu, mem_used_avg AS mem_used, mem_total, load_1_avg AS load_1,
		              net_rx_bps_avg AS net_rx_bps, net_tx_bps_avg AS net_tx_bps,
		              tcp_conn_avg AS tcp_conn, disks_json
		       FROM ` + table + ` WHERE server_id=$1 AND ts>=$2 ORDER BY ts`
	}
	var out []Point
	if err := q.DB.SelectContext(ctx, &out, sql, serverID, since); err != nil {
		return nil, err
	}
	return out, nil
}

// Latest returns the most recent 30s sample for a server, or nil.
func (q *Query) Latest(ctx context.Context, serverID int64) (*Point, error) {
	var p Point
	err := q.DB.GetContext(ctx, &p, `SELECT ts, cpu_pct AS cpu, mem_used, mem_total, load_1,
		net_rx_bps, net_tx_bps, tcp_conn, disks_json
		FROM telemetry_samples_30s WHERE server_id=$1 ORDER BY ts DESC LIMIT 1`, serverID)
	if err != nil {
		return nil, err
	}
	return &p, nil
}
```

- [ ] **Step 3: Write `internal/telemetrysvc/query_test.go`**

```go
package telemetrysvc

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/<owner>/shepherd/internal/agentapi"
	shepdb "github.com/<owner>/shepherd/internal/db"
)

func TestQuery_1h_UsesRawTable(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	res, _ := d.Exec("INSERT INTO servers(name) VALUES ('h')")
	sid, _ := res.LastInsertId()
	ing := &Ingest{DB: d}
	now := time.Now().UTC()
	for i := 0; i < 5; i++ {
		_ = ing.WriteSample(context.Background(), sid, agentapi.Telemetry{TS: now.Add(-time.Duration(i) * time.Minute), CPUPct: float64(i)})
	}
	q := &Query{DB: d}
	pts, err := q.Series(context.Background(), sid, Range1h)
	if err != nil {
		t.Fatal(err)
	}
	if len(pts) != 5 {
		t.Errorf("len=%d want 5", len(pts))
	}
}

func TestQuery_BadRange(t *testing.T) {
	q := &Query{}
	if _, err := q.Series(context.Background(), 1, "30d"); err == nil {
		t.Fatal("want error")
	}
}
```

- [ ] **Step 4: Run + commit**

```
go test ./internal/telemetrysvc -v
git add internal/telemetrysvc
git commit -m "feat(telemetry): retention pruning + range-aware time-series query"
```

---

## Milestone 10 — Public + admin telemetry routes

### Task 16: `internal/api/public.go` + telemetry routes on admin servers

**Files:**
- Create: `internal/api/public.go`
- Modify: `internal/api/admin_servers.go` (append `Telemetry` and `WithLatest`)
- Create: `internal/api/public_test.go`

- [ ] **Step 1: Append to `internal/api/admin_servers.go`**

```go
// --- telemetry on admin path ---
import (
	"github.com/<owner>/shepherd/internal/telemetrysvc"
)

// Wire into ServersAPI by adding fields:
//   Query    *telemetrysvc.Query
//   Hub      *agentsvc.Hub
//   Settings *serversvc.SettingsStore
// (Update earlier struct accordingly when wiring router.)

func (a *ServersAPI) Telemetry(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID2(r, "/api/servers/", "/telemetry")
	if !ok {
		writeError(w, 400, "bad path")
		return
	}
	rng := telemetrysvc.Range(r.URL.Query().Get("range"))
	pts, err := a.Query.Series(r.Context(), id, rng)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, pts)
}

// pathID2 extracts the numeric segment between two fixed wrappers.
//   pathID2(r, "/api/servers/", "/telemetry") on "/api/servers/42/telemetry" -> 42, true
func pathID2(r *http.Request, prefix, suffix string) (int64, bool) {
	p := r.URL.Path
	if !strings.HasPrefix(p, prefix) || !strings.HasSuffix(p, suffix) {
		return 0, false
	}
	mid := strings.TrimSuffix(strings.TrimPrefix(p, prefix), suffix)
	if mid == "" || strings.ContainsRune(mid, '/') {
		return 0, false
	}
	id, err := strconv.ParseInt(mid, 10, 64)
	if err != nil {
		return 0, false
	}
	return id, true
}
```

> `pathID2` is defined here once and reused by repair/config endpoints in Task 19.

- [ ] **Step 2: Write `internal/api/public.go`**

```go
package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/<owner>/shepherd/internal/agentsvc"
	"github.com/<owner>/shepherd/internal/serversvc"
	"github.com/<owner>/shepherd/internal/telemetrysvc"
)

type PublicAPI struct {
	Servers  *serversvc.Service
	Settings *serversvc.SettingsStore
	Query    *telemetrysvc.Query
	Hub      *agentsvc.Hub
}

type publicCard struct {
	ID          int64    `json:"id"`
	Alias       string   `json:"alias"`
	Group       string   `json:"group"`
	CountryCode string   `json:"country_code"`
	Online      bool     `json:"online"`
	Latest      *latest  `json:"latest,omitempty"`
}

type latest struct {
	TS        time.Time `json:"ts"`
	CPUPct    float64   `json:"cpu_pct"`
	MemPct    float64   `json:"mem_pct"`
	DisksPct  []float64 `json:"disks_pct"`
	NetRxBps  int64     `json:"net_rx_bps"`
	NetTxBps  int64     `json:"net_tx_bps"`
	Load1     float64   `json:"load_1"`
	TCPConn   int       `json:"tcp_conn"`
}

func (a *PublicAPI) Servers_ListPublic(w http.ResponseWriter, r *http.Request) {
	all, err := a.Servers.List(r.Context())
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	intervalStr, _ := a.Settings.Get(r.Context(), "default_telemetry_interval_seconds")
	intervalSecs, _ := strconv.Atoi(intervalStr)
	if intervalSecs <= 0 {
		intervalSecs = 30
	}
	threshold := time.Duration(intervalSecs*3) * time.Second
	if threshold < 90*time.Second {
		threshold = 90 * time.Second
	}

	out := []publicCard{}
	for _, s := range all {
		if !s.ShowOnPublic || !s.PublicAlias.Valid || s.PublicAlias.String == "" {
			continue
		}
		card := publicCard{
			ID:          s.ID,
			Alias:       s.PublicAlias.String,
			Group:       s.PublicGroup.String,
			CountryCode: s.CountryCode.String,
			Online:      s.AgentLastSeen.Valid && time.Since(s.AgentLastSeen.Time) <= threshold,
		}
		if pt, err := a.Query.Latest(r.Context(), s.ID); err == nil && pt != nil {
			card.Latest = renderLatest(pt)
		}
		out = append(out, card)
	}
	writeJSON(w, 200, out)
}

func renderLatest(p *telemetrysvc.Point) *latest {
	l := &latest{}
	l.TS = p.TS
	if p.CPU != nil {
		l.CPUPct = *p.CPU
	}
	if p.MemUsed != nil && p.MemTotal != nil && *p.MemTotal > 0 {
		l.MemPct = float64(*p.MemUsed) / float64(*p.MemTotal) * 100
	}
	if p.Load1 != nil {
		l.Load1 = *p.Load1
	}
	if p.NetRxBps != nil {
		l.NetRxBps = *p.NetRxBps
	}
	if p.NetTxBps != nil {
		l.NetTxBps = *p.NetTxBps
	}
	if p.TCPConn != nil {
		l.TCPConn = *p.TCPConn
	}
	if p.DisksJSON != nil {
		var disks []struct {
			Used  int64 `json:"used"`
			Total int64 `json:"total"`
		}
		if err := json.Unmarshal([]byte(*p.DisksJSON), &disks); err == nil {
			for _, d := range disks {
				if d.Total > 0 {
					l.DisksPct = append(l.DisksPct, float64(d.Used)/float64(d.Total)*100)
				}
			}
		}
	}
	return l
}

func (a *PublicAPI) Telemetry(w http.ResponseWriter, r *http.Request) {
	const prefix = "/api/public/servers/"
	const suffix = "/telemetry"
	if !strings.HasPrefix(r.URL.Path, prefix) || !strings.HasSuffix(r.URL.Path, suffix) {
		writeError(w, 400, "bad path")
		return
	}
	mid := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, prefix), suffix)
	id, err := strconv.ParseInt(mid, 10, 64)
	if err != nil {
		writeError(w, 400, "bad id")
		return
	}
	srv, err := a.Servers.Get(r.Context(), id)
	if err != nil || !srv.ShowOnPublic {
		writeError(w, 404, "not found")
		return
	}
	rng := telemetrysvc.Range(r.URL.Query().Get("range"))
	pts, err := a.Query.Series(r.Context(), id, rng)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, pts)
}

func (a *PublicAPI) Settings(w http.ResponseWriter, r *http.Request) {
	mode, _ := a.Settings.Get(r.Context(), "public_display_mode")
	if mode == "" {
		mode = "both"
	}
	writeJSON(w, 200, map[string]string{"public_display_mode": mode})
}
```

- [ ] **Step 3: Write `internal/api/public_test.go`**

```go
package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/<owner>/shepherd/internal/agentapi"
	"github.com/<owner>/shepherd/internal/agentsvc"
	shepdb "github.com/<owner>/shepherd/internal/db"
	"github.com/<owner>/shepherd/internal/serversvc"
	"github.com/<owner>/shepherd/internal/telemetrysvc"
)

func TestPublic_HidesPrivateAndExposesAlias(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)

	svc := &serversvc.Service{DB: d}
	settings := &serversvc.SettingsStore{DB: d}
	q := &telemetrysvc.Query{DB: d}
	hub := agentsvc.NewHub()
	api := &PublicAPI{Servers: svc, Settings: settings, Query: q, Hub: hub}

	// 1) public + alias
	a, _ := svc.Create(context.Background(), serversvc.CreateInput{Name: "internal-name-A", PublicAlias: "HK-1", ShowOnPublic: true, CountryCode: "HK"})
	// 2) hidden
	_, _ = svc.Create(context.Background(), serversvc.CreateInput{Name: "internal-name-B", ShowOnPublic: false})

	// One sample for the public server.
	ing := &telemetrysvc.Ingest{DB: d}
	_ = ing.WriteSample(context.Background(), a.ID, agentapi.Telemetry{TS: time.Now().UTC(), CPUPct: 5, MemUsed: 1, MemTotal: 2})
	_, _ = d.Exec("UPDATE servers SET agent_last_seen=$1 WHERE id=$2", time.Now().UTC(), a.ID)

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/public/servers", nil)
	api.Servers_ListPublic(w, r)
	if w.Code != 200 {
		t.Fatalf("status=%d", w.Code)
	}
	var cards []publicCard
	_ = json.Unmarshal(w.Body.Bytes(), &cards)
	if len(cards) != 1 || cards[0].Alias != "HK-1" || cards[0].CountryCode != "HK" {
		t.Fatalf("cards=%+v", cards)
	}
	if !cards[0].Online {
		t.Error("should be online")
	}
	body := w.Body.String()
	for _, leak := range []string{"internal-name-A", "ssh_user", "agent_fingerprint"} {
		if jsonContains(body, leak) {
			t.Errorf("public leaked %q", leak)
		}
	}
}

func jsonContains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: Run + commit**

```
go test ./internal/api -v -run "Public|CRUD"
git add internal/api
git commit -m "feat(api): public desensitized cards + range-aware telemetry endpoints"
```

---

## Milestone 11 — Installer

### Task 17: `internal/installer` — SSH session + distribution dispatch

**Files:**
- Create: `internal/installer/distribution.go`
- Create: `internal/installer/embedded.go`
- Create: `internal/installer/installer.go`
- Create: `internal/installer/installer_test.go`

- [ ] **Step 1: Add SSH dep**

```
go get golang.org/x/crypto/ssh
```

- [ ] **Step 2: Write `internal/installer/distribution.go`**

```go
package installer

import (
	"errors"
	"fmt"
	"io"
)

// Distribution provides the agent binary for a given target arch in one of two ways:
// stream the embedded bytes, or print a curl-from-GitHub script.
type Distribution interface {
	// Provide returns either an io.Reader to stream into /usr/local/bin/shepherd-agent (when streamed=true),
	// or a shell snippet to run on the target (when streamed=false). Caller chooses the path.
	Provide(arch string) (data io.Reader, snippet string, streamed bool, err error)
}

var ErrUnsupportedArch = errors.New("unsupported arch")

func validArch(a string) bool {
	return a == "amd64" || a == "arm64"
}

func _ = fmt.Sprintf // keep fmt import optional
```

- [ ] **Step 3: Write `internal/installer/embedded.go`**

```go
package installer

import (
	"bytes"
	"embed"
	"fmt"
	"io"
)

//go:embed bin/*
var agentBin embed.FS

// EmbeddedDistribution streams agent binaries packed at server build time.
// Plan 1.C wires the Makefile to populate internal/installer/bin/shepherd-agent-linux-<arch>
// as part of the server build. During Phase 1.A development, place placeholder bytes
// (e.g. compiled local agent) into bin/ before running install end-to-end.
type EmbeddedDistribution struct{}

func (EmbeddedDistribution) Provide(arch string) (io.Reader, string, bool, error) {
	if !validArch(arch) {
		return nil, "", false, ErrUnsupportedArch
	}
	name := fmt.Sprintf("bin/shepherd-agent-linux-%s", arch)
	b, err := agentBin.ReadFile(name)
	if err != nil {
		return nil, "", false, fmt.Errorf("agent binary missing for %s: build it before installing", arch)
	}
	return bytes.NewReader(b), "", true, nil
}
```

> Create `internal/installer/bin/.gitkeep` so the embed directive matches when no binaries are present yet:
> ```
> mkdir -p internal/installer/bin && touch internal/installer/bin/.gitkeep
> ```

- [ ] **Step 4: Append GitHub mode to `internal/installer/distribution.go`**

```go
// (append below the existing file)

type GitHubDistribution struct {
	Owner string // e.g. "lietu6"
	Repo  string // e.g. "shepherd"
	Tag   string // e.g. "v0.1.0"
}

func (g GitHubDistribution) Provide(arch string) (io.Reader, string, bool, error) {
	if !validArch(arch) {
		return nil, "", false, ErrUnsupportedArch
	}
	url := fmt.Sprintf("https://github.com/%s/%s/releases/download/%s/shepherd-agent-linux-%s",
		g.Owner, g.Repo, g.Tag, arch)
	snippet := fmt.Sprintf(`curl -fsSL %q -o /usr/local/bin/shepherd-agent && chmod +x /usr/local/bin/shepherd-agent`, url)
	return nil, snippet, false, nil
}
```

- [ ] **Step 5: Write `internal/installer/installer.go`**

```go
package installer

import (
	"context"
	"fmt"
	"io"
	"net"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// SSHCredentials holds the one-shot install credentials. They are NEVER persisted.
type SSHCredentials struct {
	Host     string
	Port     int
	User     string
	Password string // either Password or PrivateKey, not both
	PrivateKey []byte
}

type Installer struct {
	Distribution Distribution
	// LogSink receives streamed install_log; the install state machine bridges it to DB.
	// It MUST be safe for concurrent calls.
	LogSink func(line string)
	// SSHTimeout for connect + each command. Default 30s.
	SSHTimeout time.Duration
}

type InstallParams struct {
	Creds              SSHCredentials
	Arch               string  // "amd64" | "arm64"
	ServerURL          string  // base URL the agent will dial back to (incl. scheme)
	EnrollmentToken    string
}

// Run performs the install. It returns when the systemd service has been started.
// All progress is streamed to LogSink; fatal errors return as well.
func (in *Installer) Run(ctx context.Context, p InstallParams) error {
	if in.SSHTimeout == 0 {
		in.SSHTimeout = 30 * time.Second
	}
	in.log("connecting to %s@%s:%d", p.Creds.User, p.Creds.Host, p.Creds.Port)

	auth, err := buildAuth(p.Creds)
	if err != nil {
		return err
	}
	cfg := &ssh.ClientConfig{
		User:            p.Creds.User,
		Auth:            auth,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // TODO: TOFU before exposing publicly
		Timeout:         in.SSHTimeout,
	}
	addr := net.JoinHostPort(p.Creds.Host, fmt.Sprintf("%d", p.Creds.Port))
	c, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		return fmt.Errorf("ssh dial: %w", err)
	}
	defer c.Close()
	in.log("connected")

	// 1) ensure /etc/shepherd exists
	if err := in.runCmd(c, `mkdir -p /etc/shepherd && chmod 0750 /etc/shepherd`); err != nil {
		return err
	}

	// 2) deliver agent binary via Distribution
	data, snippet, streamed, err := in.Distribution.Provide(p.Arch)
	if err != nil {
		return fmt.Errorf("distribution: %w", err)
	}
	if streamed {
		if err := in.streamFile(c, data, "/usr/local/bin/shepherd-agent", 0755); err != nil {
			return err
		}
	} else {
		if err := in.runCmd(c, snippet); err != nil {
			return err
		}
	}
	in.log("agent binary in place")

	// 3) write /etc/shepherd/agent.env
	envContent := fmt.Sprintf("SERVER_URL=%s\nENROLLMENT_TOKEN=%s\n", p.ServerURL, p.EnrollmentToken)
	if err := in.streamFile(c, strings.NewReader(envContent), "/etc/shepherd/agent.env", 0600); err != nil {
		return err
	}

	// 4) write /etc/systemd/system/shepherd-agent.service
	unit := `[Unit]
Description=Shepherd agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/shepherd/agent.env
ExecStart=/usr/local/bin/shepherd-agent
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
`
	if err := in.streamFile(c, strings.NewReader(unit), "/etc/systemd/system/shepherd-agent.service", 0644); err != nil {
		return err
	}

	// 5) reload + enable + start
	for _, cmd := range []string{
		`systemctl daemon-reload`,
		`systemctl enable shepherd-agent`,
		`systemctl restart shepherd-agent`,
	} {
		if err := in.runCmd(c, cmd); err != nil {
			return err
		}
	}
	in.log("service started")
	return nil
}

func (in *Installer) log(format string, args ...any) {
	if in.LogSink != nil {
		in.LogSink(fmt.Sprintf(format, args...))
	}
}

func (in *Installer) runCmd(c *ssh.Client, cmd string) error {
	sess, err := c.NewSession()
	if err != nil {
		return err
	}
	defer sess.Close()
	in.log("$ %s", cmd)
	out, err := sess.CombinedOutput(cmd)
	if len(out) > 0 {
		in.log("%s", strings.TrimRight(string(out), "\n"))
	}
	if err != nil {
		return fmt.Errorf("cmd %q failed: %w", cmd, err)
	}
	return nil
}

// streamFile writes content to remotePath via `cat > file && chmod` over a single SSH session.
// Avoids needing scp on the target.
func (in *Installer) streamFile(c *ssh.Client, src io.Reader, remotePath string, mode int) error {
	sess, err := c.NewSession()
	if err != nil {
		return err
	}
	defer sess.Close()
	stdin, err := sess.StdinPipe()
	if err != nil {
		return err
	}
	cmd := fmt.Sprintf("umask 077 && cat > %q && chmod %o %q", remotePath, mode, remotePath)
	if err := sess.Start(cmd); err != nil {
		return err
	}
	if _, err := io.Copy(stdin, src); err != nil {
		return err
	}
	if err := stdin.Close(); err != nil {
		return err
	}
	if err := sess.Wait(); err != nil {
		return fmt.Errorf("write %s: %w", remotePath, err)
	}
	in.log("wrote %s", remotePath)
	return nil
}

func buildAuth(c SSHCredentials) ([]ssh.AuthMethod, error) {
	if len(c.PrivateKey) > 0 {
		signer, err := ssh.ParsePrivateKey(c.PrivateKey)
		if err != nil {
			return nil, fmt.Errorf("parse private key: %w", err)
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	}
	if c.Password != "" {
		return []ssh.AuthMethod{ssh.Password(c.Password)}, nil
	}
	return nil, fmt.Errorf("no ssh credentials provided")
}
```

- [ ] **Step 6: Write `internal/installer/installer_test.go`** (unit-only — full SSH path is exercised in M16 smoke)

```go
package installer

import "testing"

func TestGitHubDistribution_Snippet(t *testing.T) {
	d := GitHubDistribution{Owner: "lietu6", Repo: "shepherd", Tag: "v0.1.0"}
	_, snip, streamed, err := d.Provide("amd64")
	if err != nil {
		t.Fatal(err)
	}
	if streamed {
		t.Error("github mode should be snippet, not streamed")
	}
	if !contains(snip, "shepherd-agent-linux-amd64") || !contains(snip, "v0.1.0") {
		t.Errorf("snippet=%q", snip)
	}
}

func TestEmbeddedDistribution_MissingArch(t *testing.T) {
	if _, _, _, err := (EmbeddedDistribution{}).Provide("riscv"); err != ErrUnsupportedArch {
		t.Fatalf("err=%v", err)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
```

- [ ] **Step 7: Run + commit**

```
go test ./internal/installer -v
git add go.mod go.sum internal/installer
git commit -m "feat(installer): SSH-based agent install + embedded/github distribution channels"
```

---

## Milestone 12 — Async install state machine

### Task 18: `internal/serversvc/install.go` — orchestrate install + watchdog

**Files:**
- Create: `internal/serversvc/install.go`
- Modify: `internal/serversvc/service.go` (add `appendInstallLog` helper near top)
- Create: `internal/serversvc/install_test.go`

- [ ] **Step 1: Append helper to `internal/serversvc/service.go`**

```go
// appendInstallLog atomically appends a line + "\n" to servers.install_log.
// Both SQLite and Postgres support COALESCE + concat with `||`.
func (s *Service) appendInstallLog(ctx context.Context, id int64, line string) {
	_, _ = s.DB.ExecContext(ctx,
		`UPDATE servers SET install_log = install_log || $1 WHERE id=$2`, line+"\n", id)
}

// SetInstallStage updates install_stage, optionally clearing install_error.
func (s *Service) SetInstallStage(ctx context.Context, id int64, stage string, errMsg *string) error {
	if errMsg == nil {
		_, err := s.DB.ExecContext(ctx, "UPDATE servers SET install_stage=$1, install_error=NULL WHERE id=$2", stage, id)
		return err
	}
	_, err := s.DB.ExecContext(ctx, "UPDATE servers SET install_stage=$1, install_error=$2 WHERE id=$3", stage, *errMsg, id)
	return err
}
```

- [ ] **Step 2: Write `internal/serversvc/install.go`**

```go
package serversvc

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"time"

	"github.com/<owner>/shepherd/internal/installer"
)

// Installer is the subset of *installer.Installer the state machine needs.
type Installer interface {
	Run(ctx context.Context, p installer.InstallParams) error
}

// AgentTokenIssuer issues a one-shot enrollment token bound to a server.
type AgentTokenIssuer interface {
	IssueEnrollmentToken(ctx context.Context, serverID int64) (string, time.Time, error)
}

type InstallManager struct {
	Service     *Service
	Installer   Installer
	Tokens      AgentTokenIssuer
	ServerURL   string // base URL agent will dial back to
	WatchdogTimeout time.Duration // default 10m
}

type InstallRequest struct {
	Server     *Server
	Creds      installer.SSHCredentials
	Arch       string // "amd64" | "arm64"; defaults from server fields if empty
}

// Start launches an install in a background goroutine and returns immediately.
// Updates the server row's install_stage / install_log / install_error as it goes.
// Idempotency: caller is responsible for checking the row isn't already in 'installing'.
func (m *InstallManager) Start(req InstallRequest) {
	go m.run(context.Background(), req)
}

func (m *InstallManager) run(ctx context.Context, req InstallRequest) {
	sid := req.Server.ID
	// Mark started.
	now := time.Now().UTC()
	_, _ = m.Service.DB.ExecContext(ctx,
		"UPDATE servers SET install_stage='installing', install_started_at=$1, install_log='', install_error=NULL WHERE id=$2",
		now, sid)

	// Mint enrollment token.
	tok, _, err := m.Tokens.IssueEnrollmentToken(ctx, sid)
	if err != nil {
		m.fail(ctx, sid, "enrollment token: "+err.Error())
		return
	}

	arch := strings.ToLower(strings.TrimSpace(req.Arch))
	if arch == "" {
		arch = runtime.GOARCH // fallback when not supplied — the install form should set it
		if arch != "amd64" && arch != "arm64" {
			arch = "amd64"
		}
	}

	// Attach a log sink that writes to the row.
	sink := func(line string) {
		m.Service.appendInstallLog(ctx, sid, line)
	}
	// The Installer is shared, but its LogSink isn't — wrap by passing per-request.
	type sinkSetter interface{ SetLogSink(func(string)) }
	if s, ok := m.Installer.(sinkSetter); ok {
		s.SetLogSink(sink)
	}
	// Otherwise, expect Installer to be unique per-call (Service constructs a fresh one
	// per install in router wiring; see Task 19).

	if err := m.Installer.Run(ctx, installer.InstallParams{
		Creds:           req.Creds,
		Arch:            arch,
		ServerURL:       m.ServerURL,
		EnrollmentToken: tok,
	}); err != nil {
		m.fail(ctx, sid, err.Error())
		return
	}

	if err := m.Service.SetInstallStage(ctx, sid, "done", nil); err != nil {
		m.fail(ctx, sid, "finalize: "+err.Error())
		return
	}
}

func (m *InstallManager) fail(ctx context.Context, sid int64, msg string) {
	_ = m.Service.SetInstallStage(ctx, sid, "failed", &msg)
}

// SweepStuck marks any server stuck in 'installing' for longer than WatchdogTimeout as failed.
// Run once at server startup so a crashed install doesn't leave UI hanging.
func (m *InstallManager) SweepStuck(ctx context.Context) error {
	timeout := m.WatchdogTimeout
	if timeout == 0 {
		timeout = 10 * time.Minute
	}
	cutoff := time.Now().UTC().Add(-timeout)
	_, err := m.Service.DB.ExecContext(ctx,
		`UPDATE servers SET install_stage='failed', install_error='install watchdog: stuck > timeout'
		 WHERE install_stage='installing' AND install_started_at < $1`, cutoff)
	return err
}

var _ = errors.New
```

> The `sinkSetter` indirection lets a *real* `*installer.Installer` accept per-request log sinks. Add a tiny method to the installer:

Append to `internal/installer/installer.go`:

```go
func (in *Installer) SetLogSink(f func(string)) { in.LogSink = f }
```

- [ ] **Step 3: Write `internal/serversvc/install_test.go`**

```go
package serversvc

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/<owner>/shepherd/internal/db"
	"github.com/<owner>/shepherd/internal/installer"
)

type fakeInstaller struct {
	fail bool
	sink func(string)
}

func (f *fakeInstaller) Run(_ context.Context, _ installer.InstallParams) error {
	if f.sink != nil {
		f.sink("hello")
	}
	if f.fail {
		return errors.New("boom")
	}
	return nil
}
func (f *fakeInstaller) SetLogSink(s func(string)) { f.sink = s }

type fakeTokens struct{}

func (fakeTokens) IssueEnrollmentToken(context.Context, int64) (string, time.Time, error) {
	return "tok", time.Now().Add(time.Hour), nil
}

func newInstallTest(t *testing.T) (*InstallManager, *Service, int64) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	svc := &Service{DB: d}
	srv, _ := svc.Create(context.Background(), CreateInput{Name: "h", SSHHost: "h"})
	mgr := &InstallManager{Service: svc, Tokens: fakeTokens{}, ServerURL: "http://x"}
	return mgr, svc, srv.ID
}

func TestInstallManager_HappyPath(t *testing.T) {
	mgr, svc, sid := newInstallTest(t)
	mgr.Installer = &fakeInstaller{}
	mgr.Start(InstallRequest{Server: &Server{ID: sid}, Arch: "amd64"})
	// Wait for goroutine.
	for i := 0; i < 100; i++ {
		s, _ := svc.Get(context.Background(), sid)
		if s.InstallStage == "done" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	s, _ := svc.Get(context.Background(), sid)
	if s.InstallStage != "done" {
		t.Fatalf("stage=%s", s.InstallStage)
	}
	if !contains2(s.InstallLog, "hello") {
		t.Errorf("log missing 'hello': %q", s.InstallLog)
	}
}

func TestInstallManager_FailureRecorded(t *testing.T) {
	mgr, svc, sid := newInstallTest(t)
	mgr.Installer = &fakeInstaller{fail: true}
	mgr.Start(InstallRequest{Server: &Server{ID: sid}, Arch: "amd64"})
	for i := 0; i < 100; i++ {
		s, _ := svc.Get(context.Background(), sid)
		if s.InstallStage == "failed" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	s, _ := svc.Get(context.Background(), sid)
	if s.InstallStage != "failed" || !s.InstallError.Valid || !contains2(s.InstallError.String, "boom") {
		t.Fatalf("got stage=%s err=%+v", s.InstallStage, s.InstallError)
	}
}

func TestSweepStuck(t *testing.T) {
	mgr, svc, sid := newInstallTest(t)
	old := time.Now().Add(-time.Hour).UTC()
	_, _ = svc.DB.Exec("UPDATE servers SET install_stage='installing', install_started_at=$1 WHERE id=$2", old, sid)
	if err := mgr.SweepStuck(context.Background()); err != nil {
		t.Fatal(err)
	}
	s, _ := svc.Get(context.Background(), sid)
	if s.InstallStage != "failed" {
		t.Errorf("stage=%s", s.InstallStage)
	}
}

func contains2(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: Run + commit**

```
go test ./internal/serversvc -v
git add internal/serversvc internal/installer
git commit -m "feat(serversvc): async install state machine + watchdog for stuck rows"
```

---

### Task 19: install / repair / config-push routes on `admin_servers.go`

**Files:**
- Modify: `internal/api/admin_servers.go` (add `Install`, `Repair`, `Config` handlers + new ServersAPI fields)
- Create: `internal/api/install_routes_test.go`

- [ ] **Step 1: Replace top of `internal/api/admin_servers.go` to expand ServersAPI struct**

```go
type ServersAPI struct {
	Servers          *serversvc.Service
	Settings         *serversvc.SettingsStore
	Query            *telemetrysvc.Query
	Hub              *agentsvc.Hub
	InstallManager   *serversvc.InstallManager
	Tokens           *agentsvc.Service // for repair
}
```

- [ ] **Step 2: Add install/repair/config handlers**

```go
type installReq struct {
	Name         string `json:"name"`
	SSHHost      string `json:"ssh_host"`
	SSHPort      int    `json:"ssh_port"`
	SSHUser      string `json:"ssh_user"`
	SSHPassword  string `json:"ssh_password"`
	SSHKey       string `json:"ssh_key"`
	Arch         string `json:"arch"` // amd64|arm64
	PublicAlias  string `json:"public_alias"`
	PublicGroup  string `json:"public_group"`
	CountryCode  string `json:"country_code"`
	ShowOnPublic bool   `json:"show_on_public"`
}

func (a *ServersAPI) Install(w http.ResponseWriter, r *http.Request) {
	var in installReq
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	if strings.TrimSpace(in.Name) == "" || strings.TrimSpace(in.SSHHost) == "" || strings.TrimSpace(in.SSHUser) == "" {
		writeError(w, 400, "name, ssh_host, ssh_user required")
		return
	}
	if in.SSHPassword == "" && in.SSHKey == "" {
		writeError(w, 400, "one of ssh_password or ssh_key required")
		return
	}
	if in.Arch != "amd64" && in.Arch != "arm64" {
		writeError(w, 400, "arch must be amd64 or arm64")
		return
	}
	srv, err := a.Servers.Create(r.Context(), serversvc.CreateInput{
		Name: in.Name, SSHHost: in.SSHHost, SSHPort: in.SSHPort, SSHUser: in.SSHUser,
		PublicAlias: in.PublicAlias, PublicGroup: in.PublicGroup,
		CountryCode: in.CountryCode, ShowOnPublic: in.ShowOnPublic,
	})
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	creds := installerCreds(in)
	a.InstallManager.Start(serversvc.InstallRequest{Server: srv, Creds: creds, Arch: in.Arch})
	writeJSON(w, 202, map[string]any{"server_id": srv.ID})
}

func installerCreds(in installReq) installer.SSHCredentials {
	creds := installer.SSHCredentials{Host: in.SSHHost, Port: in.SSHPort, User: in.SSHUser, Password: in.SSHPassword}
	if creds.Port == 0 {
		creds.Port = 22
	}
	if in.SSHKey != "" {
		creds.PrivateKey = []byte(in.SSHKey)
	}
	return creds
}

// Repair regenerates an enrollment token; the admin can use it to re-pair an agent
// whose state file was lost or that was reinstalled. Existing machine_tokens stay valid
// until the agent rotates them on next enroll/auto-register.
func (a *ServersAPI) Repair(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID2(r, "/api/servers/", "/repair")
	if !ok {
		writeError(w, 400, "bad path")
		return
	}
	tok, exp, err := a.Tokens.IssueEnrollmentToken(r.Context(), id)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"enrollment_token": tok,
		"expires_at":       exp,
	})
}

type configReq struct {
	TelemetryIntervalSeconds int `json:"telemetry_interval_seconds"`
}

func (a *ServersAPI) Config(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID2(r, "/api/servers/", "/config")
	if !ok {
		writeError(w, 400, "bad path")
		return
	}
	var in configReq
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	if in.TelemetryIntervalSeconds < 5 || in.TelemetryIntervalSeconds > 3600 {
		writeError(w, 400, "telemetry_interval_seconds must be 5..3600")
		return
	}
	env, err := agentapi.Frame(agentapi.TypeConfigUpdate, agentapi.ConfigUpdate{
		TelemetryIntervalSeconds: in.TelemetryIntervalSeconds,
	})
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if err := a.Hub.Send(id, env); err != nil {
		writeError(w, 409, err.Error()) // 409 — agent offline
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

> Note: `installer` package import will need to be added to `admin_servers.go` if not already present.

- [ ] **Step 3: Test (HTTP-level coverage of install + repair; install runs a fake)**

```go
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/<owner>/shepherd/internal/agentapi"
	"github.com/<owner>/shepherd/internal/agentsvc"
	shepdb "github.com/<owner>/shepherd/internal/db"
	"github.com/<owner>/shepherd/internal/installer"
	"github.com/<owner>/shepherd/internal/serversvc"
	"github.com/<owner>/shepherd/internal/telemetrysvc"
)

type fakeInstaller2 struct{ sink func(string) }

func (f *fakeInstaller2) Run(context.Context, installer.InstallParams) error {
	if f.sink != nil {
		f.sink("ok")
	}
	return nil
}
func (f *fakeInstaller2) SetLogSink(s func(string)) { f.sink = s }

func TestInstall_HappyPath_HTTP(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)

	svc := &serversvc.Service{DB: d}
	tokens := &agentsvc.Service{DB: d}
	mgr := &serversvc.InstallManager{Service: svc, Installer: &fakeInstaller2{}, Tokens: tokens, ServerURL: "http://x"}
	api := &ServersAPI{
		Servers: svc, Tokens: tokens, Hub: agentsvc.NewHub(),
		Query: &telemetrysvc.Query{DB: d}, InstallManager: mgr,
	}
	body, _ := json.Marshal(installReq{
		Name: "h", SSHHost: "h", SSHUser: "root", SSHPassword: "p", Arch: "amd64",
	})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/servers/install", bytes.NewReader(body))
	api.Install(w, r)
	if w.Code != 202 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	// Wait for state machine.
	for i := 0; i < 100; i++ {
		var stage string
		_ = d.Get(&stage, "SELECT install_stage FROM servers ORDER BY id DESC LIMIT 1")
		if stage == "done" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("install did not reach 'done'")
}

func TestConfig_OfflineAgent_Returns409(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	svc := &serversvc.Service{DB: d}
	srv, _ := svc.Create(context.Background(), serversvc.CreateInput{Name: "h"})

	api := &ServersAPI{
		Servers: svc, Tokens: &agentsvc.Service{DB: d}, Hub: agentsvc.NewHub(),
		Query: &telemetrysvc.Query{DB: d},
	}
	body, _ := json.Marshal(configReq{TelemetryIntervalSeconds: 60})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/servers/"+itoa(srv.ID)+"/config", bytes.NewReader(body))
	api.Config(w, r)
	if w.Code != 409 {
		t.Fatalf("status=%d", w.Code)
	}
	_ = agentapi.TypeConfigUpdate
}

func itoa(i int64) string { return jsonNumber(i) }
func jsonNumber(i int64) string {
	b, _ := json.Marshal(i)
	return string(b)
}
```

- [ ] **Step 4: Run + commit**

```
go test ./internal/api -v
git add internal/api
git commit -m "feat(api): /api/servers/install async + /repair + /config (with offline 409)"
```

---

## Milestone 13 — Server entrypoint

### Task 20: `internal/api/router.go` + `cmd/server/main.go`

**Files:**
- Create: `internal/api/router.go`
- Create: `cmd/server/main.go`

- [ ] **Step 1: Write `internal/api/router.go`**

```go
package api

import (
	"net/http"
	"strings"
)

type Router struct {
	Auth     *AuthAPI
	AuthH    *http.Handler // pre-built RequireAdmin wrapper from auth.Handler
	Servers  *ServersAPI
	Settings *SettingsAPI
	Public   *PublicAPI
	Agent    *AgentAPI

	requireAdmin func(http.Handler) http.Handler
}

func NewRouter(authAPI *AuthAPI, requireAdmin func(http.Handler) http.Handler,
	servers *ServersAPI, settings *SettingsAPI, public *PublicAPI, agent *AgentAPI) *Router {
	return &Router{
		Auth: authAPI, Servers: servers, Settings: settings, Public: public, Agent: agent,
		requireAdmin: requireAdmin,
	}
}

func (r *Router) Handler() http.Handler {
	mux := http.NewServeMux()

	// public
	mux.HandleFunc("GET /api/public/servers", r.Public.Servers_ListPublic)
	mux.HandleFunc("GET /api/public/servers/{id}/telemetry", r.Public.Telemetry)
	mux.HandleFunc("GET /api/public/settings", r.Public.Settings)

	// auth
	mux.HandleFunc("POST /api/login", r.Auth.Login)
	mux.HandleFunc("POST /api/logout", r.Auth.Logout)

	// admin (gated by requireAdmin)
	admin := http.NewServeMux()
	admin.HandleFunc("GET /api/admins/me", r.Auth.Me)

	admin.HandleFunc("GET /api/servers", r.Servers.List)
	admin.HandleFunc("POST /api/servers", r.Servers.Create)
	admin.HandleFunc("POST /api/servers/install", r.Servers.Install)
	admin.HandleFunc("GET /api/servers/{id}", r.Servers.Get)
	admin.HandleFunc("PATCH /api/servers/{id}", r.Servers.Patch)
	admin.HandleFunc("DELETE /api/servers/{id}", r.Servers.Delete)
	admin.HandleFunc("GET /api/servers/{id}/telemetry", r.Servers.Telemetry)
	admin.HandleFunc("POST /api/servers/{id}/repair", r.Servers.Repair)
	admin.HandleFunc("POST /api/servers/{id}/config", r.Servers.Config)

	admin.HandleFunc("GET /api/settings", r.Settings.GetAll)
	admin.HandleFunc("PATCH /api/settings", r.Settings.Patch)

	mux.Handle("/api/admins/", r.requireAdmin(admin))
	// All admin routes share the /api/ prefix; route them through the gated admin mux.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, req *http.Request) {
		// Skip /api/public/* and /api/login & /api/logout — already mounted above
		p := req.URL.Path
		if strings.HasPrefix(p, "/api/public/") || p == "/api/login" || p == "/api/logout" {
			http.NotFound(w, req)
			return
		}
		r.requireAdmin(admin).ServeHTTP(w, req)
	})

	// agent
	mux.HandleFunc("POST /agent/enroll", r.Agent.Enroll)
	mux.HandleFunc("POST /agent/auto-register", r.Agent.AutoRegister)
	mux.HandleFunc("GET /agent/ws", r.Agent.WS)

	return mux
}
```

> The dual-mux trick (admin sub-mux behind `requireAdmin`) keeps Go 1.22's pattern matcher happy while still gating only the admin paths. Public + login bypass it.

- [ ] **Step 2: Write `cmd/server/main.go`**

```go
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/<owner>/shepherd/internal/agentapi"
	"github.com/<owner>/shepherd/internal/agentsvc"
	"github.com/<owner>/shepherd/internal/api"
	"github.com/<owner>/shepherd/internal/auth"
	"github.com/<owner>/shepherd/internal/config"
	shepdb "github.com/<owner>/shepherd/internal/db"
	"github.com/<owner>/shepherd/internal/installer"
	"github.com/<owner>/shepherd/internal/serversvc"
	"github.com/<owner>/shepherd/internal/telemetrysvc"
)

func main() {
	cfg, err := config.FromEnv()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	rootCtx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	d, err := shepdb.Open(rootCtx, shepdb.Config{Driver: cfg.DBDriver, DSN: cfg.DBDSN})
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	defer d.Close()
	if err := shepdb.Migrate(d, cfg.DBDriver); err != nil {
		log.Fatalf("db migrate: %v", err)
	}

	authStore := &auth.Store{DB: d}
	authH := &auth.Handler{Store: authStore, Secure: cfg.CookieSecure}

	// Bootstrap initial admin if creds set and no admin exists yet.
	if cfg.InitialAdminUsername != "" && cfg.InitialAdminPassword != "" {
		var n int
		_ = d.Get(&n, "SELECT COUNT(*) FROM admins")
		if n == 0 {
			if _, err := authStore.CreateAdmin(rootCtx, cfg.InitialAdminUsername, cfg.InitialAdminPassword); err != nil {
				log.Fatalf("create initial admin: %v", err)
			}
			log.Printf("created initial admin %q", cfg.InitialAdminUsername)
		}
	}

	serverSvc := &serversvc.Service{DB: d}
	settingsStore := &serversvc.SettingsStore{DB: d}
	agentSvc := &agentsvc.Service{DB: d, AutoRecoverKey: cfg.AutoRecoverKey}
	hub := agentsvc.NewHub()
	tQuery := &telemetrysvc.Query{DB: d}
	tIngest := &telemetrysvc.Ingest{DB: d}

	// Distribution
	var dist installer.Distribution
	switch cfg.AgentDistribution {
	case config.DistributionEmbedded:
		dist = installer.EmbeddedDistribution{}
	case config.DistributionGitHub:
		dist = installer.GitHubDistribution{
			Owner: ownerFromBuild(),
			Repo:  "shepherd",
			Tag:   tagOrFallback(cfg.AgentDownloadTag, cfg.BuildVersion),
		}
	default:
		log.Fatalf("unknown distribution: %q", cfg.AgentDistribution)
	}
	inst := &installer.Installer{Distribution: dist}
	installMgr := &serversvc.InstallManager{
		Service: serverSvc, Installer: inst, Tokens: agentSvc, ServerURL: deriveServerURL(cfg.HTTPAddr),
	}

	// Sweep stuck rows once at boot.
	if err := installMgr.SweepStuck(rootCtx); err != nil {
		log.Printf("sweep stuck: %v", err)
	}

	// Background loops.
	go (&telemetrysvc.Rollup{DB: d}).Run(rootCtx)
	go (&telemetrysvc.Retention{DB: d, Settings: settingsStore}).Run(rootCtx)

	authAPI := &api.AuthAPI{Auth: authH}
	servers := &api.ServersAPI{
		Servers: serverSvc, Settings: settingsStore, Query: tQuery, Hub: hub,
		InstallManager: installMgr, Tokens: agentSvc,
	}
	settings := &api.SettingsAPI{Settings: settingsStore}
	public := &api.PublicAPI{Servers: serverSvc, Settings: settingsStore, Query: tQuery, Hub: hub}
	agentAPI := &api.AgentAPI{Agents: agentSvc, Hub: hub, OnFrame: tIngest.HandleFrame}

	router := api.NewRouter(authAPI, authH.RequireAdmin, servers, settings, public, agentAPI)

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           router.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("listening on %s (driver=%s, distribution=%s, version=%s)",
			cfg.HTTPAddr, cfg.DBDriver, cfg.AgentDistribution, cfg.BuildVersion)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http: %v", err)
		}
	}()

	<-rootCtx.Done()
	shutdownCtx, c := context.WithTimeout(context.Background(), 10*time.Second)
	defer c()
	_ = srv.Shutdown(shutdownCtx)
	_ = agentapi.TypeConfigUpdate
}

// ownerFromBuild reads the import path's owner segment.
// Hardcoded to the value chosen at module init.
func ownerFromBuild() string {
	// Replace once owner is known. To avoid drift, prefer setting
	// AGENT_DOWNLOAD_TAG explicitly in env when running the github distribution.
	return "<owner>"
}

func tagOrFallback(override, build string) string {
	if override != "" {
		return override
	}
	if build == "dev" {
		return "v0.1.0"
	}
	return build
}

// deriveServerURL turns the HTTP listen address into the URL the agent uses to dial back.
// If SERVER_PUBLIC_URL is set in env, prefer that. Otherwise stitch http://localhost:<port>
// for dev (production should always set SERVER_PUBLIC_URL via reverse proxy).
func deriveServerURL(httpAddr string) string {
	if v := os.Getenv("SERVER_PUBLIC_URL"); v != "" {
		return v
	}
	return "http://localhost" + httpAddr
}
```

> **`SERVER_PUBLIC_URL`**: add this to `internal/config/config.go` as another optional field next to `HTTPAddr`. (Engineer: thread it through `Config{}` and `FromEnv`, default empty.)

- [ ] **Step 3: Build & smoke**

```
make tidy
make server
./bin/shepherd-server &
sleep 1
curl -sf http://localhost:8080/api/public/servers
kill %1
```
Expected: `[]` (empty array — no servers yet) and exit cleanly.

- [ ] **Step 4: Commit**

```
git add cmd internal/api internal/config
git commit -m "feat(server): wire router + dependency graph + signal-aware shutdown"
```

---

## Milestone 14 — Agent

### Task 21: agent fingerprint + state file

**Files:**
- Create: `internal/agent/fingerprint/fingerprint.go`
- Create: `internal/agent/state/state.go`
- Create: `internal/agentconfig/config.go`
- Create: `internal/agent/state/state_test.go`

- [ ] **Step 1: Write `internal/agent/fingerprint/fingerprint.go`**

```go
package fingerprint

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"os"
	"strings"
)

// Compute returns a stable fingerprint for this host: sha256(machine-id + first-mac).
// Falls back to hostname-based hash if /etc/machine-id is unavailable.
func Compute() (string, error) {
	var seed string
	if b, err := os.ReadFile("/etc/machine-id"); err == nil {
		seed = strings.TrimSpace(string(b))
	} else if hn, err := os.Hostname(); err == nil {
		seed = "hostname:" + hn
	}
	mac := primaryMAC()
	h := sha256.Sum256([]byte(seed + "|" + mac))
	return hex.EncodeToString(h[:]), nil
}

func primaryMAC() string {
	ifs, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, i := range ifs {
		if i.Flags&net.FlagLoopback != 0 || i.HardwareAddr == nil || len(i.HardwareAddr) == 0 {
			continue
		}
		if i.Flags&net.FlagUp == 0 {
			continue
		}
		return i.HardwareAddr.String()
	}
	return ""
}
```

- [ ] **Step 2: Write `internal/agent/state/state.go`**

```go
package state

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

const DefaultPath = "/etc/shepherd/agent.state.json"

type State struct {
	MachineToken             string `json:"machine_token"`
	Fingerprint              string `json:"fingerprint"`
	TelemetryIntervalSeconds int    `json:"telemetry_interval_seconds"`
}

type Store struct {
	Path string
	mu   sync.Mutex
}

func (s *Store) path() string {
	if s.Path == "" {
		return DefaultPath
	}
	return s.Path
}

func (s *Store) Load() (*State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return &State{}, nil
	}
	if err != nil {
		return nil, err
	}
	var st State
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, err
	}
	return &st, nil
}

func (s *Store) Save(st *State) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(s.path()), 0o750); err != nil {
		return err
	}
	tmp := s.path() + ".tmp"
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path())
}
```

- [ ] **Step 3: Write `internal/agentconfig/config.go`**

```go
package agentconfig

import (
	"errors"
	"os"
	"strings"
)

type Config struct {
	ServerURL       string
	EnrollmentToken string
	AutoRecoverKey  string
	AgentVersion    string
	StatePath       string
}

var BuildVersion = "dev" // overridden at link time

func FromEnv() (Config, error) {
	c := Config{
		ServerURL:       strings.TrimRight(os.Getenv("SERVER_URL"), "/"),
		EnrollmentToken: os.Getenv("ENROLLMENT_TOKEN"),
		AutoRecoverKey:  os.Getenv("AUTO_RECOVER_KEY"),
		AgentVersion:    BuildVersion,
		StatePath:       os.Getenv("STATE_PATH"),
	}
	if c.ServerURL == "" {
		return c, errors.New("SERVER_URL required")
	}
	return c, nil
}

// WSURL converts a server URL into the WebSocket URL for /agent/ws.
func (c Config) WSURL() string {
	switch {
	case strings.HasPrefix(c.ServerURL, "https://"):
		return "wss://" + strings.TrimPrefix(c.ServerURL, "https://") + "/agent/ws"
	case strings.HasPrefix(c.ServerURL, "http://"):
		return "ws://" + strings.TrimPrefix(c.ServerURL, "http://") + "/agent/ws"
	}
	return "ws://" + c.ServerURL + "/agent/ws"
}
```

- [ ] **Step 4: Test**

```go
// internal/agent/state/state_test.go
package state

import (
	"path/filepath"
	"testing"
)

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	st := &Store{Path: filepath.Join(dir, "s.json")}
	in := &State{MachineToken: "tok", Fingerprint: "fp", TelemetryIntervalSeconds: 30}
	if err := st.Save(in); err != nil {
		t.Fatal(err)
	}
	out, err := st.Load()
	if err != nil {
		t.Fatal(err)
	}
	if out.MachineToken != "tok" || out.TelemetryIntervalSeconds != 30 {
		t.Fatalf("got %+v", out)
	}
}

func TestLoadMissingFileReturnsEmpty(t *testing.T) {
	st := &Store{Path: filepath.Join(t.TempDir(), "absent.json")}
	out, err := st.Load()
	if err != nil {
		t.Fatal(err)
	}
	if out.MachineToken != "" {
		t.Errorf("expected empty state")
	}
}
```

```
go test ./internal/agent/state ./internal/agent/fingerprint ./internal/agentconfig -v
git add internal/agent internal/agentconfig
git commit -m "feat(agent): fingerprint compute + state file persistence + env config"
```

---

### Task 22: agent collector (gopsutil-based)

**Files:**
- Create: `internal/agent/collector/collector.go`
- Create: `internal/agent/collector/disks.go`
- Create: `internal/agent/collector/net.go`
- Create: `internal/agent/collector/collector_test.go`

- [ ] **Step 1: Add gopsutil**

```
go get github.com/shirou/gopsutil/v3/cpu github.com/shirou/gopsutil/v3/mem github.com/shirou/gopsutil/v3/disk github.com/shirou/gopsutil/v3/net github.com/shirou/gopsutil/v3/load
```

- [ ] **Step 2: Write `internal/agent/collector/disks.go`**

```go
package collector

import (
	"strings"

	"github.com/shirou/gopsutil/v3/disk"
	"github.com/<owner>/shepherd/internal/agentapi"
)

var skipFS = map[string]struct{}{
	"tmpfs": {}, "devtmpfs": {}, "squashfs": {}, "overlay": {}, "proc": {}, "sysfs": {}, "cgroup": {}, "cgroup2": {},
	"autofs": {}, "ramfs": {}, "devpts": {}, "mqueue": {}, "fusectl": {},
}

func Disks() ([]agentapi.Disk, error) {
	parts, err := disk.Partitions(false)
	if err != nil {
		return nil, err
	}
	out := []agentapi.Disk{}
	for _, p := range parts {
		if _, skip := skipFS[strings.ToLower(p.Fstype)]; skip {
			continue
		}
		u, err := disk.Usage(p.Mountpoint)
		if err != nil {
			continue
		}
		out = append(out, agentapi.Disk{Mount: p.Mountpoint, Used: int64(u.Used), Total: int64(u.Total)})
	}
	return out, nil
}
```

- [ ] **Step 3: Write `internal/agent/collector/net.go`**

```go
package collector

import (
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/net"
)

type NetMeter struct {
	mu      sync.Mutex
	prevRx  uint64
	prevTx  uint64
	prevTS  time.Time
	primed  bool
}

// Sample returns the rx/tx bytes-per-second since the last call, summed across all
// non-loopback interfaces. The first call primes counters and returns (0,0,false).
func (m *NetMeter) Sample() (rxBps, txBps int64, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	stats, err := net.IOCounters(true)
	if err != nil {
		return 0, 0, false
	}
	var rx, tx uint64
	for _, s := range stats {
		if s.Name == "lo" {
			continue
		}
		rx += s.BytesRecv
		tx += s.BytesSent
	}
	now := time.Now()
	if !m.primed {
		m.prevRx, m.prevTx, m.prevTS, m.primed = rx, tx, now, true
		return 0, 0, false
	}
	dt := now.Sub(m.prevTS).Seconds()
	if dt <= 0 {
		return 0, 0, false
	}
	rxBps = int64(float64(rx-m.prevRx) / dt)
	txBps = int64(float64(tx-m.prevTx) / dt)
	m.prevRx, m.prevTx, m.prevTS = rx, tx, now
	return rxBps, txBps, true
}
```

- [ ] **Step 4: Write `internal/agent/collector/collector.go`**

```go
package collector

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
	gnet "github.com/shirou/gopsutil/v3/net"
	"github.com/<owner>/shepherd/internal/agentapi"
)

type Sender interface {
	Send(env agentapi.Envelope) error
}

type Collector struct {
	Sender    Sender
	IntervalS atomic.Int32 // seconds, set via SetInterval; default 30 if zero
	netMeter  NetMeter
	mu        sync.Mutex
}

// SetInterval is called when a config.update arrives.
func (c *Collector) SetInterval(s int) {
	if s < 5 {
		s = 5
	}
	c.IntervalS.Store(int32(s))
}

func (c *Collector) Run(ctx context.Context) {
	if c.IntervalS.Load() == 0 {
		c.IntervalS.Store(30)
	}
	for {
		interval := time.Duration(c.IntervalS.Load()) * time.Second
		t := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
			c.tick(ctx)
		}
	}
}

func (c *Collector) tick(ctx context.Context) {
	t, ok := c.sample()
	if !ok {
		return
	}
	env, err := agentapi.Frame(agentapi.TypeTelemetry, t)
	if err != nil {
		return
	}
	_ = c.Sender.Send(env)
}

func (c *Collector) sample() (agentapi.Telemetry, bool) {
	cpuPcts, err := cpu.Percent(0, false) // average since last call
	if err != nil || len(cpuPcts) == 0 {
		return agentapi.Telemetry{}, false
	}
	v, err := mem.VirtualMemory()
	if err != nil {
		return agentapi.Telemetry{}, false
	}
	la, _ := load.Avg()
	disks, _ := Disks()
	rx, tx, netOK := c.netMeter.Sample()
	if !netOK {
		// First call: skip — net delta is required by spec
		return agentapi.Telemetry{}, false
	}
	tcpConn := countEstablished()

	t := agentapi.Telemetry{
		TS:       time.Now().UTC(),
		CPUPct:   cpuPcts[0],
		MemUsed:  int64(v.Used),
		MemTotal: int64(v.Total),
		Load1:    la.Load1,
		Load5:    la.Load5,
		Load15:   la.Load15,
		NetRxBps: rx,
		NetTxBps: tx,
		TCPConn:  tcpConn,
		Disks:    disks,
	}
	return t, true
}

func countEstablished() int {
	conns, err := gnet.Connections("tcp")
	if err != nil {
		return 0
	}
	n := 0
	for _, c := range conns {
		if c.Status == "ESTABLISHED" {
			n++
		}
	}
	return n
}
```

- [ ] **Step 5: Test (build-only sanity since gopsutil hits the host kernel)**

```go
// internal/agent/collector/collector_test.go
package collector

import "testing"

func TestNetMeter_FirstCallNotPrimed(t *testing.T) {
	var m NetMeter
	_, _, ok := m.Sample()
	if ok {
		t.Error("first call should return ok=false")
	}
}

func TestSetIntervalFloor(t *testing.T) {
	var c Collector
	c.SetInterval(2)
	if c.IntervalS.Load() != 5 {
		t.Errorf("got %d", c.IntervalS.Load())
	}
}
```

- [ ] **Step 6: Run + commit**

```
go test ./internal/agent/collector -v
git add go.mod go.sum internal/agent/collector
git commit -m "feat(agent): gopsutil collector with net rx/tx delta + disk filter + tcp count"
```

---

### Task 23: agent wsclient + `cmd/agent`

**Files:**
- Create: `internal/agent/wsclient/client.go`
- Create: `internal/agent/wsclient/client_test.go`
- Create: `cmd/agent/main.go`

- [ ] **Step 1: Write `internal/agent/wsclient/client.go`**

```go
package wsclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/<owner>/shepherd/internal/agent/state"
	"github.com/<owner>/shepherd/internal/agentapi"
	"github.com/<owner>/shepherd/internal/agentconfig"
)

var ErrPermanent = errors.New("permanent agent failure")

type Client struct {
	Cfg          agentconfig.Config
	State        *state.Store
	HTTPClient   *http.Client
	OnConfig     func(int) // called when server pushes config.update; agent updates collector interval
	Hostname     string

	mu      sync.Mutex
	conn    *websocket.Conn
}

func New(cfg agentconfig.Config, st *state.Store, onCfg func(int), hostname string) *Client {
	return &Client{
		Cfg: cfg, State: st,
		HTTPClient: &http.Client{Timeout: 30 * time.Second},
		OnConfig:   onCfg,
		Hostname:   hostname,
	}
}

// Run drives the agent lifecycle until ctx is canceled.
// Loop: ensure machine_token (enroll/auto-register if missing) -> dial WS -> read frames.
// Permanent errors abort with ErrPermanent (caller should exit non-zero).
func (c *Client) Run(ctx context.Context) error {
	backoff := time.Second
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		st, _ := c.State.Load()
		if st.MachineToken == "" {
			if err := c.acquireToken(ctx, st); err != nil {
				if errors.Is(err, ErrPermanent) {
					return err
				}
				log.Printf("token acquire: %v; retrying in %s", err, backoff)
				if !sleep(ctx, backoff) {
					return ctx.Err()
				}
				backoff = nextBackoff(backoff)
				continue
			}
		}
		err := c.dialAndRun(ctx)
		if errors.Is(err, ErrPermanent) {
			return err
		}
		log.Printf("ws session ended: %v; reconnecting in %s", err, backoff)
		if !sleep(ctx, backoff) {
			return ctx.Err()
		}
		backoff = nextBackoff(backoff)
	}
}

func (c *Client) acquireToken(ctx context.Context, st *state.State) error {
	if st.Fingerprint == "" {
		// Caller must populate Fingerprint before invoking Run; main does this.
		return errors.New("fingerprint missing")
	}
	switch {
	case c.Cfg.AutoRecoverKey != "":
		req := agentapi.AutoRegisterRequest{
			AutoRecoverKey: c.Cfg.AutoRecoverKey, Fingerprint: st.Fingerprint,
			Hostname: c.Hostname, OS: runtime.GOOS, Arch: runtime.GOARCH,
			Kernel: kernelVersion(), AgentVersion: c.Cfg.AgentVersion,
		}
		var resp agentapi.EnrollResponse
		if err := c.postJSON(ctx, "/agent/auto-register", req, &resp); err != nil {
			return err
		}
		st.MachineToken = resp.MachineToken
	case c.Cfg.EnrollmentToken != "":
		req := agentapi.EnrollRequest{
			EnrollmentToken: c.Cfg.EnrollmentToken, Fingerprint: st.Fingerprint,
			OS: runtime.GOOS, Arch: runtime.GOARCH, Kernel: kernelVersion(), AgentVersion: c.Cfg.AgentVersion,
		}
		var resp agentapi.EnrollResponse
		if err := c.postJSON(ctx, "/agent/enroll", req, &resp); err != nil {
			return err
		}
		st.MachineToken = resp.MachineToken
		c.Cfg.EnrollmentToken = "" // one-shot — drop after first use
	default:
		return errors.New("no ENROLLMENT_TOKEN nor AUTO_RECOVER_KEY")
	}
	if st.TelemetryIntervalSeconds == 0 {
		st.TelemetryIntervalSeconds = 30
	}
	return c.State.Save(st)
}

func (c *Client) postJSON(ctx context.Context, path string, body, out any) error {
	url := c.Cfg.ServerURL + path
	b, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return ErrPermanent
	}
	if resp.StatusCode/100 != 2 {
		return errors.New("non-2xx: " + string(data))
	}
	return json.Unmarshal(data, out)
}

func (c *Client) dialAndRun(ctx context.Context) error {
	st, _ := c.State.Load()
	if st.MachineToken == "" {
		return errors.New("no machine token")
	}

	wsURL := c.Cfg.WSURL()
	hdr := http.Header{}
	hdr.Set("Authorization", "Bearer "+st.MachineToken)

	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 30 * time.Second
	conn, resp, err := dialer.DialContext(ctx, wsURL, hdr)
	if err != nil {
		if resp != nil && (resp.StatusCode == 401 || resp.StatusCode == 403) {
			// machine token invalid — try fresh acquisition next loop iteration
			// (but only if AutoRecoverKey is set, since EnrollmentToken is one-shot and gone).
			if c.Cfg.AutoRecoverKey != "" {
				_ = c.State.Save(&state.State{Fingerprint: st.Fingerprint, TelemetryIntervalSeconds: st.TelemetryIntervalSeconds})
				return errors.New("token rejected; will re-register")
			}
			return ErrPermanent
		}
		return err
	}

	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.conn = nil
		c.mu.Unlock()
		_ = conn.Close()
	}()

	// Send heartbeat once on connect; subsequent heartbeats in goroutine.
	hb, _ := agentapi.Frame(agentapi.TypeHeartbeat, agentapi.Heartbeat{
		TS: time.Now().UTC(), AgentVersion: c.Cfg.AgentVersion,
		OS: runtime.GOOS, Arch: runtime.GOARCH, Kernel: kernelVersion(),
	})
	if err := c.writeJSON(hb); err != nil {
		return err
	}

	stop := make(chan struct{})
	defer close(stop)
	go c.heartbeatLoop(stop)

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		var env agentapi.Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		switch env.Type {
		case agentapi.TypePing:
			pong, _ := agentapi.Frame(agentapi.TypePong, struct{}{})
			_ = c.writeJSON(pong)
		case agentapi.TypeConfigUpdate:
			var u agentapi.ConfigUpdate
			if err := env.Decode(&u); err != nil {
				continue
			}
			if c.OnConfig != nil {
				c.OnConfig(u.TelemetryIntervalSeconds)
			}
			if u.TelemetryIntervalSeconds > 0 {
				st, _ := c.State.Load()
				st.TelemetryIntervalSeconds = u.TelemetryIntervalSeconds
				_ = c.State.Save(st)
			}
		}
	}
}

// Sender — exposed so the collector can push telemetry frames over the active conn.
func (c *Client) Send(env agentapi.Envelope) error {
	return c.writeJSON(env)
}

func (c *Client) writeJSON(env agentapi.Envelope) error {
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn == nil {
		return errors.New("not connected")
	}
	conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return conn.WriteJSON(env)
}

func (c *Client) heartbeatLoop(stop <-chan struct{}) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			env, _ := agentapi.Frame(agentapi.TypeHeartbeat, agentapi.Heartbeat{
				TS: time.Now().UTC(), AgentVersion: c.Cfg.AgentVersion,
				OS: runtime.GOOS, Arch: runtime.GOARCH, Kernel: kernelVersion(),
			})
			_ = c.writeJSON(env)
		}
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func nextBackoff(d time.Duration) time.Duration {
	d *= 2
	if d > time.Minute {
		return time.Minute
	}
	return d
}

func kernelVersion() string {
	// Linux: read /proc/sys/kernel/osrelease; cheap, no extra dep.
	b, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
```

> Add `import "os"` at the top of the file (omitted above for brevity).

- [ ] **Step 2: Test — exercise the auto-register HTTP path against a stub server**

```go
// internal/agent/wsclient/client_test.go
package wsclient

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/<owner>/shepherd/internal/agent/state"
	"github.com/<owner>/shepherd/internal/agentapi"
	"github.com/<owner>/shepherd/internal/agentconfig"
)

func TestAcquireToken_AutoRegisterFlow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/auto-register" {
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var req agentapi.AutoRegisterRequest
		_ = json.Unmarshal(body, &req)
		if req.AutoRecoverKey != "k" || req.Fingerprint != "fp" {
			http.Error(w, "bad", 400)
			return
		}
		_ = json.NewEncoder(w).Encode(agentapi.EnrollResponse{MachineToken: "tok", ServerID: 7})
	}))
	defer srv.Close()

	statePath := filepath.Join(t.TempDir(), "s.json")
	st := &state.Store{Path: statePath}
	_ = st.Save(&state.State{Fingerprint: "fp"})
	c := New(agentconfig.Config{ServerURL: srv.URL, AutoRecoverKey: "k", AgentVersion: "v0"}, st, nil, "h")

	cur, _ := st.Load()
	if err := c.acquireToken(context.Background(), cur); err != nil {
		t.Fatal(err)
	}
	got, _ := st.Load()
	if got.MachineToken != "tok" {
		t.Fatalf("token=%q", got.MachineToken)
	}
}

func TestPostJSON_PermanentOn401(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no", 401)
	}))
	defer srv.Close()
	c := New(agentconfig.Config{ServerURL: srv.URL}, &state.Store{Path: filepath.Join(t.TempDir(), "s.json")}, nil, "h")
	var out struct{}
	if err := c.postJSON(context.Background(), "/agent/enroll", bytes.NewReader(nil), &out); err == nil || err != ErrPermanent {
		t.Fatalf("err=%v want ErrPermanent", err)
	}
}
```

- [ ] **Step 3: Write `cmd/agent/main.go`**

```go
package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/<owner>/shepherd/internal/agent/collector"
	"github.com/<owner>/shepherd/internal/agent/fingerprint"
	"github.com/<owner>/shepherd/internal/agent/state"
	"github.com/<owner>/shepherd/internal/agent/wsclient"
	"github.com/<owner>/shepherd/internal/agentconfig"
)

func main() {
	cfg, err := agentconfig.FromEnv()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	statePath := state.DefaultPath
	if cfg.StatePath != "" {
		statePath = cfg.StatePath
	}
	st := &state.Store{Path: statePath}

	loaded, err := st.Load()
	if err != nil {
		log.Fatalf("state load: %v", err)
	}
	if loaded.Fingerprint == "" {
		fp, err := fingerprint.Compute()
		if err != nil {
			log.Fatalf("fingerprint: %v", err)
		}
		loaded.Fingerprint = fp
		_ = st.Save(loaded)
	}

	hostname, _ := os.Hostname()

	col := &collector.Collector{}
	if loaded.TelemetryIntervalSeconds > 0 {
		col.SetInterval(loaded.TelemetryIntervalSeconds)
	} else {
		col.SetInterval(30)
	}

	client := wsclient.New(cfg, st, func(s int) { col.SetInterval(s) }, hostname)
	col.Sender = client

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	go col.Run(ctx)
	if err := client.Run(ctx); err != nil {
		if errors.Is(err, wsclient.ErrPermanent) {
			log.Printf("permanent agent failure: %v", err)
			os.Exit(1)
		}
		log.Printf("agent stopped: %v", err)
	}
}
```

- [ ] **Step 4: Run + commit**

```
go test ./internal/agent/wsclient -v
go build -o bin/shepherd-agent ./cmd/agent
git add cmd/agent internal/agent/wsclient
git commit -m "feat(agent): wsclient with enroll/auto-register, reconnect backoff, config.update handling"
```

---

## Milestone 15 — End-to-end smoke

### Task 24: Run the full local pipeline by hand

This task is **manual** — it validates the assembled system on the developer box. No code changes. If anything is broken, reopen the relevant earlier task and fix.

- [ ] **Step 1: Build both binaries**

```
make agent
mkdir -p internal/installer/bin
cp bin/shepherd-agent internal/installer/bin/shepherd-agent-linux-amd64  # Linux dev box
# (on macOS): set GOOS=linux GOARCH=amd64; the resulting binary won't run locally
# but is enough for the embedded distribution `Provide()` call to succeed.
make server
```

- [ ] **Step 2: Boot the server with an initial admin**

```
INITIAL_ADMIN_USERNAME=alice INITIAL_ADMIN_PASSWORD=hunter2 \
  AUTO_RECOVER_KEY=secret \
  ./bin/shepherd-server &
sleep 1
```

- [ ] **Step 3: Log in**

```
curl -sf -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"hunter2"}' http://localhost:8080/api/login
# expect: {"id":1,"username":"alice"}
```

- [ ] **Step 4: Self-register an agent**

Run the agent against the same machine:

```
SERVER_URL=http://localhost:8080 \
  AUTO_RECOVER_KEY=secret \
  STATE_PATH=$(mktemp -d)/state.json \
  ./bin/shepherd-agent &
```

After ~30s:

```
curl -sf -b cookies.txt http://localhost:8080/api/servers
# expect: a row with agent_last_seen recent and agent_fingerprint populated
```

- [ ] **Step 5: Read telemetry**

```
SID=$(curl -sf -b cookies.txt http://localhost:8080/api/servers | jq '.[0].id')
curl -sf -b cookies.txt "http://localhost:8080/api/servers/$SID/telemetry?range=1h" | jq 'length'
# expect: >= 1
```

- [ ] **Step 6: Push a config update**

```
curl -sf -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"telemetry_interval_seconds":10}' \
  http://localhost:8080/api/servers/$SID/config -i
# expect: 204
```

Wait ~30s, hit telemetry again — point density should increase.

- [ ] **Step 7: Make the server public**

```
curl -sf -b cookies.txt -X PATCH -H 'Content-Type: application/json' \
  -d '{"public_alias":"DEV-1","show_on_public":true,"country_code":"US"}' \
  http://localhost:8080/api/servers/$SID
curl -sf http://localhost:8080/api/public/servers | jq
# expect: array of 1 with alias=DEV-1, no IP/hostname leaked
```

- [ ] **Step 8: Tear down**

```
pkill shepherd-agent
pkill shepherd-server
# verify: 90s after killing the agent, GET /api/public/servers shows online=false
```

- [ ] **Step 9: Commit a smoke-script artefact** (optional but recommended) — write the above as `scripts/smoke.sh` for repeatability.

```bash
#!/usr/bin/env bash
# scripts/smoke.sh — Phase 1.A end-to-end check
set -euo pipefail
# … paste the above, with `set -e` and an explicit exit code
```

```
chmod +x scripts/smoke.sh
git add scripts/smoke.sh
git commit -m "test: phase 1.A end-to-end smoke script"
```

---

## Done — what's testable now

After Task 24 you have a backend that:

- accepts admin login
- creates server rows + installs agents over SSH (form's still curl-only — UI is Plan 1.B)
- ingests heartbeats/telemetry from agents over a single WS
- aggregates 30s samples into 5m/1h rollups, prunes by retention
- serves desensitized public cards and admin telemetry windows
- pushes config updates back to online agents
- restarts/reconnects agents cleanly with exponential backoff

Next: **Plan 1.B** wires up the React SPA on top of these endpoints.
