# Subgen cert/SNI auto skip-cert-verify — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** For managed sing-box inbounds, auto-set `Node.Insecure` (→ `skip-cert-verify` in the subscription) when the inbound's cert domain doesn't match its SNI.

**Architecture:** subgen-only. A pure `certMatchesSNI(certDomain, sni)` helper (exact + single-label wildcard, case-insensitive). `collectSingbox` LEFT JOINs `singbox_certificates` (own + upstream for forward relays), and sets `Insecure` on the node when a cert is present, SNI is non-empty, and they don't match.

**Tech Stack:** Go, sqlx, SQLite (subgen tests hand-roll the inbound/cert tables).

**Spec:** `docs/superpowers/specs/2026-05-28-subgen-cert-sni-insecure-design.md`

**No DB schema change, no UI change, xray untouched.** Run from `/Users/hg/project/Shepherd`; never `git checkout`/`reset`/`stash` (commit on `feat/subgen-cert-sni-insecure`).

---

## Task 1: `certMatchesSNI` helper + unit tests

**Files:**
- Modify: `internal/plugins/subgen/node.go`
- Test: `internal/plugins/subgen/node_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/plugins/subgen/node_test.go`:

```go
func TestCertMatchesSNI(t *testing.T) {
	cases := []struct {
		cert, sni string
		want      bool
	}{
		{"vpn.example.com", "vpn.example.com", true},  // exact
		{"VPN.Example.com", "vpn.example.COM", true},  // case-insensitive
		{"vpn.example.com", "www.bing.com", false},    // mismatch (camouflage)
		{"*.example.com", "a.example.com", true},      // wildcard single-label
		{"*.example.com", "example.com", false},       // wildcard does NOT match apex
		{"*.example.com", "a.b.example.com", false},   // wildcard does NOT match multi-label
		{"*.example.com", "example.com.evil.com", false},
		{"", "a.com", false},                          // empty cert
		{"a.com", "", false},                          // empty sni
	}
	for _, c := range cases {
		if got := certMatchesSNI(c.cert, c.sni); got != c.want {
			t.Errorf("certMatchesSNI(%q,%q)=%v want %v", c.cert, c.sni, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run TestCertMatchesSNI -v`
Expected: FAIL — `undefined: certMatchesSNI`.

- [ ] **Step 3: Implement the helper**

Add to `internal/plugins/subgen/node.go` (near the other pure helpers like `nodeName`; `strings` is already imported):

```go
// certMatchesSNI reports whether sni is covered by certDomain, case-insensitively.
// True when they are exactly equal, or when certDomain is a "*.base" wildcard and
// sni is a single-label subdomain of base (not the apex, not multi-label).
func certMatchesSNI(certDomain, sni string) bool {
	c := strings.ToLower(strings.TrimSpace(certDomain))
	s := strings.ToLower(strings.TrimSpace(sni))
	if c == "" || s == "" {
		return false
	}
	if c == s {
		return true
	}
	if strings.HasPrefix(c, "*.") {
		base := c[1:] // ".example.com"
		if strings.HasSuffix(s, base) {
			label := s[:len(s)-len(base)]
			return label != "" && !strings.Contains(label, ".")
		}
	}
	return false
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run TestCertMatchesSNI -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/plugins/subgen/node.go internal/plugins/subgen/node_test.go
git commit -m "feat(subgen): certMatchesSNI helper (exact + single-label wildcard)"
```

---

## Task 2: cert/SNI insecure decision in collectSingbox

**Files:**
- Modify: `internal/plugins/subgen/node.go` (`singboxLite` + `singboxInboundToNode`)
- Modify: `internal/plugins/subgen/collect.go` (`singboxRow`, query, both build branches, new `certDomainMismatch`)
- Test: `internal/plugins/subgen/collect_test.go`

- [ ] **Step 1: Add `Insecure` to `singboxLite` and wire it in `singboxInboundToNode`**

In `internal/plugins/subgen/node.go`:
- Add `Insecure bool` to the `singboxLite` struct (e.g. after `ExtraJSON *string`).
- In `singboxInboundToNode`, before the final `n.Name = aliasOrDefault(...)` line, add: `n.Insecure = in.Insecure`.

- [ ] **Step 2: Update existing singbox collect tests' DDL (they must not break)**

The new query (next step) LEFT JOINs `singbox_certificates` on `i.cert_id` / `u.cert_id`. The three existing tests that hand-roll `singbox_inbounds` (`TestCollectNodes_Singbox`, `TestCollectNodes_SkipsForwardRelay`, `TestCollectNodes_ForwardRelayUsesLandingCreds`) currently have neither a `cert_id` column nor a `singbox_certificates` table, so they'd error with `no such column: i.cert_id` / `no such table: singbox_certificates`. In EACH of those three tests:
- Append `, cert_id INTEGER` to the `CREATE TABLE singbox_inbounds (...)` column list.
- Immediately after that `CREATE TABLE`, add:
  ```go
  d.MustExec(`CREATE TABLE singbox_certificates (id INTEGER PRIMARY KEY, domain TEXT)`)
  ```
No row changes needed — those inbounds have NULL `cert_id`, so the cert LEFT JOIN yields NULL and `Insecure` stays false (their existing assertions are unaffected).

- [ ] **Step 3: Write failing tests (new behavior)**

Add to `internal/plugins/subgen/collect_test.go`:

```go
func TestCollectNodes_SingboxCertSNIInsecure(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	d := s.DB
	d.MustExec(`CREATE TABLE singbox_inbounds (
		id INTEGER PRIMARY KEY, server_id INTEGER, tag TEXT, alias TEXT, port INTEGER, role TEXT, relay_mode TEXT, protocol TEXT,
		uuid TEXT, flow TEXT, password TEXT, sni TEXT, reality_public_key TEXT, reality_short_id TEXT,
		transport_path TEXT, transport_host TEXT, ss_method TEXT, extra_json TEXT, upstream_inbound_id INTEGER, cert_id INTEGER)`)
	d.MustExec(`CREATE TABLE singbox_certificates (id INTEGER PRIMARY KEY, domain TEXT)`)
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,country_code) VALUES (1,'s','1.1.1.1','JP')`)
	d.MustExec(`INSERT INTO singbox_certificates(id,domain) VALUES (1,'vpn.example.com'),(2,'*.example.com')`)

	cases := []struct {
		id           int
		sni          string
		certID       interface{} // nil → no cert
		wantInsecure bool
	}{
		{10, "vpn.example.com", 1, false}, // exact match → secure
		{11, "www.bing.com", 1, true},     // camouflage mismatch → skip
		{12, "a.example.com", 2, false},   // wildcard match → secure
		{13, "", 1, false},                // empty SNI → secure
		{14, "vpn.example.com", nil, false}, // no cert → secure
	}
	for _, c := range cases {
		d.MustExec(`INSERT INTO singbox_inbounds(id,server_id,tag,port,role,relay_mode,protocol,sni,password,cert_id)
		            VALUES (?,1,'t',443,'landing','proxy','anytls',?,'pw',?)`, c.id, c.sni, c.certID)
	}
	for _, c := range cases {
		nodes, warns, err := CollectNodes(ctx, d, []Selection{{Source: "singbox", InboundID: int64(c.id)}})
		if err != nil {
			t.Fatalf("id %d: %v", c.id, err)
		}
		if len(warns) != 0 || len(nodes) != 1 {
			t.Fatalf("id %d: nodes=%+v warns=%v", c.id, nodes, warns)
		}
		if nodes[0].Insecure != c.wantInsecure {
			t.Errorf("id %d (sni=%q certID=%v): Insecure=%v want %v", c.id, c.sni, c.certID, nodes[0].Insecure, c.wantInsecure)
		}
	}
}

func TestCollectNodes_ForwardRelayCertSNIInsecure(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	d := s.DB
	d.MustExec(`CREATE TABLE singbox_inbounds (
		id INTEGER PRIMARY KEY, server_id INTEGER, tag TEXT, alias TEXT, port INTEGER, role TEXT, relay_mode TEXT, protocol TEXT,
		uuid TEXT, flow TEXT, password TEXT, sni TEXT, reality_public_key TEXT, reality_short_id TEXT,
		transport_path TEXT, transport_host TEXT, ss_method TEXT, extra_json TEXT, upstream_inbound_id INTEGER, cert_id INTEGER)`)
	d.MustExec(`CREATE TABLE singbox_certificates (id INTEGER PRIMARY KEY, domain TEXT)`)
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,country_code) VALUES (1,'jp','1.1.1.1','JP'),(2,'hk','2.2.2.2','HK')`)
	d.MustExec(`INSERT INTO singbox_certificates(id,domain) VALUES (1,'vpn.example.com')`)
	// landing 40: cert mismatch (camouflage SNI). landing 42: cert matches SNI.
	d.MustExec(`INSERT INTO singbox_inbounds(id,server_id,tag,port,role,relay_mode,protocol,sni,password,cert_id)
	            VALUES (40,1,'landX',8443,'landing','proxy','anytls','www.bing.com','pw',1)`)
	d.MustExec(`INSERT INTO singbox_inbounds(id,server_id,tag,port,role,relay_mode,protocol,sni,password,cert_id)
	            VALUES (42,1,'landOK',8443,'landing','proxy','anytls','vpn.example.com','pw',1)`)
	// forward relays pointing at each
	d.MustExec(`INSERT INTO singbox_inbounds(id,server_id,tag,port,role,relay_mode,protocol,upstream_inbound_id)
	            VALUES (41,2,'rlyX',443,'relay','forward','anytls',40)`)
	d.MustExec(`INSERT INTO singbox_inbounds(id,server_id,tag,port,role,relay_mode,protocol,upstream_inbound_id)
	            VALUES (43,2,'rlyOK',443,'relay','forward','anytls',42)`)

	get := func(id int64) Node {
		nodes, warns, err := CollectNodes(ctx, d, []Selection{{Source: "singbox", InboundID: id}})
		if err != nil || len(warns) != 0 || len(nodes) != 1 {
			t.Fatalf("id %d: nodes=%+v warns=%v err=%v", id, nodes, warns, err)
		}
		return nodes[0]
	}
	// relay over a camouflage-SNI landing → insecure; endpoint is the relay's
	if n := get(41); !n.Insecure || n.Server != "2.2.2.2" {
		t.Errorf("relay over mismatched landing: %+v", n)
	}
	// relay over a matching-SNI landing → secure
	if n := get(43); n.Insecure {
		t.Errorf("relay over matched landing should be secure: %+v", n)
	}
}
```

- [ ] **Step 4: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run 'CollectNodes_SingboxCertSNIInsecure|CollectNodes_ForwardRelayCertSNIInsecure' -v`
Expected: FAIL — `no such column: i.cert_id` (query not joined yet) and/or Insecure always false.

- [ ] **Step 5: Add cert fields + joins + decision in `collect.go`**

In `internal/plugins/subgen/collect.go`:

(a) Add to `singboxRow` (after `UpExtraJSON`, before `SrvName`):

```go
	CertDomain      sql.NullString `db:"cert_domain"`
	UpCertDomain    sql.NullString `db:"upstream_cert_domain"`
```

(b) In `collectSingbox`, update the query — add the two cert columns to the SELECT and the two cert LEFT JOINs. The SELECT's `s.name AS srv_name ...` line becomes preceded by:

```go
		       c.domain AS cert_domain, uc.domain AS upstream_cert_domain,
		       s.name AS srv_name, s.ssh_host AS srv_host, s.country_code AS srv_country
		  FROM singbox_inbounds i
		  JOIN servers s ON s.id=i.server_id
		  LEFT JOIN singbox_inbounds u ON u.id=i.upstream_inbound_id
		  LEFT JOIN singbox_certificates c ON c.id=i.cert_id
		  LEFT JOIN singbox_certificates uc ON uc.id=u.cert_id
		 WHERE i.id=$1`, id)
```

(c) Add a helper at the bottom of `collect.go`:

```go
// certDomainMismatch reports whether a cert is present with a non-empty SNI that
// the cert does not cover — i.e. the client must skip cert verification.
func certDomainMismatch(certDomain string, sni sql.NullString) bool {
	if certDomain == "" || !sni.Valid || sni.String == "" {
		return false
	}
	return !certMatchesSNI(certDomain, sni.String)
}
```

(d) In the forward-relay branch, compute insecure from the UPSTREAM cert + upstream SNI and pass it. The branch's `singboxInboundToNode(singboxLite{...})` becomes:

```go
		n := singboxInboundToNode(singboxLite{
			Tag: r.Tag, Alias: r.Alias, Port: r.Port, Protocol: r.UpProtocol.String, Role: r.Role, RelayMode: r.RelayMode,
			UUID: ns(r.UpUUID), Flow: ns(r.UpFlow), Password: ns(r.UpPassword), SNI: ns(r.UpSNI),
			RealityPublicKey: ns(r.UpRealityPub), RealityShortID: ns(r.UpRealitySID),
			TransportPath: ns(r.UpTransportPath), TransportHost: ns(r.UpTransportHost),
			SSMethod: ns(r.UpSSMethod), ExtraJSON: ns(r.UpExtraJSON),
			Insecure: certDomainMismatch(r.UpCertDomain.String, r.UpSNI),
		}, serverLite{Name: r.SrvName, Host: r.SrvHost.String, Country: r.SrvCountry.String})
```

(e) In the own-fields branch (landing / proxy-relay), the final `singboxInboundToNode(singboxLite{...})` becomes:

```go
	n := singboxInboundToNode(singboxLite{
		Tag: r.Tag, Alias: r.Alias, Port: r.Port, Protocol: r.Protocol, Role: r.Role, RelayMode: r.RelayMode,
		UUID: ns(r.UUID), Flow: ns(r.Flow), Password: ns(r.Password), SNI: ns(r.SNI),
		RealityPublicKey: ns(r.RealityPub), RealityShortID: ns(r.RealitySID),
		TransportPath: ns(r.TransportPath), TransportHost: ns(r.TransportHost),
		SSMethod: ns(r.SSMethod), ExtraJSON: ns(r.ExtraJSON),
		Insecure: certDomainMismatch(r.CertDomain.String, r.SNI),
	}, serverLite{Name: r.SrvName, Host: r.SrvHost.String, Country: r.SrvCountry.String})
```

- [ ] **Step 6: Run to verify pass**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run CollectNodes -v`
Expected: PASS (new cert/SNI tests + the three updated existing tests + the rest).

- [ ] **Step 7: Full subgen package + gofmt/vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ && gofmt -l internal/plugins/subgen/node.go internal/plugins/subgen/collect.go && go vet ./internal/plugins/subgen/`
Expected: PASS; gofmt prints nothing; vet clean.

- [ ] **Step 8: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/plugins/subgen/node.go internal/plugins/subgen/collect.go internal/plugins/subgen/collect_test.go
git commit -m "feat(subgen): auto skip-cert-verify when sing-box cert domain != SNI"
```

---

## Task 3: Full verification

- [ ] **Step 1: Full Go suite (with -race, matching CI) + vet + build**

Run: `cd /Users/hg/project/Shepherd && go build ./... && go test -race ./internal/plugins/subgen/... && go test ./... && go vet ./...`
Expected: build OK; subgen race-clean; all packages PASS; vet clean.

- [ ] **Step 2: gofmt on changed files**

Run: `cd /Users/hg/project/Shepherd && gofmt -l internal/plugins/subgen/node.go internal/plugins/subgen/collect.go`
Expected: prints nothing.

- [ ] **Step 3: Confirm clean tree**

Run: `cd /Users/hg/project/Shepherd && git status --short`
Expected: clean.

---

## Self-Review Notes

- **Spec coverage:** match rule helper (Task 1) ✓; insecure decision with cert-present + non-empty-SNI guard (Task 2c `certDomainMismatch`) ✓; direct landing/proxy-relay uses own cert vs own SNI (Task 2e) ✓; forward relay uses upstream cert vs upstream SNI (Task 2d) ✓; no-cert/reality → secure (NULL cert_domain → guard false) ✓; empty SNI → secure (guard) ✓; xray untouched, no DB/UI change ✓.
- **Type consistency:** `certMatchesSNI(string,string) bool` (node.go) ↔ used by `certDomainMismatch(string, sql.NullString) bool` (collect.go) ↔ `singboxLite.Insecure bool` ↔ `n.Insecure = in.Insecure`. `cert_domain`/`upstream_cert_domain` aliases ↔ `CertDomain`/`UpCertDomain` fields.
- **Test-DDL reality:** subgen tests hand-roll tables; the new join needs `cert_id` on `singbox_inbounds` + a `singbox_certificates(id, domain)` table — added to the three existing singbox tests (Step 2) and the two new tests. Existing rows keep NULL cert_id → Insecure false → their assertions unaffected.
- **Renderer reuse:** no renderer change needed — `Node.Insecure` already drives `skip-cert-verify` across Surge (incl. anytls/hy2/tuic from the prior feature), Clash, ShadowRocket.
- **CI gate:** Task 3 runs `go test -race`.
