# Inbound Alias Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each xray / sing-box inbound an optional free-text `alias` that, when set, becomes the node's name in generated subscriptions (replacing the auto `🇺🇸 ServerName protocol` label); duplicate node names are de-duplicated with a numeric suffix.

**Architecture:** Add an `alias TEXT NOT NULL DEFAULT ''` column to each inbound table; thread it through each plugin's struct/DAO/HTTP layer and through subgen's read path (`collect.go` → `node.go`) into `Node.Name`. De-dup runs once over the full node set in `Assemble`.

**Tech Stack:** Go (sqlx, embedded SQL migrations), React/TS (vitest), Postgres + SQLite.

**Spec:** `docs/superpowers/specs/2026-05-27-inbound-alias-design.md`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `internal/plugins/subgen/node.go` | Node model + name derivation | alias-replace in `*InboundToNode`; add `Alias` to `xrayLite`/`singboxLite`; add `dedupeNodeNames` |
| `internal/plugins/subgen/base.go` | `Assemble` | call `dedupeNodeNames` after custom-node append |
| `internal/plugins/subgen/collect.go` | inbound→Node SQL read | add `Alias` to `xrayRow`/`singboxRow`; add `i.alias` to both SELECTs; pass through |
| `internal/plugins/xray/migrations/{postgres,sqlite}/0005_inbound_alias.{up,down}.sql` | schema | new column |
| `internal/plugins/xray/migrations.go` | migration registry | register `0005` |
| `internal/plugins/xray/inbounds.go` | struct + DAO | `Alias` on `Inbound`/`InboundPatch`; `Insert`/`Update`; `i.alias` in `ListAllWithUpstream` |
| `internal/plugins/xray/inbounds_routes.go` | HTTP DTO/handlers | `Alias` in body/response/create/patch |
| `internal/plugins/singbox/migrations/{postgres,sqlite}/0007_inbound_alias.{up,down}.sql` | schema | new column |
| `internal/plugins/singbox/migrations.go` | migration registry | register `0007` |
| `internal/plugins/singbox/inbounds.go` | struct + DAO | `Alias` on `Inbound`/`InboundPatch`; `Insert`/`Update`; `i.alias` in `ListAllWithUpstream` |
| `internal/plugins/singbox/inbounds_routes.go` | HTTP DTO/handlers | `Alias` in body/response/create/patch |
| `web/src/api/plugins.ts` | TS types | `alias` on 6 inbound interfaces |
| `web/src/pages/admin/plugins/{xray,singbox}/InboundDialog.tsx` | forms | alias input + wiring |
| `web/src/pages/admin/plugins/{xray,singbox}/InboundsTab.tsx` | tables | alias column |
| `web/src/pages/admin/plugins/{xray,singbox}/InboundDialog.test.tsx` | vitest fixtures | `alias: ''` |
| `docs/subgen.md` | docs | note alias naming |

**Task order rationale (so each commit builds + tests green):** Task 1 is pure subgen logic (no DB column needed — adding a field to the `*Lite` structs doesn't break existing zero-value construction). The DB column must exist before any `i.alias` SELECT runs, so the xray (Tasks 2–3) and singbox (Tasks 4–5) layers add the migration before subgen's collect wiring (Task 6) references the column. Frontend (Tasks 7–8) and docs/verify (Task 9) last.

---

## Task 1: subgen node naming (alias-replace + de-dup)

**Files:**
- Modify: `internal/plugins/subgen/node.go`
- Modify: `internal/plugins/subgen/base.go`
- Test: `internal/plugins/subgen/node_test.go`, `internal/plugins/subgen/base_test.go`

- [ ] **Step 1: Write failing tests for alias-replace and de-dup**

Add to `internal/plugins/subgen/node_test.go`:

```go
func TestInboundToNode_AliasReplacesName(t *testing.T) {
	srv := serverLite{Name: "Tokyo", Host: "1.2.3.4", Country: "US"}

	// xray: alias set → verbatim; empty → default
	if got := xrayInboundToNode(xrayLite{Protocol: "vless-reality", Alias: "🇭🇰 香港 CIA 01"}, srv).Name; got != "🇭🇰 香港 CIA 01" {
		t.Errorf("xray alias: got %q", got)
	}
	if got := xrayInboundToNode(xrayLite{Protocol: "vless-reality", Alias: "  "}, srv).Name; got != "🇺🇸 Tokyo vless" {
		t.Errorf("xray blank alias fallback: got %q", got)
	}

	// singbox: alias set → verbatim; empty → default
	if got := singboxInboundToNode(singboxLite{Protocol: "anytls", Alias: "Home AnyTLS"}, srv).Name; got != "Home AnyTLS" {
		t.Errorf("singbox alias: got %q", got)
	}
	if got := singboxInboundToNode(singboxLite{Protocol: "anytls"}, srv).Name; got != "🇺🇸 Tokyo anytls" {
		t.Errorf("singbox empty alias fallback: got %q", got)
	}
}

func TestDedupeNodeNames(t *testing.T) {
	nodes := []Node{{Name: "X"}, {Name: "X"}, {Name: "X"}, {Name: "Y"}}
	dedupeNodeNames(nodes)
	got := []string{nodes[0].Name, nodes[1].Name, nodes[2].Name, nodes[3].Name}
	want := []string{"X", "X 2", "X 3", "Y"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("idx %d: got %q want %q", i, got[i], want[i])
		}
	}

	// a name that already ends in a taken suffix is skipped
	nodes2 := []Node{{Name: "A"}, {Name: "A 2"}, {Name: "A"}}
	dedupeNodeNames(nodes2)
	if nodes2[2].Name != "A 3" {
		t.Errorf("collision with pre-taken suffix: got %q want %q", nodes2[2].Name, "A 3")
	}
}
```

Add to `internal/plugins/subgen/base_test.go`:

```go
func TestAssemble_DedupesNodeNames(t *testing.T) {
	nodes := []Node{
		{Name: "🇭🇰 香港", Protocol: "anytls"},
		{Name: "🇭🇰 香港", Protocol: "vless"},
	}
	im := Assemble(nodes, TemplateSpec{Final: "PROXY"})
	if im.Nodes[0].Name != "🇭🇰 香港" || im.Nodes[1].Name != "🇭🇰 香港 2" {
		t.Fatalf("dedupe in Assemble: got %q, %q", im.Nodes[0].Name, im.Nodes[1].Name)
	}
	// PROXY group members must reference the de-duplicated names
	if im.Groups[0].Name != "PROXY" {
		t.Fatalf("expected PROXY first, got %q", im.Groups[0].Name)
	}
	joined := strings.Join(im.Groups[0].Members, ",")
	if !strings.Contains(joined, "🇭🇰 香港 2") {
		t.Fatalf("PROXY members miss deduped name: %q", joined)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run 'AliasReplacesName|DedupeNodeNames|Assemble_DedupesNodeNames' -v`
Expected: FAIL — `xrayLite has no field Alias` / `undefined: dedupeNodeNames` (compile error).

- [ ] **Step 3: Add `Alias` to the Lite structs and use it in the mappers**

In `internal/plugins/subgen/node.go`, add `Alias string` to `xrayLite` (after `Tag string`):

```go
type xrayLite struct {
	Tag        string
	Alias      string
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
```

Add `Alias string` to `singboxLite` (after `Tag string`):

```go
type singboxLite struct {
	Tag              string
	Alias            string
	Port             int
	Protocol         string
	Role             string
	RelayMode        string
	UUID             *string
	Flow             *string
	Password         *string
	SNI              *string
	RealityPublicKey *string
	RealityShortID   *string
	TransportPath    *string
	TransportHost    *string
	SSMethod         *string
	ExtraJSON        *string
}
```

Replace the `n.Name = ...` line in `singboxInboundToNode` (currently the last statement before `return n`):

```go
	n.Name = aliasOrDefault(in.Alias, srv, n.Protocol)
	return n
```

Replace the `n.Name = ...` line in `xrayInboundToNode` the same way:

```go
	n.Name = aliasOrDefault(in.Alias, srv, n.Protocol)
	return n
```

Add `fmt` to the import block and add the two helpers (place after `nodeName`):

```go
// aliasOrDefault returns a trimmed non-empty alias verbatim, else the
// auto-generated "<flag> <server> <proto>" name.
func aliasOrDefault(alias string, srv serverLite, proto string) string {
	if a := strings.TrimSpace(alias); a != "" {
		return a
	}
	return nodeName(srv.Country, srv.Name, proto)
}

// dedupeNodeNames makes Node.Name unique across the slice, in place,
// preserving order. The first occurrence of a name is kept; later
// collisions get " 2", " 3", … (skipping any suffix already taken).
func dedupeNodeNames(nodes []Node) {
	seen := make(map[string]bool, len(nodes))
	for i := range nodes {
		name := nodes[i].Name
		if !seen[name] {
			seen[name] = true
			continue
		}
		for n := 2; ; n++ {
			cand := fmt.Sprintf("%s %d", name, n)
			if !seen[cand] {
				nodes[i].Name = cand
				seen[cand] = true
				break
			}
		}
	}
}
```

The import block becomes:

```go
import (
	"encoding/json"
	"fmt"
	"strings"
)
```

- [ ] **Step 4: Call `dedupeNodeNames` in `Assemble`**

In `internal/plugins/subgen/base.go`, in `Assemble`, insert the call right after the custom-node append and before `im := Intermediate{...}`:

```go
	if custom, _ := ParseShareLinks(spec.CustomNodes); len(custom) > 0 {
		nodes = append(nodes, custom...)
	}
	dedupeNodeNames(nodes)
	im := Intermediate{Nodes: nodes, General: spec.General, MITM: spec.MITM, URLRewrite: spec.URLRewrite, ClashGeneral: spec.ClashGeneral}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run 'AliasReplacesName|DedupeNodeNames|Assemble_DedupesNodeNames' -v`
Expected: PASS.

- [ ] **Step 6: Run the full subgen package + gofmt/vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ && gofmt -l internal/plugins/subgen/node.go internal/plugins/subgen/base.go && go vet ./internal/plugins/subgen/`
Expected: package tests PASS; gofmt prints nothing; vet clean. (collect.go still passes `Alias: ""` implicitly — wiring comes in Task 6.)

- [ ] **Step 7: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/plugins/subgen/node.go internal/plugins/subgen/base.go internal/plugins/subgen/node_test.go internal/plugins/subgen/base_test.go
git commit -m "feat(subgen): alias-replace node name + de-dup duplicate names"
```

---

## Task 2: xray DB layer (migration + struct + DAO)

**Files:**
- Create: `internal/plugins/xray/migrations/postgres/0005_inbound_alias.up.sql`
- Create: `internal/plugins/xray/migrations/postgres/0005_inbound_alias.down.sql`
- Create: `internal/plugins/xray/migrations/sqlite/0005_inbound_alias.up.sql`
- Create: `internal/plugins/xray/migrations/sqlite/0005_inbound_alias.down.sql`
- Modify: `internal/plugins/xray/migrations.go`
- Modify: `internal/plugins/xray/inbounds.go`
- Test: `internal/plugins/xray/inbounds_test.go`

- [ ] **Step 1: Create the migration files**

`internal/plugins/xray/migrations/postgres/0005_inbound_alias.up.sql`:

```sql
ALTER TABLE xray_inbounds ADD COLUMN alias TEXT NOT NULL DEFAULT '';
```

`internal/plugins/xray/migrations/postgres/0005_inbound_alias.down.sql`:

```sql
ALTER TABLE xray_inbounds DROP COLUMN alias;
```

`internal/plugins/xray/migrations/sqlite/0005_inbound_alias.up.sql`:

```sql
ALTER TABLE xray_inbounds ADD COLUMN alias TEXT NOT NULL DEFAULT '';
```

`internal/plugins/xray/migrations/sqlite/0005_inbound_alias.down.sql`:

```sql
ALTER TABLE xray_inbounds DROP COLUMN alias;
```

- [ ] **Step 2: Register the migration**

In `internal/plugins/xray/migrations.go`, append to the `names` slice (after `"0004_traffic.up.sql"`):

```go
		"0004_traffic.up.sql",
		"0005_inbound_alias.up.sql",
```

- [ ] **Step 3: Write failing DAO test**

Add to `internal/plugins/xray/inbounds_test.go` (mirror the existing test setup in that file for DB + server fixture; reuse whatever helper creates the store and a server — look at an existing test like the Insert/Update test for the exact `newTestStore`/seed pattern and copy it):

```go
func TestInbound_AliasRoundTrip(t *testing.T) {
	st := newInboundTestStore(t) // same helper existing tests use
	srvID := seedServer(t, st.DB) // same helper existing tests use

	id, err := st.Insert(testCtx(), Inbound{ServerID: srvID, Role: "landing", Protocol: "vless-reality", Port: 443, Alias: "🇭🇰 HK 01"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := st.Get(testCtx(), id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Alias != "🇭🇰 HK 01" {
		t.Fatalf("insert alias: got %q", got.Alias)
	}

	newAlias := "🇭🇰 HK renamed"
	if err := st.Update(testCtx(), id, InboundPatch{Alias: &newAlias}); err != nil {
		t.Fatal(err)
	}
	got, _ = st.Get(testCtx(), id)
	if got.Alias != newAlias {
		t.Fatalf("update alias: got %q", got.Alias)
	}

	// nil patch leaves it unchanged
	port := 8443
	if err := st.Update(testCtx(), id, InboundPatch{Port: &port}); err != nil {
		t.Fatal(err)
	}
	got, _ = st.Get(testCtx(), id)
	if got.Alias != newAlias {
		t.Fatalf("alias clobbered by unrelated patch: got %q", got.Alias)
	}
}
```

> Implementer note: match the exact constructor/seed helper names and `context` helper used by the sibling tests in `inbounds_test.go`; replace `newInboundTestStore`/`seedServer`/`testCtx` with whatever those tests already use. Do not invent new helpers if equivalents exist.

- [ ] **Step 4: Run test to verify it fails**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/xray/ -run TestInbound_AliasRoundTrip -v`
Expected: FAIL — `Inbound has no field Alias` / `InboundPatch has no field Alias` (compile error).

- [ ] **Step 5: Add `Alias` to structs and DAO**

In `internal/plugins/xray/inbounds.go`:

Add to `Inbound` (after `Tag string \`db:"tag"\``):

```go
	Alias    string    `db:"alias"`
```

Add to `InboundPatch` (after `Port *int`):

```go
	Alias      *string
```

In `Insert`, change the INSERT to include `alias`:

```go
	if err := s.DB.QueryRowxContext(ctx, `
		INSERT INTO xray_inbounds (
		  server_id, tag, alias, port, role, protocol,
		  uuid, sni, public_key, private_key, short_id,
		  ws_path, ss_method, ss_password,
		  upstream_inbound_id, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
		RETURNING id`,
		in.ServerID, in.Tag, in.Alias, in.Port, in.Role, in.Protocol,
		in.UUID, in.SNI, in.PublicKey, in.PrivateKey, in.ShortID,
		in.WSPath, in.SSMethod, in.SSPassword,
		in.UpstreamInboundID, now, now).Scan(&id); err != nil {
```

In `Update`, add after the `patch.Port` block:

```go
	if patch.Alias != nil {
		set = append(set, "alias=?")
		args = append(args, *patch.Alias)
	}
```

In `ListAllWithUpstream`, add `i.alias` to the projected column list (after `i.tag`):

```go
		SELECT
		  i.id, i.server_id, i.tag, i.alias, i.port, i.role, i.protocol,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/xray/ -run TestInbound_AliasRoundTrip -v`
Expected: PASS.

- [ ] **Step 7: Run full xray package**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/xray/ && gofmt -l internal/plugins/xray/inbounds.go internal/plugins/xray/migrations.go`
Expected: PASS; gofmt prints nothing.

- [ ] **Step 8: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/plugins/xray/migrations/ internal/plugins/xray/migrations.go internal/plugins/xray/inbounds.go internal/plugins/xray/inbounds_test.go
git commit -m "feat(xray): alias column on inbounds (migration + DAO)"
```

---

## Task 3: xray HTTP routes (DTO + create/patch/response)

**Files:**
- Modify: `internal/plugins/xray/inbounds_routes.go`
- Test: `internal/plugins/xray/inbounds_routes_test.go`

- [ ] **Step 1: Write failing route test**

Add to `internal/plugins/xray/inbounds_routes_test.go` (reuse the existing harness in that file — find how it builds the handler/router + server fixture and copy that setup):

```go
func TestRoutes_InboundAlias(t *testing.T) {
	env := newRoutesTestEnv(t) // same helper the existing route tests use

	// create with alias
	body := `{"server_id":` + env.serverIDStr + `,"role":"landing","protocol":"vless-reality","port":443,"alias":"🇭🇰 HK 01"}`
	rec := env.do(t, "POST", "/inbounds", body)
	if rec.Code != 200 && rec.Code != 201 {
		t.Fatalf("create status %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"alias":"🇭🇰 HK 01"`) {
		t.Fatalf("create response missing alias: %s", rec.Body.String())
	}
	id := env.lastInsertedInboundID(t)

	// patch alias
	rec = env.do(t, "PATCH", "/inbounds/"+id, `{"alias":"🇭🇰 HK renamed"}`)
	if rec.Code != 200 {
		t.Fatalf("patch status %d: %s", rec.Code, rec.Body.String())
	}
	// list shows new alias
	rec = env.do(t, "GET", "/inbounds", "")
	if !strings.Contains(rec.Body.String(), `"alias":"🇭🇰 HK renamed"`) {
		t.Fatalf("list missing patched alias: %s", rec.Body.String())
	}
}
```

> Implementer note: replace `newRoutesTestEnv`/`env.do`/`env.serverIDStr`/`env.lastInsertedInboundID` with the actual helpers used by sibling tests in `inbounds_routes_test.go`. If sibling tests assert on a list endpoint differently, follow their exact pattern. The assertions that matter: alias is echoed on create, persisted on patch, and present in the list response.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/xray/ -run TestRoutes_InboundAlias -v`
Expected: FAIL — alias absent from response (`postInboundBody` drops it; `inboundToMap` omits it).

- [ ] **Step 3: Wire alias through the routes**

In `internal/plugins/xray/inbounds_routes.go`:

Add to `postInboundBody` (after `Port int \`json:"port"\``):

```go
	Alias             string `json:"alias"`
```

Add to `inboundToMap`'s map literal (after the `"tag"` entry):

```go
		"alias":       v.Alias,
```

In `postInboundHandler`, add `Alias: body.Alias,` to the `Inbound{...}` literal (after `Port: body.Port,`):

```go
			Role: body.Role, Protocol: body.Protocol, Alias: body.Alias,
```

> Implementer note: place `Alias: body.Alias` anywhere inside the `Inbound{...}` literal; the line grouping above is illustrative — keep gofmt happy.

In `patchInboundHandler`, add after the `port` extraction:

```go
		if v, ok := body["alias"].(string); ok {
			patch.Alias = &v
		}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/xray/ -run TestRoutes_InboundAlias -v`
Expected: PASS.

- [ ] **Step 5: Run full xray package + vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/xray/ && go vet ./internal/plugins/xray/ && gofmt -l internal/plugins/xray/inbounds_routes.go`
Expected: PASS; vet clean; gofmt prints nothing.

- [ ] **Step 6: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/plugins/xray/inbounds_routes.go internal/plugins/xray/inbounds_routes_test.go
git commit -m "feat(xray): alias in inbound create/patch/list API"
```

---

## Task 4: sing-box DB layer (migration + struct + DAO)

**Files:**
- Create: `internal/plugins/singbox/migrations/postgres/0007_inbound_alias.up.sql`
- Create: `internal/plugins/singbox/migrations/postgres/0007_inbound_alias.down.sql`
- Create: `internal/plugins/singbox/migrations/sqlite/0007_inbound_alias.up.sql`
- Create: `internal/plugins/singbox/migrations/sqlite/0007_inbound_alias.down.sql`
- Modify: `internal/plugins/singbox/migrations.go`
- Modify: `internal/plugins/singbox/inbounds.go`
- Test: `internal/plugins/singbox/inbounds_test.go`

- [ ] **Step 1: Create the migration files**

All four files use the same SQL (table name `singbox_inbounds`):

`internal/plugins/singbox/migrations/postgres/0007_inbound_alias.up.sql` and `internal/plugins/singbox/migrations/sqlite/0007_inbound_alias.up.sql`:

```sql
ALTER TABLE singbox_inbounds ADD COLUMN alias TEXT NOT NULL DEFAULT '';
```

`internal/plugins/singbox/migrations/postgres/0007_inbound_alias.down.sql` and `internal/plugins/singbox/migrations/sqlite/0007_inbound_alias.down.sql`:

```sql
ALTER TABLE singbox_inbounds DROP COLUMN alias;
```

- [ ] **Step 2: Register the migration**

In `internal/plugins/singbox/migrations.go`, append to the `names` slice (after `"0006_relay_mode.up.sql"`):

```go
		"0006_relay_mode.up.sql",
		"0007_inbound_alias.up.sql",
```

- [ ] **Step 3: Write failing DAO test**

Add to `internal/plugins/singbox/inbounds_test.go` (reuse the file's existing store/server helpers):

```go
func TestInbound_AliasRoundTrip(t *testing.T) {
	st := newInboundTestStore(t) // existing helper
	srvID := seedServer(t, st.DB) // existing helper

	id, err := st.Insert(testCtx(), Inbound{ServerID: srvID, Role: "landing", Protocol: "anytls", Port: 443, Alias: "🇸🇬 SG 01"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := st.Get(testCtx(), id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Alias != "🇸🇬 SG 01" {
		t.Fatalf("insert alias: got %q", got.Alias)
	}

	newAlias := "🇸🇬 SG renamed"
	if err := st.Update(testCtx(), id, InboundPatch{Alias: &newAlias}); err != nil {
		t.Fatal(err)
	}
	got, _ = st.Get(testCtx(), id)
	if got.Alias != newAlias {
		t.Fatalf("update alias: got %q", got.Alias)
	}

	port := 8443
	if err := st.Update(testCtx(), id, InboundPatch{Port: &port}); err != nil {
		t.Fatal(err)
	}
	got, _ = st.Get(testCtx(), id)
	if got.Alias != newAlias {
		t.Fatalf("alias clobbered by unrelated patch: got %q", got.Alias)
	}
}
```

> Implementer note: match the actual helper names + `Get` signature in this file's sibling tests.

- [ ] **Step 4: Run test to verify it fails**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/singbox/ -run TestInbound_AliasRoundTrip -v`
Expected: FAIL — `Inbound`/`InboundPatch` has no field `Alias`.

- [ ] **Step 5: Add `Alias` to structs and DAO**

In `internal/plugins/singbox/inbounds.go`:

Add to `Inbound` (after `Tag string \`db:"tag"\``):

```go
	Alias                  string     `db:"alias"`
```

Add to `InboundPatch` (after `Port *int`):

```go
	Alias                  *string
```

In `Insert`, add `alias` to the INSERT (after `tag`) and bump placeholders:

```go
		INSERT INTO singbox_inbounds (
		  server_id, tag, alias, port, role, protocol,
		  uuid, flow, password, sni, cert_id,
		  reality_private_key, reality_public_key, reality_short_id,
		  reality_handshake_server, reality_handshake_port,
		  transport_path, transport_host, alter_id, ss_method,
		  upstream_inbound_id, relay_mode, extra_json,
		  created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5,$6, $7,$8,$9,$10,$11, $12,$13,$14, $15,$16, $17,$18,$19,$20, $21,$22,$23, $24,$25)
		RETURNING id`,
		in.ServerID, in.Tag, in.Alias, in.Port, in.Role, in.Protocol,
		in.UUID, in.Flow, in.Password, in.SNI, in.CertID,
		in.RealityPrivateKey, in.RealityPublicKey, in.RealityShortID,
		in.RealityHandshakeServer, in.RealityHandshakePort,
		in.TransportPath, in.TransportHost, in.AlterID, in.SSMethod,
		in.UpstreamInboundID, in.RelayMode, in.ExtraJSON,
		now, now).Scan(&id); err != nil {
```

In `Update`, add after the `patch.Port` line (uses the `app` helper):

```go
	if patch.Alias != nil                  { app("alias", *patch.Alias) }
```

In `ListAllWithUpstream`, add `i.alias` to the projected column list (after `i.tag`):

```go
		SELECT
		  i.id, i.server_id, i.tag, i.alias, i.port, i.role, i.protocol,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/singbox/ -run TestInbound_AliasRoundTrip -v`
Expected: PASS.

- [ ] **Step 7: Run full singbox package**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/singbox/ && gofmt -l internal/plugins/singbox/inbounds.go internal/plugins/singbox/migrations.go`
Expected: PASS; gofmt prints nothing.

- [ ] **Step 8: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/plugins/singbox/migrations/ internal/plugins/singbox/migrations.go internal/plugins/singbox/inbounds.go internal/plugins/singbox/inbounds_test.go
git commit -m "feat(singbox): alias column on inbounds (migration + DAO)"
```

---

## Task 5: sing-box HTTP routes (DTO + create/patch/response)

**Files:**
- Modify: `internal/plugins/singbox/inbounds_routes.go`
- Test: `internal/plugins/singbox/inbounds_routes_test.go`

- [ ] **Step 1: Write failing route test**

Add to `internal/plugins/singbox/inbounds_routes_test.go` (reuse existing harness helpers):

```go
func TestRoutes_InboundAlias(t *testing.T) {
	env := newRoutesTestEnv(t) // existing helper

	body := `{"server_id":` + env.serverIDStr + `,"role":"landing","protocol":"anytls","port":443,"alias":"🇸🇬 SG 01"}`
	rec := env.do(t, "POST", "/inbounds", body)
	if rec.Code != 200 && rec.Code != 201 {
		t.Fatalf("create status %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"alias":"🇸🇬 SG 01"`) {
		t.Fatalf("create response missing alias: %s", rec.Body.String())
	}
	id := env.lastInsertedInboundID(t)

	rec = env.do(t, "PATCH", "/inbounds/"+id, `{"alias":"🇸🇬 SG renamed"}`)
	if rec.Code != 200 {
		t.Fatalf("patch status %d: %s", rec.Code, rec.Body.String())
	}
	rec = env.do(t, "GET", "/inbounds", "")
	if !strings.Contains(rec.Body.String(), `"alias":"🇸🇬 SG renamed"`) {
		t.Fatalf("list missing patched alias: %s", rec.Body.String())
	}
}
```

> Implementer note: match the actual helpers in this file's sibling tests (route prefix, env constructor, list-fetch pattern).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/singbox/ -run TestRoutes_InboundAlias -v`
Expected: FAIL — alias absent from response.

- [ ] **Step 3: Wire alias through the routes**

In `internal/plugins/singbox/inbounds_routes.go`:

Add to `postInboundBody` (after `Port int \`json:"port"\``):

```go
	Alias                  string  `json:"alias"`
```

Add to `inboundToMap`'s map literal (after the `"tag"` entry):

```go
		"alias":       v.Alias,
```

In `postInboundHandler`, add `Alias: body.Alias,` to the `Inbound{...}` literal (after `Tag: store.GenerateTag(body.Role),`):

```go
			Alias:                  body.Alias,
```

In `patchInboundHandler`, add after the `port` extraction block:

```go
		if v, ok := body["alias"].(string); ok {
			patch.Alias = &v
		}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/singbox/ -run TestRoutes_InboundAlias -v`
Expected: PASS.

- [ ] **Step 5: Run full singbox package + vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/singbox/ && go vet ./internal/plugins/singbox/ && gofmt -l internal/plugins/singbox/inbounds_routes.go`
Expected: PASS; vet clean; gofmt prints nothing.

- [ ] **Step 6: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/plugins/singbox/inbounds_routes.go internal/plugins/singbox/inbounds_routes_test.go
git commit -m "feat(singbox): alias in inbound create/patch/list API"
```

---

## Task 6: subgen collect wiring (read `alias` from DB into Node)

**Files:**
- Modify: `internal/plugins/subgen/collect.go`
- Test: `internal/plugins/subgen/collect_test.go`

- [ ] **Step 1: Write failing test**

Add to `internal/plugins/subgen/collect_test.go` (the file already seeds `xray_inbounds`/`singbox_inbounds`; reuse its existing DB+seed helpers — find how `TestCollectNodes_MapsAndSkipsMissingHost` inserts a row and copy the INSERT, adding the `alias` column/value):

```go
func TestCollectNodes_UsesAlias(t *testing.T) {
	d := newCollectTestDB(t) // existing helper used by sibling tests
	// Seed a server + xray inbound WITH an alias. Copy the exact INSERT
	// statements from TestCollectNodes_MapsAndSkipsMissingHost and add
	// the alias column. Example shape (adjust columns to match sibling):
	seedServer(t, d, 1, "Tokyo", "1.2.3.4", "US")
	seedXrayInbound(t, d, 7 /*id*/, 1 /*server*/, "landing-x", "vless-reality", 443, withAlias("🇭🇰 HK Custom"))

	nodes, _, err := CollectNodes(testCtx(), d, []Selection{{Source: "xray", InboundID: 7}})
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) != 1 || nodes[0].Name != "🇭🇰 HK Custom" {
		t.Fatalf("alias not used as node name: %+v", nodes)
	}
}
```

> Implementer note: the sibling tests in `collect_test.go` already insert inbound rows with raw SQL or a helper. Do NOT invent `seedXrayInbound`/`withAlias` if no such helpers exist — instead inline the same `INSERT INTO xray_inbounds (...)` the sibling test uses, adding `alias` to the column list and `'🇭🇰 HK Custom'` to the values. The assertion that matters: a seeded `alias` becomes `nodes[0].Name`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run TestCollectNodes_UsesAlias -v`
Expected: FAIL — node name is the default `🇺🇸 Tokyo vless`, not the alias (collect.go doesn't read/pass alias yet).

- [ ] **Step 3: Read alias in the collect queries and pass it through**

In `internal/plugins/subgen/collect.go`:

Add to `xrayRow` (after `Tag string \`db:"tag"\``):

```go
	Alias      string         `db:"alias"`
```

Add to `singboxRow` (after `Tag string \`db:"tag"\``):

```go
	Alias         string         `db:"alias"`
```

In `collectXray`, add `i.alias` to the SELECT (after `i.tag`):

```go
		SELECT i.tag, i.alias, i.port, i.protocol, i.uuid, i.sni, i.public_key, i.short_id,
```

and pass it into the `xrayLite{...}` literal:

```go
	n := xrayInboundToNode(xrayLite{
		Tag: r.Tag, Alias: r.Alias, Port: r.Port, Protocol: r.Protocol,
		UUID: r.UUID.String, SNI: r.SNI.String, PublicKey: r.PublicKey.String,
		ShortID: r.ShortID.String, WSPath: r.WSPath.String,
		SSMethod: r.SSMethod.String, SSPassword: r.SSPassword.String,
	}, serverLite{Name: r.SrvName, Host: r.SrvHost.String, Country: r.SrvCountry.String})
```

In `collectSingbox`, add `i.alias` to the SELECT (after `i.tag`):

```go
		SELECT i.tag, i.alias, i.port, i.protocol, i.role, i.relay_mode, i.uuid, i.flow, i.password, i.sni,
```

and pass it into the `singboxLite{...}` literal:

```go
	n := singboxInboundToNode(singboxLite{
		Tag: r.Tag, Alias: r.Alias, Port: r.Port, Protocol: r.Protocol, Role: r.Role, RelayMode: r.RelayMode,
		UUID: ns(r.UUID), Flow: ns(r.Flow), Password: ns(r.Password), SNI: ns(r.SNI),
		RealityPublicKey: ns(r.RealityPub), RealityShortID: ns(r.RealitySID),
		TransportPath: ns(r.TransportPath), TransportHost: ns(r.TransportHost),
		SSMethod: ns(r.SSMethod), ExtraJSON: ns(r.ExtraJSON),
	}, serverLite{Name: r.SrvName, Host: r.SrvHost.String, Country: r.SrvCountry.String})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run TestCollectNodes_UsesAlias -v`
Expected: PASS.

- [ ] **Step 5: Run full subgen package + vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ && go vet ./internal/plugins/subgen/ && gofmt -l internal/plugins/subgen/collect.go`
Expected: PASS; vet clean; gofmt prints nothing.

- [ ] **Step 6: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/plugins/subgen/collect.go internal/plugins/subgen/collect_test.go
git commit -m "feat(subgen): read inbound alias into Node.Name"
```

---

## Task 7: frontend — TS types + xray form/table/fixture

**Files:**
- Modify: `web/src/api/plugins.ts`
- Modify: `web/src/pages/admin/plugins/xray/InboundDialog.tsx`
- Modify: `web/src/pages/admin/plugins/xray/InboundsTab.tsx`
- Test: `web/src/pages/admin/plugins/xray/InboundDialog.test.tsx`

- [ ] **Step 1: Add `alias` to all six TS inbound interfaces**

In `web/src/api/plugins.ts`:
- `XrayInbound`: add `alias: string` (after `tag: string`)
- `CreateXrayInboundBody`: add `alias?: string` (after `port: number`)
- `PatchXrayInboundBody`: add `alias?: string` (after `port?: number`)
- `SingboxInbound`: add `alias?: string` (after `tag: string`)
- `CreateSingboxInboundBody`: add `alias?: string` (after `port: number`)
- `PatchSingboxInboundBody`: add `alias?: string` (after `port?: number`)

(Doing all six here keeps the type file in one commit; Task 8 consumes the singbox ones.)

- [ ] **Step 2: Update the xray test fixture (will fail tsc until form is wired? No — fixture compiles once `alias` is on the type). Write the form-behavior test**

In `web/src/pages/admin/plugins/xray/InboundDialog.test.tsx`, add `alias: '',` to the `landing` fixture (after `tag: 'landing-aa',`).

Add a test that the alias input renders and submits (mirror an existing field-edit test in this file for the render/query/click pattern):

```tsx
it('submits alias on create', async () => {
  const create = vi.spyOn(pluginsAPI, 'createXrayInbound').mockResolvedValue({} as never)
  renderDialog({ editing: undefined }) // use the file's existing render helper
  fireEvent.change(screen.getByLabelText(/alias/i), { target: { value: '🇭🇰 HK 01' } })
  fireEvent.click(screen.getByRole('button', { name: /create|save/i }))
  await waitFor(() => expect(create).toHaveBeenCalled())
  expect(create.mock.calls[0][0]).toMatchObject({ alias: '🇭🇰 HK 01' })
})
```

> Implementer note: use the file's existing render helper, mock style, and button label. If the dialog uses a different submit label, match it. The assertion that matters: `createXrayInbound` is called with `alias`.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/plugins/xray/InboundDialog.test.tsx`
Expected: FAIL — no element with an accessible name matching `/alias/i` (input not added yet).

- [ ] **Step 4: Add alias state, wiring, and input to the xray dialog**

In `web/src/pages/admin/plugins/xray/InboundDialog.tsx`:

Add state (after the `sni` state):

```tsx
const [alias, setAlias] = useState<string>(editing?.alias ?? '')
```

Add to the create mutation's `createXrayInbound({...})` payload:

```tsx
      alias: alias || undefined,
```

Add to the patch mutation's `patchXrayInbound(editing.id, {...})` payload:

```tsx
      alias: alias !== editing.alias ? alias : undefined,
```

Add the input after the SNI field (match the surrounding `Label`/`Input` markup used by sibling fields):

```tsx
<div>
  <Label className="text-[12px]">Alias</Label>
  <Input value={alias} onChange={(e) => setAlias(e.target.value)}
    placeholder="可选：节点别名，留空用默认命名"
    className="h-8 font-mono mt-1" />
</div>
```

- [ ] **Step 5: Add the Alias column to the xray table**

In `web/src/pages/admin/plugins/xray/InboundsTab.tsx`:
- Add a `<th>…>Alias</th>` header cell after the Port header.
- Add a `<td className="px-3 py-2 font-mono text-[12.5px] text-muted-foreground">{i.alias || '—'}</td>` cell after the port cell.
- Bump the empty-state row `colSpan` from `5` to `6`.

- [ ] **Step 6: Run test to verify it passes + typecheck**

Run: `cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/plugins/xray/InboundDialog.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/hg/project/Shepherd
git add web/src/api/plugins.ts web/src/pages/admin/plugins/xray/InboundDialog.tsx web/src/pages/admin/plugins/xray/InboundsTab.tsx web/src/pages/admin/plugins/xray/InboundDialog.test.tsx
git commit -m "feat(web/xray): inbound alias field in form + list"
```

---

## Task 8: frontend — sing-box form/table/fixture

**Files:**
- Modify: `web/src/pages/admin/plugins/singbox/InboundDialog.tsx`
- Modify: `web/src/pages/admin/plugins/singbox/InboundsTab.tsx`
- Test: `web/src/pages/admin/plugins/singbox/InboundDialog.test.tsx`

(TS types were added in Task 7 Step 1.)

- [ ] **Step 1: Update the singbox test fixture + write form test**

In `web/src/pages/admin/plugins/singbox/InboundDialog.test.tsx`, add `alias: '',` to the `inbound` fixture (after `tag: 'landing-abc',`).

Add a create-submits-alias test (mirror the file's existing helper/mocks):

```tsx
it('submits alias on create', async () => {
  const create = vi.spyOn(pluginsAPI, 'createSingboxInbound').mockResolvedValue({} as never)
  renderDialog({}) // file's existing render helper, create mode
  fireEvent.change(screen.getByLabelText(/alias/i), { target: { value: '🇸🇬 SG 01' } })
  fireEvent.click(screen.getByRole('button', { name: /create|save/i }))
  await waitFor(() => expect(create).toHaveBeenCalled())
  expect(create.mock.calls[0][0]).toMatchObject({ alias: '🇸🇬 SG 01' })
})
```

> Implementer note: match the file's actual render helper, mock target, and submit-button label.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/plugins/singbox/InboundDialog.test.tsx`
Expected: FAIL — no `/alias/i` labelled input.

- [ ] **Step 3: Add alias state, wiring, and input to the singbox dialog**

In `web/src/pages/admin/plugins/singbox/InboundDialog.tsx`:

Add state (after the `sni` state):

```tsx
const [alias, setAlias] = useState<string>(initial?.alias ?? '')
```

Add `alias` to the `save` mutation's `body` object (after `port`):

```tsx
      alias: alias || undefined,
```

Add the input after the port/protocol grid (match the file's `labelCls`/`inputCls` pattern):

```tsx
<div>
  <Label className={labelCls} htmlFor="ib-alias">Alias (optional)</Label>
  <Input id="ib-alias" className={inputCls}
    value={alias} onChange={(e) => setAlias(e.target.value)}
    placeholder="可选：节点别名，留空用默认命名" />
</div>
```

- [ ] **Step 4: Add the Alias column to the singbox table**

In `web/src/pages/admin/plugins/singbox/InboundsTab.tsx`:
- Add a `<th>…>Alias</th>` header after the Port header.
- Add a `<td className="px-3 py-2 font-mono text-[12.5px] text-muted-foreground">{i.alias || '—'}</td>` cell after the port cell.
- Bump the empty-state row `colSpan` from `5` to `6`.

- [ ] **Step 5: Run test to verify it passes + typecheck**

Run: `cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/plugins/singbox/InboundDialog.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/hg/project/Shepherd
git add web/src/pages/admin/plugins/singbox/InboundDialog.tsx web/src/pages/admin/plugins/singbox/InboundsTab.tsx web/src/pages/admin/plugins/singbox/InboundDialog.test.tsx
git commit -m "feat(web/singbox): inbound alias field in form + list"
```

---

## Task 9: docs + full-suite verification

**Files:**
- Modify: `docs/subgen.md`

- [ ] **Step 1: Document alias naming in subgen docs**

In `docs/subgen.md`, in the "分流分类" / node-naming area (near the top "订阅" or template section), add a short paragraph:

```markdown
## 节点命名与别名

默认情况下,订阅里每个节点名按 `<国旗> <服务器名> <协议>` 生成(如 `🇺🇸 Tokyo vless`)。在 xray / sing-box 的 inbound 上设置 **别名(Alias)** 后,该节点在所有订阅里直接用别名命名(原样输出,国旗/协议都不再自动添加,需要的话自己写进别名)。留空则回退默认命名。若多个节点解析出相同名字(别名重复或与默认名撞车),渲染时自动追加 ` 2`/` 3` 去重,避免客户端因重名报错。
```

- [ ] **Step 2: Commit docs**

```bash
cd /Users/hg/project/Shepherd
git add docs/subgen.md
git commit -m "docs(subgen): document inbound alias node naming"
```

- [ ] **Step 3: Full Go suite + gofmt + vet**

Run: `cd /Users/hg/project/Shepherd && go build ./... && go test ./... && gofmt -l internal/ && go vet ./...`
Expected: build OK; all packages PASS; gofmt prints nothing; vet clean.

- [ ] **Step 4: Full frontend typecheck + tests**

Run: `cd /Users/hg/project/Shepherd/web && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all vitest suites PASS.

- [ ] **Step 5: Restore embedded build artifact if touched**

If any frontend build ran and deleted `internal/web/dist/.gitkeep`, restore it:

Run: `cd /Users/hg/project/Shepherd && git checkout -- internal/web/dist/.gitkeep 2>/dev/null; git status --short`
Expected: clean tree (or only intended changes).

---

## Self-Review Notes

- **Spec coverage:** alias column both plugins (Tasks 2,4) ✓; alias-replace naming (Task 1) ✓; de-dup over full node set incl. custom nodes (Task 1, `Assemble`) ✓; create+edit API (Tasks 3,5) ✓; forms + list display both plugins (Tasks 7,8) ✓; tests at every layer ✓; docs (Task 9) ✓; out-of-scope items (per-sub alias, DB uniqueness) intentionally absent ✓.
- **Type consistency:** `Alias`/`alias` field name used uniformly across Go structs (`Inbound`, `InboundPatch`, `xrayLite`, `singboxLite`, `xrayRow`, `singboxRow`), JSON tag `alias`, TS `alias`, and `aliasOrDefault`/`dedupeNodeNames` helper names are stable across tasks.
- **Migration/scan safety:** column is `NOT NULL DEFAULT ''` so `SELECT *` into the non-pointer `Alias string` never hits NULL; existing rows backfill to `''` → behaviour unchanged until an alias is set.
- **Test-helper caveat:** Tasks 2–8 reuse each test file's *existing* fixtures/helpers; the plan flags this explicitly rather than inventing helper names, since exact harness names weren't pinned during exploration.
