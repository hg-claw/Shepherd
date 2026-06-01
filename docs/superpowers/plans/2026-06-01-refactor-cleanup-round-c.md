# Refactor / Cleanup Cluster (Audit Round C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the 5 duplicated JSON responders behind one `internal/httpjson`, dedup the sing-box transport renderers, hoist the CN mirror const + a `cnFlag` helper, and remove the audit-blessed dead code — all behaviour-preserving.

**Architecture:** New `internal/httpjson` owns the single JSON-response impl; each package keeps its local wrapper name delegating to it (no call-site churn). `buildTransport` backs both transport renderers (preserving the inbound `method=PUT`/`quic` drift). `internal/ghmirror.Prefix` replaces three copies of the gh-proxy literal. Dead code is removed by function name (not line number), keeping `Migrations()`, `TopologyStore.Delete`, and the topology structs.

**Tech Stack:** Go 1.25 (stdlib `encoding/json`/`net/http`), golangci-lint, `deadcode`.

**Spec:** `docs/superpowers/specs/2026-06-01-refactor-cleanup-round-c-design.md`

---

## File Structure

- `internal/httpjson/httpjson.go` (new) — `Write`/`Error` (Task 1).
- `internal/api/jsonio.go`, `internal/plugins/{netquality/routes.go, subgen/httputil.go, singbox/inbounds_routes.go, xray/inbounds_routes.go}` — wrappers delegate (Task 2).
- `internal/plugins/singbox/render.go` — `buildTransport` (Task 3).
- `internal/ghmirror/ghmirror.go` (new) + `internal/plugins/{singbox,xray}/release.go` + `internal/api/admin_servers.go` — CN const + `cnFlag` (Task 4).
- Dead-code deletions across `internal/api/audit_routes.go`, `internal/plugins/subgen/store.go`, `internal/plugins/xray/{routes.go, topology.go, config.go, config_test.go}` (Task 5).

---

## Task 1: `internal/httpjson` package

**Files:**
- Create: `internal/httpjson/httpjson.go`
- Test: `internal/httpjson/httpjson_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/httpjson/httpjson_test.go`:

```go
package httpjson

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestWrite(t *testing.T) {
	w := httptest.NewRecorder()
	Write(w, 201, map[string]int{"n": 7})
	if w.Code != 201 {
		t.Fatalf("code=%d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type=%q", ct)
	}
	var got map[string]int
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || got["n"] != 7 {
		t.Fatalf("body=%q err=%v", w.Body.String(), err)
	}
}

func TestWriteNilBodyNoEncode(t *testing.T) {
	w := httptest.NewRecorder()
	Write(w, 204, nil)
	if w.Body.Len() != 0 {
		t.Fatalf("nil body should not encode, got %q", w.Body.String())
	}
}

func TestError(t *testing.T) {
	w := httptest.NewRecorder()
	Error(w, 400, "bad input")
	if w.Code != 400 {
		t.Fatalf("code=%d", w.Code)
	}
	var got map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if got["error"] != "bad input" {
		t.Fatalf("body=%q", w.Body.String())
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/httpjson/ -v`
Expected: FAIL — package/functions don't exist.

- [ ] **Step 3: Implement**

Create `internal/httpjson/httpjson.go`:

```go
package httpjson

import (
	"encoding/json"
	"net/http"
)

// Write encodes body as JSON with the given status. A nil body writes no
// payload (preserving the api package's 204-style behaviour). Single response
// writer shared by the api package and every plugin.
func Write(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if body != nil {
		_ = json.NewEncoder(w).Encode(body)
	}
}

// Error writes a {"error": msg} envelope with the given status.
func Error(w http.ResponseWriter, code int, msg string) {
	Write(w, code, map[string]string{"error": msg})
}
```

- [ ] **Step 4: Run to verify pass**

Run: `go test ./internal/httpjson/ -v`
Expected: PASS (3 tests). Then `gofmt -l internal/httpjson/` (nothing), `go vet ./internal/httpjson/`.

- [ ] **Step 5: Commit**

```bash
git add internal/httpjson/
git commit -m "refactor(httpjson): shared JSON response writers (Write/Error)"
```

---

## Task 2: Delegate the 5 wrappers to httpjson

**Files:**
- Modify: `internal/api/jsonio.go`, `internal/plugins/netquality/routes.go`, `internal/plugins/subgen/httputil.go`, `internal/plugins/singbox/inbounds_routes.go`, `internal/plugins/xray/inbounds_routes.go`

This is behaviour-preserving (no new test; existing suites + build guard). After each edit, `go build` may report an unused `encoding/json` import in files whose only json use was the wrapper — remove that import where flagged.

- [ ] **Step 1: api/jsonio.go**

Replace the `writeJSON` and `writeError` bodies (keep `decodeJSON` and the `encoding/json` import — `decodeJSON` still uses it). Add the import `"github.com/hg-claw/Shepherd/internal/httpjson"`:

```go
func writeJSON(w http.ResponseWriter, status int, body any) {
	httpjson.Write(w, status, body)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	httpjson.Error(w, status, msg)
}
```

- [ ] **Step 2: netquality/routes.go**

Add the httpjson import. Replace the two helpers:

```go
func writeJSON(w http.ResponseWriter, code int, v any) {
	httpjson.Write(w, code, v)
}

func writeErr(w http.ResponseWriter, code int, err error) {
	httpjson.Error(w, code, err.Error())
}
```

- [ ] **Step 3: subgen/httputil.go**

This file's ONLY funcs are the two wrappers, so `encoding/json` becomes unused — replace the file body so it imports only `net/http` + httpjson:

```go
package subgen

import (
	"net/http"

	"github.com/hg-claw/Shepherd/internal/httpjson"
)

// writeJSON encodes v as JSON with the given status code.
func writeJSON(w http.ResponseWriter, code int, v any) {
	httpjson.Write(w, code, v)
}

// writeErr renders {"error": msg} with the given status code.
func writeErr(w http.ResponseWriter, code int, err error) {
	httpjson.Error(w, code, err.Error())
}
```

- [ ] **Step 4: singbox/inbounds_routes.go**

Add the httpjson import. Replace the two helpers:

```go
func writeJSON(w http.ResponseWriter, code int, body any) {
	httpjson.Write(w, code, body)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	httpjson.Error(w, code, msg)
}
```

- [ ] **Step 5: xray/inbounds_routes.go**

Add the httpjson import. Replace `writeJSONResp` (leave `writeRouteError`, which composes on `writeJSONResp`):

```go
func writeJSONResp(w http.ResponseWriter, code int, body any) {
	httpjson.Write(w, code, body)
}
```

- [ ] **Step 6: Build + fix imports + test**

Run: `cd /Users/hg/project/Shepherd && go build ./...`
If a file errors `"encoding/json" imported and not used`, remove that import from THAT file (its only json use was the wrapper). Re-run until build is clean. Then:
`go test ./internal/api/ ./internal/plugins/netquality/ ./internal/plugins/subgen/ ./internal/plugins/singbox/ ./internal/plugins/xray/`
Expected: all PASS (wire output unchanged). `gofmt -l` the 5 files (nothing), `golangci-lint run ./internal/...`.

- [ ] **Step 7: Commit**

```bash
git add internal/api/jsonio.go internal/plugins/netquality/routes.go internal/plugins/subgen/httputil.go internal/plugins/singbox/inbounds_routes.go internal/plugins/xray/inbounds_routes.go
git commit -m "refactor(api): route all writeJSON/writeErr helpers through internal/httpjson"
```

---

## Task 3: `buildTransport` (sing-box)

**Files:**
- Modify: `internal/plugins/singbox/render.go`
- Test: `internal/plugins/singbox/render_test.go` (extend)

- [ ] **Step 1: Write the failing test**

Append to `internal/plugins/singbox/render_test.go`:

```go
func TestBuildTransport(t *testing.T) {
	ws := buildTransport("ws", "/p", "h.com", true)
	if ws["path"] != "/p" {
		t.Fatalf("ws path: %v", ws)
	}
	if hdr, ok := ws["headers"].(map[string]any); !ok || hdr["Host"] != "h.com" {
		t.Fatalf("ws headers: %v", ws)
	}
	// inbound http carries method=PUT; upstream http does NOT (preserved drift)
	inHTTP := buildTransport("http", "/p", "h.com", true)
	if inHTTP["method"] != "PUT" {
		t.Fatalf("inbound http should have method=PUT: %v", inHTTP)
	}
	upHTTP := buildTransport("http", "/p", "h.com", false)
	if _, has := upHTTP["method"]; has {
		t.Fatalf("upstream http must NOT have method: %v", upHTTP)
	}
	if hh, ok := upHTTP["host"].([]any); !ok || hh[0] != "h.com" {
		t.Fatalf("http host: %v", upHTTP)
	}
	hu := buildTransport("httpupgrade", "/p", "h.com", false)
	if hu["host"] != "h.com" {
		t.Fatalf("httpupgrade host should be string: %v", hu)
	}
	q := buildTransport("quic", "", "", true)
	if len(q) != 1 || q["type"] != "quic" {
		t.Fatalf("quic should be {type:quic} only: %v", q)
	}
	// no host → no headers/host key
	noHost := buildTransport("ws", "/p", "", true)
	if _, has := noHost["headers"]; has {
		t.Fatalf("ws no-host should omit headers: %v", noHost)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/plugins/singbox/ -run TestBuildTransport -v`
Expected: FAIL — `buildTransport` undefined.

- [ ] **Step 3: Extract `buildTransport` + delegate**

In `internal/plugins/singbox/render.go`, add `buildTransport` and rewrite the two renderers to delegate (replacing their switch bodies):

```go
// buildTransport renders a sing-box transport block. isInbound adds the
// inbound-only fields (http method=PUT, the quic case), preserving the existing
// inbound/upstream difference exactly.
func buildTransport(ttype, path, host string, isInbound bool) map[string]any {
	tr := map[string]any{"type": ttype}
	switch ttype {
	case "ws":
		tr["path"] = path
		if host != "" {
			tr["headers"] = map[string]any{"Host": host}
		}
	case "http":
		tr["path"] = path
		if host != "" {
			tr["host"] = []any{host}
		}
		if isInbound {
			tr["method"] = "PUT"
		}
	case "httpupgrade":
		tr["path"] = path
		if host != "" {
			tr["host"] = host
		}
	case "quic":
		// inbound only; no extra fields
	}
	return tr
}

func renderTransport(ttype string, in InboundView) map[string]any {
	return buildTransport(ttype, strVal(in.TransportPath), strVal(in.TransportHost), true)
}

func renderUpstreamTransport(ttype string, in InboundView) map[string]any {
	return buildTransport(ttype, in.UpstreamTransportPath.String, in.UpstreamTransportHost.String, false)
}
```

- [ ] **Step 4: Run to verify pass**

Run: `go test ./internal/plugins/singbox/ -v`
Expected: PASS (new test + all existing render tests — output is byte-identical). `gofmt -l internal/plugins/singbox/render.go`, `go vet ./internal/plugins/singbox/`.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/singbox/render.go internal/plugins/singbox/render_test.go
git commit -m "refactor(singbox): extract buildTransport (dedup render/renderUpstream transport)"
```

---

## Task 4: CN mirror const + `cnFlag`

**Files:**
- Create: `internal/ghmirror/ghmirror.go`
- Modify: `internal/plugins/singbox/release.go`, `internal/plugins/xray/release.go`, `internal/api/admin_servers.go`
- Test: `internal/api/admin_servers_test.go` (extend)

- [ ] **Step 1: Write the failing test**

Append to `internal/api/admin_servers_test.go`:

```go
func TestCNFlag(t *testing.T) {
	mk := func(q string) *http.Request { return httptest.NewRequest("GET", "/x?"+q, nil) }
	cases := map[string]bool{"cn=1": true, "cn=true": true, "cn=0": false, "cn=yes": false, "": false}
	for q, want := range cases {
		if got := cnFlag(mk(q)); got != want {
			t.Errorf("cnFlag(%q)=%v want %v", q, got, want)
		}
	}
}
```

(Ensure `net/http` and `net/http/httptest` are imported in the test file — add if missing.)

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/api/ -run TestCNFlag -v`
Expected: FAIL — `cnFlag` undefined.

- [ ] **Step 3: Create the shared const**

Create `internal/ghmirror/ghmirror.go`:

```go
package ghmirror

// Prefix wraps a github.com asset/script URL to route it through the
// gh-proxy.com mirror for mainland-China hosts. Single source for the Go side;
// scripts/install-agent.sh carries its own copy (a shell literal can't import).
const Prefix = "https://gh-proxy.com/"
```

- [ ] **Step 4: Replace the two plugin consts**

In `internal/plugins/singbox/release.go`: delete the `CNMirrorPrefix` const (and its doc comment), add the import `"github.com/hg-claw/Shepherd/internal/ghmirror"`, and change the reference sites `dlURL = CNMirrorPrefix + dlURL` / `shaURL = CNMirrorPrefix + shaURL` to use `ghmirror.Prefix`.

In `internal/plugins/xray/release.go`: same — delete the `CNMirrorPrefix` const + comment, import `ghmirror`, change `zipURL = CNMirrorPrefix + zipURL` / `dgstURL = CNMirrorPrefix + dgstURL` to `ghmirror.Prefix`. (Fix the comment at line ~24/86 that references `CNMirrorPrefix` if it now dangles — reword to `ghmirror.Prefix`.)

- [ ] **Step 5: admin_servers.go — const + cnFlag**

In `internal/api/admin_servers.go`:
- Add the import `"github.com/hg-claw/Shepherd/internal/ghmirror"`.
- In `buildInstallCommand`, change `scriptURL = "https://gh-proxy.com/" + scriptURL` to `scriptURL = ghmirror.Prefix + scriptURL`.
- Add the helper:
```go
// cnFlag reports whether the request asks for the CN gh-proxy mirror (?cn=1|true).
func cnFlag(r *http.Request) bool {
	v := r.URL.Query().Get("cn")
	return v == "1" || v == "true"
}
```
- Replace BOTH inline parses `cn := r.URL.Query().Get("cn") == "1" || r.URL.Query().Get("cn") == "true"` (two sites) with `cn := cnFlag(r)`.

- [ ] **Step 6: Build + test**

Run: `cd /Users/hg/project/Shepherd && go build ./... && go test ./internal/api/ ./internal/plugins/singbox/ ./internal/plugins/xray/`
Expected: build OK; tests PASS. Confirm no remaining `CNMirrorPrefix`: `grep -rn "CNMirrorPrefix" internal` → nothing. `gofmt -l` the touched files; `golangci-lint run ./internal/...`.

- [ ] **Step 7: Commit**

```bash
git add internal/ghmirror/ internal/plugins/singbox/release.go internal/plugins/xray/release.go internal/api/admin_servers.go internal/api/admin_servers_test.go
git commit -m "refactor: hoist CN gh-proxy mirror to internal/ghmirror + extract cnFlag helper"
```

---

## Task 5: Remove dead code (audit-blessed set only)

**Files:**
- Modify: `internal/api/audit_routes.go`, `internal/plugins/subgen/store.go`, `internal/plugins/xray/routes.go`, `internal/plugins/xray/topology.go`, `internal/plugins/xray/config.go`, `internal/plugins/xray/config_test.go`

Delete by FUNCTION NAME (not line number). After each file, `go build ./...`.

- [ ] **Step 1: AuditAPI.CSV**

In `internal/api/audit_routes.go`, delete the `func (a *AuditAPI) CSV(...)` method in full. Run `go build ./...`; if it reports an unused import or helper that `CSV` alone used, remove it. (Do NOT remove anything still used by other AuditAPI methods.)

- [ ] **Step 2: subgen Store.TemplateByName**

In `internal/plugins/subgen/store.go`, delete `func (s *Store) TemplateByName(...)` (and its doc comment). `go build ./...`.

- [ ] **Step 3: xray topologyHandler + dead TopologyStore methods**

In `internal/plugins/xray/routes.go`, delete `func topologyHandler(...)` (and its doc comment). Confirm via `grep -rn "topologyHandler" internal/plugins/xray` that it has NO remaining reference (it's unmounted) — if a registration line exists, remove it too.

In `internal/plugins/xray/topology.go`, delete these methods ONLY: `now`, `Get`, `UpsertLanding`, `UpsertRelay`, `ListByUpstream`, `ListWithUpstreamName`. **KEEP** `func (s *TopologyStore) Delete(...)` and the `TopologyStore`/`Topology`/`TopologyView` type declarations. `go build ./...` (must stay green — `Delete` is called from `xray.go` and `inbounds_routes.go`).

- [ ] **Step 4: xray config.go dead renderers + their tests**

In `internal/plugins/xray/config.go`, delete `RenderTemplate`, `renderVLESSReality`, `renderVMessWS`, `renderShadowsocks`. **KEEP** `NormaliseRaw`.

In `internal/plugins/xray/config_test.go`, delete the 4 tests that call `RenderTemplate`: `TestRenderTemplate_VLESSReality`, `TestRenderTemplate_RejectsUnknownInbound`, `TestRenderTemplate_VLESSReality_Relay`, `TestRenderTemplate_VLESSReality_Landing_UnchangedShape`. **KEEP** `TestNormaliseRaw_AcceptsValidJSON` and `TestNormaliseRaw_RejectsInvalidJSON`.

Then: `grep -rn "TemplateRequest\|TopologyRef\|LandingRef" internal/plugins/xray` — if those structs (defined in config.go) are now referenced ONLY by deleted code (no matches outside their declarations), delete them from config.go too; if anything else references them, KEEP them. Run `go build ./internal/plugins/xray/` and fix any unused-import fallout in config.go / config_test.go.

- [ ] **Step 5: Verify the deletions are correct**

Run:
```bash
cd /Users/hg/project/Shepherd
go build ./... && go test ./internal/api/ ./internal/plugins/subgen/ ./internal/plugins/xray/
go run golang.org/x/tools/cmd/deadcode@latest ./... 2>/dev/null | grep -E "AuditAPI.CSV|TemplateByName|topologyHandler|RenderTemplate|renderVLESSReality|renderVMessWS|renderShadowsocks|TopologyStore.(now|Get|UpsertLanding|UpsertRelay|ListByUpstream|ListWithUpstreamName)" && echo "STILL DEAD (unexpected)" || echo "deleted set gone"
go run golang.org/x/tools/cmd/deadcode@latest ./... 2>/dev/null | grep -E "Migrations|TopologyStore.Delete" && echo "WARNING: a KEEP item is flagged — confirm it was not deleted" || echo "keeps intact"
```
Expected: build OK; tests PASS; "deleted set gone"; `TopologyStore.Delete` and `Migrations` NOT among deleted (still present in the tree — grep them to confirm they exist: `grep -rn "func.*TopologyStore) Delete\|func Migrations" internal/plugins/xray`).

- [ ] **Step 6: Commit**

```bash
git add internal/api/audit_routes.go internal/plugins/subgen/store.go internal/plugins/xray/routes.go internal/plugins/xray/topology.go internal/plugins/xray/config.go internal/plugins/xray/config_test.go
git commit -m "chore: remove audit-confirmed dead code (keep Migrations, TopologyStore.Delete)"
```

---

## Task 6: Full verification

**Files:** none.

- [ ] **Step 1: Backend gates**

Run: `gofmt -l ./internal/... ./cmd/... && go build ./... && go test -race ./... && golangci-lint run`
Expected: no gofmt output for files we touched; build OK; tests PASS; linter clean.

- [ ] **Step 2: Duplication/keep sweep**

Run:
```bash
cd /Users/hg/project/Shepherd
grep -rn "CNMirrorPrefix" internal           # expect 0 (all → ghmirror.Prefix)
grep -rln "func writeJSON\b" internal | wc -l # wrappers remain but all delegate (impl is single)
grep -rn "func Migrations\|TopologyStore) Delete" internal/plugins/xray  # KEEPs still present
```
Expected: 0 `CNMirrorPrefix`; `Migrations`/`Delete` still present.

- [ ] **Step 3: Frontend unaffected**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: clean (no frontend change in this round).

---

## Self-Review

- **Spec coverage:** httpjson package → Task 1; 5-wrapper delegation → Task 2; buildTransport → Task 3; ghmirror const + cnFlag → Task 4; dead-code (audit-blessed, keeping Migrations/Delete/structs) → Task 5; gates → Task 6. All spec items mapped.
- **Type consistency:** `httpjson.Write(w, code, body any)` / `httpjson.Error(w, code, msg string)` defined in Task 1 and consumed unchanged in Task 2; `buildTransport(ttype, path, host string, isInbound bool)` (Task 3) matches both delegators; `ghmirror.Prefix` (Task 4) replaces the two consts + the inline literal; `cnFlag(r *http.Request) bool` (Task 4) replaces both inline parses.
- **Placeholders:** none — full code in every step; deletions are by function name (line-shift-robust) with explicit keep lists and grep-gated struct removal.
- **Risk note:** Task 2's only fiddly point is per-file unused-`encoding/json` imports after delegation — Step 6 builds and removes them. Task 5 keeps `Migrations()` (false positives) and `TopologyStore.Delete`+structs (live); Step 5 asserts both survive.
