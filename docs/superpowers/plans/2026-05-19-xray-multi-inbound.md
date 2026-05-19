# xray Multi-Inbound (Phase 3c-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the xray plugin from "one server = one inbound" to "one server = one xray process with N inbounds", with per-inbound topology (relay→landing at inbound granularity), stable per-inbound tags, and a server-side config renderer.

**Architecture:** New `xray_inbounds` table holds one row per inbound; `xray_inbounds.upstream_inbound_id` self-references for topology (RESTRICT prevents deleting a landing-inbound with dependent relays). `plugin_hosts` degrades to server-level xray process state. Render moves from frontend to server (so private keys never leave DB and multi-inbound assembly can JOIN). All inbound CRUD goes through new `/api/admin/plugins/xray/inbounds*` endpoints; each mutation reassembles the full server config and restarts xray on that host.

**Tech Stack:** Go 1.25 / sqlx / SQLite / React 19 + TS + Tailwind + shadcn/ui + react-query. Reference spec: `docs/superpowers/specs/2026-05-19-xray-multi-inbound-design.md`.

---

## File Map

**Create:**
- `internal/plugins/xray/migrations/0003_multi_inbound.up.sql` — schema only (no data)
- `internal/plugins/xray/migrations/0003_multi_inbound.down.sql`
- `internal/plugins/xray/inbounds.go` — `Inbound` struct + `InboundStore` DAO (CRUD + ListByServer + GetByID + tag generator)
- `internal/plugins/xray/inbounds_test.go`
- `internal/plugins/xray/migrate_0003.go` — Go-level data migration that runs once at server boot, after SQL migrations, populating `xray_inbounds` from legacy `plugin_hosts.config` + `xray_host_topology`
- `internal/plugins/xray/migrate_0003_test.go`
- `internal/plugins/xray/render.go` — `RenderServerConfig(inbounds []InboundView) ([]byte, error)`
- `internal/plugins/xray/render_test.go`
- `internal/plugins/xray/inbounds_routes.go` — handlers for POST/GET/PATCH/DELETE /inbounds + PATCH /servers/:id/version
- `internal/plugins/xray/inbounds_routes_test.go`
- `internal/plugins/xray/deploy_server.go` — `assembleAndDeploy(serverID)`: SELECT inbounds → render → push → restart (or stop if zero inbounds)
- `internal/plugins/xray/deploy_server_test.go`
- `web/src/pages/admin/plugins/xray/InboundsTab.tsx`
- `web/src/pages/admin/plugins/xray/InboundsTab.test.tsx`
- `web/src/pages/admin/plugins/xray/InboundDialog.tsx`
- `web/src/pages/admin/plugins/xray/InboundDialog.test.tsx`

**Modify:**
- `internal/plugins/xray/migrations.go` — register `0003_multi_inbound.up.sql`
- `internal/plugins/xray/xray.go` — drop existing `BeforeDeploy`/`AfterDeploy`/`BeforeUndeploy` (server-level topology validators); reshape `Plugin` to no longer implement those interfaces; add server-boot hook that runs `Migrate0003`
- `internal/plugins/xray/routes.go` — register new inbounds routes; mark old topology route 410
- `internal/api/plugins.go` — `PostHost`/`DeleteHost` for plugin `xray` return 410 Gone (only when plugin id is xray; other plugins unaffected)
- `internal/api/plugins_test.go` — assert 410 for old xray endpoints
- `cmd/server/main.go` — call `xray.Migrate0003(db)` after `RunPluginMigrations` for enabled plugins
- `web/src/api/plugins.ts` — add `XrayInbound` type, `listXrayInbounds`, `createXrayInbound`, `patchXrayInbound`, `deleteXrayInbound`, `patchXrayServerVersion`; deprecate `XrayTopologyRow`/`fetchXrayTopology`/old deploy helpers (delete after Task 13)
- `web/src/pages/admin/plugins/xray/BulkRelayDialog.tsx` — switch to inbound-level (Props change, target list shape, deploy call)
- `web/src/pages/admin/plugins/xray/BulkRelayDialog.test.tsx` — update mocks/fixtures
- `web/src/pages/admin/plugins/xray/index.tsx` — remove HostsTab from tab order, add InboundsTab
- `web/src/pages/admin/plugins/xray/templates.ts` — keep only `buildShareURL` + helpers; remove `renderTemplate`/`parseConfig`/`vlessReality`/`vmessWS` (no longer used)
- `web/src/pages/admin/plugins/xray/templates.test.ts` — drop tests for removed functions
- Delete: `web/src/pages/admin/plugins/xray/HostsTab.tsx`, `HostsTab.test.tsx`, `DeployDialog.tsx` (Task 13)

---

## Task 1: Migration 0003 — `xray_inbounds` schema

**Files:**
- Create: `internal/plugins/xray/migrations/0003_multi_inbound.up.sql`
- Create: `internal/plugins/xray/migrations/0003_multi_inbound.down.sql`
- Modify: `internal/plugins/xray/migrations.go` (add 0003 to names slice)
- Modify: `internal/plugins/xray/xray_test.go` (add migration test)

This task creates the schema only. Data migration is Task 3.

- [ ] **Step 1: Write the failing test**

Append to `internal/plugins/xray/xray_test.go`:

```go
func TestMigration0003_CreatesInboundsTable(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "p.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil { t.Fatal(err) }
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil { t.Fatal(err) }
	if err := plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations()); err != nil {
		t.Fatal(err)
	}

	// xray_inbounds table exists and has the expected columns
	var n int
	if err := d.Get(&n,
		"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='xray_inbounds'"); err != nil {
		t.Fatal(err)
	}
	if n != 1 { t.Fatalf("xray_inbounds table not created") }

	// Seed two servers for the constraint test
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_password,ssh_port,created_at,updated_at)
		VALUES (1,'s1','1.1.1.1','r','x',22,?,?), (2,'s2','2.2.2.2','r','x',22,?,?)`,
		time.Now(), time.Now(), time.Now(), time.Now())

	// CHECK constraint: landing must have NULL upstream
	_, err = d.Exec(`INSERT INTO xray_inbounds(server_id, tag, port, role, upstream_inbound_id, updated_at)
		VALUES (1, 'landing-aaaa', 443, 'landing', 99, ?)`, time.Now())
	if err == nil {
		t.Fatalf("expected CHECK violation when landing has upstream, got nil")
	}

	// CHECK constraint: relay must have non-NULL upstream
	_, err = d.Exec(`INSERT INTO xray_inbounds(server_id, tag, port, role, upstream_inbound_id, updated_at)
		VALUES (1, 'relay-bbbb', 444, 'relay', NULL, ?)`, time.Now())
	if err == nil {
		t.Fatalf("expected CHECK violation when relay has NULL upstream, got nil")
	}

	// Insert a valid landing then a valid relay pointing at it
	d.MustExec(`INSERT INTO xray_inbounds(server_id, tag, port, role, updated_at)
		VALUES (1, 'landing-cccc', 443, 'landing', ?)`, time.Now())
	var landingID int64
	_ = d.Get(&landingID, `SELECT id FROM xray_inbounds WHERE tag='landing-cccc'`)
	d.MustExec(`INSERT INTO xray_inbounds(server_id, tag, port, role, upstream_inbound_id, updated_at)
		VALUES (2, 'relay-dddd', 8443, 'relay', ?, ?)`, landingID, time.Now())

	// RESTRICT: deleting landing while relay depends on it must fail
	_, err = d.Exec(`DELETE FROM xray_inbounds WHERE id=?`, landingID)
	if err == nil {
		t.Fatalf("expected RESTRICT to block landing delete with dependent relay")
	}

	// UNIQUE(server_id, port)
	_, err = d.Exec(`INSERT INTO xray_inbounds(server_id, tag, port, role, updated_at)
		VALUES (1, 'landing-eeee', 443, 'landing', ?)`, time.Now())
	if err == nil { t.Fatalf("expected UNIQUE(server_id,port) violation") }

	// UNIQUE(server_id, tag)
	_, err = d.Exec(`INSERT INTO xray_inbounds(server_id, tag, port, role, updated_at)
		VALUES (1, 'landing-cccc', 9443, 'landing', ?)`, time.Now())
	if err == nil { t.Fatalf("expected UNIQUE(server_id,tag) violation") }
}
```

- [ ] **Step 2: Run test to verify it fails**

```
go test -run TestMigration0003_CreatesInboundsTable ./internal/plugins/xray/...
```

Expected: FAIL — `xray_inbounds` table doesn't exist yet.

- [ ] **Step 3: Create the up migration**

`internal/plugins/xray/migrations/0003_multi_inbound.up.sql`:

```sql
CREATE TABLE IF NOT EXISTS xray_inbounds (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id            INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag                  TEXT    NOT NULL,
  port                 INTEGER NOT NULL,
  role                 TEXT    NOT NULL CHECK (role IN ('landing', 'relay')),
  protocol             TEXT    NOT NULL DEFAULT 'vless-reality',
  uuid                 TEXT,
  sni                  TEXT,
  public_key           TEXT,
  private_key          TEXT,
  short_id             TEXT,
  ws_path              TEXT,
  ss_method            TEXT,
  ss_password          TEXT,
  upstream_inbound_id  INTEGER REFERENCES xray_inbounds(id) ON DELETE RESTRICT,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (role = 'landing' AND upstream_inbound_id IS NULL) OR
    (role = 'relay'   AND upstream_inbound_id IS NOT NULL)
  ),
  UNIQUE (server_id, tag),
  UNIQUE (server_id, port)
);

CREATE INDEX IF NOT EXISTS xray_inbounds_server   ON xray_inbounds(server_id);
CREATE INDEX IF NOT EXISTS xray_inbounds_upstream ON xray_inbounds(upstream_inbound_id);

-- xray_host_topology is replaced by xray_inbounds.upstream_inbound_id.
-- It is intentionally NOT dropped here; v0.4.0 will drop it via 0004_cleanup.up.sql
-- to give two release windows for any external code that still reads it.
```

- [ ] **Step 4: Create the down migration**

`internal/plugins/xray/migrations/0003_multi_inbound.down.sql`:

```sql
DROP INDEX IF EXISTS xray_inbounds_upstream;
DROP INDEX IF EXISTS xray_inbounds_server;
DROP TABLE IF EXISTS xray_inbounds;
```

- [ ] **Step 5: Register 0003 in loader**

Edit `internal/plugins/xray/migrations.go`:

```go
names := []string{
	"0001_xray.up.sql",
	"0002_topology.up.sql",
	"0003_multi_inbound.up.sql",
}
```

- [ ] **Step 6: Run test to verify pass**

```
go test -run TestMigration0003 ./internal/plugins/xray/...
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/plugins/xray/migrations/0003_multi_inbound.up.sql \
        internal/plugins/xray/migrations/0003_multi_inbound.down.sql \
        internal/plugins/xray/migrations.go \
        internal/plugins/xray/xray_test.go
git commit -m "feat(plugins/xray): 0003 migration creates xray_inbounds with CHECK/UNIQUE/RESTRICT"
```

---

## Task 2: `InboundStore` DAO

**Files:**
- Create: `internal/plugins/xray/inbounds.go`
- Create: `internal/plugins/xray/inbounds_test.go`

- [ ] **Step 1: Write failing tests**

`internal/plugins/xray/inbounds_test.go`:

```go
package xray

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func newInboundStore(t *testing.T) *InboundStore {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "i.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil { t.Fatal(err) }
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil { t.Fatal(err) }
	if err := plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations()); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{1, 2, 3} {
		d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_password,ssh_port,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?)`,
			id, "s"+string(rune('0'+id)), "1.2.3."+string(rune('0'+id)), "root", "x", 22, time.Now(), time.Now())
	}
	return &InboundStore{DB: d, Now: time.Now}
}

func TestInboundStore_GenerateTag(t *testing.T) {
	s := newInboundStore(t)
	tag := s.GenerateTag("landing")
	if len(tag) != len("landing-")+8 { t.Fatalf("tag length: %q", tag) }
	if tag[:8] != "landing-" { t.Fatalf("tag prefix: %q", tag) }
	tag2 := s.GenerateTag("relay")
	if tag2[:6] != "relay-" { t.Fatalf("relay tag prefix: %q", tag2) }
	if tag == tag2 { t.Fatalf("tags should differ: %q vs %q", tag, tag2) }
}

func TestInboundStore_InsertLandingThenRelay(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	landingID, err := s.Insert(ctx, Inbound{
		ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443, Role: "landing",
		Protocol: "vless-reality",
		UUID: "u1", SNI: "www.lovelive-anime.jp", PublicKey: "P", PrivateKey: "K", ShortID: "aa",
	})
	if err != nil { t.Fatal(err) }
	if landingID == 0 { t.Fatalf("landingID 0") }

	relayID, err := s.Insert(ctx, Inbound{
		ServerID: 2, Tag: s.GenerateTag("relay"), Port: 8443, Role: "relay",
		Protocol: "vless-reality",
		UUID: "u2", SNI: "www.microsoft.com", PublicKey: "P2", PrivateKey: "K2", ShortID: "bb",
		UpstreamInboundID: &landingID,
	})
	if err != nil { t.Fatal(err) }

	row, err := s.GetByID(ctx, relayID)
	if err != nil { t.Fatal(err) }
	if row.Role != "relay" || row.UpstreamInboundID == nil || *row.UpstreamInboundID != landingID {
		t.Fatalf("relay row = %+v", row)
	}
}

func TestInboundStore_ListByServer(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	_, _ = s.Insert(ctx, Inbound{ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality"})
	_, _ = s.Insert(ctx, Inbound{ServerID: 1, Tag: s.GenerateTag("landing"), Port: 8443, Role: "landing", Protocol: "vless-reality"})
	_, _ = s.Insert(ctx, Inbound{ServerID: 2, Tag: s.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality"})

	rows, err := s.ListByServer(ctx, 1)
	if err != nil { t.Fatal(err) }
	if len(rows) != 2 { t.Fatalf("got %d rows for server 1, want 2", len(rows)) }
}

func TestInboundStore_ListWithUpstream(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	landingID, _ := s.Insert(ctx, Inbound{ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality",
		UUID: "lu", SNI: "www.lovelive-anime.jp", PublicKey: "LP", ShortID: "ll"})
	_, _ = s.Insert(ctx, Inbound{ServerID: 2, Tag: s.GenerateTag("relay"), Port: 8443, Role: "relay", Protocol: "vless-reality",
		UpstreamInboundID: &landingID})

	views, err := s.ListAllWithUpstream(ctx)
	if err != nil { t.Fatal(err) }
	if len(views) != 2 { t.Fatalf("views = %d want 2", len(views)) }
	var relay *InboundView
	for i := range views {
		if views[i].Role == "relay" { relay = &views[i]; break }
	}
	if relay == nil { t.Fatalf("no relay view") }
	if relay.UpstreamTag.String == "" || relay.UpstreamServerName.String != "s1" {
		t.Fatalf("relay view missing JOIN: %+v", relay)
	}
}

func TestInboundStore_Update_DoesNotChangeRoleOrUpstream(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	id, _ := s.Insert(ctx, Inbound{ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality",
		UUID: "u", SNI: "s", PublicKey: "P", PrivateKey: "K", ShortID: "aa"})
	// Update changes mutable fields only
	if err := s.Update(ctx, id, InboundPatch{
		Port: ptrInt(8443), UUID: ptrString("u2"), SNI: ptrString("s2"),
	}); err != nil { t.Fatal(err) }
	row, _ := s.GetByID(ctx, id)
	if row.Port != 8443 || row.UUID != "u2" || row.SNI != "s2" {
		t.Fatalf("update did not apply: %+v", row)
	}
	if row.Role != "landing" {
		t.Fatalf("role changed unexpectedly: %s", row.Role)
	}
}

func TestInboundStore_Delete_RestrictsLandingWithRelay(t *testing.T) {
	s := newInboundStore(t)
	ctx := context.Background()
	landingID, _ := s.Insert(ctx, Inbound{ServerID: 1, Tag: s.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality"})
	_, _ = s.Insert(ctx, Inbound{ServerID: 2, Tag: s.GenerateTag("relay"), Port: 8443, Role: "relay", Protocol: "vless-reality",
		UpstreamInboundID: &landingID})
	if err := s.Delete(ctx, landingID); err == nil {
		t.Fatalf("expected RESTRICT error deleting landing with relay dependent")
	}
}

func ptrInt(v int) *int       { return &v }
func ptrString(v string) *string { return &v }
```

- [ ] **Step 2: Run tests to verify failure**

```
go test -run TestInboundStore ./internal/plugins/xray/...
```

Expected: FAIL — `InboundStore` doesn't exist.

- [ ] **Step 3: Implement DAO**

`internal/plugins/xray/inbounds.go`:

```go
package xray

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

type Inbound struct {
	ID                int64  `db:"id"`
	ServerID          int64  `db:"server_id"`
	Tag               string `db:"tag"`
	Port              int    `db:"port"`
	Role              string `db:"role"`
	Protocol          string `db:"protocol"`
	UUID              string `db:"uuid"`
	SNI               string `db:"sni"`
	PublicKey         string `db:"public_key"`
	PrivateKey        string `db:"private_key"`
	ShortID           string `db:"short_id"`
	WSPath            string `db:"ws_path"`
	SSMethod          string `db:"ss_method"`
	SSPassword        string `db:"ss_password"`
	UpstreamInboundID *int64 `db:"upstream_inbound_id"`
	CreatedAt         time.Time `db:"created_at"`
	UpdatedAt         time.Time `db:"updated_at"`
}

// InboundView extends Inbound with JOIN fields used when the row is rendered
// for the UI or for config assembly. Upstream fields are populated only for
// relay rows (NULL otherwise).
type InboundView struct {
	Inbound
	ServerName         string         `db:"server_name"`
	UpstreamTag        sql.NullString `db:"upstream_tag"`
	UpstreamPort       sql.NullInt64  `db:"upstream_port"`
	UpstreamServerID   sql.NullInt64  `db:"upstream_server_id"`
	UpstreamServerName sql.NullString `db:"upstream_server_name"`
	UpstreamSNI        sql.NullString `db:"upstream_sni"`
	UpstreamUUID       sql.NullString `db:"upstream_uuid"`
	UpstreamPublicKey  sql.NullString `db:"upstream_public_key"`
	UpstreamShortID    sql.NullString `db:"upstream_short_id"`
	UpstreamAddress    sql.NullString `db:"upstream_address"` // upstream server.ssh_host
}

// InboundPatch is the set of mutable fields for Update. nil pointer = leave unchanged.
// role / server_id / tag / upstream_inbound_id / protocol are NOT in this struct
// because they are immutable post-create.
type InboundPatch struct {
	Port       *int
	UUID       *string
	SNI        *string
	PublicKey  *string
	PrivateKey *string
	ShortID    *string
	WSPath     *string
	SSMethod   *string
	SSPassword *string
}

type InboundStore struct {
	DB  *sqlx.DB
	Now func() time.Time
}

func (s *InboundStore) now() time.Time {
	if s.Now == nil { return time.Now().UTC() }
	return s.Now().UTC()
}

// GenerateTag returns a fresh tag of the form "<role>-<8hex>".
// Server-side assigned at creation; immutable for the inbound's lifetime.
func (s *InboundStore) GenerateTag(role string) string {
	var buf [4]byte
	_, _ = rand.Read(buf[:])
	return role + "-" + hex.EncodeToString(buf[:])
}

func (s *InboundStore) Insert(ctx context.Context, in Inbound) (int64, error) {
	if in.Tag == "" { in.Tag = s.GenerateTag(in.Role) }
	now := s.now()
	res, err := s.DB.ExecContext(ctx, `
		INSERT INTO xray_inbounds (
		  server_id, tag, port, role, protocol,
		  uuid, sni, public_key, private_key, short_id,
		  ws_path, ss_method, ss_password,
		  upstream_inbound_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		in.ServerID, in.Tag, in.Port, in.Role, in.Protocol,
		in.UUID, in.SNI, in.PublicKey, in.PrivateKey, in.ShortID,
		in.WSPath, in.SSMethod, in.SSPassword,
		in.UpstreamInboundID, now, now)
	if err != nil { return 0, err }
	return res.LastInsertId()
}

func (s *InboundStore) GetByID(ctx context.Context, id int64) (Inbound, error) {
	var row Inbound
	err := s.DB.GetContext(ctx, &row,
		`SELECT * FROM xray_inbounds WHERE id=?`, id)
	return row, err
}

func (s *InboundStore) ListByServer(ctx context.Context, serverID int64) ([]Inbound, error) {
	rows := []Inbound{}
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT * FROM xray_inbounds WHERE server_id=? ORDER BY id`, serverID)
	return rows, err
}

// ListAllWithUpstream returns every inbound with JOIN fields populated for
// downstream renderers + UI. Ordered by (server_id, id).
func (s *InboundStore) ListAllWithUpstream(ctx context.Context) ([]InboundView, error) {
	rows := []InboundView{}
	err := s.DB.SelectContext(ctx, &rows, `
		SELECT
		  i.id, i.server_id, i.tag, i.port, i.role, i.protocol,
		  i.uuid, i.sni, i.public_key, i.private_key, i.short_id,
		  i.ws_path, i.ss_method, i.ss_password,
		  i.upstream_inbound_id, i.created_at, i.updated_at,
		  s.name AS server_name,
		  u.tag AS upstream_tag,
		  u.port AS upstream_port,
		  u.server_id AS upstream_server_id,
		  us.name AS upstream_server_name,
		  u.sni AS upstream_sni,
		  u.uuid AS upstream_uuid,
		  u.public_key AS upstream_public_key,
		  u.short_id AS upstream_short_id,
		  us.ssh_host AS upstream_address
		FROM xray_inbounds i
		JOIN servers s ON s.id = i.server_id
		LEFT JOIN xray_inbounds u ON u.id = i.upstream_inbound_id
		LEFT JOIN servers us ON us.id = u.server_id
		ORDER BY i.server_id, i.id`)
	return rows, err
}

// ListByUpstream returns all relay inbounds pointing at the given landing id.
// Used to compute "depending relays" for delete validation.
func (s *InboundStore) ListByUpstream(ctx context.Context, landingID int64) ([]Inbound, error) {
	rows := []Inbound{}
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT * FROM xray_inbounds WHERE upstream_inbound_id=? ORDER BY id`, landingID)
	return rows, err
}

func (s *InboundStore) Update(ctx context.Context, id int64, patch InboundPatch) error {
	set := []string{}
	args := []any{}
	if patch.Port != nil       { set = append(set, "port=?");        args = append(args, *patch.Port) }
	if patch.UUID != nil       { set = append(set, "uuid=?");        args = append(args, *patch.UUID) }
	if patch.SNI != nil        { set = append(set, "sni=?");         args = append(args, *patch.SNI) }
	if patch.PublicKey != nil  { set = append(set, "public_key=?");  args = append(args, *patch.PublicKey) }
	if patch.PrivateKey != nil { set = append(set, "private_key=?"); args = append(args, *patch.PrivateKey) }
	if patch.ShortID != nil    { set = append(set, "short_id=?");    args = append(args, *patch.ShortID) }
	if patch.WSPath != nil     { set = append(set, "ws_path=?");     args = append(args, *patch.WSPath) }
	if patch.SSMethod != nil   { set = append(set, "ss_method=?");   args = append(args, *patch.SSMethod) }
	if patch.SSPassword != nil { set = append(set, "ss_password=?"); args = append(args, *patch.SSPassword) }
	if len(set) == 0 { return nil }
	set = append(set, "updated_at=?")
	args = append(args, s.now())
	args = append(args, id)
	q := fmt.Sprintf("UPDATE xray_inbounds SET %s WHERE id=?", strings.Join(set, ", "))
	_, err := s.DB.ExecContext(ctx, q, args...)
	return err
}

// Delete removes the row. FK RESTRICT on upstream_inbound_id will surface as
// an error from the driver if dependent relays exist; callers should check
// ListByUpstream first to give a clean 409 with details.
func (s *InboundStore) Delete(ctx context.Context, id int64) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM xray_inbounds WHERE id=?`, id)
	return err
}
```

- [ ] **Step 4: Run tests to verify pass**

```
go test ./internal/plugins/xray/...
```

Expected: PASS for all 7 new tests + existing ones.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/xray/inbounds.go internal/plugins/xray/inbounds_test.go
git commit -m "feat(plugins/xray): InboundStore DAO with server-scoped CRUD + upstream JOIN view"
```

---

## Task 3: Data migration from legacy plugin_hosts.config

**Files:**
- Create: `internal/plugins/xray/migrate_0003.go`
- Create: `internal/plugins/xray/migrate_0003_test.go`
- Modify: `cmd/server/main.go` (wire call after RunPluginMigrations)

The plugin migration runner only executes SQL. Data extraction from `plugin_hosts.config` (JSON) is done in Go, called once at server boot after the SQL migration has applied. Idempotent: re-runs are no-ops because we skip rows that already exist in `xray_inbounds`.

- [ ] **Step 1: Write failing test**

`internal/plugins/xray/migrate_0003_test.go`:

```go
package xray

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func setupLegacyDB(t *testing.T) (*shepdb.DB, *InboundStore) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "legacy.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil { t.Fatal(err) }
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil { t.Fatal(err) }
	if err := plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations()); err != nil {
		t.Fatal(err)
	}
	// Two servers, both with xray
	for _, id := range []int64{1, 2} {
		d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_password,ssh_port,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?)`,
			id, "s"+string(rune('0'+id)), "1.1.1."+string(rune('0'+id)), "root", "x", 22, time.Now(), time.Now())
	}
	// Legacy landing on server 1
	landingCfg := []byte(`{"inbounds":[{"port":443,"protocol":"vless","settings":{"clients":[{"id":"landing-uuid","flow":"xtls-rprx-vision"}],"decryption":"none"},"streamSettings":{"network":"tcp","security":"reality","realitySettings":{"serverNames":["www.lovelive-anime.jp"],"publicKey":"LPUB","privateKey":"LPRIV","shortIds":["aa"]}}}]}`)
	d.MustExec(`INSERT INTO plugin_hosts(plugin_id,server_id,config,status,updated_at)
		VALUES ('xray',1,?,'running',?)`, landingCfg, time.Now())
	d.MustExec(`INSERT INTO xray_host_topology(server_id,role,upstream_server_id,updated_at)
		VALUES (1,'landing',NULL,?)`, time.Now())

	// Legacy relay on server 2 pointing at server 1
	relayCfg := []byte(`{"inbounds":[{"port":8443,"protocol":"vless","settings":{"clients":[{"id":"relay-uuid","flow":"xtls-rprx-vision"}],"decryption":"none"},"streamSettings":{"network":"tcp","security":"reality","realitySettings":{"serverNames":["www.microsoft.com"],"publicKey":"RPUB","privateKey":"RPRIV","shortIds":["bb"]}}}]}`)
	d.MustExec(`INSERT INTO plugin_hosts(plugin_id,server_id,config,status,updated_at)
		VALUES ('xray',2,?,'running',?)`, relayCfg, time.Now())
	d.MustExec(`INSERT INTO xray_host_topology(server_id,role,upstream_server_id,updated_at)
		VALUES (2,'relay',1,?)`, time.Now())

	return d, &InboundStore{DB: d, Now: time.Now}
}

func TestMigrate0003_PopulatesLandingAndRelay(t *testing.T) {
	d, s := setupLegacyDB(t)
	if err := Migrate0003(context.Background(), d); err != nil { t.Fatal(err) }

	rows, err := s.ListAllWithUpstream(context.Background())
	if err != nil { t.Fatal(err) }
	if len(rows) != 2 { t.Fatalf("want 2 inbounds, got %d", len(rows)) }

	var landing, relay *InboundView
	for i := range rows {
		switch rows[i].Role {
		case "landing": landing = &rows[i]
		case "relay":   relay = &rows[i]
		}
	}
	if landing == nil || landing.UUID != "landing-uuid" || landing.SNI != "www.lovelive-anime.jp" || landing.Port != 443 {
		t.Fatalf("landing wrong: %+v", landing)
	}
	if relay == nil || relay.UpstreamInboundID == nil || *relay.UpstreamInboundID != landing.ID {
		t.Fatalf("relay upstream link wrong: %+v", relay)
	}

	// plugin_hosts.config should be cleared to {}
	var cfg string
	_ = d.Get(&cfg, `SELECT config FROM plugin_hosts WHERE plugin_id='xray' AND server_id=1`)
	if cfg != "{}" { t.Fatalf("plugin_hosts.config not cleared: %q", cfg) }
}

func TestMigrate0003_Idempotent(t *testing.T) {
	d, s := setupLegacyDB(t)
	if err := Migrate0003(context.Background(), d); err != nil { t.Fatal(err) }
	if err := Migrate0003(context.Background(), d); err != nil { t.Fatal(err) }
	rows, _ := s.ListAllWithUpstream(context.Background())
	if len(rows) != 2 { t.Fatalf("re-run inserted duplicates: %d rows", len(rows)) }
}
```

- [ ] **Step 2: Run test, expect FAIL**

```
go test -run TestMigrate0003 ./internal/plugins/xray/...
```

Expected: FAIL — `Migrate0003` undefined.

- [ ] **Step 3: Implement migrate_0003.go**

`internal/plugins/xray/migrate_0003.go`:

```go
package xray

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/jmoiron/sqlx"
)

// Migrate0003 fills xray_inbounds from legacy plugin_hosts.config (vless-reality
// shape only — vmess/shadowsocks were never shipped in production). Idempotent.
// Call AFTER the 0003 SQL migration has applied (which is guaranteed when
// RunPluginMigrations has returned nil).
func Migrate0003(ctx context.Context, db *sqlx.DB) error {
	type legacyRow struct {
		ServerID         int64          `db:"server_id"`
		Config           []byte         `db:"config"`
		Role             sql.NullString `db:"role"`
		UpstreamServerID sql.NullInt64  `db:"upstream_server_id"`
	}
	rows := []legacyRow{}
	// Use LEFT JOIN so plugin_hosts rows that never got a topology row still
	// migrate as landing (the default in 0002 backfill).
	err := db.SelectContext(ctx, &rows, `
		SELECT ph.server_id, ph.config, ht.role, ht.upstream_server_id
		FROM plugin_hosts ph
		LEFT JOIN xray_host_topology ht ON ht.server_id = ph.server_id
		WHERE ph.plugin_id = 'xray'
		ORDER BY ph.server_id`)
	if err != nil { return fmt.Errorf("query legacy plugin_hosts: %w", err) }

	store := &InboundStore{DB: db}
	serverToInboundID := map[int64]int64{}

	// Pass 1: insert one inbound per legacy plugin_host. Skip rows whose
	// (server_id, port) already exists in xray_inbounds (idempotency).
	for _, r := range rows {
		port, uuid, sni, pubk, privk, sid, ok := extractVlessRealityFields(r.Config)
		if !ok { continue } // unrecognized config shape; skip rather than error

		// Idempotency: did we already migrate this server?
		var existingID int64
		err := db.GetContext(ctx, &existingID,
			`SELECT id FROM xray_inbounds WHERE server_id=? AND port=?`, r.ServerID, port)
		if err == nil {
			serverToInboundID[r.ServerID] = existingID
			continue
		}

		role := "landing"
		if r.Role.Valid && r.Role.String == "relay" { role = "relay" }

		// Relay rows are inserted with NULL upstream first, then patched in pass 2.
		var upstream *int64 = nil
		in := Inbound{
			ServerID: r.ServerID, Tag: store.GenerateTag(role), Port: port, Role: role,
			Protocol: "vless-reality",
			UUID: uuid, SNI: sni, PublicKey: pubk, PrivateKey: privk, ShortID: sid,
			UpstreamInboundID: upstream,
		}
		// CHECK constraint requires relay rows to have non-NULL upstream. To
		// satisfy that we temporarily insert a placeholder using a self-reference:
		// allocate ID by inserting as landing, then UPDATE role+upstream in pass 2.
		// Simpler: defer relay insert to pass 2 once we know the upstream ID.
		if role == "relay" {
			continue
		}
		id, err := store.Insert(ctx, in)
		if err != nil { return fmt.Errorf("insert landing for server %d: %w", r.ServerID, err) }
		serverToInboundID[r.ServerID] = id
	}

	// Pass 2: insert relay rows now that we have landing IDs.
	for _, r := range rows {
		if !r.Role.Valid || r.Role.String != "relay" { continue }
		port, uuid, sni, pubk, privk, sid, ok := extractVlessRealityFields(r.Config)
		if !ok { continue }
		var existingID int64
		err := db.GetContext(ctx, &existingID,
			`SELECT id FROM xray_inbounds WHERE server_id=? AND port=?`, r.ServerID, port)
		if err == nil {
			serverToInboundID[r.ServerID] = existingID
			continue
		}
		if !r.UpstreamServerID.Valid {
			// Orphan relay: legacy topology row pointed nowhere. Skip rather than
			// corrupt — admin can recreate.
			continue
		}
		upstreamID, ok := serverToInboundID[r.UpstreamServerID.Int64]
		if !ok { continue } // upstream landing wasn't migrated; skip
		id, err := store.Insert(ctx, Inbound{
			ServerID: r.ServerID, Tag: store.GenerateTag("relay"), Port: port, Role: "relay",
			Protocol: "vless-reality",
			UUID: uuid, SNI: sni, PublicKey: pubk, PrivateKey: privk, ShortID: sid,
			UpstreamInboundID: &upstreamID,
		})
		if err != nil { return fmt.Errorf("insert relay for server %d: %w", r.ServerID, err) }
		serverToInboundID[r.ServerID] = id
	}

	// Clear plugin_hosts.config for all xray rows (we no longer use it).
	if _, err := db.ExecContext(ctx,
		`UPDATE plugin_hosts SET config='{}' WHERE plugin_id='xray' AND config != '{}'`); err != nil {
		return fmt.Errorf("clear plugin_hosts.config: %w", err)
	}
	return nil
}

// extractVlessRealityFields parses inbounds[0] of a legacy xray config.json.
// Returns (port, uuid, sni, publicKey, privateKey, shortID, ok). ok=false on
// any malformed input — callers should skip the row.
func extractVlessRealityFields(raw []byte) (int, string, string, string, string, string, bool) {
	if len(raw) == 0 { return 0, "", "", "", "", "", false }
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil { return 0, "", "", "", "", "", false }
	inbounds, _ := cfg["inbounds"].([]any)
	if len(inbounds) == 0 { return 0, "", "", "", "", "", false }
	first, _ := inbounds[0].(map[string]any)
	if first == nil { return 0, "", "", "", "", "", false }
	portF, _ := first["port"].(float64)
	port := int(portF)
	settings, _ := first["settings"].(map[string]any)
	clients, _ := settings["clients"].([]any)
	uuid := ""
	if len(clients) > 0 {
		c0, _ := clients[0].(map[string]any)
		uuid, _ = c0["id"].(string)
	}
	ss, _ := first["streamSettings"].(map[string]any)
	rs, _ := ss["realitySettings"].(map[string]any)
	sni := ""
	if names, _ := rs["serverNames"].([]any); len(names) > 0 {
		sni, _ = names[0].(string)
	}
	pubk, _ := rs["publicKey"].(string)
	privk, _ := rs["privateKey"].(string)
	shortID := ""
	if sids, _ := rs["shortIds"].([]any); len(sids) > 0 {
		shortID, _ = sids[0].(string)
	}
	if port == 0 || uuid == "" || sni == "" { return 0, "", "", "", "", "", false }
	return port, uuid, sni, pubk, privk, shortID, true
}
```

- [ ] **Step 4: Wire call site in main.go**

Edit `cmd/server/main.go`. Find the existing boot loop that runs `plugins.RunPluginMigrations` for enabled plugins. Right after that call returns, if the plugin id is `"xray"`, call `xray.Migrate0003(ctx, db)`:

```go
// after RunPluginMigrations(ctx, db, pl.Meta().ID, pl.Migrations()) returns nil...
if pl.Meta().ID == "xray" {
    if err := xray.Migrate0003(ctx, db); err != nil {
        log.Printf("xray.Migrate0003: %v", err)
        // continue; don't crash boot
    }
}
```

(Import `"github.com/hg-claw/Shepherd/internal/plugins/xray"` if not already imported.)

- [ ] **Step 5: Run tests**

```
go test ./internal/plugins/xray/... ./cmd/...
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/xray/migrate_0003.go \
        internal/plugins/xray/migrate_0003_test.go \
        cmd/server/main.go
git commit -m "feat(plugins/xray): Migrate0003 backfills xray_inbounds from legacy plugin_hosts.config"
```

---

## Task 4: Server-side config renderer (multi-inbound)

**Files:**
- Create: `internal/plugins/xray/render.go`
- Create: `internal/plugins/xray/render_test.go`

- [ ] **Step 1: Write failing tests**

`internal/plugins/xray/render_test.go`:

```go
package xray

import (
	"database/sql"
	"encoding/json"
	"testing"
)

func mkLandingView(id int64, tag string, port int, sni, uuid, pub, priv, sid string) InboundView {
	return InboundView{
		Inbound: Inbound{
			ID: id, ServerID: 1, Tag: tag, Port: port, Role: "landing",
			Protocol: "vless-reality",
			UUID: uuid, SNI: sni, PublicKey: pub, PrivateKey: priv, ShortID: sid,
		},
		ServerName: "s1",
	}
}

func mkRelayView(id, upstreamID int64, tag string, port int, sni, uuid, pub, priv, sid,
	upTag, upSNI, upUUID, upPub, upSID, upAddr string, upPort int64) InboundView {
	upID := upstreamID
	return InboundView{
		Inbound: Inbound{
			ID: id, ServerID: 2, Tag: tag, Port: port, Role: "relay",
			Protocol: "vless-reality",
			UUID: uuid, SNI: sni, PublicKey: pub, PrivateKey: priv, ShortID: sid,
			UpstreamInboundID: &upID,
		},
		ServerName: "s2",
		UpstreamTag:        sql.NullString{String: upTag, Valid: true},
		UpstreamPort:       sql.NullInt64{Int64: upPort, Valid: true},
		UpstreamServerID:   sql.NullInt64{Int64: 1, Valid: true},
		UpstreamServerName: sql.NullString{String: "s1", Valid: true},
		UpstreamSNI:        sql.NullString{String: upSNI, Valid: true},
		UpstreamUUID:       sql.NullString{String: upUUID, Valid: true},
		UpstreamPublicKey:  sql.NullString{String: upPub, Valid: true},
		UpstreamShortID:    sql.NullString{String: upSID, Valid: true},
		UpstreamAddress:    sql.NullString{String: upAddr, Valid: true},
	}
}

func TestRenderServerConfig_OnlyLanding(t *testing.T) {
	out, err := RenderServerConfig([]InboundView{
		mkLandingView(1, "landing-aa", 443, "www.lovelive-anime.jp", "u1", "P1", "K1", "s1"),
	})
	if err != nil { t.Fatal(err) }
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil { t.Fatal(err) }
	inbounds := m["inbounds"].([]any)
	if len(inbounds) != 1 { t.Fatalf("inbounds count = %d", len(inbounds)) }
	first := inbounds[0].(map[string]any)
	if first["tag"] != "landing-aa" { t.Fatalf("tag = %v", first["tag"]) }
	outbounds := m["outbounds"].([]any)
	if len(outbounds) != 1 || outbounds[0].(map[string]any)["protocol"] != "freedom" {
		t.Fatalf("expected only freedom outbound, got %v", outbounds)
	}
	if _, has := m["routing"]; has {
		t.Fatalf("landing-only config must not have routing block")
	}
}

func TestRenderServerConfig_OnlyRelay(t *testing.T) {
	out, err := RenderServerConfig([]InboundView{
		mkRelayView(2, 1, "relay-bb", 8443, "www.microsoft.com", "u2", "P2", "K2", "s2",
			"landing-aa", "www.lovelive-anime.jp", "u1", "P1", "s1", "server-y.example.com", 443),
	})
	if err != nil { t.Fatal(err) }
	var m map[string]any
	_ = json.Unmarshal(out, &m)
	outbounds := m["outbounds"].([]any)
	if len(outbounds) != 2 {
		t.Fatalf("outbounds = %d, want 2 (to-landing-aa + freedom)", len(outbounds))
	}
	if outbounds[0].(map[string]any)["tag"] != "to-landing-aa" {
		t.Fatalf("outbound[0] tag = %v", outbounds[0].(map[string]any)["tag"])
	}
	rules := m["routing"].(map[string]any)["rules"].([]any)
	if len(rules) != 2 {
		t.Fatalf("rules = %d, want 2 (relay-bb + geoip:private)", len(rules))
	}
	r0 := rules[0].(map[string]any)
	tags := r0["inboundTag"].([]any)
	if len(tags) != 1 || tags[0] != "relay-bb" {
		t.Fatalf("rule 0 inboundTag = %v", tags)
	}
}

func TestRenderServerConfig_MixedLandingAndRelays(t *testing.T) {
	out, err := RenderServerConfig([]InboundView{
		mkLandingView(1, "landing-aa", 443, "www.lovelive-anime.jp", "ul", "PL", "KL", "sl"),
		mkRelayView(2, 10, "relay-bb", 8443, "www.microsoft.com", "u2", "P2", "K2", "s2",
			"landing-x", "www.apple.com", "u-x", "P-X", "s-x", "x.example.com", 443),
		mkRelayView(3, 11, "relay-cc", 9443, "www.apple.com", "u3", "P3", "K3", "s3",
			"landing-y", "www.swift.org", "u-y", "P-Y", "s-y", "y.example.com", 8443),
	})
	if err != nil { t.Fatal(err) }
	var m map[string]any
	_ = json.Unmarshal(out, &m)
	if len((m["inbounds"]).([]any)) != 3 { t.Fatalf("inbounds count") }
	outs := m["outbounds"].([]any)
	if len(outs) != 3 {
		t.Fatalf("outbounds = %d, want 3 (to-landing-x + to-landing-y + freedom)", len(outs))
	}
	rules := m["routing"].(map[string]any)["rules"].([]any)
	if len(rules) != 3 {
		t.Fatalf("rules = %d, want 3 (relay-bb + relay-cc + geoip:private)", len(rules))
	}
}

func TestRenderServerConfig_EmptyReturnsError(t *testing.T) {
	_, err := RenderServerConfig(nil)
	if err == nil { t.Fatalf("expected error for empty inbounds") }
}
```

- [ ] **Step 2: Run tests to verify FAIL**

```
go test -run TestRenderServerConfig ./internal/plugins/xray/...
```

Expected: FAIL — `RenderServerConfig` undefined.

- [ ] **Step 3: Implement render.go**

`internal/plugins/xray/render.go`:

```go
package xray

import (
	"encoding/json"
	"errors"
	"fmt"
)

// RenderServerConfig assembles a complete xray config.json for one server,
// given all of its inbounds (with upstream JOIN fields populated for relays).
// Output is deterministic: inbounds are emitted in input order (caller should
// sort by id), outbounds emit to-{upstream.tag} for each unique upstream then
// freedom at the end, routing rules emit one per relay inbound then the
// geoip:private fallback.
func RenderServerConfig(inbounds []InboundView) ([]byte, error) {
	if len(inbounds) == 0 {
		return nil, errors.New("RenderServerConfig: no inbounds")
	}

	cfg := map[string]any{
		"log": map[string]any{"loglevel": "warning"},
	}

	inboundsJSON := make([]any, 0, len(inbounds))
	outboundsByTag := map[string]map[string]any{}
	routingRules := make([]any, 0, len(inbounds)+1)
	hasRelay := false

	for _, in := range inbounds {
		ib, err := renderInbound(in)
		if err != nil { return nil, fmt.Errorf("inbound %s: %w", in.Tag, err) }
		inboundsJSON = append(inboundsJSON, ib)

		if in.Role == "relay" {
			hasRelay = true
			if !in.UpstreamTag.Valid {
				return nil, fmt.Errorf("relay %s missing upstream JOIN fields", in.Tag)
			}
			upTag := in.UpstreamTag.String
			outTag := "to-" + upTag
			if _, exists := outboundsByTag[outTag]; !exists {
				outboundsByTag[outTag] = renderRelayOutbound(outTag, in)
			}
			routingRules = append(routingRules, map[string]any{
				"type":         "field",
				"inboundTag":   []any{in.Tag},
				"outboundTag":  outTag,
			})
		}
	}

	// Build outbounds list: to-* in deterministic order (sorted by tag), then freedom.
	outboundsList := make([]any, 0, len(outboundsByTag)+1)
	for _, tag := range sortedKeys(outboundsByTag) {
		outboundsList = append(outboundsList, outboundsByTag[tag])
	}
	outboundsList = append(outboundsList, map[string]any{
		"tag":      "freedom",
		"protocol": "freedom",
		"settings": map[string]any{"domainStrategy": "UseIP"},
	})

	cfg["inbounds"] = inboundsJSON
	cfg["outbounds"] = outboundsList

	if hasRelay {
		routingRules = append(routingRules, map[string]any{
			"type":        "field",
			"ip":          []any{"geoip:private"},
			"outboundTag": "freedom",
		})
		cfg["routing"] = map[string]any{"rules": routingRules}
	}
	return json.MarshalIndent(cfg, "", "  ")
}

func renderInbound(in InboundView) (map[string]any, error) {
	switch in.Protocol {
	case "vless-reality":
		return map[string]any{
			"tag":      in.Tag,
			"port":     in.Port,
			"protocol": "vless",
			"settings": map[string]any{
				"clients":    []any{map[string]any{"id": in.UUID, "flow": "xtls-rprx-vision"}},
				"decryption": "none",
			},
			"streamSettings": map[string]any{
				"network":  "tcp",
				"security": "reality",
				"realitySettings": map[string]any{
					"show":        false,
					"dest":        in.SNI + ":443",
					"serverNames": []any{in.SNI},
					"privateKey":  in.PrivateKey,
					"publicKey":   in.PublicKey,
					"shortIds":    []any{in.ShortID},
				},
			},
			"sniffing": map[string]any{
				"enabled":      true,
				"destOverride": []any{"http", "tls"},
			},
		}, nil
	case "vmess-ws":
		path := in.WSPath
		if path == "" { path = "/ws" }
		return map[string]any{
			"tag":      in.Tag,
			"port":     in.Port,
			"protocol": "vmess",
			"settings": map[string]any{
				"clients": []any{map[string]any{"id": in.UUID}},
			},
			"streamSettings": map[string]any{
				"network":    "ws",
				"wsSettings": map[string]any{"path": path},
			},
			"sniffing": map[string]any{
				"enabled":      true,
				"destOverride": []any{"http", "tls"},
			},
		}, nil
	case "shadowsocks":
		return map[string]any{
			"tag":      in.Tag,
			"port":     in.Port,
			"protocol": "shadowsocks",
			"settings": map[string]any{"method": in.SSMethod, "password": in.SSPassword},
			"sniffing": map[string]any{
				"enabled":      true,
				"destOverride": []any{"http", "tls"},
			},
		}, nil
	default:
		return nil, fmt.Errorf("unknown protocol %q", in.Protocol)
	}
}

func renderRelayOutbound(outTag string, in InboundView) map[string]any {
	return map[string]any{
		"tag":      outTag,
		"protocol": "vless",
		"settings": map[string]any{
			"vnext": []any{map[string]any{
				"address": in.UpstreamAddress.String,
				"port":    in.UpstreamPort.Int64,
				"users": []any{map[string]any{
					"id":         in.UpstreamUUID.String,
					"encryption": "none",
					"flow":       "xtls-rprx-vision",
				}},
			}},
		},
		"streamSettings": map[string]any{
			"network":  "tcp",
			"security": "reality",
			"realitySettings": map[string]any{
				"fingerprint": "chrome",
				"serverName":  in.UpstreamSNI.String,
				"publicKey":   in.UpstreamPublicKey.String,
				"shortId":     in.UpstreamShortID.String,
			},
		},
	}
}

func sortedKeys(m map[string]map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m { keys = append(keys, k) }
	// stdlib sort.Strings
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j-1] > keys[j]; j-- {
			keys[j-1], keys[j] = keys[j], keys[j-1]
		}
	}
	return keys
}
```

- [ ] **Step 4: Run tests to verify PASS**

```
go test ./internal/plugins/xray/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/xray/render.go internal/plugins/xray/render_test.go
git commit -m "feat(plugins/xray): RenderServerConfig assembles multi-inbound xray config"
```

---

## Task 5: Server-level assemble + push + restart helper

**Files:**
- Create: `internal/plugins/xray/deploy_server.go`
- Create: `internal/plugins/xray/deploy_server_test.go`
- Modify: `internal/plugins/xray/xray.go` (drop legacy validators; expose `assembleAndDeploy` for routes)

- [ ] **Step 1: Write failing test**

`internal/plugins/xray/deploy_server_test.go`:

```go
package xray

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type fakeHostExec struct {
	pushed map[string][]byte
	cmds   [][]string
}

func (f *fakeHostExec) PushFile(_ context.Context, _ int64, path string, _ uint32, content []byte) error {
	if f.pushed == nil { f.pushed = map[string][]byte{} }
	f.pushed[path] = append([]byte(nil), content...)
	return nil
}
func (f *fakeHostExec) RunCmd(_ context.Context, _ int64, name string, args ...string) ([]byte, []byte, int, error) {
	f.cmds = append(f.cmds, append([]string{name}, args...))
	return nil, nil, 0, nil
}
func (f *fakeHostExec) StreamCmd(context.Context, int64, string, []string, func(string)) error {
	return nil
}

func TestAssembleAndDeploy_PushesConfigAndRestarts(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "ad.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations())
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_password,ssh_port,agent_os,agent_arch,created_at,updated_at)
		VALUES (1,'s1','1.1.1.1','r','x',22,'linux','amd64',?,?)`, time.Now(), time.Now())
	store := &InboundStore{DB: d, Now: time.Now}
	_, _ = store.Insert(context.Background(), Inbound{
		ServerID: 1, Tag: store.GenerateTag("landing"), Port: 443, Role: "landing",
		Protocol: "vless-reality", UUID: "u", SNI: "www.lovelive-anime.jp",
		PublicKey: "P", PrivateKey: "K", ShortID: "aa",
	})

	exec := &fakeHostExec{}
	deps := plugins.Deps{DB: d, HostExec: exec}
	if err := AssembleAndDeploy(context.Background(), deps, 1); err != nil { t.Fatal(err) }

	if _, ok := exec.pushed["/etc/shepherd-xray/config.json"]; !ok {
		t.Fatalf("config not pushed; pushed=%v", exec.pushed)
	}
	// Restart cmd issued
	sawRestart := false
	for _, c := range exec.cmds {
		if len(c) >= 2 && c[0] == "systemctl" && c[1] == "restart" {
			sawRestart = true; break
		}
	}
	if !sawRestart {
		t.Fatalf("no restart cmd issued; cmds=%v", exec.cmds)
	}
}

func TestAssembleAndDeploy_NoInboundsStopsService(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "ad.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations())
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_password,ssh_port,agent_os,agent_arch,created_at,updated_at)
		VALUES (1,'s1','1.1.1.1','r','x',22,'linux','amd64',?,?)`, time.Now(), time.Now())
	exec := &fakeHostExec{}
	deps := plugins.Deps{DB: d, HostExec: exec}
	if err := AssembleAndDeploy(context.Background(), deps, 1); err != nil { t.Fatal(err) }
	// No config push, no restart; a stop must have been issued
	if _, ok := exec.pushed["/etc/shepherd-xray/config.json"]; ok {
		t.Fatalf("config should not be pushed when no inbounds")
	}
	sawStop := false
	for _, c := range exec.cmds {
		if len(c) >= 2 && c[0] == "systemctl" && (c[1] == "stop" || c[1] == "disable") {
			sawStop = true; break
		}
	}
	if !sawStop { t.Fatalf("expected stop cmd; cmds=%v", exec.cmds) }
}
```

- [ ] **Step 2: Run tests to verify FAIL**

```
go test -run TestAssembleAndDeploy ./internal/plugins/xray/...
```

Expected: FAIL — `AssembleAndDeploy` undefined.

- [ ] **Step 3: Implement deploy_server.go**

`internal/plugins/xray/deploy_server.go`:

```go
package xray

import (
	"context"
	"fmt"

	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/hg-claw/Shepherd/internal/plugins/deploy"
)

// AssembleAndDeploy gathers all inbounds for serverID, renders the full xray
// config, pushes it, and restarts xray. If serverID has zero inbounds, stops
// xray instead (without pushing a config).
func AssembleAndDeploy(ctx context.Context, deps plugins.Deps, serverID int64) error {
	store := &InboundStore{DB: deps.DB}
	views, err := store.ListAllWithUpstream(ctx)
	if err != nil { return fmt.Errorf("list inbounds: %w", err) }

	// Filter to this server
	mine := make([]InboundView, 0)
	for _, v := range views {
		if v.ServerID == serverID { mine = append(mine, v) }
	}

	osName, _ := hostOSArch(ctx, deps.DB, serverID)
	unitName := unitNameLinux
	if osName == "darwin" { unitName = unitNameDarwin }
	pusher := &deploy.Pusher{Exec: deps.HostExec}

	if len(mine) == 0 {
		// Last inbound removed — stop service. plugin_hosts row is kept.
		return pusher.Stop(ctx, osName, serverID, unitName)
	}

	cfgBytes, err := RenderServerConfig(mine)
	if err != nil { return fmt.Errorf("render: %w", err) }

	// Push config only (binary + unit are pushed during version upgrades, not on every inbound change).
	if err := deps.HostExec.PushFile(ctx, serverID, configRemotePathUnix, 0600, cfgBytes); err != nil {
		return fmt.Errorf("push config: %w", err)
	}
	// Restart xray to pick up new config
	return pusher.Reload(ctx, osName, serverID, unitName, "" /*unitPath unused for linux*/)
}
```

- [ ] **Step 4: Drop legacy validators on `Plugin`**

Edit `internal/plugins/xray/xray.go`. Remove `BeforeDeploy`, `AfterDeploy`, `BeforeUndeploy` methods on `*Plugin`. The plugin no longer implements `DeployValidator`/`DeployCommitter`/`UndeployValidator`. (Keep `DeployToHost`/`UndeployFromHost`/`HostStatus` for now — Task 7 will mark the generic /hosts endpoint 410 Gone, after which these become dead code; clean up in Task 13.)

Also drop the call to `TopologyStore` inside `UndeployFromHost` (this was the per-server cleanup; the new flow doesn't go through here).

After edit, `*Plugin` should only implement `Plugin`, `HostAware` (legacy, soon-to-be-unreachable), and `LogStreamer`.

- [ ] **Step 5: Run tests**

```
go test ./internal/plugins/xray/...
```

Expected: PASS. Pre-existing `TestXrayBeforeDeploy*` / `TestXrayAfterDeploy_*` / `TestXrayBeforeUndeploy_*` tests in `xray_test.go` will FAIL because the methods are gone. Delete those tests in the same step (their behavior is replaced by Task 6's API tests).

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/xray/deploy_server.go \
        internal/plugins/xray/deploy_server_test.go \
        internal/plugins/xray/xray.go \
        internal/plugins/xray/xray_test.go
git commit -m "feat(plugins/xray): AssembleAndDeploy renders per-server multi-inbound config; drop legacy validators"
```

---

## Task 6: New `/inbounds` HTTP routes

**Files:**
- Create: `internal/plugins/xray/inbounds_routes.go`
- Create: `internal/plugins/xray/inbounds_routes_test.go`
- Modify: `internal/plugins/xray/routes.go` (register new routes; mark old `/topology` 410)

- [ ] **Step 1: Write failing tests**

`internal/plugins/xray/inbounds_routes_test.go`:

```go
package xray

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func newRoutesDB(t *testing.T) (*shepdb.DB, plugins.Deps) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "r.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations())
	for _, id := range []int64{1, 2, 3} {
		d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_password,ssh_port,agent_os,agent_arch,created_at,updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?)`,
			id, "s"+strconv.FormatInt(id, 10), "1.1.1."+strconv.FormatInt(id, 10), "root", "x", 22, "linux", "amd64", time.Now(), time.Now())
	}
	return d, plugins.Deps{DB: d, HostExec: &fakeHostExec{}}
}

func TestPostInbound_CreatesLandingAndAssignsTag(t *testing.T) {
	d, deps := newRoutesDB(t)
	body := map[string]any{
		"server_id": 1, "port": 443, "role": "landing", "protocol": "vless-reality",
		"uuid": "u", "sni": "www.lovelive-anime.jp",
		"public_key": "P", "private_key": "K", "short_id": "aa",
	}
	b, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/inbounds", bytes.NewReader(b))
	postInboundHandler(deps)(w, req)
	if w.Code != 201 { t.Fatalf("status = %d body=%s", w.Code, w.Body.String()) }
	var out map[string]any
	_ = json.NewDecoder(w.Body).Decode(&out)
	if tag, _ := out["tag"].(string); len(tag) != 16 { // landing-XXXXXXXX
		t.Fatalf("tag = %q", out["tag"])
	}
	if out["private_key"] != "[REDACTED]" {
		t.Fatalf("private_key not redacted: %v", out["private_key"])
	}

	// DB has the row
	store := &InboundStore{DB: d}
	rows, _ := store.ListByServer(context.Background(), 1)
	if len(rows) != 1 { t.Fatalf("inbounds in DB = %d", len(rows)) }
}

func TestPostInbound_RejectsPortConflict(t *testing.T) {
	d, deps := newRoutesDB(t)
	store := &InboundStore{DB: d}
	_, _ = store.Insert(context.Background(), Inbound{
		ServerID: 1, Tag: store.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality",
		UUID: "u", SNI: "s", PublicKey: "P", PrivateKey: "K", ShortID: "aa",
	})
	body := map[string]any{
		"server_id": 1, "port": 443, "role": "landing", "protocol": "vless-reality",
		"uuid": "u2", "sni": "s2", "public_key": "P2", "private_key": "K2", "short_id": "bb",
	}
	b, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/inbounds", bytes.NewReader(b))
	postInboundHandler(deps)(w, req)
	if w.Code != 409 { t.Fatalf("status = %d, want 409", w.Code) }
}

func TestPostInbound_RejectsRelayWithoutUpstream(t *testing.T) {
	_, deps := newRoutesDB(t)
	body := map[string]any{
		"server_id": 1, "port": 8443, "role": "relay", "protocol": "vless-reality",
		"uuid": "u", "sni": "s", "public_key": "P", "private_key": "K", "short_id": "aa",
	}
	b, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/inbounds", bytes.NewReader(b))
	postInboundHandler(deps)(w, req)
	if w.Code != 409 { t.Fatalf("status = %d, want 409", w.Code) }
}

func TestPostInbound_RejectsRelayPointingAtRelay(t *testing.T) {
	d, deps := newRoutesDB(t)
	store := &InboundStore{DB: d}
	landingID, _ := store.Insert(context.Background(), Inbound{
		ServerID: 1, Tag: store.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality",
		UUID: "u", SNI: "s", PublicKey: "P", PrivateKey: "K", ShortID: "aa",
	})
	relayID, _ := store.Insert(context.Background(), Inbound{
		ServerID: 2, Tag: store.GenerateTag("relay"), Port: 8443, Role: "relay", Protocol: "vless-reality",
		UUID: "u2", UpstreamInboundID: &landingID,
	})
	// New relay tries to point at the existing relay → reject
	body := map[string]any{
		"server_id": 3, "port": 9443, "role": "relay", "protocol": "vless-reality",
		"uuid": "u3", "upstream_inbound_id": relayID,
	}
	b, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/inbounds", bytes.NewReader(b))
	postInboundHandler(deps)(w, req)
	if w.Code != 409 { t.Fatalf("status = %d, want 409", w.Code) }
}

func TestGetInbounds_FiltersByServer(t *testing.T) {
	d, deps := newRoutesDB(t)
	store := &InboundStore{DB: d}
	_, _ = store.Insert(context.Background(), Inbound{ServerID: 1, Tag: store.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality"})
	_, _ = store.Insert(context.Background(), Inbound{ServerID: 2, Tag: store.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality"})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/inbounds?server_id=1", nil)
	getInboundsHandler(deps)(w, req)
	if w.Code != 200 { t.Fatalf("code=%d", w.Code) }
	var out []map[string]any
	_ = json.NewDecoder(w.Body).Decode(&out)
	if len(out) != 1 { t.Fatalf("expected 1 inbound for server 1, got %d", len(out)) }
}

func TestPatchInbound_IgnoresImmutableFields(t *testing.T) {
	d, deps := newRoutesDB(t)
	store := &InboundStore{DB: d}
	id, _ := store.Insert(context.Background(), Inbound{
		ServerID: 1, Tag: store.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality",
		UUID: "u", SNI: "s", PublicKey: "P", PrivateKey: "K", ShortID: "aa",
	})
	body := map[string]any{
		"port": 8443, "uuid": "u-new",
		"role": "relay", "server_id": 99, "tag": "tag-new", "upstream_inbound_id": 7,
	}
	b, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("PATCH", "/inbounds/"+strconv.FormatInt(id, 10), bytes.NewReader(b))
	req.SetPathValue("id", strconv.FormatInt(id, 10))
	patchInboundHandler(deps)(w, req)
	if w.Code != 200 { t.Fatalf("status=%d body=%s", w.Code, w.Body.String()) }
	row, _ := store.GetByID(context.Background(), id)
	if row.Port != 8443 || row.UUID != "u-new" { t.Fatalf("mutable fields not applied: %+v", row) }
	if row.Role != "landing" || row.ServerID != 1 { t.Fatalf("immutable changed: %+v", row) }
}

func TestDeleteInbound_RejectsLandingWithRelays(t *testing.T) {
	d, deps := newRoutesDB(t)
	store := &InboundStore{DB: d}
	landingID, _ := store.Insert(context.Background(), Inbound{
		ServerID: 1, Tag: store.GenerateTag("landing"), Port: 443, Role: "landing", Protocol: "vless-reality",
	})
	_, _ = store.Insert(context.Background(), Inbound{
		ServerID: 2, Tag: store.GenerateTag("relay"), Port: 8443, Role: "relay", Protocol: "vless-reality",
		UpstreamInboundID: &landingID,
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("DELETE", "/inbounds/"+strconv.FormatInt(landingID, 10), nil)
	req.SetPathValue("id", strconv.FormatInt(landingID, 10))
	deleteInboundHandler(deps)(w, req)
	if w.Code != 409 { t.Fatalf("status = %d, want 409", w.Code) }
}
```

- [ ] **Step 2: Run tests to verify FAIL**

```
go test -run 'TestPostInbound|TestGetInbounds|TestPatchInbound|TestDeleteInbound' ./internal/plugins/xray/...
```

Expected: FAIL — handlers undefined.

- [ ] **Step 3: Implement inbounds_routes.go**

`internal/plugins/xray/inbounds_routes.go`:

```go
package xray

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

type postInboundBody struct {
	ServerID          int64  `json:"server_id"`
	Port              int    `json:"port"`
	Role              string `json:"role"`
	Protocol          string `json:"protocol"`
	UUID              string `json:"uuid"`
	SNI               string `json:"sni"`
	PublicKey         string `json:"public_key"`
	PrivateKey        string `json:"private_key"`
	ShortID           string `json:"short_id"`
	WSPath            string `json:"ws_path"`
	SSMethod          string `json:"ss_method"`
	SSPassword        string `json:"ss_password"`
	UpstreamInboundID *int64 `json:"upstream_inbound_id"`
}

func writeJSONResp(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSONResp(w, code, map[string]string{"error": msg})
}

func inboundToMap(v InboundView) map[string]any {
	m := map[string]any{
		"id":         v.ID,
		"server_id":  v.ServerID,
		"server_name": v.ServerName,
		"tag":        v.Tag,
		"port":       v.Port,
		"role":       v.Role,
		"protocol":   v.Protocol,
		"uuid":       v.UUID,
		"sni":        v.SNI,
		"public_key": v.PublicKey,
		"private_key": "[REDACTED]",
		"short_id":   v.ShortID,
		"ws_path":    v.WSPath,
		"ss_method":  v.SSMethod,
		"created_at": v.CreatedAt,
		"updated_at": v.UpdatedAt,
	}
	if v.UpstreamInboundID != nil {
		m["upstream_inbound_id"] = *v.UpstreamInboundID
		if v.UpstreamTag.Valid     { m["upstream_tag"] = v.UpstreamTag.String }
		if v.UpstreamServerID.Valid { m["upstream_server_id"] = v.UpstreamServerID.Int64 }
		if v.UpstreamServerName.Valid { m["upstream_server_name"] = v.UpstreamServerName.String }
	}
	return m
}

// validatePostInbound runs all the synchronous checks. Returns nil error on success.
func validatePostInbound(ctx context.Context, store *InboundStore, body postInboundBody) error {
	if body.ServerID == 0 { return errors.New("server_id required") }
	if body.Port <= 0 || body.Port > 65535 { return errors.New("port out of range") }
	if body.Role != "landing" && body.Role != "relay" {
		return fmt.Errorf("role must be landing or relay, got %q", body.Role)
	}
	if body.Protocol == "" { body.Protocol = "vless-reality" }

	// Port conflict (same server)
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
		if err != nil { return fmt.Errorf("upstream inbound %d not found", *body.UpstreamInboundID) }
		if upstream.Role != "landing" {
			return fmt.Errorf("upstream inbound %d is not a landing (role=%s)", upstream.ID, upstream.Role)
		}
	}
	return nil
}

func postInboundHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body postInboundBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, 400, "bad json"); return
		}
		store := &InboundStore{DB: deps.DB}
		if err := validatePostInbound(r.Context(), store, body); err != nil {
			writeError(w, 409, err.Error()); return
		}
		role := body.Role
		in := Inbound{
			ServerID: body.ServerID, Tag: store.GenerateTag(role), Port: body.Port,
			Role: role, Protocol: body.Protocol,
			UUID: body.UUID, SNI: body.SNI,
			PublicKey: body.PublicKey, PrivateKey: body.PrivateKey, ShortID: body.ShortID,
			WSPath: body.WSPath, SSMethod: body.SSMethod, SSPassword: body.SSPassword,
			UpstreamInboundID: body.UpstreamInboundID,
		}
		id, err := store.Insert(r.Context(), in)
		if err != nil { writeError(w, 500, err.Error()); return }
		// Trigger reassemble + restart in background. Errors are reported via plugin_hosts.last_error elsewhere.
		go func() {
			_ = AssembleAndDeploy(r.Context(), deps, body.ServerID)
		}()
		// Fetch the JOIN view for response
		views, _ := store.ListAllWithUpstream(r.Context())
		for _, v := range views {
			if v.ID == id { writeJSONResp(w, 201, inboundToMap(v)); return }
		}
		writeError(w, 500, "inserted but not findable")
	}
}

func getInboundsHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		store := &InboundStore{DB: deps.DB}
		views, err := store.ListAllWithUpstream(r.Context())
		if err != nil { writeError(w, 500, err.Error()); return }
		filter := r.URL.Query().Get("server_id")
		out := []map[string]any{}
		for _, v := range views {
			if filter != "" {
				want, _ := strconv.ParseInt(filter, 10, 64)
				if v.ServerID != want { continue }
			}
			out = append(out, inboundToMap(v))
		}
		writeJSONResp(w, 200, out)
	}
}

func patchInboundHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if id == 0 { writeError(w, 400, "id required"); return }
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, 400, "bad json"); return
		}
		// Build patch, ignoring immutable fields by simply not reading them
		patch := InboundPatch{}
		if v, ok := body["port"].(float64);       ok { p := int(v); patch.Port = &p }
		if v, ok := body["uuid"].(string);        ok { patch.UUID = &v }
		if v, ok := body["sni"].(string);         ok { patch.SNI = &v }
		if v, ok := body["public_key"].(string);  ok { patch.PublicKey = &v }
		if v, ok := body["private_key"].(string); ok && v != "[REDACTED]" { patch.PrivateKey = &v }
		if v, ok := body["short_id"].(string);    ok { patch.ShortID = &v }
		if v, ok := body["ws_path"].(string);     ok { patch.WSPath = &v }
		if v, ok := body["ss_method"].(string);   ok { patch.SSMethod = &v }
		if v, ok := body["ss_password"].(string); ok { patch.SSPassword = &v }

		store := &InboundStore{DB: deps.DB}
		// Lookup serverID for downstream deploy
		row, err := store.GetByID(r.Context(), id)
		if err != nil { writeError(w, 404, "inbound not found"); return }

		// Port-change conflict check
		if patch.Port != nil && *patch.Port != row.Port {
			others, _ := store.ListByServer(r.Context(), row.ServerID)
			for _, o := range others {
				if o.ID != id && o.Port == *patch.Port {
					writeError(w, 409, fmt.Sprintf("port %d already in use by tag %s", *patch.Port, o.Tag))
					return
				}
			}
		}
		if err := store.Update(r.Context(), id, patch); err != nil {
			writeError(w, 500, err.Error()); return
		}
		go func() { _ = AssembleAndDeploy(r.Context(), deps, row.ServerID) }()
		views, _ := store.ListAllWithUpstream(r.Context())
		for _, v := range views {
			if v.ID == id { writeJSONResp(w, 200, inboundToMap(v)); return }
		}
		writeError(w, 500, "updated but not findable")
	}
}

func deleteInboundHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if id == 0 { writeError(w, 400, "id required"); return }
		store := &InboundStore{DB: deps.DB}
		row, err := store.GetByID(r.Context(), id)
		if err != nil { writeError(w, 404, "inbound not found"); return }
		if row.Role == "landing" {
			dependents, _ := store.ListByUpstream(r.Context(), id)
			if len(dependents) > 0 {
				ids := make([]int64, 0, len(dependents))
				for _, d := range dependents { ids = append(ids, d.ID) }
				writeJSONResp(w, 409, map[string]any{
					"error":             fmt.Sprintf("landing inbound %s has %d relay(s) depending on it", row.Tag, len(dependents)),
					"relay_inbound_ids": ids,
				})
				return
			}
		}
		if err := store.Delete(r.Context(), id); err != nil {
			writeError(w, 500, err.Error()); return
		}
		go func() { _ = AssembleAndDeploy(r.Context(), deps, row.ServerID) }()
		writeJSONResp(w, 200, map[string]any{"ok": true})
	}
}
```

(Add `"context"` to imports.)

- [ ] **Step 4: Register routes + retire /topology**

Edit `internal/plugins/xray/routes.go` inside `(p *Plugin) RegisterRoutes`. Add:

```go
mux.HandleFunc("POST /inbounds",       postInboundHandler(deps))
mux.HandleFunc("GET /inbounds",        getInboundsHandler(deps))
mux.HandleFunc("PATCH /inbounds/{id}", patchInboundHandler(deps))
mux.HandleFunc("DELETE /inbounds/{id}", deleteInboundHandler(deps))

// Retire /topology — replaced by /inbounds (each row carries upstream_*).
mux.HandleFunc("GET /topology", func(w http.ResponseWriter, r *http.Request) {
    http.Error(w, "GET /topology is deprecated; use GET /inbounds instead", http.StatusGone)
})
```

- [ ] **Step 5: Run tests**

```
go test ./internal/plugins/xray/...
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/xray/inbounds_routes.go \
        internal/plugins/xray/inbounds_routes_test.go \
        internal/plugins/xray/routes.go
git commit -m "feat(plugins/xray): /inbounds CRUD endpoints with validation; deprecate /topology with 410"
```

---

## Task 7: Generic `/hosts` endpoint returns 410 Gone for xray

**Files:**
- Modify: `internal/api/plugins.go` (special-case plugin id "xray" in PostHost/DeleteHost)
- Modify: `internal/api/plugins_test.go` (assert 410)

The generic `POST /api/admin/plugins/{id}/hosts` and `DELETE .../hosts/{server_id}` endpoints stay functional for non-xray plugins (e.g., cloudflare doesn't use them but other future plugins might). For xray, they must return 410 with a hint about `/inbounds`.

- [ ] **Step 1: Write failing test**

Append to `internal/api/plugins_test.go`:

```go
func TestPostHost_XrayReturns410(t *testing.T) {
	// Register the real xray plugin so id "xray" exists in the registry
	plugins.ResetRegistryForTestPublic()
	plugins.Register(xrayplugin.New())  // import as: xrayplugin "github.com/hg-claw/Shepherd/internal/plugins/xray"
	dsn := "file:" + filepath.Join(t.TempDir(), "x.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	defer d.Close()
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	store := &plugins.Store{DB: d, Now: time.Now}
	_ = store.UpsertEnabled(context.Background(), "xray", true)
	api := &PluginsAPI{Store: store, Deps: plugins.Deps{DB: d}}

	req := httptest.NewRequest("POST", "/api/admin/plugins/xray/hosts", strings.NewReader(`{"server_id":1}`))
	req.SetPathValue("id", "xray")
	w := httptest.NewRecorder()
	api.PostHost(w, req)
	if w.Code != 410 { t.Fatalf("status=%d want 410, body=%s", w.Code, w.Body.String()) }
	if !strings.Contains(w.Body.String(), "/inbounds") {
		t.Fatalf("body should mention /inbounds: %s", w.Body.String())
	}
}

func TestDeleteHost_XrayReturns410(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	plugins.Register(xrayplugin.New())
	dsn := "file:" + filepath.Join(t.TempDir(), "x.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	defer d.Close()
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	store := &plugins.Store{DB: d, Now: time.Now}
	_ = store.UpsertEnabled(context.Background(), "xray", true)
	api := &PluginsAPI{Store: store, Deps: plugins.Deps{DB: d}}

	req := httptest.NewRequest("DELETE", "/api/admin/plugins/xray/hosts/1", nil)
	req.SetPathValue("id", "xray")
	req.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	api.DeleteHost(w, req)
	if w.Code != 410 { t.Fatalf("status=%d want 410", w.Code) }
}
```

Add import: `xrayplugin "github.com/hg-claw/Shepherd/internal/plugins/xray"`.

- [ ] **Step 2: Run test to verify FAIL**

```
go test -run 'TestPostHost_XrayReturns410|TestDeleteHost_XrayReturns410' ./internal/api/...
```

Expected: FAIL — current handlers don't special-case xray.

- [ ] **Step 3: Add the special case**

Edit `internal/api/plugins.go`. At the top of `PostHost`, after the `unknown plugin` check:

```go
if id == "xray" {
    writeError(w, http.StatusGone, "POST /hosts is deprecated for xray; use POST /api/admin/plugins/xray/inbounds")
    return
}
```

At the top of `DeleteHost`, after the `unknown plugin` check:

```go
if id == "xray" {
    writeError(w, http.StatusGone, "DELETE /hosts is deprecated for xray; use DELETE /api/admin/plugins/xray/inbounds/{id}")
    return
}
```

(Import `"net/http"` is already there.)

- [ ] **Step 4: Run tests to verify PASS**

```
go test ./internal/api/...
```

Expected: PASS for new tests; old PostHost/DeleteHost tests for non-xray plugins still PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/api/plugins.go internal/api/plugins_test.go
git commit -m "feat(api): /hosts endpoints return 410 Gone for xray (point to /inbounds)"
```

---

## Task 8: Web API client — XrayInbound types + fetchers

**Files:**
- Modify: `web/src/api/plugins.ts`

- [ ] **Step 1: Add types and fetchers**

Edit `web/src/api/plugins.ts`. Add near the existing xray-related types (right after `XrayTopologyRow`):

```ts
export interface XrayInbound {
  id: number
  server_id: number
  server_name: string
  tag: string
  port: number
  role: 'landing' | 'relay'
  protocol: 'vless-reality' | 'vmess-ws' | 'shadowsocks'
  uuid: string
  sni: string
  public_key: string
  private_key: string  // always "[REDACTED]" in GET responses
  short_id: string
  ws_path: string
  ss_method: string
  upstream_inbound_id: number | null
  upstream_tag: string | null
  upstream_server_id: number | null
  upstream_server_name: string | null
  created_at: string
  updated_at: string
}

export interface CreateXrayInboundBody {
  server_id: number
  port: number
  role: 'landing' | 'relay'
  protocol: 'vless-reality' | 'vmess-ws' | 'shadowsocks'
  uuid?: string
  sni?: string
  public_key?: string
  private_key?: string
  short_id?: string
  ws_path?: string
  ss_method?: string
  ss_password?: string
  upstream_inbound_id?: number
}

export interface PatchXrayInboundBody {
  port?: number
  uuid?: string
  sni?: string
  public_key?: string
  private_key?: string
  short_id?: string
  ws_path?: string
  ss_method?: string
  ss_password?: string
}

export const listXrayInbounds = (params: { server_id?: number } = {}) => {
  const q = new URLSearchParams()
  if (params.server_id) q.set('server_id', String(params.server_id))
  const qs = q.toString()
  return api.get<XrayInbound[]>(`/api/admin/plugins/xray/inbounds${qs ? '?' + qs : ''}`)
}

export const createXrayInbound = (body: CreateXrayInboundBody) =>
  api.post<XrayInbound>('/api/admin/plugins/xray/inbounds', body)

export const patchXrayInbound = (id: number, body: PatchXrayInboundBody) =>
  api.patch<XrayInbound>(`/api/admin/plugins/xray/inbounds/${id}`, body)

export const deleteXrayInbound = (id: number) =>
  api.del(`/api/admin/plugins/xray/inbounds/${id}`)
```

(If `api.patch` doesn't exist, add it alongside `api.get/post/del` in `web/src/api/client.ts`. Check first.)

- [ ] **Step 2: Verify TypeScript compiles**

```
cd /Users/hg/project/Shepherd/web && npm run build 2>&1 | tail -5
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
cd /Users/hg/project/Shepherd && git add web/src/api/plugins.ts && git commit -m "feat(web/api): XrayInbound types + CRUD fetchers for /inbounds"
```

---

## Task 9: `InboundsTab.tsx` — replaces `HostsTab`

**Files:**
- Create: `web/src/pages/admin/plugins/xray/InboundsTab.tsx`
- Create: `web/src/pages/admin/plugins/xray/InboundsTab.test.tsx`

- [ ] **Step 1: Write failing test**

`web/src/pages/admin/plugins/xray/InboundsTab.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import InboundsTab from './InboundsTab'
import * as pluginsAPI from '@/api/plugins'

vi.mock('@/api/plugins', async () => {
  const actual = await vi.importActual<typeof pluginsAPI>('@/api/plugins')
  return {
    ...actual,
    listXrayInbounds: vi.fn().mockResolvedValue([
      {
        id: 1, server_id: 10, server_name: 'tokyo-1', tag: 'landing-aa', port: 443,
        role: 'landing', protocol: 'vless-reality',
        uuid: 'u1', sni: 'www.lovelive-anime.jp', public_key: 'P1', private_key: '[REDACTED]', short_id: 'aa',
        ws_path: '', ss_method: '',
        upstream_inbound_id: null, upstream_tag: null, upstream_server_id: null, upstream_server_name: null,
        created_at: '', updated_at: '',
      },
      {
        id: 2, server_id: 10, server_name: 'tokyo-1', tag: 'landing-bb', port: 8443,
        role: 'landing', protocol: 'vless-reality',
        uuid: 'u2', sni: 'www.apple.com', public_key: 'P2', private_key: '[REDACTED]', short_id: 'bb',
        ws_path: '', ss_method: '',
        upstream_inbound_id: null, upstream_tag: null, upstream_server_id: null, upstream_server_name: null,
        created_at: '', updated_at: '',
      },
      {
        id: 3, server_id: 20, server_name: 'osaka-1', tag: 'relay-cc', port: 18443,
        role: 'relay', protocol: 'vless-reality',
        uuid: 'u3', sni: 'www.swift.org', public_key: 'P3', private_key: '[REDACTED]', short_id: 'cc',
        ws_path: '', ss_method: '',
        upstream_inbound_id: 1, upstream_tag: 'landing-aa',
        upstream_server_id: 10, upstream_server_name: 'tokyo-1',
        created_at: '', updated_at: '',
      },
    ] as pluginsAPI.XrayInbound[]),
    listPluginHosts: vi.fn().mockResolvedValue([
      { id: 1, server_id: 10, config: {}, deployed_version: '1.8.11', status: 'running', last_error: null, updated_at: '' },
      { id: 2, server_id: 20, config: {}, deployed_version: '1.8.11', status: 'running', last_error: null, updated_at: '' },
    ]),
  }
})

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe('InboundsTab', () => {
  it('groups inbounds by server and shows tags + roles', async () => {
    wrap(<InboundsTab />)
    expect(await screen.findByText('tokyo-1')).toBeInTheDocument()
    expect(screen.getByText('osaka-1')).toBeInTheDocument()
    expect(screen.getByText('landing-aa')).toBeInTheDocument()
    expect(screen.getByText('landing-bb')).toBeInTheDocument()
    expect(screen.getByText('relay-cc')).toBeInTheDocument()
    // Relay row shows upstream tag@server
    expect(screen.getByText(/landing-aa.*tokyo-1|tokyo-1.*landing-aa/)).toBeInTheDocument()
  })

  it('disables Delete on landing-aa because relay-cc depends on it', async () => {
    wrap(<InboundsTab />)
    const row = (await screen.findByText('landing-aa')).closest('tr')!
    const del = row.querySelector('button[title*="depend"]') as HTMLButtonElement | null
    expect(del?.disabled).toBe(true)
  })
})
```

- [ ] **Step 2: Verify test fails**

```
cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/plugins/xray/InboundsTab.test.tsx 2>&1 | tail -10
```

Expected: FAIL — component doesn't exist.

- [ ] **Step 3: Implement InboundsTab.tsx**

`web/src/pages/admin/plugins/xray/InboundsTab.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/Pill'
import { useUI } from '@/store/ui'
import { copyText } from '@/lib/clipboard'
import { buildShareURL } from './templates'
import InboundDialog from './InboundDialog'
import BulkRelayDialog from './BulkRelayDialog'
import {
  listXrayInbounds, deleteXrayInbound, listPluginHosts,
  type XrayInbound, type PluginHost,
} from '@/api/plugins'
import { useServers } from '@/api/servers'

export default function InboundsTab() {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const serversQ = useServers({ refetchInterval: 30_000 })
  const inboundsQ = useQuery({
    queryKey: ['xray-inbounds'],
    queryFn: () => listXrayInbounds(),
    refetchInterval: 5_000,
  })
  const hostsQ = useQuery({
    queryKey: ['plugin-hosts', 'xray'],
    queryFn: () => listPluginHosts('xray'),
    refetchInterval: 5_000,
  })

  // Group inbounds by server_id; one section per server.
  const groups = useMemo(() => {
    const m = new Map<number, XrayInbound[]>()
    for (const i of inboundsQ.data ?? []) {
      const arr = m.get(i.server_id) ?? []
      arr.push(i)
      m.set(i.server_id, arr)
    }
    return m
  }, [inboundsQ.data])

  // Count relay dependents per landing-inbound id
  const dependentsByLandingID = useMemo(() => {
    const m = new Map<number, number>()
    for (const i of inboundsQ.data ?? []) {
      if (i.role === 'relay' && i.upstream_inbound_id != null) {
        m.set(i.upstream_inbound_id, (m.get(i.upstream_inbound_id) ?? 0) + 1)
      }
    }
    return m
  }, [inboundsQ.data])

  // PluginHost lookup for xray version + process status
  const hostByServer = useMemo(() => {
    const m = new Map<number, PluginHost>()
    for (const h of hostsQ.data ?? []) m.set(h.server_id, h)
    return m
  }, [hostsQ.data])

  const del = useMutation({
    mutationFn: (id: number) => deleteXrayInbound(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['xray-inbounds'] })
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
    },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })

  const [dialog, setDialog] = useState<
    { kind: 'new'; serverID?: number } |
    { kind: 'edit'; inbound: XrayInbound } |
    { kind: 'bulk'; landing: XrayInbound } |
    null
  >(null)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] text-muted-foreground">
          Each row is one xray inbound. A single server can host multiple inbounds.
        </p>
        <Button size="sm" className="h-8" onClick={() => setDialog({ kind: 'new' })}>
          + New inbound
        </Button>
      </div>

      {(serversQ.data ?? []).map((s) => {
        const inbounds = groups.get(s.id) ?? []
        const host = hostByServer.get(s.id)
        return (
          <div key={s.id} className="rounded-lg border bg-elev overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b bg-background/40">
              <div className="text-[13px] font-mono">
                <span className="font-medium">{s.name}</span>
                <span className="text-fg-dim ml-2">
                  {s.ssh_host?.Valid ? s.ssh_host.String : '—'}
                </span>
                {host?.deployed_version && (
                  <span className="text-fg-dim ml-3">xray v{host.deployed_version}</span>
                )}
                {host && (
                  <span className="ml-3"><Pill kind={host.status === 'running' ? 'ok' : 'neutral'}>{host.status}</Pill></span>
                )}
              </div>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]"
                onClick={() => setDialog({ kind: 'new', serverID: s.id })}>
                + Add inbound
              </Button>
            </div>
            <table className="w-full text-[13px] border-collapse">
              <thead>
                <tr className="text-left">
                  <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Tag</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Role</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Protocol</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Port</th>
                  <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {inbounds.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-4 text-center text-muted-foreground text-[12.5px]">
                    No inbounds on this server.
                  </td></tr>
                )}
                {inbounds.map((i) => {
                  const dep = dependentsByLandingID.get(i.id) ?? 0
                  const isLanding = i.role === 'landing'
                  const hostname = s.ssh_host?.Valid ? s.ssh_host.String : ''
                  const shareURL = hostname && i.uuid && i.public_key && i.sni
                    ? buildShareURL({
                        inbound: 'vless-reality',
                        port: i.port, uuid: i.uuid, sni: i.sni,
                        publicKey: i.public_key, shortID: i.short_id,
                      }, hostname, `${s.name}/${i.tag}`)
                    : null
                  return (
                    <tr key={i.id} className="border-t">
                      <td className="px-3 py-2 font-mono">{i.tag}</td>
                      <td className="px-3 py-2">
                        {isLanding
                          ? <Pill kind="neutral">landing</Pill>
                          : (
                            <span className="font-mono">
                              <Pill kind="ok">relay</Pill>
                              <span className="text-fg-dim ml-1">→ {i.upstream_tag} @ {i.upstream_server_name}</span>
                            </span>
                          )}
                      </td>
                      <td className="px-3 py-2 font-mono text-[12.5px]">{i.protocol}</td>
                      <td className="px-3 py-2 font-mono text-[12.5px]">{i.port}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]"
                          disabled={!shareURL}
                          title={shareURL ? 'Copy share URL' : 'cannot build URL'}
                          onClick={async () => {
                            if (!shareURL) return
                            try { await copyText(shareURL); toast('success', 'Share URL copied') }
                            catch (e) { toast('error', String((e as Error)?.message ?? e)) }
                          }}>
                          Copy URL
                        </Button>
                        {isLanding && (
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]"
                            onClick={() => setDialog({ kind: 'bulk', landing: i })}>
                            + Bulk Relay
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]"
                          onClick={() => setDialog({ kind: 'edit', inbound: i })}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px] text-destructive"
                          disabled={del.isPending || dep > 0}
                          title={dep > 0 ? `${dep} relay(s) depend on this landing; delete them first` : undefined}
                          onClick={() => del.mutate(i.id)}>
                          Delete
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      })}

      {dialog?.kind === 'new' && (
        <InboundDialog
          key={`new-${dialog.serverID ?? 'any'}`}
          open={true}
          onOpenChange={(open) => { if (!open) setDialog(null) }}
          mode="create"
          defaultServerID={dialog.serverID}
          allInbounds={inboundsQ.data ?? []}
        />
      )}
      {dialog?.kind === 'edit' && (
        <InboundDialog
          key={`edit-${dialog.inbound.id}`}
          open={true}
          onOpenChange={(open) => { if (!open) setDialog(null) }}
          mode="edit"
          inbound={dialog.inbound}
          allInbounds={inboundsQ.data ?? []}
        />
      )}
      {dialog?.kind === 'bulk' && (
        <BulkRelayDialog
          key={`bulk-${dialog.landing.id}`}
          open={true}
          onOpenChange={(open) => { if (!open) setDialog(null) }}
          landingInbound={dialog.landing}
          allInbounds={inboundsQ.data ?? []}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run test, expect PASS**

```
cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/plugins/xray/InboundsTab.test.tsx 2>&1 | tail -10
```

Expected: PASS for 2 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd && git add web/src/pages/admin/plugins/xray/InboundsTab.tsx web/src/pages/admin/plugins/xray/InboundsTab.test.tsx && git commit -m "feat(web/xray): InboundsTab groups inbounds by server with per-row actions"
```

---

## Task 10: `InboundDialog.tsx` — replaces `DeployDialog`

**Files:**
- Create: `web/src/pages/admin/plugins/xray/InboundDialog.tsx`
- Create: `web/src/pages/admin/plugins/xray/InboundDialog.test.tsx`

- [ ] **Step 1: Write failing test**

`web/src/pages/admin/plugins/xray/InboundDialog.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import InboundDialog from './InboundDialog'
import * as pluginsAPI from '@/api/plugins'

vi.mock('@/api/plugins', async () => {
  const actual = await vi.importActual<typeof pluginsAPI>('@/api/plugins')
  return {
    ...actual,
    createXrayInbound: vi.fn().mockResolvedValue({ id: 99 }),
    patchXrayInbound: vi.fn().mockResolvedValue({ id: 1 }),
    generateX25519: vi.fn().mockResolvedValue({ private_key: 'priv', public_key: 'pub' }),
    generateShortID: vi.fn().mockResolvedValue({ short_id: 'sid' }),
  }
})
vi.mock('@/api/servers', () => ({
  useServers: () => ({ data: [
    { id: 10, name: 'tokyo-1', ssh_host: { Valid: true, String: '10.0.0.1' } },
    { id: 11, name: 'osaka-1', ssh_host: { Valid: true, String: '10.0.0.2' } },
  ] }),
}))

const landing: pluginsAPI.XrayInbound = {
  id: 1, server_id: 10, server_name: 'tokyo-1', tag: 'landing-aa', port: 443,
  role: 'landing', protocol: 'vless-reality',
  uuid: 'ul', sni: 'www.lovelive-anime.jp', public_key: 'PL', private_key: '[REDACTED]', short_id: 'aa',
  ws_path: '', ss_method: '',
  upstream_inbound_id: null, upstream_tag: null, upstream_server_id: null, upstream_server_name: null,
  created_at: '', updated_at: '',
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe('InboundDialog (create)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('relay role shows upstream selector with landings only', async () => {
    wrap(<InboundDialog open={true} onOpenChange={() => {}} mode="create"
      allInbounds={[landing]} />)
    // Select role=relay
    const roleSelect = await screen.findByLabelText(/role/i) as HTMLSelectElement
    fireEvent.change(roleSelect, { target: { value: 'relay' } })
    const upstreamSelect = await screen.findByLabelText(/upstream landing-inbound/i) as HTMLSelectElement
    const opts = Array.from(upstreamSelect.options).map((o) => o.value)
    expect(opts).toContain(String(landing.id))
  })

  it('submits POST /inbounds with the right body', async () => {
    wrap(<InboundDialog open={true} onOpenChange={() => {}} mode="create"
      defaultServerID={11} allInbounds={[landing]} />)
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    await waitFor(() => {
      expect(pluginsAPI.createXrayInbound).toHaveBeenCalled()
    })
    const body = (pluginsAPI.createXrayInbound as any).mock.calls[0][0]
    expect(body.server_id).toBe(11)
    expect(body.role).toBe('landing')
  })
})

describe('InboundDialog (edit)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('role, server, upstream and protocol are disabled in edit mode', async () => {
    wrap(<InboundDialog open={true} onOpenChange={() => {}} mode="edit"
      inbound={landing} allInbounds={[landing]} />)
    const roleSelect = await screen.findByLabelText(/role/i) as HTMLSelectElement
    expect(roleSelect.disabled).toBe(true)
    const serverSelect = screen.getByLabelText(/server/i) as HTMLSelectElement
    expect(serverSelect.disabled).toBe(true)
  })
})
```

- [ ] **Step 2: Verify FAIL**

```
cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/plugins/xray/InboundDialog.test.tsx 2>&1 | tail -10
```

Expected: FAIL — component doesn't exist.

- [ ] **Step 3: Implement InboundDialog.tsx**

`web/src/pages/admin/plugins/xray/InboundDialog.tsx`:

```tsx
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { useServers } from '@/api/servers'
import { useUI } from '@/store/ui'
import {
  createXrayInbound, patchXrayInbound, generateX25519, generateShortID,
  type XrayInbound,
} from '@/api/plugins'
import { randomPort, randomUUID } from './templates'

type Role = 'landing' | 'relay'
type Protocol = 'vless-reality' | 'vmess-ws' | 'shadowsocks'

interface CreateProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'create'
  defaultServerID?: number
  allInbounds: XrayInbound[]
}
interface EditProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'edit'
  inbound: XrayInbound
  allInbounds: XrayInbound[]
}
type Props = CreateProps | EditProps

export default function InboundDialog(props: Props) {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const serversQ = useServers()
  const editing = props.mode === 'edit' ? props.inbound : null

  // Lazy-init from props (mount = once)
  const [serverID, setServerID] = useState<number | ''>(
    editing?.server_id ?? props.mode === 'create' && (props as CreateProps).defaultServerID || ''
  )
  const [role, setRole] = useState<Role>(editing?.role ?? 'landing')
  const [protocol, setProtocol] = useState<Protocol>(editing?.protocol ?? 'vless-reality')
  const [upstreamID, setUpstreamID] = useState<number | ''>(editing?.upstream_inbound_id ?? '')
  const [port, setPort] = useState<number>(editing?.port ?? randomPort())
  const [uuid, setUUID] = useState<string>(editing?.uuid ?? randomUUID())
  const [sni, setSNI] = useState<string>(editing?.sni ?? 'www.lovelive-anime.jp')
  const [publicKey, setPublicKey] = useState<string>(editing?.public_key ?? '')
  const [privateKey, setPrivateKey] = useState<string>('') // never preloaded from edit (it's redacted)
  const [shortID, setShortID] = useState<string>(editing?.short_id ?? '')
  const [wsPath, setWSPath] = useState<string>(editing?.ws_path ?? '/ws')
  const [error, setError] = useState<string | null>(null)

  const landings = props.allInbounds.filter((i) => i.role === 'landing')

  const create = useMutation({
    mutationFn: () => {
      if (!serverID) throw new Error('select a server')
      if (role === 'relay' && !upstreamID) throw new Error('relay requires upstream landing')
      return createXrayInbound({
        server_id: Number(serverID), port, role, protocol,
        uuid, sni, public_key: publicKey, private_key: privateKey, short_id: shortID,
        ws_path: protocol === 'vmess-ws' ? wsPath : undefined,
        upstream_inbound_id: role === 'relay' ? Number(upstreamID) : undefined,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['xray-inbounds'] })
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
      toast('success', 'Inbound created')
      props.onOpenChange(false)
    },
    onError: (e: any) => setError(String(e?.message ?? e)),
  })

  const patch = useMutation({
    mutationFn: () => {
      if (!editing) throw new Error('not in edit mode')
      return patchXrayInbound(editing.id, {
        port,
        uuid: uuid !== editing.uuid ? uuid : undefined,
        sni: sni !== editing.sni ? sni : undefined,
        public_key: publicKey !== editing.public_key ? publicKey : undefined,
        private_key: privateKey || undefined,
        short_id: shortID !== editing.short_id ? shortID : undefined,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['xray-inbounds'] })
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
      toast('success', 'Inbound updated')
      props.onOpenChange(false)
    },
    onError: (e: any) => setError(String(e?.message ?? e)),
  })

  const isEdit = props.mode === 'edit'
  const submit = () => (isEdit ? patch.mutate() : create.mutate())

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono">
            {isEdit ? `Edit inbound ${editing!.tag}` : 'New inbound'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[12px]" htmlFor="ind-server">Server</Label>
              <select id="ind-server"
                aria-label="server"
                value={serverID}
                onChange={(e) => setServerID(Number(e.target.value) || '')}
                disabled={isEdit}
                className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full disabled:opacity-60">
                <option value="">— select —</option>
                {(serversQ.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-[12px]" htmlFor="ind-role">Role</Label>
              <select id="ind-role"
                aria-label="role"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                disabled={isEdit}
                className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full disabled:opacity-60">
                <option value="landing">Landing</option>
                <option value="relay">Relay</option>
              </select>
            </div>
          </div>

          {role === 'relay' && (
            <div>
              <Label className="text-[12px]" htmlFor="ind-upstream">Upstream landing-inbound</Label>
              <select id="ind-upstream"
                aria-label="upstream landing-inbound"
                value={upstreamID}
                onChange={(e) => setUpstreamID(Number(e.target.value) || '')}
                disabled={isEdit}
                className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full disabled:opacity-60">
                <option value="">— select —</option>
                {landings.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.server_name} / {l.tag} (:{l.port})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[12px]">Protocol</Label>
              <select value={protocol}
                onChange={(e) => setProtocol(e.target.value as Protocol)}
                disabled={isEdit}
                className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full disabled:opacity-60">
                <option value="vless-reality">VLESS + REALITY</option>
                <option value="vmess-ws">VMess + WS</option>
                <option value="shadowsocks">Shadowsocks</option>
              </select>
            </div>
            <div>
              <Label className="text-[12px]">Port</Label>
              <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))}
                className="h-8 font-mono mt-1" />
            </div>
          </div>

          <div>
            <Label className="text-[12px]">UUID</Label>
            <div className="flex gap-2 mt-1">
              <Input value={uuid} onChange={(e) => setUUID(e.target.value)}
                className="h-8 font-mono text-[12px]" />
              <Button type="button" variant="outline" size="sm" className="h-8"
                onClick={() => setUUID(randomUUID())}>new</Button>
            </div>
          </div>

          {protocol === 'vless-reality' && (
            <>
              <div>
                <Label className="text-[12px]">REALITY SNI (target domain)</Label>
                <Input value={sni} onChange={(e) => setSNI(e.target.value)}
                  className="h-8 font-mono mt-1" />
                <p className="text-fg-dim text-[11px] mt-1">
                  Must be a single-tenant TLS endpoint. Do NOT use multi-tenant CDNs.
                </p>
              </div>
              <div>
                <Label className="text-[12px]">REALITY keypair</Label>
                <div className="flex gap-2 mt-1">
                  <Input value={privateKey} placeholder="private" readOnly
                    className="h-8 font-mono text-[11px]" />
                  <Input value={publicKey} placeholder="public" readOnly
                    className="h-8 font-mono text-[11px]" />
                  <Button type="button" variant="outline" size="sm" className="h-8"
                    onClick={async () => {
                      const kp = await generateX25519()
                      setPrivateKey(kp.private_key); setPublicKey(kp.public_key)
                    }}>Generate</Button>
                </div>
              </div>
              <div>
                <Label className="text-[12px]">Short ID</Label>
                <div className="flex gap-2 mt-1">
                  <Input value={shortID} onChange={(e) => setShortID(e.target.value)}
                    className="h-8 font-mono" />
                  <Button type="button" variant="outline" size="sm" className="h-8"
                    onClick={async () => {
                      const r = await generateShortID()
                      setShortID(r.short_id)
                    }}>Generate</Button>
                </div>
              </div>
            </>
          )}

          {protocol === 'vmess-ws' && (
            <div>
              <Label className="text-[12px]">WebSocket path</Label>
              <Input value={wsPath} onChange={(e) => setWSPath(e.target.value)}
                className="h-8 font-mono mt-1" />
            </div>
          )}

          {error && <p className="text-err text-[12px]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>Cancel</Button>
          <Button disabled={create.isPending || patch.isPending} onClick={submit}>
            {isEdit ? (patch.isPending ? 'Saving…' : 'Save') : (create.isPending ? 'Creating…' : 'Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Run tests**

```
cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/plugins/xray/InboundDialog.test.tsx 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd && git add web/src/pages/admin/plugins/xray/InboundDialog.tsx web/src/pages/admin/plugins/xray/InboundDialog.test.tsx && git commit -m "feat(web/xray): InboundDialog with create/edit modes; immutable fields locked in edit"
```

---

## Task 11: Refactor `BulkRelayDialog` to inbound-level

**Files:**
- Modify: `web/src/pages/admin/plugins/xray/BulkRelayDialog.tsx`
- Modify: `web/src/pages/admin/plugins/xray/BulkRelayDialog.test.tsx`

- [ ] **Step 1: Update Props + behavior**

Replace the contents of `web/src/pages/admin/plugins/xray/BulkRelayDialog.tsx` with:

```tsx
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { useServers } from '@/api/servers'
import {
  createXrayInbound, fetchXrayVersions, generateX25519, generateShortID,
  type XrayInbound,
} from '@/api/plugins'
import { useUI } from '@/store/ui'
import { randomPort, randomUUID } from './templates'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  landingInbound: XrayInbound   // selected landing inbound
  allInbounds: XrayInbound[]    // for port-conflict hints per-server
}

interface RelayDraft {
  serverID: number
  serverName: string
  port: number
  uuid: string
  privateKey: string
  publicKey: string
  shortID: string
}

function newDraft(serverID: number, serverName: string, takenPorts: Set<number>): RelayDraft {
  let port = randomPort()
  while (takenPorts.has(port)) port = randomPort()
  return {
    serverID, serverName, port,
    uuid: randomUUID(),
    privateKey: '', publicKey: '', shortID: '',
  }
}

export default function BulkRelayDialog({ open, onOpenChange, landingInbound, allInbounds }: Props) {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const serversQ = useServers()
  const versionsQ = useQuery({ queryKey: ['xray-versions'], queryFn: fetchXrayVersions, enabled: open })

  // Map server_id -> Set<port> for port conflict avoidance.
  const portsByServer = useMemo(() => {
    const m = new Map<number, Set<number>>()
    for (const i of allInbounds) {
      const s = m.get(i.server_id) ?? new Set<number>()
      s.add(i.port); m.set(i.server_id, s)
    }
    return m
  }, [allInbounds])

  // Targets: ALL enrolled servers (multi-inbound makes "already has xray" irrelevant).
  // Exclude only the landing's own server (don't put a relay back at its own landing).
  const targets = useMemo(() => {
    return (serversQ.data ?? []).filter((s) => s.id !== landingInbound.server_id)
  }, [serversQ.data, landingInbound.server_id])

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [drafts, setDrafts] = useState<Map<number, RelayDraft>>(new Map())
  const [sharedSNI, setSharedSNI] = useState<string>(landingInbound.sni || 'www.lovelive-anime.jp')

  const toggle = (s: { id: number; name: string }) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(s.id)) {
        next.delete(s.id)
        setDrafts((dPrev) => { const d = new Map(dPrev); d.delete(s.id); return d })
      } else {
        next.add(s.id)
        const taken = portsByServer.get(s.id) ?? new Set<number>()
        setDrafts((dPrev) => {
          const d = new Map(dPrev)
          d.set(s.id, newDraft(s.id, s.name, taken))
          return d
        })
      }
      return next
    })
  }

  const regenKeys = async (id: number) => {
    const kp = await generateX25519()
    const sid = await generateShortID()
    setDrafts((prev) => {
      const d = new Map(prev)
      const cur = d.get(id); if (!cur) return prev
      d.set(id, { ...cur, privateKey: kp.private_key, publicKey: kp.public_key, shortID: sid.short_id })
      return d
    })
  }

  // Eager fill on selection (defensive against the "click Deploy All before keys arrive" race)
  for (const [id, d] of drafts) {
    if (!d.privateKey || !d.publicKey || !d.shortID) {
      void regenKeys(id); break
    }
  }

  const deploy = useMutation({
    mutationFn: async () => {
      const ids = Array.from(selected.values()).sort((a, b) => a - b)
      let ok = 0, fail = 0
      for (const id of ids) {
        const d = drafts.get(id)!
        if (!d.privateKey || !d.publicKey || !d.shortID) {
          await regenKeys(id)
        }
        const refresh = drafts.get(id)!
        try {
          await createXrayInbound({
            server_id: id, port: refresh.port, role: 'relay',
            protocol: 'vless-reality',
            uuid: refresh.uuid, sni: sharedSNI,
            public_key: refresh.publicKey, private_key: refresh.privateKey,
            short_id: refresh.shortID,
            upstream_inbound_id: landingInbound.id,
          })
          ok++
          toast('success', `Deployed relay on ${d.serverName}`)
        } catch (e: any) {
          fail++
          toast('error', `${d.serverName}: ${String(e?.message ?? e)}`)
        }
      }
      return { ok, fail }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['xray-inbounds'] })
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
    },
    onSuccess: ({ ok, fail }) => {
      toast(fail === 0 ? 'success' : 'info', `Bulk relay: ${ok} ok, ${fail} failed`)
      if (fail === 0) onOpenChange(false)
    },
  })

  const version = versionsQ.data?.latest?.[0]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">
            Add relays → {landingInbound.tag} @ {landingInbound.server_name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-[12px]">REALITY SNI (shared)</Label>
            <Input value={sharedSNI} onChange={(e) => setSharedSNI(e.target.value)}
              className="h-8 font-mono mt-1" />
          </div>

          <div>
            <Label className="text-[12px]">Target servers</Label>
            <div className="mt-1 rounded-md border bg-elev max-h-64 overflow-y-auto">
              {targets.length === 0 && (
                <p className="px-3 py-4 text-[12px] text-muted-foreground">No eligible servers.</p>
              )}
              {targets.map((s) => {
                const checked = selected.has(s.id)
                const d = drafts.get(s.id)
                const taken = portsByServer.get(s.id) ?? new Set<number>()
                return (
                  <label key={s.id}
                    className="flex items-center gap-3 px-3 py-2 border-b last:border-b-0 text-[12.5px]">
                    <input type="checkbox" checked={checked} onChange={() => toggle({ id: s.id, name: s.name })}
                      aria-label={`select ${s.name}`} />
                    <span className="font-mono w-32 truncate">{s.name}</span>
                    {taken.size > 0 && (
                      <span className="text-fg-dim text-[10.5px]" title={`used: ${Array.from(taken).join(', ')}`}>
                        {taken.size} port(s) in use
                      </span>
                    )}
                    {checked && d && (
                      <>
                        <span className="font-mono text-fg-dim">port</span>
                        <Input type="number" value={d.port}
                          onChange={(e) => setDrafts((prev) => {
                            const m = new Map(prev); m.set(s.id, { ...d, port: Number(e.target.value) }); return m
                          })}
                          className="h-7 w-24 font-mono" />
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]"
                          onClick={(e) => { e.preventDefault(); void regenKeys(s.id) }}>↻ keys</Button>
                        <span className="font-mono text-fg-dim text-[10px] truncate" title={d.publicKey}>
                          {d.publicKey ? d.publicKey.slice(0, 8) + '…' : 'generating…'}
                        </span>
                      </>
                    )}
                  </label>
                )
              })}
            </div>
          </div>

          {version && <p className="text-fg-dim text-[11px]">Uses xray v{version} (taken from the landing's deployed version).</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={deploy.isPending || selected.size === 0}
            onClick={() => deploy.mutate()}>
            {deploy.isPending ? 'Deploying…' : `Deploy all (${selected.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Update test fixture and assertions**

Replace `web/src/pages/admin/plugins/xray/BulkRelayDialog.test.tsx` with:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import BulkRelayDialog from './BulkRelayDialog'
import * as pluginsAPI from '@/api/plugins'

vi.mock('@/api/plugins', async () => {
  const actual = await vi.importActual<typeof pluginsAPI>('@/api/plugins')
  return {
    ...actual,
    createXrayInbound: vi.fn().mockResolvedValue({ id: 99 }),
    fetchXrayVersions: vi.fn().mockResolvedValue({ latest: ['1.8.11'], cached: [] }),
    generateX25519: vi.fn().mockResolvedValue({ private_key: 'priv', public_key: 'pub' }),
    generateShortID: vi.fn().mockResolvedValue({ short_id: 'sid' }),
  }
})
vi.mock('@/api/servers', () => ({
  useServers: () => ({ data: [
    { id: 10, name: 'tokyo-1', ssh_host: { Valid: true, String: '10.0.0.1' } },
    { id: 11, name: 'osaka-1', ssh_host: { Valid: true, String: '10.0.0.2' } },
    { id: 12, name: 'mumbai-1', ssh_host: { Valid: true, String: '10.0.0.3' } },
  ] }),
}))

const landingInbound: pluginsAPI.XrayInbound = {
  id: 1, server_id: 10, server_name: 'tokyo-1', tag: 'landing-aa', port: 443,
  role: 'landing', protocol: 'vless-reality',
  uuid: 'ul', sni: 'www.lovelive-anime.jp', public_key: 'PL', private_key: '[REDACTED]', short_id: 'aa',
  ws_path: '', ss_method: '',
  upstream_inbound_id: null, upstream_tag: null, upstream_server_id: null, upstream_server_name: null,
  created_at: '', updated_at: '',
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe('BulkRelayDialog (inbound-level)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists target servers excluding the landing\'s own server', async () => {
    wrap(<BulkRelayDialog open={true} onOpenChange={() => {}}
      landingInbound={landingInbound} allInbounds={[landingInbound]} />)
    expect(screen.queryByLabelText(/select tokyo-1/)).toBeNull()  // landing's own server
    expect(await screen.findByLabelText(/select osaka-1/)).toBeInTheDocument()
    expect(screen.getByLabelText(/select mumbai-1/)).toBeInTheDocument()
  })

  it('includes servers that already have other inbounds (multi-inbound allows it)', async () => {
    const allInbounds = [
      landingInbound,
      { ...landingInbound, id: 2, server_id: 11, tag: 'landing-bb', port: 443 },
    ]
    wrap(<BulkRelayDialog open={true} onOpenChange={() => {}}
      landingInbound={landingInbound} allInbounds={allInbounds as pluginsAPI.XrayInbound[]} />)
    expect(await screen.findByLabelText(/select osaka-1/)).toBeInTheDocument()
    // osaka-1 row shows "1 port(s) in use" hint
    expect(screen.getByText(/1 port\(s\) in use/)).toBeInTheDocument()
  })

  it('calls createXrayInbound once per selected target with role=relay + upstream_inbound_id', async () => {
    wrap(<BulkRelayDialog open={true} onOpenChange={() => {}}
      landingInbound={landingInbound} allInbounds={[landingInbound]} />)
    fireEvent.click(await screen.findByLabelText(/select osaka-1/))
    fireEvent.click(screen.getByLabelText(/select mumbai-1/))
    fireEvent.click(screen.getByRole('button', { name: /deploy all/i }))
    await waitFor(() => {
      expect(pluginsAPI.createXrayInbound).toHaveBeenCalledTimes(2)
    })
    const first = (pluginsAPI.createXrayInbound as any).mock.calls[0][0]
    expect(first.role).toBe('relay')
    expect(first.upstream_inbound_id).toBe(landingInbound.id)
    expect(first.server_id).toBe(11)  // osaka-1
  })
})
```

- [ ] **Step 3: Run tests**

```
cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/plugins/xray/BulkRelayDialog.test.tsx 2>&1 | tail -10
```

Expected: PASS for all 3 tests.

- [ ] **Step 4: Commit**

```bash
cd /Users/hg/project/Shepherd && git add web/src/pages/admin/plugins/xray/BulkRelayDialog.tsx web/src/pages/admin/plugins/xray/BulkRelayDialog.test.tsx && git commit -m "refactor(web/xray): BulkRelayDialog targets inbounds (allows server reuse)"
```

---

## Task 12: Wire `InboundsTab` into plugin index; remove `HostsTab`

**Files:**
- Modify: `web/src/pages/admin/plugins/xray/index.tsx`

- [ ] **Step 1: Inspect current tab order**

```
sed -n '1,30p' web/src/pages/admin/plugins/xray/index.tsx
```

Identify the existing tab list (likely a const exporting `[{label: 'Hosts', component: HostsTab}, ...]`).

- [ ] **Step 2: Replace HostsTab with InboundsTab**

Edit `web/src/pages/admin/plugins/xray/index.tsx`:

```tsx
import InboundsTab from './InboundsTab'
import ConfigTab from './ConfigTab'
import EventsTab from './EventsTab'
import LogsTab from './LogsTab'

export default {
  tabs: [
    { id: 'inbounds', label: 'Inbounds', component: InboundsTab },
    { id: 'config',   label: 'Config',   component: ConfigTab },
    { id: 'events',   label: 'Events',   component: EventsTab },
    { id: 'logs',     label: 'Logs',     component: LogsTab },
  ],
}
```

(Match the existing module-shape exactly; this is illustrative.)

- [ ] **Step 3: Verify build**

```
cd /Users/hg/project/Shepherd/web && npm run build 2>&1 | tail -5
```

Expected: build succeeds. (Old HostsTab is no longer referenced but the file still exists — Task 13 cleans it up.)

- [ ] **Step 4: Commit**

```bash
cd /Users/hg/project/Shepherd && git add web/src/pages/admin/plugins/xray/index.tsx && git commit -m "feat(web/xray): mount InboundsTab in place of HostsTab in plugin tab order"
```

---

## Task 13: Delete obsolete frontend files

**Files:**
- Delete: `web/src/pages/admin/plugins/xray/HostsTab.tsx`
- Delete: `web/src/pages/admin/plugins/xray/HostsTab.test.tsx` (if exists)
- Delete: `web/src/pages/admin/plugins/xray/DeployDialog.tsx`
- Modify: `web/src/pages/admin/plugins/xray/templates.ts` — remove `renderTemplate`, `parseConfig`, `vlessReality`, `vmessWS`; keep `buildShareURL`, `randomPort`, `randomUUID`
- Modify: `web/src/pages/admin/plugins/xray/templates.test.ts` — drop tests for removed functions; keep `buildShareURL` tests

- [ ] **Step 1: Delete the obsolete component files**

```
cd /Users/hg/project/Shepherd
rm web/src/pages/admin/plugins/xray/HostsTab.tsx
[ -f web/src/pages/admin/plugins/xray/HostsTab.test.tsx ] && rm web/src/pages/admin/plugins/xray/HostsTab.test.tsx
rm web/src/pages/admin/plugins/xray/DeployDialog.tsx
```

- [ ] **Step 2: Strip templates.ts to share-URL-only**

Replace `web/src/pages/admin/plugins/xray/templates.ts` with:

```ts
// templates.ts — utility helpers for the xray plugin UI.
// Multi-inbound (Phase 3c-1) moved config rendering to the server,
// so `renderTemplate` / `parseConfig` are no longer used. This file
// keeps only the share-URL builder + random helpers used by dialogs.

export type Inbound = 'vless-reality' | 'vmess-ws'

export interface TemplateValues {
  inbound: Inbound
  port: number
  uuid?: string
  sni?: string
  publicKey?: string
  privateKey?: string
  shortID?: string
  wsPath?: string
}

export function buildShareURL(parsed: TemplateValues, hostname: string, label: string): string | null {
  if (!hostname || !parsed.port || !parsed.uuid) return null

  if (parsed.inbound === 'vless-reality') {
    if (!parsed.publicKey) return null
    const q = new URLSearchParams({
      encryption: 'none',
      security: 'reality',
      sni: parsed.sni ?? '',
      fp: 'chrome',
      pbk: parsed.publicKey,
      sid: parsed.shortID ?? '',
      type: 'tcp',
      flow: 'xtls-rprx-vision',
    })
    return `vless://${parsed.uuid}@${hostname}:${parsed.port}?${q.toString()}#${encodeURIComponent(label)}`
  }

  if (parsed.inbound === 'vmess-ws') {
    const obj = {
      v: '2', ps: label, add: hostname, port: String(parsed.port),
      id: parsed.uuid, aid: '0', scy: 'auto', net: 'ws', type: 'none',
      host: '', path: parsed.wsPath ?? '/ws', tls: '',
    }
    return `vmess://${btoa(JSON.stringify(obj))}`
  }
  return null
}

export function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000)
}

export function randomUUID(): string {
  if ('randomUUID' in crypto) return (crypto as any).randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
```

- [ ] **Step 3: Strip templates.test.ts**

Replace `web/src/pages/admin/plugins/xray/templates.test.ts` with:

```ts
import { describe, it, expect } from 'vitest'
import { buildShareURL } from './templates'

describe('buildShareURL', () => {
  it('generates a vless-reality URL', () => {
    const url = buildShareURL({
      inbound: 'vless-reality', port: 443,
      uuid: '11111111-1111-4111-8111-111111111111',
      sni: 'www.lovelive-anime.jp',
      publicKey: 'PK', shortID: 'ab',
    }, '1.2.3.4', 'edge-1')!
    expect(url).toMatch(/^vless:\/\/11111111-1111-4111-8111-111111111111@1\.2\.3\.4:443\?/)
    expect(url).toContain('security=reality')
    expect(url).toContain('sni=www.lovelive-anime.jp')
    expect(url).toContain('pbk=PK')
    expect(url).toContain('sid=ab')
    expect(url.endsWith('#edge-1')).toBe(true)
  })

  it('generates a vmess-ws URL with base64 JSON payload', () => {
    const url = buildShareURL({
      inbound: 'vmess-ws', port: 9000,
      uuid: '22222222-2222-4222-8222-222222222222',
      wsPath: '/ws',
    }, '1.2.3.4', 'ws-1')!
    expect(url.startsWith('vmess://')).toBe(true)
    const decoded = JSON.parse(atob(url.slice('vmess://'.length)))
    expect(decoded.add).toBe('1.2.3.4')
    expect(decoded.port).toBe('9000')
  })

  it('returns null on incomplete data', () => {
    expect(buildShareURL({ inbound: 'vless-reality', port: 0, uuid: 'u', publicKey: 'k' } as any, '1.2.3.4', 'x')).toBeNull()
    expect(buildShareURL({ inbound: 'vless-reality', port: 443, uuid: 'u', publicKey: 'k' } as any, '', 'x')).toBeNull()
    expect(buildShareURL({ inbound: 'vless-reality', port: 443, uuid: 'u' } as any, '1.2.3.4', 'x')).toBeNull()
  })
})
```

- [ ] **Step 4: Run web tests + build**

```
cd /Users/hg/project/Shepherd/web && npx vitest run 2>&1 | tail -10 && npm run build 2>&1 | tail -5
```

Expected: all tests pass (including the new InboundsTab/InboundDialog/BulkRelayDialog tests); build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add -u web/src/pages/admin/plugins/xray/
git commit -m "chore(web/xray): drop HostsTab/DeployDialog/renderTemplate; templates.ts keeps share-URL only"
```

---

## Task 14: PATCH `/servers/:id` for xray version upgrade (optional v1 polish)

**Files:**
- Modify: `internal/plugins/xray/routes.go` (add handler)
- Modify: `internal/plugins/xray/routes_test.go` (add test)

Allows admins to change the xray binary version on a server independently of any inbound mutation. Without this, version change still requires deleting and recreating an inbound (which triggers the binary fetch path). v1 ships this as a small QoL endpoint.

- [ ] **Step 1: Write failing test**

Append to `internal/plugins/xray/routes_test.go`:

```go
func TestPatchServerVersion_TriggersBinaryPushAndRestart(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "v.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations())
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_password,ssh_port,agent_os,agent_arch,created_at,updated_at)
		VALUES (1,'s1','1.1.1.1','r','x',22,'linux','amd64',?,?)`, time.Now(), time.Now())
	// plugin_hosts row with old version
	d.MustExec(`INSERT INTO plugin_hosts(plugin_id,server_id,config,deployed_version,status,updated_at)
		VALUES ('xray',1,'{}','1.8.10','running',?)`, time.Now())

	exec := &fakeHostExec{}
	deps := plugins.Deps{DB: d, HostExec: exec}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("PATCH", "/servers/1", strings.NewReader(`{"version":"1.8.11"}`))
	req.SetPathValue("id", "1")
	patchServerVersionHandler(deps)(w, req)
	if w.Code != 200 { t.Fatalf("status=%d body=%s", w.Code, w.Body.String()) }
	// plugin_hosts.deployed_version updated
	var v string
	_ = d.Get(&v, `SELECT deployed_version FROM plugin_hosts WHERE server_id=1 AND plugin_id='xray'`)
	if v != "1.8.11" { t.Fatalf("deployed_version=%q", v) }
}
```

Add `"strings"` import if missing.

- [ ] **Step 2: Implement handler**

Append to `internal/plugins/xray/inbounds_routes.go` (or a new `server_routes.go`):

```go
type patchVersionBody struct {
	Version string `json:"version"`
}

func patchServerVersionHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sid, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if sid == 0 { writeError(w, 400, "id required"); return }
		var body patchVersionBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeError(w, 400, "bad json"); return
		}
		if body.Version == "" { writeError(w, 400, "version required"); return }
		// Update plugin_hosts.deployed_version
		_, err := deps.DB.ExecContext(r.Context(),
			`INSERT INTO plugin_hosts(plugin_id, server_id, config, deployed_version, status, updated_at)
			 VALUES ('xray', ?, '{}', ?, 'deploying', ?)
			 ON CONFLICT(plugin_id, server_id) DO UPDATE
			 SET deployed_version = excluded.deployed_version, status='deploying', updated_at = excluded.updated_at`,
			sid, body.Version, time.Now().UTC())
		if err != nil { writeError(w, 500, err.Error()); return }
		// Push new binary + restart in background
		go func() {
			ctx := context.Background()
			p := &Plugin{}
			// Re-use the existing legacy DeployToHost path: it fetches the binary
			// and pushes binary+unit+restart (config push is no-op when we don't
			// touch /etc/shepherd-xray/config.json). After binary push, follow up
			// with AssembleAndDeploy to refresh the config and restart cleanly.
			if err := p.DeployToHost(ctx, deps, sid, body.Version, []byte("{}")); err != nil {
				_, _ = deps.DB.ExecContext(ctx,
					`UPDATE plugin_hosts SET status='failed', last_error=? WHERE plugin_id='xray' AND server_id=?`,
					err.Error(), sid)
				return
			}
			_ = AssembleAndDeploy(ctx, deps, sid)
			_, _ = deps.DB.ExecContext(ctx,
				`UPDATE plugin_hosts SET status='running', last_error='' WHERE plugin_id='xray' AND server_id=?`,
				sid)
		}()
		writeJSONResp(w, 200, map[string]any{"ok": true, "version": body.Version})
	}
}
```

- [ ] **Step 3: Register route**

In `(p *Plugin) RegisterRoutes`:

```go
mux.HandleFunc("PATCH /servers/{id}", patchServerVersionHandler(deps))
```

- [ ] **Step 4: Run tests**

```
go test ./internal/plugins/xray/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/xray/inbounds_routes.go internal/plugins/xray/routes.go internal/plugins/xray/routes_test.go
git commit -m "feat(plugins/xray): PATCH /servers/:id endpoint for version upgrade"
```

---

## Task 15: Wire version-upgrade UI into InboundsTab header

**Files:**
- Modify: `web/src/api/plugins.ts` (add `patchXrayServerVersion`)
- Modify: `web/src/pages/admin/plugins/xray/InboundsTab.tsx` (inline form in server header)

- [ ] **Step 1: Add API client**

In `web/src/api/plugins.ts`:

```ts
export const patchXrayServerVersion = (serverID: number, version: string) =>
  api.patch<{ ok: true; version: string }>(`/api/admin/plugins/xray/servers/${serverID}`, { version })
```

- [ ] **Step 2: Add inline form to server header**

In `InboundsTab.tsx`, inside the server section header (where `xray v{host.deployed_version}` is rendered), wrap with an editable inline form:

```tsx
function VersionInline({ serverID, current }: { serverID: number; current: string | null }) {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(current ?? '')
  const apply = useMutation({
    mutationFn: () => patchXrayServerVersion(serverID, value),
    onSuccess: () => {
      toast('success', `Upgrading to v${value}`)
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
      setEditing(false)
    },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })
  if (!editing) {
    return (
      <span className="text-fg-dim">
        xray v{current ?? '—'}{' '}
        <button className="text-fg-dim underline" onClick={() => setEditing(true)}>change</button>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Input value={value} onChange={(e) => setValue(e.target.value)}
        className="h-6 w-20 font-mono text-[11px]" />
      <Button size="sm" className="h-6 px-2 text-[11px]" disabled={apply.isPending}
        onClick={() => apply.mutate()}>Apply</Button>
      <button className="text-fg-dim text-[11px]" onClick={() => setEditing(false)}>cancel</button>
    </span>
  )
}
```

Import `patchXrayServerVersion`, `Input`, `useMutation`, `useQueryClient`, `Button` in the same file. Then replace the old inline `xray v{host.deployed_version}` span with `<VersionInline serverID={s.id} current={host?.deployed_version ?? null} />`.

- [ ] **Step 3: Run build + tests**

```
cd /Users/hg/project/Shepherd/web && npm run build 2>&1 | tail -5 && npx vitest run src/pages/admin/plugins/xray/ 2>&1 | tail -5
```

Expected: build OK; existing InboundsTab test still passes (the test mocks `listXrayInbounds` and renders without exercising the version UI).

- [ ] **Step 4: Commit**

```bash
cd /Users/hg/project/Shepherd && git add web/src/api/plugins.ts web/src/pages/admin/plugins/xray/InboundsTab.tsx && git commit -m "feat(web/xray): inline version-upgrade control in InboundsTab server header"
```

---

## Task 16: End-to-end smoke + PR

**Files:** none (manual checklist + PR open)

- [ ] **Step 1: Full local CI rehearsal**

```
cd /Users/hg/project/Shepherd
go test -count=1 ./...
go build ./...
golangci-lint run --timeout=5m
cd web && npx vitest run && npm run build
```

All must be green / 0 issues / build OK. If npm build removed `internal/web/dist/.gitkeep`, `touch internal/web/dist/.gitkeep && git add internal/web/dist/.gitkeep`.

- [ ] **Step 2: Smoke against a real environment**

Build a fresh Shepherd binary, point at a throwaway sqlite DB. Enroll 3 servers via agent.

1. `POST /inbounds` for server-A, role=landing, port=443 → InboundsTab shows landing-XX row under server-A, xray running.
2. Copy URL → import to client → connect → traffic flows out via server-A. Verify access log.
3. `POST /inbounds` for server-A, role=landing, port=8443 → server-A section now has 2 rows, xray restarted once, both ports work.
4. `POST /inbounds` for server-B, role=relay, upstream=landing-XX → relay row appears under server-B; client connects via relay-B and reaches the internet via server-A.
5. Try DELETE on landing-XX → 409, Delete button on UI disabled with tooltip.
6. DELETE relay on server-B → success; DELETE landing-XX → success; server-A still serves port 8443.
7. DELETE the last inbound on server-A → server-A section header shows `status=stopped`.
8. From a landing-inbound row click `+ Bulk Relay`, multi-select server-B and server-C, Deploy all → 2 relays created, both reachable.
9. Edit a relay's UUID via Edit dialog → save → server xray restarts → new UUID required on client side.
10. Migration upgrade: start with a v0.3.x DB (plugin_hosts with config JSON + xray_host_topology rows). Boot v0.3.1+ binary → `xray_inbounds` populated, plugin_hosts.config = `{}`, all existing landings/relays still reachable.

- [ ] **Step 3: Open PR**

```bash
cd /Users/hg/project/Shepherd
git push origin spec-phase3c-xray-multi-inbound   # (or whatever branch you used)
gh pr create --base main --title "feat(xray): single process, multiple inbounds (Phase 3c-1)" --body "$(cat <<'EOF'
Implements docs/superpowers/specs/2026-05-19-xray-multi-inbound-design.md.

## Summary
- New xray_inbounds table; each row = one inbound on one server
- Topology stored as xray_inbounds.upstream_inbound_id (self-ref FK, RESTRICT)
- plugin_hosts degrades to server-level xray process state
- Server-side config render assembles full multi-inbound xray config on every change
- /inbounds CRUD endpoints; old /hosts and /topology return 410 Gone for xray
- InboundsTab + InboundDialog + refactored BulkRelayDialog replace HostsTab + DeployDialog
- Data migration from v0.3.x preserves existing landings/relays

## Test plan
- [x] go test -count=1 ./... all green
- [x] golangci-lint 0 issues
- [x] vitest all green; npm run build OK
- [x] Manual smoke (10 steps in plan §16)
EOF
)"
```

---

## Self-Review Notes

**Spec coverage:**
- §1.1 deliverables → Tasks 1 (table), 3 (migration), 4 (render), 5/14 (server lifecycle), 6/7 (API), 9/10/11/12 (UI), 13 (cleanup)
- §1.2 non-goals → respected (no multi-process, no shared creds, no cross-server inbound migration, no per-inbound routing custom, no tag rename, no relay chain, no cross-Shepherd)
- §1.3 constraints → enforced (Tasks 5/6 implement restart-on-change, port/tag uniqueness via Task 1's UNIQUE, last-inbound stops service via Task 5)
- §2.1/2.4 → Tasks 1 + 3
- §2.2 → Task 6 (topology endpoint replaced by /inbounds)
- §2.3 → Task 3 (clears plugin_hosts.config)
- §3 render → Task 4
- §4 API → Tasks 6, 7, 14
- §5 UI → Tasks 9, 10, 11, 12, 13, 15
- §6 lifecycle → Tasks 5, 6 (delete validation)
- §7 migrations → Tasks 1, 3 (skip 0004 cleanup; deferred to v0.4.0 release per spec)
- §8 test matrix → distributed across tasks

**Placeholder scan:** No "TBD" / "implement later" / "add appropriate error handling". Every code step shows the complete code.

**Type consistency:**
- Go `Inbound` struct: same field set used in Tasks 2, 3, 4, 5, 6
- Go `InboundView`: defined in Task 2, consumed in Tasks 4 (render), 6 (route response builder)
- Go `InboundPatch`: defined in Task 2, consumed in Task 6 (PATCH handler)
- TS `XrayInbound`: defined in Task 8, consumed in Tasks 9, 10, 11
- TS `CreateXrayInboundBody`, `PatchXrayInboundBody`: defined Task 8, consumed Tasks 10, 11
- Endpoint paths consistent: `/api/admin/plugins/xray/inbounds[/:id]` across all task references
- Tag format `{role}-{8hex}` consistent: defined Task 2 (`GenerateTag`), referenced in §6.3 spec, asserted in Task 6 test

**Known follow-ups (not blocking PR):**
- §6.1 batched inbound creation with single restart — deferred to §10 backlog
- §6.3 tag tombstone table for deleted-tag reuse prevention — deferred; UNIQUE on (server_id, tag) is sufficient until tombstone is needed
- §7.4 dropping `xray_host_topology` table — deferred to v0.4.0's `0004_cleanup.up.sql`
- VMess+WS and Shadowsocks render paths in Task 4 are present but untested; the smoke checklist only exercises vless-reality. Optional follow-up: add render tests for the other two protocols once they have UI exposure.

