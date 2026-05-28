# Subgen: forward-mode relays + Surge insecure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** (1) Emit `skip-cert-verify` for insecure anytls/hysteria2/tuic nodes in Surge (+ tuic in Clash); (2) render sing-box forward-mode relays as nodes (landing creds + relay host:port) instead of skipping them.

**Architecture:** Pure subgen changes. Part 1 is renderer-only (`render_surge.go`, `render_clash.go`) keyed off the already-parsed `Node.Insecure`. Part 2 adds an upstream-landing `LEFT JOIN` to `collectSingbox` and builds the forward-relay node from the upstream's protocol/creds with the relay's own server:port.

**Tech Stack:** Go, sqlx, SQLite (tests hand-roll the inbound tables — subgen does not run the singbox/xray migrations).

**Spec:** `docs/superpowers/specs/2026-05-27-subgen-relay-insecure-design.md`

**No frontend change** — the subscription inbound-picker already lists relay inbounds as selectable; this only fixes rendering. **No DB schema change.** Run from `/Users/hg/project/Shepherd`; never `git checkout`/`reset`/`stash` (commit on `feat/subgen-relay-insecure`).

---

## Task 1: Surge + Clash `skip-cert-verify` for anytls / hysteria2 / tuic

**Files:**
- Modify: `internal/plugins/subgen/render_surge.go` (`proxyLine`)
- Modify: `internal/plugins/subgen/render_clash.go` (`clashProxy`, tuic case)
- Test: `internal/plugins/subgen/render_surge_test.go`, `internal/plugins/subgen/render_clash_test.go`

- [ ] **Step 1: Write failing tests**

Add to `internal/plugins/subgen/render_surge_test.go`:

```go
func TestSurge_InsecureSkipCertVerify(t *testing.T) {
	mk := func(proto string, insecure bool) string {
		im := Intermediate{
			Nodes:  []Node{{Name: "n", Protocol: proto, Server: "1.1.1.1", Port: 443, Password: "p", UUID: "u", SNI: "s.com", Insecure: insecure}},
			Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"n"}}},
			Rules:  []Rule{{Final: true, Target: "PROXY"}},
		}
		return (&SurgeRenderer{}).Render(im, "x", DefaultRulesetBase)
	}
	for _, proto := range []string{"anytls", "hysteria2", "tuic"} {
		if out := mk(proto, true); !strings.Contains(out, "skip-cert-verify=true") {
			t.Errorf("%s insecure: missing skip-cert-verify\n%s", proto, out)
		}
		if out := mk(proto, false); strings.Contains(out, "skip-cert-verify=true") {
			t.Errorf("%s secure: unexpected skip-cert-verify\n%s", proto, out)
		}
	}
}
```

Add to `internal/plugins/subgen/render_clash_test.go`:

```go
func TestClash_TUICInsecureSkipCertVerify(t *testing.T) {
	im := Intermediate{
		Nodes:  []Node{{Name: "t", Protocol: "tuic", Server: "1.1.1.1", Port: 443, Password: "p", UUID: "u", SNI: "s.com", Insecure: true}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"t"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}
	out := (&ClashRenderer{}).Render(im, "x", DefaultRulesetBase)
	if !strings.Contains(out, "skip-cert-verify: true") {
		t.Fatalf("tuic insecure: missing skip-cert-verify\n%s", out)
	}
}
```

> Implementer note: confirm `ClashRenderer`'s constructor/usage matches sibling clash tests in `render_clash_test.go` (e.g. `(&ClashRenderer{}).Render(...)`); mirror their exact call style if different. `strings` is already imported in both test files.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run 'Surge_InsecureSkipCertVerify|Clash_TUICInsecureSkipCertVerify' -v`
Expected: FAIL — anytls/hysteria2/tuic Surge lines and clash tuic lack `skip-cert-verify`.

- [ ] **Step 3: Add `skip-cert-verify` to the three Surge cases**

In `internal/plugins/subgen/render_surge.go` `proxyLine`, the current cases are:

```go
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
```

Change to (add the `n.Insecure` block to each, after the `sni=` segment — matching the trojan/vless pattern):

```go
	case "hysteria2":
		fmt.Fprintf(&b, "%s = hysteria2, %s, %d, password=%s", n.Name, n.Server, n.Port, n.Password)
		if n.SNI != "" {
			b.WriteString(", sni=" + n.SNI)
		}
		if n.Insecure {
			b.WriteString(", skip-cert-verify=true")
		}
	case "tuic":
		fmt.Fprintf(&b, "%s = tuic, %s, %d, password=%s, uuid=%s", n.Name, n.Server, n.Port, n.Password, n.UUID)
		if n.SNI != "" {
			b.WriteString(", sni=" + n.SNI)
		}
		if n.Insecure {
			b.WriteString(", skip-cert-verify=true")
		}
		if cc, ok := n.Extra["congestion_control"].(string); ok && cc != "" {
			b.WriteString(", congestion-controller=" + cc)
		}
	case "anytls":
		fmt.Fprintf(&b, "%s = anytls, %s, %d, password=%s", n.Name, n.Server, n.Port, n.Password)
		if n.SNI != "" {
			b.WriteString(", sni=" + n.SNI)
		}
		if n.Insecure {
			b.WriteString(", skip-cert-verify=true")
		}
```

- [ ] **Step 4: Add `skip-cert-verify` to the Clash tuic case**

In `internal/plugins/subgen/render_clash.go` `clashProxy`, the current tuic case is:

```go
	case "tuic":
		p["type"] = "tuic"
		p["uuid"] = n.UUID
		p["password"] = n.Password
		if n.SNI != "" {
			p["sni"] = n.SNI
		}
		if cc, ok := n.Extra["congestion_control"].(string); ok && cc != "" {
			p["congestion-controller"] = cc
		}
```

Add the insecure block (matching the anytls/hysteria2 cases above it):

```go
	case "tuic":
		p["type"] = "tuic"
		p["uuid"] = n.UUID
		p["password"] = n.Password
		if n.SNI != "" {
			p["sni"] = n.SNI
		}
		if n.Insecure {
			p["skip-cert-verify"] = true
		}
		if cc, ok := n.Extra["congestion_control"].(string); ok && cc != "" {
			p["congestion-controller"] = cc
		}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run 'Surge_InsecureSkipCertVerify|Clash_TUICInsecureSkipCertVerify' -v`
Expected: PASS.

- [ ] **Step 6: Run the full subgen package + gofmt/vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ && gofmt -l internal/plugins/subgen/render_surge.go internal/plugins/subgen/render_clash.go && go vet ./internal/plugins/subgen/`
Expected: PASS; gofmt prints nothing; vet clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/plugins/subgen/render_surge.go internal/plugins/subgen/render_clash.go internal/plugins/subgen/render_surge_test.go internal/plugins/subgen/render_clash_test.go
git commit -m "feat(subgen): emit skip-cert-verify for insecure anytls/hysteria2/tuic (Surge + Clash tuic)"
```

---

## Task 2: sing-box forward-mode relay → node (collect.go)

**Files:**
- Modify: `internal/plugins/subgen/collect.go` (`singboxRow`, `collectSingbox`)
- Test: `internal/plugins/subgen/collect_test.go`

- [ ] **Step 1: Write/adjust tests**

In `internal/plugins/subgen/collect_test.go`:

(a) Both singbox tests hand-roll the `singbox_inbounds` table but omit `upstream_inbound_id`, which the new query joins on. Add `upstream_inbound_id INTEGER` to the inline DDL in **`TestCollectNodes_Singbox`** and **`TestCollectNodes_SkipsForwardRelay`** (append it to the column list, e.g. after `extra_json TEXT`). `TestCollectNodes_SkipsForwardRelay`'s relay (id 30) has no upstream, so it now hits the "upstream missing" skip branch — still 0 nodes + 1 warning, so its assertions hold; update its comment to "forward relay with missing upstream is skipped".

(b) Add a new positive test:

```go
func TestCollectNodes_ForwardRelayUsesLandingCreds(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	d := s.DB
	d.MustExec(`CREATE TABLE singbox_inbounds (
		id INTEGER PRIMARY KEY, server_id INTEGER, tag TEXT, alias TEXT, port INTEGER, role TEXT, relay_mode TEXT, protocol TEXT,
		uuid TEXT, flow TEXT, password TEXT, sni TEXT, reality_public_key TEXT, reality_short_id TEXT,
		transport_path TEXT, transport_host TEXT, ss_method TEXT, extra_json TEXT, upstream_inbound_id INTEGER)`)
	// landing on the JP server (its own creds)
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,country_code) VALUES (1,'jp','1.1.1.1','JP')`)
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,country_code) VALUES (2,'hk','2.2.2.2','HK')`)
	d.MustExec(`INSERT INTO singbox_inbounds(id,server_id,tag,port,role,relay_mode,protocol,uuid,sni,reality_public_key,reality_short_id)
	            VALUES (40,1,'land',8443,'landing','proxy','vless-reality','LU','landing.example.com','LPBK','ab')`)
	// forward relay on the HK server pointing at the landing (no own creds)
	d.MustExec(`INSERT INTO singbox_inbounds(id,server_id,tag,port,role,relay_mode,protocol,upstream_inbound_id)
	            VALUES (41,2,'rly',443,'relay','forward','vless-reality',40)`)

	nodes, warns, err := CollectNodes(ctx, d, []Selection{{Source: "singbox", InboundID: 41}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(warns) != 0 {
		t.Fatalf("unexpected warns: %v", warns)
	}
	if len(nodes) != 1 {
		t.Fatalf("expected 1 node, got %+v", nodes)
	}
	n := nodes[0]
	// connects to the RELAY's server:port …
	if n.Server != "2.2.2.2" || n.Port != 443 {
		t.Errorf("relay endpoint: got %s:%d", n.Server, n.Port)
	}
	// … but with the LANDING's protocol + creds + reality
	if n.Protocol != "vless" || n.UUID != "LU" || n.SNI != "landing.example.com" || n.RealityPublicKey != "LPBK" || n.RealityShortID != "ab" {
		t.Errorf("relay should use landing creds: %+v", n)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run 'CollectNodes_ForwardRelayUsesLandingCreds|CollectNodes_Singbox|CollectNodes_SkipsForwardRelay' -v`
Expected: FAIL — `no such column: i.upstream_inbound_id` (query not updated) for the singbox tests, and the new test errors.

- [ ] **Step 3: Add upstream fields to `singboxRow`**

In `internal/plugins/subgen/collect.go`, add to the `singboxRow` struct (after `ExtraJSON`, before `SrvName`):

```go
	UpProtocol      sql.NullString `db:"upstream_protocol"`
	UpUUID          sql.NullString `db:"upstream_uuid"`
	UpFlow          sql.NullString `db:"upstream_flow"`
	UpPassword      sql.NullString `db:"upstream_password"`
	UpSNI           sql.NullString `db:"upstream_sni"`
	UpRealityPub    sql.NullString `db:"upstream_reality_public_key"`
	UpRealitySID    sql.NullString `db:"upstream_reality_short_id"`
	UpTransportPath sql.NullString `db:"upstream_transport_path"`
	UpTransportHost sql.NullString `db:"upstream_transport_host"`
	UpSSMethod      sql.NullString `db:"upstream_ss_method"`
	UpExtraJSON     sql.NullString `db:"upstream_extra_json"`
```

- [ ] **Step 4: Join the upstream landing in the query + handle forward relays**

In `collectSingbox`, replace the query and the forward-relay skip. The query becomes:

```go
	err := db.GetContext(ctx, &r, `
		SELECT i.tag, COALESCE(i.alias,'') AS alias, i.port, i.protocol, i.role, i.relay_mode, i.uuid, i.flow, i.password, i.sni,
		       i.reality_public_key, i.reality_short_id, i.transport_path, i.transport_host,
		       i.ss_method, i.extra_json,
		       u.protocol AS upstream_protocol, u.uuid AS upstream_uuid, u.flow AS upstream_flow,
		       u.password AS upstream_password, u.sni AS upstream_sni,
		       u.reality_public_key AS upstream_reality_public_key, u.reality_short_id AS upstream_reality_short_id,
		       u.transport_path AS upstream_transport_path, u.transport_host AS upstream_transport_host,
		       u.ss_method AS upstream_ss_method, u.extra_json AS upstream_extra_json,
		       s.name AS srv_name, s.ssh_host AS srv_host, s.country_code AS srv_country
		  FROM singbox_inbounds i
		  JOIN servers s ON s.id=i.server_id
		  LEFT JOIN singbox_inbounds u ON u.id=i.upstream_inbound_id
		 WHERE i.id=$1`, id)
```

Replace the forward-relay skip block:

```go
	if r.Role == "relay" && r.RelayMode == "forward" {
		return Node{}, fmt.Sprintf("singbox %s on %s: forward-mode relay not supported in subscriptions, skipped", r.Tag, r.SrvName), nil
	}
```

with a build-from-upstream block:

```go
	if r.Role == "relay" && r.RelayMode == "forward" {
		// Forward relays are transparent forwarders: the client connects to the
		// relay's host:port but speaks the LANDING's protocol/creds. Build the
		// node from the upstream landing, keeping the relay's own server:port.
		if !r.UpProtocol.Valid || r.UpProtocol.String == "" {
			return Node{}, fmt.Sprintf("singbox %s on %s: forward relay upstream landing missing, skipped", r.Tag, r.SrvName), nil
		}
		n := singboxInboundToNode(singboxLite{
			Tag: r.Tag, Alias: r.Alias, Port: r.Port, Protocol: r.UpProtocol.String, Role: r.Role, RelayMode: r.RelayMode,
			UUID: ns(r.UpUUID), Flow: ns(r.UpFlow), Password: ns(r.UpPassword), SNI: ns(r.UpSNI),
			RealityPublicKey: ns(r.UpRealityPub), RealityShortID: ns(r.UpRealitySID),
			TransportPath: ns(r.UpTransportPath), TransportHost: ns(r.UpTransportHost),
			SSMethod: ns(r.UpSSMethod), ExtraJSON: ns(r.UpExtraJSON),
		}, serverLite{Name: r.SrvName, Host: r.SrvHost.String, Country: r.SrvCountry.String})
		return n, "", nil
	}
```

(The existing landing / proxy-relay build below it — using the inbound's own
fields — stays unchanged.)

- [ ] **Step 5: Run to verify pass**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run 'CollectNodes' -v`
Expected: PASS (all CollectNodes tests, incl. the new forward-relay test and the updated skip test).

- [ ] **Step 6: Full subgen package + gofmt/vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ && gofmt -l internal/plugins/subgen/collect.go && go vet ./internal/plugins/subgen/`
Expected: PASS; gofmt prints nothing; vet clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/plugins/subgen/collect.go internal/plugins/subgen/collect_test.go
git commit -m "feat(subgen): render sing-box forward-mode relays via upstream landing creds"
```

---

## Task 3: Full verification

- [ ] **Step 1: Full Go suite (with -race, matching CI) + vet + build**

Run: `cd /Users/hg/project/Shepherd && go build ./... && go test -race ./internal/plugins/subgen/... && go test ./... && go vet ./...`
Expected: build OK; subgen race-clean; all packages PASS; vet clean.

- [ ] **Step 2: gofmt on changed files**

Run: `cd /Users/hg/project/Shepherd && gofmt -l internal/plugins/subgen/render_surge.go internal/plugins/subgen/render_clash.go internal/plugins/subgen/collect.go`
Expected: prints nothing (these subgen files are kept gofmt-clean).

- [ ] **Step 3: Confirm clean tree**

Run: `cd /Users/hg/project/Shepherd && git status --short`
Expected: clean (all changes committed).

---

## Self-Review Notes

- **Spec coverage:** Part 1 Surge anytls/hy2/tuic insecure (Task 1) ✓; Clash tuic parity (Task 1) ✓; ShadowRocket inherits Surge (no code — embeds SurgeRenderer) ✓; Part 2 forward-relay via upstream join (Task 2) ✓; missing-upstream skip (Task 2) ✓; proxy-relay/landing/xray unchanged (Task 2 leaves the own-fields path) ✓; no UI/DB change ✓.
- **Type consistency:** `singboxRow.Up*` fields ↔ `upstream_*` SQL aliases ↔ `singboxLite` fields passed to `singboxInboundToNode` are consistent. `ns()` helper reused. `Node.Insecure` is the field already set by the share-link parser; renderers now read it.
- **Test-DDL reality:** subgen tests hand-roll `singbox_inbounds`; the only missing column for the new self-join is `upstream_inbound_id`, added to the two existing singbox tests + the new one. The `upstream_*` SELECT columns reference real `singbox_inbounds` columns that already exist in the inline DDL.
- **CI gate:** Task 3 runs `go test -race` (the check that caught the v0.12.0 issue) before finishing.
