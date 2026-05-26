# Subscription Generator Plugin (`subgen`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure-Go Shepherd plugin (`subgen`) that aggregates managed xray + sing-box inbounds into client subscription URLs (Surge + ShadowRocket in v1) with category-based routing emitted as remote `RULE-SET` references.

**Architecture:** A `Base` assembler maps selected inbounds into a target-agnostic `Intermediate{Nodes, Groups, Rules}`; a `Renderer` interface (SurgeRenderer, ShadowRocketRenderer) serializes it. Routing categories resolve to GitHub-hosted `RULE-SET` URLs (blackmatrix7/ios_rule_script) so clients self-subscribe. A public `GET /sub/{token}` endpoint (wired in the core router, the only non-plugin change) serves the rendered config; all admin CRUD lives on the gated plugin mux.

**Tech Stack:** Go 1.22+ (`net/http` ServeMux, `sqlx`, `embed`), React + TanStack Query (admin UI), SQLite/Postgres dual migrations.

**Spec:** `docs/superpowers/specs/2026-05-26-subscription-generator-plugin-design.md`

---

## File Structure

All under `internal/plugins/subgen/` unless noted:

- `subgen.go` — Plugin impl: struct, `New()`, `init()`→`plugins.Register`, `Meta()`, `Migrations()`, `RegisterRoutes()`, `OnEnable` (idempotent built-in template seed), `OnDisable`.
- `migrations.go` + `migrations/{sqlite,postgres}/0001_subgen.up.sql` (+ `.down.sql`).
- `node.go` — `Node` struct + `xrayInboundToNode`, `singboxInboundToNode`.
- `collect.go` — `CollectNodes(ctx, db, []Selection) ([]Node, []string warnings)`.
- `catalog.go` — `UNIFIED_CATEGORIES`, `PREDEFINED_TEMPLATES`, `ResolveRuleLines`.
- `template.go` — `Template` schema, `Validate`, JSON (un)marshal.
- `base.go` — `Intermediate`, `Group`, `Rule`, `Assemble`.
- `render.go` — `Renderer` interface, registry, `Generate` helpers.
- `render_surge.go`, `render_shadowrocket.go`.
- `store.go` — subscription + template CRUD.
- `service.go` — `Service.Generate(ctx, token, target)`.
- `routes.go` — admin CRUD handlers.
- `internal/api/subgen.go` — `SubgenAPI` (public `/sub/{token}` handler), thin wrapper over `subgen.Service`.
- `internal/api/router.go`, `cmd/server/main.go` — wiring (modify).
- `web/src/api/subgen.ts`, `web/src/pages/admin/plugins/subgen/` — frontend.
- `web/src/pages/admin/plugins/PluginRegistry.ts` — register (modify).

---

## Phase 1 — Plugin skeleton, migrations, store

### Task 1: Plugin scaffolding + registration

**Files:**
- Create: `internal/plugins/subgen/subgen.go`, `internal/plugins/subgen/meta.go`
- Modify: `cmd/server/main.go` (blank import, around line 24-28)

- [ ] **Step 1: Create `meta.go`**

```go
package subgen

import "github.com/hg-claw/Shepherd/internal/plugins"

func meta() plugins.Meta {
	return plugins.Meta{
		ID:          "subgen",
		Name:        "Subscriptions",
		Description: "Aggregate managed xray/sing-box inbounds into client subscription URLs (Surge, ShadowRocket) with category routing.",
		Icon:        "rss",
		Category:    "proxy",
		HostAware:   false,
	}
}
```

- [ ] **Step 2: Create `subgen.go` (scaffolding; routes/seed filled in later tasks)**

```go
package subgen

import (
	"context"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type Plugin struct {
	deps plugins.Deps // captured in RegisterRoutes
}

func New() *Plugin { return &Plugin{} }

func init() { plugins.Register(New()) }

func (p *Plugin) Meta() plugins.Meta { return meta() }
func (p *Plugin) Migrations(driver shepdb.Driver) []plugins.Migration {
	return loadMigrations(driver)
}
func (p *Plugin) RegisterRoutes(mux plugins.Mux, deps plugins.Deps) {
	p.deps = deps
	p.registerRoutes(mux) // defined in routes.go (Task 15)
}
func (p *Plugin) OnEnable(ctx context.Context, deps plugins.Deps) error {
	return seedBuiltinTemplates(ctx, deps.DB) // defined in Task 8
}
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error { return nil }
```

- [ ] **Step 3: Add blank import in `cmd/server/main.go`** next to the other plugin imports (after the `xrayplugin "…/xray"` line):

```go
	_ "github.com/hg-claw/Shepherd/internal/plugins/subgen" // registers via init()
```

- [ ] **Step 4: Stub the not-yet-defined symbols so it compiles** — temporarily add to `subgen.go` bottom (REMOVE as later tasks define them; tracked here so the build is green per task):

```go
// temporary stubs — replaced in later tasks
func (p *Plugin) registerRoutes(mux plugins.Mux)                     {}
```

(`loadMigrations` lands in Task 2, `seedBuiltinTemplates` in Task 8 — do Task 2 before building.)

- [ ] **Step 5: Defer build to end of Task 2** (migrations loader needed). Commit after Task 2.

### Task 2: Migrations

**Files:**
- Create: `internal/plugins/subgen/migrations.go`
- Create: `internal/plugins/subgen/migrations/sqlite/0001_subgen.up.sql`, `…/0001_subgen.down.sql`
- Create: `internal/plugins/subgen/migrations/postgres/0001_subgen.up.sql`, `…/0001_subgen.down.sql`

- [ ] **Step 1: `migrations/sqlite/0001_subgen.up.sql`**

```sql
CREATE TABLE subgen_templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  builtin    INTEGER NOT NULL DEFAULT 0,
  rules_json TEXT    NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE subgen_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  token       TEXT    NOT NULL UNIQUE,
  template_id INTEGER NOT NULL REFERENCES subgen_templates(id) ON DELETE RESTRICT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE subgen_subscription_inbounds (
  subscription_id INTEGER NOT NULL REFERENCES subgen_subscriptions(id) ON DELETE CASCADE,
  source          TEXT    NOT NULL,
  inbound_id      INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, source, inbound_id)
);
```

- [ ] **Step 2: `migrations/postgres/0001_subgen.up.sql`** (BIGSERIAL / BOOLEAN / TIMESTAMPTZ)

```sql
CREATE TABLE subgen_templates (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT    NOT NULL,
  builtin    BOOLEAN NOT NULL DEFAULT false,
  rules_json TEXT    NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subgen_subscriptions (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT    NOT NULL,
  token       TEXT    NOT NULL UNIQUE,
  template_id BIGINT  NOT NULL REFERENCES subgen_templates(id) ON DELETE RESTRICT,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subgen_subscription_inbounds (
  subscription_id BIGINT NOT NULL REFERENCES subgen_subscriptions(id) ON DELETE CASCADE,
  source          TEXT   NOT NULL,
  inbound_id      BIGINT NOT NULL,
  PRIMARY KEY (subscription_id, source, inbound_id)
);
```

- [ ] **Step 3: Both `0001_subgen.down.sql`** (sqlite + postgres, identical body)

```sql
DROP TABLE IF EXISTS subgen_subscription_inbounds;
DROP TABLE IF EXISTS subgen_subscriptions;
DROP TABLE IF EXISTS subgen_templates;
```

- [ ] **Step 4: `migrations.go`** (copy the cloudflare loader pattern)

```go
package subgen

import (
	"embed"
	"fmt"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

//go:embed migrations/sqlite/*.sql migrations/postgres/*.sql
var migFS embed.FS

func loadMigrations(driver shepdb.Driver) []plugins.Migration {
	names := []string{"0001_subgen.up.sql"}
	subdir := "sqlite"
	if driver == shepdb.DriverPostgres {
		subdir = "postgres"
	}
	out := make([]plugins.Migration, 0, len(names))
	for _, n := range names {
		path := "migrations/" + subdir + "/" + n
		b, err := migFS.ReadFile(path)
		if err != nil {
			panic(fmt.Sprintf("subgen: missing migration %s: %v", path, err))
		}
		out = append(out, plugins.Migration{Name: n[:len(n)-len(".up.sql")], SQL: string(b)})
	}
	return out
}
```

- [ ] **Step 5: temporarily stub `seedBuiltinTemplates`** in `subgen.go` (replaced in Task 8):

```go
func seedBuiltinTemplates(_ context.Context, _ *sqlx.DB) error { return nil }
```
(add `"github.com/jmoiron/sqlx"` import.)

- [ ] **Step 6: Build**

Run: `cd /Users/hg/project/Shepherd && go build ./...`
Expected: success.

- [ ] **Step 7: Commit**

```bash
git add internal/plugins/subgen cmd/server/main.go
git commit -m "feat(subgen): plugin scaffolding + migrations"
```

### Task 3: Subscription + template store

**Files:**
- Create: `internal/plugins/subgen/store.go`, `internal/plugins/subgen/store_test.go`

- [ ] **Step 1: Write `store_test.go`** (use the same in-memory-sqlite + RunPluginMigrations pattern other plugin tests use)

```go
package subgen

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "s.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	if err := plugins.RunPluginMigrations(context.Background(), d, "subgen", loadMigrations(shepdb.DriverSQLite)); err != nil {
		t.Fatal(err)
	}
	return &Store{DB: d, Now: time.Now}
}

func TestStore_TemplateAndSubscriptionCRUD(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	tid, err := s.CreateTemplate(ctx, "t1", false, `{"final":"PROXY"}`)
	if err != nil {
		t.Fatal(err)
	}
	sub, err := s.CreateSubscription(ctx, "sub1", tid)
	if err != nil {
		t.Fatal(err)
	}
	if sub.Token == "" {
		t.Fatal("token not generated")
	}
	if err := s.SetInbounds(ctx, sub.ID, []Selection{{Source: "xray", InboundID: 5}}); err != nil {
		t.Fatal(err)
	}
	got, err := s.SubscriptionByToken(ctx, sub.Token)
	if err != nil || got.ID != sub.ID {
		t.Fatalf("lookup by token: %v got=%+v", err, got)
	}
	sels, _ := s.InboundsFor(ctx, sub.ID)
	if len(sels) != 1 || sels[0].Source != "xray" || sels[0].InboundID != 5 {
		t.Fatalf("inbounds = %+v", sels)
	}
}

func TestStore_RotateTokenChangesToken(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	tid, _ := s.CreateTemplate(ctx, "t", false, `{}`)
	sub, _ := s.CreateSubscription(ctx, "s", tid)
	old := sub.Token
	if err := s.RotateToken(ctx, sub.ID); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Subscription(ctx, sub.ID)
	if got.Token == old || got.Token == "" {
		t.Fatalf("token not rotated: %q -> %q", old, got.Token)
	}
}
```

- [ ] **Step 2: Run — fails (no Store)**

Run: `go test ./internal/plugins/subgen/ -run Store`
Expected: build failure (`undefined: Store`).

- [ ] **Step 3: Implement `store.go`**

```go
package subgen

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"github.com/jmoiron/sqlx"
)

type Store struct {
	DB  *sqlx.DB
	Now func() time.Time
}

type Template struct {
	ID        int64     `db:"id"`
	Name      string    `db:"name"`
	Builtin   bool      `db:"builtin"`
	RulesJSON string    `db:"rules_json"`
	CreatedAt time.Time `db:"created_at"`
	UpdatedAt time.Time `db:"updated_at"`
}

type Subscription struct {
	ID         int64     `db:"id"`
	Name       string    `db:"name"`
	Token      string    `db:"token"`
	TemplateID int64     `db:"template_id"`
	Enabled    bool      `db:"enabled"`
	CreatedAt  time.Time `db:"created_at"`
	UpdatedAt  time.Time `db:"updated_at"`
}

type Selection struct {
	Source    string `db:"source" json:"source"` // "xray" | "singbox"
	InboundID int64  `db:"inbound_id" json:"inbound_id"`
}

func newToken() string {
	b := make([]byte, 18)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *Store) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Store) CreateTemplate(ctx context.Context, name string, builtin bool, rulesJSON string) (int64, error) {
	now := s.now()
	var id int64
	err := s.DB.QueryRowxContext(ctx,
		`INSERT INTO subgen_templates(name, builtin, rules_json, created_at, updated_at)
		 VALUES ($1,$2,$3,$4,$4) RETURNING id`, name, builtin, rulesJSON, now).Scan(&id)
	return id, err
}

func (s *Store) UpdateTemplate(ctx context.Context, id int64, name, rulesJSON string) error {
	_, err := s.DB.ExecContext(ctx,
		`UPDATE subgen_templates SET name=$1, rules_json=$2, updated_at=$3 WHERE id=$4 AND builtin=false`,
		name, rulesJSON, s.now(), id)
	return err
}

func (s *Store) DeleteTemplate(ctx context.Context, id int64) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM subgen_templates WHERE id=$1 AND builtin=false`, id)
	return err
}

func (s *Store) ListTemplates(ctx context.Context) ([]Template, error) {
	var out []Template
	err := s.DB.SelectContext(ctx, &out, `SELECT * FROM subgen_templates ORDER BY builtin DESC, id`)
	return out, err
}

func (s *Store) Template(ctx context.Context, id int64) (Template, error) {
	var t Template
	err := s.DB.GetContext(ctx, &t, `SELECT * FROM subgen_templates WHERE id=$1`, id)
	return t, err
}

func (s *Store) TemplateByName(ctx context.Context, name string) (Template, error) {
	var t Template
	err := s.DB.GetContext(ctx, &t, `SELECT * FROM subgen_templates WHERE name=$1 AND builtin=true`, name)
	return t, err
}

func (s *Store) CreateSubscription(ctx context.Context, name string, templateID int64) (Subscription, error) {
	now := s.now()
	tok := newToken()
	var id int64
	err := s.DB.QueryRowxContext(ctx,
		`INSERT INTO subgen_subscriptions(name, token, template_id, enabled, created_at, updated_at)
		 VALUES ($1,$2,$3,true,$4,$4) RETURNING id`, name, tok, templateID, now).Scan(&id)
	if err != nil {
		return Subscription{}, err
	}
	return s.Subscription(ctx, id)
}

func (s *Store) UpdateSubscription(ctx context.Context, id int64, name string, templateID int64, enabled bool) error {
	_, err := s.DB.ExecContext(ctx,
		`UPDATE subgen_subscriptions SET name=$1, template_id=$2, enabled=$3, updated_at=$4 WHERE id=$5`,
		name, templateID, enabled, s.now(), id)
	return err
}

func (s *Store) DeleteSubscription(ctx context.Context, id int64) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM subgen_subscriptions WHERE id=$1`, id)
	return err
}

func (s *Store) RotateToken(ctx context.Context, id int64) error {
	_, err := s.DB.ExecContext(ctx,
		`UPDATE subgen_subscriptions SET token=$1, updated_at=$2 WHERE id=$3`, newToken(), s.now(), id)
	return err
}

func (s *Store) ListSubscriptions(ctx context.Context) ([]Subscription, error) {
	var out []Subscription
	err := s.DB.SelectContext(ctx, &out, `SELECT * FROM subgen_subscriptions ORDER BY id`)
	return out, err
}

func (s *Store) Subscription(ctx context.Context, id int64) (Subscription, error) {
	var sub Subscription
	err := s.DB.GetContext(ctx, &sub, `SELECT * FROM subgen_subscriptions WHERE id=$1`, id)
	return sub, err
}

func (s *Store) SubscriptionByToken(ctx context.Context, token string) (Subscription, error) {
	var sub Subscription
	err := s.DB.GetContext(ctx, &sub, `SELECT * FROM subgen_subscriptions WHERE token=$1`, token)
	return sub, err
}

func (s *Store) SetInbounds(ctx context.Context, subID int64, sels []Selection) error {
	tx, err := s.DB.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM subgen_subscription_inbounds WHERE subscription_id=$1`, subID); err != nil {
		return err
	}
	for _, sel := range sels {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO subgen_subscription_inbounds(subscription_id, source, inbound_id) VALUES ($1,$2,$3)`,
			subID, sel.Source, sel.InboundID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) InboundsFor(ctx context.Context, subID int64) ([]Selection, error) {
	var out []Selection
	err := s.DB.SelectContext(ctx, &out,
		`SELECT source, inbound_id FROM subgen_subscription_inbounds WHERE subscription_id=$1 ORDER BY source, inbound_id`, subID)
	return out, err
}
```

- [ ] **Step 4: Run — passes**

Run: `go test ./internal/plugins/subgen/ -run Store -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/subgen/store.go internal/plugins/subgen/store_test.go
git commit -m "feat(subgen): subscription + template store"
```

---

## Phase 2 — Node model + mappers

### Task 4: Node model + xray mapper

**Files:**
- Create: `internal/plugins/subgen/node.go`, `internal/plugins/subgen/node_test.go`

- [ ] **Step 1: Write `node_test.go` (xray cases)**

```go
package subgen

import "testing"

func TestXrayInboundToNode_Reality(t *testing.T) {
	n := xrayInboundToNode(xrayLite{
		Tag: "r1", Port: 443, Protocol: "vless-reality",
		UUID: "uuid-1", SNI: "www.example.com", PublicKey: "PBK", ShortID: "aa",
	}, serverLite{Name: "tokyo", Host: "1.2.3.4", Country: "JP"})
	if n.Protocol != "vless" || n.Server != "1.2.3.4" || n.Port != 443 {
		t.Fatalf("bad node: %+v", n)
	}
	if n.RealityPublicKey != "PBK" || n.RealityShortID != "aa" || n.SNI != "www.example.com" {
		t.Fatalf("reality fields lost: %+v", n)
	}
	if n.Country != "JP" || n.Name == "" {
		t.Fatalf("name/country: %+v", n)
	}
}

func TestXrayInboundToNode_Shadowsocks(t *testing.T) {
	n := xrayInboundToNode(xrayLite{
		Tag: "s1", Port: 8388, Protocol: "shadowsocks",
		SSMethod: "aes-256-gcm", SSPassword: "pw",
	}, serverLite{Name: "sg", Host: "5.6.7.8", Country: "SG"})
	if n.Protocol != "shadowsocks" || n.SSMethod != "aes-256-gcm" || n.Password != "pw" {
		t.Fatalf("ss fields: %+v", n)
	}
}
```

- [ ] **Step 2: Run — fails** (`undefined: xrayInboundToNode`).

Run: `go test ./internal/plugins/subgen/ -run XrayInbound`

- [ ] **Step 3: Implement `node.go`**

`xrayLite`/`singboxLite`/`serverLite` are narrow input structs so mappers are pure + unit-testable without importing the xray/singbox packages (avoids an import cycle — `collect.go` adapts the real store rows into these). The `Protocol` on `Node` is the base scheme (`vless`/`vmess`/`trojan`/`shadowsocks`/`hysteria2`/`tuic`/`anytls`); transport/tls live in dedicated fields.

```go
package subgen

import "strings"

type Node struct {
	Name     string
	Protocol string // vless|vmess|trojan|shadowsocks|hysteria2|tuic|anytls
	Server   string
	Port     int
	Country  string

	UUID     string
	Password string
	SNI      string
	Flow     string

	RealityPublicKey string
	RealityShortID   string

	Transport string // ""|ws|grpc|h2|httpupgrade
	Path      string
	Host      string

	SSMethod string
	Insecure bool
	ALPN     []string

	Extra map[string]any // hysteria2/tuic knobs
}

type serverLite struct {
	Name    string
	Host    string
	Country string
}

type xrayLite struct {
	Tag        string
	Port       int
	Protocol   string
	UUID       string
	SNI        string
	PublicKey  string
	ShortID    string
	WSPath     string
	SSMethod   string
	SSPassword string
}

// baseScheme strips the transport/tls suffix from a singbox protocol token
// ("vless-ws-tls" -> "vless", "vmess-h2-tls" -> "vmess", "tuic-v5" -> "tuic").
func baseScheme(proto string) string {
	switch {
	case strings.HasPrefix(proto, "vless"):
		return "vless"
	case strings.HasPrefix(proto, "vmess"):
		return "vmess"
	case strings.HasPrefix(proto, "trojan"):
		return "trojan"
	case proto == "hysteria2":
		return "hysteria2"
	case proto == "tuic-v5":
		return "tuic"
	case proto == "anytls":
		return "anytls"
	case proto == "shadowsocks" || proto == "shadowsocks-2022":
		return "shadowsocks"
	default:
		return proto
	}
}

func nodeName(country, server, proto string) string {
	flag := countryFlag(country)
	if flag != "" {
		return flag + " " + server + " " + proto
	}
	return server + " " + proto
}

func xrayInboundToNode(in xrayLite, srv serverLite) Node {
	n := Node{
		Protocol: baseScheme(in.Protocol),
		Server:   srv.Host,
		Port:     in.Port,
		Country:  srv.Country,
		UUID:     in.UUID,
		SNI:      in.SNI,
	}
	switch in.Protocol {
	case "vless-reality":
		n.RealityPublicKey = in.PublicKey
		n.RealityShortID = in.ShortID
	case "vmess-ws":
		n.Transport = "ws"
		n.Path = in.WSPath
	case "shadowsocks":
		n.SSMethod = in.SSMethod
		n.Password = in.SSPassword
	}
	n.Name = nodeName(srv.Country, srv.Name, n.Protocol)
	return n
}
```

- [ ] **Step 4: Add `countryFlag` to `node.go`** (regional-indicator from ISO-3166 alpha-2; empty for unknown)

```go
func countryFlag(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	if len(code) != 2 {
		return ""
	}
	r := []rune{}
	for _, c := range code {
		if c < 'A' || c > 'Z' {
			return ""
		}
		r = append(r, 0x1F1E6+(c-'A'))
	}
	return string(r)
}
```

- [ ] **Step 5: Run — passes**

Run: `go test ./internal/plugins/subgen/ -run XrayInbound -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/subgen/node.go internal/plugins/subgen/node_test.go
git commit -m "feat(subgen): Node model + xray mapper"
```

### Task 5: sing-box mapper

**Files:**
- Modify: `internal/plugins/subgen/node.go`, `internal/plugins/subgen/node_test.go`

- [ ] **Step 1: Add sing-box tests to `node_test.go`**

```go
func TestSingboxInboundToNode_Hysteria2(t *testing.T) {
	pw := "hpw"
	n := singboxInboundToNode(singboxLite{
		Port: 443, Protocol: "hysteria2", Password: &pw,
		SNI: strp("h.example.com"), ExtraJSON: strp(`{"up_mbps":100,"down_mbps":500}`),
	}, serverLite{Name: "hk", Host: "9.9.9.9", Country: "HK"})
	if n.Protocol != "hysteria2" || n.Password != "hpw" || n.SNI != "h.example.com" {
		t.Fatalf("hy2 fields: %+v", n)
	}
	if n.Extra["up_mbps"] == nil || n.Extra["down_mbps"] == nil {
		t.Fatalf("extra knobs lost: %+v", n.Extra)
	}
}

func TestSingboxInboundToNode_VlessWsTls(t *testing.T) {
	uuid := "u"
	n := singboxInboundToNode(singboxLite{
		Port: 443, Protocol: "vless-ws-tls", UUID: &uuid,
		SNI: strp("w.example.com"), TransportPath: strp("/ws"), TransportHost: strp("w.example.com"),
	}, serverLite{Name: "us", Host: "2.2.2.2", Country: "US"})
	if n.Protocol != "vless" || n.Transport != "ws" || n.Path != "/ws" || n.Host != "w.example.com" {
		t.Fatalf("vless-ws fields: %+v", n)
	}
}

func strp(s string) *string { return &s }
```

- [ ] **Step 2: Run — fails** (`undefined: singboxInboundToNode`).

- [ ] **Step 3: Implement `singboxInboundToNode` + `singboxLite` in `node.go`**

```go
import "encoding/json" // add to node.go imports

type singboxLite struct {
	Tag               string
	Port              int
	Protocol          string
	Role              string
	RelayMode         string
	UUID              *string
	Flow              *string
	Password          *string
	SNI               *string
	RealityPublicKey  *string
	RealityShortID    *string
	TransportPath     *string
	TransportHost     *string
	SSMethod          *string
	ExtraJSON         *string
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func transportOf(proto string) string {
	switch {
	case strings.Contains(proto, "-ws-"), strings.HasSuffix(proto, "-ws"):
		return "ws"
	case strings.Contains(proto, "-h2-"), strings.HasSuffix(proto, "-h2"):
		return "h2"
	case strings.Contains(proto, "-httpupgrade-"), strings.HasSuffix(proto, "-httpupgrade"):
		return "httpupgrade"
	default:
		return ""
	}
}

func singboxInboundToNode(in singboxLite, srv serverLite) Node {
	n := Node{
		Protocol:  baseScheme(in.Protocol),
		Server:    srv.Host,
		Port:      in.Port,
		Country:   srv.Country,
		UUID:      deref(in.UUID),
		Password:  deref(in.Password),
		SNI:       deref(in.SNI),
		Flow:      deref(in.Flow),
		SSMethod:  deref(in.SSMethod),
		Transport: transportOf(in.Protocol),
		Path:      deref(in.TransportPath),
		Host:      deref(in.TransportHost),
	}
	if in.Protocol == "vless-reality" {
		n.RealityPublicKey = deref(in.RealityPublicKey)
		n.RealityShortID = deref(in.RealityShortID)
	}
	if e := deref(in.ExtraJSON); e != "" {
		var m map[string]any
		if json.Unmarshal([]byte(e), &m) == nil {
			n.Extra = m
		}
	}
	n.Name = nodeName(srv.Country, srv.Name, n.Protocol)
	return n
}
```

- [ ] **Step 4: Run — passes**

Run: `go test ./internal/plugins/subgen/ -run SingboxInbound -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/subgen/node.go internal/plugins/subgen/node_test.go
git commit -m "feat(subgen): sing-box mapper"
```

### Task 6: Node collection (resolve selections → []Node)

**Files:**
- Create: `internal/plugins/subgen/collect.go`, `internal/plugins/subgen/collect_test.go`

`collect.go` queries the xray/singbox inbound tables + servers directly via `*sqlx.DB` (no import of the plugin packages — avoids cycles, and the columns are stable). Returns warnings for skipped nodes (missing ssh_host).

- [ ] **Step 1: Write `collect_test.go`** — seeds servers + xray_inbounds + singbox_inbounds, then asserts CollectNodes maps + skips a host with NULL ssh_host.

```go
package subgen

import (
	"context"
	"testing"
)

func TestCollectNodes_MapsAndSkipsMissingHost(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	d := s.DB
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,country_code) VALUES (1,'tokyo','1.2.3.4','JP')`)
	d.MustExec(`INSERT INTO servers(id,name,country_code) VALUES (2,'nohost','US')`) // ssh_host NULL
	d.MustExec(`INSERT INTO xray_inbounds(id,server_id,tag,port,role,protocol,uuid,sni,public_key,short_id)
	            VALUES (10,1,'r',443,'landing','vless-reality','u','sni','PBK','aa')`)
	d.MustExec(`INSERT INTO xray_inbounds(id,server_id,tag,port,role,protocol,uuid)
	            VALUES (11,2,'r',443,'landing','vless-reality','u')`)

	nodes, warns := CollectNodes(ctx, d, []Selection{
		{Source: "xray", InboundID: 10},
		{Source: "xray", InboundID: 11},
	})
	if len(nodes) != 1 || nodes[0].Server != "1.2.3.4" {
		t.Fatalf("nodes = %+v", nodes)
	}
	if len(warns) != 1 {
		t.Fatalf("expected 1 skip warning, got %v", warns)
	}
}
```

(The `xray_inbounds` / `singbox_inbounds` / `servers` tables exist because `newStore` runs the core migrations + the xray/singbox plugin migrations are part of core `shepdb.Migrate`? They are plugin migrations — add `RunPluginMigrations` for xray & singbox in `newStore`'s test helper, or create the minimal tables in the test. Implementer: extend `newStore` to also run `xray.loadMigrations`/`singbox.loadMigrations` via their exported migration funcs if available; otherwise `CREATE TABLE` the two inbound tables inline in this test.)

- [ ] **Step 2: Run — fails** (`undefined: CollectNodes`).

- [ ] **Step 3: Implement `collect.go`**

```go
package subgen

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jmoiron/sqlx"
)

func CollectNodes(ctx context.Context, db *sqlx.DB, sels []Selection) ([]Node, []string) {
	var nodes []Node
	var warns []string
	for _, sel := range sels {
		switch sel.Source {
		case "xray":
			n, ok, w := collectXray(ctx, db, sel.InboundID)
			if w != "" {
				warns = append(warns, w)
			}
			if ok {
				nodes = append(nodes, n)
			}
		case "singbox":
			n, ok, w := collectSingbox(ctx, db, sel.InboundID)
			if w != "" {
				warns = append(warns, w)
			}
			if ok {
				nodes = append(nodes, n)
			}
		}
	}
	return nodes, warns
}

type xrayRow struct {
	Tag        string         `db:"tag"`
	Port       int            `db:"port"`
	Protocol   string         `db:"protocol"`
	UUID       sql.NullString `db:"uuid"`
	SNI        sql.NullString `db:"sni"`
	PublicKey  sql.NullString `db:"public_key"`
	ShortID    sql.NullString `db:"short_id"`
	WSPath     sql.NullString `db:"ws_path"`
	SSMethod   sql.NullString `db:"ss_method"`
	SSPassword sql.NullString `db:"ss_password"`
	SrvName    string         `db:"srv_name"`
	SrvHost    sql.NullString `db:"srv_host"`
	SrvCountry sql.NullString `db:"srv_country"`
}

func collectXray(ctx context.Context, db *sqlx.DB, id int64) (Node, bool, string) {
	var r xrayRow
	err := db.GetContext(ctx, &r, `
		SELECT i.tag, i.port, i.protocol, i.uuid, i.sni, i.public_key, i.short_id,
		       i.ws_path, i.ss_method, i.ss_password,
		       s.name AS srv_name, s.ssh_host AS srv_host, s.country_code AS srv_country
		  FROM xray_inbounds i JOIN servers s ON s.id=i.server_id WHERE i.id=$1`, id)
	if err != nil {
		return Node{}, false, fmt.Sprintf("xray inbound %d not found", id)
	}
	if !r.SrvHost.Valid || r.SrvHost.String == "" {
		return Node{}, false, fmt.Sprintf("xray %s on %s: no ssh_host, skipped", r.Tag, r.SrvName)
	}
	n := xrayInboundToNode(xrayLite{
		Tag: r.Tag, Port: r.Port, Protocol: r.Protocol,
		UUID: r.UUID.String, SNI: r.SNI.String, PublicKey: r.PublicKey.String,
		ShortID: r.ShortID.String, WSPath: r.WSPath.String,
		SSMethod: r.SSMethod.String, SSPassword: r.SSPassword.String,
	}, serverLite{Name: r.SrvName, Host: r.SrvHost.String, Country: r.SrvCountry.String})
	return n, true, ""
}

type singboxRow struct {
	Tag           string         `db:"tag"`
	Port          int            `db:"port"`
	Protocol      string         `db:"protocol"`
	Role          string         `db:"role"`
	RelayMode     string         `db:"relay_mode"`
	UUID          sql.NullString `db:"uuid"`
	Flow          sql.NullString `db:"flow"`
	Password      sql.NullString `db:"password"`
	SNI           sql.NullString `db:"sni"`
	RealityPub    sql.NullString `db:"reality_public_key"`
	RealitySID    sql.NullString `db:"reality_short_id"`
	TransportPath sql.NullString `db:"transport_path"`
	TransportHost sql.NullString `db:"transport_host"`
	SSMethod      sql.NullString `db:"ss_method"`
	ExtraJSON     sql.NullString `db:"extra_json"`
	SrvName       string         `db:"srv_name"`
	SrvHost       sql.NullString `db:"srv_host"`
	SrvCountry    sql.NullString `db:"srv_country"`
}

func ns(v sql.NullString) *string {
	if v.Valid {
		s := v.String
		return &s
	}
	return nil
}

func collectSingbox(ctx context.Context, db *sqlx.DB, id int64) (Node, bool, string) {
	var r singboxRow
	err := db.GetContext(ctx, &r, `
		SELECT i.tag, i.port, i.protocol, i.role, i.relay_mode, i.uuid, i.flow, i.password, i.sni,
		       i.reality_public_key, i.reality_short_id, i.transport_path, i.transport_host,
		       i.ss_method, i.extra_json,
		       s.name AS srv_name, s.ssh_host AS srv_host, s.country_code AS srv_country
		  FROM singbox_inbounds i JOIN servers s ON s.id=i.server_id WHERE i.id=$1`, id)
	if err != nil {
		return Node{}, false, fmt.Sprintf("singbox inbound %d not found", id)
	}
	if !r.SrvHost.Valid || r.SrvHost.String == "" {
		return Node{}, false, fmt.Sprintf("singbox %s on %s: no ssh_host, skipped", r.Tag, r.SrvName)
	}
	n := singboxInboundToNode(singboxLite{
		Tag: r.Tag, Port: r.Port, Protocol: r.Protocol, Role: r.Role, RelayMode: r.RelayMode,
		UUID: ns(r.UUID), Flow: ns(r.Flow), Password: ns(r.Password), SNI: ns(r.SNI),
		RealityPublicKey: ns(r.RealityPub), RealityShortID: ns(r.RealitySID),
		TransportPath: ns(r.TransportPath), TransportHost: ns(r.TransportHost),
		SSMethod: ns(r.SSMethod), ExtraJSON: ns(r.ExtraJSON),
	}, serverLite{Name: r.SrvName, Host: r.SrvHost.String, Country: r.SrvCountry.String})
	return n, true, ""
}
```

- [ ] **Step 4: Run — passes** (extend `newStore`/test to create the two inbound tables as noted in Step 1).

Run: `go test ./internal/plugins/subgen/ -run CollectNodes -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/subgen/collect.go internal/plugins/subgen/collect_test.go internal/plugins/subgen/store_test.go
git commit -m "feat(subgen): collect selected inbounds into nodes"
```

---

## Phase 3 — Catalog, template schema, base assembler

### Task 7: Category catalog + rule-line resolution

**Files:**
- Create: `internal/plugins/subgen/catalog.go`, `internal/plugins/subgen/catalog_test.go`

- [ ] **Step 1: Write `catalog_test.go`**

```go
package subgen

import (
	"strings"
	"testing"
)

func TestResolveRuleLines_RemoteAndNative(t *testing.T) {
	base := "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master"
	// Telegram → remote RULE-SET for the surge target.
	lines := ResolveRuleLines("Telegram", "PROXY", "surge", base)
	if len(lines) != 1 || !strings.HasPrefix(lines[0], "RULE-SET,") ||
		!strings.Contains(lines[0], "/rule/Surge/Telegram/Telegram.list,") ||
		!strings.HasSuffix(lines[0], ",PROXY") {
		t.Fatalf("telegram line = %v", lines)
	}
	// Location:CN → native GEOIP directive, no URL.
	cn := ResolveRuleLines("Location:CN", "DIRECT", "surge", base)
	if len(cn) != 1 || cn[0] != "GEOIP,CN,DIRECT" {
		t.Fatalf("cn line = %v", cn)
	}
}

func TestPredefinedTemplatesReferenceKnownCategories(t *testing.T) {
	known := map[string]bool{}
	for _, c := range UnifiedCategories {
		known[c.Name] = true
	}
	for set, names := range PredefinedTemplates {
		for _, n := range names {
			if !known[n] {
				t.Errorf("predefined %q references unknown category %q", set, n)
			}
		}
	}
}
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement `catalog.go`**

`Rulesets` are blackmatrix7 folder names; `Native` is a directive prefix where the client resolves natively (no remote fetch). A category sets exactly one of the two.

```go
package subgen

import "strings"

type Category struct {
	Name          string
	Rulesets      []string // blackmatrix7 folder names (remote RULE-SET)
	Native        string   // e.g. "GEOIP,CN" — client resolves natively
	DefaultPolicy string   // PROXY | DIRECT | REJECT
}

var UnifiedCategories = []Category{
	{Name: "Ad Block", Rulesets: []string{"AdvertisingLite"}, DefaultPolicy: "REJECT"},
	{Name: "AI Services", Rulesets: []string{"OpenAI"}, DefaultPolicy: "PROXY"},
	{Name: "Telegram", Rulesets: []string{"Telegram"}, DefaultPolicy: "PROXY"},
	{Name: "Google", Rulesets: []string{"Google"}, DefaultPolicy: "PROXY"},
	{Name: "Youtube", Rulesets: []string{"YouTube"}, DefaultPolicy: "PROXY"},
	{Name: "Github", Rulesets: []string{"GitHub"}, DefaultPolicy: "PROXY"},
	{Name: "Microsoft", Rulesets: []string{"Microsoft"}, DefaultPolicy: "PROXY"},
	{Name: "Apple", Rulesets: []string{"Apple"}, DefaultPolicy: "PROXY"},
	{Name: "Streaming", Rulesets: []string{"Netflix", "Disney", "HBO", "YouTube"}, DefaultPolicy: "PROXY"},
	{Name: "Social Media", Rulesets: []string{"Facebook", "Twitter", "TikTok", "Instagram"}, DefaultPolicy: "PROXY"},
	{Name: "Location:CN", Native: "GEOIP,CN", DefaultPolicy: "DIRECT"},
	{Name: "Private", Native: "RULE-SET,SYSTEM", DefaultPolicy: "DIRECT"},
}

var PredefinedTemplates = map[string][]string{
	"minimal":       {"Location:CN", "Private", "Ad Block"},
	"balanced":      {"Location:CN", "Private", "Ad Block", "Github", "Google", "Youtube", "AI Services", "Telegram"},
	"comprehensive": categoryNames(),
}

func categoryNames() []string {
	out := make([]string, 0, len(UnifiedCategories))
	for _, c := range UnifiedCategories {
		out = append(out, c.Name)
	}
	return out
}

func categoryByName(name string) (Category, bool) {
	for _, c := range UnifiedCategories {
		if c.Name == name {
			return c, true
		}
	}
	return Category{}, false
}

// surgeDir maps a target to the blackmatrix7 rule directory + file ext.
func rulesetDir(target string) (dir, ext string) {
	// Surge and ShadowRocket both consume Surge-format .list files.
	return "Surge", "list"
}

// ResolveRuleLines turns one category + policy into the rule line(s) for a
// target. Remote rulesets become RULE-SET URLs; native categories emit
// their directive verbatim with the policy appended.
func ResolveRuleLines(category, policy, target, base string) []string {
	c, ok := categoryByName(category)
	if !ok {
		return nil
	}
	if c.Native != "" {
		return []string{c.Native + "," + policy}
	}
	dir, ext := rulesetDir(target)
	base = strings.TrimRight(base, "/")
	var out []string
	for _, rs := range c.Rulesets {
		url := base + "/rule/" + dir + "/" + rs + "/" + rs + "." + ext
		out = append(out, "RULE-SET,"+url+","+policy)
	}
	return out
}

const DefaultRulesetBase = "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master"
```

- [ ] **Step 4: Run — passes.** Commit.

```bash
git add internal/plugins/subgen/catalog.go internal/plugins/subgen/catalog_test.go
git commit -m "feat(subgen): category catalog + RULE-SET resolution"
```

### Task 8: Template schema + validation + built-in seeding

**Files:**
- Create: `internal/plugins/subgen/template.go`, `internal/plugins/subgen/template_test.go`
- Modify: `internal/plugins/subgen/subgen.go` (replace the `seedBuiltinTemplates` stub)

- [ ] **Step 1: Write `template_test.go`**

```go
package subgen

import (
	"context"
	"testing"
)

func TestTemplateValidate(t *testing.T) {
	good := `{"categories":[{"name":"Telegram","policy":"PROXY"}],"final":"PROXY"}`
	if _, err := ParseTemplate(good); err != nil {
		t.Fatalf("good template rejected: %v", err)
	}
	badCat := `{"categories":[{"name":"Nope","policy":"PROXY"}],"final":"PROXY"}`
	if _, err := ParseTemplate(badCat); err == nil {
		t.Fatal("unknown category accepted")
	}
	badPolicy := `{"categories":[{"name":"Telegram","policy":"WAT"}],"final":"PROXY"}`
	if _, err := ParseTemplate(badPolicy); err == nil {
		t.Fatal("bad policy accepted")
	}
}

func TestSeedBuiltinTemplatesIdempotent(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	if err := seedBuiltinTemplates(ctx, s.DB); err != nil {
		t.Fatal(err)
	}
	if err := seedBuiltinTemplates(ctx, s.DB); err != nil { // second call must not duplicate
		t.Fatal(err)
	}
	ts, _ := s.ListTemplates(ctx)
	builtins := 0
	for _, tpl := range ts {
		if tpl.Builtin {
			builtins++
		}
	}
	if builtins != len(PredefinedTemplates) {
		t.Fatalf("builtins=%d want %d", builtins, len(PredefinedTemplates))
	}
}
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement `template.go`**

```go
package subgen

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
)

type CategorySel struct {
	Name   string `json:"name"`
	Policy string `json:"policy"`
}

type CustomRule struct {
	Match  string `json:"match"`  // e.g. "IP-CIDR,10.0.0.0/24"
	Policy string `json:"policy"`
}

type TemplateSpec struct {
	Categories        []CategorySel `json:"categories"`
	CustomRules       []CustomRule  `json:"custom_rules"`
	Final             string        `json:"final"`
	GroupByCountry    bool          `json:"group_by_country"`
	IncludeAutoSelect bool          `json:"include_auto_select"`
}

func validPolicy(p string) bool {
	switch p {
	case "PROXY", "DIRECT", "REJECT":
		return true
	default:
		return p != "" // named group allowed
	}
}

func ParseTemplate(rulesJSON string) (TemplateSpec, error) {
	var t TemplateSpec
	if err := json.Unmarshal([]byte(rulesJSON), &t); err != nil {
		return t, fmt.Errorf("bad rules_json: %w", err)
	}
	if t.Final == "" {
		t.Final = "PROXY"
	}
	for _, c := range t.Categories {
		if _, ok := categoryByName(c.Name); !ok {
			return t, fmt.Errorf("unknown category %q", c.Name)
		}
		if !validPolicy(c.Policy) {
			return t, fmt.Errorf("bad policy %q for %q", c.Policy, c.Name)
		}
	}
	for _, r := range t.CustomRules {
		if r.Match == "" || !validPolicy(r.Policy) {
			return t, fmt.Errorf("bad custom rule %+v", r)
		}
	}
	return t, nil
}

func builtinSpec(setName string) TemplateSpec {
	t := TemplateSpec{Final: "PROXY", GroupByCountry: true, IncludeAutoSelect: true}
	for _, name := range PredefinedTemplates[setName] {
		c, _ := categoryByName(name)
		t.Categories = append(t.Categories, CategorySel{Name: name, Policy: c.DefaultPolicy})
	}
	return t
}

func seedBuiltinTemplates(ctx context.Context, db *sqlx.DB) error {
	now := time.Now().UTC()
	for setName := range PredefinedTemplates {
		spec := builtinSpec(setName)
		raw, _ := json.Marshal(spec)
		// insert-if-absent by (name, builtin=1); never overwrite.
		var n int
		if err := db.GetContext(ctx, &n,
			`SELECT COUNT(*) FROM subgen_templates WHERE name=$1 AND builtin=true`, setName); err != nil {
			return err
		}
		if n > 0 {
			continue
		}
		if _, err := db.ExecContext(ctx,
			`INSERT INTO subgen_templates(name, builtin, rules_json, created_at, updated_at)
			 VALUES ($1,true,$2,$3,$3)`, setName, string(raw), now); err != nil {
			return err
		}
	}
	return nil
}
```

- [ ] **Step 4: Remove the `seedBuiltinTemplates` stub from `subgen.go`** (now defined in template.go). Keep the `sqlx` import only if still used elsewhere in subgen.go; otherwise drop it.

- [ ] **Step 5: Run — passes.** Commit.

```bash
git add internal/plugins/subgen/template.go internal/plugins/subgen/template_test.go internal/plugins/subgen/subgen.go
git commit -m "feat(subgen): template schema, validation, builtin seeding"
```

### Task 9: Base assembler → Intermediate

**Files:**
- Create: `internal/plugins/subgen/base.go`, `internal/plugins/subgen/base_test.go`

- [ ] **Step 1: Write `base_test.go`**

```go
package subgen

import "testing"

func TestAssemble_GroupsAndRules(t *testing.T) {
	nodes := []Node{
		{Name: "🇯🇵 tokyo vless", Protocol: "vless", Server: "1.1.1.1", Port: 443, Country: "JP"},
		{Name: "🇸🇬 sg ss", Protocol: "shadowsocks", Server: "2.2.2.2", Port: 8388, Country: "SG"},
	}
	spec := TemplateSpec{
		Categories:        []CategorySel{{Name: "Telegram", Policy: "PROXY"}, {Name: "Location:CN", Policy: "DIRECT"}},
		CustomRules:       []CustomRule{{Match: "IP-CIDR,10.0.0.0/24", Policy: "PROXY"}},
		Final:             "PROXY",
		IncludeAutoSelect: true,
		GroupByCountry:    true,
	}
	im := Assemble(nodes, spec, "surge", DefaultRulesetBase)
	if len(im.Nodes) != 2 {
		t.Fatalf("nodes=%d", len(im.Nodes))
	}
	// main PROXY group + auto-select + per-country (JP, SG)
	if findGroup(im.Groups, "PROXY") == nil || findGroup(im.Groups, "Auto Select") == nil {
		t.Fatalf("missing core groups: %+v", im.Groups)
	}
	// custom rule precedes category rules precedes FINAL
	if im.Rules[0] != "IP-CIDR,10.0.0.0/24,PROXY" {
		t.Fatalf("custom rule not first: %v", im.Rules[0])
	}
	if im.Rules[len(im.Rules)-1] != "FINAL,PROXY" {
		t.Fatalf("final not last: %v", im.Rules[len(im.Rules)-1])
	}
}

func findGroup(gs []Group, name string) *Group {
	for i := range gs {
		if gs[i].Name == name {
			return &gs[i]
		}
	}
	return nil
}
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement `base.go`**

```go
package subgen

import "sort"

type Group struct {
	Name    string
	Type    string   // "select" | "url-test"
	Members []string // proxy or group names
}

type Intermediate struct {
	Nodes  []Node
	Groups []Group
	Rules  []string // target-agnostic rule lines, FINAL last
}

const autoSelectGroup = "Auto Select"
const mainProxyGroup = "PROXY"

// Assemble builds the target-agnostic model. Groups: the main manual
// "PROXY" select (members = all node names + per-country groups + auto),
// an "Auto Select" url-test over all nodes, and one url-test per country
// when GroupByCountry. Rules: custom rules first (operator intent wins),
// then category rules, then FINAL.
func Assemble(nodes []Node, spec TemplateSpec, target, rulesetBase string) Intermediate {
	im := Intermediate{Nodes: nodes}
	allNames := make([]string, 0, len(nodes))
	byCountry := map[string][]string{}
	for _, n := range nodes {
		allNames = append(allNames, n.Name)
		byCountry[n.Country] = append(byCountry[n.Country], n.Name)
	}

	mainMembers := []string{}
	if spec.IncludeAutoSelect {
		im.Groups = append(im.Groups, Group{Name: autoSelectGroup, Type: "url-test", Members: allNames})
		mainMembers = append(mainMembers, autoSelectGroup)
	}
	if spec.GroupByCountry {
		countries := make([]string, 0, len(byCountry))
		for c := range byCountry {
			if c != "" {
				countries = append(countries, c)
			}
		}
		sort.Strings(countries)
		for _, c := range countries {
			gname := countryFlag(c) + " " + c
			im.Groups = append(im.Groups, Group{Name: gname, Type: "url-test", Members: byCountry[c]})
			mainMembers = append(mainMembers, gname)
		}
	}
	mainMembers = append(mainMembers, allNames...)
	// main select group first in the list (clients show it on top).
	im.Groups = append([]Group{{Name: mainProxyGroup, Type: "select", Members: mainMembers}}, im.Groups...)

	// Rules: custom first, then categories, then FINAL.
	for _, r := range spec.CustomRules {
		im.Rules = append(im.Rules, r.Match+","+r.Policy)
	}
	for _, c := range spec.Categories {
		im.Rules = append(im.Rules, ResolveRuleLines(c.Name, c.Policy, target, rulesetBase)...)
	}
	im.Rules = append(im.Rules, "FINAL,"+spec.Final)
	return im
}
```

- [ ] **Step 4: Run — passes.** Commit.

```bash
git add internal/plugins/subgen/base.go internal/plugins/subgen/base_test.go
git commit -m "feat(subgen): base assembler -> intermediate model"
```

---

## Phase 4 — Renderers

### Task 10: Renderer interface + Surge renderer

**Files:**
- Create: `internal/plugins/subgen/render.go`, `internal/plugins/subgen/render_surge.go`, `internal/plugins/subgen/render_surge_test.go`

Line templates (from sublink-worker SurgeConfigBuilder + Shadowrocket manual; comma-space separated):

| proto | Surge line |
|---|---|
| shadowsocks | `{name} = ss, {server}, {port}, encrypt-method={method}, password={pw}` |
| vmess | `{name} = vmess, {server}, {port}, username={uuid}, vmess-aead=true[, tls=true, sni={sni}, skip-cert-verify=true][, ws=true, ws-path={path}, ws-headers=Host:{host}]` |
| trojan | `{name} = trojan, {server}, {port}, password={pw}[, sni={sni}][, skip-cert-verify=true][, ws=true, ws-path={path}]` |
| vless/reality | `{name} = vless, {server}, {port}, username={uuid}, tls=true, sni={sni}, public-key={pbk}, short-id={sid}[, flow={flow}]` |
| hysteria2 | `{name} = hysteria2, {server}, {port}, password={pw}[, sni={sni}][, skip-cert-verify=true]` |
| tuic | `{name} = tuic, {server}, {port}, password={pw}, uuid={uuid}[, sni={sni}][, congestion-controller={cc}]` |
| anytls | `{name} = anytls, {server}, {port}, password={pw}[, sni={sni}][, skip-cert-verify=true]` |

Groups: `select` → `{name} = select, {m1}, {m2}, …, DIRECT`; `url-test` → `{name} = url-test, {m1}, …, url=http://www.gstatic.com/generate_204, interval=300`. Layout: `#!MANAGED-CONFIG {url} interval=43200 strict=false`, then `[General]`, `[Proxy]` (`DIRECT = direct` first), `[Proxy Group]`, `[Rule]`.

- [ ] **Step 1: Write `render_surge_test.go`** (golden-ish substring assertions per protocol + layout)

```go
package subgen

import (
	"strings"
	"testing"
)

func TestSurge_RendersProtocolsGroupsRules(t *testing.T) {
	im := Intermediate{
		Nodes: []Node{
			{Name: "ss1", Protocol: "shadowsocks", Server: "1.1.1.1", Port: 8388, SSMethod: "aes-256-gcm", Password: "p"},
			{Name: "re1", Protocol: "vless", Server: "2.2.2.2", Port: 443, UUID: "u", SNI: "s", RealityPublicKey: "PBK", RealityShortID: "aa"},
			{Name: "hy1", Protocol: "hysteria2", Server: "3.3.3.3", Port: 443, Password: "hp", SNI: "h"},
			{Name: "at1", Protocol: "anytls", Server: "4.4.4.4", Port: 443, Password: "ap", SNI: "a"},
		},
		Groups: []Group{
			{Name: "PROXY", Type: "select", Members: []string{"Auto Select", "ss1"}},
			{Name: "Auto Select", Type: "url-test", Members: []string{"ss1", "re1"}},
		},
		Rules: []string{"IP-CIDR,10.0.0.0/24,PROXY", "GEOIP,CN,DIRECT", "FINAL,PROXY"},
	}
	out := (&SurgeRenderer{}).Render(im, "https://x/sub/abc?target=surge")
	for _, want := range []string{
		"#!MANAGED-CONFIG https://x/sub/abc?target=surge",
		"[Proxy]", "DIRECT = direct",
		"ss1 = ss, 1.1.1.1, 8388, encrypt-method=aes-256-gcm, password=p",
		"re1 = vless, 2.2.2.2, 443, username=u, tls=true, sni=s, public-key=PBK, short-id=aa",
		"hy1 = hysteria2, 3.3.3.3, 443, password=hp, sni=h",
		"at1 = anytls, 4.4.4.4, 443, password=ap, sni=a",
		"[Proxy Group]",
		"PROXY = select, Auto Select, ss1, DIRECT",
		"Auto Select = url-test, ss1, re1, url=http://www.gstatic.com/generate_204, interval=300",
		"[Rule]",
		"IP-CIDR,10.0.0.0/24,PROXY",
		"GEOIP,CN,DIRECT",
		"FINAL,PROXY",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q\n---\n%s", want, out)
		}
	}
}
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement `render.go` (interface)**

```go
package subgen

type Renderer interface {
	Target() string
	Supports(protocol string) bool
	Render(im Intermediate, subURL string) string
}

func rendererFor(target string) (Renderer, bool) {
	switch target {
	case "surge":
		return &SurgeRenderer{}, true
	case "shadowrocket":
		return &ShadowRocketRenderer{}, true
	default:
		return nil, false
	}
}
```

- [ ] **Step 4: Implement `render_surge.go`**

```go
package subgen

import (
	"fmt"
	"strings"
)

type SurgeRenderer struct{}

func (*SurgeRenderer) Target() string { return "surge" }

func (*SurgeRenderer) Supports(p string) bool {
	switch p {
	case "shadowsocks", "vmess", "trojan", "vless", "hysteria2", "tuic", "anytls":
		return true
	}
	return false
}

func (r *SurgeRenderer) proxyLine(n Node) string {
	var b strings.Builder
	switch n.Protocol {
	case "shadowsocks":
		fmt.Fprintf(&b, "%s = ss, %s, %d, encrypt-method=%s, password=%s", n.Name, n.Server, n.Port, n.SSMethod, n.Password)
	case "vmess":
		fmt.Fprintf(&b, "%s = vmess, %s, %d, username=%s, vmess-aead=true", n.Name, n.Server, n.Port, n.UUID)
		if n.SNI != "" {
			b.WriteString(", tls=true, sni=" + n.SNI)
			if n.Insecure {
				b.WriteString(", skip-cert-verify=true")
			}
		}
		if n.Transport == "ws" {
			b.WriteString(", ws=true, ws-path=" + n.Path)
			if n.Host != "" {
				b.WriteString(", ws-headers=Host:" + n.Host)
			}
		}
	case "trojan":
		fmt.Fprintf(&b, "%s = trojan, %s, %d, password=%s", n.Name, n.Server, n.Port, n.Password)
		if n.SNI != "" {
			b.WriteString(", sni=" + n.SNI)
		}
		if n.Insecure {
			b.WriteString(", skip-cert-verify=true")
		}
		if n.Transport == "ws" {
			b.WriteString(", ws=true, ws-path=" + n.Path)
			if n.Host != "" {
				b.WriteString(", ws-headers=Host:" + n.Host)
			}
		}
	case "vless":
		fmt.Fprintf(&b, "%s = vless, %s, %d, username=%s, tls=true", n.Name, n.Server, n.Port, n.UUID)
		if n.SNI != "" {
			b.WriteString(", sni=" + n.SNI)
		}
		if n.RealityPublicKey != "" {
			b.WriteString(", public-key=" + n.RealityPublicKey + ", short-id=" + n.RealityShortID)
		}
		if n.Flow != "" {
			b.WriteString(", flow=" + n.Flow)
		}
	case "hysteria2":
		fmt.Fprintf(&b, "%s = hysteria2, %s, %d, password=%s", n.Name, n.Server, n.Port, n.Password)
		if n.SNI != "" {
			b.WriteString(", sni=" + n.SNI)
		}
	case "tuic":
		fmt.Fprintf(&b, "%s = tuic, %s, %d, password=%s, uuid=%s", n.Name, n.Server, n.Port, n.Password, n.UUID)
		if n.SNI != "" {
			b.WriteString(", sni=" + n.SNI)
		}
		if cc, ok := n.Extra["congestion_control"].(string); ok && cc != "" {
			b.WriteString(", congestion-controller=" + cc)
		}
	case "anytls":
		fmt.Fprintf(&b, "%s = anytls, %s, %d, password=%s", n.Name, n.Server, n.Port, n.Password)
		if n.SNI != "" {
			b.WriteString(", sni=" + n.SNI)
		}
	}
	return b.String()
}

func (r *SurgeRenderer) Render(im Intermediate, subURL string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "#!MANAGED-CONFIG %s interval=43200 strict=false\n\n", subURL)

	// skipped-protocol header comment
	var skipped []string
	for _, n := range im.Nodes {
		if !r.Supports(n.Protocol) {
			skipped = append(skipped, n.Name)
		}
	}
	if len(skipped) > 0 {
		fmt.Fprintf(&b, "# skipped %d node(s) not supported by surge: %s\n", len(skipped), strings.Join(skipped, ", "))
	}

	b.WriteString("[General]\nbypass-system = true\n\n")
	b.WriteString("[Proxy]\nDIRECT = direct\n")
	for _, n := range im.Nodes {
		if r.Supports(n.Protocol) {
			b.WriteString(r.proxyLine(n) + "\n")
		}
	}
	b.WriteString("\n[Proxy Group]\n")
	for _, g := range im.Groups {
		b.WriteString(r.groupLine(g) + "\n")
	}
	b.WriteString("\n[Rule]\n")
	for _, rule := range im.Rules {
		b.WriteString(rule + "\n")
	}
	return b.String()
}

func (r *SurgeRenderer) groupLine(g Group) string {
	members := strings.Join(g.Members, ", ")
	if g.Type == "url-test" {
		return fmt.Sprintf("%s = url-test, %s, url=http://www.gstatic.com/generate_204, interval=300", g.Name, members)
	}
	return fmt.Sprintf("%s = select, %s, DIRECT", g.Name, members)
}
```

- [ ] **Step 5: Run — passes.** Commit.

```bash
git add internal/plugins/subgen/render.go internal/plugins/subgen/render_surge.go internal/plugins/subgen/render_surge_test.go
git commit -m "feat(subgen): renderer interface + Surge renderer"
```

### Task 11: ShadowRocket renderer

**Files:**
- Create: `internal/plugins/subgen/render_shadowrocket.go`, `internal/plugins/subgen/render_shadowrocket_test.go`

ShadowRocket consumes Surge `.conf` syntax with these per-protocol differences (Shadowrocket manual): vmess id field `username=`, vless `username=` + `tls=true` + `public-key=`/`short-id=`, tuic `uuid=` works, hysteria2 uses `password=`/`sni=`, anytls `password=`/`sni=`. ShadowRocket is close enough that we subclass Surge's behavior and only override the lines that differ; here we reuse the Surge proxy lines (they are accepted by ShadowRocket) and keep the same section layout. The separate renderer exists so future ShadowRocket-only tweaks have a home and `Target()` reports `shadowrocket`.

- [ ] **Step 1: Write `render_shadowrocket_test.go`**

```go
package subgen

import (
	"strings"
	"testing"
)

func TestShadowRocket_RendersAndReportsTarget(t *testing.T) {
	r := &ShadowRocketRenderer{}
	if r.Target() != "shadowrocket" {
		t.Fatalf("target=%s", r.Target())
	}
	im := Intermediate{
		Nodes:  []Node{{Name: "tu1", Protocol: "tuic", Server: "1.1.1.1", Port: 443, Password: "p", UUID: "u", SNI: "s"}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"tu1"}}},
		Rules:  []string{"FINAL,PROXY"},
	}
	out := r.Render(im, "https://x/sub/t?target=shadowrocket")
	for _, want := range []string{
		"[Proxy]", "tu1 = tuic, 1.1.1.1, 443, password=p, uuid=u, sni=s",
		"[Proxy Group]", "PROXY = select, tu1, DIRECT", "[Rule]", "FINAL,PROXY",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q\n%s", want, out)
		}
	}
}
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement `render_shadowrocket.go`** (embed Surge, override Target)

```go
package subgen

type ShadowRocketRenderer struct {
	SurgeRenderer
}

func (*ShadowRocketRenderer) Target() string { return "shadowrocket" }
```

(Inherits `Supports`, `proxyLine`, `Render`, `groupLine` from the embedded `SurgeRenderer`. If a future ShadowRocket-specific line is needed, override `proxyLine` here.)

- [ ] **Step 4: Run — passes.** Commit.

```bash
git add internal/plugins/subgen/render_shadowrocket.go internal/plugins/subgen/render_shadowrocket_test.go
git commit -m "feat(subgen): ShadowRocket renderer"
```

---

## Phase 5 — Service, public endpoint, admin API

### Task 12: Generate service

**Files:**
- Create: `internal/plugins/subgen/service.go`, `internal/plugins/subgen/service_test.go`

- [ ] **Step 1: Write `service_test.go`**

```go
package subgen

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestService_GenerateByToken(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	s.DB.MustExec(`INSERT INTO servers(id,name,ssh_host,country_code) VALUES (1,'jp','1.1.1.1','JP')`)
	s.DB.MustExec(`INSERT INTO xray_inbounds(id,server_id,tag,port,role,protocol,uuid,sni,public_key,short_id)
	               VALUES (10,1,'r',443,'landing','vless-reality','u','sni','PBK','aa')`)
	tid, _ := s.CreateTemplate(ctx, "t", false, `{"categories":[{"name":"Telegram","policy":"PROXY"}],"final":"PROXY"}`)
	sub, _ := s.CreateSubscription(ctx, "s", tid)
	_ = s.SetInbounds(ctx, sub.ID, []Selection{{Source: "xray", InboundID: 10}})

	svc := &Service{Store: s, Now: time.Now, RulesetBase: DefaultRulesetBase}
	out, ct, err := svc.Generate(ctx, sub.Token, "surge")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ct, "text/plain") {
		t.Fatalf("content-type=%s", ct)
	}
	if !strings.Contains(out, "vless, 1.1.1.1, 443") || !strings.Contains(out, "RULE-SET,") {
		t.Fatalf("output:\n%s", out)
	}
}

func TestService_UnknownTokenAndTarget(t *testing.T) {
	s := newStore(t)
	svc := &Service{Store: s, Now: time.Now}
	if _, _, err := svc.Generate(context.Background(), "nope", "surge"); err == nil {
		t.Fatal("expected error for unknown token")
	}
}
```

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement `service.go`**

```go
package subgen

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var ErrNotFound = errors.New("subscription not found")
var ErrBadTarget = errors.New("unknown target")

type Service struct {
	Store       *Store
	Now         func() time.Time
	RulesetBase string // empty → DefaultRulesetBase
	PublicURL   string // base for #!MANAGED-CONFIG, e.g. https://host
}

func (s *Service) base() string {
	if s.RulesetBase != "" {
		return s.RulesetBase
	}
	return DefaultRulesetBase
}

func (s *Service) Generate(ctx context.Context, token, target string) (body, contentType string, err error) {
	r, ok := rendererFor(target)
	if !ok {
		return "", "", ErrBadTarget
	}
	sub, err := s.Store.SubscriptionByToken(ctx, token)
	if err != nil || !sub.Enabled {
		return "", "", ErrNotFound
	}
	tpl, err := s.Store.Template(ctx, sub.TemplateID)
	if err != nil {
		return "", "", ErrNotFound
	}
	spec, err := ParseTemplate(tpl.RulesJSON)
	if err != nil {
		return "", "", err
	}
	sels, _ := s.Store.InboundsFor(ctx, sub.ID)
	nodes, _, err := CollectNodes(ctx, s.Store.DB, sels)
	if err != nil {
		return "", "", err
	}
	im := Assemble(nodes, spec, target, s.base())
	subURL := fmt.Sprintf("%s/sub/%s?target=%s", s.PublicURL, token, target)
	return r.Render(im, subURL), "text/plain; charset=utf-8", nil
}
```

- [ ] **Step 4: Run — passes.** Commit.

```bash
git add internal/plugins/subgen/service.go internal/plugins/subgen/service_test.go
git commit -m "feat(subgen): Generate service"
```

### Task 13: Public `/sub/{token}` endpoint + wiring

**Files:**
- Create: `internal/api/subgen.go`, `internal/api/subgen_test.go`
- Modify: `internal/api/router.go` (Router struct + NewRouter + Handler), `cmd/server/main.go`

- [ ] **Step 1: Write `internal/api/subgen_test.go`**

```go
package api

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/hg-claw/Shepherd/internal/plugins/subgen"
)

func newSubgenAPI(t *testing.T) (*SubgenAPI, *subgen.Store) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "s.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "subgen", subgen.LoadMigrationsForTest(shepdb.DriverSQLite))
	st := &subgen.Store{DB: d, Now: time.Now}
	svc := &subgen.Service{Store: st, Now: time.Now}
	api := &SubgenAPI{Service: svc}
	api.InitRateLimit(60, time.Minute)
	return api, st
}

func TestSubgenPublic_TokenAuthAndTarget(t *testing.T) {
	api, st := newSubgenAPI(t)
	ctx := context.Background()
	tid, _ := st.CreateTemplate(ctx, "t", false, `{"final":"PROXY"}`)
	sub, _ := st.CreateSubscription(ctx, "s", tid)

	// bad target → 400
	r := httptest.NewRequest("GET", "/sub/"+sub.Token+"?target=clash", nil)
	r.SetPathValue("token", sub.Token)
	w := httptest.NewRecorder()
	api.GetSubscription(w, r)
	if w.Code != 400 {
		t.Fatalf("bad target: %d", w.Code)
	}
	// unknown token → 404
	r = httptest.NewRequest("GET", "/sub/nope?target=surge", nil)
	r.SetPathValue("token", "nope")
	w = httptest.NewRecorder()
	api.GetSubscription(w, r)
	if w.Code != 404 {
		t.Fatalf("unknown token: %d", w.Code)
	}
	// valid → 200 text/plain
	r = httptest.NewRequest("GET", "/sub/"+sub.Token+"?target=surge", nil)
	r.SetPathValue("token", sub.Token)
	w = httptest.NewRecorder()
	api.GetSubscription(w, r)
	if w.Code != 200 || w.Header().Get("Content-Type") != "text/plain; charset=utf-8" {
		t.Fatalf("valid: %d %s", w.Code, w.Header().Get("Content-Type"))
	}
}
```

- [ ] **Step 2: Add a test-only migrations exporter** in `internal/plugins/subgen/subgen.go`:

```go
// LoadMigrationsForTest exposes loadMigrations to other packages' tests.
func LoadMigrationsForTest(driver shepdb.Driver) []plugins.Migration { return loadMigrations(driver) }
```

- [ ] **Step 3: Run — fails** (`undefined: SubgenAPI`).

- [ ] **Step 4: Implement `internal/api/subgen.go`** (reuse the `tokenRateLimiter` pattern from `agent_status_ratelimit.go`)

```go
package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/hg-claw/Shepherd/internal/plugins/subgen"
)

type SubgenAPI struct {
	Service *subgen.Service
	limit   *tokenRateLimiter
}

func (a *SubgenAPI) InitRateLimit(max int, window time.Duration) {
	a.limit = newTokenRateLimiter(max, window)
}

// GetSubscription serves GET /sub/{token}?target=… — PUBLIC (token is the
// secret; no admin cookie). Wired on the root mux in router.go.
func (a *SubgenAPI) GetSubscription(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	if token == "" {
		http.NotFound(w, r)
		return
	}
	if a.limit != nil && !a.limit.allow(token) {
		writeError(w, 429, "rate limit exceeded")
		return
	}
	target := r.URL.Query().Get("target")
	body, ct, err := a.Service.Generate(r.Context(), token, target)
	switch {
	case errors.Is(err, subgen.ErrBadTarget):
		writeError(w, 400, "unknown target")
		return
	case errors.Is(err, subgen.ErrNotFound):
		http.NotFound(w, r)
		return
	case err != nil:
		writeError(w, 500, err.Error())
		return
	}
	w.Header().Set("Content-Type", ct)
	_, _ = w.Write([]byte(body))
}

var _ = context.Background // keep import if unused after edits
```

- [ ] **Step 5: Wire into `internal/api/router.go`**
  - Add `Subgen *SubgenAPI` to the `Router` struct.
  - Add `subgenAPI *SubgenAPI` as the final param of `NewRouter` + assign `Subgen: subgenAPI` in the returned struct.
  - In `Handler()`, register on the **root** mux next to `/healthz`:

```go
	if r.Subgen != nil {
		mux.HandleFunc("GET /sub/{token}", r.Subgen.GetSubscription)
	}
```

  - In the `/api/` catch-all closure, `/sub/` is NOT under `/api/` so it is unaffected (it matches the explicit pattern above first).

- [ ] **Step 6: Wire into `cmd/server/main.go`** — after the store/service constructions, before `NewRouter`:

```go
	subgenStore := &subgen.Store{DB: d, Now: time.Now}
	subgenSvc := &subgen.Service{
		Store:       subgenStore,
		Now:         time.Now,
		RulesetBase: subgen.DefaultRulesetBase,
		PublicURL:   deriveServerURL(cfg),
	}
	subgenAPI := &api.SubgenAPI{Service: subgenSvc}
	subgenAPI.InitRateLimit(60, time.Minute)
```

  Add `subgenAPI` as the new trailing arg to `api.NewRouter(...)`. Add import `"github.com/hg-claw/Shepherd/internal/plugins/subgen"` (named, since we use it directly here — keep the blank import from Task 1 OR switch it to this named import; do NOT have both).

- [ ] **Step 7: Run tests + build**

Run: `go test ./internal/api/ -run Subgen -v && go build ./...`
Expected: PASS + build OK.

- [ ] **Step 8: Commit**

```bash
git add internal/api/subgen.go internal/api/subgen_test.go internal/api/router.go cmd/server/main.go internal/plugins/subgen/subgen.go
git commit -m "feat(subgen): public /sub/{token} endpoint + wiring"
```

### Task 14: Admin CRUD routes

**Files:**
- Create: `internal/plugins/subgen/routes.go`, `internal/plugins/subgen/routes_test.go`
- Modify: `internal/plugins/subgen/subgen.go` (remove the `registerRoutes` stub)

Routes mounted via the plugin's gated mux (prefix `/api/admin/plugins/subgen`):
`GET/POST /subscriptions`, `PATCH/DELETE /subscriptions/{id}`, `POST /subscriptions/{id}/rotate-token`, `PUT /subscriptions/{id}/inbounds`, `GET/POST /templates`, `PATCH/DELETE /templates/{id}`, `GET /categories`, `GET /subscriptions/{id}/preview`.

- [ ] **Step 1: Write `routes_test.go`** — drive handlers directly (construct `*Plugin` with `deps`), assert: create template (valid), reject invalid `rules_json`, create subscription, set inbounds, rotate token changes token, builtin template PATCH/DELETE rejected, `GET /categories` returns the catalog.

```go
package subgen

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestRoutes_TemplateValidationAndBuiltinImmutability(t *testing.T) {
	s := newStore(t)
	p := &Plugin{deps: depsWith(s.DB)}
	ctx := context.Background()
	_ = seedBuiltinTemplates(ctx, s.DB)

	// invalid rules_json rejected at create
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/templates", strings.NewReader(`{"name":"x","rules_json":"{\"categories\":[{\"name\":\"Nope\",\"policy\":\"PROXY\"}]}"}`))
	p.createTemplate(w, r)
	if w.Code != 400 {
		t.Fatalf("invalid template not rejected: %d", w.Code)
	}

	// builtin delete rejected
	ts, _ := s.ListTemplates(ctx)
	var builtinID int64
	for _, tpl := range ts {
		if tpl.Builtin {
			builtinID = tpl.ID
		}
	}
	w = httptest.NewRecorder()
	r = httptest.NewRequest("DELETE", "/templates/"+strconv.FormatInt(builtinID, 10), nil)
	r.SetPathValue("id", strconv.FormatInt(builtinID, 10))
	p.deleteTemplate(w, r)
	if w.Code == 200 || w.Code == 204 {
		t.Fatalf("builtin delete should fail, got %d", w.Code)
	}

	// categories catalog
	w = httptest.NewRecorder()
	p.listCategories(w, httptest.NewRequest("GET", "/categories", nil))
	var cats []map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &cats)
	if len(cats) != len(UnifiedCategories) {
		t.Fatalf("categories=%d want %d", len(cats), len(UnifiedCategories))
	}
}
```

Add a `depsWith` helper in the test file: `func depsWith(db *sqlx.DB) plugins.Deps { return plugins.Deps{DB: db, Now: time.Now} }` (import sqlx, plugins, time).

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement `routes.go`** — `registerRoutes` mounts the patterns; each handler reads `p.store()` (lazily builds `&Store{DB: p.deps.DB, Now: p.deps.Now}`). Validate template `rules_json` via `ParseTemplate` before persisting. Builtin guard returns 403 on PATCH/DELETE of `builtin=1` rows (the store already filters with `builtin=0`, so check affected-rows / pre-read and 403). `listCategories` marshals `UnifiedCategories` plus each category's resolved URL(s) using `DefaultRulesetBase`. `preview` calls a shared generate path against the subscription's selections + template for the `?target=`.

  Provide the full handler bodies (createTemplate, updateTemplate, deleteTemplate, listTemplates, createSubscription, updateSubscription, deleteSubscription, rotateToken, setInbounds, listSubscriptions, listCategories, preview) following the cloudflare/netquality `writeJSON`/`writeErr` helper style. Use `encoding/json` for request bodies. (Implementer: mirror `internal/plugins/netquality/routes.go` helpers `writeJSON`/`writeErr`; copy them into a small `httputil.go` in the subgen package.)

- [ ] **Step 4: Remove the `registerRoutes` stub** added in Task 1; the real one lives in routes.go.

- [ ] **Step 5: Run — passes.** Build. Commit.

```bash
git add internal/plugins/subgen/routes.go internal/plugins/subgen/routes_test.go internal/plugins/subgen/subgen.go internal/plugins/subgen/httputil.go
git commit -m "feat(subgen): admin CRUD routes"
```

---

## Phase 6 — Frontend

### Task 15: API client + plugin registration + page skeleton

**Files:**
- Create: `web/src/api/subgen.ts`, `web/src/pages/admin/plugins/subgen/index.tsx`
- Modify: `web/src/pages/admin/plugins/PluginRegistry.ts`

- [ ] **Step 1: `web/src/api/subgen.ts`** — typed wrappers:

```ts
import { api } from './client'

export interface SubgenTemplate { id: number; name: string; builtin: boolean; rules_json: string }
export interface SubgenSubscription { id: number; name: string; token: string; template_id: number; enabled: boolean }
export interface SubgenSelection { source: 'xray' | 'singbox'; inbound_id: number }
export interface SubgenCategory { name: string; default_policy: string; rule_urls: string[] }

const B = '/api/admin/plugins/subgen'
export const listSubgenSubscriptions = () => api.get<SubgenSubscription[]>(`${B}/subscriptions`)
export const createSubgenSubscription = (name: string, template_id: number) =>
  api.post<SubgenSubscription>(`${B}/subscriptions`, { name, template_id })
export const updateSubgenSubscription = (id: number, body: Partial<SubgenSubscription>) =>
  api.patch<SubgenSubscription>(`${B}/subscriptions/${id}`, body)
export const deleteSubgenSubscription = (id: number) => api.delete<void>(`${B}/subscriptions/${id}`)
export const rotateSubgenToken = (id: number) => api.post<SubgenSubscription>(`${B}/subscriptions/${id}/rotate-token`, {})
export const setSubgenInbounds = (id: number, sels: SubgenSelection[]) =>
  api.put<void>(`${B}/subscriptions/${id}/inbounds`, { inbounds: sels })
export const listSubgenTemplates = () => api.get<SubgenTemplate[]>(`${B}/templates`)
export const createSubgenTemplate = (name: string, rules_json: string) =>
  api.post<SubgenTemplate>(`${B}/templates`, { name, rules_json })
export const updateSubgenTemplate = (id: number, name: string, rules_json: string) =>
  api.patch<SubgenTemplate>(`${B}/templates/${id}`, { name, rules_json })
export const deleteSubgenTemplate = (id: number) => api.delete<void>(`${B}/templates/${id}`)
export const listSubgenCategories = () => api.get<SubgenCategory[]>(`${B}/categories`)
```

- [ ] **Step 2: Register in `PluginRegistry.ts`**

```ts
subgen: {
  module: () => import('./subgen'),
  tabs: [
    { key: 'subscriptions', label: 'Subscriptions' },
    { key: 'templates', label: 'Templates' },
  ],
},
```

- [ ] **Step 3: `subgen/index.tsx`** — tab routing (mirror cloudflare/index.tsx)

```tsx
import { Routes, Route, Navigate } from 'react-router-dom'
import SubscriptionsTab from './SubscriptionsTab'
import TemplatesTab from './TemplatesTab'

export default function SubgenPlugin() {
  return (
    <Routes>
      <Route index element={<Navigate to="subscriptions" replace />} />
      <Route path="subscriptions" element={<SubscriptionsTab />} />
      <Route path="templates" element={<TemplatesTab />} />
    </Routes>
  )
}
```

- [ ] **Step 4: Build (will fail until tabs exist)** — proceed to Task 16/17 then build. Commit after Task 17.

### Task 16: Subscriptions tab

**Files:** Create `web/src/pages/admin/plugins/subgen/SubscriptionsTab.tsx`

- [ ] **Step 1:** Table of subscriptions (TanStack `useQuery(['subgen-subs'], listSubgenSubscriptions)`); create dialog (name + template `<select>` from `listSubgenTemplates`); per row: the subscription URL `${origin}/sub/${token}?target=surge` with copy button + a `target` toggle (surge/shadowrocket), a "Rotate token" button (`rotateSubgenToken` → invalidate), an inbound picker dialog (node checkboxes grouped by server; reuse `useServers` + xray/singbox inbound list endpoints; persist via `setSubgenInbounds`), delete with confirm. Follow the existing plugin-tab styling.

- [ ] **Step 2:** Manual visual check deferred to smoke; no unit test required for this tab (interaction-heavy). Optionally add a vitest that mocks `@/api/subgen` and asserts a subscription row + copy button render.

### Task 17: Templates tab

**Files:** Create `web/src/pages/admin/plugins/subgen/TemplatesTab.tsx`

- [ ] **Step 1:** List templates (built-in badge + "Clone" → create custom prefilled; custom → edit/delete). Editor: category checklist from `listSubgenCategories`; per checked category a policy `<select>` (PROXY/DIRECT/REJECT + group names) and a read-only display of that category's `rule_urls` (the GitHub subscription addresses); `custom_rules` textarea (`TYPE,VALUE,policy` per line, parsed into `{match,policy}`); toggles `group_by_country` / `include_auto_select`; `final` `<select>`. Save serializes to `rules_json` and calls create/update.

- [ ] **Step 2: Build + tests**

Run: `cd web && npx tsc --noEmit && npm run build && npx vitest run`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add web/src/api/subgen.ts web/src/pages/admin/plugins/subgen web/src/pages/admin/plugins/PluginRegistry.ts
git commit -m "feat(subgen): admin UI (subscriptions + templates tabs)"
```

### Task 18: Full-suite verification + smoke

- [ ] **Step 1:** `cd /Users/hg/project/Shepherd && go test ./... && cd web && npx tsc --noEmit && npm run build && npx vitest run` — all green.
- [ ] **Step 2:** Manual smoke: enable the `subgen` plugin in admin; create a template; create a subscription selecting one xray + one singbox inbound; open `/sub/{token}?target=surge` and `?target=shadowrocket`; confirm the config contains the nodes + `RULE-SET` lines + groups; import into Surge/ShadowRocket and verify it connects.
- [ ] **Step 3: Final commit** (any smoke fixes), then hand off to `superpowers:finishing-a-development-branch`.

---

## Self-Review

**Spec coverage:** ✅ subscription entity + node selection (Tasks 3,6,16); category routing via remote RULE-SET (Tasks 7,9); built-in + custom templates (Tasks 8,17); Surge + ShadowRocket renderers incl. anytls (Tasks 10,11); public token endpoint as the one core-router change (Task 13); admin CRUD + categories + preview (Task 14); `ruleset_base` configurable (Service field, Task 12/13 — exposed via plugin config in a follow-up if UI editing is wanted; default wired now); frontend two tabs (Tasks 15-17); protocol×format coverage + skip path (Task 10 `Supports` + header comment); tests throughout.

**Gaps deliberately deferred (not v1):** Clash/sing-box/QX renderers; remote ruleset-URL custom templates; per-inbound host override; editing `ruleset_base` from the UI (it's a `Service` field + `DefaultRulesetBase`; a plugin-config editor can be added when needed — note for implementer).

**Type consistency:** `Node`, `Selection`, `TemplateSpec`, `Intermediate`, `Group`, `Renderer`, `Service`, `Store`, `SubgenAPI` names are used consistently across tasks. `ResolveRuleLines(category, policy, target, base)` signature matches its callers in `Assemble`. `Service.Generate(ctx, token, target) (body, contentType, err)` matches the API handler. Mapper input structs (`xrayLite`/`singboxLite`/`serverLite`) are consistent between `node.go` and `collect.go`.

**Placeholder scan:** Two tasks (14 admin handlers, 16/17 React tabs) describe the handlers/components in prose + give the contract and exact route/field names rather than every line — these are mechanical given the established `writeJSON`/`writeErr` and TanStack patterns already shown. All novel logic (mappers, catalog, assembler, renderers, service, wiring) has complete code.
