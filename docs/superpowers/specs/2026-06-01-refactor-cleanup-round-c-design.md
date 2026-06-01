# Refactor / cleanup cluster (audit Round C, item 9 + dead code) — Design

**Date:** 2026-06-01
**Status:** Approved (scope + approach confirmed via Q&A)
**Source:** `docs/system-optimization-audit.md` (item 9 / "Larger refactors" + dead code)

## Goal

The final audit round: reduce duplication and remove dead code, with minimal
behaviour change and a small conflict surface. Then PR + release.

1. **Consolidate the 5 divergent `writeJSON`/`writeErr` helpers** behind one shared
   implementation.
2. **De-duplicate the two sing-box transport renderers** into one `buildTransport`.
3. **Hoist the CN gh-proxy mirror prefix** to one shared const and extract a
   `cnFlag` request helper.
4. **Remove dead code** — only the audit-blessed safe set (NOT the raw `deadcode`
   output, which contains false positives).

## Confirmed decisions (Q&A)

- **Core only.** The big file splits (`admin_servers.go` 777L, `ServerList.tsx`
  721L) are DEFERRED — pure maintainability, large effort, biggest conflict
  surface, zero runtime value (verifier-downgraded).
- **writeJSON: shared impl + thin per-package wrappers.** A new `internal/httpjson`
  package owns the single implementation; each package keeps its local
  `writeJSON`/`writeErr`/`writeJSONResp` name as a thin delegating wrapper, so the
  ~100 call sites are untouched and an envelope change is made once.
- **Behaviour-preserving.** `buildTransport` keeps the existing inbound-only
  `method=PUT`/`quic` drift (a refactor must not change wire output).
- **Dead-code: audit-blessed set only.** Keep all `Migrations()` (false positives
  — dispatched via the plugin interface; deleting breaks plugins), keep
  `TopologyStore.Delete` + the `Topology`/`TopologyView` structs (live), keep
  `Query.Latest`/`vlog.Enabled`/`agentapi.ValidSID` (conservative).

---

## ① `internal/httpjson` shared JSON responders

**Files:** create `internal/httpjson/httpjson.go`; modify the 5 wrapper sites.

```go
package httpjson

import (
	"encoding/json"
	"net/http"
)

// Write encodes body as JSON with the given status. The single response writer
// shared by the api package and every plugin.
func Write(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

// Error writes a {"error": msg} envelope with the given status.
func Error(w http.ResponseWriter, code int, msg string) {
	Write(w, code, map[string]string{"error": msg})
}
```

Each existing helper becomes a thin wrapper delegating to `httpjson` (names and
signatures unchanged so callers don't change):

- `internal/api/jsonio.go`: `writeJSON(w, status, body)` → `httpjson.Write(w, status, body)`;
  `writeError(w, status, msg string)` → `httpjson.Error(w, status, msg)`.
- `internal/plugins/netquality/routes.go`: `writeJSON(w, code, v)` → `httpjson.Write`;
  `writeErr(w, code, err error)` → `httpjson.Error(w, code, err.Error())`.
- `internal/plugins/subgen/httputil.go`: same as netquality (`writeErr(err error)`).
- `internal/plugins/singbox/inbounds_routes.go`: `writeJSON(w, code, body)` → `httpjson.Write`;
  `writeErr(w, code, msg string)` → `httpjson.Error(w, code, msg)`.
- `internal/plugins/xray/inbounds_routes.go`: `writeJSONResp(w, code, body)` → `httpjson.Write`.

**Note on envelope parity:** the api `writeError` and singbox `writeErr` already
emit `map[string]string{"error": msg}`; netquality/subgen emit `map[string]any` /
`map[string]string` — all produce the byte-identical `{"error":"..."}` wire shape,
so delegating to `httpjson.Error` is behaviour-preserving. If any wrapper currently
emits a DIFFERENT shape (verify each before editing), keep that wrapper's body
as-is rather than forcing it through `httpjson.Error`.

---

## ② `buildTransport` (sing-box)

**File:** `internal/plugins/singbox/render.go`.

`renderTransport(ttype, in)` and `renderUpstreamTransport(ttype, in)` share the
ws/http/httpupgrade builders; they differ only in (a) the field source
(`in.TransportPath/Host` vs `in.UpstreamTransport*`) and (b) inbound-only extras
(`method=PUT` on http, a `quic` case). Extract:

```go
// buildTransport renders a sing-box transport block. isInbound adds the
// inbound-only fields (http method=PUT, the quic case) — preserving the existing
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

This keeps the upstream variant WITHOUT `method=PUT` (the current behaviour) — the
refactor does not "fix" the drift.

---

## ③ CN mirror const + `cnFlag`

**Files:** create `internal/ghmirror/ghmirror.go`; modify
`internal/plugins/singbox/release.go`, `internal/plugins/xray/release.go`,
`internal/api/admin_servers.go`.

```go
package ghmirror

// Prefix wraps a github.com asset/script URL to route it through the
// gh-proxy.com mirror for mainland-China hosts. Single source for the Go side;
// scripts/install-agent.sh carries its own copy (a shell literal can't import).
const Prefix = "https://gh-proxy.com/"
```

- `singbox/release.go` and `xray/release.go`: delete their local
  `const CNMirrorPrefix = "https://gh-proxy.com/"` and use `ghmirror.Prefix` at
  their reference sites (e.g. `dlURL = ghmirror.Prefix + dlURL`).
- `admin_servers.go` `buildInstallCommand`: replace the inline
  `"https://gh-proxy.com/"` with `ghmirror.Prefix`.
- `admin_servers.go`: the `?cn=` parse appears verbatim twice
  (`cn := r.URL.Query().Get("cn") == "1" || r.URL.Query().Get("cn") == "true"`).
  Extract `func cnFlag(r *http.Request) bool { v := r.URL.Query().Get("cn"); return v == "1" || v == "true" }`
  and call it at both sites (lines ~605, ~647). (`in.CN`-driven sites that read a
  JSON body field are unaffected — only the query-string parses are deduped.)

---

## ④ Dead-code removal (audit-blessed set ONLY)

**Delete:**

- `internal/api/audit_routes.go`: `(*AuditAPI).CSV` (never routed; the frontend
  builds CSV client-side). Remove the method; check for and remove any now-unused
  helpers/imports it alone used.
- `internal/plugins/subgen/store.go`: `(*Store).TemplateByName` (unreachable).
- `internal/plugins/xray/routes.go`: `topologyHandler` (orphaned — not mounted;
  the `/topology` route is gone). Confirm it has no registration line to remove
  (deadcode flags it unreachable ⇒ unmounted).
- `internal/plugins/xray/topology.go`: the dead `TopologyStore` methods `now`,
  `Get`, `UpsertLanding`, `UpsertRelay`, `ListByUpstream`, `ListWithUpstreamName`.
- `internal/plugins/xray/config.go`: `RenderTemplate`, `renderVLESSReality`,
  `renderVMessWS`, `renderShadowsocks` (referenced only by `config_test.go`), and
  the corresponding tests in `config_test.go` (delete the whole file if it tests
  ONLY these; otherwise delete just those test funcs + any now-unused helpers).

**KEEP (do NOT delete):**

- `(*TopologyStore).Delete` (live: `xray.go:132`, `inbounds_routes.go:225`) and the
  `TopologyStore`/`Topology`/`TopologyView` type declarations. If `Topology`/
  `TopologyView` become unused after removing the `List*` methods, leaving them is
  harmless (unused types don't break the Go build) — keep them.
- All `Migrations()` (netquality/singbox/xray) and `LoadMigrationsForTest` — false
  positives (dispatched via the plugin interface / used by the test build);
  deleting `Migrations()` would break plugin enablement.
- `Query.Latest`, `vlog.Enabled`, `agentapi.ValidSID` — conservative keep
  (small public/utility surface; orphaned but harmless).

**Order:** remove `config.go` renderers + their tests together (so the package
still compiles); remove the topology methods + handler together; each deletion
followed by `go build ./...`.

---

## Testing

- **`internal/httpjson`** (`httpjson_test.go`): `Write` sets
  `Content-Type: application/json`, the status, and JSON-encodes the body; `Error`
  emits `{"error":"<msg>"}` with the status.
- **`buildTransport`** (extend `internal/plugins/singbox/render_test.go` or a new
  test): `ws` → headers Host when host set; inbound `http` → `method=PUT`; upstream
  `http` (isInbound=false) → NO `method`; `httpupgrade` → host string; `quic`
  inbound → only `{type:quic}`. (Locks the preserved drift.)
- **`cnFlag`** (`admin_servers_test.go`): `cn=1`→true, `cn=true`→true, `cn=0`/
  absent/`cn=yes`→false.
- **Dead-code**: `go build ./...` + `go test -race ./...` stay green (existing
  tests guard behaviour); re-run `deadcode ./...` and confirm the deleted symbols
  are gone AND that no `Migrations`/`TopologyStore.Delete` were removed.
- **Behaviour parity**: the writeJSON wrappers and buildTransport are
  behaviour-preserving — the full existing suite (api + all plugins) must stay
  green.

## Out of scope

- The big file splits (`admin_servers.go`, `ServerList.tsx`) and the
  `dispatchAgentUpdate` extraction — deferred.
- "Fixing" the inbound/upstream transport drift (kept as-is).
- Deleting the deadcode false positives (`Migrations`, etc.) or the conservative
  keeps (`Query.Latest`, …).
- The frontend bundle code-splitting (a separate future item).

## Verification gates

`go build ./...`, `go test -race ./...`, `golangci-lint run`, `gofmt`; frontend
unaffected (`tsc` + `vitest` still green). Re-run `deadcode ./...` to confirm the
intended shrink without touching the keeps.
