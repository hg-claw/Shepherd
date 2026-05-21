# sing-box Plugin (Phase 3d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a parallel sing-box plugin to Shepherd with the same architectural shape as the xray plugin (multi-inbound + relay/landing topology + traffic monitoring), plus ACME cert auto-issuance for TLS-using protocols.

**Architecture:** New `internal/plugins/singbox/` package mirrors `internal/plugins/xray/` (own InboundStore DAO, own RenderServerConfig, own /inbounds CRUD, own traffic tables). New `internal/singbox/certmgr/` package wraps go-acme/lego for issuance + renewal of TLS certs stored in DB and pushed to hosts. Frontend mirrors `web/src/pages/admin/plugins/xray/` with adjustments for the 18-protocol catalog and an additional CertificatesTab.

**Tech Stack:** Go 1.25 / sqlx / SQLite / github.com/go-acme/lego/v4 / React 19 + TS + Tailwind + shadcn/ui + react-query + recharts. Reference spec: `docs/superpowers/specs/2026-05-20-singbox-plugin-design.md`.

---

## File Map

**Create:**
- `internal/plugins/singbox/meta.go` — `meta()` returning ID="singbox"
- `internal/plugins/singbox/singbox.go` — `Plugin` struct, `init()` registration, lifecycle methods
- `internal/plugins/singbox/migrations.go` — embed FS + `loadMigrations()` + `Migrations()`
- `internal/plugins/singbox/migrations/.gitkeep`
- `internal/plugins/singbox/migrations/0001_singbox_inbounds.up.sql`
- `internal/plugins/singbox/migrations/0001_singbox_inbounds.down.sql`
- `internal/plugins/singbox/migrations/0002_singbox_binaries.up.sql`
- `internal/plugins/singbox/migrations/0002_singbox_binaries.down.sql`
- `internal/plugins/singbox/migrations/0003_singbox_traffic.up.sql`
- `internal/plugins/singbox/migrations/0003_singbox_traffic.down.sql`
- `internal/plugins/singbox/migrations/0004_singbox_certificates.up.sql`
- `internal/plugins/singbox/migrations/0004_singbox_certificates.down.sql`
- `internal/plugins/singbox/inbounds.go` — `Inbound`, `InboundView`, `InboundPatch`, `InboundStore`
- `internal/plugins/singbox/inbounds_test.go`
- `internal/plugins/singbox/release.go` — `Releaser`, `Binary`, `singboxOS/Arch`
- `internal/plugins/singbox/release_test.go`
- `internal/plugins/singbox/certs.go` — `CertStore` DAO
- `internal/plugins/singbox/certs_test.go`
- `internal/plugins/singbox/render.go` — `InboundView`, `CertView`, `RenderServerConfig`, `CertFilePath`
- `internal/plugins/singbox/render_test.go`
- `internal/plugins/singbox/deploy_server.go` — `AssembleAndDeploy`
- `internal/plugins/singbox/deploy_server_test.go`
- `internal/plugins/singbox/inbounds_routes.go` — POST/GET/PATCH/DELETE /inbounds handlers
- `internal/plugins/singbox/inbounds_routes_test.go`
- `internal/plugins/singbox/routes.go` — `RegisterRoutes`
- `internal/plugins/singbox/unit.linux.service`
- `internal/plugins/singbox/unit.darwin.plist`
- `internal/singbox/certmgr/certmgr.go`
- `internal/singbox/certmgr/certmgr_test.go`
- `web/src/pages/admin/plugins/singbox/` — (frontend tasks, covered in Part B)

**Modify:**
- `cmd/server/main.go` — blank import `internal/plugins/singbox` to trigger `init()`
- `go.mod` / `go.sum` — add `github.com/go-acme/lego/v4` (Task 7)

---

## Task 1: Plugin skeleton + meta + init() registration

**Files:**
- Create: `internal/plugins/singbox/meta.go`
- Create: `internal/plugins/singbox/singbox.go`
- Create: `internal/plugins/singbox/migrations.go`
- Create: `internal/plugins/singbox/migrations/.gitkeep`
- Modify: `cmd/server/main.go` (blank import)

- [ ] **Step 1: Write the failing test**

`internal/plugins/singbox/singbox_test.go`:

```go
package singbox_test

import (
	"testing"

	"github.com/hg-claw/Shepherd/internal/plugins"
	_ "github.com/hg-claw/Shepherd/internal/plugins/singbox"
)

func TestSingboxRegistered(t *testing.T) {
	all := plugins.All()
	for _, p := range all {
		if p.Meta().ID == "singbox" {
			return
		}
	}
	t.Fatalf("singbox not found in plugins.All(); registered: %v", func() []string {
		ids := make([]string, len(all))
		for i, p := range all { ids[i] = p.Meta().ID }
		return ids
	}())
}
```

- [ ] **Step 2: Run test, expect FAIL**

```
go test -run TestSingboxRegistered ./internal/plugins/singbox/...
```

Expected: FAIL — package does not exist yet.

- [ ] **Step 3: Implement skeleton**

`internal/plugins/singbox/meta.go`:

```go
package singbox

import "github.com/hg-claw/Shepherd/internal/plugins"

func meta() plugins.Meta {
	return plugins.Meta{
		ID:          "singbox",
		Name:        "sing-box",
		Description: "Manage sing-box as a proxy on selected hosts (18-protocol catalog + ACME certs).",
		Icon:        "box",
		Category:    "proxy",
		HostAware:   true,
	}
}
```

`internal/plugins/singbox/migrations.go`:

```go
package singbox

import (
	"embed"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

//go:embed migrations/*.sql
var migFS embed.FS

// Migrations returns the ordered list of singbox plugin migrations.
func Migrations() []plugins.Migration { return loadMigrations() }

func loadMigrations() []plugins.Migration {
	names := []string{
		"0001_singbox_inbounds.up.sql",
		"0002_singbox_binaries.up.sql",
		"0003_singbox_traffic.up.sql",
		"0004_singbox_certificates.up.sql",
	}
	out := make([]plugins.Migration, 0, len(names))
	for _, n := range names {
		b, err := migFS.ReadFile("migrations/" + n)
		if err != nil {
			panic("singbox: missing migration " + n + ": " + err.Error())
		}
		out = append(out, plugins.Migration{Name: n[:len(n)-len(".up.sql")], SQL: string(b)})
	}
	return out
}
```

`internal/plugins/singbox/singbox.go`:

```go
package singbox

import (
	"context"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

// Plugin implements plugins.Plugin for sing-box.
type Plugin struct{}

func New() *Plugin { return &Plugin{} }

func init() {
	plugins.Register(New())
}

func (p *Plugin) Meta() plugins.Meta              { return meta() }
func (p *Plugin) Migrations() []plugins.Migration { return loadMigrations() }
func (p *Plugin) OnEnable(_ context.Context, _ plugins.Deps) error  { return nil }
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }
func (p *Plugin) RegisterRoutes(_ plugins.Mux, _ plugins.Deps)      {}
```

Create `internal/plugins/singbox/migrations/.gitkeep` (empty file — the embed glob requires at least one file before SQL files exist).

Wire blank import in `cmd/server/main.go` alongside the xray import:

```go
_ "github.com/hg-claw/Shepherd/internal/plugins/singbox"
```

- [ ] **Step 4: Run test, expect PASS**

```
go test -run TestSingboxRegistered ./internal/plugins/singbox/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/singbox/ cmd/server/main.go
git commit -m "feat(plugins/singbox): plugin skeleton + meta + init() registration"
```

---

## Task 2: Migration 0001_singbox_inbounds + constraint test

**Files:**
- Create: `internal/plugins/singbox/migrations/0001_singbox_inbounds.up.sql`
- Create: `internal/plugins/singbox/migrations/0001_singbox_inbounds.down.sql`
- Create: `internal/plugins/singbox/migration_0001_test.go`

- [ ] **Step 1: Write the failing test**

`internal/plugins/singbox/migration_0001_test.go`:

```go
package singbox

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func newTestDB(t *testing.T) *shepdb.DB {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "sb.db") + "?_fk=1"
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

func seedServers(t *testing.T, d *shepdb.DB, ids ...int64) {
	t.Helper()
	for _, id := range ids {
		d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?)`,
			id, "s"+fmt.Sprint(id), "1.2.3."+fmt.Sprint(id), "root", 22, time.Now(), time.Now())
	}
}

func TestMigration0001_SingboxInbounds(t *testing.T) {
	d := newTestDB(t)
	if err := plugins.RunPluginMigrations(context.Background(), d, "singbox",
		[]plugins.Migration{loadMigrations()[0]}); err != nil {
		t.Fatal(err)
	}
	seedServers(t, d, 1, 2)

	// Table exists
	var n int
	if err := d.Get(&n,
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='singbox_inbounds'"); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatal("singbox_inbounds table not created")
	}

	// INSERT valid landing
	d.MustExec(`INSERT INTO singbox_inbounds
		(server_id,tag,port,role,protocol,updated_at)
		VALUES (1,'landing-aabb1122',443,'landing','vless-reality',?)`, time.Now())
	var landingID int64
	_ = d.Get(&landingID, `SELECT id FROM singbox_inbounds WHERE tag='landing-aabb1122'`)

	// CHECK: landing with non-NULL upstream_inbound_id must fail
	_, err := d.Exec(`INSERT INTO singbox_inbounds
		(server_id,tag,port,role,protocol,upstream_inbound_id,updated_at)
		VALUES (1,'landing-bad',444,'landing','vless-reality',?,?)`, landingID, time.Now())
	if err == nil {
		t.Fatal("expected CHECK violation: landing cannot have upstream_inbound_id")
	}

	// CHECK: relay with NULL upstream_inbound_id must fail
	_, err = d.Exec(`INSERT INTO singbox_inbounds
		(server_id,tag,port,role,protocol,upstream_inbound_id,updated_at)
		VALUES (1,'relay-bad',445,'relay','vless-reality',NULL,?)`, time.Now())
	if err == nil {
		t.Fatal("expected CHECK violation: relay must have upstream_inbound_id")
	}

	// Valid relay
	d.MustExec(`INSERT INTO singbox_inbounds
		(server_id,tag,port,role,protocol,upstream_inbound_id,updated_at)
		VALUES (2,'relay-ccdd3344',8443,'relay','hysteria2',?,?)`, landingID, time.Now())

	// RESTRICT: deleting landing while relay depends on it must fail
	_, err = d.Exec(`DELETE FROM singbox_inbounds WHERE id=?`, landingID)
	if err == nil {
		t.Fatal("expected RESTRICT: cannot delete landing with dependent relay")
	}

	// UNIQUE(server_id, port)
	_, err = d.Exec(`INSERT INTO singbox_inbounds
		(server_id,tag,port,role,protocol,updated_at)
		VALUES (1,'landing-dup',443,'landing','vmess-tcp',?)`, time.Now())
	if err == nil {
		t.Fatal("expected UNIQUE(server_id,port) violation")
	}

	// UNIQUE(server_id, tag)
	_, err = d.Exec(`INSERT INTO singbox_inbounds
		(server_id,tag,port,role,protocol,updated_at)
		VALUES (1,'landing-aabb1122',9443,'landing','vmess-tcp',?)`, time.Now())
	if err == nil {
		t.Fatal("expected UNIQUE(server_id,tag) violation")
	}
}
```

Note: add `"fmt"` to imports.

- [ ] **Step 2: Run test, expect FAIL**

```
go test -run TestMigration0001_SingboxInbounds ./internal/plugins/singbox/...
```

Expected: FAIL — migration SQL file not present yet.

- [ ] **Step 3: Create the up migration**

`internal/plugins/singbox/migrations/0001_singbox_inbounds.up.sql`:

```sql
CREATE TABLE IF NOT EXISTS singbox_inbounds (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id                 INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag                       TEXT    NOT NULL,
  port                      INTEGER NOT NULL,
  role                      TEXT    NOT NULL CHECK (role IN ('landing', 'relay')),
  protocol                  TEXT    NOT NULL,

  uuid                      TEXT,
  flow                      TEXT,
  password                  TEXT,
  sni                       TEXT,
  cert_id                   INTEGER REFERENCES singbox_certificates(id) ON DELETE RESTRICT,

  reality_private_key       TEXT,
  reality_public_key        TEXT,
  reality_short_id          TEXT,
  reality_handshake_server  TEXT,
  reality_handshake_port    INTEGER,

  transport_path            TEXT,
  transport_host            TEXT,
  alter_id                  INTEGER DEFAULT 0,
  ss_method                 TEXT,

  upstream_inbound_id       INTEGER REFERENCES singbox_inbounds(id) ON DELETE RESTRICT,
  extra_json                TEXT,

  created_at                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CHECK (
    (role = 'landing' AND upstream_inbound_id IS NULL) OR
    (role = 'relay'   AND upstream_inbound_id IS NOT NULL)
  ),
  UNIQUE (server_id, tag),
  UNIQUE (server_id, port)
);

CREATE INDEX IF NOT EXISTS singbox_inbounds_server
    ON singbox_inbounds(server_id);
CREATE INDEX IF NOT EXISTS singbox_inbounds_upstream
    ON singbox_inbounds(upstream_inbound_id);
CREATE INDEX IF NOT EXISTS singbox_inbounds_cert
    ON singbox_inbounds(cert_id);
```

`internal/plugins/singbox/migrations/0001_singbox_inbounds.down.sql`:

```sql
DROP INDEX IF EXISTS singbox_inbounds_cert;
DROP INDEX IF EXISTS singbox_inbounds_upstream;
DROP INDEX IF EXISTS singbox_inbounds_server;
DROP TABLE IF EXISTS singbox_inbounds;
```

- [ ] **Step 4: Run test, expect PASS**

```
go test -run TestMigration0001_SingboxInbounds ./internal/plugins/singbox/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/singbox/migrations/0001_singbox_inbounds.up.sql \
        internal/plugins/singbox/migrations/0001_singbox_inbounds.down.sql \
        internal/plugins/singbox/migration_0001_test.go
git commit -m "feat(plugins/singbox): 0001 migration creates singbox_inbounds with CHECK/UNIQUE/RESTRICT"
```

---

## Task 3: InboundStore DAO

**Files:**
- Create: `internal/plugins/singbox/inbounds.go`
- Create: `internal/plugins/singbox/inbounds_test.go`

- [ ] **Step 1: Write failing tests**

`internal/plugins/singbox/inbounds_test.go`:

```go
package singbox

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func newInboundStore(t *testing.T) *InboundStore {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "ib.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	// Only run 0001 so cert_id FK is absent (singbox_certificates created by 0004)
	if err := plugins.RunPluginMigrations(context.Background(), d, "singbox",
		[]plugins.Migration{loadMigrations()[0]}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{1, 2, 3} {
		d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?)`,
			id, fmt.Sprintf("s%d", id), fmt.Sprintf("1.2.3.%d", id), "root", 22,
			time.Now(), time.Now())
	}
	return &InboundStore{DB: d, Now: time.Now}
}

func TestInboundStore_GenerateTag(t *testing.T) {
	s := newInboundStore(t)
	tag := s.GenerateTag("landing")
	if len(tag) != len("landing-")+8 {
		t.Fatalf("tag length wrong: %q", tag)
	}
	if tag[:8] != "landing-" {
		t.Fatalf("tag prefix wrong: %q", tag)
	}
	tag2 := s.GenerateTag("relay")
	if tag2[:6] != "relay-" {
		t.Fatalf("relay prefix wrong: %q", tag2)
	}
	if tag == tag2 {
		t.Fatalf("tags should differ: %q vs %q", tag, tag2)
	}
}

func TestInboundStore_InsertLandingThenRelay(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	landingID, err := s.Insert(ctx, Inbound{
		ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443, Role: "landing",
		Protocol: "vless-reality",
		UUID:     ptrStr("uuid-land"), SNI: ptrStr("www.icloud.com"),
		RealityPublicKey: ptrStr("PUB"), RealityPrivateKey: ptrStr("PRIV"),
		RealityShortID: ptrStr("aabb1122"),
		RealityHandshakeServer: ptrStr("www.icloud.com"), RealityHandshakePort: ptrI64(443),
	})
	if err != nil {
		t.Fatal(err)
	}
	if landingID == 0 {
		t.Fatal("landingID is 0")
	}

	relayID, err := s.Insert(ctx, Inbound{
		ServerID: 2, Tag: s.GenerateTag("relay"), Port: 8443, Role: "relay",
		Protocol: "vless-reality",
		UUID:     ptrStr("uuid-relay"), SNI: ptrStr("www.apple.com"),
		RealityPublicKey:       ptrStr("PUB"),
		RealityShortID:         ptrStr("ccdd3344"),
		RealityHandshakeServer: ptrStr("www.apple.com"), RealityHandshakePort: ptrI64(443),
		UpstreamInboundID: &landingID,
	})
	if err != nil {
		t.Fatal(err)
	}
	row, err := s.GetByID(ctx, relayID)
	if err != nil {
		t.Fatal(err)
	}
	if row.Role != "relay" || row.UpstreamInboundID == nil || *row.UpstreamInboundID != landingID {
		t.Fatalf("relay row wrong: %+v", row)
	}
}

func TestInboundStore_ListByServer(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	for _, port := range []int{443, 8443} {
		_, _ = s.Insert(ctx, Inbound{
			ServerID: 1, Tag: s.GenerateTag("landing"), Port: port,
			Role: "landing", Protocol: "vmess-tcp",
		})
	}
	_, _ = s.Insert(ctx, Inbound{
		ServerID: 2, Tag: s.GenerateTag("landing"), Port: 443,
		Role: "landing", Protocol: "vmess-tcp",
	})

	rows, err := s.ListByServer(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows for server 1, want 2", len(rows))
	}
}

func TestInboundStore_ListAllWithUpstream(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	landingID, _ := s.Insert(ctx, Inbound{
		ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443,
		Role: "landing", Protocol: "vless-reality",
		UUID: ptrStr("lu"), SNI: ptrStr("www.icloud.com"),
		RealityPublicKey: ptrStr("LP"), RealityShortID: ptrStr("aa"),
		RealityHandshakeServer: ptrStr("www.icloud.com"), RealityHandshakePort: ptrI64(443),
	})
	_, _ = s.Insert(ctx, Inbound{
		ServerID: 2, Tag: s.GenerateTag("relay"), Port: 8443,
		Role: "relay", Protocol: "hysteria2",
		Password: ptrStr("secret"), SNI: ptrStr("hy2.example.com"),
		UpstreamInboundID: &landingID,
	})

	views, err := s.ListAllWithUpstream(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(views) != 2 {
		t.Fatalf("want 2 views, got %d", len(views))
	}
	var relay *InboundView
	for i := range views {
		if views[i].Role == "relay" {
			relay = &views[i]
			break
		}
	}
	if relay == nil {
		t.Fatal("no relay in views")
	}
	if !relay.UpstreamTag.Valid || relay.UpstreamServerName.String != "s1" {
		t.Fatalf("relay upstream JOIN missing: %+v", relay)
	}
}

func TestInboundStore_Update_ImmutableFieldsUnchanged(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	id, _ := s.Insert(ctx, Inbound{
		ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443,
		Role: "landing", Protocol: "vless-reality",
	})
	if err := s.Update(ctx, id, InboundPatch{
		Port: ptrInt(9443), SNI: ptrStr("new.sni"),
	}); err != nil {
		t.Fatal(err)
	}
	row, _ := s.GetByID(ctx, id)
	if row.Port != 9443 || row.SNI == nil || *row.SNI != "new.sni" {
		t.Fatalf("patch did not apply: %+v", row)
	}
	if row.Role != "landing" {
		t.Fatalf("role changed: %s", row.Role)
	}
	if row.Protocol != "vless-reality" {
		t.Fatalf("protocol changed: %s", row.Protocol)
	}
}

func TestInboundStore_Delete_RestrictLandingWithRelay(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	landingID, _ := s.Insert(ctx, Inbound{
		ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443,
		Role: "landing", Protocol: "vmess-tcp",
	})
	_, _ = s.Insert(ctx, Inbound{
		ServerID: 2, Tag: s.GenerateTag("relay"), Port: 8443,
		Role: "relay", Protocol: "vmess-tcp",
		UpstreamInboundID: &landingID,
	})
	if err := s.Delete(ctx, landingID); err == nil {
		t.Fatal("expected RESTRICT error deleting landing with dependent relay")
	}
}

func ptrStr(s string) *string  { return &s }
func ptrI64(i int64) *int64    { return &i }
func ptrInt(i int) *int        { return &i }
```

- [ ] **Step 2: Run tests, expect FAIL**

```
go test -run TestInboundStore ./internal/plugins/singbox/...
```

Expected: FAIL — `InboundStore` undefined.

- [ ] **Step 3: Implement the DAO**

`internal/plugins/singbox/inbounds.go`:

```go
package singbox

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
)

// Inbound is the raw DB row for singbox_inbounds.
type Inbound struct {
	ID                     int64      `db:"id"`
	ServerID               int64      `db:"server_id"`
	Tag                    string     `db:"tag"`
	Port                   int        `db:"port"`
	Role                   string     `db:"role"`   // "landing" | "relay"
	Protocol               string     `db:"protocol"`
	UUID                   *string    `db:"uuid"`
	Flow                   *string    `db:"flow"`
	Password               *string    `db:"password"`
	SNI                    *string    `db:"sni"`
	CertID                 *int64     `db:"cert_id"`
	RealityPrivateKey      *string    `db:"reality_private_key"`
	RealityPublicKey       *string    `db:"reality_public_key"`
	RealityShortID         *string    `db:"reality_short_id"`
	RealityHandshakeServer *string    `db:"reality_handshake_server"`
	RealityHandshakePort   *int64     `db:"reality_handshake_port"`
	TransportPath          *string    `db:"transport_path"`
	TransportHost          *string    `db:"transport_host"`
	AlterID                *int64     `db:"alter_id"`
	SSMethod               *string    `db:"ss_method"`
	UpstreamInboundID      *int64     `db:"upstream_inbound_id"`
	ExtraJSON              *string    `db:"extra_json"`
	CreatedAt              time.Time  `db:"created_at"`
	UpdatedAt              time.Time  `db:"updated_at"`
}

// InboundView extends Inbound with JOIN fields from the upstream row + server name.
type InboundView struct {
	Inbound
	ServerName                  string         `db:"server_name"`
	UpstreamTag                 sql.NullString `db:"upstream_tag"`
	UpstreamPort                sql.NullInt64  `db:"upstream_port"`
	UpstreamServerID            sql.NullInt64  `db:"upstream_server_id"`
	UpstreamServerName          sql.NullString `db:"upstream_server_name"`
	UpstreamAddress             sql.NullString `db:"upstream_address"`
	UpstreamProtocol            sql.NullString `db:"upstream_protocol"`
	UpstreamUUID                sql.NullString `db:"upstream_uuid"`
	UpstreamPassword            sql.NullString `db:"upstream_password"`
	UpstreamSNI                 sql.NullString `db:"upstream_sni"`
	UpstreamRealityPublicKey    sql.NullString `db:"upstream_reality_public_key"`
	UpstreamRealityShortID      sql.NullString `db:"upstream_reality_short_id"`
	UpstreamTransportPath       sql.NullString `db:"upstream_transport_path"`
	UpstreamTransportHost       sql.NullString `db:"upstream_transport_host"`
	UpstreamSSMethod            sql.NullString `db:"upstream_ss_method"`
	UpstreamExtraJSON           sql.NullString `db:"upstream_extra_json"`
}

// InboundPatch carries mutable fields. nil = leave unchanged.
// Immutable fields (server_id, tag, role, protocol, upstream_inbound_id) are absent.
type InboundPatch struct {
	Port                   *int
	UUID                   *string
	Flow                   *string
	Password               *string
	SNI                    *string
	CertID                 *int64
	RealityPrivateKey      *string
	RealityPublicKey       *string
	RealityShortID         *string
	RealityHandshakeServer *string
	RealityHandshakePort   *int64
	TransportPath          *string
	TransportHost          *string
	AlterID                *int64
	SSMethod               *string
	ExtraJSON              *string
}

type InboundStore struct {
	DB  *sqlx.DB
	Now func() time.Time
}

func (s *InboundStore) now() time.Time {
	if s.Now == nil {
		return time.Now().UTC()
	}
	return s.Now().UTC()
}

// GenerateTag returns "<role>-<8hex>" unique each call.
func (s *InboundStore) GenerateTag(role string) string {
	var buf [4]byte
	_, _ = rand.Read(buf[:])
	return role + "-" + hex.EncodeToString(buf[:])
}

func (s *InboundStore) Insert(ctx context.Context, in Inbound) (int64, error) {
	if in.Tag == "" {
		in.Tag = s.GenerateTag(in.Role)
	}
	now := s.now()
	res, err := s.DB.ExecContext(ctx, `
		INSERT INTO singbox_inbounds (
		  server_id, tag, port, role, protocol,
		  uuid, flow, password, sni, cert_id,
		  reality_private_key, reality_public_key, reality_short_id,
		  reality_handshake_server, reality_handshake_port,
		  transport_path, transport_host, alter_id, ss_method,
		  upstream_inbound_id, extra_json,
		  created_at, updated_at
		) VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?, ?,?,?,?, ?,?, ?,?)`,
		in.ServerID, in.Tag, in.Port, in.Role, in.Protocol,
		in.UUID, in.Flow, in.Password, in.SNI, in.CertID,
		in.RealityPrivateKey, in.RealityPublicKey, in.RealityShortID,
		in.RealityHandshakeServer, in.RealityHandshakePort,
		in.TransportPath, in.TransportHost, in.AlterID, in.SSMethod,
		in.UpstreamInboundID, in.ExtraJSON,
		now, now)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *InboundStore) GetByID(ctx context.Context, id int64) (Inbound, error) {
	var row Inbound
	err := s.DB.GetContext(ctx, &row, `SELECT * FROM singbox_inbounds WHERE id=?`, id)
	return row, err
}

func (s *InboundStore) ListByServer(ctx context.Context, serverID int64) ([]Inbound, error) {
	var rows []Inbound
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT * FROM singbox_inbounds WHERE server_id=? ORDER BY id`, serverID)
	return rows, err
}

func (s *InboundStore) ListAllWithUpstream(ctx context.Context) ([]InboundView, error) {
	var rows []InboundView
	err := s.DB.SelectContext(ctx, &rows, `
		SELECT
		  i.id, i.server_id, i.tag, i.port, i.role, i.protocol,
		  i.uuid, i.flow, i.password, i.sni, i.cert_id,
		  i.reality_private_key, i.reality_public_key, i.reality_short_id,
		  i.reality_handshake_server, i.reality_handshake_port,
		  i.transport_path, i.transport_host, i.alter_id, i.ss_method,
		  i.upstream_inbound_id, i.extra_json,
		  i.created_at, i.updated_at,
		  s.name  AS server_name,
		  u.tag              AS upstream_tag,
		  u.port             AS upstream_port,
		  u.server_id        AS upstream_server_id,
		  us.name            AS upstream_server_name,
		  us.ssh_host        AS upstream_address,
		  u.protocol         AS upstream_protocol,
		  u.uuid             AS upstream_uuid,
		  u.password         AS upstream_password,
		  u.sni              AS upstream_sni,
		  u.reality_public_key  AS upstream_reality_public_key,
		  u.reality_short_id    AS upstream_reality_short_id,
		  u.transport_path      AS upstream_transport_path,
		  u.transport_host      AS upstream_transport_host,
		  u.ss_method           AS upstream_ss_method,
		  u.extra_json          AS upstream_extra_json
		FROM singbox_inbounds i
		JOIN servers s ON s.id = i.server_id
		LEFT JOIN singbox_inbounds u  ON u.id = i.upstream_inbound_id
		LEFT JOIN servers us ON us.id = u.server_id
		ORDER BY i.server_id, i.id`)
	return rows, err
}

// ListByUpstream returns relay inbounds pointing at the given landing ID.
func (s *InboundStore) ListByUpstream(ctx context.Context, landingID int64) ([]Inbound, error) {
	var rows []Inbound
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT * FROM singbox_inbounds WHERE upstream_inbound_id=? ORDER BY id`, landingID)
	return rows, err
}

func (s *InboundStore) Update(ctx context.Context, id int64, patch InboundPatch) error {
	set := []string{}
	args := []any{}
	app := func(col string, val any) { set = append(set, col+"=?"); args = append(args, val) }
	if patch.Port != nil                   { app("port", *patch.Port) }
	if patch.UUID != nil                   { app("uuid", *patch.UUID) }
	if patch.Flow != nil                   { app("flow", *patch.Flow) }
	if patch.Password != nil               { app("password", *patch.Password) }
	if patch.SNI != nil                    { app("sni", *patch.SNI) }
	if patch.CertID != nil                 { app("cert_id", *patch.CertID) }
	if patch.RealityPrivateKey != nil      { app("reality_private_key", *patch.RealityPrivateKey) }
	if patch.RealityPublicKey != nil       { app("reality_public_key", *patch.RealityPublicKey) }
	if patch.RealityShortID != nil         { app("reality_short_id", *patch.RealityShortID) }
	if patch.RealityHandshakeServer != nil { app("reality_handshake_server", *patch.RealityHandshakeServer) }
	if patch.RealityHandshakePort != nil   { app("reality_handshake_port", *patch.RealityHandshakePort) }
	if patch.TransportPath != nil          { app("transport_path", *patch.TransportPath) }
	if patch.TransportHost != nil          { app("transport_host", *patch.TransportHost) }
	if patch.AlterID != nil                { app("alter_id", *patch.AlterID) }
	if patch.SSMethod != nil               { app("ss_method", *patch.SSMethod) }
	if patch.ExtraJSON != nil              { app("extra_json", *patch.ExtraJSON) }
	if len(set) == 0 {
		return nil
	}
	set = append(set, "updated_at=?")
	args = append(args, s.now())
	args = append(args, id)
	q := fmt.Sprintf("UPDATE singbox_inbounds SET %s WHERE id=?", strings.Join(set, ", "))
	_, err := s.DB.ExecContext(ctx, q, args...)
	return err
}

// Delete removes the row. FK RESTRICT surfaces as an error if relay dependents exist.
func (s *InboundStore) Delete(ctx context.Context, id int64) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM singbox_inbounds WHERE id=?`, id)
	return err
}
```

- [ ] **Step 4: Run tests, expect PASS**

```
go test ./internal/plugins/singbox/...
```

Expected: PASS for all 6 new tests.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/singbox/inbounds.go internal/plugins/singbox/inbounds_test.go
git commit -m "feat(plugins/singbox): InboundStore DAO with full 18-protocol schema + upstream JOIN view"
```

---

## Task 4: Migration 0002_singbox_binaries + Releaser

**Files:**
- Create: `internal/plugins/singbox/migrations/0002_singbox_binaries.up.sql`
- Create: `internal/plugins/singbox/migrations/0002_singbox_binaries.down.sql`
- Create: `internal/plugins/singbox/release.go`
- Create: `internal/plugins/singbox/release_test.go`

- [ ] **Step 1: Write failing tests**

`internal/plugins/singbox/release_test.go`:

```go
package singbox

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestReleaser_FetchAndCacheHit(t *testing.T) {
	// Build a minimal fake sing-box binary tarball
	fakeBin := []byte("#!/bin/sh\necho sing-box\n")
	var tarBuf []byte
	{
		import_bytes := &bytesWriter{}
		gw := gzip.NewWriter(import_bytes)
		tw := tar.NewWriter(gw)
		_ = tw.WriteHeader(&tar.Header{
			Name: "sing-box",
			Mode: 0755,
			Size: int64(len(fakeBin)),
		})
		_, _ = tw.Write(fakeBin)
		_ = tw.Close()
		_ = gw.Close()
		tarBuf = import_bytes.Bytes()
	}
	h256 := sha256.Sum256(tarBuf)
	sha := hex.EncodeToString(h256[:])

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/repos/SagerNet/sing-box/releases":
			releases := []map[string]any{{
				"tag_name": "v1.11.5",
				"assets": []map[string]any{
					{"name": "sing-box-1.11.5-linux-amd64.tar.gz",
						"browser_download_url": "http://" + r.Host + "/dl/sing-box-1.11.5-linux-amd64.tar.gz"},
				},
			}}
			_ = json.NewEncoder(w).Encode(releases)
		case r.URL.Path == "/dl/sing-box-1.11.5-linux-amd64.tar.gz":
			w.Header().Set("Content-Length", fmt.Sprint(len(tarBuf)))
			_, _ = w.Write(tarBuf)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	cacheDir := t.TempDir()
	rel := &Releaser{
		BaseURL:  srv.URL,
		CacheDir: cacheDir,
		HTTP:     srv.Client(),
	}

	bin, err := rel.Fetch(context.Background(), "1.11.5", "linux", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	if bin.Version != "1.11.5" || bin.OS != "linux" || bin.Arch != "amd64" {
		t.Fatalf("unexpected binary meta: %+v", bin)
	}
	if bin.Sha256 != sha {
		t.Fatalf("sha256 mismatch: got %s want %s", bin.Sha256, sha)
	}

	// Cache hit: second Fetch must not call the fake server (it would panic if
	// the tarball endpoint were called again, but here we just check no error).
	bin2, err := rel.Fetch(context.Background(), "1.11.5", "linux", "amd64")
	if err != nil {
		t.Fatalf("cache hit Fetch: %v", err)
	}
	if bin2.Path != bin.Path {
		t.Fatalf("cache hit returned different path: %s vs %s", bin2.Path, bin.Path)
	}
}

// bytesWriter is a minimal io.Writer + Bytes() helper for tar/gzip assembly.
type bytesWriter struct{ buf []byte }
func (b *bytesWriter) Write(p []byte) (int, error) { b.buf = append(b.buf, p...); return len(p), nil }
func (b *bytesWriter) Bytes() []byte               { return b.buf }
```

- [ ] **Step 2: Run test, expect FAIL**

```
go test -run TestReleaser_FetchAndCacheHit ./internal/plugins/singbox/...
```

Expected: FAIL — `Releaser` undefined.

- [ ] **Step 3: Create the migration files**

`internal/plugins/singbox/migrations/0002_singbox_binaries.up.sql`:

```sql
CREATE TABLE IF NOT EXISTS singbox_binaries (
  version      TEXT    NOT NULL,
  os           TEXT    NOT NULL,
  arch         TEXT    NOT NULL,
  sha256       TEXT    NOT NULL,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  downloaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version, os, arch)
);
```

`internal/plugins/singbox/migrations/0002_singbox_binaries.down.sql`:

```sql
DROP TABLE IF EXISTS singbox_binaries;
```

- [ ] **Step 4: Implement Releaser**

`internal/plugins/singbox/release.go`:

```go
package singbox

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Releaser downloads and caches sing-box release binaries from GitHub.
type Releaser struct {
	BaseURL  string       // override for tests; default https://api.github.com
	CacheDir string
	HTTP     *http.Client
}

// Binary describes one cached sing-box binary.
type Binary struct {
	Version      string
	OS           string
	Arch         string
	SizeBytes    int64
	Sha256       string
	Path         string
	DownloadedAt time.Time
}

func (r *Releaser) client() *http.Client {
	if r.HTTP != nil {
		return r.HTTP
	}
	return &http.Client{Timeout: 120 * time.Second}
}

func (r *Releaser) apiBase() string {
	if r.BaseURL != "" {
		return strings.TrimRight(r.BaseURL, "/")
	}
	return "https://api.github.com"
}

// singboxAssetName maps (version, os, arch) to the tar.gz asset name.
// sing-box assets: sing-box-{version}-{os}-{arch}.tar.gz
// OS: linux, darwin, windows; Arch: amd64, arm64, 386, armv7, etc.
func singboxAssetName(version, osName, arch string) string {
	a := arch
	switch arch {
	case "amd64":
		a = "amd64"
	case "arm64":
		a = "arm64"
	case "386":
		a = "386"
	case "arm":
		a = "armv7"
	}
	return fmt.Sprintf("sing-box-%s-%s-%s.tar.gz", version, osName, a)
}

func (r *Releaser) cachedPath(version, osName, arch string) string {
	return filepath.Join(r.CacheDir, osName+"-"+arch, "v"+version, "sing-box")
}

// Fetch returns the binary, downloading if necessary.
func (r *Releaser) Fetch(ctx context.Context, version, osName, arch string) (Binary, error) {
	dest := r.cachedPath(version, osName, arch)
	if fi, err := os.Stat(dest); err == nil && fi.Size() > 0 {
		// Cache hit — compute sha256 from disk.
		data, err := os.ReadFile(dest)
		if err != nil {
			return Binary{}, err
		}
		h := sha256.Sum256(data)
		return Binary{
			Version: version, OS: osName, Arch: arch,
			SizeBytes: fi.Size(), Sha256: hex.EncodeToString(h[:]),
			Path: dest, DownloadedAt: fi.ModTime(),
		}, nil
	}

	// Resolve download URL from GitHub releases list.
	assetName := singboxAssetName(version, osName, arch)
	url, err := r.resolveAssetURL(ctx, version, assetName)
	if err != nil {
		return Binary{}, fmt.Errorf("resolve asset URL: %w", err)
	}

	tarBuf, err := r.download(ctx, url)
	if err != nil {
		return Binary{}, fmt.Errorf("download %s: %w", url, err)
	}

	binBytes, err := extractFromTarGz(tarBuf, "sing-box")
	if err != nil {
		return Binary{}, fmt.Errorf("extract: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
		return Binary{}, err
	}
	if err := os.WriteFile(dest, binBytes, 0755); err != nil {
		return Binary{}, err
	}

	h := sha256.Sum256(tarBuf)
	return Binary{
		Version: version, OS: osName, Arch: arch,
		SizeBytes: int64(len(binBytes)), Sha256: hex.EncodeToString(h[:]),
		Path: dest, DownloadedAt: time.Now(),
	}, nil
}

func (r *Releaser) resolveAssetURL(ctx context.Context, version, assetName string) (string, error) {
	url := r.apiBase() + "/repos/SagerNet/sing-box/releases"
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := r.client().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var releases []struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return "", err
	}
	want := "v" + version
	for _, rel := range releases {
		if rel.TagName != want {
			continue
		}
		for _, a := range rel.Assets {
			if a.Name == assetName {
				return a.BrowserDownloadURL, nil
			}
		}
	}
	return "", fmt.Errorf("asset %s not found in release %s", assetName, want)
}

func (r *Releaser) download(ctx context.Context, url string) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	resp, err := r.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func extractFromTarGz(data []byte, targetName string) ([]byte, error) {
	gr, err := gzip.NewReader(strings.NewReader(string(data)))
	if err != nil {
		// Try with bytes.Reader
		gr, err = gzip.NewReader(bytesReader(data))
		if err != nil {
			return nil, err
		}
	}
	defer gr.Close()
	tr := tar.NewReader(gr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		base := filepath.Base(hdr.Name)
		if base == targetName || strings.TrimSuffix(base, ".exe") == targetName {
			return io.ReadAll(tr)
		}
	}
	return nil, fmt.Errorf("entry %q not found in tar.gz", targetName)
}

type bytesReaderType struct{ *strings.Reader }
func bytesReader(b []byte) io.Reader { return strings.NewReader(string(b)) }
```

Note: the test uses a helper `bytesWriter` defined inline; the implementation uses `strings.NewReader` which is fine. Remove the duplicate `bytesReader` type in the actual file — use `bytes.NewReader` instead:

Replace the last two lines with:
```go
// extractFromTarGz: use bytes.NewReader directly in the gzip call.
```

And update `extractFromTarGz` to use `bytes.NewReader(data)`:

```go
import "bytes"
// ...
gr, err := gzip.NewReader(bytes.NewReader(data))
```

- [ ] **Step 5: Run test, expect PASS**

```
go test -run TestReleaser_FetchAndCacheHit ./internal/plugins/singbox/...
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/singbox/migrations/0002_singbox_binaries.up.sql \
        internal/plugins/singbox/migrations/0002_singbox_binaries.down.sql \
        internal/plugins/singbox/release.go \
        internal/plugins/singbox/release_test.go
git commit -m "feat(plugins/singbox): 0002 migration + Releaser fetches sing-box binary from GitHub"
```

---

## Task 5: Migration 0003_singbox_traffic + TrafficStore basics

**Files:**
- Create: `internal/plugins/singbox/migrations/0003_singbox_traffic.up.sql`
- Create: `internal/plugins/singbox/migrations/0003_singbox_traffic.down.sql`
- Create: `internal/plugins/singbox/migration_0003_test.go`

- [ ] **Step 1: Write the failing test**

`internal/plugins/singbox/migration_0003_test.go`:

```go
package singbox

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func TestMigration0003_TrafficTables(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "tr.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at,updated_at)
		VALUES (1,'s1','1.1.1.1','root',22,?,?)`, time.Now(), time.Now())

	// Run migrations 0001–0003 (skip 0004 so singbox_certificates is absent)
	migs := loadMigrations()[:3]
	if err := plugins.RunPluginMigrations(context.Background(), d, "singbox", migs); err != nil {
		t.Fatal(err)
	}

	for _, tbl := range []string{"singbox_traffic_raw", "singbox_traffic_minute", "singbox_traffic_hour"} {
		var n int
		if err := d.Get(&n, "SELECT COUNT(*) FROM "+tbl); err != nil {
			t.Fatalf("table %s not found: %v", tbl, err)
		}
	}

	// Valid insert into raw
	_, err = d.Exec(`INSERT INTO singbox_traffic_raw
		(server_id, tag, kind, ts, bytes_up, bytes_down)
		VALUES (1, 'landing-aabb1122', 'landing', datetime('now'), 1024, 2048)`)
	if err != nil {
		t.Fatalf("insert singbox_traffic_raw: %v", err)
	}

	// CHECK on kind
	_, err = d.Exec(`INSERT INTO singbox_traffic_raw
		(server_id, tag, kind, ts, bytes_up, bytes_down)
		VALUES (1, 'landing-aabb1122', 'invalid', datetime('now'), 0, 0)`)
	if err == nil {
		t.Fatal("expected CHECK violation on kind='invalid'")
	}

	// ON CONFLICT DO UPDATE on minute table
	_, err = d.Exec(`INSERT INTO singbox_traffic_minute
		(server_id, tag, kind, ts, bytes_up, bytes_down)
		VALUES (1, 'landing-aabb1122', 'landing', '2026-05-20 10:00:00', 100, 200)
		ON CONFLICT(server_id, tag, ts) DO UPDATE SET
		  bytes_up   = bytes_up   + excluded.bytes_up,
		  bytes_down = bytes_down + excluded.bytes_down`)
	if err != nil {
		t.Fatalf("minute upsert: %v", err)
	}
}
```

- [ ] **Step 2: Run test, expect FAIL**

```
go test -run TestMigration0003_TrafficTables ./internal/plugins/singbox/...
```

Expected: FAIL — SQL files not present.

- [ ] **Step 3: Create migration files**

`internal/plugins/singbox/migrations/0003_singbox_traffic.up.sql`:

```sql
CREATE TABLE IF NOT EXISTS singbox_traffic_raw (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag         TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('landing', 'relay')),
  ts          TIMESTAMP NOT NULL,
  bytes_up    INTEGER NOT NULL DEFAULT 0,
  bytes_down  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS singbox_traffic_raw_server_tag_ts
    ON singbox_traffic_raw(server_id, tag, ts);

CREATE TABLE IF NOT EXISTS singbox_traffic_minute (
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag         TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  ts          TIMESTAMP NOT NULL,
  bytes_up    INTEGER NOT NULL DEFAULT 0,
  bytes_down  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, tag, ts)
);
CREATE INDEX IF NOT EXISTS singbox_traffic_minute_server_tag_ts
    ON singbox_traffic_minute(server_id, tag, ts);

CREATE TABLE IF NOT EXISTS singbox_traffic_hour (
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag         TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  ts          TIMESTAMP NOT NULL,
  bytes_up    INTEGER NOT NULL DEFAULT 0,
  bytes_down  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, tag, ts)
);
CREATE INDEX IF NOT EXISTS singbox_traffic_hour_server_tag_ts
    ON singbox_traffic_hour(server_id, tag, ts);
```

`internal/plugins/singbox/migrations/0003_singbox_traffic.down.sql`:

```sql
DROP TABLE IF EXISTS singbox_traffic_hour;
DROP TABLE IF EXISTS singbox_traffic_minute;
DROP TABLE IF EXISTS singbox_traffic_raw;
```

- [ ] **Step 4: Run test, expect PASS**

```
go test -run TestMigration0003_TrafficTables ./internal/plugins/singbox/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/singbox/migrations/0003_singbox_traffic.up.sql \
        internal/plugins/singbox/migrations/0003_singbox_traffic.down.sql \
        internal/plugins/singbox/migration_0003_test.go
git commit -m "feat(plugins/singbox): 0003 migration creates singbox traffic tables (raw/minute/hour)"
```

---

## Task 6: Migration 0004_singbox_certificates + CertStore DAO

**Files:**
- Create: `internal/plugins/singbox/migrations/0004_singbox_certificates.up.sql`
- Create: `internal/plugins/singbox/migrations/0004_singbox_certificates.down.sql`
- Create: `internal/plugins/singbox/certs.go`
- Create: `internal/plugins/singbox/certs_test.go`

- [ ] **Step 1: Write failing tests**

`internal/plugins/singbox/certs_test.go`:

```go
package singbox

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func newCertStore(t *testing.T) *CertStore {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "cert.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	// Run all 4 migrations so cert_id FK in singbox_inbounds is valid
	if err := plugins.RunPluginMigrations(context.Background(), d, "singbox", loadMigrations()); err != nil {
		t.Fatal(err)
	}
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at,updated_at)
		VALUES (1,'s1','1.1.1.1','root',22,?,?)`, time.Now(), time.Now())
	return &CertStore{DB: d, Now: time.Now}
}

func TestCertStore_InsertAndGet(t *testing.T) {
	cs := newCertStore(t)
	ctx := context.Background()
	expires := time.Now().Add(90 * 24 * time.Hour).UTC().Truncate(time.Second)
	id, err := cs.Insert(ctx, CertRow{
		Domain:    "proxy.example.com",
		CertPEM:   "CERT_PEM",
		KeyPEM:    "KEY_PEM",
		ExpiresAt: expires,
		Issuer:    "Let's Encrypt",
		Status:    "active",
	})
	if err != nil {
		t.Fatal(err)
	}
	row, err := cs.GetByDomain(ctx, "proxy.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if row.ID != id || row.Status != "active" || row.CertPEM != "CERT_PEM" {
		t.Fatalf("unexpected row: %+v", row)
	}
}

func TestCertStore_List(t *testing.T) {
	cs := newCertStore(t)
	ctx := context.Background()
	for _, d := range []string{"a.example.com", "b.example.com"} {
		_, _ = cs.Insert(ctx, CertRow{
			Domain: d, CertPEM: "C", KeyPEM: "K",
			ExpiresAt: time.Now().Add(90 * 24 * time.Hour), Status: "active",
		})
	}
	rows, err := cs.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 certs, got %d", len(rows))
	}
}

func TestCertStore_UpsertStatus(t *testing.T) {
	cs := newCertStore(t)
	ctx := context.Background()
	id, _ := cs.Insert(ctx, CertRow{
		Domain: "x.example.com", CertPEM: "C", KeyPEM: "K",
		ExpiresAt: time.Now().Add(90 * 24 * time.Hour), Status: "issuing",
	})
	errMsg := "acme: error"
	if err := cs.UpsertStatus(ctx, id, "failed", &errMsg); err != nil {
		t.Fatal(err)
	}
	row, _ := cs.Get(ctx, id)
	if row.Status != "failed" || row.LastError == nil || *row.LastError != errMsg {
		t.Fatalf("status not updated: %+v", row)
	}
}

func TestCertStore_Delete_RestrictWhenReferencedByInbound(t *testing.T) {
	cs := newCertStore(t)
	ctx := context.Background()
	certID, _ := cs.Insert(ctx, CertRow{
		Domain: "y.example.com", CertPEM: "C", KeyPEM: "K",
		ExpiresAt: time.Now().Add(90 * 24 * time.Hour), Status: "active",
	})
	// Insert inbound that references this cert
	cs.DB.MustExec(`INSERT INTO singbox_inbounds
		(server_id,tag,port,role,protocol,cert_id,updated_at)
		VALUES (1,'landing-ref1',443,'landing','trojan-tls',?,?)`, certID, time.Now())
	// Delete should fail — FK RESTRICT from singbox_inbounds.cert_id
	if err := cs.Delete(ctx, certID); err == nil {
		t.Fatal("expected RESTRICT error when cert is referenced by inbound")
	}
}
```

- [ ] **Step 2: Run tests, expect FAIL**

```
go test -run TestCertStore ./internal/plugins/singbox/...
```

Expected: FAIL — `CertStore` undefined.

- [ ] **Step 3: Create migration files**

`internal/plugins/singbox/migrations/0004_singbox_certificates.up.sql`:

```sql
CREATE TABLE IF NOT EXISTS singbox_certificates (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  domain                TEXT    NOT NULL UNIQUE,
  cert_pem              TEXT    NOT NULL,
  key_pem               TEXT    NOT NULL,
  expires_at            TIMESTAMP NOT NULL,
  issuer                TEXT    NOT NULL DEFAULT 'Let''s Encrypt',
  status                TEXT    NOT NULL DEFAULT 'issuing'
                                CHECK (status IN ('issuing', 'active', 'failed', 'revoked')),
  last_renew_attempt_at TIMESTAMP,
  last_error            TEXT,
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

`internal/plugins/singbox/migrations/0004_singbox_certificates.down.sql`:

```sql
DROP TABLE IF EXISTS singbox_certificates;
```

- [ ] **Step 4: Implement CertStore**

`internal/plugins/singbox/certs.go`:

```go
package singbox

import (
	"context"
	"time"

	"github.com/jmoiron/sqlx"
)

// CertRow maps singbox_certificates.
type CertRow struct {
	ID                  int64      `db:"id"`
	Domain              string     `db:"domain"`
	CertPEM             string     `db:"cert_pem"`
	KeyPEM              string     `db:"key_pem"`
	ExpiresAt           time.Time  `db:"expires_at"`
	Issuer              string     `db:"issuer"`
	Status              string     `db:"status"`
	LastRenewAttemptAt  *time.Time `db:"last_renew_attempt_at"`
	LastError           *string    `db:"last_error"`
	CreatedAt           time.Time  `db:"created_at"`
	UpdatedAt           time.Time  `db:"updated_at"`
}

// CertView is the read projection used by the renderer (subset of CertRow).
type CertView struct {
	ID      int64  `db:"id"`
	Domain  string `db:"domain"`
	CertPEM string `db:"cert_pem"`
	KeyPEM  string `db:"key_pem"`
}

type CertStore struct {
	DB  *sqlx.DB
	Now func() time.Time
}

func (s *CertStore) now() time.Time {
	if s.Now == nil {
		return time.Now().UTC()
	}
	return s.Now().UTC()
}

func (s *CertStore) Insert(ctx context.Context, row CertRow) (int64, error) {
	now := s.now()
	if row.Issuer == "" {
		row.Issuer = "Let's Encrypt"
	}
	res, err := s.DB.ExecContext(ctx, `
		INSERT INTO singbox_certificates
		  (domain, cert_pem, key_pem, expires_at, issuer, status, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?)`,
		row.Domain, row.CertPEM, row.KeyPEM, row.ExpiresAt,
		row.Issuer, row.Status, now, now)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *CertStore) Get(ctx context.Context, id int64) (CertRow, error) {
	var row CertRow
	err := s.DB.GetContext(ctx, &row, `SELECT * FROM singbox_certificates WHERE id=?`, id)
	return row, err
}

func (s *CertStore) GetByDomain(ctx context.Context, domain string) (CertRow, error) {
	var row CertRow
	err := s.DB.GetContext(ctx, &row,
		`SELECT * FROM singbox_certificates WHERE domain=?`, domain)
	return row, err
}

func (s *CertStore) List(ctx context.Context) ([]CertRow, error) {
	var rows []CertRow
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT * FROM singbox_certificates ORDER BY domain`)
	return rows, err
}

// UpsertStatus updates status and optionally last_error (nil clears it).
func (s *CertStore) UpsertStatus(ctx context.Context, id int64, status string, lastErr *string) error {
	now := s.now()
	_, err := s.DB.ExecContext(ctx,
		`UPDATE singbox_certificates
		 SET status=?, last_error=?, last_renew_attempt_at=?, updated_at=?
		 WHERE id=?`,
		status, lastErr, now, now, id)
	return err
}

// UpsertCert stores the full cert + key PEM and marks status='active'.
func (s *CertStore) UpsertCert(ctx context.Context, id int64, certPEM, keyPEM string, expiresAt time.Time) error {
	now := s.now()
	_, err := s.DB.ExecContext(ctx,
		`UPDATE singbox_certificates
		 SET cert_pem=?, key_pem=?, expires_at=?, status='active',
		     last_renew_attempt_at=?, last_error=NULL, updated_at=?
		 WHERE id=?`,
		certPEM, keyPEM, expiresAt, now, now, id)
	return err
}

// Delete removes the cert row. FK RESTRICT on singbox_inbounds.cert_id will
// surface as an error if any inbound references this cert.
func (s *CertStore) Delete(ctx context.Context, id int64) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM singbox_certificates WHERE id=?`, id)
	return err
}

// GetViewsByIDs returns CertView for the given set of cert IDs (for the renderer).
func (s *CertStore) GetViewsByIDs(ctx context.Context, ids []int64) ([]CertView, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	query, args, err := sqlx.In(
		`SELECT id, domain, cert_pem, key_pem FROM singbox_certificates WHERE id IN (?)`, ids)
	if err != nil {
		return nil, err
	}
	var rows []CertView
	err = s.DB.SelectContext(ctx, &rows, s.DB.Rebind(query), args...)
	return rows, err
}
```

- [ ] **Step 5: Run tests, expect PASS**

```
go test ./internal/plugins/singbox/...
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/singbox/migrations/0004_singbox_certificates.up.sql \
        internal/plugins/singbox/migrations/0004_singbox_certificates.down.sql \
        internal/plugins/singbox/certs.go \
        internal/plugins/singbox/certs_test.go
git commit -m "feat(plugins/singbox): 0004 migration + CertStore DAO for ACME certificates"
```

---

## Task 7: ACME certmgr — issuance via lego

**Files:**
- Create: `internal/singbox/certmgr/certmgr.go`
- Create: `internal/singbox/certmgr/certmgr_test.go`
- Modify: `go.mod` (add lego dependency)

- [ ] **Step 1: Add lego dependency**

```bash
cd /path/to/Shepherd
go get github.com/go-acme/lego/v4@latest
```

Verify `go.mod` now lists `github.com/go-acme/lego/v4`.

- [ ] **Step 2: Write failing test**

`internal/singbox/certmgr/certmgr_test.go`:

```go
package certmgr_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/singbox/certmgr"
)

// fakeACMEServer is a minimal ACME-like server that issues self-signed certs
// immediately (no actual ACME protocol — we mock at the Manager interface level).
// This test verifies the Manager.Issue path writes PEM to the CertStore.

type fakeCertStore struct {
	upserted []certmgr.UpsertCertCall
}

type fakeCertStoreAdapter struct{ s *fakeCertStore }

func (f *fakeCertStoreAdapter) UpsertCert(ctx context.Context, id int64, certPEM, keyPEM string, expiresAt time.Time) error {
	f.s.upserted = append(f.s.upserted, certmgr.UpsertCertCall{
		ID: id, CertPEM: certPEM, KeyPEM: keyPEM, ExpiresAt: expiresAt,
	})
	return nil
}

func (f *fakeCertStoreAdapter) UpsertStatus(ctx context.Context, id int64, status string, lastErr *string) error {
	return nil
}

func TestManager_Issue_WritesToCertStore(t *testing.T) {
	store := &fakeCertStore{}
	adapter := &fakeCertStoreAdapter{s: store}

	// Build a fake lego client factory that bypasses real ACME and just
	// issues a self-signed cert.
	mgr := certmgr.New(certmgr.Config{
		CertStoreWriter: adapter,
		IssuerFunc:      fakeSelfSignedIssuer,
	})

	ctx := context.Background()
	certID := int64(42)
	if err := mgr.Issue(ctx, certID, "example.local", "http-01", "test@example.com"); err != nil {
		t.Fatalf("Issue: %v", err)
	}

	if len(store.upserted) != 1 {
		t.Fatalf("expected 1 UpsertCert call, got %d", len(store.upserted))
	}
	u := store.upserted[0]
	if u.ID != certID {
		t.Fatalf("wrong cert ID: %d", u.ID)
	}
	if u.CertPEM == "" || u.KeyPEM == "" {
		t.Fatalf("PEM not written: cert=%q key=%q", u.CertPEM, u.KeyPEM)
	}
	if u.ExpiresAt.Before(time.Now()) {
		t.Fatalf("expires_at in the past: %v", u.ExpiresAt)
	}
}

// fakeSelfSignedIssuer returns a self-signed cert immediately without any ACME.
func fakeSelfSignedIssuer(_ context.Context, domain, _ /*challenge*/, _ /*email*/ string) (certPEM, keyPEM string, expiresAt time.Time, err error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", time.Time{}, err
	}
	exp := time.Now().Add(90 * 24 * time.Hour)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: domain},
		DNSNames:     []string{domain},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     exp,
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		return "", "", time.Time{}, err
	}
	certBlock, keyBlock := pemEncode(certDER, priv)
	_ = tls.Certificate{} // ensure crypto/tls is used
	_ = http.StatusOK
	return certBlock, keyBlock, exp, nil
}

func pemEncode(certDER []byte, priv *ecdsa.PrivateKey) (string, string) {
	import_pem := func(t, b []byte) string {
		return "-----BEGIN " + t + "-----\n" + encodeBase64(b) + "\n-----END " + t + "-----\n"
	}
	keyDER, _ := x509.MarshalECPrivateKey(priv)
	return import_pem([]byte("CERTIFICATE"), certDER), import_pem([]byte("EC PRIVATE KEY"), keyDER)
}

func encodeBase64(b []byte) string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	_ = chars
	import_b64 := func(src []byte) string {
		import_enc := struct{ EncodeToString func([]byte) string }{}
		_ = import_enc
		// Use encoding/base64 directly
		return ""
	}
	_ = import_b64
	import_encoding_base64 := struct{ StdEncoding interface{ EncodeToString([]byte) string } }{}
	_ = import_encoding_base64
	// Simplified: just return a placeholder for the test
	return "<base64>"
}
```

Note: the test above uses a `fakeSelfSignedIssuer` to bypass lego entirely. The `pemEncode` and `encodeBase64` helpers are simplified — replace them with proper `encoding/pem` + `encoding/base64` calls in the actual test file:

`internal/singbox/certmgr/certmgr_test.go` (clean version):

```go
package certmgr_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/singbox/certmgr"
)

type fakeCertWriter struct{ calls []certmgr.UpsertCertCall }

func (f *fakeCertWriter) UpsertCert(_ context.Context, id int64, certPEM, keyPEM string, exp time.Time) error {
	f.calls = append(f.calls, certmgr.UpsertCertCall{ID: id, CertPEM: certPEM, KeyPEM: keyPEM, ExpiresAt: exp})
	return nil
}
func (f *fakeCertWriter) UpsertStatus(_ context.Context, _ int64, _ string, _ *string) error { return nil }

func TestManager_Issue_WritesToCertStore(t *testing.T) {
	w := &fakeCertWriter{}
	mgr := certmgr.New(certmgr.Config{
		CertStoreWriter: w,
		IssuerFunc:      selfSignedIssuer,
	})

	if err := mgr.Issue(context.Background(), 42, "test.local", "http-01", "a@b.com"); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if len(w.calls) != 1 {
		t.Fatalf("expected 1 UpsertCert, got %d", len(w.calls))
	}
	c := w.calls[0]
	if c.ID != 42 || c.CertPEM == "" || c.KeyPEM == "" {
		t.Fatalf("bad call: %+v", c)
	}
	if c.ExpiresAt.Before(time.Now()) {
		t.Fatalf("expiresAt in past: %v", c.ExpiresAt)
	}
}

func selfSignedIssuer(_ context.Context, domain, _, _ string) (certPEM, keyPEM string, expiresAt time.Time, err error) {
	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	exp := time.Now().Add(90 * 24 * time.Hour)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: domain},
		DNSNames:     []string{domain},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     exp,
	}
	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		return "", "", time.Time{}, err
	}
	certPEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}))
	keyDER, _ := x509.MarshalECPrivateKey(priv)
	keyPEM = string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
	return certPEM, keyPEM, exp, nil
}
```

- [ ] **Step 3: Run test, expect FAIL**

```
go test -run TestManager_Issue_WritesToCertStore ./internal/singbox/certmgr/...
```

Expected: FAIL — package does not exist.

- [ ] **Step 4: Implement certmgr**

`internal/singbox/certmgr/certmgr.go`:

```go
// Package certmgr wraps go-acme/lego to issue and renew TLS certificates
// for sing-box inbounds. Certificates are stored in singbox_certificates via
// the CertStoreWriter interface; the file push to hosts is done by deploy_server.
package certmgr

import (
	"context"
	"fmt"
	"time"

	"github.com/go-acme/lego/v4/certcrypto"
	"github.com/go-acme/lego/v4/certificate"
	"github.com/go-acme/lego/v4/challenge/http01"
	"github.com/go-acme/lego/v4/lego"
	"github.com/go-acme/lego/v4/providers/dns/cloudflare"
	"github.com/go-acme/lego/v4/registration"
)

// CertStoreWriter is the subset of CertStore used by the Manager.
type CertStoreWriter interface {
	UpsertCert(ctx context.Context, id int64, certPEM, keyPEM string, expiresAt time.Time) error
	UpsertStatus(ctx context.Context, id int64, status string, lastErr *string) error
}

// UpsertCertCall records one call to UpsertCert (used in tests).
type UpsertCertCall struct {
	ID        int64
	CertPEM   string
	KeyPEM    string
	ExpiresAt time.Time
}

// IssuerFunc is the actual certificate-issuance function signature.
// In production this calls lego; in tests it can be replaced with a fake.
type IssuerFunc func(ctx context.Context, domain, challenge, email string) (certPEM, keyPEM string, expiresAt time.Time, err error)

// Config is the configuration for a Manager.
type Config struct {
	CertStoreWriter CertStoreWriter
	// IssuerFunc overrides the default lego-based issuance (used in tests).
	IssuerFunc IssuerFunc
	// CFToken is the Cloudflare API token for DNS-01 challenges.
	CFToken string
	// HTTP01Port is the port to bind for HTTP-01 challenges (default 80).
	HTTP01Port int
	// CADirectoryURL overrides the ACME CA directory (default Let's Encrypt production).
	CADirectoryURL string
	// Email is the ACME account email.
	Email string
}

// Manager issues and renews TLS certificates using lego.
type Manager struct {
	cfg    Config
	issuer IssuerFunc
}

// New creates a Manager. If cfg.IssuerFunc is nil, the default lego-based
// issuer is used.
func New(cfg Config) *Manager {
	m := &Manager{cfg: cfg}
	if cfg.IssuerFunc != nil {
		m.issuer = cfg.IssuerFunc
	} else {
		m.issuer = m.legoIssue
	}
	return m
}

// Issue requests a certificate for domain using the given challenge type and
// writes the PEM pair to the CertStore row identified by certID.
// challenge must be "dns-01-cf" or "http-01".
func (m *Manager) Issue(ctx context.Context, certID int64, domain, challenge, email string) error {
	// Mark as issuing
	if err := m.cfg.CertStoreWriter.UpsertStatus(ctx, certID, "issuing", nil); err != nil {
		return fmt.Errorf("set issuing status: %w", err)
	}

	certPEM, keyPEM, expiresAt, err := m.issuer(ctx, domain, challenge, email)
	if err != nil {
		msg := err.Error()
		_ = m.cfg.CertStoreWriter.UpsertStatus(ctx, certID, "failed", &msg)
		return fmt.Errorf("issue cert for %s: %w", domain, err)
	}

	if err := m.cfg.CertStoreWriter.UpsertCert(ctx, certID, certPEM, keyPEM, expiresAt); err != nil {
		return fmt.Errorf("store cert: %w", err)
	}
	return nil
}

// Renew re-issues the certificate for domain.
func (m *Manager) Renew(ctx context.Context, certID int64, domain, challenge, email string) error {
	return m.Issue(ctx, certID, domain, challenge, email)
}

// RunRenewalLoop starts a blocking goroutine that renews certs expiring within
// 30 days. Call in a goroutine; cancel ctx to stop.
// store is a full CertStore (not just the writer interface) so we can query
// for due certs. Passed as any to avoid circular import; use type assertion.
func (m *Manager) RunRenewalLoop(ctx context.Context, store interface {
	ListExpiringSoon(ctx context.Context, within time.Duration) ([]RenewalTarget, error)
}) {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			targets, err := store.ListExpiringSoon(ctx, 30*24*time.Hour)
			if err != nil {
				continue
			}
			for _, t := range targets {
				_ = m.Renew(ctx, t.ID, t.Domain, t.Challenge, m.cfg.Email)
			}
		}
	}
}

// RenewalTarget is returned by CertStore.ListExpiringSoon.
type RenewalTarget struct {
	ID        int64
	Domain    string
	Challenge string // "dns-01-cf" | "http-01"
}

// legoIssue is the production issuance path using go-acme/lego.
func (m *Manager) legoIssue(ctx context.Context, domain, challenge, email string) (certPEM, keyPEM string, expiresAt time.Time, err error) {
	// Build a throw-away private key for the ACME account.
	accountKey, err := certcrypto.GeneratePrivateKey(certcrypto.EC256)
	if err != nil {
		return "", "", time.Time{}, fmt.Errorf("gen account key: %w", err)
	}

	user := &acmeUser{email: email, key: accountKey}
	legoConfig := lego.NewConfig(user)
	if m.cfg.CADirectoryURL != "" {
		legoConfig.CADirURL = m.cfg.CADirectoryURL
	}
	legoConfig.Certificate.KeyType = certcrypto.EC256

	client, err := lego.NewClient(legoConfig)
	if err != nil {
		return "", "", time.Time{}, fmt.Errorf("lego client: %w", err)
	}

	switch challenge {
	case "dns-01-cf":
		cfCfg := cloudflare.NewDefaultConfig()
		cfCfg.AuthToken = m.cfg.CFToken
		provider, err := cloudflare.NewDNSProviderConfig(cfCfg)
		if err != nil {
			return "", "", time.Time{}, fmt.Errorf("cloudflare provider: %w", err)
		}
		if err := client.Challenge.SetDNS01Provider(provider); err != nil {
			return "", "", time.Time{}, err
		}
	case "http-01":
		port := m.cfg.HTTP01Port
		if port == 0 {
			port = 80
		}
		if err := client.Challenge.SetHTTP01Provider(
			http01.NewProviderServer("", fmt.Sprint(port))); err != nil {
			return "", "", time.Time{}, err
		}
	default:
		return "", "", time.Time{}, fmt.Errorf("unknown challenge %q", challenge)
	}

	// Register account
	reg, err := client.Registration.Register(registration.RegisterOptions{TermsOfServiceAgreed: true})
	if err != nil {
		return "", "", time.Time{}, fmt.Errorf("register: %w", err)
	}
	user.reg = reg

	// Obtain certificate
	req := certificate.ObtainRequest{Domains: []string{domain}, Bundle: true}
	res, err := client.Certificate.Obtain(req)
	if err != nil {
		return "", "", time.Time{}, fmt.Errorf("obtain: %w", err)
	}

	// Parse expiry from the leaf cert
	exp := time.Now().Add(90 * 24 * time.Hour) // fallback
	if certs, err := certcrypto.ParsePEMBundle(res.Certificate); err == nil && len(certs) > 0 {
		exp = certs[0].NotAfter
	}

	return string(res.Certificate), string(res.PrivateKey), exp, nil
}
```

Add the `acmeUser` helper at the bottom of the same file:

```go
import (
	"crypto"
	legoreg "github.com/go-acme/lego/v4/registration"
)

type acmeUser struct {
	email string
	key   crypto.PrivateKey
	reg   *legoreg.Resource
}

func (u *acmeUser) GetEmail() string                        { return u.email }
func (u *acmeUser) GetRegistration() *legoreg.Resource      { return u.reg }
func (u *acmeUser) GetPrivateKey() crypto.PrivateKey        { return u.key }
```

(Merge both import blocks in the actual file.)

- [ ] **Step 5: Run test, expect PASS**

```
go test -run TestManager_Issue_WritesToCertStore ./internal/singbox/certmgr/...
```

Expected: PASS (the fake IssuerFunc bypasses lego entirely).

- [ ] **Step 6: Commit**

```bash
git add internal/singbox/certmgr/certmgr.go \
        internal/singbox/certmgr/certmgr_test.go \
        go.mod go.sum
git commit -m "feat(singbox/certmgr): ACME certificate manager wrapping go-acme/lego with injectable IssuerFunc"
```

---

---

## Task 8: RenderServerConfig — VLESS-REALITY (landing only)

**Files:**
- Create: `internal/plugins/singbox/render.go`
- Create: `internal/plugins/singbox/render_test.go`

- [ ] **Step 1: Write failing tests**

`internal/plugins/singbox/render_test.go`:

```go
package singbox

import (
	"encoding/json"
	"testing"
)

func mkVlessRealityLanding() InboundView {
	return InboundView{
		Inbound: Inbound{
			ID: 1, ServerID: 1, Tag: "landing-a1b2c3d4", Port: 443,
			Role: "landing", Protocol: "vless-reality",
			UUID:                   ptrStr("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"),
			Flow:                   ptrStr("xtls-rprx-vision"),
			SNI:                    ptrStr("www.icloud.com"),
			RealityPrivateKey:      ptrStr("PRIVKEY"),
			RealityPublicKey:       ptrStr("PUBKEY"),
			RealityShortID:         ptrStr("aabb1122"),
			RealityHandshakeServer: ptrStr("www.icloud.com"),
			RealityHandshakePort:   ptrI64(443),
		},
		ServerName: "s1",
	}
}

func TestRenderServerConfig_VlessRealityLanding(t *testing.T) {
	cfg, err := RenderServerConfig([]InboundView{mkVlessRealityLanding()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(cfg, &out); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, cfg)
	}
	for _, key := range []string{"log", "dns", "inbounds", "outbounds", "route", "experimental"} {
		if _, ok := out[key]; !ok {
			t.Errorf("missing top-level key %q", key)
		}
	}
	inbounds := out["inbounds"].([]any)
	if len(inbounds) != 1 {
		t.Fatalf("want 1 inbound, got %d", len(inbounds))
	}
	ib := inbounds[0].(map[string]any)
	if ib["type"] != "vless" {
		t.Errorf("inbound type: got %v", ib["type"])
	}
	if ib["tag"] != "landing-a1b2c3d4" {
		t.Errorf("inbound tag: got %v", ib["tag"])
	}
	tls := ib["tls"].(map[string]any)
	if tls["enabled"] != true {
		t.Errorf("tls.enabled not true")
	}
	reality := tls["reality"].(map[string]any)
	if reality["enabled"] != true {
		t.Errorf("reality.enabled not true")
	}
	exp := out["experimental"].(map[string]any)
	clashAPI := exp["clash_api"].(map[string]any)
	if clashAPI["external_controller"] != "127.0.0.1:29090" {
		t.Errorf("clash_api port: got %v", clashAPI["external_controller"])
	}
	route := out["route"].(map[string]any)
	rules := route["rules"].([]any)
	hasGeoIP := false
	for _, r := range rules {
		rm := r.(map[string]any)
		if _, ok := rm["ip_cidr"]; ok {
			hasGeoIP = true
		}
	}
	if !hasGeoIP {
		t.Errorf("missing ip_cidr rule in route.rules")
	}
}

func TestRenderServerConfig_ErrorOnEmpty(t *testing.T) {
	_, err := RenderServerConfig(nil, nil)
	if err == nil {
		t.Fatal("expected error on empty inbounds")
	}
}
```

- [ ] **Step 2: Run tests, expect FAIL**

```
go test -run TestRenderServerConfig ./internal/plugins/singbox/...
```

Expected: FAIL — `RenderServerConfig` undefined.

- [ ] **Step 3: Implement render.go (VLESS-REALITY only)**

`internal/plugins/singbox/render.go`:

```go
package singbox

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

const (
	clashAPIAddr = "127.0.0.1:29090"
	configDir    = "/etc/shepherd-singbox"
)

// CertFilePath returns host-side cert/key paths for the given domain.
func CertFilePath(cfgDir, domain string) (crt, key string) {
	return cfgDir + "/certs/" + domain + ".crt",
		cfgDir + "/certs/" + domain + ".key"
}

// RenderServerConfig assembles a complete sing-box config.json.
// Returns error if inbounds is empty.
func RenderServerConfig(inbounds []InboundView, certs []CertView) ([]byte, error) {
	if len(inbounds) == 0 {
		return nil, errors.New("RenderServerConfig: no inbounds")
	}
	certsByID := map[int64]CertView{}
	for _, c := range certs {
		certsByID[c.ID] = c
	}

	inboundsJSON := make([]any, 0, len(inbounds))
	outbounds := make([]any, 0)
	routeRules := make([]any, 0)
	hasLanding := false

	for _, in := range inbounds {
		ib, err := renderInbound(in, certsByID)
		if err != nil {
			return nil, fmt.Errorf("inbound %s: %w", in.Tag, err)
		}
		inboundsJSON = append(inboundsJSON, ib)
		if in.Role == "landing" {
			hasLanding = true
		}
		if in.Role == "relay" {
			if !in.UpstreamTag.Valid {
				return nil, fmt.Errorf("relay %s missing upstream JOIN fields", in.Tag)
			}
			ob, err := renderRelayOutbound(in)
			if err != nil {
				return nil, fmt.Errorf("relay outbound %s: %w", in.Tag, err)
			}
			outbounds = append(outbounds, ob)
			routeRules = append(routeRules, map[string]any{
				"inbound":  []any{in.Tag},
				"outbound": "to-" + in.UpstreamTag.String,
			})
		}
	}

	outbounds = append(outbounds,
		map[string]any{"type": "direct", "tag": "direct"},
		map[string]any{"type": "block", "tag": "block"},
	)
	if hasLanding {
		routeRules = append(routeRules, map[string]any{
			"ip_cidr": []any{
				"0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8",
				"169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16",
				"fc00::/7", "fe80::/10",
			},
			"outbound": "block",
		})
	}

	cfg := map[string]any{
		"log": map[string]any{"level": "warn", "timestamp": true},
		"dns": map[string]any{
			"servers": []any{
				map[string]any{"tag": "dns-remote", "address": "tls://1.1.1.1", "detour": "direct"},
				map[string]any{"tag": "dns-local", "address": "local", "detour": "direct"},
			},
			"rules": []any{},
			"final": "dns-remote",
		},
		"inbounds":  inboundsJSON,
		"outbounds": outbounds,
		"route": map[string]any{
			"rules":                 routeRules,
			"final":                 "direct",
			"auto_detect_interface": true,
		},
		"experimental": map[string]any{
			"clash_api": map[string]any{
				"external_controller": clashAPIAddr,
				"secret":              "",
			},
		},
	}
	return json.MarshalIndent(cfg, "", "  ")
}

func renderInbound(in InboundView, certsByID map[int64]CertView) (map[string]any, error) {
	base := map[string]any{
		"tag":         in.Tag,
		"listen":      "::",
		"listen_port": in.Port,
	}
	switch in.Protocol {
	case "vless-reality":
		return renderVlessReality(base, in)
	case "vless-ws-tls":
		return renderVlessTLS(base, in, "ws", certsByID)
	case "vless-h2-tls":
		return renderVlessTLS(base, in, "http", certsByID)
	case "vless-httpupgrade-tls":
		return renderVlessTLS(base, in, "httpupgrade", certsByID)
	case "vmess-tcp":
		return renderVmess(base, in, "", certsByID)
	case "vmess-http":
		return renderVmess(base, in, "http", certsByID)
	case "vmess-quic":
		return renderVmess(base, in, "quic", certsByID)
	case "vmess-ws-tls":
		return renderVmessTLS(base, in, "ws", certsByID)
	case "vmess-h2-tls":
		return renderVmessTLS(base, in, "http", certsByID)
	case "vmess-httpupgrade-tls":
		return renderVmessTLS(base, in, "httpupgrade", certsByID)
	case "trojan-tls":
		return renderTrojan(base, in, "", certsByID)
	case "trojan-ws-tls":
		return renderTrojan(base, in, "ws", certsByID)
	case "trojan-h2-tls":
		return renderTrojan(base, in, "http", certsByID)
	case "trojan-httpupgrade-tls":
		return renderTrojan(base, in, "httpupgrade", certsByID)
	case "hysteria2":
		return renderHysteria2(base, in, certsByID)
	case "tuic-v5":
		return renderTUIC(base, in, certsByID)
	case "anytls":
		return renderAnyTLS(base, in, certsByID)
	case "shadowsocks-2022":
		return renderSS2022(base, in)
	default:
		return nil, fmt.Errorf("unsupported protocol: %s", in.Protocol)
	}
}

// certPaths looks up cert domain and returns host-side file paths.
func certPaths(certID *int64, certsByID map[int64]CertView) (crt, key string) {
	if certID == nil { return "", "" }
	c, ok := certsByID[*certID]
	if !ok { return "", "" }
	return CertFilePath(configDir, c.Domain)
}

func renderTLSBlock(sni, certPath, keyPath string) map[string]any {
	return map[string]any{
		"enabled":          true,
		"server_name":      sni,
		"certificate_path": certPath,
		"key_path":         keyPath,
	}
}

func renderVlessReality(base map[string]any, in InboundView) (map[string]any, error) {
	base["type"] = "vless"
	user := map[string]any{"uuid": strVal(in.UUID)}
	if in.Flow != nil && *in.Flow != "" { user["flow"] = *in.Flow }
	base["users"] = []any{user}
	shortIDs := []any{}
	if in.RealityShortID != nil { shortIDs = []any{*in.RealityShortID} }
	base["tls"] = map[string]any{
		"enabled":     true,
		"server_name": strVal(in.SNI),
		"reality": map[string]any{
			"enabled": true,
			"handshake": map[string]any{
				"server":      strVal(in.RealityHandshakeServer),
				"server_port": int64Val(in.RealityHandshakePort),
			},
			"private_key": strVal(in.RealityPrivateKey),
			"short_id":    shortIDs,
		},
	}
	return base, nil
}

func renderVlessTLS(base map[string]any, in InboundView, transport string, certsByID map[int64]CertView) (map[string]any, error) {
	base["type"] = "vless"
	base["users"] = []any{map[string]any{"uuid": strVal(in.UUID)}}
	crt, key := certPaths(in.CertID, certsByID)
	base["tls"] = renderTLSBlock(strVal(in.SNI), crt, key)
	base["transport"] = renderTransport(transport, in)
	return base, nil
}

func renderVmess(base map[string]any, in InboundView, transport string, _ map[int64]CertView) (map[string]any, error) {
	base["type"] = "vmess"
	alterID := int64(0)
	if in.AlterID != nil { alterID = *in.AlterID }
	base["users"] = []any{map[string]any{"uuid": strVal(in.UUID), "alterId": alterID}}
	if transport != "" { base["transport"] = renderTransport(transport, in) }
	return base, nil
}

func renderVmessTLS(base map[string]any, in InboundView, transport string, certsByID map[int64]CertView) (map[string]any, error) {
	base, err := renderVmess(base, in, transport, certsByID)
	if err != nil { return nil, err }
	crt, key := certPaths(in.CertID, certsByID)
	base["tls"] = renderTLSBlock(strVal(in.SNI), crt, key)
	return base, nil
}

func renderTrojan(base map[string]any, in InboundView, transport string, certsByID map[int64]CertView) (map[string]any, error) {
	base["type"] = "trojan"
	base["users"] = []any{map[string]any{"password": strVal(in.Password)}}
	crt, key := certPaths(in.CertID, certsByID)
	base["tls"] = renderTLSBlock(strVal(in.SNI), crt, key)
	if transport != "" { base["transport"] = renderTransport(transport, in) }
	return base, nil
}

func renderHysteria2(base map[string]any, in InboundView, certsByID map[int64]CertView) (map[string]any, error) {
	base["type"] = "hysteria2"
	base["users"] = []any{map[string]any{"password": strVal(in.Password)}}
	crt, key := certPaths(in.CertID, certsByID)
	base["tls"] = renderTLSBlock(strVal(in.SNI), crt, key)
	if in.ExtraJSON != nil && *in.ExtraJSON != "" {
		var extra map[string]any
		if err := json.Unmarshal([]byte(*in.ExtraJSON), &extra); err == nil {
			if v, ok := extra["up_mbps"]; ok   { base["up_mbps"] = v }
			if v, ok := extra["down_mbps"]; ok { base["down_mbps"] = v }
			if v, ok := extra["obfs"]; ok && v != "" {
				base["obfs"] = map[string]any{"type": v, "password": extra["obfs_password"]}
			}
		}
	}
	return base, nil
}

func renderTUIC(base map[string]any, in InboundView, certsByID map[int64]CertView) (map[string]any, error) {
	base["type"] = "tuic"
	base["users"] = []any{map[string]any{"uuid": strVal(in.UUID), "password": strVal(in.Password)}}
	crt, key := certPaths(in.CertID, certsByID)
	tls := renderTLSBlock(strVal(in.SNI), crt, key)
	tls["alpn"] = []any{"h3"}
	base["tls"] = tls
	if in.ExtraJSON != nil && *in.ExtraJSON != "" {
		var extra map[string]any
		if err := json.Unmarshal([]byte(*in.ExtraJSON), &extra); err == nil {
			if v, ok := extra["congestion_control"]; ok { base["congestion_control"] = v }
			if v, ok := extra["auth_timeout"]; ok       { base["auth_timeout"] = v }
		}
	}
	return base, nil
}

func renderAnyTLS(base map[string]any, in InboundView, certsByID map[int64]CertView) (map[string]any, error) {
	base["type"] = "anytls"
	base["users"] = []any{map[string]any{"password": strVal(in.Password)}}
	crt, key := certPaths(in.CertID, certsByID)
	base["tls"] = renderTLSBlock(strVal(in.SNI), crt, key)
	return base, nil
}

func renderSS2022(base map[string]any, in InboundView) (map[string]any, error) {
	base["type"] = "shadowsocks"
	base["method"] = strVal(in.SSMethod)
	base["password"] = strVal(in.Password)
	return base, nil
}

func renderTransport(ttype string, in InboundView) map[string]any {
	tr := map[string]any{"type": ttype}
	path := strVal(in.TransportPath)
	host := strVal(in.TransportHost)
	switch ttype {
	case "ws":
		tr["path"] = path
		if host != "" { tr["headers"] = map[string]any{"Host": host} }
	case "http":
		tr["path"] = path
		if host != "" { tr["host"] = []any{host} }
		tr["method"] = "PUT"
	case "httpupgrade":
		tr["path"] = path
		if host != "" { tr["host"] = host }
	}
	return tr
}

func renderRelayOutbound(in InboundView) (map[string]any, error) {
	upTag := in.UpstreamTag.String
	ob := map[string]any{
		"tag":         "to-" + upTag,
		"server":      in.UpstreamAddress.String,
		"server_port": in.UpstreamPort.Int64,
	}
	switch in.UpstreamProtocol.String {
	case "vless-reality":
		ob["type"] = "vless"
		ob["uuid"] = in.UpstreamUUID.String
		ob["flow"] = "xtls-rprx-vision"
		ob["tls"] = map[string]any{
			"enabled":     true,
			"server_name": in.UpstreamSNI.String,
			"utls":        map[string]any{"enabled": true, "fingerprint": "chrome"},
			"reality": map[string]any{
				"enabled":    true,
				"public_key": in.UpstreamRealityPublicKey.String,
				"short_id":   in.UpstreamRealityShortID.String,
			},
		}
	case "vless-ws-tls", "vless-h2-tls", "vless-httpupgrade-tls":
		ob["type"] = "vless"
		ob["uuid"] = in.UpstreamUUID.String
		ob["tls"] = map[string]any{"enabled": true, "server_name": in.UpstreamSNI.String}
		ob["transport"] = renderUpstreamTransport(protoToTransport(in.UpstreamProtocol.String), in)
	case "vmess-tcp":
		ob["type"] = "vmess"; ob["uuid"] = in.UpstreamUUID.String
		ob["alter_id"] = 0; ob["security"] = "auto"
	case "vmess-http":
		ob["type"] = "vmess"; ob["uuid"] = in.UpstreamUUID.String
		ob["alter_id"] = 0; ob["security"] = "auto"
		ob["transport"] = renderUpstreamTransport("http", in)
	case "vmess-quic":
		ob["type"] = "vmess"; ob["uuid"] = in.UpstreamUUID.String
		ob["alter_id"] = 0; ob["security"] = "auto"
		ob["transport"] = map[string]any{"type": "quic"}
	case "vmess-ws-tls", "vmess-h2-tls", "vmess-httpupgrade-tls":
		ob["type"] = "vmess"; ob["uuid"] = in.UpstreamUUID.String
		ob["alter_id"] = 0; ob["security"] = "auto"
		ob["tls"] = map[string]any{"enabled": true, "server_name": in.UpstreamSNI.String}
		ob["transport"] = renderUpstreamTransport(protoToTransport(in.UpstreamProtocol.String), in)
	case "trojan-tls":
		ob["type"] = "trojan"; ob["password"] = in.UpstreamPassword.String
		ob["tls"] = map[string]any{"enabled": true, "server_name": in.UpstreamSNI.String}
	case "trojan-ws-tls", "trojan-h2-tls", "trojan-httpupgrade-tls":
		ob["type"] = "trojan"; ob["password"] = in.UpstreamPassword.String
		ob["tls"] = map[string]any{"enabled": true, "server_name": in.UpstreamSNI.String}
		ob["transport"] = renderUpstreamTransport(protoToTransport(in.UpstreamProtocol.String), in)
	case "hysteria2":
		ob["type"] = "hysteria2"; ob["password"] = in.UpstreamPassword.String
		ob["tls"] = map[string]any{"enabled": true, "server_name": in.UpstreamSNI.String}
		if in.UpstreamExtraJSON.Valid && in.UpstreamExtraJSON.String != "" {
			var extra map[string]any
			if err := json.Unmarshal([]byte(in.UpstreamExtraJSON.String), &extra); err == nil {
				if v, ok := extra["up_mbps"]; ok   { ob["up_mbps"] = v }
				if v, ok := extra["down_mbps"]; ok { ob["down_mbps"] = v }
			}
		}
	case "tuic-v5":
		ob["type"] = "tuic"; ob["uuid"] = in.UpstreamUUID.String
		ob["password"] = in.UpstreamPassword.String
		ob["tls"] = map[string]any{
			"enabled": true, "server_name": in.UpstreamSNI.String, "alpn": []any{"h3"},
		}
	case "anytls":
		ob["type"] = "anytls"; ob["password"] = in.UpstreamPassword.String
		ob["tls"] = map[string]any{"enabled": true, "server_name": in.UpstreamSNI.String}
	case "shadowsocks-2022":
		ob["type"] = "shadowsocks"
		ob["method"] = in.UpstreamSSMethod.String
		ob["password"] = in.UpstreamPassword.String
	default:
		return nil, fmt.Errorf("unsupported upstream protocol: %s", in.UpstreamProtocol.String)
	}
	return ob, nil
}

// protoToTransport maps protocol suffix to sing-box transport type string.
func protoToTransport(proto string) string {
	switch {
	case strings.HasSuffix(proto, "ws-tls"):
		return "ws"
	case strings.HasSuffix(proto, "h2-tls"):
		return "http"
	case strings.HasSuffix(proto, "httpupgrade-tls"):
		return "httpupgrade"
	default:
		return ""
	}
}

func renderUpstreamTransport(ttype string, in InboundView) map[string]any {
	tr := map[string]any{"type": ttype}
	path := in.UpstreamTransportPath.String
	host := in.UpstreamTransportHost.String
	switch ttype {
	case "ws":
		tr["path"] = path
		if host != "" { tr["headers"] = map[string]any{"Host": host} }
	case "http":
		tr["path"] = path
		if host != "" { tr["host"] = []any{host} }
	case "httpupgrade":
		tr["path"] = path
		if host != "" { tr["host"] = host }
	}
	return tr
}

func strVal(s *string) string   { if s == nil { return "" }; return *s }
func int64Val(i *int64) int64   { if i == nil { return 0 }; return *i }
func sortedKeys(m map[string]map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m { keys = append(keys, k) }
	sort.Strings(keys)
	return keys
}
```

- [ ] **Step 4: Run tests, expect PASS**

```
go test ./internal/plugins/singbox/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/singbox/render.go internal/plugins/singbox/render_test.go
git commit -m "feat(plugins/singbox): RenderServerConfig — all 18 protocols + relay outbounds + clash_api"
```

Note: Tasks 8, 9, and 10 are merged into this single render.go file. The render.go implementation above covers all 18 protocols (landing + relay). If you prefer to split them, apply the VLESS-REALITY-only version first, run tests, then extend — the commit message above reflects the final merged state.

---

## Task 9: Per-protocol render tests (remaining 17 families)

**Files:**
- Modify: `internal/plugins/singbox/render_test.go` (add tests)

The render.go from Task 8 already handles all 18 protocols. This task adds the per-family test coverage and relay tests.

- [ ] **Step 1: Append tests to render_test.go**

```go
// Add to render_test.go:

import "database/sql"

func fakeCertView(id int64, domain string) CertView {
	return CertView{ID: id, Domain: domain, CertPEM: "CERT", KeyPEM: "KEY"}
}

func TestRender_VlessWSTLS(t *testing.T) {
	certID := int64(10)
	iv := InboundView{Inbound: Inbound{
		ID: 2, ServerID: 1, Tag: "landing-b2c3d4e5", Port: 8443,
		Role: "landing", Protocol: "vless-ws-tls",
		UUID: ptrStr("uuid-vless-ws"), SNI: ptrStr("proxy.example.com"),
		CertID: &certID, TransportPath: ptrStr("/vless"), TransportHost: ptrStr("proxy.example.com"),
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, []CertView{fakeCertView(certID, "proxy.example.com")})
	if err != nil { t.Fatal(err) }
	var out map[string]any; _ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "vless" { t.Errorf("type: %v", ib["type"]) }
	tls := ib["tls"].(map[string]any)
	if tls["certificate_path"] != "/etc/shepherd-singbox/certs/proxy.example.com.crt" {
		t.Errorf("cert path: %v", tls["certificate_path"])
	}
	tr := ib["transport"].(map[string]any)
	if tr["type"] != "ws" || tr["path"] != "/vless" { t.Errorf("transport: %v", tr) }
}

func TestRender_VmessTCP(t *testing.T) {
	iv := InboundView{Inbound: Inbound{
		ID: 3, ServerID: 1, Tag: "landing-e5f6a7b8", Port: 10086,
		Role: "landing", Protocol: "vmess-tcp",
		UUID: ptrStr("uuid-vmess"), AlterID: ptrI64(0),
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, nil)
	if err != nil { t.Fatal(err) }
	var out map[string]any; _ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "vmess" { t.Errorf("type: %v", ib["type"]) }
	u := ib["users"].([]any)[0].(map[string]any)
	if u["alterId"] != float64(0) { t.Errorf("alterId: %v", u["alterId"]) }
	if _, hasTLS := ib["tls"]; hasTLS { t.Error("vmess-tcp must not have tls block") }
}

func TestRender_TrojanTLS(t *testing.T) {
	certID := int64(20)
	iv := InboundView{Inbound: Inbound{
		ID: 4, ServerID: 1, Tag: "landing-e1f2a3b4", Port: 443,
		Role: "landing", Protocol: "trojan-tls",
		Password: ptrStr("trojan_pass"), SNI: ptrStr("proxy.example.com"), CertID: &certID,
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, []CertView{fakeCertView(certID, "proxy.example.com")})
	if err != nil { t.Fatal(err) }
	var out map[string]any; _ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "trojan" { t.Errorf("type: %v", ib["type"]) }
	u := ib["users"].([]any)[0].(map[string]any)
	if u["password"] != "trojan_pass" { t.Errorf("password: %v", u["password"]) }
}

func TestRender_Hysteria2(t *testing.T) {
	certID := int64(30)
	extra := `{"up_mbps":100,"down_mbps":200}`
	iv := InboundView{Inbound: Inbound{
		ID: 5, ServerID: 1, Tag: "landing-c5d6e7f8", Port: 36712,
		Role: "landing", Protocol: "hysteria2",
		Password: ptrStr("hy2_pass"), SNI: ptrStr("hy2.example.com"),
		CertID: &certID, ExtraJSON: &extra,
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, []CertView{fakeCertView(certID, "hy2.example.com")})
	if err != nil { t.Fatal(err) }
	var out map[string]any; _ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "hysteria2" { t.Errorf("type: %v", ib["type"]) }
	if ib["up_mbps"] != float64(100) { t.Errorf("up_mbps: %v", ib["up_mbps"]) }
}

func TestRender_SS2022(t *testing.T) {
	iv := InboundView{Inbound: Inbound{
		ID: 6, ServerID: 1, Tag: "landing-f8a9b0c1", Port: 8388,
		Role: "landing", Protocol: "shadowsocks-2022",
		Password: ptrStr("base64key=="), SSMethod: ptrStr("2022-blake3-aes-128-gcm"),
	}, ServerName: "s1"}
	cfg, err := RenderServerConfig([]InboundView{iv}, nil)
	if err != nil { t.Fatal(err) }
	var out map[string]any; _ = json.Unmarshal(cfg, &out)
	ib := out["inbounds"].([]any)[0].(map[string]any)
	if ib["type"] != "shadowsocks" { t.Errorf("type: %v", ib["type"]) }
	if ib["method"] != "2022-blake3-aes-128-gcm" { t.Errorf("method: %v", ib["method"]) }
}

func TestRender_VlessRealityRelay(t *testing.T) {
	landing := mkVlessRealityLanding()
	upID := int64(1)
	relay := InboundView{
		Inbound: Inbound{
			ID: 10, ServerID: 2, Tag: "relay-e5f6a7b8", Port: 8443,
			Role: "relay", Protocol: "vless-reality",
			UUID: ptrStr("relay-uuid"), Flow: ptrStr("xtls-rprx-vision"),
			SNI: ptrStr("relay.example.com"),
			RealityPublicKey: ptrStr("RELAYPUB"), RealityShortID: ptrStr("relay123"),
			RealityHandshakeServer: ptrStr("relay.example.com"), RealityHandshakePort: ptrI64(443),
			UpstreamInboundID: &upID,
		},
		ServerName:               "s2",
		UpstreamTag:              sql.NullString{String: "landing-a1b2c3d4", Valid: true},
		UpstreamPort:             sql.NullInt64{Int64: 443, Valid: true},
		UpstreamServerID:         sql.NullInt64{Int64: 1, Valid: true},
		UpstreamServerName:       sql.NullString{String: "s1", Valid: true},
		UpstreamAddress:          sql.NullString{String: "landing.example.com", Valid: true},
		UpstreamProtocol:         sql.NullString{String: "vless-reality", Valid: true},
		UpstreamUUID:             sql.NullString{String: "upstream-uuid", Valid: true},
		UpstreamSNI:              sql.NullString{String: "www.icloud.com", Valid: true},
		UpstreamRealityPublicKey: sql.NullString{String: "UPPUB", Valid: true},
		UpstreamRealityShortID:   sql.NullString{String: "aabb1122", Valid: true},
	}
	cfg, err := RenderServerConfig([]InboundView{landing, relay}, nil)
	if err != nil { t.Fatal(err) }
	var out map[string]any; _ = json.Unmarshal(cfg, &out)
	outbounds := out["outbounds"].([]any)
	var relayOB map[string]any
	for _, o := range outbounds {
		om := o.(map[string]any)
		if om["tag"] == "to-landing-a1b2c3d4" { relayOB = om }
	}
	if relayOB == nil { t.Fatal("to-landing-a1b2c3d4 not found") }
	if relayOB["type"] != "vless" { t.Errorf("type: %v", relayOB["type"]) }
	tls := relayOB["tls"].(map[string]any)
	reality := tls["reality"].(map[string]any)
	if reality["public_key"] != "UPPUB" { t.Errorf("public_key: %v", reality["public_key"]) }
	rules := out["route"].(map[string]any)["rules"].([]any)
	found := false
	for _, r := range rules {
		if inb, ok := r.(map[string]any)["inbound"].([]any); ok {
			for _, tag := range inb { if tag == "relay-e5f6a7b8" { found = true } }
		}
	}
	if !found { t.Error("route rule for relay not found") }
}

func TestRender_Hysteria2Relay(t *testing.T) {
	certID := int64(30)
	extra := `{"up_mbps":100,"down_mbps":200}`
	landing := InboundView{Inbound: Inbound{
		ID: 5, ServerID: 1, Tag: "landing-c5d6e7f8", Port: 36712,
		Role: "landing", Protocol: "hysteria2",
		Password: ptrStr("hy2_pass"), SNI: ptrStr("hy2.example.com"),
		CertID: &certID, ExtraJSON: &extra,
	}, ServerName: "s1"}
	relayUID := int64(5)
	relay := InboundView{
		Inbound: Inbound{
			ID: 11, ServerID: 2, Tag: "relay-hy2-0001", Port: 36713,
			Role: "relay", Protocol: "hysteria2",
			Password: ptrStr("relay-hy2"), SNI: ptrStr("relay.example.com"),
			CertID: &certID, ExtraJSON: &extra, UpstreamInboundID: &relayUID,
		},
		ServerName:           "s2",
		UpstreamTag:          sql.NullString{String: "landing-c5d6e7f8", Valid: true},
		UpstreamPort:         sql.NullInt64{Int64: 36712, Valid: true},
		UpstreamServerID:     sql.NullInt64{Int64: 1, Valid: true},
		UpstreamServerName:   sql.NullString{String: "s1", Valid: true},
		UpstreamAddress:      sql.NullString{String: "landing.example.com", Valid: true},
		UpstreamProtocol:     sql.NullString{String: "hysteria2", Valid: true},
		UpstreamPassword:     sql.NullString{String: "hy2_pass", Valid: true},
		UpstreamSNI:          sql.NullString{String: "hy2.example.com", Valid: true},
		UpstreamExtraJSON:    sql.NullString{String: extra, Valid: true},
	}
	cfg, err := RenderServerConfig([]InboundView{landing, relay}, []CertView{fakeCertView(certID, "hy2.example.com")})
	if err != nil { t.Fatal(err) }
	var out map[string]any; _ = json.Unmarshal(cfg, &out)
	var hy2OB map[string]any
	for _, o := range out["outbounds"].([]any) {
		om := o.(map[string]any)
		if om["tag"] == "to-landing-c5d6e7f8" { hy2OB = om }
	}
	if hy2OB == nil { t.Fatal("to-landing-c5d6e7f8 not found") }
	if hy2OB["type"] != "hysteria2" { t.Errorf("type: %v", hy2OB["type"]) }
}

func TestRender_SS2022Relay(t *testing.T) {
	landing := InboundView{Inbound: Inbound{
		ID: 6, ServerID: 1, Tag: "landing-f8a9b0c1", Port: 8388,
		Role: "landing", Protocol: "shadowsocks-2022",
		Password: ptrStr("base64key=="), SSMethod: ptrStr("2022-blake3-aes-128-gcm"),
	}, ServerName: "s1"}
	relayUID := int64(6)
	relay := InboundView{
		Inbound: Inbound{
			ID: 12, ServerID: 2, Tag: "relay-ss2022-0001", Port: 8389,
			Role: "relay", Protocol: "shadowsocks-2022",
			Password: ptrStr("relay-key=="), SSMethod: ptrStr("2022-blake3-aes-128-gcm"),
			UpstreamInboundID: &relayUID,
		},
		ServerName:         "s2",
		UpstreamTag:        sql.NullString{String: "landing-f8a9b0c1", Valid: true},
		UpstreamPort:       sql.NullInt64{Int64: 8388, Valid: true},
		UpstreamServerID:   sql.NullInt64{Int64: 1, Valid: true},
		UpstreamServerName: sql.NullString{String: "s1", Valid: true},
		UpstreamAddress:    sql.NullString{String: "landing.example.com", Valid: true},
		UpstreamProtocol:   sql.NullString{String: "shadowsocks-2022", Valid: true},
		UpstreamPassword:   sql.NullString{String: "base64key==", Valid: true},
		UpstreamSSMethod:   sql.NullString{String: "2022-blake3-aes-128-gcm", Valid: true},
	}
	cfg, err := RenderServerConfig([]InboundView{landing, relay}, nil)
	if err != nil { t.Fatal(err) }
	var out map[string]any; _ = json.Unmarshal(cfg, &out)
	var ssOB map[string]any
	for _, o := range out["outbounds"].([]any) {
		om := o.(map[string]any)
		if om["tag"] == "to-landing-f8a9b0c1" { ssOB = om }
	}
	if ssOB == nil { t.Fatal("to-landing-f8a9b0c1 not found") }
	if ssOB["type"] != "shadowsocks" { t.Errorf("type: %v", ssOB["type"]) }
	if ssOB["method"] != "2022-blake3-aes-128-gcm" { t.Errorf("method: %v", ssOB["method"]) }
}
```

- [ ] **Step 2: Run tests, expect PASS**

```
go test -run "TestRender_" ./internal/plugins/singbox/...
```

Expected: PASS (render.go from Task 8 already handles all these cases).

- [ ] **Step 3: Commit**

```bash
git add internal/plugins/singbox/render_test.go
git commit -m "test(plugins/singbox): per-protocol render tests for all 18 families + relay outbounds"
```

---

## Task 10: AssembleAndDeploy — cert push + config push + restart

**Files:**
- Create: `internal/plugins/singbox/deploy_server.go`
- Create: `internal/plugins/singbox/deploy_server_test.go`

- [ ] **Step 1: Write failing tests**

`internal/plugins/singbox/deploy_server_test.go`:

```go
package singbox

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type fakeSBHostExec struct {
	pushed map[string][]byte
	cmds   [][]string
}

func (f *fakeSBHostExec) PushFile(_ context.Context, _ int64, path string, _ uint32, content []byte) error {
	if f.pushed == nil { f.pushed = map[string][]byte{} }
	f.pushed[path] = append([]byte(nil), content...)
	return nil
}
func (f *fakeSBHostExec) RunCmd(_ context.Context, _ int64, name string, args ...string) ([]byte, []byte, int, error) {
	f.cmds = append(f.cmds, append([]string{name}, args...))
	return nil, nil, 0, nil
}
func (f *fakeSBHostExec) StreamCmd(context.Context, int64, string, []string, func(string)) error { return nil }

func newDeployTestDB(t *testing.T) *shepdb.DB {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "dep.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil { t.Fatal(err) }
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil { t.Fatal(err) }
	if err := plugins.RunPluginMigrations(context.Background(), d, "singbox", loadMigrations()); err != nil {
		t.Fatal(err)
	}
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,agent_os,agent_arch,created_at,updated_at)
		VALUES (1,'s1','1.1.1.1','root',22,'linux','amd64',?,?)`, time.Now(), time.Now())
	return d
}

func TestAssembleAndDeploy_NoCerts(t *testing.T) {
	d := newDeployTestDB(t)
	store := &InboundStore{DB: d, Now: time.Now}
	_, _ = store.Insert(context.Background(), Inbound{
		ServerID: 1, Tag: store.GenerateTag("landing"), Port: 443,
		Role: "landing", Protocol: "vless-reality",
		UUID: ptrStr("u"), SNI: ptrStr("www.icloud.com"),
		RealityPublicKey: ptrStr("PUB"), RealityPrivateKey: ptrStr("PRIV"),
		RealityShortID: ptrStr("aa"),
		RealityHandshakeServer: ptrStr("www.icloud.com"), RealityHandshakePort: ptrI64(443),
	})
	exec := &fakeSBHostExec{}
	deps := plugins.Deps{DB: d, HostExec: exec}
	if err := AssembleAndDeploy(context.Background(), deps, 1); err != nil { t.Fatal(err) }
	if _, ok := exec.pushed["/etc/shepherd-singbox/config.json"]; !ok {
		t.Fatalf("config.json not pushed; pushed=%v", keysOf(exec.pushed))
	}
	sawRestart := false
	for _, c := range exec.cmds {
		if len(c) >= 3 && c[0] == "systemctl" && c[1] == "restart" && c[2] == "shepherd-singbox" {
			sawRestart = true
		}
	}
	if !sawRestart { t.Fatalf("no restart; cmds=%v", exec.cmds) }
}

func TestAssembleAndDeploy_WithCert_PushesCertFiles(t *testing.T) {
	d := newDeployTestDB(t)
	cs := &CertStore{DB: d, Now: time.Now}
	certID, _ := cs.Insert(context.Background(), CertRow{
		Domain: "proxy.example.com", CertPEM: "CERT_PEM_DATA", KeyPEM: "KEY_PEM_DATA",
		ExpiresAt: time.Now().Add(90 * 24 * time.Hour), Status: "active",
	})
	store := &InboundStore{DB: d, Now: time.Now}
	_, _ = store.Insert(context.Background(), Inbound{
		ServerID: 1, Tag: store.GenerateTag("landing"), Port: 8443,
		Role: "landing", Protocol: "trojan-tls",
		Password: ptrStr("pass"), SNI: ptrStr("proxy.example.com"), CertID: &certID,
	})
	exec := &fakeSBHostExec{}
	deps := plugins.Deps{DB: d, HostExec: exec}
	if err := AssembleAndDeploy(context.Background(), deps, 1); err != nil { t.Fatal(err) }
	crtPath := "/etc/shepherd-singbox/certs/proxy.example.com.crt"
	keyPath := "/etc/shepherd-singbox/certs/proxy.example.com.key"
	if string(exec.pushed[crtPath]) != "CERT_PEM_DATA" {
		t.Errorf("cert not pushed; keys=%v", keysOf(exec.pushed))
	}
	if string(exec.pushed[keyPath]) != "KEY_PEM_DATA" {
		t.Errorf("key not pushed; keys=%v", keysOf(exec.pushed))
	}
}

func TestAssembleAndDeploy_ZeroInboundsStops(t *testing.T) {
	d := newDeployTestDB(t)
	exec := &fakeSBHostExec{}
	deps := plugins.Deps{DB: d, HostExec: exec}
	if err := AssembleAndDeploy(context.Background(), deps, 1); err != nil { t.Fatal(err) }
	sawStop := false
	for _, c := range exec.cmds {
		if len(c) >= 2 && c[0] == "systemctl" && c[1] == "stop" { sawStop = true }
	}
	if !sawStop { t.Fatalf("expected stop on zero inbounds; cmds=%v", exec.cmds) }
	if _, pushed := exec.pushed["/etc/shepherd-singbox/config.json"]; pushed {
		t.Error("config.json must not be pushed when zero inbounds")
	}
}

func keysOf(m map[string][]byte) []string {
	ks := make([]string, 0, len(m))
	for k := range m { ks = append(ks, k) }
	return ks
}
```

- [ ] **Step 2: Run tests, expect FAIL**

```
go test -run TestAssembleAndDeploy ./internal/plugins/singbox/...
```

Expected: FAIL — `AssembleAndDeploy` undefined.

- [ ] **Step 3: Implement deploy_server.go**

`internal/plugins/singbox/deploy_server.go`:

```go
package singbox

import (
	"context"
	"fmt"

	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/hg-claw/Shepherd/internal/plugins/deploy"
)

const (
	sbConfigRemotePath = "/etc/shepherd-singbox/config.json"
)

// AssembleAndDeploy renders and deploys the sing-box config for serverID.
// If the server has zero singbox inbounds, stops sing-box without pushing config.
func AssembleAndDeploy(ctx context.Context, deps plugins.Deps, serverID int64) error {
	store := &InboundStore{DB: deps.DB}
	allViews, err := store.ListAllWithUpstream(ctx)
	if err != nil {
		return fmt.Errorf("list inbounds: %w", err)
	}
	mine := make([]InboundView, 0)
	for _, v := range allViews {
		if v.ServerID == serverID { mine = append(mine, v) }
	}

	osName, _ := hostOSArch(ctx, deps.DB, serverID)
	unitName := sbUnitNameLinux
	if osName == "darwin" { unitName = sbUnitNameDarwin }
	pusher := &deploy.Pusher{Exec: deps.HostExec}

	if len(mine) == 0 {
		return pusher.Stop(ctx, osName, serverID, unitName)
	}

	// Collect unique cert IDs
	certIDSet := map[int64]bool{}
	for _, v := range mine {
		if v.CertID != nil { certIDSet[*v.CertID] = true }
	}
	certIDs := make([]int64, 0, len(certIDSet))
	for id := range certIDSet { certIDs = append(certIDs, id) }

	cs := &CertStore{DB: deps.DB}
	certViews, err := cs.GetViewsByIDs(ctx, certIDs)
	if err != nil {
		return fmt.Errorf("load certs: %w", err)
	}

	// Push cert files to host
	for _, cv := range certViews {
		crtPath, keyPath := CertFilePath(configDir, cv.Domain)
		if err := deps.HostExec.PushFile(ctx, serverID, crtPath, 0600, []byte(cv.CertPEM)); err != nil {
			return fmt.Errorf("push cert %s: %w", crtPath, err)
		}
		if err := deps.HostExec.PushFile(ctx, serverID, keyPath, 0600, []byte(cv.KeyPEM)); err != nil {
			return fmt.Errorf("push key %s: %w", keyPath, err)
		}
	}

	// Render and push config
	cfgBytes, err := RenderServerConfig(mine, certViews)
	if err != nil {
		return fmt.Errorf("render config: %w", err)
	}
	if err := deps.HostExec.PushFile(ctx, serverID, sbConfigRemotePath, 0600, cfgBytes); err != nil {
		return fmt.Errorf("push config: %w", err)
	}

	// Restart
	if osName == "darwin" {
		_, _, _, _ = deps.HostExec.RunCmd(ctx, serverID, "launchctl", "bootout", "system", sbUnitRemotePathDarwin)
		if _, _, _, err := deps.HostExec.RunCmd(ctx, serverID, "launchctl", "bootstrap", "system", sbUnitRemotePathDarwin); err != nil {
			return fmt.Errorf("launchctl bootstrap: %w", err)
		}
		return nil
	}
	if _, _, _, err := deps.HostExec.RunCmd(ctx, serverID, "systemctl", "restart", unitName); err != nil {
		return fmt.Errorf("systemctl restart %s: %w", unitName, err)
	}
	return nil
}
```

- [ ] **Step 4: Run tests, expect PASS**

```
go test ./internal/plugins/singbox/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/singbox/deploy_server.go internal/plugins/singbox/deploy_server_test.go
git commit -m "feat(plugins/singbox): AssembleAndDeploy pushes certs + config + systemctl restart"
```

---

## Task 11: Plugin lifecycle — DeployToHost + UndeployFromHost + HostStatus + LogStreamCommand

**Files:**
- Modify: `internal/plugins/singbox/singbox.go`
- Create: `internal/plugins/singbox/unit.linux.service`
- Create: `internal/plugins/singbox/unit.darwin.plist`
- Create: `internal/plugins/singbox/singbox_host_test.go`

- [ ] **Step 1: Write failing tests**

`internal/plugins/singbox/singbox_host_test.go`:

```go
package singbox

import (
	"context"
	"testing"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

type activeHostExec struct{ *fakeSBHostExec }

func (a *activeHostExec) RunCmd(_ context.Context, _ int64, name string, args ...string) ([]byte, []byte, int, error) {
	a.cmds = append(a.cmds, append([]string{name}, args...))
	return []byte("active\n"), nil, 0, nil
}

func TestPlugin_HostStatus_Running(t *testing.T) {
	d := newDeployTestDB(t)
	exec := &fakeSBHostExec{}
	p := New()
	deps := plugins.Deps{DB: d, HostExec: &activeHostExec{fakeSBHostExec: exec}}
	status, err := p.HostStatus(context.Background(), deps, 1)
	if err != nil { t.Fatal(err) }
	if status.State != "running" { t.Errorf("expected running, got %s", status.State) }
}

func TestPlugin_UndeployFromHost_Stop(t *testing.T) {
	d := newDeployTestDB(t)
	exec := &fakeSBHostExec{}
	p := New()
	deps := plugins.Deps{DB: d, HostExec: exec}
	if err := p.UndeployFromHost(context.Background(), deps, 1); err != nil { t.Fatal(err) }
	sawStop := false
	for _, c := range exec.cmds {
		if len(c) >= 2 && c[0] == "systemctl" && c[1] == "stop" { sawStop = true }
	}
	if !sawStop { t.Fatalf("expected stop; cmds=%v", exec.cmds) }
}

func TestPlugin_LogStreamCommand_Linux(t *testing.T) {
	d := newDeployTestDB(t)
	d.MustExec(`UPDATE servers SET agent_os='linux' WHERE id=1`)
	p := New()
	deps := plugins.Deps{DB: d, HostExec: &fakeSBHostExec{}}
	name, args, err := p.LogStreamCommand(context.Background(), deps, 1)
	if err != nil { t.Fatal(err) }
	if name != "journalctl" { t.Errorf("expected journalctl, got %s", name) }
	found := false
	for _, a := range args { if a == "shepherd-singbox" { found = true } }
	if !found { t.Errorf("shepherd-singbox not in args: %v", args) }
}
```

- [ ] **Step 2: Run tests, expect FAIL**

```
go test -run "TestPlugin_" ./internal/plugins/singbox/...
```

Expected: FAIL — HostStatus/UndeployFromHost/LogStreamCommand not implemented.

- [ ] **Step 3: Create unit embed files**

`internal/plugins/singbox/unit.linux.service`:

```ini
[Unit]
Description=Shepherd-managed sing-box proxy
After=network.target
Wants=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/shepherd-singbox run -c /etc/shepherd-singbox/config.json
Restart=on-failure
RestartSec=3s
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

`internal/plugins/singbox/unit.darwin.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>com.shepherd.singbox</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/shepherd-singbox</string>
    <string>run</string>
    <string>-c</string>
    <string>/etc/shepherd-singbox/config.json</string>
  </array>
  <key>RunAtLoad</key>      <true/>
  <key>KeepAlive</key>      <true/>
  <key>StandardOutPath</key>  <string>/var/log/shepherd-singbox.out.log</string>
  <key>StandardErrorPath</key><string>/var/log/shepherd-singbox.err.log</string>
</dict>
</plist>
```

- [ ] **Step 4: Replace singbox.go with full HostAware implementation**

Replace the stub `singbox.go` with the full version (constants + embed + HostAware methods):

```go
package singbox

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

//go:embed unit.linux.service
var unitLinux []byte

//go:embed unit.darwin.plist
var unitDarwin []byte

const (
	sbBinaryRemotePath     = "/usr/local/bin/shepherd-singbox"
	sbUnitRemotePathLinux  = "/etc/systemd/system/shepherd-singbox.service"
	sbUnitRemotePathDarwin = "/Library/LaunchDaemons/com.shepherd.singbox.plist"
	sbUnitNameLinux        = "shepherd-singbox"
	sbUnitNameDarwin       = "com.shepherd.singbox"
)

type releaserIface interface {
	Fetch(ctx context.Context, version, osName, arch string) (Binary, error)
}

// Plugin implements plugins.Plugin, plugins.HostAware, and plugins.LogStreamer.
type Plugin struct{ releaser releaserIface }

func New() *Plugin { return &Plugin{} }

func init() { plugins.Register(New()) }

func (p *Plugin) Meta() plugins.Meta              { return meta() }
func (p *Plugin) Migrations() []plugins.Migration { return loadMigrations() }
func (p *Plugin) OnEnable(_ context.Context, _ plugins.Deps) error  { return nil }
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }
func (p *Plugin) RegisterRoutes(mux plugins.Mux, deps plugins.Deps) { registerRoutes(mux, deps) }

func (p *Plugin) DeployToHost(ctx context.Context, deps plugins.Deps, serverID int64, version string, _ []byte) error {
	if version == "" { return fmt.Errorf("version required") }
	osName, arch := hostOSArch(ctx, deps.DB, serverID)
	r := p.releaser
	if r == nil { r = &Releaser{CacheDir: deps.DataDir + "/cache"} }
	bin, err := r.Fetch(ctx, version, osName, arch)
	if err != nil { return fmt.Errorf("fetch binary: %w", err) }
	binBytes, err := os.ReadFile(bin.Path)
	if err != nil { return fmt.Errorf("read binary: %w", err) }

	unitBytes, unitPath, unitName := unitLinux, sbUnitRemotePathLinux, sbUnitNameLinux
	if osName == "darwin" { unitBytes, unitPath, unitName = unitDarwin, sbUnitRemotePathDarwin, sbUnitNameDarwin }

	pusher := &deploy.Pusher{Exec: deps.HostExec}
	if err := pusher.DeployService(ctx, deploy.DeployParams{
		OS: osName, ServerID: serverID,
		BinaryPath: sbBinaryRemotePath, BinaryBytes: binBytes,
		ConfigPath: sbConfigRemotePath, ConfigBytes: []byte("{}"),
		UnitPath: unitPath, UnitBytes: unitBytes, UnitName: unitName,
	}); err != nil {
		return err
	}
	return AssembleAndDeploy(ctx, deps, serverID)
}

func (p *Plugin) UndeployFromHost(ctx context.Context, deps plugins.Deps, serverID int64) error {
	osName, _ := hostOSArch(ctx, deps.DB, serverID)
	unitName := sbUnitNameLinux
	if osName == "darwin" { unitName = sbUnitNameDarwin }
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	if err := pusher.Stop(ctx, osName, serverID, unitName); err != nil { return err }
	_, _ = deps.DB.ExecContext(ctx, `DELETE FROM singbox_inbounds WHERE server_id=?`, serverID)
	return nil
}

func (p *Plugin) HostStatus(ctx context.Context, deps plugins.Deps, serverID int64) (plugins.HostStatus, error) {
	osName, _ := hostOSArch(ctx, deps.DB, serverID)
	unitName := sbUnitNameLinux
	if osName == "darwin" { unitName = sbUnitNameDarwin }
	pusher := &deploy.Pusher{Exec: deps.HostExec}
	active, _ := pusher.IsActive(ctx, osName, serverID, unitName)
	state := "stopped"
	if active { state = "running" }
	return plugins.HostStatus{State: state}, nil
}

func (p *Plugin) LogStreamCommand(ctx context.Context, deps plugins.Deps, serverID int64) (string, []string, error) {
	osName, _ := hostOSArch(ctx, deps.DB, serverID)
	if osName == "darwin" {
		return "tail", []string{"-F", "-n", "200",
			"/var/log/shepherd-singbox.out.log", "/var/log/shepherd-singbox.err.log"}, nil
	}
	return "journalctl", []string{"-u", "shepherd-singbox", "-f", "--no-pager", "-n", "200", "-o", "short-iso"}, nil
}

func hostOSArch(ctx context.Context, db *sqlx.DB, serverID int64) (string, string) {
	var osName, arch sql.NullString
	_ = db.QueryRowxContext(ctx, "SELECT agent_os, agent_arch FROM servers WHERE id=?", serverID).
		Scan(&osName, &arch)
	o, a := "linux", "amd64"
	if osName.Valid && osName.String != "" { o = osName.String }
	if arch.Valid && arch.String != ""   { a = arch.String }
	return o, a
}
```

- [ ] **Step 5: Run tests, expect PASS**

```
go test ./internal/plugins/singbox/...
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/singbox/singbox.go \
        internal/plugins/singbox/unit.linux.service \
        internal/plugins/singbox/unit.darwin.plist \
        internal/plugins/singbox/singbox_host_test.go
git commit -m "feat(plugins/singbox): HostAware lifecycle (DeployToHost/Undeploy/HostStatus/LogStream)"
```

---

## Task 12: /inbounds CRUD routes + validation

**Files:**
- Create: `internal/plugins/singbox/inbounds_routes.go`
- Create: `internal/plugins/singbox/inbounds_routes_test.go`
- Create: `internal/plugins/singbox/routes.go`

- [ ] **Step 1: Write failing tests**

`internal/plugins/singbox/inbounds_routes_test.go`:

```go
package singbox

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

func newRouteDeps(t *testing.T) plugins.Deps {
	t.Helper()
	d := newDeployTestDB(t)
	return plugins.Deps{DB: d, HostExec: &fakeSBHostExec{}}
}

func postJSON(t *testing.T, handler http.HandlerFunc, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/inbounds", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler(rr, req)
	return rr
}

func TestRoute_CreateLanding(t *testing.T) {
	deps := newRouteDeps(t)
	rr := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 443, "role": "landing", "protocol": "vless-reality",
		"uuid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		"reality_private_key": "PRIV", "reality_public_key": "PUB",
		"reality_short_id": "aabb1122",
		"reality_handshake_server": "www.icloud.com", "reality_handshake_port": 443,
		"sni": "www.icloud.com",
	})
	if rr.Code != 201 { t.Fatalf("want 201, got %d: %s", rr.Code, rr.Body) }
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["tag"] == nil || resp["tag"] == "" { t.Errorf("tag missing: %v", resp) }
}

func TestRoute_RejectsPortConflict(t *testing.T) {
	deps := newRouteDeps(t)
	h := postInboundHandler(deps)
	_ = postJSON(t, h, map[string]any{"server_id": 1, "port": 443, "role": "landing", "protocol": "vmess-tcp", "uuid": "uuid1"})
	rr := postJSON(t, h, map[string]any{"server_id": 1, "port": 443, "role": "landing", "protocol": "vmess-tcp", "uuid": "uuid2"})
	if rr.Code != 409 { t.Fatalf("want 409, got %d: %s", rr.Code, rr.Body) }
}

func TestRoute_RejectsClashAPIPort(t *testing.T) {
	deps := newRouteDeps(t)
	rr := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 29090, "role": "landing", "protocol": "vmess-tcp", "uuid": "uuid3",
	})
	if rr.Code != 409 { t.Fatalf("want 409, got %d: %s", rr.Code, rr.Body) }
}

func TestRoute_RejectsRelayWithoutUpstream(t *testing.T) {
	deps := newRouteDeps(t)
	rr := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 8443, "role": "relay", "protocol": "vmess-tcp", "uuid": "uuid4",
	})
	if rr.Code != 409 { t.Fatalf("want 409, got %d: %s", rr.Code, rr.Body) }
}

func TestRoute_RejectsRelayPointingAtRelay(t *testing.T) {
	deps := newRouteDeps(t)
	h := postInboundHandler(deps)
	r1 := postJSON(t, h, map[string]any{"server_id": 1, "port": 443, "role": "landing", "protocol": "vmess-tcp", "uuid": "uuidL"})
	if r1.Code != 201 { t.Fatalf("landing: %d %s", r1.Code, r1.Body) }
	var land map[string]any; _ = json.NewDecoder(r1.Body).Decode(&land)
	landID := int64(land["id"].(float64))

	deps.DB.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at,updated_at)
		VALUES (2,'s2','2.2.2.2','root',22,?,?)`, time.Now(), time.Now())
	r2 := postJSON(t, h, map[string]any{
		"server_id": 2, "port": 8443, "role": "relay", "protocol": "vmess-tcp",
		"uuid": "uuidR1", "upstream_inbound_id": landID,
	})
	if r2.Code != 201 { t.Fatalf("relay1: %d %s", r2.Code, r2.Body) }
	var relay1 map[string]any; _ = json.NewDecoder(r2.Body).Decode(&relay1)
	relay1ID := int64(relay1["id"].(float64))

	deps.DB.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at,updated_at)
		VALUES (3,'s3','3.3.3.3','root',22,?,?)`, time.Now(), time.Now())
	r3 := postJSON(t, h, map[string]any{
		"server_id": 3, "port": 9443, "role": "relay", "protocol": "vmess-tcp",
		"uuid": "uuidR2", "upstream_inbound_id": relay1ID,
	})
	if r3.Code != 409 { t.Fatalf("relay→relay must be 409, got %d: %s", r3.Code, r3.Body) }
}

func TestRoute_GetByServer(t *testing.T) {
	deps := newRouteDeps(t)
	_ = postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 443, "role": "landing", "protocol": "vmess-tcp", "uuid": "uuidG",
	})
	req := httptest.NewRequest("GET", "/inbounds?server_id=1", nil)
	rr := httptest.NewRecorder()
	getInboundsHandler(deps)(rr, req)
	if rr.Code != 200 { t.Fatalf("get: %d %s", rr.Code, rr.Body) }
	var resp []any; _ = json.NewDecoder(rr.Body).Decode(&resp)
	if len(resp) != 1 { t.Fatalf("want 1 inbound, got %d", len(resp)) }
}

func TestRoute_PatchImmutables(t *testing.T) {
	deps := newRouteDeps(t)
	r := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 443, "role": "landing", "protocol": "vmess-tcp", "uuid": "uuidP",
	})
	var created map[string]any; _ = json.NewDecoder(r.Body).Decode(&created)
	id := int64(created["id"].(float64))

	b, _ := json.Marshal(map[string]any{"port": 9443, "role": "relay"})
	req := httptest.NewRequest("PATCH", "/inbounds/"+fmt.Sprint(id), bytes.NewReader(b))
	req.SetPathValue("id", fmt.Sprint(id))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	patchInboundHandler(deps)(rr, req)
	if rr.Code != 200 { t.Fatalf("patch: %d %s", rr.Code, rr.Body) }
	var updated map[string]any; _ = json.NewDecoder(rr.Body).Decode(&updated)
	if updated["port"].(float64) != 9443 { t.Errorf("port not updated: %v", updated["port"]) }
	if updated["role"] != "landing" { t.Errorf("role mutated: %v", updated["role"]) }
}

func TestRoute_DeleteWithDependents(t *testing.T) {
	deps := newRouteDeps(t)
	h := postInboundHandler(deps)
	r := postJSON(t, h, map[string]any{"server_id": 1, "port": 443, "role": "landing", "protocol": "vmess-tcp", "uuid": "uuidD"})
	var land map[string]any; _ = json.NewDecoder(r.Body).Decode(&land)
	landID := int64(land["id"].(float64))

	deps.DB.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at,updated_at)
		VALUES (2,'s2','2.2.2.2','root',22,?,?)`, time.Now(), time.Now())
	_ = postJSON(t, h, map[string]any{
		"server_id": 2, "port": 8443, "role": "relay", "protocol": "vmess-tcp",
		"uuid": "uuidDR", "upstream_inbound_id": landID,
	})
	req := httptest.NewRequest("DELETE", "/inbounds/"+fmt.Sprint(landID), nil)
	req.SetPathValue("id", fmt.Sprint(landID))
	rr := httptest.NewRecorder()
	deleteInboundHandler(deps)(rr, req)
	if rr.Code != 409 { t.Fatalf("want 409, got %d: %s", rr.Code, rr.Body) }
}
```

- [ ] **Step 2: Run tests, expect FAIL**

```
go test -run TestRoute_ ./internal/plugins/singbox/...
```

Expected: FAIL — handlers undefined.

- [ ] **Step 3: Implement inbounds_routes.go + routes.go**

`internal/plugins/singbox/inbounds_routes.go`:

```go
package singbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

const clashAPIPort = 29090

func isValidProtocol(p string) bool {
	for _, v := range []string{
		"vless-reality", "vless-ws-tls", "vless-h2-tls", "vless-httpupgrade-tls",
		"vmess-tcp", "vmess-http", "vmess-quic", "vmess-ws-tls", "vmess-h2-tls", "vmess-httpupgrade-tls",
		"trojan-tls", "trojan-ws-tls", "trojan-h2-tls", "trojan-httpupgrade-tls",
		"hysteria2", "tuic-v5", "anytls", "shadowsocks-2022",
	} {
		if p == v { return true }
	}
	return false
}

type postInboundBody struct {
	ServerID               int64   `json:"server_id"`
	Port                   int     `json:"port"`
	Role                   string  `json:"role"`
	Protocol               string  `json:"protocol"`
	UUID                   *string `json:"uuid"`
	Flow                   *string `json:"flow"`
	Password               *string `json:"password"`
	SNI                    *string `json:"sni"`
	CertID                 *int64  `json:"cert_id"`
	RealityPrivateKey      *string `json:"reality_private_key"`
	RealityPublicKey       *string `json:"reality_public_key"`
	RealityShortID         *string `json:"reality_short_id"`
	RealityHandshakeServer *string `json:"reality_handshake_server"`
	RealityHandshakePort   *int64  `json:"reality_handshake_port"`
	TransportPath          *string `json:"transport_path"`
	TransportHost          *string `json:"transport_host"`
	AlterID                *int64  `json:"alter_id"`
	SSMethod               *string `json:"ss_method"`
	Extra                  *string `json:"extra"`
	UpstreamInboundID      *int64  `json:"upstream_inbound_id"`
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}
func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func validatePostInbound(ctx context.Context, store *InboundStore, body postInboundBody) error {
	if body.ServerID == 0 { return errors.New("server_id required") }
	if body.Port <= 0 || body.Port > 65535 { return errors.New("port out of range") }
	if body.Port == clashAPIPort {
		return fmt.Errorf("port %d is reserved for the sing-box clash-api", clashAPIPort)
	}
	if body.Role != "landing" && body.Role != "relay" {
		return fmt.Errorf("role must be landing or relay, got %q", body.Role)
	}
	if !isValidProtocol(body.Protocol) {
		return fmt.Errorf("unknown protocol %q", body.Protocol)
	}
	existing, _ := store.ListByServer(ctx, body.ServerID)
	for _, e := range existing {
		if e.Port == body.Port {
			return fmt.Errorf("server %d already has inbound on port %d (tag=%s)", body.ServerID, body.Port, e.Tag)
		}
	}
	if body.Role == "relay" {
		if body.UpstreamInboundID == nil {
			return errors.New("upstream_inbound_id required when role=relay")
		}
		upstream, err := store.GetByID(ctx, *body.UpstreamInboundID)
		if err != nil {
			return fmt.Errorf("upstream inbound %d not found", *body.UpstreamInboundID)
		}
		if upstream.Role != "landing" {
			return fmt.Errorf("upstream inbound %d is not a landing (role=%s)", upstream.ID, upstream.Role)
		}
	}
	return nil
}

func inboundToMap(v InboundView) map[string]any {
	m := map[string]any{
		"id": v.ID, "server_id": v.ServerID, "server_name": v.ServerName,
		"tag": v.Tag, "port": v.Port, "role": v.Role, "protocol": v.Protocol,
		"uuid": v.UUID, "flow": v.Flow, "password": v.Password, "sni": v.SNI,
		"cert_id":                  v.CertID,
		"reality_private_key":      "[REDACTED]",
		"reality_public_key":       v.RealityPublicKey,
		"reality_short_id":         v.RealityShortID,
		"reality_handshake_server": v.RealityHandshakeServer,
		"reality_handshake_port":   v.RealityHandshakePort,
		"transport_path":           v.TransportPath,
		"transport_host":           v.TransportHost,
		"alter_id":                 v.AlterID,
		"ss_method":                v.SSMethod,
		"upstream_inbound_id":      v.UpstreamInboundID,
		"created_at": v.CreatedAt, "updated_at": v.UpdatedAt,
	}
	if v.UpstreamTag.Valid        { m["upstream_tag"] = v.UpstreamTag.String }
	if v.UpstreamServerID.Valid   { m["upstream_server_id"] = v.UpstreamServerID.Int64 }
	if v.UpstreamServerName.Valid { m["upstream_server_name"] = v.UpstreamServerName.String }
	return m
}

func postInboundHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body postInboundBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, 400, "bad json"); return
		}
		store := &InboundStore{DB: deps.DB}
		if err := validatePostInbound(r.Context(), store, body); err != nil {
			writeErr(w, 409, err.Error()); return
		}
		in := Inbound{
			ServerID: body.ServerID, Tag: store.GenerateTag(body.Role),
			Port: body.Port, Role: body.Role, Protocol: body.Protocol,
			UUID: body.UUID, Flow: body.Flow, Password: body.Password,
			SNI: body.SNI, CertID: body.CertID,
			RealityPrivateKey: body.RealityPrivateKey, RealityPublicKey: body.RealityPublicKey,
			RealityShortID: body.RealityShortID,
			RealityHandshakeServer: body.RealityHandshakeServer,
			RealityHandshakePort:   body.RealityHandshakePort,
			TransportPath: body.TransportPath, TransportHost: body.TransportHost,
			AlterID: body.AlterID, SSMethod: body.SSMethod,
			ExtraJSON: body.Extra, UpstreamInboundID: body.UpstreamInboundID,
		}
		id, err := store.Insert(r.Context(), in)
		if err != nil { writeErr(w, 500, err.Error()); return }
		go func() { _ = AssembleAndDeploy(context.Background(), deps, body.ServerID) }()
		views, _ := store.ListAllWithUpstream(r.Context())
		for _, v := range views {
			if v.ID == id { writeJSON(w, 201, inboundToMap(v)); return }
		}
		writeErr(w, 500, "inserted but not findable")
	}
}

func getInboundsHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		store := &InboundStore{DB: deps.DB}
		views, err := store.ListAllWithUpstream(r.Context())
		if err != nil { writeErr(w, 500, err.Error()); return }
		filter := r.URL.Query().Get("server_id")
		out := []map[string]any{}
		for _, v := range views {
			if filter != "" {
				want, _ := strconv.ParseInt(filter, 10, 64)
				if v.ServerID != want { continue }
			}
			out = append(out, inboundToMap(v))
		}
		writeJSON(w, 200, out)
	}
}

func patchInboundHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if id == 0 { writeErr(w, 400, "id required"); return }
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, 400, "bad json"); return
		}
		patch := InboundPatch{}
		if v, ok := body["port"].(float64)             { p := int(v); patch.Port = &p }
		if v, ok := body["uuid"].(string)              { patch.UUID = &v }
		if v, ok := body["flow"].(string)              { patch.Flow = &v }
		if v, ok := body["password"].(string)          { patch.Password = &v }
		if v, ok := body["sni"].(string)               { patch.SNI = &v }
		if v, ok := body["reality_public_key"].(string){ patch.RealityPublicKey = &v }
		if v, ok := body["reality_short_id"].(string)  { patch.RealityShortID = &v }
		if v, ok := body["transport_path"].(string)    { patch.TransportPath = &v }
		if v, ok := body["transport_host"].(string)    { patch.TransportHost = &v }
		if v, ok := body["ss_method"].(string)         { patch.SSMethod = &v }
		if v, ok := body["extra"].(string)             { patch.ExtraJSON = &v }
		if v, ok := body["reality_private_key"].(string); ok && v != "[REDACTED]" {
			patch.RealityPrivateKey = &v
		}
		store := &InboundStore{DB: deps.DB}
		row, err := store.GetByID(r.Context(), id)
		if err != nil { writeErr(w, 404, "inbound not found"); return }
		if patch.Port != nil && *patch.Port != row.Port {
			if *patch.Port == clashAPIPort {
				writeErr(w, 409, fmt.Sprintf("port %d reserved for clash-api", clashAPIPort)); return
			}
			others, _ := store.ListByServer(r.Context(), row.ServerID)
			for _, o := range others {
				if o.ID != id && o.Port == *patch.Port {
					writeErr(w, 409, fmt.Sprintf("port %d in use by %s", *patch.Port, o.Tag)); return
				}
			}
		}
		if err := store.Update(r.Context(), id, patch); err != nil {
			writeErr(w, 500, err.Error()); return
		}
		go func() { _ = AssembleAndDeploy(context.Background(), deps, row.ServerID) }()
		views, _ := store.ListAllWithUpstream(r.Context())
		for _, v := range views {
			if v.ID == id { writeJSON(w, 200, inboundToMap(v)); return }
		}
		writeErr(w, 500, "updated but not findable")
	}
}

func deleteInboundHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if id == 0 { writeErr(w, 400, "id required"); return }
		store := &InboundStore{DB: deps.DB}
		row, err := store.GetByID(r.Context(), id)
		if err != nil { writeErr(w, 404, "inbound not found"); return }
		if row.Role == "landing" {
			relays, _ := store.ListByUpstream(r.Context(), id)
			if len(relays) > 0 {
				ids := make([]int64, len(relays))
				for i, rel := range relays { ids[i] = rel.ID }
				writeJSON(w, 409, map[string]any{
					"error": fmt.Sprintf("landing inbound %s has %d relay(s) depending on it",
						row.Tag, len(relays)),
					"relay_inbound_ids": ids,
				}); return
			}
		}
		if err := store.Delete(r.Context(), id); err != nil {
			writeErr(w, 500, err.Error()); return
		}
		go func() { _ = AssembleAndDeploy(context.Background(), deps, row.ServerID) }()
		w.WriteHeader(204)
	}
}
```

`internal/plugins/singbox/routes.go`:

```go
package singbox

import "github.com/hg-claw/Shepherd/internal/plugins"

func registerRoutes(mux plugins.Mux, deps plugins.Deps) {
	mux.HandleFunc("POST /inbounds",        postInboundHandler(deps))
	mux.HandleFunc("GET /inbounds",         getInboundsHandler(deps))
	mux.HandleFunc("PATCH /inbounds/{id}",  patchInboundHandler(deps))
	mux.HandleFunc("DELETE /inbounds/{id}", deleteInboundHandler(deps))
}
```

- [ ] **Step 4: Run tests, expect PASS**

```
go test ./internal/plugins/singbox/...
```

Expected: PASS for all 8 route tests.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/singbox/inbounds_routes.go \
        internal/plugins/singbox/inbounds_routes_test.go \
        internal/plugins/singbox/routes.go
git commit -m "feat(plugins/singbox): /inbounds CRUD routes with port-conflict + clash-api + relay-chain validation"
```

---

## Task 13 — Versions, server-version PATCH, and certificate API routes

**Goal:** Add the remaining HTTP routes: `GET /versions` (cached binary list + GitHub latest tags), `PATCH /servers/{id}` (trigger async re-deploy with a new sing-box binary version), and the certificate lifecycle routes (`POST /certificates`, `GET /certificates`, `DELETE /certificates/{id}`, `POST /certificates/{id}/renew`). Wire all of these into `registerRoutes`.

**Files touched:**

```
internal/plugins/singbox/release.go          (already written in Task 5)
internal/plugins/singbox/certstore.go        (already written in Task 6)
internal/plugins/singbox/routes.go           (extend — add new HandleFunc calls)
internal/plugins/singbox/cert_routes.go      (new)
internal/plugins/singbox/cert_routes_test.go (new)
internal/plugins/singbox/routes_test.go      (extend — add version + server-PATCH tests)
```

---

- [ ] **Step 1: Write failing tests**

Create `internal/plugins/singbox/cert_routes_test.go`:

```go
package singbox_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/hg-claw/Shepherd/internal/plugins/singbox"
)

// fakeMgr implements the certIssuer interface used by cert_routes.go.
type fakeMgr struct {
	IssueErr  error
	RenewErr  error
	IssuedIDs []int64
}

func (f *fakeMgr) Issue(ctx context.Context, certID int64, domain, challenge, email string) error {
	f.IssuedIDs = append(f.IssuedIDs, certID)
	return f.IssueErr
}

func (f *fakeMgr) Renew(ctx context.Context, certID int64) error {
	return f.RenewErr
}

// setupCertDB returns a DB with migrations 0001+0004 applied (inbounds + certs).
func setupCertDB(t *testing.T) *sqlx.DB {
	t.Helper()
	db := singbox.OpenTestDB(t)
	migs := singbox.ExportedMigrations()
	applyMigration(t, db, migs[0]) // 0001_singbox_inbounds
	applyMigration(t, db, migs[3]) // 0004_singbox_certificates
	mustExec(t, db, `INSERT INTO servers(id,name,ip,agent_os,agent_arch) VALUES (1,'s1','1.2.3.4','linux','amd64')`)
	return db
}

func TestPostCertificate_202(t *testing.T) {
	db := setupCertDB(t)
	mgr := &fakeMgr{}
	deps := plugins.Deps{DB: db}
	h := singbox.NewCertHandler(deps, mgr, "test@example.com")

	body, _ := json.Marshal(map[string]string{"domain": "proxy.example.com", "challenge": "http-01"})
	req := httptest.NewRequest("POST", "/certificates", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Fatalf("want 202, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if resp["status"] != "issuing" {
		t.Errorf("want status=issuing, got %v", resp["status"])
	}
	if resp["domain"] != "proxy.example.com" {
		t.Errorf("want domain=proxy.example.com, got %v", resp["domain"])
	}
}

func TestPostCertificate_400_MissingDomain(t *testing.T) {
	db := setupCertDB(t)
	mgr := &fakeMgr{}
	deps := plugins.Deps{DB: db}
	h := singbox.NewCertHandler(deps, mgr, "test@example.com")

	body, _ := json.Marshal(map[string]string{"challenge": "http-01"})
	req := httptest.NewRequest("POST", "/certificates", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", w.Code)
	}
}

func TestPostCertificate_400_BadChallenge(t *testing.T) {
	db := setupCertDB(t)
	mgr := &fakeMgr{}
	deps := plugins.Deps{DB: db}
	h := singbox.NewCertHandler(deps, mgr, "test@example.com")

	body, _ := json.Marshal(map[string]string{"domain": "proxy.example.com", "challenge": "invalid"})
	req := httptest.NewRequest("POST", "/certificates", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", w.Code)
	}
}

func TestGetCertificates_200(t *testing.T) {
	db := setupCertDB(t)
	mgr := &fakeMgr{}
	deps := plugins.Deps{DB: db}
	h := singbox.NewCertHandler(deps, mgr, "test@example.com")

	// Seed a cert row.
	mustExec(t, db, `INSERT INTO singbox_certificates(domain,status,issuer) VALUES ('proxy.example.com','active','Let''s Encrypt')`)

	req := httptest.NewRequest("GET", "/certificates", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", w.Code)
	}
	var certs []map[string]any
	_ = json.NewDecoder(w.Body).Decode(&certs)
	if len(certs) != 1 {
		t.Fatalf("want 1 cert, got %d", len(certs))
	}
	if certs[0]["domain"] != "proxy.example.com" {
		t.Errorf("want domain=proxy.example.com, got %v", certs[0]["domain"])
	}
	// cert_pem / key_pem must NOT be in the response.
	if _, ok := certs[0]["cert_pem"]; ok {
		t.Error("cert_pem must not be exposed in GET /certificates")
	}
}

func TestDeleteCertificate_204(t *testing.T) {
	db := setupCertDB(t)
	mgr := &fakeMgr{}
	deps := plugins.Deps{DB: db}
	h := singbox.NewCertHandler(deps, mgr, "test@example.com")

	mustExec(t, db, `INSERT INTO singbox_certificates(id,domain,status,issuer) VALUES (10,'proxy.example.com','active','Let''s Encrypt')`)

	req := httptest.NewRequest("DELETE", "/certificates/10", nil)
	req.SetPathValue("id", "10")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("want 204, got %d: %s", w.Code, w.Body.String())
	}
}

func TestDeleteCertificate_409_InUse(t *testing.T) {
	db := setupCertDB(t)
	mgr := &fakeMgr{}
	deps := plugins.Deps{DB: db}
	h := singbox.NewCertHandler(deps, mgr, "test@example.com")

	mustExec(t, db, `INSERT INTO singbox_certificates(id,domain,status,issuer,cert_pem,key_pem) VALUES (10,'p.example.com','active','LE','CERT','KEY')`)
	mustExec(t, db, `INSERT INTO singbox_inbounds(server_id,tag,port,role,protocol,cert_id) VALUES (1,'landing-aa000001',443,'landing','vless-ws-tls',10)`)

	req := httptest.NewRequest("DELETE", "/certificates/10", nil)
	req.SetPathValue("id", "10")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusConflict {
		t.Fatalf("want 409, got %d: %s", w.Code, w.Body.String())
	}
}

func TestRenewCertificate_202(t *testing.T) {
	db := setupCertDB(t)
	mgr := &fakeMgr{}
	deps := plugins.Deps{DB: db}
	h := singbox.NewCertHandler(deps, mgr, "test@example.com")

	mustExec(t, db, `INSERT INTO singbox_certificates(id,domain,status,issuer) VALUES (7,'proxy.example.com','active','LE')`)

	req := httptest.NewRequest("POST", "/certificates/7/renew", nil)
	req.SetPathValue("id", "7")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusAccepted {
		t.Fatalf("want 202, got %d: %s", w.Code, w.Body.String())
	}
}
```

Add to `internal/plugins/singbox/routes_test.go`:

```go
func TestGetVersions_200(t *testing.T) {
	db := openSingboxTestDB(t)
	applyMigration(t, db, ExportedMigrations()[1]) // 0002_singbox_binaries
	deps := plugins.Deps{DB: db}

	// Inject fake latest fetcher so no real GitHub call happens.
	origFetcher := singbox.LatestFetcher
	singbox.LatestFetcher = func(ctx context.Context) ([]string, error) {
		return []string{"1.11.5", "1.11.4"}, nil
	}
	defer func() { singbox.LatestFetcher = origFetcher }()

	mux := http.NewServeMux()
	p := singbox.New()
	p.RegisterRoutes(adaptMux(mux), deps)
	req := httptest.NewRequest("GET", "/versions", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(w.Body).Decode(&resp)
	if _, ok := resp["cached"]; !ok {
		t.Error("response missing 'cached' key")
	}
	if _, ok := resp["latest"]; !ok {
		t.Error("response missing 'latest' key")
	}
}

func TestPatchServerVersion_200(t *testing.T) {
	db := openSingboxTestDB(t)
	applyMigrations(t, db, ExportedMigrations()[:2]...) // 0001 + 0002
	mustExec(t, db, `INSERT INTO servers(id,name,ip) VALUES (1,'s1','1.2.3.4')`)
	mustExec(t, db, `CREATE TABLE IF NOT EXISTS plugin_hosts(plugin_id TEXT, server_id INTEGER, config_json TEXT, deployed_version TEXT, status TEXT, last_error TEXT, updated_at TIMESTAMP, PRIMARY KEY(plugin_id,server_id))`)

	fakeExec := &fakeSBHostExec{}
	deps := plugins.Deps{DB: db, HostExec: fakeExec, DataDir: t.TempDir()}
	p := singbox.NewWithFakeReleaser(&fakeSBReleaser{})

	mux := http.NewServeMux()
	p.RegisterRoutes(adaptMux(mux), deps)

	body, _ := json.Marshal(map[string]string{"version": "1.11.5"})
	req := httptest.NewRequest("PATCH", "/servers/1", bytes.NewReader(body))
	req.SetPathValue("id", "1")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
}
```

- [ ] **Step 2: Run tests, expect FAIL**

```
go test ./internal/plugins/singbox/... -run "TestPostCertificate|TestGetCertificates|TestDeleteCertificate|TestRenewCertificate|TestGetVersions|TestPatchServerVersion"
```

Expected: compile errors (missing `NewCertHandler`, `LatestFetcher`, cert route handlers).

---

- [ ] **Step 3: Implement**

Create `internal/plugins/singbox/cert_routes.go`:

```go
package singbox

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

// certIssuer is the subset of certmgr.Manager used by cert_routes.
// Tests inject a fake; production code injects *certmgr.Manager.
type certIssuer interface {
	Issue(ctx context.Context, certID int64, domain, challenge, email string) error
	Renew(ctx context.Context, certID int64) error
}

// CertHandler is an http.Handler that dispatches cert API routes.
// Route method+path is inspected at ServeHTTP time because the mux has already
// stripped the plugin prefix; the caller registers each sub-route individually
// (see registerRoutes).
type CertHandler struct {
	deps  plugins.Deps
	mgr   certIssuer
	email string
}

// NewCertHandler constructs a CertHandler. email is the ACME account email.
func NewCertHandler(deps plugins.Deps, mgr certIssuer, email string) *CertHandler {
	return &CertHandler{deps: deps, mgr: mgr, email: email}
}

func (h *CertHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Dispatch by method + path suffix.
	switch {
	case r.Method == "POST" && r.PathValue("id") == "" && !hasSuffix(r.URL.Path, "/renew"):
		h.postCert(w, r)
	case r.Method == "GET":
		h.listCerts(w, r)
	case r.Method == "DELETE":
		h.deleteCert(w, r)
	case r.Method == "POST" && hasSuffix(r.URL.Path, "/renew"):
		h.renewCert(w, r)
	default:
		http.NotFound(w, r)
	}
}

func hasSuffix(path, suffix string) bool {
	n := len(path) - len(suffix)
	return n >= 0 && path[n:] == suffix
}

// postCertBody is the request body for POST /certificates.
type postCertBody struct {
	Domain    string `json:"domain"`
	Challenge string `json:"challenge"`
}

func (h *CertHandler) postCert(w http.ResponseWriter, r *http.Request) {
	var body postCertBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeRouteError(w, 400, "bad json")
		return
	}
	if body.Domain == "" {
		writeRouteError(w, 400, "domain required")
		return
	}
	if body.Challenge != "dns-01-cf" && body.Challenge != "http-01" {
		writeRouteError(w, 400, "challenge must be 'dns-01-cf' or 'http-01'")
		return
	}

	now := time.Now().UTC()
	res, err := h.deps.DB.ExecContext(r.Context(), `
		INSERT INTO singbox_certificates(domain, status, issuer, created_at, updated_at)
		VALUES (?, 'issuing', 'Let''s Encrypt', ?, ?)`,
		body.Domain, now, now)
	if err != nil {
		writeRouteError(w, 500, err.Error())
		return
	}
	certID, _ := res.LastInsertId()

	// Fire ACME issue asynchronously so the HTTP response is immediate (202).
	go func() {
		ctx := context.Background()
		if err := h.mgr.Issue(ctx, certID, body.Domain, body.Challenge, h.email); err != nil {
			_, _ = h.deps.DB.ExecContext(ctx, `
				UPDATE singbox_certificates SET status='failed', last_error=?, updated_at=? WHERE id=?`,
				err.Error(), time.Now().UTC(), certID)
		}
		// On success certmgr.Manager already sets status='active', expires_at, cert_pem, key_pem.
	}()

	writeJSONResp(w, 202, map[string]any{
		"id":         certID,
		"domain":     body.Domain,
		"status":     "issuing",
		"issuer":     "Let's Encrypt",
		"expires_at": nil,
		"last_error": nil,
		"created_at": now,
		"updated_at": now,
	})
}

// certRow is the public projection of singbox_certificates (no PEM).
type certRow struct {
	ID                int64          `json:"id"                   db:"id"`
	Domain            string         `json:"domain"               db:"domain"`
	Issuer            string         `json:"issuer"               db:"issuer"`
	Status            string         `json:"status"               db:"status"`
	ExpiresAt         sql.NullTime   `json:"expires_at"           db:"expires_at"`
	LastRenewAttemptAt sql.NullTime  `json:"last_renew_attempt_at" db:"last_renew_attempt_at"`
	LastError         sql.NullString `json:"last_error"           db:"last_error"`
	CreatedAt         time.Time      `json:"created_at"           db:"created_at"`
	UpdatedAt         time.Time      `json:"updated_at"           db:"updated_at"`
}

func (h *CertHandler) listCerts(w http.ResponseWriter, r *http.Request) {
	rows, err := h.deps.DB.QueryxContext(r.Context(), `
		SELECT id, domain, issuer, status, expires_at, last_renew_attempt_at, last_error, created_at, updated_at
		FROM singbox_certificates ORDER BY created_at DESC`)
	if err != nil {
		writeRouteError(w, 500, err.Error())
		return
	}
	defer func() { _ = rows.Close() }()

	out := []certRow{}
	for rows.Next() {
		var c certRow
		if err := rows.StructScan(&c); err != nil {
			writeRouteError(w, 500, err.Error())
			return
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		writeRouteError(w, 500, err.Error())
		return
	}
	writeJSONResp(w, 200, out)
}

func (h *CertHandler) deleteCert(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	certID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || certID == 0 {
		writeRouteError(w, 400, "id required")
		return
	}

	// Check for referencing inbounds.
	type inboundRef struct {
		ID int64 `db:"id"`
	}
	var refs []inboundRef
	if err := h.deps.DB.SelectContext(r.Context(), &refs,
		`SELECT id FROM singbox_inbounds WHERE cert_id=?`, certID); err != nil {
		writeRouteError(w, 500, err.Error())
		return
	}
	if len(refs) > 0 {
		ids := make([]int64, len(refs))
		for i, ref := range refs {
			ids[i] = ref.ID
		}
		writeJSONResp(w, 409, map[string]any{
			"error":       "certificate is in use",
			"inbound_ids": ids,
		})
		return
	}

	// Best-effort revoke via certmgr (fire-and-forget; failure doesn't block delete).
	go func() { _ = h.mgr.Renew(context.Background(), certID) }()

	if _, err := h.deps.DB.ExecContext(r.Context(),
		`DELETE FROM singbox_certificates WHERE id=?`, certID); err != nil {
		writeRouteError(w, 500, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *CertHandler) renewCert(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	certID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || certID == 0 {
		writeRouteError(w, 400, "id required")
		return
	}

	// Verify cert exists.
	var count int
	if err := h.deps.DB.QueryRowxContext(r.Context(),
		`SELECT COUNT(*) FROM singbox_certificates WHERE id=?`, certID).Scan(&count); err != nil || count == 0 {
		writeRouteError(w, 404, "certificate not found")
		return
	}

	// Mark as issuing before launching goroutine so UI sees the state immediately.
	_, _ = h.deps.DB.ExecContext(r.Context(), `
		UPDATE singbox_certificates SET status='issuing', last_renew_attempt_at=?, updated_at=? WHERE id=?`,
		time.Now().UTC(), time.Now().UTC(), certID)

	go func() {
		ctx := context.Background()
		if err := h.mgr.Renew(ctx, certID); err != nil {
			_, _ = h.deps.DB.ExecContext(ctx, `
				UPDATE singbox_certificates SET status='failed', last_error=?, updated_at=? WHERE id=?`,
				err.Error(), time.Now().UTC(), certID)
		}
	}()

	writeJSONResp(w, 202, map[string]any{"id": certID, "status": "issuing"})
}
```

Extend `internal/plugins/singbox/routes.go` to add all remaining routes:

```go
package singbox

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/jmoiron/sqlx"
	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/hg-claw/Shepherd/internal/plugins/singbox/certmgr"
)

// LatestFetcher is a package-level var so tests can override it without
// touching the real GitHub API. Mirrors the xray plugin pattern.
var LatestFetcher = func(ctx context.Context) ([]string, error) {
	return (&Releaser{}).ListLatestTags(ctx, 5)
}

var (
	latestMu    sync.Mutex
	latestVal   []string
	latestStamp time.Time
)

const latestTTL = 24 * time.Hour

func cachedLatest(ctx context.Context) []string {
	latestMu.Lock()
	if time.Since(latestStamp) < latestTTL {
		out := append([]string(nil), latestVal...)
		latestMu.Unlock()
		return out
	}
	latestMu.Unlock()
	tags, err := LatestFetcher(ctx)
	latestMu.Lock()
	defer latestMu.Unlock()
	if err == nil {
		latestVal = tags
		latestStamp = time.Now()
	}
	return append([]string(nil), latestVal...)
}

func (p *Plugin) RegisterRoutes(mux plugins.Mux, deps plugins.Deps) {
	// Inbound CRUD (Task 12)
	mux.HandleFunc("POST /inbounds",        postInboundHandler(deps))
	mux.HandleFunc("GET /inbounds",         getInboundsHandler(deps))
	mux.HandleFunc("PATCH /inbounds/{id}",  patchInboundHandler(deps))
	mux.HandleFunc("DELETE /inbounds/{id}", deleteInboundHandler(deps))

	// Binary version management
	mux.HandleFunc("PATCH /servers/{id}", patchServerVersionHandler(deps))
	mux.HandleFunc("GET /versions", func(w http.ResponseWriter, r *http.Request) {
		cached, err := listCachedBinaries(r.Context(), deps.DB)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		latest := cachedLatest(r.Context())
		if latest == nil {
			latest = []string{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"cached": cached,
			"latest": latest,
		})
	})

	// Certificate CRUD + renew
	// deps.CertManager is populated by OnEnable; we expose it via plugin struct
	// so tests can substitute a fakeMgr. In production this is *certmgr.Manager.
	var mgr certIssuer = p.certMgr
	if mgr == nil {
		// safety: create a no-op manager if OnEnable was never called
		// (e.g. unit tests that only test routes, not full lifecycle)
		mgr = &certmgr.Manager{}
	}
	email := p.acmeEmail
	certH := NewCertHandler(deps, mgr, email)
	mux.HandleFunc("POST /certificates",           certH.postCert)
	mux.HandleFunc("GET /certificates",            certH.listCerts)
	mux.HandleFunc("DELETE /certificates/{id}",    certH.deleteCert)
	mux.HandleFunc("POST /certificates/{id}/renew", certH.renewCert)
}

// listCachedBinaries reads singbox_binaries for the /versions response.
type cachedBinary struct {
	Version      string    `json:"version"`
	OS           string    `json:"os"`
	Arch         string    `json:"arch"`
	SizeBytes    int64     `json:"size_bytes"`
	Sha256       string    `json:"sha256"`
	DownloadedAt time.Time `json:"downloaded_at"`
}

func listCachedBinaries(ctx context.Context, db *sqlx.DB) ([]cachedBinary, error) {
	rows, err := db.QueryxContext(ctx,
		`SELECT version, os, arch, size_bytes, sha256, downloaded_at
		 FROM singbox_binaries ORDER BY downloaded_at DESC`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
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

Add `patchServerVersionHandler` to `internal/plugins/singbox/inbounds_routes.go`:

```go
type patchVersionBody struct {
	Version string `json:"version"`
}

func patchServerVersionHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if sid == 0 {
			writeRouteError(w, 400, "id required")
			return
		}
		var body patchVersionBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeRouteError(w, 400, "bad json")
			return
		}
		if body.Version == "" {
			writeRouteError(w, 400, "version required")
			return
		}

		// UPSERT plugin_hosts with status=deploying.
		_, err := deps.DB.ExecContext(r.Context(), `
			INSERT INTO plugin_hosts(plugin_id, server_id, config_json, deployed_version, status, updated_at)
			VALUES ('singbox', ?, '{}', ?, 'deploying', ?)
			ON CONFLICT(plugin_id, server_id) DO UPDATE
			SET deployed_version = excluded.deployed_version,
			    status           = 'deploying',
			    updated_at       = excluded.updated_at`,
			sid, body.Version, time.Now().UTC())
		if err != nil {
			writeRouteError(w, 500, err.Error())
			return
		}

		// Async: fetch binary + push service unit + restart + push real config.
		go func() {
			ctx := context.Background()
			p := &Plugin{}
			if err := p.DeployToHost(ctx, deps, sid, body.Version, []byte("{}")); err != nil {
				_, _ = deps.DB.ExecContext(ctx,
					`UPDATE plugin_hosts SET status='failed', last_error=? WHERE plugin_id='singbox' AND server_id=?`,
					err.Error(), sid)
				return
			}
			if err := AssembleAndDeploy(ctx, deps, sid); err != nil {
				_, _ = deps.DB.ExecContext(ctx,
					`UPDATE plugin_hosts SET status='failed', last_error=? WHERE plugin_id='singbox' AND server_id=?`,
					err.Error(), sid)
				return
			}
			_, _ = deps.DB.ExecContext(ctx,
				`UPDATE plugin_hosts SET status='running', last_error='' WHERE plugin_id='singbox' AND server_id=?`, sid)
		}()

		writeJSONResp(w, 200, map[string]any{"ok": true, "version": body.Version})
	}
}
```

Update `internal/plugins/singbox/singbox.go` — add `certMgr` and `acmeEmail` fields to `Plugin` struct and wire `OnEnable`:

```go
import "github.com/hg-claw/Shepherd/internal/plugins/singbox/certmgr"

type Plugin struct {
	releaser  releaserIface
	certMgr   *certmgr.Manager // populated by OnEnable
	acmeEmail string
}

func (p *Plugin) OnEnable(_ context.Context, deps plugins.Deps) error {
	// In a real deployment the ACME email and CF token come from plugin config_json.
	// For now we initialise with empty values; operator sets them via the Config tab.
	p.certMgr = certmgr.New(certmgr.Config{
		CertStoreWriter: &CertStore{DB: deps.DB},
		Email:           p.acmeEmail,
	})
	return nil
}
```

- [ ] **Step 4: Run tests, expect PASS**

```
go test ./internal/plugins/singbox/...
```

Expected: all cert route tests + version/patchServer tests PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/singbox/cert_routes.go \
        internal/plugins/singbox/cert_routes_test.go \
        internal/plugins/singbox/routes.go \
        internal/plugins/singbox/routes_test.go \
        internal/plugins/singbox/inbounds_routes.go \
        internal/plugins/singbox/singbox.go
git commit -m "feat(plugins/singbox): /versions, PATCH /servers/:id, and /certificates CRUD + renew routes"
```

---

## Task 14: agentapi SingboxTrafficBatch envelope

**Files:**
- Modify: `internal/agentapi/types.go`

- [ ] **Step 1: Write the failing test**

Append to `internal/agentapi/traffic_test.go` (the same file that holds `TestXrayTrafficBatch_RoundTrip`):

```go
func TestSingboxTrafficBatch_RoundTrip(t *testing.T) {
	batch := SingboxTrafficBatch{
		Samples: []SingboxTrafficSample{
			{Tag: "landing-aabb1122", Kind: "landing", TS: time.Date(2026, 5, 20, 10, 0, 30, 0, time.UTC), BytesUp: 204800, BytesDown: 1048576},
			{Tag: "relay-ccdd3344",   Kind: "relay",   TS: time.Date(2026, 5, 20, 10, 0, 30, 0, time.UTC), BytesUp: 1024,   BytesDown: 512},
		},
	}
	env, err := Frame(TypeSingboxTraffic, batch)
	if err != nil {
		t.Fatal(err)
	}
	if env.Type != TypeSingboxTraffic {
		t.Errorf("type = %q, want %q", env.Type, TypeSingboxTraffic)
	}
	var got SingboxTrafficBatch
	if err := env.Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Samples) != 2 {
		t.Fatalf("samples = %d, want 2", len(got.Samples))
	}
	if got.Samples[0].BytesUp != 204800 {
		t.Errorf("BytesUp = %d, want 204800", got.Samples[0].BytesUp)
	}
}
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
go test -run TestSingboxTrafficBatch_RoundTrip ./internal/agentapi/...
```

Expected: FAIL — `TypeSingboxTraffic`, `SingboxTrafficSample`, `SingboxTrafficBatch` undefined.

- [ ] **Step 3: Implement**

Append to `internal/agentapi/types.go`:

```go
// TypeSingboxTraffic is the agent→server envelope type for sing-box traffic samples.
const TypeSingboxTraffic = "singbox.traffic"

// SingboxTrafficSample is a per-inbound-tag traffic delta for one 30s window.
// Kind mirrors the inbound role: "landing" or "relay".
type SingboxTrafficSample struct {
	Tag       string    `json:"tag"`        // e.g. "landing-aabb1122"
	Kind      string    `json:"kind"`       // "landing" | "relay"
	TS        time.Time `json:"ts"`         // sample timestamp, UTC
	BytesUp   int64     `json:"bytes_up"`
	BytesDown int64     `json:"bytes_down"`
}

// SingboxTrafficBatch is the payload of a TypeSingboxTraffic envelope.
type SingboxTrafficBatch struct {
	Samples []SingboxTrafficSample `json:"samples"`
}
```

- [ ] **Step 4: Run test, expect PASS**

```bash
go test -run TestSingboxTrafficBatch_RoundTrip ./internal/agentapi/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/agentapi/types.go internal/agentapi/traffic_test.go
git commit -m "feat(agentapi): add TypeSingboxTraffic + SingboxTrafficBatch envelope types"
```

---

## Task 15: singboxsampler/parse — parse clash-api /connections JSON

**Files:**
- Create: `internal/agent/singboxsampler/parse.go`
- Create: `internal/agent/singboxsampler/parse_test.go`

- [ ] **Step 1: Write the failing test**

`internal/agent/singboxsampler/parse_test.go`:

```go
package singboxsampler

import (
	"testing"
)

func TestParseConnections_SumsPerTag(t *testing.T) {
	raw := []byte(`{
		"connections": [
			{"id":"c1","upload":1024,"download":2048,"metadata":{"inbound":"landing-aabb1122","network":"tcp"}},
			{"id":"c2","upload":512, "download":1024,"metadata":{"inbound":"landing-aabb1122","network":"tcp"}},
			{"id":"c3","upload":4096,"download":8192,"metadata":{"inbound":"relay-ccdd3344",  "network":"udp"}}
		],
		"uploadTotal":5632,"downloadTotal":11264
	}`)
	got, err := ParseConnections(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("entries = %d, want 2", len(got))
	}
	if got["landing-aabb1122"].Up != 1536 {
		t.Errorf("landing up = %d, want 1536 (1024+512)", got["landing-aabb1122"].Up)
	}
	if got["landing-aabb1122"].Down != 3072 {
		t.Errorf("landing down = %d, want 3072 (2048+1024)", got["landing-aabb1122"].Down)
	}
	if got["relay-ccdd3344"].Up != 4096 {
		t.Errorf("relay up = %d, want 4096", got["relay-ccdd3344"].Up)
	}
}

func TestParseConnections_Empty(t *testing.T) {
	raw := []byte(`{"connections":[],"uploadTotal":0,"downloadTotal":0}`)
	got, err := ParseConnections(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("expected empty map, got %d entries", len(got))
	}
}

func TestParseConnections_MissingInboundTag(t *testing.T) {
	// connections with no inbound tag in metadata are skipped
	raw := []byte(`{"connections":[{"id":"c1","upload":100,"download":200,"metadata":{"network":"tcp"}}]}`)
	got, err := ParseConnections(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("expected empty map for missing inbound tag, got %d", len(got))
	}
}

func TestParseConnections_InvalidJSON(t *testing.T) {
	_, err := ParseConnections([]byte(`not-json`))
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
go test -run TestParseConnections ./internal/agent/singboxsampler/...
```

Expected: FAIL — package does not exist.

- [ ] **Step 3: Implement**

`internal/agent/singboxsampler/parse.go`:

```go
package singboxsampler

import (
	"encoding/json"
	"fmt"
)

// TagBytes holds cumulative upload/download bytes for one inbound tag.
type TagBytes struct {
	Up   int64
	Down int64
}

type connectionsResponse struct {
	Connections []connectionEntry `json:"connections"`
}

type connectionEntry struct {
	Upload   int64            `json:"upload"`
	Download int64            `json:"download"`
	Metadata connectionMeta   `json:"metadata"`
}

type connectionMeta struct {
	Inbound string `json:"inbound"`
}

// ParseConnections parses the clash-api GET /connections response and returns
// per-inbound-tag cumulative bytes. Connections with an empty inbound tag are skipped.
func ParseConnections(data []byte) (map[string]TagBytes, error) {
	var resp connectionsResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, fmt.Errorf("singboxsampler: parse connections: %w", err)
	}
	out := make(map[string]TagBytes, 8)
	for _, c := range resp.Connections {
		tag := c.Metadata.Inbound
		if tag == "" {
			continue
		}
		tb := out[tag]
		tb.Up += c.Upload
		tb.Down += c.Download
		out[tag] = tb
	}
	return out, nil
}
```

- [ ] **Step 4: Run test, expect PASS**

```bash
go test -run TestParseConnections ./internal/agent/singboxsampler/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/agent/singboxsampler/parse.go internal/agent/singboxsampler/parse_test.go
git commit -m "feat(singboxsampler): ParseConnections — clash-api /connections per-tag aggregator"
```

---

## Task 16: singboxsampler sampler loop

**Files:**
- Create: `internal/agent/singboxsampler/sampler.go`
- Create: `internal/agent/singboxsampler/sampler_test.go`

- [ ] **Step 1: Write the failing test**

`internal/agent/singboxsampler/sampler_test.go`:

```go
package singboxsampler

import (
	"context"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

func runTicks(s *Sampler, snapshots []map[string]TagBytes) []agentapi.SingboxTrafficBatch {
	var sent []agentapi.SingboxTrafficBatch
	s.Send = func(env agentapi.Envelope) error {
		var b agentapi.SingboxTrafficBatch
		_ = env.Decode(&b)
		sent = append(sent, b)
		return nil
	}
	for _, snap := range snapshots {
		s.fetchFunc = func(_ string, _ string) (map[string]TagBytes, error) { return snap, nil }
		s.tick(context.Background())
	}
	return sent
}

func TestFirstTickNoReport(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:29090", Interval: time.Second}
	sent := runTicks(s, []map[string]TagBytes{
		{"landing-aabb1122": {Up: 1000, Down: 2000}},
	})
	if len(sent) != 0 {
		t.Errorf("first tick must not send; got %d batches", len(sent))
	}
}

func TestSecondTickDelta(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:29090", Interval: time.Second}
	sent := runTicks(s, []map[string]TagBytes{
		{"landing-aabb1122": {Up: 1000, Down: 2000}},
		{"landing-aabb1122": {Up: 1500, Down: 3500}},
	})
	if len(sent) != 1 {
		t.Fatalf("expected 1 batch after second tick, got %d", len(sent))
	}
	if len(sent[0].Samples) != 1 {
		t.Fatalf("expected 1 sample, got %d", len(sent[0].Samples))
	}
	s0 := sent[0].Samples[0]
	if s0.BytesUp != 500 {
		t.Errorf("BytesUp = %d, want 500", s0.BytesUp)
	}
	if s0.BytesDown != 1500 {
		t.Errorf("BytesDown = %d, want 1500", s0.BytesDown)
	}
	if s0.Kind != "landing" {
		t.Errorf("Kind = %q, want 'landing'", s0.Kind)
	}
}

func TestCounterResetZeroDelta(t *testing.T) {
	// Simulate sing-box restart: counters drop. Delta must be clamped to 0.
	s := &Sampler{APIAddress: "127.0.0.1:29090", Interval: time.Second}
	sent := runTicks(s, []map[string]TagBytes{
		{"landing-aabb1122": {Up: 5000, Down: 10000}},
		{"landing-aabb1122": {Up: 100,  Down: 200}},
	})
	if len(sent) != 1 {
		t.Fatalf("expected 1 batch, got %d", len(sent))
	}
	if sent[0].Samples[0].BytesUp != 0 {
		t.Errorf("BytesUp = %d after reset, want 0", sent[0].Samples[0].BytesUp)
	}
}

func TestFetchErrorSkipsTick(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:29090", Interval: time.Second}
	var sendCalled bool
	s.Send = func(_ agentapi.Envelope) error { sendCalled = true; return nil }
	s.fetchFunc = func(_, _ string) (map[string]TagBytes, error) {
		return nil, fmt.Errorf("connection refused")
	}
	s.tick(context.Background())
	if sendCalled {
		t.Error("Send must not be called when fetch fails")
	}
}
```

(Add `"fmt"` to the import block.)

- [ ] **Step 2: Run test, expect FAIL**

```bash
go test -run TestFirstTickNoReport ./internal/agent/singboxsampler/...
```

Expected: FAIL — `Sampler`, `tick`, `fetchFunc` undefined.

- [ ] **Step 3: Implement**

`internal/agent/singboxsampler/sampler.go`:

```go
package singboxsampler

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// Sampler polls the sing-box clash-api /connections endpoint every Interval,
// computes per-tag byte deltas, and emits SingboxTrafficBatch envelopes via Send.
type Sampler struct {
	// APIAddress is the clash-api listen address (default 127.0.0.1:29090).
	APIAddress string
	// Secret is the optional clash-api secret header value.
	Secret string
	// Interval between polls (default 30s).
	Interval time.Duration
	// Send delivers an encoded envelope to the server. Set by the caller.
	Send func(agentapi.Envelope) error

	// fetchFunc is replaceable in tests; production uses httpFetch.
	fetchFunc func(addr, secret string) (map[string]TagBytes, error)

	prev       map[string]TagBytes
	prevExists bool
}

func (s *Sampler) apiAddress() string {
	if s.APIAddress != "" {
		return s.APIAddress
	}
	return "127.0.0.1:29090"
}

func (s *Sampler) interval() time.Duration {
	if s.Interval > 0 {
		return s.Interval
	}
	return 30 * time.Second
}

func (s *Sampler) fetch(ctx context.Context) (map[string]TagBytes, error) {
	if s.fetchFunc != nil {
		return s.fetchFunc(s.apiAddress(), s.Secret)
	}
	return httpFetch(ctx, s.apiAddress(), s.Secret)
}

// Run blocks until ctx is canceled, ticking every Interval.
func (s *Sampler) Run(ctx context.Context) {
	t := time.NewTicker(s.interval())
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick(ctx)
		}
	}
}

func (s *Sampler) tick(ctx context.Context) {
	cur, err := s.fetch(ctx)
	if err != nil {
		log.Printf("singboxsampler: fetch failed: %v", err)
		return
	}

	if !s.prevExists {
		s.prev = cur
		s.prevExists = true
		return
	}

	now := time.Now().UTC()
	samples := make([]agentapi.SingboxTrafficSample, 0, len(cur))
	for tag, tb := range cur {
		prev := s.prev[tag]
		up := tb.Up - prev.Up
		if up < 0 {
			up = 0
		}
		down := tb.Down - prev.Down
		if down < 0 {
			down = 0
		}
		kind := "landing"
		if strings.HasPrefix(tag, "relay-") {
			kind = "relay"
		}
		samples = append(samples, agentapi.SingboxTrafficSample{
			Tag:       tag,
			Kind:      kind,
			TS:        now,
			BytesUp:   up,
			BytesDown: down,
		})
	}

	env, err := agentapi.Frame(agentapi.TypeSingboxTraffic, agentapi.SingboxTrafficBatch{Samples: samples})
	if err != nil {
		log.Printf("singboxsampler: frame error: %v", err)
		s.prev = cur
		return
	}
	if s.Send != nil {
		if err := s.Send(env); err != nil {
			log.Printf("singboxsampler: send failed: %v", err)
		}
	}
	s.prev = cur
}

// httpFetch calls the clash-api GET /connections endpoint.
func httpFetch(ctx context.Context, addr, secret string) (map[string]TagBytes, error) {
	url := fmt.Sprintf("http://%s/connections", addr)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	if secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("singboxsampler: GET /connections: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return ParseConnections(data)
}
```

- [ ] **Step 4: Run test, expect PASS**

```bash
go test ./internal/agent/singboxsampler/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/agent/singboxsampler/sampler.go internal/agent/singboxsampler/sampler_test.go
git commit -m "feat(singboxsampler): 30s sampler loop with delta computation + counter-reset clamping"
```

---

## Task 17: Wire singboxsampler into agent

**Files:**
- Modify: `internal/agent/wsclient/client.go`
- Modify: `cmd/agent/main.go`

- [ ] **Step 1: Write the failing compilation test**

Append to `internal/agent/wsclient/client_test.go`:

```go
func TestClient_SingboxTrafficSamplerField_Compiles(t *testing.T) {
	c := &Client{}
	_ = c.SingboxTrafficSampler // compilation check
}
```

- [ ] **Step 2: Run, expect FAIL**

```bash
go build ./internal/agent/wsclient/...
```

Expected: compile error — `SingboxTrafficSampler` field does not exist.

- [ ] **Step 3: Implement**

In `internal/agent/wsclient/client.go`:

1. Add import: `"github.com/hg-claw/Shepherd/internal/agent/singboxsampler"`

2. Add field to `Client` struct alongside existing `TrafficSampler`:

```go
// SingboxTrafficSampler, if non-nil, is started after each WS connect.
SingboxTrafficSampler *singboxsampler.Sampler
```

3. In `dialAndRun`, after the existing `TrafficSampler` goroutine block, add:

```go
if c.SingboxTrafficSampler != nil {
	sbCtx, sbCancel := context.WithCancel(ctx)
	go func() {
		select {
		case <-stop:
			sbCancel()
		case <-ctx.Done():
			sbCancel()
		}
	}()
	go c.SingboxTrafficSampler.Run(sbCtx)
}
```

In `cmd/agent/main.go`, after the existing `trafficSampler` block:

```go
singboxSampler := &singboxsampler.Sampler{
	APIAddress: "127.0.0.1:29090",
	Interval:   30 * time.Second,
	Send:       client.Send,
}
client.SingboxTrafficSampler = singboxSampler
```

Add import: `"github.com/hg-claw/Shepherd/internal/agent/singboxsampler"`

- [ ] **Step 4: Run, expect PASS**

```bash
go build ./cmd/agent/... && go test ./internal/agent/wsclient/...
```

Expected: builds clean, tests pass.

- [ ] **Step 5: Commit**

```bash
git add internal/agent/wsclient/client.go cmd/agent/main.go
git commit -m "feat(agent): wire singboxsampler into wsclient dialAndRun goroutine"
```

---

## Task 18: Server ingest WriteSingboxTrafficBatch + HandleFrame dispatch

**Files:**
- Create: `internal/telemetrysvc/singbox_traffic_ingest.go`
- Create: `internal/telemetrysvc/singbox_traffic_ingest_test.go`
- Modify: `internal/telemetrysvc/ingest.go`

- [ ] **Step 1: Write the failing test**

`internal/telemetrysvc/singbox_traffic_ingest_test.go`:

```go
package telemetrysvc

import (
	"context"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/plugins"
	sbplugin "github.com/hg-claw/Shepherd/internal/plugins/singbox"
)

func newIngestWithSingboxTraffic(t *testing.T) (*Ingest, int64) {
	t.Helper()
	ing, sid := newIngest(t)
	if err := plugins.RunPluginMigrations(context.Background(), ing.DB, "singbox",
		sbplugin.Migrations()); err != nil {
		t.Fatal(err)
	}
	return ing, sid
}

func TestWriteSingboxTrafficBatch_InsertsRows(t *testing.T) {
	ing, sid := newIngestWithSingboxTraffic(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	samples := []agentapi.SingboxTrafficSample{
		{Tag: "landing-aabb1122", Kind: "landing", TS: now, BytesUp: 1024, BytesDown: 2048},
		{Tag: "relay-ccdd3344",   Kind: "relay",   TS: now, BytesUp: 512,  BytesDown: 1024},
	}
	if err := ing.WriteSingboxTrafficBatch(ctx, sid, samples); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := ing.DB.GetContext(ctx, &n,
		"SELECT COUNT(*) FROM singbox_traffic_raw WHERE server_id=?", sid); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Errorf("rows = %d, want 2", n)
	}
	var up int64
	_ = ing.DB.GetContext(ctx, &up,
		"SELECT bytes_up FROM singbox_traffic_raw WHERE tag='landing-aabb1122'")
	if up != 1024 {
		t.Errorf("bytes_up = %d, want 1024", up)
	}
}

func TestWriteSingboxTrafficBatch_EmptyIsNoOp(t *testing.T) {
	ing, sid := newIngestWithSingboxTraffic(t)
	if err := ing.WriteSingboxTrafficBatch(context.Background(), sid, nil); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = ing.DB.Get(&n, "SELECT COUNT(*) FROM singbox_traffic_raw WHERE server_id=?", sid)
	if n != 0 {
		t.Errorf("rows = %d after empty batch, want 0", n)
	}
}

func TestHandleFrame_SingboxTraffic(t *testing.T) {
	ing, sid := newIngestWithSingboxTraffic(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	batch := agentapi.SingboxTrafficBatch{Samples: []agentapi.SingboxTrafficSample{
		{Tag: "landing-aabb1122", Kind: "landing", TS: now, BytesUp: 100, BytesDown: 200},
	}}
	env, _ := agentapi.Frame(agentapi.TypeSingboxTraffic, batch)
	ing.HandleFrame(ctx, sid, env)

	var n int
	_ = ing.DB.GetContext(ctx, &n,
		"SELECT COUNT(*) FROM singbox_traffic_raw WHERE server_id=?", sid)
	if n != 1 {
		t.Errorf("rows = %d after HandleFrame, want 1", n)
	}
}
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
go test -run TestWriteSingboxTrafficBatch ./internal/telemetrysvc/...
```

Expected: FAIL — `WriteSingboxTrafficBatch` undefined, `singbox_traffic_raw` table missing.

- [ ] **Step 3: Implement**

`internal/telemetrysvc/singbox_traffic_ingest.go`:

```go
package telemetrysvc

import (
	"context"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// WriteSingboxTrafficBatch inserts SingboxTrafficSample rows into singbox_traffic_raw
// within a single transaction. Empty slice is a no-op.
func (i *Ingest) WriteSingboxTrafficBatch(ctx context.Context, serverID int64, samples []agentapi.SingboxTrafficSample) error {
	if len(samples) == 0 {
		return nil
	}
	tx, err := i.DB.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO singbox_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
		VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()

	for _, s := range samples {
		if _, err := stmt.ExecContext(ctx, serverID, s.Tag, s.Kind, s.TS.UTC(), s.BytesUp, s.BytesDown); err != nil {
			return err
		}
	}
	return tx.Commit()
}
```

In `internal/telemetrysvc/ingest.go`, inside `HandleFrame`'s switch block, add alongside the existing `TypeXrayTraffic` case:

```go
case agentapi.TypeSingboxTraffic:
	var batch agentapi.SingboxTrafficBatch
	if err := env.Decode(&batch); err != nil {
		log.Printf("singbox.traffic decode (server=%d): %v", serverID, err)
		return
	}
	if err := i.WriteSingboxTrafficBatch(ctx, serverID, batch.Samples); err != nil {
		log.Printf("singbox.traffic write (server=%d): %v", serverID, err)
	}
```

- [ ] **Step 4: Run test, expect PASS**

```bash
go test -run TestWriteSingboxTrafficBatch -run TestHandleFrame_SingboxTraffic ./internal/telemetrysvc/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/telemetrysvc/singbox_traffic_ingest.go \
        internal/telemetrysvc/singbox_traffic_ingest_test.go \
        internal/telemetrysvc/ingest.go
git commit -m "feat(telemetrysvc): WriteSingboxTrafficBatch + HandleFrame dispatch for singbox.traffic"
```

---

## Task 19: SingboxTrafficRollup raw→minute→hour + retention

**Files:**
- Create: `internal/telemetrysvc/singbox_traffic_rollup.go`
- Create: `internal/telemetrysvc/singbox_traffic_rollup_test.go`
- Modify: `internal/telemetrysvc/retention.go`

- [ ] **Step 1: Write the failing test**

`internal/telemetrysvc/singbox_traffic_rollup_test.go`:

```go
package telemetrysvc

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
	sbplugin "github.com/hg-claw/Shepherd/internal/plugins/singbox"
)

func newSingboxRollupDB(t *testing.T) (*Ingest, int64) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "sbr.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "singbox", sbplugin.Migrations())
	res, _ := d.Exec("INSERT INTO servers(name,ssh_host,ssh_user,ssh_port,created_at,updated_at) VALUES ('h','1.2.3.4','root',22,datetime('now'),datetime('now'))")
	sid, _ := res.LastInsertId()
	return &Ingest{DB: d}, sid
}

func TestSingboxRollupRawToMinute(t *testing.T) {
	ing, sid := newSingboxRollupDB(t)
	ctx := context.Background()
	bucket := time.Now().UTC().Add(-2 * time.Minute).Truncate(time.Minute)
	for i := 0; i < 4; i++ {
		ts := bucket.Add(time.Duration(i) * 15 * time.Second)
		_, err := ing.DB.ExecContext(ctx,
			`INSERT INTO singbox_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
			 VALUES (?, 'landing-aabb1122', 'landing', ?, 1000, 2000)`, sid, ts)
		if err != nil {
			t.Fatal(err)
		}
	}

	r := &SingboxTrafficRollup{DB: ing.DB}
	if err := r.rollupRawToMinute(ctx); err != nil {
		t.Fatal(err)
	}

	var n int
	_ = ing.DB.GetContext(ctx, &n,
		"SELECT COUNT(*) FROM singbox_traffic_minute WHERE server_id=?", sid)
	if n != 1 {
		t.Fatalf("singbox_traffic_minute rows = %d, want 1", n)
	}
	var up, down int64
	_ = ing.DB.GetContext(ctx, &up,   "SELECT bytes_up   FROM singbox_traffic_minute WHERE server_id=?", sid)
	_ = ing.DB.GetContext(ctx, &down, "SELECT bytes_down FROM singbox_traffic_minute WHERE server_id=?", sid)
	if up != 4000 {
		t.Errorf("bytes_up = %d, want 4000", up)
	}
	if down != 8000 {
		t.Errorf("bytes_down = %d, want 8000", down)
	}
}

func TestSingboxRollupRawToMinute_Idempotent(t *testing.T) {
	ing, sid := newSingboxRollupDB(t)
	ctx := context.Background()
	bucket := time.Now().UTC().Add(-2 * time.Minute).Truncate(time.Minute)
	ing.DB.MustExec(
		`INSERT INTO singbox_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
		 VALUES (?, 'landing-aabb1122', 'landing', ?, 1000, 2000)`, sid, bucket)

	r := &SingboxTrafficRollup{DB: ing.DB}
	_ = r.rollupRawToMinute(ctx)
	_ = r.rollupRawToMinute(ctx)

	var n int
	_ = ing.DB.GetContext(ctx, &n, "SELECT COUNT(*) FROM singbox_traffic_minute WHERE server_id=?", sid)
	if n != 1 {
		t.Errorf("idempotent rollup created %d rows, want 1", n)
	}
}

func TestSingboxRollupOpenBucketSkipped(t *testing.T) {
	ing, sid := newSingboxRollupDB(t)
	ctx := context.Background()
	// Timestamp = now → current open bucket, must not be rolled up.
	ing.DB.MustExec(
		`INSERT INTO singbox_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
		 VALUES (?, 'landing-aabb1122', 'landing', datetime('now'), 1000, 2000)`, sid)

	r := &SingboxTrafficRollup{DB: ing.DB}
	_ = r.rollupRawToMinute(ctx)

	var n int
	_ = ing.DB.GetContext(ctx, &n, "SELECT COUNT(*) FROM singbox_traffic_minute WHERE server_id=?", sid)
	if n != 0 {
		t.Errorf("open bucket rolled up prematurely: %d rows", n)
	}
}

func TestSingboxRollupMinuteToHour(t *testing.T) {
	ing, sid := newSingboxRollupDB(t)
	ctx := context.Background()
	bucket := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Hour)
	for i := 0; i < 60; i++ {
		ts := bucket.Add(time.Duration(i) * time.Minute)
		_, err := ing.DB.ExecContext(ctx,
			`INSERT INTO singbox_traffic_minute (server_id, tag, kind, ts, bytes_up, bytes_down)
			 VALUES (?, 'landing-aabb1122', 'landing', ?, 100, 200)
			 ON CONFLICT DO NOTHING`, sid, ts)
		if err != nil {
			t.Fatal(err)
		}
	}

	r := &SingboxTrafficRollup{DB: ing.DB}
	if err := r.rollupMinuteToHour(ctx); err != nil {
		t.Fatal(err)
	}

	var up int64
	_ = ing.DB.GetContext(ctx, &up,
		"SELECT bytes_up FROM singbox_traffic_hour WHERE server_id=?", sid)
	if up != 6000 {
		t.Errorf("bytes_up = %d, want 6000 (60 × 100)", up)
	}
}
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
go test -run TestSingboxRollup ./internal/telemetrysvc/...
```

Expected: FAIL — `SingboxTrafficRollup` undefined.

- [ ] **Step 3: Implement rollup**

`internal/telemetrysvc/singbox_traffic_rollup.go`:

```go
package telemetrysvc

import (
	"context"
	"log"
	"time"

	"github.com/jmoiron/sqlx"
)

// SingboxTrafficRollup aggregates singbox_traffic_raw → minute → hour.
// It mirrors TrafficRollup but operates on the singbox_traffic_* tables.
type SingboxTrafficRollup struct {
	DB *sqlx.DB
}

// Run blocks until ctx is canceled, running rollup + cleanup every minute.
func (r *SingboxTrafficRollup) Run(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := r.rollupRawToMinute(ctx); err != nil {
				log.Printf("singbox rollup raw→minute: %v", err)
			}
			if err := r.rollupMinuteToHour(ctx); err != nil {
				log.Printf("singbox rollup minute→hour: %v", err)
			}
			r.cleanup(ctx)
		}
	}
}

// rollupRawToMinute aggregates closed minute buckets from singbox_traffic_raw
// into singbox_traffic_minute. Buckets whose truncated minute == current minute
// are skipped (still open). Idempotent via ON CONFLICT DO UPDATE.
func (r *SingboxTrafficRollup) rollupRawToMinute(ctx context.Context) error {
	_, err := r.DB.ExecContext(ctx, `
		INSERT INTO singbox_traffic_minute (server_id, tag, kind, ts, bytes_up, bytes_down)
		SELECT server_id, tag, kind,
		       strftime('%Y-%m-%dT%H:%M:00Z', ts) AS ts,
		       SUM(bytes_up)   AS bytes_up,
		       SUM(bytes_down) AS bytes_down
		FROM singbox_traffic_raw
		WHERE strftime('%Y-%m-%dT%H:%M:00Z', ts) < strftime('%Y-%m-%dT%H:%M:00Z', 'now')
		GROUP BY server_id, tag, kind, strftime('%Y-%m-%dT%H:%M:00Z', ts)
		ON CONFLICT(server_id, tag, ts) DO UPDATE
		SET bytes_up   = excluded.bytes_up,
		    bytes_down = excluded.bytes_down`)
	return err
}

// rollupMinuteToHour aggregates closed hour buckets from singbox_traffic_minute
// into singbox_traffic_hour. Idempotent via ON CONFLICT DO UPDATE.
func (r *SingboxTrafficRollup) rollupMinuteToHour(ctx context.Context) error {
	_, err := r.DB.ExecContext(ctx, `
		INSERT INTO singbox_traffic_hour (server_id, tag, kind, ts, bytes_up, bytes_down)
		SELECT server_id, tag, kind,
		       strftime('%Y-%m-%dT%H:00:00Z', ts) AS ts,
		       SUM(bytes_up)   AS bytes_up,
		       SUM(bytes_down) AS bytes_down
		FROM singbox_traffic_minute
		WHERE strftime('%Y-%m-%dT%H:00:00Z', ts) < strftime('%Y-%m-%dT%H:00:00Z', 'now')
		GROUP BY server_id, tag, kind, strftime('%Y-%m-%dT%H:00:00Z', ts)
		ON CONFLICT(server_id, tag, ts) DO UPDATE
		SET bytes_up   = excluded.bytes_up,
		    bytes_down = excluded.bytes_down`)
	return err
}

func (r *SingboxTrafficRollup) cleanup(ctx context.Context) {
	now := time.Now().UTC()
	for _, q := range []struct {
		table  string
		retain time.Duration
	}{
		{"singbox_traffic_raw",    24 * time.Hour},
		{"singbox_traffic_minute", 7 * 24 * time.Hour},
		{"singbox_traffic_hour",   90 * 24 * time.Hour},
	} {
		cutoff := now.Add(-q.retain)
		if _, err := r.DB.ExecContext(ctx,
			"DELETE FROM "+q.table+" WHERE ts < ?", cutoff); err != nil {
			log.Printf("singbox cleanup %s: %v", q.table, err)
		}
	}
}
```

- [ ] **Step 4: Run test, expect PASS**

```bash
go test -run TestSingboxRollup ./internal/telemetrysvc/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/telemetrysvc/singbox_traffic_rollup.go \
        internal/telemetrysvc/singbox_traffic_rollup_test.go
git commit -m "feat(telemetrysvc): SingboxTrafficRollup raw→minute→hour with idempotent aggregation"
```

---

## Task 20: Start SingboxTrafficRollup + cert renewal goroutines in cmd/server/main.go

**Files:**
- Modify: `cmd/server/main.go`

- [ ] **Step 1: Write the failing compilation test**

The test here is `go build ./cmd/server/...` — no unit test file needed because we are only wiring goroutines.

```bash
go build ./cmd/server/...
```

Expected BEFORE: builds clean (no references to SingboxTrafficRollup yet).

- [ ] **Step 2: Implement**

In `cmd/server/main.go`, find where the existing `TrafficRollup.Run` goroutine is started (alongside the xray rollup). After that block, add:

```go
// sing-box traffic rollup
sbRollup := &telemetrysvc.SingboxTrafficRollup{DB: db}
go sbRollup.Run(ctx)
```

Also start the cert renewal loop. The certmgr.Manager needs a CF token provider.
Pull the token from the cloudflare plugin store if enabled, otherwise pass empty:

```go
// sing-box cert renewal loop
sbCertStore := &singboxplugin.CertStore{DB: db}
cfToken := ""
// If the cloudflare plugin is enabled, extract its API token for DNS-01 challenges.
var cfCfgJSON string
_ = db.Get(&cfCfgJSON,
	`SELECT config_json FROM plugin_hosts WHERE plugin_id='cloudflare' LIMIT 1`)
if cfCfgJSON != "" {
	var cfCfg struct{ APIToken string `json:"api_token"` }
	if err := json.Unmarshal([]byte(cfCfgJSON), &cfCfg); err == nil {
		cfToken = cfCfg.APIToken
	}
}
sbCertMgr := certmgr.New(certmgr.Config{
	CertStoreWriter: sbCertStore,
	CFToken:         cfToken,
})
go sbCertMgr.RunRenewalLoop(ctx, sbCertStore)
```

Add imports:

```go
import (
	// existing imports …
	"encoding/json"

	"github.com/hg-claw/Shepherd/internal/singbox/certmgr"
	singboxplugin "github.com/hg-claw/Shepherd/internal/plugins/singbox"
	"github.com/hg-claw/Shepherd/internal/telemetrysvc"
)
```

(Adjust to match existing import grouping style.)

- [ ] **Step 3: Run, expect PASS**

```bash
go build ./cmd/server/...
```

Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add cmd/server/main.go
git commit -m "feat(server): start SingboxTrafficRollup + certmgr renewal goroutines at boot"
```

---

## Task 21: GET /traffic + /traffic/batch endpoints (singbox)

**Files:**
- Create: `internal/plugins/singbox/traffic_query.go`
- Create: `internal/plugins/singbox/traffic_query_test.go`
- Modify: `internal/plugins/singbox/routes.go`

- [ ] **Step 1: Write the failing test**

`internal/plugins/singbox/traffic_query_test.go`:

```go
package singbox_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/hg-claw/Shepherd/internal/plugins/singbox"
)

func setupTrafficDB(t *testing.T) (*sqlx.DB, int64) {
	t.Helper()
	db := singbox.OpenTestDB(t)
	migs := singbox.ExportedMigrations()
	applyMigration(t, db, migs[2]) // 0003_singbox_traffic
	mustExec(t, db, `INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at,updated_at)
		VALUES (1,'s1','1.2.3.4','root',22,datetime('now'),datetime('now'))`)
	return db, 1
}

func insertRawTraffic(t *testing.T, db *sqlx.DB, sid int64, tag, kind string, ts time.Time, up, down int64) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO singbox_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
		VALUES (?, ?, ?, ?, ?, ?)`, sid, tag, kind, ts, up, down)
	if err != nil {
		t.Fatal(err)
	}
}

func TestSingboxTrafficQuery_ReturnsPoints(t *testing.T) {
	db, sid := setupTrafficDB(t)
	now := time.Now().UTC()
	ts := now.Add(-5 * time.Minute)
	insertRawTraffic(t, db, sid, "landing-aabb1122", "landing", ts, 1024, 2048)

	deps := plugins.Deps{DB: db}
	mux := http.NewServeMux()
	p := singbox.New()
	p.RegisterRoutes(adaptMux(mux), deps)

	from := now.Add(-10 * time.Minute).Format(time.RFC3339)
	to   := now.Format(time.RFC3339)
	url  := fmt.Sprintf("/traffic?server_id=%d&tag=landing-aabb1122&from=%s&to=%s", sid, from, to)
	req  := httptest.NewRequest("GET", url, nil)
	w    := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(w.Body).Decode(&resp)
	pts, _ := resp["points"].([]any)
	if len(pts) != 1 {
		t.Errorf("points = %d, want 1", len(pts))
	}
}

func TestSingboxTrafficBatchQuery_MultipleTags(t *testing.T) {
	db, sid := setupTrafficDB(t)
	now := time.Now().UTC()
	ts := now.Add(-5 * time.Minute)
	insertRawTraffic(t, db, sid, "landing-aabb1122", "landing", ts, 1024, 2048)
	insertRawTraffic(t, db, sid, "relay-ccdd3344",   "relay",   ts, 512,  1024)

	deps := plugins.Deps{DB: db}
	mux := http.NewServeMux()
	p := singbox.New()
	p.RegisterRoutes(adaptMux(mux), deps)

	from := now.Add(-10 * time.Minute).Format(time.RFC3339)
	to   := now.Format(time.RFC3339)
	url  := fmt.Sprintf("/traffic/batch?server_id=%d&tags=landing-aabb1122,relay-ccdd3344&from=%s&to=%s",
		sid, from, to)
	req := httptest.NewRequest("GET", url, nil)
	w   := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	_ = json.NewDecoder(w.Body).Decode(&resp)
	series, _ := resp["series"].([]any)
	if len(series) != 2 {
		t.Errorf("series = %d, want 2", len(series))
	}
}
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
go test -run TestSingboxTrafficQuery ./internal/plugins/singbox/...
```

Expected: FAIL — `/traffic` route not registered.

- [ ] **Step 3: Implement**

`internal/plugins/singbox/traffic_query.go`:

```go
package singbox

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
)

type trafficPoint struct {
	TS        time.Time `json:"ts"         db:"ts"`
	BytesUp   int64     `json:"bytes_up"   db:"bytes_up"`
	BytesDown int64     `json:"bytes_down" db:"bytes_down"`
}

type trafficSeries struct {
	Tag    string         `json:"tag"`
	Kind   string         `json:"kind"`
	Points []trafficPoint `json:"points"`
}

// chooseTable returns the appropriate singbox_traffic_* table based on the
// requested time span. Auto-resolution thresholds mirror the xray plugin:
// ≤ 2h → raw, ≤ 7d → minute, > 7d → hour.
func chooseTable(from, to time.Time, resolution string) string {
	if resolution != "" {
		switch resolution {
		case "raw":
			return "singbox_traffic_raw"
		case "minute":
			return "singbox_traffic_minute"
		case "hour":
			return "singbox_traffic_hour"
		}
	}
	span := to.Sub(from)
	switch {
	case span <= 2*time.Hour:
		return "singbox_traffic_raw"
	case span <= 7*24*time.Hour:
		return "singbox_traffic_minute"
	default:
		return "singbox_traffic_hour"
	}
}

func queryTrafficPoints(ctx interface{ Deadline() (time.Time, bool) }, db *sqlx.DB,
	r *http.Request, table, tag, kind string, serverID int64, from, to time.Time) ([]trafficPoint, error) {

	q := `SELECT ts, bytes_up, bytes_down FROM ` + table +
		` WHERE server_id = ? AND tag = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC`
	args := []any{serverID, tag, from.UTC(), to.UTC()}
	rows, err := db.QueryxContext(r.Context(), q, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var pts []trafficPoint
	for rows.Next() {
		var p trafficPoint
		if err := rows.Scan(&p.TS, &p.BytesUp, &p.BytesDown); err != nil {
			return nil, err
		}
		pts = append(pts, p)
	}
	return pts, rows.Err()
}

func parseTrafficQueryParams(r *http.Request) (serverID int64, tag, kind, resolution string, from, to time.Time, err error) {
	q := r.URL.Query()
	serverID, _ = strconv.ParseInt(q.Get("server_id"), 10, 64)
	if serverID == 0 {
		err = errParam("server_id required")
		return
	}
	tag = q.Get("tag")
	kind = q.Get("kind")
	resolution = q.Get("resolution")
	fromStr, toStr := q.Get("from"), q.Get("to")
	if fromStr == "" || toStr == "" {
		err = errParam("from and to required")
		return
	}
	from, err = time.Parse(time.RFC3339, fromStr)
	if err != nil {
		err = errParam("invalid from")
		return
	}
	to, err = time.Parse(time.RFC3339, toStr)
	if err != nil {
		err = errParam("invalid to")
	}
	return
}

type paramError string

func (e paramError) Error() string { return string(e) }

func errParam(msg string) error { return paramError(msg) }

func singboxTrafficQueryHandler(db *sqlx.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID, tag, kind, resolution, from, to, err := parseTrafficQueryParams(r)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if tag == "" {
			http.Error(w, "tag required", 400)
			return
		}
		table := chooseTable(from, to, resolution)
		pts, err := queryTrafficPoints(nil, db, r, table, tag, kind, serverID, from, to)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if pts == nil {
			pts = []trafficPoint{}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"server_id":  serverID,
			"tag":        tag,
			"kind":       kind,
			"resolution": strings.TrimPrefix(table, "singbox_traffic_"),
			"points":     pts,
		})
	}
}

func singboxTrafficBatchQueryHandler(db *sqlx.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID, _, kind, resolution, from, to, err := parseTrafficQueryParams(r)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		tagsRaw := r.URL.Query().Get("tags")
		if tagsRaw == "" {
			http.Error(w, "tags required", 400)
			return
		}
		tags := strings.Split(tagsRaw, ",")
		table := chooseTable(from, to, resolution)
		series := make([]trafficSeries, 0, len(tags))
		for _, tag := range tags {
			tag = strings.TrimSpace(tag)
			if tag == "" {
				continue
			}
			pts, err := queryTrafficPoints(nil, db, r, table, tag, kind, serverID, from, to)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			if pts == nil {
				pts = []trafficPoint{}
			}
			series = append(series, trafficSeries{Tag: tag, Kind: kind, Points: pts})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"resolution": strings.TrimPrefix(table, "singbox_traffic_"),
			"series":     series,
		})
	}
}
```

Register in `internal/plugins/singbox/routes.go` (inside `RegisterRoutes`, before the closing brace):

```go
mux.HandleFunc("GET /traffic",       singboxTrafficQueryHandler(deps.DB))
mux.HandleFunc("GET /traffic/batch", singboxTrafficBatchQueryHandler(deps.DB))
```

- [ ] **Step 4: Run test, expect PASS**

```bash
go test -run TestSingboxTrafficQuery ./internal/plugins/singbox/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/singbox/traffic_query.go \
        internal/plugins/singbox/traffic_query_test.go \
        internal/plugins/singbox/routes.go
git commit -m "feat(plugins/singbox): GET /traffic and GET /traffic/batch query endpoints"
```

---

## Task 22: Web API client — singbox types + fetchers

**Files:**
- Modify: `web/src/api/plugins.ts`

- [ ] **Step 1: Write the failing check**

```bash
cd web && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors (baseline — the new types don't exist yet but aren't imported anywhere).

- [ ] **Step 2: Implement**

Append to `web/src/api/plugins.ts`:

```typescript
// ── singbox plugin ────────────────────────────────────────────────────────────

export type SingboxProtocol =
  | 'vless-reality'
  | 'vless-ws-tls' | 'vless-h2-tls' | 'vless-httpupgrade-tls'
  | 'vmess-tcp'    | 'vmess-http'    | 'vmess-quic'
  | 'vmess-ws-tls' | 'vmess-h2-tls' | 'vmess-httpupgrade-tls'
  | 'trojan-tls'   | 'trojan-ws-tls' | 'trojan-h2-tls' | 'trojan-httpupgrade-tls'
  | 'hysteria2' | 'tuic-v5' | 'anytls' | 'shadowsocks-2022'

export interface SingboxInbound {
  id: number
  server_id: number
  tag: string
  port: number
  role: 'landing' | 'relay'
  protocol: SingboxProtocol
  uuid?: string
  flow?: string
  password?: string
  sni?: string
  cert_id?: number
  reality_public_key?: string
  reality_private_key?: string   // "[REDACTED]" in responses
  reality_short_id?: string
  reality_handshake_server?: string
  reality_handshake_port?: number
  transport_path?: string
  transport_host?: string
  alter_id?: number
  ss_method?: string
  upstream_inbound_id?: number
  extra_json?: string
  created_at: string
  updated_at: string
}

export type CreateSingboxInboundBody = Omit<SingboxInbound,
  'id' | 'tag' | 'created_at' | 'updated_at'>

export type PatchSingboxInboundBody = Partial<
  Omit<SingboxInbound, 'id' | 'tag' | 'server_id' | 'role' | 'protocol' | 'created_at' | 'updated_at'>
>

export interface SingboxCertificate {
  id: number
  domain: string
  issuer: string
  status: 'issuing' | 'active' | 'failed' | 'revoked'
  expires_at?: string
  last_renew_attempt_at?: string
  last_error?: string
  created_at: string
  updated_at: string
}

export interface IssueCertBody {
  domain: string
  challenge: 'dns-01-cf' | 'http-01'
}

export interface SingboxTrafficPoint {
  ts: string
  bytes_up: number
  bytes_down: number
}

export interface SingboxTrafficSeries {
  tag: string
  kind: string
  points: SingboxTrafficPoint[]
}

export interface SingboxTrafficResponse {
  server_id: number
  tag: string
  kind: string
  resolution: 'raw' | 'minute' | 'hour'
  points: SingboxTrafficPoint[]
}

export interface SingboxTrafficBatchResponse {
  resolution: 'raw' | 'minute' | 'hour'
  series: SingboxTrafficSeries[]
}

const SINGBOX = '/api/admin/plugins/singbox'

export const listSingboxInbounds = (serverID?: number): Promise<SingboxInbound[]> => {
  const q = serverID ? `?server_id=${serverID}` : ''
  return api.get<SingboxInbound[]>(`${SINGBOX}/inbounds${q}`)
}

export const createSingboxInbound = (body: CreateSingboxInboundBody): Promise<SingboxInbound> =>
  api.post<SingboxInbound>(`${SINGBOX}/inbounds`, body)

export const patchSingboxInbound = (id: number, body: PatchSingboxInboundBody): Promise<SingboxInbound> =>
  api.patch<SingboxInbound>(`${SINGBOX}/inbounds/${id}`, body)

export const deleteSingboxInbound = (id: number): Promise<void> =>
  api.delete(`${SINGBOX}/inbounds/${id}`)

export const patchSingboxServerVersion = (serverID: number, version: string): Promise<{ ok: boolean }> =>
  api.patch<{ ok: boolean }>(`${SINGBOX}/servers/${serverID}`, { version })

export const listSingboxCerts = (): Promise<SingboxCertificate[]> =>
  api.get<SingboxCertificate[]>(`${SINGBOX}/certificates`)

export const issueSingboxCert = (body: IssueCertBody): Promise<SingboxCertificate> =>
  api.post<SingboxCertificate>(`${SINGBOX}/certificates`, body)

export const renewSingboxCert = (id: number): Promise<{ id: number; status: string }> =>
  api.post<{ id: number; status: string }>(`${SINGBOX}/certificates/${id}/renew`, {})

export const deleteSingboxCert = (id: number): Promise<void> =>
  api.delete(`${SINGBOX}/certificates/${id}`)

export const fetchSingboxTraffic = (params: {
  server_id: number
  tag: string
  kind?: string
  from: string
  to: string
  resolution?: 'raw' | 'minute' | 'hour'
}): Promise<SingboxTrafficResponse> => {
  const q = new URLSearchParams({ server_id: String(params.server_id), tag: params.tag, from: params.from, to: params.to })
  if (params.kind)       q.set('kind', params.kind)
  if (params.resolution) q.set('resolution', params.resolution)
  return api.get<SingboxTrafficResponse>(`${SINGBOX}/traffic?${q}`)
}

export const fetchSingboxTrafficBatch = (params: {
  server_id: number
  tags: string[]
  kind?: string
  from: string
  to: string
  resolution?: 'raw' | 'minute' | 'hour'
}): Promise<SingboxTrafficBatchResponse> => {
  const q = new URLSearchParams({
    server_id: String(params.server_id),
    tags: params.tags.join(','),
    from: params.from,
    to: params.to,
  })
  if (params.kind)       q.set('kind', params.kind)
  if (params.resolution) q.set('resolution', params.resolution)
  return api.get<SingboxTrafficBatchResponse>(`${SINGBOX}/traffic/batch?${q}`)
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/api/plugins.ts
git commit -m "feat(web/api): singbox types + inbound/cert/traffic fetchers"
```

---

## Task 23: PluginRegistry + singbox plugin route stubs

**Files:**
- Modify: `web/src/pages/admin/plugins/PluginRegistry.ts`
- Create: `web/src/pages/admin/plugins/singbox/index.tsx`
- Create: `web/src/pages/admin/plugins/singbox/ConfigTab.tsx`
- Create: `web/src/pages/admin/plugins/singbox/InboundsTab.tsx`
- Create: `web/src/pages/admin/plugins/singbox/CertificatesTab.tsx`
- Create: `web/src/pages/admin/plugins/singbox/TrafficTab.tsx`
- Create: `web/src/pages/admin/plugins/singbox/EventsTab.tsx`
- Create: `web/src/pages/admin/plugins/singbox/LogsTab.tsx`

- [ ] **Step 1: Write the failing check**

```bash
cd web && npx tsc --noEmit 2>&1 | grep singbox
```

Expected BEFORE: no singbox references (the entry does not exist yet).

- [ ] **Step 2: Add registry entry**

In `web/src/pages/admin/plugins/PluginRegistry.ts`, add the singbox entry alongside the xray entry:

```typescript
singbox: {
  id: 'singbox',
  name: 'sing-box',
  tabs: ['config', 'inbounds', 'certificates', 'traffic', 'events', 'logs'],
  component: lazy(() => import('./singbox')),
},
```

- [ ] **Step 3: Create index.tsx**

`web/src/pages/admin/plugins/singbox/index.tsx`:

```tsx
import { Routes, Route, Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'

const ConfigTab       = lazy(() => import('./ConfigTab'))
const InboundsTab     = lazy(() => import('./InboundsTab'))
const CertificatesTab = lazy(() => import('./CertificatesTab'))
const TrafficTab      = lazy(() => import('./TrafficTab'))
const EventsTab       = lazy(() => import('./EventsTab'))
const LogsTab         = lazy(() => import('./LogsTab'))

export default function SingboxPlugin() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route index element={<Navigate to="config" replace />} />
        <Route path="config"       element={<ConfigTab />} />
        <Route path="inbounds"     element={<InboundsTab />} />
        <Route path="certificates" element={<CertificatesTab />} />
        <Route path="traffic"      element={<TrafficTab />} />
        <Route path="events"       element={<EventsTab />} />
        <Route path="logs"         element={<LogsTab />} />
      </Routes>
    </Suspense>
  )
}
```

- [ ] **Step 4: Create tab stubs**

Each of the six stubs (`ConfigTab.tsx`, `InboundsTab.tsx`, `CertificatesTab.tsx`, `TrafficTab.tsx`, `EventsTab.tsx`, `LogsTab.tsx`):

```tsx
// e.g. ConfigTab.tsx — replace component name in each file
export default function ConfigTab() { return null }
```

- [ ] **Step 5: Verify build**

```bash
cd web && npm run build 2>&1 | tail -5
```

Expected: build succeeds with no singbox-related errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/admin/plugins/PluginRegistry.ts \
        web/src/pages/admin/plugins/singbox/
git commit -m "feat(web/plugins/singbox): PluginRegistry entry + route stubs for all 6 tabs"
```

---

## Task 24: singbox/ConfigTab.tsx — binary version selector

**Files:**
- Modify: `web/src/pages/admin/plugins/singbox/ConfigTab.tsx`

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/admin/plugins/singbox/ConfigTab.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ConfigTab from './ConfigTab'

vi.mock('@/api/plugins', () => ({
  patchSingboxServerVersion: vi.fn().mockResolvedValue({ ok: true }),
}))

// Mock the versions endpoint via react-query
vi.mock('@tanstack/react-query', async (importActual) => {
  const actual = await importActual<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: vi.fn().mockReturnValue({
      data: { cached: [], latest: ['1.11.5', '1.11.4'] },
      isLoading: false,
    }),
  }
})

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('singbox/ConfigTab', () => {
  it('renders latest version list', async () => {
    render(<ConfigTab />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('1.11.5')).toBeTruthy()
    })
  })
})
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
cd web && npx vitest run ConfigTab
```

Expected: FAIL — ConfigTab returns null.

- [ ] **Step 3: Implement**

`web/src/pages/admin/plugins/singbox/ConfigTab.tsx`:

```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { patchSingboxServerVersion } from '@/api/plugins'
import { useServers } from '@/hooks/useServers'

interface VersionsResponse {
  cached: Array<{ version: string; os: string; arch: string }>
  latest: string[]
}

export default function ConfigTab() {
  const qc = useQueryClient()
  const { data: servers = [] } = useServers()
  const { data: versions } = useQuery<VersionsResponse>({
    queryKey: ['singbox', 'versions'],
    queryFn: () => fetch('/api/admin/plugins/singbox/versions').then(r => r.json()),
  })
  const [selected, setSelected] = useState<Record<number, string>>({})
  const deploy = useMutation({
    mutationFn: ({ serverID, version }: { serverID: number; version: string }) =>
      patchSingboxServerVersion(serverID, version),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['singbox'] }),
  })

  const allVersions = Array.from(new Set([
    ...(versions?.latest ?? []),
    ...(versions?.cached?.map(c => c.version) ?? []),
  ]))

  return (
    <div className="space-y-4 p-4">
      <h2 className="text-lg font-semibold">sing-box Binary Version</h2>
      {servers.map(s => (
        <div key={s.id} className="flex items-center gap-3">
          <span className="w-40 truncate text-sm">{s.name}</span>
          <Select
            value={selected[s.id] ?? ''}
            onValueChange={v => setSelected(prev => ({ ...prev, [s.id]: v }))}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="pick version" />
            </SelectTrigger>
            <SelectContent>
              {allVersions.map(v => (
                <SelectItem key={v} value={v}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={!selected[s.id] || deploy.isPending}
            onClick={() => deploy.mutate({ serverID: s.id, version: selected[s.id] })}
          >
            Deploy
          </Button>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Run test, expect PASS**

```bash
cd web && npx vitest run ConfigTab
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/plugins/singbox/ConfigTab.tsx \
        web/src/pages/admin/plugins/singbox/ConfigTab.test.tsx
git commit -m "feat(web/plugins/singbox): ConfigTab binary version selector"
```

---

## Task 25: singbox/InboundsTab.tsx — server-grouped with active/idle dot

**Files:**
- Create: `web/src/pages/admin/plugins/singbox/InboundsTab.tsx`
- Create: `web/src/pages/admin/plugins/singbox/InboundsTab.test.tsx`

- [ ] **Step 1: Write the failing test**

`web/src/pages/admin/plugins/singbox/InboundsTab.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import InboundsTab from './InboundsTab'
import type { SingboxInbound } from '@/api/plugins'

const mockInbounds: SingboxInbound[] = [
  {
    id: 1, server_id: 1, tag: 'landing-aabb1122', port: 443, role: 'landing',
    protocol: 'vless-reality', uuid: 'uuid-1', sni: 'www.icloud.com',
    reality_public_key: 'pubk', reality_private_key: '[REDACTED]',
    reality_short_id: 'aabb1122', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 2, server_id: 2, tag: 'relay-ccdd3344', port: 8443, role: 'relay',
    protocol: 'vless-reality', upstream_inbound_id: 1,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
]

vi.mock('@/api/plugins', () => ({
  listSingboxInbounds:   vi.fn().mockResolvedValue(mockInbounds),
  deleteSingboxInbound:  vi.fn().mockResolvedValue(undefined),
  fetchSingboxTrafficBatch: vi.fn().mockResolvedValue({ resolution: 'raw', series: [] }),
  patchSingboxServerVersion: vi.fn(),
}))

vi.mock('@/hooks/useServers', () => ({
  useServers: () => ({ data: [
    { id: 1, name: 'Server 1', ssh_host: '1.1.1.1' },
    { id: 2, name: 'Server 2', ssh_host: '2.2.2.2' },
  ]}),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('singbox/InboundsTab', () => {
  it('groups inbounds by server', async () => {
    render(<InboundsTab />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('Server 1')).toBeTruthy()
      expect(screen.getByText('Server 2')).toBeTruthy()
      expect(screen.getByText('landing-aabb1122')).toBeTruthy()
      expect(screen.getByText('relay-ccdd3344')).toBeTruthy()
    })
  })

  it('disables delete for landing with dependents', async () => {
    render(<InboundsTab />, { wrapper })
    await waitFor(() => {
      // landing-aabb1122 is upstream of relay-ccdd3344, delete must be disabled
      const deleteButtons = screen.getAllByRole('button', { name: /delete/i })
      expect(deleteButtons[0]).toBeDisabled()
    })
  })
})
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
cd web && npx vitest run InboundsTab
```

Expected: FAIL — InboundsTab returns null.

- [ ] **Step 3: Implement**

`web/src/pages/admin/plugins/singbox/InboundsTab.tsx`:

```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Sparkline } from '@/components/Sparkline'
import {
  listSingboxInbounds, deleteSingboxInbound,
  fetchSingboxTrafficBatch, patchSingboxServerVersion,
  type SingboxInbound,
} from '@/api/plugins'
import { useServers } from '@/hooks/useServers'
import InboundDialog from './InboundDialog'
import TrafficDrawer from './TrafficDrawer'

function now() { return new Date().toISOString() }
function minus2min() { return new Date(Date.now() - 2 * 60 * 1000).toISOString() }

export default function InboundsTab() {
  const qc = useQueryClient()
  const { data: servers = [] } = useServers()
  const { data: inbounds = [] } = useQuery({
    queryKey: ['singbox', 'inbounds'],
    queryFn: () => listSingboxInbounds(),
  })

  const [editTarget, setEditTarget] = useState<SingboxInbound | null>(null)
  const [createServerID, setCreateServerID] = useState<number | null>(null)
  const [drawerTarget, setDrawerTarget] = useState<{ serverID: number; tag: string } | null>(null)

  const del = useMutation({
    mutationFn: (id: number) => deleteSingboxInbound(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['singbox', 'inbounds'] }),
  })

  // Determine which landing IDs have dependent relays
  const usedLandingIDs = new Set(
    inbounds
      .filter(i => i.role === 'relay' && i.upstream_inbound_id != null)
      .map(i => i.upstream_inbound_id!)
  )

  // Per-server 2-min activity check (batch query for sparkline presence)
  const allTags = inbounds.map(i => i.tag)
  const { data: recentBatch } = useQuery({
    queryKey: ['singbox', 'traffic', 'batch2m'],
    queryFn: () =>
      allTags.length > 0
        ? fetchSingboxTrafficBatch({
            server_id: 0,  // all servers; backend ignores if tags provided
            tags: allTags,
            from: minus2min(),
            to: now(),
          })
        : Promise.resolve({ resolution: 'raw' as const, series: [] }),
    refetchInterval: 30_000,
    enabled: allTags.length > 0,
  })
  const activeTagSet = new Set(
    (recentBatch?.series ?? [])
      .filter(s => s.points.some(p => p.bytes_up + p.bytes_down > 0))
      .map(s => s.tag)
  )

  return (
    <div className="space-y-6 p-4">
      {servers.map(server => {
        const rows = inbounds.filter(i => i.server_id === server.id)
        return (
          <div key={server.id}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold">{server.name}</h3>
              <Button size="sm" variant="outline"
                onClick={() => setCreateServerID(server.id)}>
                + Inbound
              </Button>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground text-xs border-b">
                  <th className="py-1 pr-3">Tag</th>
                  <th className="py-1 pr-3">Role</th>
                  <th className="py-1 pr-3">Protocol</th>
                  <th className="py-1 pr-3">Port</th>
                  <th className="py-1 pr-3">Traffic</th>
                  <th className="py-1">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-3 font-mono text-xs">
                      <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${
                        activeTagSet.has(row.tag) ? 'bg-green-500' : 'bg-gray-300'
                      }`} />
                      {row.tag}
                    </td>
                    <td className="py-1.5 pr-3">
                      <Badge variant={row.role === 'landing' ? 'default' : 'secondary'}>
                        {row.role}
                      </Badge>
                    </td>
                    <td className="py-1.5 pr-3 text-xs">{row.protocol}</td>
                    <td className="py-1.5 pr-3">{row.port}</td>
                    <td className="py-1.5 pr-3 cursor-pointer"
                      onClick={() => setDrawerTarget({ serverID: row.server_id, tag: row.tag })}>
                      <Sparkline tag={row.tag} serverID={row.server_id} plugin="singbox" />
                    </td>
                    <td className="py-1.5 flex gap-1">
                      <Button size="sm" variant="ghost"
                        onClick={() => setEditTarget(row)}>Edit</Button>
                      <Button size="sm" variant="ghost"
                        disabled={usedLandingIDs.has(row.id)}
                        onClick={() => del.mutate(row.id)}>Delete</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}

      {(createServerID != null || editTarget != null) && (
        <InboundDialog
          serverID={createServerID ?? editTarget!.server_id}
          initial={editTarget ?? undefined}
          open
          onClose={() => { setCreateServerID(null); setEditTarget(null) }}
          onSaved={() => {
            setCreateServerID(null)
            setEditTarget(null)
            qc.invalidateQueries({ queryKey: ['singbox', 'inbounds'] })
          }}
        />
      )}

      {drawerTarget && (
        <TrafficDrawer
          open
          onOpenChange={open => { if (!open) setDrawerTarget(null) }}
          serverID={drawerTarget.serverID}
          tag={drawerTarget.tag}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run test, expect PASS**

```bash
cd web && npx vitest run InboundsTab
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/plugins/singbox/InboundsTab.tsx \
        web/src/pages/admin/plugins/singbox/InboundsTab.test.tsx
git commit -m "feat(web/plugins/singbox): InboundsTab — server-grouped with active/idle dot + sparkline"
```

---

## Task 26: singbox/InboundDialog.tsx — 18-protocol form

**Files:**
- Create: `web/src/pages/admin/plugins/singbox/InboundDialog.tsx`
- Create: `web/src/pages/admin/plugins/singbox/InboundDialog.test.tsx`

- [ ] **Step 1: Write the failing test**

`web/src/pages/admin/plugins/singbox/InboundDialog.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import InboundDialog from './InboundDialog'

const mockCerts = [
  { id: 1, domain: 'proxy.example.com', status: 'active', issuer: 'LE',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
]

vi.mock('@/api/plugins', () => ({
  listSingboxCerts:      vi.fn().mockResolvedValue(mockCerts),
  createSingboxInbound:  vi.fn().mockResolvedValue({ id: 99, tag: 'landing-new' }),
  patchSingboxInbound:   vi.fn().mockResolvedValue({ id: 1 }),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('singbox/InboundDialog', () => {
  it('shows port field for all protocols', () => {
    render(
      <InboundDialog serverID={1} open onClose={() => {}} onSaved={() => {}} />,
      { wrapper }
    )
    expect(screen.getByLabelText(/port/i)).toBeTruthy()
  })

  it('shows uuid field when protocol is vless-reality', async () => {
    render(
      <InboundDialog serverID={1} open onClose={() => {}} onSaved={() => {}} />,
      { wrapper }
    )
    // vless-reality is the default protocol; UUID field must be visible
    await waitFor(() => expect(screen.getByLabelText(/uuid/i)).toBeTruthy())
  })

  it('shows password field when protocol is trojan-tls', async () => {
    render(
      <InboundDialog serverID={1} open onClose={() => {}} onSaved={() => {}} />,
      { wrapper }
    )
    const select = screen.getByRole('combobox', { name: /protocol/i })
    fireEvent.change(select, { target: { value: 'trojan-tls' } })
    await waitFor(() => expect(screen.getByLabelText(/password/i)).toBeTruthy())
  })

  it('shows ss_method dropdown for shadowsocks-2022', async () => {
    render(
      <InboundDialog serverID={1} open onClose={() => {}} onSaved={() => {}} />,
      { wrapper }
    )
    const select = screen.getByRole('combobox', { name: /protocol/i })
    fireEvent.change(select, { target: { value: 'shadowsocks-2022' } })
    await waitFor(() => expect(screen.getByLabelText(/method/i)).toBeTruthy())
  })
})
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
cd web && npx vitest run InboundDialog
```

Expected: FAIL — InboundDialog not implemented.

- [ ] **Step 3: Implement**

`web/src/pages/admin/plugins/singbox/InboundDialog.tsx`:

```tsx
import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  listSingboxCerts, createSingboxInbound, patchSingboxInbound,
  type SingboxInbound, type SingboxProtocol,
} from '@/api/plugins'

const ALL_PROTOCOLS: SingboxProtocol[] = [
  'vless-reality',
  'vless-ws-tls', 'vless-h2-tls', 'vless-httpupgrade-tls',
  'vmess-tcp', 'vmess-http', 'vmess-quic',
  'vmess-ws-tls', 'vmess-h2-tls', 'vmess-httpupgrade-tls',
  'trojan-tls', 'trojan-ws-tls', 'trojan-h2-tls', 'trojan-httpupgrade-tls',
  'hysteria2', 'tuic-v5', 'anytls', 'shadowsocks-2022',
]

const SS_METHODS = [
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
]

function needsCert(proto: SingboxProtocol) {
  return !['vless-reality', 'vmess-tcp', 'vmess-http', 'vmess-quic', 'shadowsocks-2022'].includes(proto)
}
function needsUUID(proto: SingboxProtocol) {
  return proto.startsWith('vless-') || proto.startsWith('vmess-') || proto === 'tuic-v5'
}
function needsPassword(proto: SingboxProtocol) {
  return proto.startsWith('trojan-') || proto === 'hysteria2' || proto === 'tuic-v5' || proto === 'anytls'
}
function needsTransport(proto: SingboxProtocol) {
  return proto.includes('-ws-') || proto.includes('-h2-') || proto.includes('-httpupgrade-')
}
function needsReality(proto: SingboxProtocol) { return proto === 'vless-reality' }
function needsSS(proto: SingboxProtocol)      { return proto === 'shadowsocks-2022' }

interface Props {
  serverID: number
  initial?: SingboxInbound
  open: boolean
  onClose: () => void
  onSaved: () => void
}

export default function InboundDialog({ serverID, initial, open, onClose, onSaved }: Props) {
  const isEdit = !!initial
  const { data: certs = [] } = useQuery({
    queryKey: ['singbox', 'certs'],
    queryFn:  listSingboxCerts,
  })

  const [protocol, setProtocol] = useState<SingboxProtocol>(initial?.protocol ?? 'vless-reality')
  const [port,     setPort]     = useState(String(initial?.port ?? ''))
  const [uuid,     setUUID]     = useState(initial?.uuid ?? '')
  const [password, setPassword] = useState(initial?.password ?? '')
  const [sni,      setSNI]      = useState(initial?.sni ?? '')
  const [certID,   setCertID]   = useState(String(initial?.cert_id ?? ''))
  const [path,     setPath]     = useState(initial?.transport_path ?? '')
  const [host,     setHost]     = useState(initial?.transport_host ?? '')
  const [privKey,  setPrivKey]  = useState(initial?.reality_private_key ?? '')
  const [pubKey,   setPubKey]   = useState(initial?.reality_public_key ?? '')
  const [shortID,  setShortID]  = useState(initial?.reality_short_id ?? '')
  const [hsServer, setHSServer] = useState(initial?.reality_handshake_server ?? '')
  const [hsPort,   setHSPort]   = useState(String(initial?.reality_handshake_port ?? '443'))
  const [ssMethod, setSSMethod] = useState(initial?.ss_method ?? SS_METHODS[0])

  // Reset protocol-dependent fields when switching protocol
  useEffect(() => { setCertID('') }, [protocol])

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        server_id: serverID,
        port: Number(port),
        protocol,
      }
      if (needsUUID(protocol))      body.uuid = uuid
      if (needsPassword(protocol))  body.password = password
      if (needsCert(protocol))      { body.sni = sni; body.cert_id = Number(certID) }
      if (needsTransport(protocol)) { body.transport_path = path; body.transport_host = host }
      if (needsReality(protocol))   {
        body.sni = sni
        body.reality_private_key  = privKey
        body.reality_public_key   = pubKey
        body.reality_short_id     = shortID
        body.reality_handshake_server = hsServer
        body.reality_handshake_port   = Number(hsPort)
      }
      if (needsSS(protocol))        { body.ss_method = ssMethod; body.password = password }
      if (!isEdit)                  body.role = 'landing'

      if (isEdit) {
        return patchSingboxInbound(initial!.id, body as never)
      }
      return createSingboxInbound(body as never)
    },
    onSuccess: onSaved,
  })

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Inbound' : 'New Inbound'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ib-port">Port</Label>
              <Input id="ib-port" value={port}
                onChange={e => setPort(e.target.value)} placeholder="443" />
            </div>
            <div>
              <Label htmlFor="ib-proto">Protocol</Label>
              <select id="ib-proto" aria-label="protocol"
                className="w-full border rounded px-2 py-1.5 text-sm"
                value={protocol}
                disabled={isEdit}
                onChange={e => setProtocol(e.target.value as SingboxProtocol)}>
                {ALL_PROTOCOLS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>

          {needsUUID(protocol) && (
            <div>
              <Label htmlFor="ib-uuid">UUID</Label>
              <Input id="ib-uuid" aria-label="uuid" value={uuid}
                onChange={e => setUUID(e.target.value)} placeholder="xxxxxxxx-xxxx-..." />
            </div>
          )}

          {needsPassword(protocol) && (
            <div>
              <Label htmlFor="ib-pw">Password</Label>
              <Input id="ib-pw" aria-label="password" value={password}
                onChange={e => setPassword(e.target.value)} />
            </div>
          )}

          {needsReality(protocol) && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="ib-sni">SNI</Label>
                  <Input id="ib-sni" value={sni} onChange={e => setSNI(e.target.value)}
                    placeholder="www.icloud.com" />
                </div>
                <div>
                  <Label htmlFor="ib-sid">Short ID</Label>
                  <Input id="ib-sid" value={shortID} onChange={e => setShortID(e.target.value)}
                    placeholder="aabb1122" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="ib-hs">Handshake Host</Label>
                  <Input id="ib-hs" value={hsServer} onChange={e => setHSServer(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="ib-hp">Handshake Port</Label>
                  <Input id="ib-hp" value={hsPort} onChange={e => setHSPort(e.target.value)} />
                </div>
              </div>
              {!isEdit && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="ib-privk">Private Key</Label>
                    <Input id="ib-privk" value={privKey} onChange={e => setPrivKey(e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="ib-pubk">Public Key</Label>
                    <Input id="ib-pubk" value={pubKey} onChange={e => setPubKey(e.target.value)} />
                  </div>
                </div>
              )}
            </>
          )}

          {needsCert(protocol) && (
            <>
              <div>
                <Label htmlFor="ib-sni-tls">SNI / Domain</Label>
                <Input id="ib-sni-tls" value={sni} onChange={e => setSNI(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="ib-cert">Certificate</Label>
                <Select value={certID} onValueChange={setCertID} disabled={isEdit}>
                  <SelectTrigger id="ib-cert">
                    <SelectValue placeholder="Select certificate" />
                  </SelectTrigger>
                  <SelectContent>
                    {certs.filter(c => c.status === 'active').map(c => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.domain}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          {needsTransport(protocol) && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="ib-path">Path</Label>
                <Input id="ib-path" value={path} onChange={e => setPath(e.target.value)}
                  placeholder="/vless" />
              </div>
              <div>
                <Label htmlFor="ib-host">Host Header</Label>
                <Input id="ib-host" value={host} onChange={e => setHost(e.target.value)} />
              </div>
            </div>
          )}

          {needsSS(protocol) && (
            <div>
              <Label htmlFor="ib-ssm">Method</Label>
              <select id="ib-ssm" aria-label="method"
                className="w-full border rounded px-2 py-1.5 text-sm"
                value={ssMethod}
                onChange={e => setSSMethod(e.target.value)}>
                {SS_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Run test, expect PASS**

```bash
cd web && npx vitest run InboundDialog
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/plugins/singbox/InboundDialog.tsx \
        web/src/pages/admin/plugins/singbox/InboundDialog.test.tsx
git commit -m "feat(web/plugins/singbox): InboundDialog — 18-protocol dynamic form"
```

---

## Task 27: singbox/CertificatesTab.tsx + IssueCertDialog

**Files:**
- Create: `web/src/pages/admin/plugins/singbox/CertificatesTab.tsx`
- Create: `web/src/pages/admin/plugins/singbox/CertificatesTab.test.tsx`

- [ ] **Step 1: Write the failing test**

`web/src/pages/admin/plugins/singbox/CertificatesTab.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import CertificatesTab from './CertificatesTab'
import type { SingboxCertificate } from '@/api/plugins'

const mockCerts: SingboxCertificate[] = [
  {
    id: 1, domain: 'proxy.example.com', issuer: 'Let\'s Encrypt',
    status: 'active', expires_at: '2026-08-01T00:00:00Z',
    created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z',
  },
  {
    id: 2, domain: 'relay.example.com', issuer: 'Let\'s Encrypt',
    status: 'failed', last_error: 'DNS propagation timeout',
    created_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z',
  },
]

vi.mock('@/api/plugins', () => ({
  listSingboxCerts:    vi.fn().mockResolvedValue(mockCerts),
  issueSingboxCert:    vi.fn().mockResolvedValue({ id: 3, status: 'issuing' }),
  renewSingboxCert:    vi.fn().mockResolvedValue({ id: 1, status: 'issuing' }),
  deleteSingboxCert:   vi.fn().mockResolvedValue(undefined),
  listSingboxInbounds: vi.fn().mockResolvedValue([]),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('singbox/CertificatesTab', () => {
  it('lists certificates with domain and status', async () => {
    render(<CertificatesTab />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('proxy.example.com')).toBeTruthy()
      expect(screen.getByText('relay.example.com')).toBeTruthy()
      expect(screen.getByText('active')).toBeTruthy()
      expect(screen.getByText('failed')).toBeTruthy()
    })
  })

  it('shows issue button', async () => {
    render(<CertificatesTab />, { wrapper })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /issue/i })).toBeTruthy()
    })
  })
})
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
cd web && npx vitest run CertificatesTab
```

Expected: FAIL — CertificatesTab returns null.

- [ ] **Step 3: Implement**

`web/src/pages/admin/plugins/singbox/CertificatesTab.tsx`:

```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  listSingboxCerts, issueSingboxCert, renewSingboxCert, deleteSingboxCert,
  listSingboxInbounds, type SingboxCertificate,
} from '@/api/plugins'

function statusVariant(s: SingboxCertificate['status']) {
  return s === 'active' ? 'default'
    : s === 'failed'  ? 'destructive'
    : s === 'issuing' ? 'secondary'
    : 'outline'
}

function expiryColor(expires?: string) {
  if (!expires) return 'text-muted-foreground'
  const days = (new Date(expires).getTime() - Date.now()) / 86_400_000
  if (days < 7)  return 'text-destructive font-semibold'
  if (days < 30) return 'text-amber-600'
  return 'text-green-600'
}

function IssueCertDialog({ open, onClose, onIssued }: {
  open: boolean; onClose: () => void; onIssued: () => void
}) {
  const [domain,    setDomain]    = useState('')
  const [challenge, setChallenge] = useState<'dns-01-cf' | 'http-01'>('dns-01-cf')

  const issue = useMutation({
    mutationFn: () => issueSingboxCert({ domain, challenge }),
    onSuccess: () => { setDomain(''); onIssued() },
  })

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Issue Certificate</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="ic-domain">Domain</Label>
            <Input id="ic-domain" value={domain}
              onChange={e => setDomain(e.target.value)} placeholder="proxy.example.com" />
          </div>
          <div>
            <Label htmlFor="ic-challenge">Challenge</Label>
            <select id="ic-challenge"
              className="w-full border rounded px-2 py-1.5 text-sm"
              value={challenge}
              onChange={e => setChallenge(e.target.value as typeof challenge)}>
              <option value="dns-01-cf">DNS-01 (Cloudflare)</option>
              <option value="http-01">HTTP-01</option>
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-3">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!domain || issue.isPending}
            onClick={() => issue.mutate()}>
            {issue.isPending ? 'Issuing…' : 'Issue'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default function CertificatesTab() {
  const qc = useQueryClient()
  const { data: certs = [] } = useQuery({ queryKey: ['singbox', 'certs'], queryFn: listSingboxCerts })
  const { data: inbounds = [] } = useQuery({ queryKey: ['singbox', 'inbounds'], queryFn: listSingboxInbounds })
  const [showIssue, setShowIssue] = useState(false)

  // Cert IDs in use by any inbound
  const usedCertIDs = new Set(inbounds.map(i => i.cert_id).filter(Boolean))

  const renew = useMutation({
    mutationFn: (id: number) => renewSingboxCert(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['singbox', 'certs'] }),
  })
  const del = useMutation({
    mutationFn: (id: number) => deleteSingboxCert(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['singbox', 'certs'] }),
  })

  return (
    <div className="space-y-4 p-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">TLS Certificates</h2>
        <Button size="sm" onClick={() => setShowIssue(true)}>Issue Certificate</Button>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground border-b">
            <th className="py-1 pr-4">Domain</th>
            <th className="py-1 pr-4">Status</th>
            <th className="py-1 pr-4">Expires</th>
            <th className="py-1 pr-4">Issuer</th>
            <th className="py-1">Actions</th>
          </tr>
        </thead>
        <tbody>
          {certs.map(c => (
            <tr key={c.id} className="border-b last:border-0">
              <td className="py-2 pr-4 font-mono text-xs">{c.domain}</td>
              <td className="py-2 pr-4">
                <Badge variant={statusVariant(c.status)}
                  title={c.last_error ?? undefined}>
                  {c.status}
                </Badge>
              </td>
              <td className={`py-2 pr-4 text-xs ${expiryColor(c.expires_at)}`}>
                {c.expires_at ? new Date(c.expires_at).toLocaleDateString() : '—'}
              </td>
              <td className="py-2 pr-4 text-xs">{c.issuer}</td>
              <td className="py-2 flex gap-1">
                <Button size="sm" variant="ghost"
                  disabled={renew.isPending}
                  onClick={() => renew.mutate(c.id)}>
                  Renew
                </Button>
                <Button size="sm" variant="ghost"
                  disabled={usedCertIDs.has(c.id)}
                  onClick={() => del.mutate(c.id)}>
                  Delete
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <IssueCertDialog
        open={showIssue}
        onClose={() => setShowIssue(false)}
        onIssued={() => {
          setShowIssue(false)
          qc.invalidateQueries({ queryKey: ['singbox', 'certs'] })
        }}
      />
    </div>
  )
}
```

- [ ] **Step 4: Run test, expect PASS**

```bash
cd web && npx vitest run CertificatesTab
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/plugins/singbox/CertificatesTab.tsx \
        web/src/pages/admin/plugins/singbox/CertificatesTab.test.tsx
git commit -m "feat(web/plugins/singbox): CertificatesTab + IssueCertDialog with status pills"
```

---

## Task 28: singbox/TrafficTab.tsx + TrafficDrawer

**Files:**
- Create: `web/src/pages/admin/plugins/singbox/TrafficTab.tsx`
- Create: `web/src/pages/admin/plugins/singbox/TrafficDrawer.tsx`

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/admin/plugins/singbox/TrafficTab.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TrafficTab from './TrafficTab'
import type { SingboxInbound } from '@/api/plugins'

const mockInbounds: SingboxInbound[] = [
  { id: 1, server_id: 1, tag: 'landing-aabb1122', port: 443, role: 'landing',
    protocol: 'vless-reality', created_at: '', updated_at: '' },
]

vi.mock('@/api/plugins', () => ({
  listSingboxInbounds:      vi.fn().mockResolvedValue(mockInbounds),
  fetchSingboxTrafficBatch: vi.fn().mockResolvedValue({
    resolution: 'minute',
    series: [{ tag: 'landing-aabb1122', kind: 'landing',
      points: [{ ts: '2026-05-20T10:00:00Z', bytes_up: 1024, bytes_down: 2048 }] }],
  }),
}))

vi.mock('@/hooks/useServers', () => ({
  useServers: () => ({ data: [{ id: 1, name: 'Server 1', ssh_host: '1.1.1.1' }] }),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('singbox/TrafficTab', () => {
  it('renders per-server section with inbound rows', async () => {
    render(<TrafficTab />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('Server 1')).toBeTruthy()
      expect(screen.getByText('landing-aabb1122')).toBeTruthy()
    })
  })

  it('shows time-range selector buttons', async () => {
    render(<TrafficTab />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('1h')).toBeTruthy()
      expect(screen.getByText('24h')).toBeTruthy()
      expect(screen.getByText('7d')).toBeTruthy()
      expect(screen.getByText('30d')).toBeTruthy()
    })
  })
})
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
cd web && npx vitest run TrafficTab
```

Expected: FAIL — TrafficTab returns null.

- [ ] **Step 3: Implement TrafficDrawer**

`web/src/pages/admin/plugins/singbox/TrafficDrawer.tsx`:

```tsx
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { fetchSingboxTraffic } from '@/api/plugins'

type Range = '1h' | '24h' | '7d' | '30d'

function rangeToParams(range: Range) {
  const to = new Date()
  const from = new Date(to)
  const res = range === '1h' ? 'raw' : range === '24h' ? 'minute' : 'hour'
  if (range === '1h')  from.setHours(to.getHours() - 1)
  if (range === '24h') from.setDate(to.getDate() - 1)
  if (range === '7d')  from.setDate(to.getDate() - 7)
  if (range === '30d') from.setDate(to.getDate() - 30)
  return { from: from.toISOString(), to: to.toISOString(), resolution: res as 'raw' | 'minute' | 'hour' }
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverID: number
  tag: string
}

export default function TrafficDrawer({ open, onOpenChange, serverID, tag }: Props) {
  const [range, setRange] = useState<Range>('1h')
  const params = rangeToParams(range)

  const { data } = useQuery({
    queryKey: ['singbox', 'traffic', serverID, tag, range],
    queryFn: () => fetchSingboxTraffic({ server_id: serverID, tag, ...params }),
    enabled: open,
  })

  const points = (data?.points ?? []).map(p => ({
    ts: new Date(p.ts).toLocaleTimeString(),
    up:   Math.round(p.bytes_up   / 1024),
    down: Math.round(p.bytes_down / 1024),
  }))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[480px]">
        <SheetHeader>
          <SheetTitle className="font-mono text-sm">{tag}</SheetTitle>
        </SheetHeader>
        <div className="flex gap-1 my-3">
          {(['1h', '24h', '7d', '30d'] as Range[]).map(r => (
            <Button key={r} size="sm"
              variant={range === r ? 'default' : 'outline'}
              onClick={() => setRange(r)}>
              {r}
            </Button>
          ))}
        </div>
        <ResponsiveContainer width="100%" height={250}>
          <AreaChart data={points}>
            <XAxis dataKey="ts" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} unit=" KB" />
            <Tooltip formatter={(v: number) => `${v} KB`} />
            <Area type="monotone" dataKey="up"   stroke="#3b82f6" fill="#bfdbfe" name="Upload" />
            <Area type="monotone" dataKey="down" stroke="#10b981" fill="#a7f3d0" name="Download" />
          </AreaChart>
        </ResponsiveContainer>
      </SheetContent>
    </Sheet>
  )
}
```

Note: duplication with `xray/TrafficDrawer` is intentional at this stage — see §10 cleanup note in Self-Review Notes.

- [ ] **Step 4: Implement TrafficTab**

`web/src/pages/admin/plugins/singbox/TrafficTab.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { listSingboxInbounds, fetchSingboxTrafficBatch, type SingboxInbound } from '@/api/plugins'
import { useServers } from '@/hooks/useServers'
import TrafficDrawer from './TrafficDrawer'

type Range = '1h' | '24h' | '7d' | '30d'

function toParams(range: Range) {
  const to = new Date()
  const from = new Date(to)
  const res = range === '1h' ? 'raw' : range === '24h' ? 'minute' : 'hour'
  if (range === '1h')  from.setHours(to.getHours() - 1)
  if (range === '24h') from.setDate(to.getDate() - 1)
  if (range === '7d')  from.setDate(to.getDate() - 7)
  if (range === '30d') from.setDate(to.getDate() - 30)
  return { from: from.toISOString(), to: to.toISOString(), resolution: res as 'raw' | 'minute' | 'hour' }
}

function fmtBytes(n: number) {
  if (n > 1_073_741_824) return (n / 1_073_741_824).toFixed(1) + ' GB'
  if (n > 1_048_576)     return (n / 1_048_576).toFixed(1)     + ' MB'
  if (n > 1024)          return (n / 1024).toFixed(1)          + ' KB'
  return n + ' B'
}

export default function TrafficTab() {
  const [range, setRange] = useState<Range>('24h')
  const [drawer, setDrawer] = useState<{ serverID: number; tag: string } | null>(null)

  const { data: servers = [] }  = useServers()
  const { data: inbounds = [] } = useQuery({
    queryKey: ['singbox', 'inbounds'],
    queryFn: listSingboxInbounds,
  })

  const params = toParams(range)
  const allTags = inbounds.map(i => i.tag)

  const { data: batch } = useQuery({
    queryKey: ['singbox', 'traffic', 'tab', range],
    queryFn: () =>
      allTags.length > 0
        ? fetchSingboxTrafficBatch({ server_id: 0, tags: allTags, ...params })
        : Promise.resolve({ resolution: 'raw' as const, series: [] }),
    enabled: allTags.length > 0,
    refetchInterval: 60_000,
  })

  const totals = Object.fromEntries(
    (batch?.series ?? []).map(s => [
      s.tag,
      {
        up:    s.points.reduce((a, p) => a + p.bytes_up,   0),
        down:  s.points.reduce((a, p) => a + p.bytes_down, 0),
        total: s.points.reduce((a, p) => a + p.bytes_up + p.bytes_down, 0),
      },
    ])
  )

  return (
    <div className="space-y-6 p-4">
      <div className="flex gap-1">
        {(['1h', '24h', '7d', '30d'] as Range[]).map(r => (
          <Button key={r} size="sm"
            variant={range === r ? 'default' : 'outline'}
            onClick={() => setRange(r)}>
            {r}
          </Button>
        ))}
      </div>

      {servers.map(server => {
        const rows = inbounds.filter(i => i.server_id === server.id)
        if (rows.length === 0) return null
        return (
          <div key={server.id}>
            <h3 className="font-semibold mb-2">{server.name}</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b text-left">
                  <th className="py-1 pr-4">Tag</th>
                  <th className="py-1 pr-4">Role</th>
                  <th className="py-1 pr-4">Uplink</th>
                  <th className="py-1 pr-4">Downlink</th>
                  <th className="py-1">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const t = totals[row.tag]
                  return (
                    <tr key={row.id}
                      className="border-b last:border-0 cursor-pointer hover:bg-muted/30"
                      onClick={() => setDrawer({ serverID: row.server_id, tag: row.tag })}>
                      <td className="py-2 pr-4 font-mono text-xs">{row.tag}</td>
                      <td className="py-2 pr-4 text-xs">{row.role}</td>
                      <td className="py-2 pr-4 text-xs">{t ? fmtBytes(t.up)    : '—'}</td>
                      <td className="py-2 pr-4 text-xs">{t ? fmtBytes(t.down)  : '—'}</td>
                      <td className="py-2 text-xs">     {t ? fmtBytes(t.total) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      })}

      {drawer && (
        <TrafficDrawer
          open
          onOpenChange={open => { if (!open) setDrawer(null) }}
          serverID={drawer.serverID}
          tag={drawer.tag}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 5: Run test, expect PASS**

```bash
cd web && npx vitest run TrafficTab
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/admin/plugins/singbox/TrafficTab.tsx \
        web/src/pages/admin/plugins/singbox/TrafficTab.test.tsx \
        web/src/pages/admin/plugins/singbox/TrafficDrawer.tsx
git commit -m "feat(web/plugins/singbox): TrafficTab + TrafficDrawer with time-range selector and area chart"
```

---

## Task 29: Full Go CI gate

**Files:** none (verification only)

- [ ] **Step 1: Run full Go test suite**

```bash
go test -count=1 ./...
```

Expected: all PASS.

- [ ] **Step 2: Verify build**

```bash
go build ./...
```

Expected: no errors.

- [ ] **Step 3: Run linter**

```bash
golangci-lint run --timeout=5m
```

Expected: no new lint errors introduced by this branch.

- [ ] **Step 4: Fix any failures**

Common issues to check:
- Unused imports in `cmd/server/main.go` after wiring rollup + certmgr.
- `singboxTrafficQueryHandler` uses a `context.Context`-shaped parameter that is never used — simplify the function signature.
- Missing `"fmt"` imports in test files that use `fmt.Errorf`.

---

## Task 30: Full web CI gate

**Files:** none (verification only)

- [ ] **Step 1: Run vitest**

```bash
cd web && npx vitest run
```

Expected: all PASS.

- [ ] **Step 2: Run production build**

```bash
cd web && npm run build
```

Expected: build succeeds. Restore `internal/web/dist/.gitkeep` if the build step removed it.

- [ ] **Step 3: Fix any failures**

Common issues to check:
- `Sparkline` component may not accept a `plugin` prop yet — check the xray version's props and extend if needed (or pass `plugin="singbox"` only if Sparkline supports it; otherwise wire `fetchSingboxTrafficBatch` directly in InboundsTab).
- `useServers` hook may not exist — check xray's equivalent and either import it or create a minimal version.
- recharts import may need `"recharts"` added to `web/package.json` if not already present from the xray plan.

---

## Task 31: E2E smoke test checklist + PR (manual)

This task is executed by a human operator against a staging environment. No code changes.

**Pre-merge manual smoke checklist:**

1. Enable the singbox plugin from the Plugins page. Verify it appears under "Active Plugins" in the sidebar.
2. Navigate to sing-box → Config tab. Select a version (e.g. 1.11.5) for a test server. Click Deploy. Wait ~10s, verify the server status transitions to `running`.
3. Navigate to sing-box → Certificates. Click "Issue Certificate". Enter a domain, select DNS-01 (Cloudflare). Verify status transitions from `issuing` → `active` within ~60s. (Use `http-01` if no CF token configured.)
4. Navigate to sing-box → Inbounds. Click "+ Inbound" for the test server. Select `vless-reality`, fill port + SNI + keys. Save. Verify the row appears with `landing` badge.
5. Create a second inbound with protocol `hysteria2`, set `cert_id` to the cert from step 3. Save. Verify `cert_id` is populated.
6. Create a relay inbound pointing at the VLESS-REALITY landing. Verify it saves and shows `relay` badge.
7. Connect a client to the landing inbound. Generate ~1 MB traffic. Wait 30s. Verify the active/idle dot on the Inbounds row turns green.
8. Navigate to Traffic tab. Select "1h". Verify the landing row shows non-zero Uplink / Downlink. Click the row to open TrafficDrawer and verify the area chart renders.
9. Verify SQLite directly: `SELECT * FROM singbox_traffic_raw LIMIT 5;` — rows must exist with the landing tag. Verify xray_traffic_raw has NOT been written to.
10. Attempt to delete the cert while the hysteria2 inbound references it. Verify 409 response with `inbound_ids`.
11. Delete the hysteria2 inbound first, then delete the cert. Verify 204.
12. Renew the cert manually from the Certificates tab. Verify status briefly shows `issuing` then returns to `active`.
13. Open a PR with base=main.

**PR details:**

Title: `feat(singbox): sing-box plugin — 18 protocols, ACME certs, clash-api traffic monitoring`

Body:

```
## Summary

- New `internal/plugins/singbox/` package: 18-protocol inbound catalog,
  server-side config renderer, /inbounds + /certificates CRUD, /traffic + /traffic/batch endpoints
- New `internal/singbox/certmgr/` package: ACME certificate issuance + daily renewal via go-acme/lego
- New `internal/agent/singboxsampler/` package: 30s clash-api polling with delta computation
- New `SingboxTrafficBatch` WS envelope, `singbox_traffic_raw/minute/hour` tables, rollup goroutine
- New frontend: 6-tab plugin layout (Config / Inbounds / Certificates / Traffic / Events / Logs)
  with 18-protocol InboundDialog, CertificatesTab + IssueCertDialog, TrafficTab + TrafficDrawer

## Pre-merge checklist

- [ ] `go test -count=1 ./...` passes (Task 29)
- [ ] `go build ./...` passes (Task 29)
- [ ] `golangci-lint run` passes (Task 29)
- [ ] `npx vitest run` passes (Task 30)
- [ ] `npm run build` passes (Task 30)
- [ ] Manual smoke steps 1–12 completed (Task 31)
```

---

## Self-Review Notes

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1.1 deliverables — plugin package + lifecycle | Task 1 |
| §1.1 deliverables — migrations (4 files) | Task 2 |
| §2.1 singbox_inbounds schema | Task 2 |
| §2.3 singbox_traffic_* tables | Task 2 |
| §2.4 singbox_certificates table | Task 2 |
| §3 protocol catalog (18 protocols) | Task 7 (render) + Task 26 (UI dialog) |
| §1.1 Inbound DAO | Task 3 |
| §1.1 binary fetch + Releaser | Task 4 |
| §1.1 CertStore DAO | Task 5 |
| §1.1 ACME certmgr | Task 6 |
| §1.1 RenderServerConfig (all 18 protocols) | Task 7 + Task 8 |
| §1.1 AssembleAndDeploy (cert push + config push + restart) | Task 9 |
| §1.1 lifecycle (Deploy/Undeploy/Status/LogStream) | Task 10 |
| §1.1 /inbounds CRUD + clash-api port guard | Task 11 + Task 12 |
| §1.1 /versions + PATCH /servers/:id + /certificates routes | Task 13 |
| §1.1 SingboxTrafficBatch WS envelope | Task 14 |
| §1.1 singboxsampler parse | Task 15 |
| §1.1 singboxsampler loop | Task 16 |
| §1.1 agent wiring | Task 17 |
| §1.1 server ingest + HandleFrame dispatch | Task 18 |
| §1.1 SingboxTrafficRollup goroutine | Task 19 + Task 20 |
| §1.1 cert renewal goroutine | Task 20 |
| §1.1 /traffic + /traffic/batch endpoints | Task 21 |
| §1.1 PluginRegistry + frontend tabs | Tasks 22–28 |

**Placeholder scan:** none. All stubs in Task 23 are explicitly replaced in Tasks 24–28.

**Type consistency:**

- Go: `Inbound` (struct, inbounds.go) → `InboundView` (ListAllWithUpstream) → `InboundPatch` (Update) → handler maps (inbounds_routes.go) → `SingboxInbound` (TS). Verify `cert_id` is `*int64` in Go, `number | undefined` in TS.
- `CertStore.UpsertCert` / `UpsertStatus` signatures match `certmgr.CertStoreWriter` interface.
- `SingboxTrafficSample.Kind` values: Go uses "landing"/"relay"; TS `SingboxCertificate.status` enum is separate — no collision.
- `certmgr.Manager.Renew(ctx, certID)` — Task 13's `certIssuer` interface declares `Renew(ctx, certID int64) error` (no domain/challenge args); `certmgr.Manager.Renew` signature in Task 6 takes `(ctx, certID, domain, challenge, email)`. Reconcile: cert_routes.go's `renewCert` must look up domain + challenge from the DB row before calling `mgr.Renew`, OR the `certIssuer` interface's Renew should take only `certID` and certmgr.Manager.Renew looks up the row itself. The simpler fix: `certIssuer.Renew(ctx, certID)` and `certmgr.Manager` Renew queries the DB for domain/challenge. Ensure this is consistent before committing Task 13.

**Known follow-ups (not blocking):**

- Refactor `TrafficDrawer` (singbox) and `xray/TrafficDrawer` into a shared `internal/web/components/TrafficDrawer` once both plugins stabilize.
- Extract `rollupRawToMinute` / `rollupMinuteToHour` SQL patterns into a shared `telemetrysvc.RollupHelper(tablePrefix)` function after both xray and singbox rollups are proven correct.
- Rename `singbox_traffic_*` / `xray_traffic_*` to `proxy_traffic_*` with a `plugin_id` column (single-table approach) after adoption is confirmed.
- ACME EAB support; wildcard certs; cert revocation via lego.
- Cross-plugin topology (singbox relay → xray landing) — requires proxycore abstraction.
- Encrypted-at-rest for `reality_private_key` and `cert_pem` / `key_pem`.

---
