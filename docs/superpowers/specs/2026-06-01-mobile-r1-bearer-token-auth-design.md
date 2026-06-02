# Mobile app — R1: backend bearer-token auth — Design

**Date:** 2026-06-01
**Status:** Approved (scope + approach confirmed via Q&A)
**Initiative:** React Native / Expo mobile app for Shepherd (monorepo `mobile/`),
exposing current functionality with remote machine control. Decomposition:
**R1 token auth (this spec)** → R2 Expo skeleton + login → R3 server list +
monitoring → R4 remote terminal → R5 files + scripts → R6 plugins + push/biometrics.
Each round is its own spec → plan → PR → release.

## Goal

Let a non-browser client (the upcoming mobile app) authenticate to the existing
`/api/admin/*` HTTP + WebSocket endpoints with a bearer token, without disturbing
the browser's cookie-based flow. Backend-only; no new schema.

## Key insight

A Shepherd **session token already is a bearer credential**: `IssueSession` mints a
random token row in `sessions`, `LookupSession(token)` validates it and returns the
admin, `RevokeSession(token)` deletes it. The session cookie merely carries that
token. So R1 reuses the session token as the bearer token — no new table, TTL, or
token type.

## Confirmed decisions

- **Bearer = the session token.** Reuse the existing session machinery.
- **WS auth via the `Authorization` header.** React Native's native WebSocket
  supports request headers on iOS/Android, and the WS endpoints already pass
  through `RequireAdmin`, so accepting bearer in `RequireAdmin` covers them. No
  `?access_token=` query fallback (query tokens leak into proxy/server logs).
- **Opt-in token-in-body.** `Login` returns the token in the JSON body ONLY when
  the request opts in, so the browser flow stays cookie-only (token never exposed
  to web JS — preserves the HttpOnly XSS hygiene).

---

## Components

### 1. `RequireAdmin` accepts bearer — `internal/auth/middleware.go`

Extract the session token from EITHER the cookie OR an `Authorization: Bearer
<token>` header, then run the existing `LookupSession` validation. A small helper:

```go
// sessionToken returns the caller's session token from the Authorization bearer
// header (preferred for non-browser clients) or the session cookie. "" if neither.
func (h *Handler) sessionToken(r *http.Request) string {
	if a := r.Header.Get("Authorization"); len(a) > 7 && strings.EqualFold(a[:7], "Bearer ") {
		return strings.TrimSpace(a[7:])
	}
	if c, err := r.Cookie(h.CookieName()); err == nil {
		return c.Value
	}
	return ""
}
```

`RequireAdmin` uses it:

```go
func (h *Handler) RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := h.sessionToken(r)
		if tok == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_, admin, err := h.Store.LookupSession(r.Context(), tok)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), ctxKeyAdmin, admin)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
```

Bearer takes precedence over cookie (a client sending both is treated as the
non-browser case). All `/api/admin/*` HTTP handlers and the WS upgrade endpoints
(`console/ws`, `plugins/{id}/hosts/{server_id}/logs`, `servers/{id}/net-live/ws`)
inherit this since they are mounted under the `RequireAdmin`-gated mux.

### 2. `Login` opt-in token — `internal/api/admin_auth.go`

`loginReq` gains an opt-in signal; the response gains an optional `token`:

```go
type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Client   string `json:"client,omitempty"` // "mobile" → also return the token in the body
}
```

After a successful `IssueSession` + `SetSessionCookie`, build the response body and
add the token when opted in (either `req.Client == "mobile"` or `?token=1`):

```go
	out := map[string]any{"id": admin.ID, "username": admin.Username}
	if req.Client == "mobile" || r.URL.Query().Get("token") == "1" {
		out["token"] = sess.Token
	}
	a.Auth.SetSessionCookie(w, sess)
	writeJSON(w, http.StatusOK, out)
```

The cookie is still set in both cases (harmless for the app, required for web).
The browser login (no `client`/`?token=1`) is byte-identical to today — `token`
absent.

**Login rate-limit interaction:** the existing per-IP/per-username limiter (from
the v0.19.0 hardening) stays in front and is unchanged — the opt-in only affects
the success-response shape.

### 3. `Logout` accepts bearer — `internal/api/admin_auth.go`

`Logout` currently revokes the session named by the cookie. Make it also revoke a
bearer token when there's no cookie:

```go
func (a *AuthAPI) Logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(a.Auth.CookieName()); err == nil && c.Value != "" {
		_ = a.Auth.Store.RevokeSession(r.Context(), c.Value)
	} else if tok := bearerToken(r); tok != "" {
		_ = a.Auth.Store.RevokeSession(r.Context(), tok)
	}
	a.Auth.ClearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}
```

`bearerToken(r)` is a small helper in the api package (parses `Authorization:
Bearer`), or `Logout` reuses `auth`'s extraction — choose one home in the plan;
the api package already has `clientIP`, so a sibling `bearerToken` helper there is
natural.

---

## Data flow

```
mobile login: POST /api/login {username, password, client:"mobile"}
  → 200 {id, username, token}    (token stored in expo-secure-store)
mobile request: GET /api/admin/... + "Authorization: Bearer <token>"
  → RequireAdmin: sessionToken() → bearer → LookupSession → admin in ctx → handler
mobile WS:    new WebSocket(".../console/ws", { headers: { Authorization: "Bearer <token>" } })
  → same RequireAdmin path
mobile logout: POST /api/logout + bearer → RevokeSession(token) → token now 401s
browser: unchanged (cookie set on login, sent automatically, RequireAdmin reads cookie)
```

## Testing

`internal/auth/middleware_test.go` (or extend `auth_test.go`) — build a `Handler`
over a temp sqlite store with a seeded admin + an issued session:
- A request with `Authorization: Bearer <valid-token>` passes `RequireAdmin`
  (reaches the wrapped handler, admin in context).
- A request with the cookie still passes (web path unbroken).
- Bearer takes precedence: garbage cookie + valid bearer → passes.
- Missing/empty/`Bearer ` / invalid / revoked / expired token → 401, handler not
  reached.

`internal/api/admin_auth_test.go`:
- `Login` with `client:"mobile"` → 200 body includes a non-empty `token` that
  subsequently authenticates a `RequireAdmin` request; `Login` without the flag →
  body has NO `token` key (web parity) but still sets the cookie.
- `Login` with `?token=1` query → token returned.
- `Logout` with `Authorization: Bearer <token>` (no cookie) → 204 and the token
  no longer authenticates (revoked).
- The existing `TestLogin_OK`/`TestLogin_BadCreds`/rate-limit tests stay green.

## Out of scope

- The Expo app itself (R2+).
- `?access_token=` query-param WS fallback; token refresh / long-lived "remember
  me"; per-token scopes/labels; device management. All deferrable follow-ups.
- Any change to the agent transport (`/agent/ws` is the agent side, unrelated).

## Verification gates

`go test -race ./...`, `golangci-lint run`, `gofmt`; the web app must be unaffected
(its login/`RequireAdmin` cookie path is unchanged) — `tsc` + `vitest` still green.
Manual: `curl` `/api/login` with `client:"mobile"`, then `curl` an `/api/admin/*`
endpoint with `Authorization: Bearer <token>` → 200.
