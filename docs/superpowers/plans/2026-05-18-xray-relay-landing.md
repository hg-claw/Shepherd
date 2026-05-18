# xray Relay / Landing Topology — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an xray host be either a `landing` (current behavior, terminates traffic) or a `relay` (tunnels client traffic to a chosen landing via vless+REALITY), with single-host and bulk-create flows in the UI.

**Architecture:** New table `xray_host_topology(server_id PK, role, upstream_server_id)` stores the N relay → 1 landing relation. Frontend renders both kinds of xray config and POSTs full JSON; backend validates+persists topology via three new optional plugin interfaces (`DeployValidator` / `DeployCommitter` / `UndeployValidator`) hooked into the existing generic `/api/admin/plugins/{id}/hosts` endpoints. Bulk relay creation is pure frontend orchestration over the same single-host deploy endpoint.

**Tech Stack:** Go 1.25 / sqlx / SQLite (plugin schemas) / React 19 + TS + Tailwind + shadcn/ui + react-query. Reference spec: `docs/superpowers/specs/2026-05-18-xray-relay-landing-design.md`.

---

## File Map

**Create:**
- `internal/plugins/xray/migrations/0002_topology.up.sql` — new table + backfill
- `internal/plugins/xray/migrations/0002_topology.down.sql`
- `internal/plugins/xray/topology.go` — TopologyStore DAO
- `internal/plugins/xray/topology_test.go`
- `web/src/pages/admin/plugins/xray/BulkRelayDialog.tsx`
- `web/src/pages/admin/plugins/xray/BulkRelayDialog.test.tsx`

**Modify:**
- `internal/plugins/xray/migrations.go` — register 0002
- `internal/plugins/xray/config.go` — render relay outbound
- `internal/plugins/xray/config_test.go` — relay rendering assertions
- `internal/plugins/xray/xray.go` — implement 3 validator interfaces
- `internal/plugins/xray/routes.go` — GET /topology endpoint
- `internal/plugins/xray/routes_test.go` — topology endpoint test
- `internal/plugins/plugin.go` — three new optional interfaces
- `internal/api/plugins.go` — wire validators into PostHost / DeleteHost; `hostBody.Topology`
- `internal/api/plugins_test.go` — assert generic API calls hooks correctly
- `web/src/api/plugins.ts` — topology fetcher + types; deployPluginHost body
- `web/src/pages/admin/plugins/xray/templates.ts` — relay render + parse + types
- `web/src/pages/admin/plugins/xray/templates.test.ts` — relay tests
- `web/src/pages/admin/plugins/xray/DeployDialog.tsx` — role + upstream + lock
- `web/src/pages/admin/plugins/xray/HostsTab.tsx` — role column + undeploy guard + "+ Relays" button

---

## Task 1: Migration — `xray_host_topology` table

**Files:**
- Create: `internal/plugins/xray/migrations/0002_topology.up.sql`
- Create: `internal/plugins/xray/migrations/0002_topology.down.sql`
- Modify: `internal/plugins/xray/migrations.go`
- Modify: `internal/plugins/xray/xray_test.go` (or add new) — assert migration creates the table and backfills landing rows

- [ ] **Step 1: Write the failing test**

Add to `internal/plugins/xray/xray_test.go`:

```go
func TestMigration0002_CreatesTopologyAndBackfillsLanding(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "p.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil { t.Fatal(err) }
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil { t.Fatal(err) }

	// Seed: one server + one xray plugin_host BEFORE the topology migration runs.
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_password,ssh_port,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?)`, 9, "s9", "1.2.3.4", "root", "x", 22, time.Now(), time.Now())
	d.MustExec(`INSERT INTO plugin_hosts(plugin_id,server_id,config,status,updated_at)
		VALUES (?,?,?,?,?)`, "xray", 9, []byte("{}"), "running", time.Now())

	// Apply ONLY the xray plugin migrations (0001 + 0002).
	migs := loadMigrations()
	if err := plugins.RunPluginMigrations(context.Background(), d, "xray", migs); err != nil {
		t.Fatal(err)
	}

	var n int
	if err := d.Get(&n, "SELECT COUNT(*) FROM xray_host_topology WHERE server_id=9"); err != nil {
		t.Fatalf("query topology: %v", err)
	}
	if n != 1 { t.Fatalf("expected 1 backfilled landing row, got %d", n) }
	var role string
	_ = d.Get(&role, "SELECT role FROM xray_host_topology WHERE server_id=9")
	if role != "landing" { t.Fatalf("backfill role = %q want landing", role) }
}
```

Imports needed (add if missing): `"path/filepath"`, `"time"`, `shepdb "github.com/hg-claw/Shepherd/internal/db"`, `"github.com/hg-claw/Shepherd/internal/plugins"`.

- [ ] **Step 2: Run test to verify it fails**

```
go test -run TestMigration0002_CreatesTopologyAndBackfillsLanding ./internal/plugins/xray/...
```

Expected: FAIL — `loadMigrations` only returns `0001_xray.up.sql`, so `xray_host_topology` is never created.

- [ ] **Step 3: Create the up migration**

`internal/plugins/xray/migrations/0002_topology.up.sql`:

```sql
CREATE TABLE xray_host_topology (
  server_id           INTEGER PRIMARY KEY
                        REFERENCES servers(id) ON DELETE CASCADE,
  role                TEXT    NOT NULL CHECK (role IN ('landing', 'relay')),
  upstream_server_id  INTEGER REFERENCES servers(id) ON DELETE RESTRICT,
  updated_at          TIMESTAMP NOT NULL,
  CHECK (
    (role = 'landing' AND upstream_server_id IS NULL) OR
    (role = 'relay'   AND upstream_server_id IS NOT NULL)
  )
);
CREATE INDEX xray_host_topology_upstream ON xray_host_topology(upstream_server_id);

-- Backfill: every existing xray plugin_host is treated as a landing.
INSERT INTO xray_host_topology(server_id, role, upstream_server_id, updated_at)
SELECT server_id, 'landing', NULL, COALESCE(updated_at, CURRENT_TIMESTAMP)
FROM plugin_hosts
WHERE plugin_id = 'xray'
ON CONFLICT(server_id) DO NOTHING;
```

- [ ] **Step 4: Create the down migration**

`internal/plugins/xray/migrations/0002_topology.down.sql`:

```sql
DROP INDEX IF EXISTS xray_host_topology_upstream;
DROP TABLE IF EXISTS xray_host_topology;
```

- [ ] **Step 5: Register 0002 in loader**

Edit `internal/plugins/xray/migrations.go`:

```go
names := []string{
	"0001_xray.up.sql",
	"0002_topology.up.sql",
}
```

- [ ] **Step 6: Re-run test to verify pass**

```
go test -run TestMigration0002 ./internal/plugins/xray/...
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/plugins/xray/migrations/0002_topology.up.sql \
        internal/plugins/xray/migrations/0002_topology.down.sql \
        internal/plugins/xray/migrations.go \
        internal/plugins/xray/xray_test.go
git commit -m "feat(plugins/xray): xray_host_topology table + backfill existing hosts as landing"
```

---

## Task 2: TopologyStore (Go DAO)

**Files:**
- Create: `internal/plugins/xray/topology.go`
- Create: `internal/plugins/xray/topology_test.go`

- [ ] **Step 1: Write the failing test**

`internal/plugins/xray/topology_test.go`:

```go
package xray

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

func newTopoStore(t *testing.T) *TopologyStore {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
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
	return &TopologyStore{DB: d, Now: time.Now}
}

func TestTopologyStore_UpsertLanding(t *testing.T) {
	s := newTopoStore(t)
	ctx := context.Background()
	if err := s.UpsertLanding(ctx, 1); err != nil { t.Fatal(err) }
	row, err := s.Get(ctx, 1)
	if err != nil { t.Fatal(err) }
	if row.Role != "landing" || row.UpstreamServerID.Valid {
		t.Fatalf("got %+v", row)
	}
}

func TestTopologyStore_UpsertRelay_AndListByUpstream(t *testing.T) {
	s := newTopoStore(t)
	ctx := context.Background()
	if err := s.UpsertLanding(ctx, 1); err != nil { t.Fatal(err) }
	if err := s.UpsertRelay(ctx, 2, 1); err != nil { t.Fatal(err) }
	if err := s.UpsertRelay(ctx, 3, 1); err != nil { t.Fatal(err) }
	relays, err := s.ListByUpstream(ctx, 1)
	if err != nil { t.Fatal(err) }
	if len(relays) != 2 { t.Fatalf("relays = %v", relays) }
}

func TestTopologyStore_DeleteCascadesOnUpstreamRestrict(t *testing.T) {
	s := newTopoStore(t)
	ctx := context.Background()
	_ = s.UpsertLanding(ctx, 1)
	_ = s.UpsertRelay(ctx, 2, 1)
	// Deleting landing while relay depends on it must fail.
	if err := s.Delete(ctx, 1); err == nil {
		t.Fatalf("expected delete to fail (RESTRICT), got nil")
	}
	// Deleting the relay first then landing works.
	if err := s.Delete(ctx, 2); err != nil { t.Fatal(err) }
	if err := s.Delete(ctx, 1); err != nil { t.Fatal(err) }
}

func TestTopologyStore_ListWithUpstreamName(t *testing.T) {
	s := newTopoStore(t)
	ctx := context.Background()
	_ = s.UpsertLanding(ctx, 1)
	_ = s.UpsertRelay(ctx, 2, 1)
	rows, err := s.ListWithUpstreamName(ctx)
	if err != nil { t.Fatal(err) }
	byID := map[int64]TopologyView{}
	for _, r := range rows { byID[r.ServerID] = r }
	if byID[2].UpstreamName.String != "s1" {
		t.Fatalf("relay row upstream_name = %q want s1", byID[2].UpstreamName.String)
	}
}

var _ = sql.NullString{} // keep import in case test trims helpers
```

- [ ] **Step 2: Run test to verify it fails**

```
go test -run TestTopologyStore ./internal/plugins/xray/...
```

Expected: FAIL — `TopologyStore` and friends don't exist.

- [ ] **Step 3: Implement the store**

`internal/plugins/xray/topology.go`:

```go
package xray

import (
	"context"
	"database/sql"
	"time"

	"github.com/jmoiron/sqlx"
)

// Topology is the on-disk row.
type Topology struct {
	ServerID         int64         `db:"server_id"`
	Role             string        `db:"role"` // "landing" | "relay"
	UpstreamServerID sql.NullInt64 `db:"upstream_server_id"`
	UpdatedAt        time.Time     `db:"updated_at"`
}

// TopologyView extends Topology with the upstream landing's server name
// (NULL for landings; populated for relays via servers.name JOIN).
type TopologyView struct {
	Topology
	UpstreamName sql.NullString `db:"upstream_name"`
}

type TopologyStore struct {
	DB  *sqlx.DB
	Now func() time.Time
}

func (s *TopologyStore) now() time.Time {
	if s.Now == nil { return time.Now().UTC() }
	return s.Now().UTC()
}

// Get returns ErrNoRows when no row exists for serverID.
func (s *TopologyStore) Get(ctx context.Context, serverID int64) (Topology, error) {
	var t Topology
	err := s.DB.GetContext(ctx, &t,
		`SELECT server_id, role, upstream_server_id, updated_at
		 FROM xray_host_topology WHERE server_id=?`, serverID)
	return t, err
}

func (s *TopologyStore) UpsertLanding(ctx context.Context, serverID int64) error {
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO xray_host_topology(server_id, role, upstream_server_id, updated_at)
		 VALUES (?, 'landing', NULL, ?)
		 ON CONFLICT(server_id) DO UPDATE SET
		   role='landing', upstream_server_id=NULL, updated_at=excluded.updated_at`,
		serverID, s.now())
	return err
}

func (s *TopologyStore) UpsertRelay(ctx context.Context, serverID, upstreamServerID int64) error {
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO xray_host_topology(server_id, role, upstream_server_id, updated_at)
		 VALUES (?, 'relay', ?, ?)
		 ON CONFLICT(server_id) DO UPDATE SET
		   role='relay', upstream_server_id=excluded.upstream_server_id,
		   updated_at=excluded.updated_at`,
		serverID, upstreamServerID, s.now())
	return err
}

// Delete removes a topology row. FK RESTRICT on upstream_server_id will
// return an error if other relays still point to this server.
func (s *TopologyStore) Delete(ctx context.Context, serverID int64) error {
	_, err := s.DB.ExecContext(ctx,
		`DELETE FROM xray_host_topology WHERE server_id=?`, serverID)
	return err
}

func (s *TopologyStore) ListByUpstream(ctx context.Context, upstreamServerID int64) ([]Topology, error) {
	rows := []Topology{}
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT server_id, role, upstream_server_id, updated_at
		 FROM xray_host_topology WHERE upstream_server_id=?`, upstreamServerID)
	return rows, err
}

func (s *TopologyStore) ListWithUpstreamName(ctx context.Context) ([]TopologyView, error) {
	rows := []TopologyView{}
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT t.server_id, t.role, t.upstream_server_id, t.updated_at,
		        up.name AS upstream_name
		 FROM xray_host_topology t
		 LEFT JOIN servers up ON up.id = t.upstream_server_id`)
	return rows, err
}
```

- [ ] **Step 4: Run test to verify pass**

```
go test -run TestTopologyStore ./internal/plugins/xray/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/xray/topology.go internal/plugins/xray/topology_test.go
git commit -m "feat(plugins/xray): TopologyStore DAO with upstream listing + RESTRICT-safe delete"
```

---

## Task 3: `RenderVLESSReality` relay branch

**Files:**
- Modify: `internal/plugins/xray/config.go`
- Modify: `internal/plugins/xray/config_test.go`

- [ ] **Step 1: Add failing test for relay rendering**

Append to `internal/plugins/xray/config_test.go`:

```go
func TestRenderTemplate_VLESSReality_Relay(t *testing.T) {
	out, err := RenderTemplate(TemplateRequest{
		Inbound: "vless-reality",
		Port:    443, UUID: "11111111-1111-1111-1111-111111111111",
		SNI: "example.com", PublicKey: "RPUB", PrivateKey: "RPRIV", ShortID: "ee",
		Topology: &TopologyRef{
			Role: "relay",
			Landing: &LandingRef{
				Address: "edge.example.com", Port: 8443,
				SNI: "www.icloud.com", UUID: "ll-uuid",
				PublicKey: "LPUB", ShortID: "ll",
			},
		},
	})
	if err != nil { t.Fatal(err) }
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil { t.Fatal(err) }

	// Inbound: relay's own creds.
	in := m["inbounds"].([]any)[0].(map[string]any)
	if in["port"].(float64) != 443 { t.Fatalf("inbound port: %v", in["port"]) }
	client := in["settings"].(map[string]any)["clients"].([]any)[0].(map[string]any)
	if client["id"] != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("relay inbound UUID = %v", client["id"])
	}

	// Outbound[0]: vless to landing.
	outs := m["outbounds"].([]any)
	o0 := outs[0].(map[string]any)
	if o0["protocol"] != "vless" || o0["tag"] != "to-landing" {
		t.Fatalf("outbound[0] = %v", o0)
	}
	vnext := o0["settings"].(map[string]any)["vnext"].([]any)[0].(map[string]any)
	if vnext["address"] != "edge.example.com" || vnext["port"].(float64) != 8443 {
		t.Fatalf("vnext addr/port: %v", vnext)
	}
	user := vnext["users"].([]any)[0].(map[string]any)
	if user["id"] != "ll-uuid" || user["flow"] != "xtls-rprx-vision" || user["encryption"] != "none" {
		t.Fatalf("vnext user: %v", user)
	}
	rs := o0["streamSettings"].(map[string]any)["realitySettings"].(map[string]any)
	if rs["serverName"] != "www.icloud.com" || rs["publicKey"] != "LPUB" || rs["shortId"] != "ll" {
		t.Fatalf("reality client fields: %v", rs)
	}
	if rs["fingerprint"] != "chrome" {
		t.Fatalf("expected fingerprint=chrome got %v", rs["fingerprint"])
	}

	// Outbound[1]: direct.
	o1 := outs[1].(map[string]any)
	if o1["protocol"] != "freedom" || o1["tag"] != "direct" {
		t.Fatalf("outbound[1] = %v", o1)
	}

	// Routing: private IPs go to direct.
	routing := m["routing"].(map[string]any)
	rules := routing["rules"].([]any)
	r0 := rules[0].(map[string]any)
	if r0["outboundTag"] != "direct" {
		t.Fatalf("private routing rule = %v", r0)
	}
}

func TestRenderTemplate_VLESSReality_Landing_UnchangedShape(t *testing.T) {
	// Without Topology (or with role=landing), output must match Task 0 shape:
	// no routing block, freedom outbound has UseIP.
	out, _ := RenderTemplate(TemplateRequest{
		Inbound: "vless-reality",
		Port: 443, UUID: "u", SNI: "s", PublicKey: "p", PrivateKey: "k", ShortID: "00",
	})
	var m map[string]any
	_ = json.Unmarshal(out, &m)
	if _, has := m["routing"]; has {
		t.Fatalf("landing config must not have routing block")
	}
	o0 := m["outbounds"].([]any)[0].(map[string]any)
	if o0["protocol"] != "freedom" {
		t.Fatalf("landing outbound must be freedom, got %v", o0["protocol"])
	}
}
```

- [ ] **Step 2: Run tests to verify failure**

```
go test -run TestRenderTemplate_VLESSReality ./internal/plugins/xray/...
```

Expected: FAIL — `TopologyRef` / `LandingRef` don't exist on `TemplateRequest`.

- [ ] **Step 3: Extend types + branch on role in `config.go`**

Edit `internal/plugins/xray/config.go`. Add types near the existing `TemplateRequest`:

```go
type TopologyRef struct {
	Role    string      `json:"role"`    // "landing" | "relay"
	Landing *LandingRef `json:"landing"` // non-nil iff Role=="relay"
}

type LandingRef struct {
	Address   string `json:"address"`
	Port      int    `json:"port"`
	SNI       string `json:"sni"`
	UUID      string `json:"uuid"`
	PublicKey string `json:"public_key"`
	ShortID   string `json:"short_id"`
}
```

Extend `TemplateRequest`:

```go
type TemplateRequest struct {
	Inbound    string `json:"inbound"`
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
	// Relay topology (vless-reality only). Nil or Role=="landing" → current behavior.
	Topology   *TopologyRef `json:"topology"`
}
```

Modify `renderVLESSReality(r TemplateRequest)`:

```go
func renderVLESSReality(r TemplateRequest) ([]byte, error) {
	if r.Port == 0 || r.UUID == "" || r.SNI == "" || r.PublicKey == "" {
		return nil, errors.New("vless-reality: port/uuid/sni/public_key required")
	}
	inbound := map[string]any{
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
				"show":        false,
				"dest":        r.SNI + ":443",
				"serverNames": []any{r.SNI},
				"privateKey":  r.PrivateKey,
				"publicKey":   r.PublicKey,
				"shortIds":    []any{r.ShortID},
			},
		},
		"sniffing": map[string]any{
			"enabled":      true,
			"destOverride": []any{"http", "tls"},
		},
	}

	cfg := map[string]any{
		"log":      map[string]any{"loglevel": "warning"},
		"inbounds": []any{inbound},
	}

	if r.Topology != nil && r.Topology.Role == "relay" {
		if r.Topology.Landing == nil {
			return nil, errors.New("vless-reality relay: topology.landing required")
		}
		l := r.Topology.Landing
		cfg["outbounds"] = []any{
			map[string]any{
				"tag":      "to-landing",
				"protocol": "vless",
				"settings": map[string]any{
					"vnext": []any{map[string]any{
						"address": l.Address,
						"port":    l.Port,
						"users": []any{map[string]any{
							"id":         l.UUID,
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
						"serverName":  l.SNI,
						"publicKey":   l.PublicKey,
						"shortId":     l.ShortID,
					},
				},
			},
			map[string]any{
				"tag":      "direct",
				"protocol": "freedom",
				"settings": map[string]any{"domainStrategy": "UseIP"},
			},
		}
		cfg["routing"] = map[string]any{
			"rules": []any{
				map[string]any{"type": "field", "ip": []any{"geoip:private"}, "outboundTag": "direct"},
			},
		}
	} else {
		// landing (or unspecified) — current behavior.
		cfg["outbounds"] = []any{map[string]any{
			"protocol": "freedom",
			"settings": map[string]any{"domainStrategy": "UseIP"},
		}}
	}

	return json.MarshalIndent(cfg, "", "  ")
}
```

- [ ] **Step 4: Run tests**

```
go test ./internal/plugins/xray/...
```

Expected: PASS for both new tests and all pre-existing ones (the landing path is unchanged).

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/xray/config.go internal/plugins/xray/config_test.go
git commit -m "feat(plugins/xray): relay outbound rendering in RenderVLESSReality"
```

---

## Task 4: Generic API hooks — three optional plugin interfaces

**Files:**
- Modify: `internal/plugins/plugin.go`
- Modify: `internal/api/plugins.go`
- Modify: `internal/api/plugins_test.go`

- [ ] **Step 1: Write the failing test**

The file already has `setupPluginsAPI(t)` (registers `plainP{id:"a"}` + `hostP{plainP:plainP{id:"b"}}` and opens a sqlite). Our tests need a *different* registered plugin (validatorP) so we inline a custom setup that mirrors the helper's pattern.

Append to `internal/api/plugins_test.go`:

```go
type validatorP struct {
	plainP
	beforeDeployErr      error
	beforeUndeployErr    error
	beforeDeployTopology string
	afterDeployTopology  string
	beforeUndeployCalled bool
}

func (v *validatorP) Meta() plugins.Meta { return plugins.Meta{ID: "v", Name: "V", HostAware: true} }
func (v *validatorP) DeployToHost(context.Context, plugins.Deps, int64, string, []byte) error { return nil }
func (v *validatorP) UndeployFromHost(context.Context, plugins.Deps, int64) error              { return nil }
func (v *validatorP) HostStatus(context.Context, plugins.Deps, int64) (plugins.HostStatus, error) {
	return plugins.HostStatus{}, nil
}
func (v *validatorP) BeforeDeploy(_ context.Context, _ plugins.Deps, _ int64, topology []byte) error {
	v.beforeDeployTopology = string(topology); return v.beforeDeployErr
}
func (v *validatorP) AfterDeploy(_ context.Context, _ plugins.Deps, _ int64, topology []byte) error {
	v.afterDeployTopology = string(topology); return nil
}
func (v *validatorP) BeforeUndeploy(_ context.Context, _ plugins.Deps, _ int64) error {
	v.beforeUndeployCalled = true; return v.beforeUndeployErr
}

// setupValidatorAPI returns a PluginsAPI with plugin "v" registered & enabled.
func setupValidatorAPI(t *testing.T, v *validatorP) *PluginsAPI {
	t.Helper()
	plugins.ResetRegistryForTestPublic()
	plugins.Register(v)
	dsn := "file:" + filepath.Join(t.TempDir(), "vapi.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil { t.Fatal(err) }
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil { t.Fatal(err) }
	store := &plugins.Store{DB: d, Now: time.Now}
	_ = store.UpsertEnabled(context.Background(), "v", true) // bypass /enable
	return &PluginsAPI{Store: store, Deps: plugins.Deps{DB: d}}
}

func TestPostHost_BeforeDeployRejectionReturns409(t *testing.T) {
	v := &validatorP{beforeDeployErr: errors.New("role mismatch on re-deploy")}
	api := setupValidatorAPI(t, v)
	body := `{"server_id":7,"topology":{"role":"relay"}}`
	req := httptest.NewRequest("POST", "/api/admin/plugins/v/hosts", strings.NewReader(body))
	req.SetPathValue("id", "v")
	w := httptest.NewRecorder()
	api.PostHost(w, req)
	if w.Code != 409 { t.Fatalf("status = %d want 409 (body: %s)", w.Code, w.Body.String()) }
	if v.beforeDeployTopology != `{"role":"relay"}` {
		t.Fatalf("BeforeDeploy got topology %q", v.beforeDeployTopology)
	}
}

func TestDeleteHost_BeforeUndeployRejectionReturns409(t *testing.T) {
	v := &validatorP{beforeUndeployErr: errors.New("landing has 2 relays")}
	api := setupValidatorAPI(t, v)
	req := httptest.NewRequest("DELETE", "/api/admin/plugins/v/hosts/5", nil)
	req.SetPathValue("id", "v"); req.SetPathValue("server_id", "5")
	w := httptest.NewRecorder()
	api.DeleteHost(w, req)
	if w.Code != 409 { t.Fatalf("status = %d want 409", w.Code) }
	if !v.beforeUndeployCalled { t.Fatalf("BeforeUndeploy not called") }
}
```

Imports needed (add if missing): `"errors"`, `"strings"`, `"path/filepath"`, `"time"`, `shepdb "github.com/hg-claw/Shepherd/internal/db"`.

- [ ] **Step 2: Run test to verify failure**

```
go test -run 'TestPostHost_BeforeDeployRejectionReturns409|TestDeleteHost_BeforeUndeployRejectionReturns409' ./internal/api/...
```

Expected: FAIL — interfaces don't exist; generic API doesn't call them.

- [ ] **Step 3: Add the three interfaces**

Append to `internal/plugins/plugin.go`:

```go
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
```

- [ ] **Step 4: Wire hooks into generic API**

Edit `internal/api/plugins.go`. Add `Topology` to `hostBody`:

```go
type hostBody struct {
	ServerID int64           `json:"server_id"`
	Version  string          `json:"version"`
	Config   json.RawMessage `json:"config"`
	Topology json.RawMessage `json:"topology"`
}
```

Modify `PostHost`:

```go
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

	// Sync pre-flight validation (plugin-specific).
	if v, ok := p.(plugins.DeployValidator); ok {
		if err := v.BeforeDeploy(r.Context(), a.Deps, body.ServerID, []byte(body.Topology)); err != nil {
			writeError(w, 409, err.Error())
			return
		}
	}

	host, err := a.Store.UpsertHost(r.Context(), id, body.ServerID, cfg, "deploying")
	if err != nil { writeError(w, 500, err.Error()); return }

	go func() {
		ctx := context.Background()
		if err := ha.DeployToHost(ctx, a.Deps, body.ServerID, body.Version, cfg); err != nil {
			_ = a.Store.SetHostStatus(ctx, id, body.ServerID, "failed", body.Version, err.Error())
			return
		}
		if c, ok := p.(plugins.DeployCommitter); ok {
			if err := c.AfterDeploy(ctx, a.Deps, body.ServerID, []byte(body.Topology)); err != nil {
				_ = a.Store.SetHostStatus(ctx, id, body.ServerID, "failed", body.Version,
					"deploy ok but topology persist failed: "+err.Error())
				return
			}
		}
		_ = a.Store.SetHostStatus(ctx, id, body.ServerID, "running", body.Version, "")
	}()
	writeJSON(w, 200, hostRowToMap(host))
}
```

Modify `DeleteHost`:

```go
func (a *PluginsAPI) DeleteHost(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sid, _ := strconv.ParseInt(r.PathValue("server_id"), 10, 64)
	p, ok := plugins.Get(id)
	if !ok { writeError(w, 404, "unknown plugin"); return }
	if v, ok := p.(plugins.UndeployValidator); ok {
		if err := v.BeforeUndeploy(r.Context(), a.Deps, sid); err != nil {
			writeError(w, 409, err.Error())
			return
		}
	}
	if ha, ok := p.(plugins.HostAware); ok {
		_ = ha.UndeployFromHost(r.Context(), a.Deps, sid)
	}
	if err := a.Store.DeleteHost(r.Context(), id, sid); err != nil {
		writeError(w, 500, err.Error()); return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}
```

- [ ] **Step 5: Run tests to verify pass**

```
go test ./internal/api/... ./internal/plugins/...
```

Expected: PASS for the two new tests; existing tests still green (the new validator interfaces are opt-in via type assertion; plugins that don't implement them get the existing behavior).

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/plugin.go internal/api/plugins.go internal/api/plugins_test.go
git commit -m "feat(plugins): Deploy/Undeploy validator hooks; generic API maps to 409"
```

---

## Task 5: xray plugin implements the three validators

**Files:**
- Modify: `internal/plugins/xray/xray.go`
- Modify: `internal/plugins/xray/xray_test.go`

- [ ] **Step 1: Write failing tests for xray's validator behavior**

Append to `internal/plugins/xray/xray_test.go`:

```go
func TestXrayBeforeDeploy_FirstTimeLanding(t *testing.T) {
	s := newTopoStore(t)  // helper from topology_test.go
	p := &Plugin{}
	// First deploy as landing — should be accepted (no row yet).
	err := p.BeforeDeploy(context.Background(), plugins.Deps{DB: s.DB}, 1,
		[]byte(`{"role":"landing"}`))
	if err != nil { t.Fatalf("first landing deploy rejected: %v", err) }
}

func TestXrayBeforeDeploy_FirstTimeRelay_NeedsUpstream(t *testing.T) {
	s := newTopoStore(t)
	p := &Plugin{}
	// Relay without upstream → reject.
	err := p.BeforeDeploy(context.Background(), plugins.Deps{DB: s.DB}, 2,
		[]byte(`{"role":"relay"}`))
	if err == nil || !strings.Contains(err.Error(), "upstream") {
		t.Fatalf("got %v, want upstream-required error", err)
	}
}

func TestXrayBeforeDeploy_RelayUpstreamMustBeLanding(t *testing.T) {
	s := newTopoStore(t)
	_ = s.UpsertLanding(context.Background(), 1)
	_ = s.UpsertRelay(context.Background(), 2, 1)
	p := &Plugin{}
	// Trying to point relay at another relay (server 2) → reject.
	err := p.BeforeDeploy(context.Background(), plugins.Deps{DB: s.DB}, 3,
		[]byte(`{"role":"relay","upstream_server_id":2}`))
	if err == nil || !strings.Contains(err.Error(), "landing") {
		t.Fatalf("got %v, want upstream-must-be-landing error", err)
	}
}

func TestXrayBeforeDeploy_RoleLockOnRedeploy(t *testing.T) {
	s := newTopoStore(t)
	_ = s.UpsertLanding(context.Background(), 1)
	p := &Plugin{}
	// Re-deploy server 1 with role=relay → reject.
	err := p.BeforeDeploy(context.Background(), plugins.Deps{DB: s.DB}, 1,
		[]byte(`{"role":"relay","upstream_server_id":1}`))
	if err == nil || !strings.Contains(err.Error(), "role") {
		t.Fatalf("got %v, want role-lock error", err)
	}
}

func TestXrayAfterDeploy_PersistsTopology(t *testing.T) {
	s := newTopoStore(t)
	_ = s.UpsertLanding(context.Background(), 1)
	p := &Plugin{}
	if err := p.AfterDeploy(context.Background(), plugins.Deps{DB: s.DB}, 2,
		[]byte(`{"role":"relay","upstream_server_id":1}`)); err != nil {
		t.Fatal(err)
	}
	row, _ := s.Get(context.Background(), 2)
	if row.Role != "relay" || row.UpstreamServerID.Int64 != 1 {
		t.Fatalf("topology row = %+v", row)
	}
}

func TestXrayBeforeUndeploy_BlocksLandingWithRelays(t *testing.T) {
	s := newTopoStore(t)
	_ = s.UpsertLanding(context.Background(), 1)
	_ = s.UpsertRelay(context.Background(), 2, 1)
	p := &Plugin{}
	err := p.BeforeUndeploy(context.Background(), plugins.Deps{DB: s.DB}, 1)
	if err == nil || !strings.Contains(err.Error(), "relay") {
		t.Fatalf("got %v, want depending-relays error", err)
	}
}
```

Add `"strings"` import if not present.

- [ ] **Step 2: Run tests to verify failure**

```
go test -run TestXrayBeforeDeploy ./internal/plugins/xray/...
go test -run TestXrayAfterDeploy ./internal/plugins/xray/...
go test -run TestXrayBeforeUndeploy ./internal/plugins/xray/...
```

Expected: FAIL — methods don't exist on `*Plugin`.

- [ ] **Step 3: Implement the validators in xray.go**

Append to `internal/plugins/xray/xray.go`:

```go
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
```

Add imports: `"encoding/json"`, `"strings"` (some may already be there).

Also update `UndeployFromHost` to clean up the topology row after stopping:

```go
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
```

- [ ] **Step 4: Run tests to verify pass**

```
go test ./internal/plugins/xray/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/xray/xray.go internal/plugins/xray/xray_test.go
git commit -m "feat(plugins/xray): topology validators (role lock, upstream-must-be-landing, undeploy-block)"
```

---

## Task 6: xray expose topology via `GET /api/admin/plugins/xray/topology`

**Files:**
- Modify: `internal/plugins/xray/routes.go`
- Modify: `internal/plugins/xray/routes_test.go`

- [ ] **Step 1: Write the failing test**

`routes.go` registers handlers as closures inside `(p *Plugin) RegisterRoutes(mux plugins.Mux, deps plugins.Deps)`. Test calls a small extracted handler function so we can unit-test without a full mux.

Append to `internal/plugins/xray/routes_test.go`:

```go
func TestTopologyHandler_ReturnsRowsWithUpstreamName(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "r.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations())
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_password,ssh_port,created_at,updated_at)
		VALUES (1,'landing-a','1.1.1.1','r','x',22,?,?), (2,'relay-b','2.2.2.2','r','x',22,?,?)`,
		time.Now(), time.Now(), time.Now(), time.Now())
	store := &TopologyStore{DB: d, Now: time.Now}
	_ = store.UpsertLanding(context.Background(), 1)
	_ = store.UpsertRelay(context.Background(), 2, 1)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/topology", nil)
	topologyHandler(d)(w, req)   // exported handler factory used by RegisterRoutes
	if w.Code != 200 { t.Fatalf("status = %d body=%s", w.Code, w.Body.String()) }

	var out map[string]struct {
		Role             string  `json:"role"`
		UpstreamServerID *int64  `json:"upstream_server_id"`
		UpstreamName     *string `json:"upstream_name"`
	}
	if err := json.NewDecoder(w.Body).Decode(&out); err != nil { t.Fatal(err) }
	if out["1"].Role != "landing" { t.Fatalf("server 1: %+v", out["1"]) }
	if out["2"].Role != "relay" || out["2"].UpstreamServerID == nil || *out["2"].UpstreamServerID != 1 {
		t.Fatalf("server 2: %+v", out["2"])
	}
	if out["2"].UpstreamName == nil || *out["2"].UpstreamName != "landing-a" {
		t.Fatalf("server 2 upstream_name: %v", out["2"].UpstreamName)
	}
}
```

- [ ] **Step 2: Run test to verify failure**

```
go test -run TestTopologyRoute ./internal/plugins/xray/...
```

Expected: FAIL — `Topology` method doesn't exist.

- [ ] **Step 3: Add the handler factory + register it**

Append to `internal/plugins/xray/routes.go` (alongside existing helpers):

```go
// topologyHandler returns an http.HandlerFunc that emits a map keyed by
// server_id (string, JSON-friendly) of every xray host's role + upstream
// metadata. UI fetches this in parallel with the generic /hosts list.
func topologyHandler(db *sqlx.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		store := &TopologyStore{DB: db}
		rows, err := store.ListWithUpstreamName(req.Context())
		if err != nil { http.Error(w, err.Error(), 500); return }
		out := map[string]map[string]any{}
		for _, t := range rows {
			entry := map[string]any{"role": t.Role}
			if t.UpstreamServerID.Valid {
				entry["upstream_server_id"] = t.UpstreamServerID.Int64
			} else {
				entry["upstream_server_id"] = nil
			}
			if t.UpstreamName.Valid {
				entry["upstream_name"] = t.UpstreamName.String
			} else {
				entry["upstream_name"] = nil
			}
			out[fmt.Sprint(t.ServerID)] = entry
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	}
}
```

Inside `(p *Plugin) RegisterRoutes`, add (alongside the existing `/versions`, `/keys/x25519`, `/keys/short-id`):

```go
mux.HandleFunc("GET /topology", topologyHandler(deps.DB))
```

The mux is mounted under `/api/admin/plugins/xray/` by the generic dispatcher, so the actual URL is `GET /api/admin/plugins/xray/topology`.

Imports: `"fmt"`, `"net/http"`, `"github.com/jmoiron/sqlx"` should already be present; if not add them.

- [ ] **Step 4: Run test to verify pass**

```
go test ./internal/plugins/xray/...
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/xray/routes.go internal/plugins/xray/routes_test.go
git commit -m "feat(plugins/xray): GET /topology returns role+upstream map joined to servers.name"
```

---

## Task 7: Web API client — topology fetcher + deploy body extension

**Files:**
- Modify: `web/src/api/plugins.ts`

- [ ] **Step 1: Add types and fetcher**

Append to `web/src/api/plugins.ts`:

```ts
export interface XrayTopologyRow {
  role: 'landing' | 'relay'
  upstream_server_id: number | null
  upstream_name: string | null
}

// Map keyed by server_id (string in JSON, number for callers).
// Servers without an xray deployment are simply absent.
export const fetchXrayTopology = async (): Promise<Map<number, XrayTopologyRow>> => {
  const raw = await api.get<Record<string, XrayTopologyRow>>('/api/admin/plugins/xray/topology')
  const out = new Map<number, XrayTopologyRow>()
  for (const [k, v] of Object.entries(raw)) out.set(Number(k), v)
  return out
}
```

Extend `deployPluginHost` body type to include topology:

```ts
export const deployPluginHost = (id: string, body: {
  server_id: number
  version?: string
  config?: unknown
  topology?: { role: 'landing' | 'relay'; upstream_server_id?: number }
}) => api.post<PluginHost>(`/api/admin/plugins/${id}/hosts`, body)
```

- [ ] **Step 2: Commit (no test needed — type-only change)**

```bash
git add web/src/api/plugins.ts
git commit -m "feat(web/api): fetchXrayTopology + deployPluginHost.topology field"
```

---

## Task 8: `templates.ts` — relay render + parse + types

**Files:**
- Modify: `web/src/pages/admin/plugins/xray/templates.ts`
- Modify: `web/src/pages/admin/plugins/xray/templates.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `web/src/pages/admin/plugins/xray/templates.test.ts`:

```ts
describe('renderTemplate relay', () => {
  it('emits vless-to-landing outbound + direct fallback + private-IP routing', () => {
    const cfg = renderTemplate({
      inbound: 'vless-reality', port: 443,
      uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sni: 'www.icloud.com', publicKey: 'RPUB', privateKey: 'RPRIV', shortID: 'ee',
      role: 'relay',
      landing: {
        address: '1.2.3.4', port: 8443, sni: 'www.icloud.com',
        uuid: 'lll', publicKey: 'LPUB', shortID: 'll',
      },
    }) as any
    expect(cfg.outbounds[0].protocol).toBe('vless')
    expect(cfg.outbounds[0].settings.vnext[0].address).toBe('1.2.3.4')
    expect(cfg.outbounds[0].settings.vnext[0].users[0].id).toBe('lll')
    expect(cfg.outbounds[0].streamSettings.realitySettings.publicKey).toBe('LPUB')
    expect(cfg.outbounds[1].protocol).toBe('freedom')
    expect(cfg.routing.rules[0].outboundTag).toBe('direct')
  })

  it('parseConfig recognizes relay shape', () => {
    const cfg = renderTemplate({
      inbound: 'vless-reality', port: 443, uuid: 'u',
      sni: 's', publicKey: 'P', privateKey: 'K', shortID: 'sid',
      role: 'relay',
      landing: { address: '1.2.3.4', port: 8443, sni: 'X', uuid: 'L', publicKey: 'LP', shortID: 'ls' },
    })
    const parsed = parseConfig(cfg)
    expect(parsed.role).toBe('relay')
    expect(parsed.landing?.address).toBe('1.2.3.4')
    expect(parsed.landing?.uuid).toBe('L')
    expect(parsed.landing?.publicKey).toBe('LP')
  })

  it('parseConfig recognizes landing shape (no role field) as landing', () => {
    const cfg = renderTemplate({
      inbound: 'vless-reality', port: 443, uuid: 'u',
      sni: 's', publicKey: 'P', privateKey: 'K', shortID: 'sid',
    })
    const parsed = parseConfig(cfg)
    expect(parsed.role ?? 'landing').toBe('landing')
    expect(parsed.landing).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify failure**

```
cd web && npx vitest run src/pages/admin/plugins/xray/templates.test.ts
```

Expected: FAIL — `role` / `landing` are not on `TemplateValues`; relay branch missing in `renderTemplate`.

- [ ] **Step 3: Extend types + add relay renderer + parse**

Edit `web/src/pages/admin/plugins/xray/templates.ts`. Add `LandingRef` and extend `TemplateValues`:

```ts
export interface LandingRef {
  address: string
  port: number
  sni: string
  uuid: string
  publicKey: string
  shortID: string
}

export interface TemplateValues {
  inbound: Inbound
  port: number
  uuid?: string
  // VLESS+REALITY
  sni?: string
  publicKey?: string
  privateKey?: string
  shortID?: string
  // VMess+WS
  wsPath?: string
  // Relay topology (vless-reality only)
  role?: 'landing' | 'relay'
  landing?: LandingRef
}
```

Update `renderTemplate` and `vlessReality`:

```ts
export function renderTemplate(v: TemplateValues): Record<string, unknown> {
  switch (v.inbound) {
    case 'vless-reality': return vlessReality(v)
    case 'vmess-ws':      return vmessWS(v)
  }
}

function vlessReality(v: TemplateValues) {
  const inbound = {
    port: v.port,
    protocol: 'vless',
    settings: {
      clients: [{ id: v.uuid, flow: 'xtls-rprx-vision' }],
      decryption: 'none',
    },
    streamSettings: {
      network: 'tcp',
      security: 'reality',
      realitySettings: {
        show: false,
        dest: `${v.sni}:443`,
        serverNames: [v.sni],
        privateKey: v.privateKey,
        publicKey: v.publicKey,
        shortIds: [v.shortID ?? ''],
      },
    },
    sniffing: { enabled: true, destOverride: ['http', 'tls'] },
  }

  if (v.role === 'relay' && v.landing) {
    const l = v.landing
    return {
      log: { loglevel: 'warning' },
      inbounds: [inbound],
      outbounds: [
        {
          tag: 'to-landing',
          protocol: 'vless',
          settings: {
            vnext: [{
              address: l.address,
              port: l.port,
              users: [{ id: l.uuid, encryption: 'none', flow: 'xtls-rprx-vision' }],
            }],
          },
          streamSettings: {
            network: 'tcp',
            security: 'reality',
            realitySettings: {
              fingerprint: 'chrome',
              serverName: l.sni,
              publicKey: l.publicKey,
              shortId: l.shortID,
            },
          },
        },
        { tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'UseIP' } },
      ],
      routing: {
        rules: [{ type: 'field', ip: ['geoip:private'], outboundTag: 'direct' }],
      },
    }
  }

  return {
    log: { loglevel: 'warning' },
    inbounds: [inbound],
    outbounds: [{ protocol: 'freedom', settings: { domainStrategy: 'UseIP' } }],
  }
}
```

Extend `ParsedTemplate` and `parseConfig`:

```ts
export interface ParsedTemplate extends Partial<TemplateValues> {
  inbound?: Inbound
}

export function parseConfig(cfg: unknown): ParsedTemplate {
  if (!cfg || typeof cfg !== 'object') return {}
  const inbounds = (cfg as any).inbounds
  if (!Array.isArray(inbounds) || inbounds.length === 0) return {}
  const ib = inbounds[0] as any
  const proto = String(ib?.protocol ?? '')
  const ss = ib?.streamSettings ?? {}
  const security = String(ss?.security ?? '')
  const port = typeof ib?.port === 'number' ? ib.port : undefined

  if (proto === 'vless' && security === 'reality') {
    const rs = ss.realitySettings ?? {}
    const client = ib?.settings?.clients?.[0] ?? {}
    const base: ParsedTemplate = {
      inbound: 'vless-reality',
      port,
      uuid: typeof client.id === 'string' ? client.id : undefined,
      sni: Array.isArray(rs.serverNames) && rs.serverNames[0] ? String(rs.serverNames[0]) : undefined,
      publicKey: typeof rs.publicKey === 'string' ? rs.publicKey : undefined,
      privateKey: typeof rs.privateKey === 'string' ? rs.privateKey : undefined,
      shortID: Array.isArray(rs.shortIds) && rs.shortIds[0] != null ? String(rs.shortIds[0]) : undefined,
    }
    // Detect relay shape by outbound[0] being vless+reality.
    const outs = (cfg as any).outbounds
    const o0 = Array.isArray(outs) ? outs[0] : null
    if (o0?.protocol === 'vless' && o0?.streamSettings?.security === 'reality') {
      const vnext = o0?.settings?.vnext?.[0]
      const user  = vnext?.users?.[0]
      const ors   = o0?.streamSettings?.realitySettings ?? {}
      base.role = 'relay'
      base.landing = {
        address:   String(vnext?.address ?? ''),
        port:      typeof vnext?.port === 'number' ? vnext.port : 0,
        sni:       String(ors?.serverName ?? ''),
        uuid:      String(user?.id ?? ''),
        publicKey: String(ors?.publicKey ?? ''),
        shortID:   String(ors?.shortId ?? ''),
      }
    } else {
      base.role = 'landing'
    }
    return base
  }
  if (proto === 'vmess' && ss.network === 'ws') {
    const client = ib?.settings?.clients?.[0] ?? {}
    const wsPath = ss?.wsSettings?.path
    return {
      inbound: 'vmess-ws',
      port,
      uuid: typeof client.id === 'string' ? client.id : undefined,
      wsPath: typeof wsPath === 'string' ? wsPath : undefined,
    }
  }
  return {}
}
```

- [ ] **Step 4: Run tests to verify pass**

```
cd web && npx vitest run src/pages/admin/plugins/xray/templates.test.ts
```

Expected: PASS for new + existing tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/plugins/xray/templates.ts web/src/pages/admin/plugins/xray/templates.test.ts
git commit -m "feat(web/xray): templates render + parse relay topology"
```

---

## Task 9: DeployDialog — Role + Upstream + lock

**Files:**
- Modify: `web/src/pages/admin/plugins/xray/DeployDialog.tsx`

- [ ] **Step 1: Read the current DeployDialog**

```
sed -n '40,75p' web/src/pages/admin/plugins/xray/DeployDialog.tsx
```

Confirm: form state is lazy-initialized from `existing`. We will add `role` and `upstreamServerID` state.

- [ ] **Step 2: Add state + selector + render**

Modify imports (top of file) — add `fetchXrayTopology` and `XrayTopologyRow`:

```ts
import {
  deployPluginHost,
  fetchXrayVersions,
  generateX25519,
  generateShortID,
  getPluginConfig,
  fetchXrayTopology,
  listPluginHosts,
  type XrayTopologyRow,
} from '@/api/plugins'
import { renderTemplate, parseConfig, randomPort, randomUUID, type Inbound, type LandingRef } from './templates'
```

Inside the component, after the existing queries, add a topology query and a landings list:

```ts
const topoQ = useQuery({
  queryKey: ['xray-topology'],
  queryFn: fetchXrayTopology,
  enabled: open,
})
const hostsQ = useQuery({
  queryKey: ['plugin-hosts', 'xray'],
  queryFn: () => listPluginHosts('xray'),
  enabled: open,
})

// Lazy-init `role` and `upstreamServerID` alongside other form state.
// (Insert next to the other useState calls.)
const [role, setRole] = useState<'landing' | 'relay'>(parsed.role ?? 'landing')
const [upstreamServerID, setUpstreamServerID] = useState<number | ''>(
  parsed.landing && existing
    ? (topoQ.data?.get(existing.server_id ?? -1)?.upstream_server_id ?? '')
    : ''
)
// Note: when re-deploying a relay, prefer the topology row's upstream_server_id
// (DB source of truth) over what parseConfig might read from the rendered config.
// Refine after topoQ resolves:
useEffect(() => {
  if (!existing || !topoQ.data) return
  const t = topoQ.data.get(existing.server_id)
  if (t?.upstream_server_id != null) setUpstreamServerID(t.upstream_server_id)
  if (t?.role) setRole(t.role)
}, [existing, topoQ.data])
```

Compute available upstreams (landings that are not the current server):

```ts
const landings: Array<{ id: number; name: string; landing: LandingRef | null }> = []
if (topoQ.data && hostsQ.data) {
  const serversByID = new Map((serversQ.data ?? []).map((s) => [s.id, s]))
  for (const h of hostsQ.data) {
    const t = topoQ.data.get(h.server_id)
    if (t?.role !== 'landing') continue
    if (existing && h.server_id === existing.server_id) continue   // can't pick self
    if (!existing && h.server_id === serverID) continue            // can't pick self mid-create
    const s = serversByID.get(h.server_id)
    if (!s || !s.ssh_host?.Valid) continue
    const p = parseConfig(h.config)
    if (!p.uuid || !p.publicKey || !p.sni || !p.port) continue
    landings.push({
      id: h.server_id,
      name: s.name,
      landing: {
        address: s.ssh_host.String,
        port: p.port,
        sni: p.sni,
        uuid: p.uuid,
        publicKey: p.publicKey,
        shortID: p.shortID ?? '',
      },
    })
  }
}
const selectedLanding = landings.find((l) => l.id === upstreamServerID) ?? null
```

Update the `mutationFn` to render with topology and POST topology:

```ts
const m = useMutation({
  mutationFn: async () => {
    if (!serverID) throw new Error('select a server')
    if (role === 'relay' && (!upstreamServerID || !selectedLanding?.landing)) {
      throw new Error('relay needs an upstream landing')
    }
    const config = renderTemplate({
      inbound, port, uuid,
      sni, publicKey, privateKey, shortID,
      wsPath,
      role,
      landing: role === 'relay' ? selectedLanding!.landing! : undefined,
    })
    const topology = role === 'relay'
      ? { role: 'relay' as const, upstream_server_id: Number(upstreamServerID) }
      : { role: 'landing' as const }
    return deployPluginHost('xray', { server_id: Number(serverID), version, config, topology })
  },
  onSuccess: () => {
    qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
    qc.invalidateQueries({ queryKey: ['xray-topology'] })
    onOpenChange(false)
  },
  onError: (e: any) => setError(String(e?.message ?? e)),
})
```

Add UI controls in the dialog body, immediately after Target server, before Version/Inbound. Role is locked in re-deploy mode:

```tsx
<div className="grid grid-cols-2 gap-3">
  <div>
    <Label className="text-[12px]">Role</Label>
    <select
      value={role}
      onChange={(e) => setRole(e.target.value as 'landing' | 'relay')}
      disabled={!!existing}
      title={existing ? 'role is locked on re-deploy; undeploy first to change' : undefined}
      className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full disabled:opacity-60"
    >
      <option value="landing">Landing</option>
      <option value="relay">Relay → upstream landing</option>
    </select>
  </div>
  {role === 'relay' && (
    <div>
      <Label className="text-[12px]">Upstream landing</Label>
      <select
        value={upstreamServerID}
        onChange={(e) => setUpstreamServerID(Number(e.target.value) || '')}
        disabled={!!existing}
        title={existing ? 'upstream is locked on re-deploy; undeploy first to change' : undefined}
        className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full disabled:opacity-60"
      >
        <option value="">— select —</option>
        {landings.map((l) => (
          <option key={l.id} value={l.id}>{l.name}</option>
        ))}
      </select>
      {landings.length === 0 && (
        <p className="text-err text-[11.5px] mt-1">
          No landing available. Deploy a landing first.
        </p>
      )}
    </div>
  )}
</div>
```

- [ ] **Step 3: Build to verify**

```
cd web && npm run build
```

Expected: build succeeds. (No new unit test for the dialog; covered indirectly by templates tests + Task 13 smoke.)

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/admin/plugins/xray/DeployDialog.tsx
git commit -m "feat(web/xray): DeployDialog Role + Upstream landing fields, locked on re-deploy"
```

---

## Task 10: HostsTab — Role column + Undeploy guard

**Files:**
- Modify: `web/src/pages/admin/plugins/xray/HostsTab.tsx`

- [ ] **Step 1: Add topology query + Role column**

Top imports — extend:

```ts
import { listPluginHosts, removePluginHost, fetchXrayTopology, type PluginHost, type XrayTopologyRow } from '@/api/plugins'
```

In the component, alongside `hostsQ`:

```ts
const topoQ = useQuery({
  queryKey: ['xray-topology'],
  queryFn: fetchXrayTopology,
  refetchInterval: 10_000,
})
const topo: Map<number, XrayTopologyRow> = topoQ.data ?? new Map()

// Count how many relays depend on each landing for the undeploy guard.
const relayCountByUpstream = new Map<number, number>()
for (const v of topo.values()) {
  if (v.role === 'relay' && v.upstream_server_id != null) {
    relayCountByUpstream.set(v.upstream_server_id, (relayCountByUpstream.get(v.upstream_server_id) ?? 0) + 1)
  }
}
```

Add a header `<th>Role</th>` between Server and Protocol:

```tsx
<th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Role</th>
```

And inside each row, render a Role pill after the Server cell:

```tsx
<td className="px-3 py-2 text-[12.5px]">
  {(() => {
    const t = topo.get(s.id)
    if (!t) return <span className="text-muted-foreground">—</span>
    if (t.role === 'landing') return <Pill kind="neutral">landing</Pill>
    return (
      <span className="font-mono">
        <Pill kind="ok">relay</Pill>
        <span className="text-fg-dim ml-1">→ {t.upstream_name ?? `#${t.upstream_server_id}`}</span>
      </span>
    )
  })()}
</td>
```

Guard the Undeploy button:

```tsx
{(() => {
  const dependents = relayCountByUpstream.get(s.id) ?? 0
  const disabled = undeploy.isPending || dependents > 0
  const title = dependents > 0
    ? `${dependents} relay(s) depend on this landing; undeploy them first`
    : undefined
  return (
    <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px] text-destructive"
      onClick={() => undeploy.mutate(s.id)}
      disabled={disabled}
      title={title}>
      Undeploy
    </Button>
  )
})()}
```

Update the colspan of the "No managed servers." row to `7`:

```tsx
<tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground text-[13px]">
  No managed servers.
</td></tr>
```

- [ ] **Step 2: Verify build + existing tests still green**

```
cd web && npm run build && npx vitest run src/pages/admin/plugins/xray/
```

Expected: build succeeds; xray test files still pass (their HostsTab tests if present pass too).

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/admin/plugins/xray/HostsTab.tsx
git commit -m "feat(web/xray): HostsTab role column + undeploy guard when landing has relays"
```

---

## Task 11: BulkRelayDialog component

**Files:**
- Create: `web/src/pages/admin/plugins/xray/BulkRelayDialog.tsx`
- Create: `web/src/pages/admin/plugins/xray/BulkRelayDialog.test.tsx`

- [ ] **Step 1: Write the failing test**

`web/src/pages/admin/plugins/xray/BulkRelayDialog.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import BulkRelayDialog from './BulkRelayDialog'
import * as pluginsAPI from '@/api/plugins'
import * as serversAPI from '@/api/servers'

vi.mock('@/api/plugins', async () => {
  const actual = await vi.importActual<typeof pluginsAPI>('@/api/plugins')
  return {
    ...actual,
    deployPluginHost: vi.fn().mockResolvedValue({}),
    fetchXrayVersions: vi.fn().mockResolvedValue({ latest: ['1.8.11'], cached: [] }),
  }
})
vi.mock('@/api/servers', () => ({
  useServers: () => ({ data: [
    { id: 10, name: 'tokyo-1',  ssh_host: { Valid: true, String: '10.0.0.1' } },
    { id: 11, name: 'osaka-1',  ssh_host: { Valid: true, String: '10.0.0.2' } },
  ] }),
}))

const landing = {
  id: 1,
  server_id: 1,
  config: {
    inbounds: [{
      port: 8443, protocol: 'vless',
      settings: { clients: [{ id: 'lll', flow: 'xtls-rprx-vision' }], decryption: 'none' },
      streamSettings: {
        network: 'tcp', security: 'reality',
        realitySettings: { serverNames: ['www.icloud.com'], publicKey: 'LPUB', shortIds: ['ll'] },
      },
    }],
  },
  deployed_version: '1.8.11',
  status: 'running' as const,
  last_error: null,
  updated_at: '',
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe('BulkRelayDialog', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists target servers and calls deployPluginHost once per selected target', async () => {
    wrap(
      <BulkRelayDialog
        open={true}
        onOpenChange={() => {}}
        landing={landing}
        landingServerHost="1.2.3.4"
        landingServerName="us-1"
        existingXrayServerIDs={new Set([1])}
      />
    )

    // Pick both targets.
    fireEvent.click(await screen.findByLabelText(/tokyo-1/))
    fireEvent.click(screen.getByLabelText(/osaka-1/))

    fireEvent.click(screen.getByRole('button', { name: /deploy all/i }))

    await waitFor(() => {
      expect(pluginsAPI.deployPluginHost).toHaveBeenCalledTimes(2)
    })
    // First call: tokyo-1, role=relay, upstream=1.
    const firstCall = (pluginsAPI.deployPluginHost as any).mock.calls[0][1]
    expect(firstCall.server_id).toBe(10)
    expect(firstCall.topology).toEqual({ role: 'relay', upstream_server_id: 1 })
    expect(firstCall.version).toBe('1.8.11')
    expect((firstCall.config as any).outbounds[0].settings.vnext[0].address).toBe('1.2.3.4')
  })

  it('excludes the landing itself and already-xray-deployed servers from the target list', async () => {
    wrap(
      <BulkRelayDialog
        open={true}
        onOpenChange={() => {}}
        landing={landing}
        landingServerHost="1.2.3.4"
        landingServerName="us-1"
        existingXrayServerIDs={new Set([1, 10])} // 10 already has xray
      />
    )
    expect(screen.queryByLabelText(/tokyo-1/)).toBeNull()    // excluded
    expect(await screen.findByLabelText(/osaka-1/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify failure**

```
cd web && npx vitest run src/pages/admin/plugins/xray/BulkRelayDialog.test.tsx
```

Expected: FAIL — component doesn't exist.

- [ ] **Step 3: Implement the component**

`web/src/pages/admin/plugins/xray/BulkRelayDialog.tsx`:

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
  deployPluginHost, fetchXrayVersions, generateX25519, generateShortID,
  type PluginHost,
} from '@/api/plugins'
import { useUI } from '@/store/ui'
import { renderTemplate, parseConfig, randomPort, randomUUID, type LandingRef } from './templates'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  landing: PluginHost
  landingServerHost: string  // landing's servers.ssh_host (must be Valid before opening)
  landingServerName: string  // landing's servers.name
  existingXrayServerIDs: Set<number>  // any server that already has xray (incl. landing itself)
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

function newDraft(serverID: number, serverName: string): RelayDraft {
  return {
    serverID, serverName,
    port: randomPort(),
    uuid: randomUUID(),
    privateKey: '', publicKey: '', shortID: '',
  }
}

export default function BulkRelayDialog({
  open, onOpenChange, landing, landingServerHost, landingServerName, existingXrayServerIDs,
}: Props) {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const serversQ = useServers()
  const versionsQ = useQuery({ queryKey: ['xray-versions'], queryFn: fetchXrayVersions, enabled: open })

  // Landing reference derived from landing.config (parsed once).
  const landingRef: LandingRef | null = useMemo(() => {
    const p = parseConfig(landing.config)
    if (!p.uuid || !p.publicKey || !p.sni || !p.port) return null
    return {
      address: landingServerHost,
      port: p.port,
      sni: p.sni,
      uuid: p.uuid,
      publicKey: p.publicKey,
      shortID: p.shortID ?? '',
    }
  }, [landing, landingServerHost])

  // Eligible targets: enrolled servers without xray, excluding landing itself.
  const targets = useMemo(() => {
    return (serversQ.data ?? []).filter((s) => !existingXrayServerIDs.has(s.id))
  }, [serversQ.data, existingXrayServerIDs])

  // Per-target draft state, keyed by server id.
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [drafts, setDrafts] = useState<Map<number, RelayDraft>>(new Map())
  const [version, setVersion] = useState<string>('')
  const [sharedSNI, setSharedSNI] = useState<string>(landingRef?.sni ?? 'www.icloud.com')

  // Initialize version from query result.
  if (!version && versionsQ.data?.latest?.length) {
    setVersion(versionsQ.data.latest[0])
  }

  const toggle = (s: { id: number; name: string }) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(s.id)) {
        next.delete(s.id)
        setDrafts((dPrev) => { const d = new Map(dPrev); d.delete(s.id); return d })
      } else {
        next.add(s.id)
        setDrafts((dPrev) => { const d = new Map(dPrev); d.set(s.id, newDraft(s.id, s.name)); return d })
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

  // Auto-gen keys for selected drafts that don't have them yet.
  for (const [id, d] of drafts) {
    if (!d.privateKey || !d.publicKey || !d.shortID) {
      void regenKeys(id) // fire-and-forget; React re-renders when state updates
      break              // one per render to avoid floods
    }
  }

  const deploy = useMutation({
    mutationFn: async () => {
      if (!landingRef) throw new Error('landing config incomplete')
      const ids = Array.from(selected.values()).sort((a, b) => a - b)
      let ok = 0, fail = 0
      for (const id of ids) {
        const d = drafts.get(id)!
        if (!d.privateKey || !d.publicKey || !d.shortID) {
          fail++
          toast('error', `${d.serverName}: keys not ready, skipped`)
          continue
        }
        const config = renderTemplate({
          inbound: 'vless-reality', port: d.port, uuid: d.uuid,
          sni: sharedSNI, publicKey: d.publicKey, privateKey: d.privateKey, shortID: d.shortID,
          role: 'relay',
          landing: { ...landingRef, sni: sharedSNI },
        })
        try {
          await deployPluginHost('xray', {
            server_id: id, version, config,
            topology: { role: 'relay', upstream_server_id: landing.server_id },
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
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
      qc.invalidateQueries({ queryKey: ['xray-topology'] })
    },
    onSuccess: ({ ok, fail }) => {
      toast(fail === 0 ? 'success' : 'warn', `Bulk relay: ${ok} ok, ${fail} failed`)
      if (fail === 0) onOpenChange(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">Add relays → {landingServerName}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[12px]">Version</Label>
              <Input value={version} onChange={(e) => setVersion(e.target.value)}
                className="h-8 font-mono mt-1" />
            </div>
            <div>
              <Label className="text-[12px]">REALITY SNI (shared)</Label>
              <Input value={sharedSNI} onChange={(e) => setSharedSNI(e.target.value)}
                className="h-8 font-mono mt-1" />
            </div>
          </div>

          <div>
            <Label className="text-[12px]">Target servers</Label>
            <div className="mt-1 rounded-md border bg-elev max-h-64 overflow-y-auto">
              {targets.length === 0 && (
                <p className="px-3 py-4 text-[12px] text-muted-foreground">
                  No eligible servers. All managed servers already have xray deployed, or none are enrolled.
                </p>
              )}
              {targets.map((s) => {
                const checked = selected.has(s.id)
                const d = drafts.get(s.id)
                return (
                  <label key={s.id}
                    className="flex items-center gap-3 px-3 py-2 border-b last:border-b-0 text-[12.5px]">
                    <input type="checkbox" checked={checked} onChange={() => toggle({ id: s.id, name: s.name })}
                      aria-label={`select ${s.name}`} />
                    <span className="font-mono w-32 truncate">{s.name}</span>
                    {checked && d && (
                      <>
                        <span className="font-mono text-fg-dim">port</span>
                        <Input type="number" value={d.port}
                          onChange={(e) => setDrafts((prev) => {
                            const m = new Map(prev); m.set(s.id, { ...d, port: Number(e.target.value) }); return m
                          })}
                          className="h-7 w-24 font-mono" />
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]"
                          onClick={(e) => { e.preventDefault(); void regenKeys(s.id) }}>
                          ↻ keys
                        </Button>
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={deploy.isPending || selected.size === 0 || !landingRef || !version}
            onClick={() => deploy.mutate()}>
            {deploy.isPending ? 'Deploying…' : `Deploy all (${selected.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Run tests to verify pass**

```
cd web && npx vitest run src/pages/admin/plugins/xray/BulkRelayDialog.test.tsx
```

Expected: PASS for both new tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/plugins/xray/BulkRelayDialog.tsx \
        web/src/pages/admin/plugins/xray/BulkRelayDialog.test.tsx
git commit -m "feat(web/xray): BulkRelayDialog — fan-out N relays to one landing"
```

---

## Task 12: HostsTab integrates "+ Relays" button

**Files:**
- Modify: `web/src/pages/admin/plugins/xray/HostsTab.tsx`

- [ ] **Step 1: Import + state for the bulk dialog**

Top of file:

```tsx
import BulkRelayDialog from './BulkRelayDialog'
```

Inside the component:

```ts
const [bulkRelayFor, setBulkRelayFor] = useState<{ host: PluginHost; serverName: string; serverHost: string } | null>(null)

// Set of server IDs that already have xray deployed.
const xrayServerIDs = new Set<number>((hostsQ.data ?? []).map((h) => h.server_id))
```

- [ ] **Step 2: Add the button to each landing row**

Inside the deployed branch (`{deployed ? (`), only when this row's topology says `role==='landing'`:

```tsx
{(topo.get(s.id)?.role === 'landing') && (
  <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]"
    onClick={() => {
      if (!h) return
      const sHost = s.ssh_host?.Valid ? s.ssh_host.String : ''
      if (!sHost) {
        toast('error', `${s.name} has no ssh_host yet; cannot bulk-deploy relays to it`)
        return
      }
      setBulkRelayFor({ host: h, serverName: s.name, serverHost: sHost })
    }}>
    + Relays
  </Button>
)}
```

Place it before the Re-deploy button.

- [ ] **Step 3: Mount the dialog below the table**

After the existing `{deployTarget !== null && ...}` block:

```tsx
{bulkRelayFor && (
  <BulkRelayDialog
    open={true}
    onOpenChange={(open) => { if (!open) setBulkRelayFor(null) }}
    landing={bulkRelayFor.host}
    landingServerHost={bulkRelayFor.serverHost}
    landingServerName={bulkRelayFor.serverName}
    existingXrayServerIDs={xrayServerIDs}
  />
)}
```

- [ ] **Step 4: Verify build + existing tests**

```
cd web && npm run build && npx vitest run src/pages/admin/plugins/xray/
```

Expected: build succeeds; previously-passing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/plugins/xray/HostsTab.tsx
git commit -m "feat(web/xray): HostsTab '+ Relays' button on landing rows opens BulkRelayDialog"
```

---

## Task 13: End-to-end smoke verification

**Files:**
- (none — this is a manual checklist that must pass before opening the PR)

- [ ] **Step 1: Build + run server with a fresh DB**

```
cd /Users/hg/project/Shepherd && go build -o ./bin/shepherd ./cmd/server && cd web && npm run build
```

Restart the Shepherd server pointing at a throwaway sqlite DB.

- [ ] **Step 2: Enroll two managed servers**

Use the existing add-server / agent-enroll flow. Confirm both show up with `ssh_host` populated.

- [ ] **Step 3: Deploy a landing on server A**

Open Plugin Center → xray → Hosts → New configuration. Role = Landing (default). Fill REALITY fields, generate keypair + short-id, Deploy. Wait for status=running. Copy URL → import to a client → verify it connects.

- [ ] **Step 4: Deploy a relay on server B pointing at A**

Hosts → New configuration. Role = Relay → choose landing-A. Fill the relay's own REALITY inbound fields (different port/UUID/keypair from A; SNI can be the same). Deploy. Verify status=running. Copy URL from relay-B row → import to client → verify client connects via relay-B and the landing-A access log shows the request.

- [ ] **Step 5: Verify the role lock**

Try to Re-deploy relay-B but change Role select to Landing. Expect: select is disabled with lock tooltip. (Backend: even if you call the API directly, expect 409.)

- [ ] **Step 6: Verify Undeploy guard**

Click Undeploy on landing-A. Expect: button is disabled with tooltip "1 relay(s) depend on this landing". Confirm by direct API: `DELETE /api/admin/plugins/xray/hosts/<A>` returns 409.

- [ ] **Step 7: Bulk-deploy relays**

On landing-A row click `+ Relays`. Enroll 2–3 more servers first if needed. Select them all, leave defaults, click Deploy all. Watch toasts. After completion, table shows N rows of `relay → A`. Verify each relay's share URL connects.

- [ ] **Step 8: Tear down relays then landing**

Undeploy each relay. Verify landing-A's Undeploy button becomes enabled. Undeploy landing-A. Verify all xray plugin_hosts rows and xray_host_topology rows are gone for these servers (`SELECT * FROM xray_host_topology;` should be empty for these IDs).

- [ ] **Step 9: Commit the (empty) smoke checklist record**

After the manual run succeeds, no code commit is needed for this task. Move on to PR.

- [ ] **Step 10: Open PR**

```bash
gh pr create --base main --title "feat(xray): relay / landing topology + bulk relay deploy" --body "Implements docs/superpowers/specs/2026-05-18-xray-relay-landing-design.md.

## Summary
- New plugin migration adds xray_host_topology table; existing xray hosts backfilled as landing.
- HostAware plugin gains DeployValidator / DeployCommitter / UndeployValidator optional interfaces; generic API wires them to 409 responses.
- xray plugin implements all three: role lock on re-deploy, upstream-must-be-landing, undeploy blocked when landing has relays.
- xray RenderVLESSReality renders relay configs (vless+REALITY outbound to landing, private-IP direct routing).
- New GET /api/admin/plugins/xray/topology endpoint joins servers.name for UI.
- DeployDialog: Role + Upstream landing fields, locked on re-deploy.
- HostsTab: Role column, Undeploy disabled when landing has dependents, '+ Relays' button per landing row.
- BulkRelayDialog: select N target servers, auto-gen per-relay UUID/keypair/shortID, sequential deploy with toast progress.

## Test plan
- [x] go test ./... all green
- [x] vitest all green
- [x] Manual smoke (steps 2–8 above)"
```

---

## Self-Review Notes

- **Spec coverage:** §2.1 (T1), §2.2 (no DB change to plugin_hosts — covered by absence of changes), §3.1 (T3, regression test), §3.2 (T3), §3.3 (T3 Go + T8 TS), §4.1 (T4+T5), §4.2 (T6+T7), §4.3 (T5 BeforeUndeploy + T4 hook), §5.1 (T9), §5.2 (T10+T12), §5.3 (T11+T12), §6.1 / §6.2 (T13 manual + Re-deploy keypair warning — **see follow-up**), §6.3/6.4 (T5+T9), §7 (T1), §8.1 (T1–T6 unit tests), §8.2 (T8 unit, T11 unit, T9/T10 indirect), §8.3 (T13).
- **Open gap (§6.2):** Spec calls for a Confirm dialog when re-deploying a landing whose keypair/SNI/UUID/port changes. That warning UI isn't in any task. It's an additive nice-to-have, not a blocker for v1 functionality (manual re-deploy of relays still works); if you want it inside this PR, add it after Task 9 as Task 9b. Otherwise file as follow-up.
- **Type consistency:** Go `Topology { ServerID, Role, UpstreamServerID NullInt64, UpdatedAt }`; TS `XrayTopologyRow { role, upstream_server_id|null, upstream_name|null }`; TS `LandingRef { address, port, sni, uuid, publicKey, shortID }` mirrors Go `LandingRef { Address, Port, SNI, UUID, PublicKey, ShortID }` — same field set in different case conventions, correct for each language.
- **Frequent commits:** 12 implementation commits + smoke. Each commit independently compiles and tests pass.

Plan complete and saved to `docs/superpowers/plans/2026-05-18-xray-relay-landing.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review after each (spec compliance → code quality), fast iteration in this session.
2. **Inline Execution** — execute tasks here in this session in batches with checkpoints for review.

Which approach?
