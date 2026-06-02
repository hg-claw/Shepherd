# Mobile R1 — Backend Bearer-Token Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let non-browser clients authenticate to `/api/admin/*` (HTTP + WebSocket) with `Authorization: Bearer <session-token>`, and let login optionally return that token — without changing the browser cookie flow.

**Architecture:** Reuse the existing session token as the bearer credential. One `auth.BearerToken` parser feeds both `RequireAdmin` (cookie OR bearer) and `Logout` (revoke by bearer when no cookie). `Login` returns the token in the body only when the caller opts in (`client:"mobile"` or `?token=1`).

**Tech Stack:** Go 1.25 (stdlib `net/http`/`strings`), existing `internal/auth` session store.

**Spec:** `docs/superpowers/specs/2026-06-01-mobile-r1-bearer-token-auth-design.md` (sub-project R1 of the Expo mobile-app initiative).

---

## File Structure

- `internal/auth/middleware.go` — `BearerToken` + `Handler.sessionToken` + `RequireAdmin` bearer support (Task 1).
- `internal/api/admin_auth.go` — `loginReq.Client`, opt-in token in `Login`, bearer revoke in `Logout` (Task 2).

---

## Task 1: `RequireAdmin` accepts a bearer token

**Files:**
- Modify: `internal/auth/middleware.go`
- Test: `internal/auth/auth_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `internal/auth/auth_test.go` (it already imports `context`, `net/http`, `net/http/httptest`, `testing` and has `newTestStore`):

```go
func TestRequireAdmin_BearerToken(t *testing.T) {
	s := newTestStore(t)
	a, err := s.CreateAdmin(context.Background(), "bob", "pw")
	if err != nil {
		t.Fatal(err)
	}
	sess, err := s.IssueSession(context.Background(), a.ID)
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{Store: s, Secure: false}
	called := false
	srv := h.RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if adm, ok := AdminFromContext(r.Context()); !ok || adm.ID != a.ID {
			t.Errorf("admin not in context")
		}
	}))

	// Valid bearer → passes.
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Authorization", "Bearer "+sess.Token)
	srv.ServeHTTP(w, r)
	if w.Code != 200 || !called {
		t.Fatalf("bearer should pass: code=%d called=%v", w.Code, called)
	}

	// Bearer takes precedence over a garbage cookie.
	called = false
	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/", nil)
	r.AddCookie(&http.Cookie{Name: h.CookieName(), Value: "garbage"})
	r.Header.Set("Authorization", "Bearer "+sess.Token)
	srv.ServeHTTP(w, r)
	if w.Code != 200 || !called {
		t.Fatalf("valid bearer + bad cookie should pass: code=%d", w.Code)
	}

	// Invalid / revoked bearer → 401.
	if err := s.RevokeSession(context.Background(), sess.Token); err != nil {
		t.Fatal(err)
	}
	called = false
	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Authorization", "Bearer "+sess.Token)
	srv.ServeHTTP(w, r)
	if w.Code != 401 || called {
		t.Fatalf("revoked bearer should 401: code=%d called=%v", w.Code, called)
	}

	// Empty bearer value → 401.
	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Authorization", "Bearer ")
	srv.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatalf("empty bearer should 401: code=%d", w.Code)
	}
}

func TestBearerToken(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Authorization", "Bearer abc123")
	if got := BearerToken(r); got != "abc123" {
		t.Fatalf("got %q", got)
	}
	r2 := httptest.NewRequest("GET", "/", nil)
	r2.Header.Set("Authorization", "bearer xyz") // case-insensitive scheme
	if got := BearerToken(r2); got != "xyz" {
		t.Fatalf("case-insensitive: got %q", got)
	}
	if got := BearerToken(httptest.NewRequest("GET", "/", nil)); got != "" {
		t.Fatalf("no header: got %q", got)
	}
	r3 := httptest.NewRequest("GET", "/", nil)
	r3.Header.Set("Authorization", "Basic abc")
	if got := BearerToken(r3); got != "" {
		t.Fatalf("non-bearer scheme: got %q", got)
	}
}
```

(The existing cookie-path test `TestRequireAdminRejectsAnonymous` and any cookie-success test stay as the web-parity guard.)

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/auth/ -run 'TestRequireAdmin_BearerToken|TestBearerToken' -v`
Expected: FAIL — `BearerToken` undefined; `RequireAdmin` ignores the header (401 on the valid-bearer case).

- [ ] **Step 3: Implement**

In `internal/auth/middleware.go`, add `"strings"` to the import block. Add the `BearerToken` helper + `sessionToken`, and rewrite `RequireAdmin` to use `sessionToken`:

```go
// BearerToken returns the token from an "Authorization: Bearer <token>" header
// (scheme is case-insensitive), or "" if absent / a different scheme.
func BearerToken(r *http.Request) string {
	a := r.Header.Get("Authorization")
	const p = "Bearer "
	if len(a) <= len(p) || !strings.EqualFold(a[:len(p)], p) {
		return ""
	}
	return strings.TrimSpace(a[len(p):])
}

// sessionToken returns the caller's session token from the bearer header
// (preferred for non-browser clients) or the session cookie.
func (h *Handler) sessionToken(r *http.Request) string {
	if t := BearerToken(r); t != "" {
		return t
	}
	if c, err := r.Cookie(h.CookieName()); err == nil {
		return c.Value
	}
	return ""
}

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

- [ ] **Step 4: Run to verify pass**

Run: `go test ./internal/auth/ -v`
Expected: PASS (new tests + all existing auth tests, incl. the cookie-path ones). `gofmt -l internal/auth/middleware.go` (nothing), `go vet ./internal/auth/`.

- [ ] **Step 5: Commit**

```bash
git add internal/auth/middleware.go internal/auth/auth_test.go
git commit -m "feat(auth): RequireAdmin accepts Authorization: Bearer (reuse session token)"
```

---

## Task 2: Login opt-in token + Logout bearer revoke

**Files:**
- Modify: `internal/api/admin_auth.go`
- Test: `internal/api/admin_auth_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `internal/api/admin_auth_test.go` (it has `newAuthAPI(t)` seeding admin `alice`/`hunter2`, and imports `bytes`, `encoding/json`, `net/http`, `net/http/httptest`, `testing`; add `"github.com/hg-claw/Shepherd/internal/auth"` if not already imported):

```go
func loginBody(t *testing.T, a *AuthAPI, req loginReq, query string) (int, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(req)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/login"+query, bytes.NewReader(body))
	a.Login(w, r)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func TestLogin_MobileReturnsToken(t *testing.T) {
	a, _ := newAuthAPI(t)
	code, out := loginBody(t, a, loginReq{Username: "alice", Password: "hunter2", Client: "mobile"}, "")
	if code != 200 {
		t.Fatalf("status=%d", code)
	}
	tok, _ := out["token"].(string)
	if tok == "" {
		t.Fatal("mobile login must return a token")
	}
	// The token authenticates a RequireAdmin request.
	h := a.Auth
	called := false
	srv := h.RequireAdmin(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/admin/x", nil)
	r.Header.Set("Authorization", "Bearer "+tok)
	srv.ServeHTTP(w, r)
	if !called || w.Code != 200 {
		t.Fatalf("returned token should authenticate: code=%d called=%v", w.Code, called)
	}
}

func TestLogin_WebOmitsToken(t *testing.T) {
	a, _ := newAuthAPI(t)
	code, out := loginBody(t, a, loginReq{Username: "alice", Password: "hunter2"}, "")
	if code != 200 {
		t.Fatalf("status=%d", code)
	}
	if _, has := out["token"]; has {
		t.Fatal("web login must NOT return a token in the body")
	}
}

func TestLogin_QueryOptInReturnsToken(t *testing.T) {
	a, _ := newAuthAPI(t)
	_, out := loginBody(t, a, loginReq{Username: "alice", Password: "hunter2"}, "?token=1")
	if tok, _ := out["token"].(string); tok == "" {
		t.Fatal("?token=1 should return a token")
	}
}

func TestLogout_BearerRevokes(t *testing.T) {
	a, _ := newAuthAPI(t)
	_, out := loginBody(t, a, loginReq{Username: "alice", Password: "hunter2", Client: "mobile"}, "")
	tok := out["token"].(string)
	// Logout with the bearer token (no cookie).
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/logout", nil)
	r.Header.Set("Authorization", "Bearer "+tok)
	a.Logout(w, r)
	if w.Code != http.StatusNoContent {
		t.Fatalf("logout status=%d", w.Code)
	}
	// The token no longer authenticates.
	if _, _, err := a.Auth.Store.LookupSession(r.Context(), tok); err == nil {
		t.Fatal("token should be revoked after bearer logout")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/api/ -run 'TestLogin_MobileReturnsToken|TestLogin_WebOmitsToken|TestLogin_QueryOptInReturnsToken|TestLogout_BearerRevokes' -v`
Expected: FAIL — `loginReq` has no `Client` field; `Login` never returns `token`; `Logout` doesn't revoke via bearer.

- [ ] **Step 3: Add the `Client` field + opt-in token**

In `internal/api/admin_auth.go`, add the field to `loginReq`:

```go
type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Client   string `json:"client,omitempty"` // "mobile" → also return the token in the body
}
```

In `Login`, replace the final success response (the `a.Auth.SetSessionCookie(w, sess)` + `writeJSON(...)` block) with:

```go
	if a.limit != nil {
		a.limit.reset(ip)
		a.limit.reset(userKey)
	}
	a.Auth.SetSessionCookie(w, sess)
	out := map[string]any{"id": admin.ID, "username": admin.Username}
	if req.Client == "mobile" || r.URL.Query().Get("token") == "1" {
		out["token"] = sess.Token
	}
	writeJSON(w, http.StatusOK, out)
```

- [ ] **Step 4: Add bearer revoke to `Logout`**

In `internal/api/admin_auth.go`, rewrite `Logout` (ensure `"github.com/hg-claw/Shepherd/internal/auth"` is imported — it already is, used for `auth.VerifyPassword`):

```go
func (a *AuthAPI) Logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(a.Auth.CookieName()); err == nil && c.Value != "" {
		_ = a.Auth.Store.RevokeSession(r.Context(), c.Value)
	} else if tok := auth.BearerToken(r); tok != "" {
		_ = a.Auth.Store.RevokeSession(r.Context(), tok)
	}
	a.Auth.ClearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}
```

- [ ] **Step 5: Run to verify pass**

Run: `go test ./internal/api/ -run 'TestLogin|TestLogout' -v`
Expected: PASS (new tests + existing `TestLogin_OK`/`TestLogin_BadCreds`/rate-limit tests). `gofmt -l internal/api/admin_auth.go`, `go vet ./internal/api/`, `golangci-lint run ./internal/api/...`.

- [ ] **Step 6: Commit**

```bash
git add internal/api/admin_auth.go internal/api/admin_auth_test.go
git commit -m "feat(api): login opt-in token (client=mobile) + bearer logout revoke"
```

---

## Task 3: Full verification

**Files:** none.

- [ ] **Step 1: Backend gates**

Run: `gofmt -l internal/auth/ internal/api/admin_auth.go && go build ./... && go test -race ./internal/auth/ ./internal/api/ && golangci-lint run ./internal/...`
Expected: no gofmt output for our files; build OK; tests PASS; linter clean.

- [ ] **Step 2: Full race + web-unaffected**

Run: `go test -race ./... && (cd web && npx tsc --noEmit && npx vitest run)`
Expected: all Go tests PASS; frontend tsc clean + vitest green (the cookie-based web login/`RequireAdmin` path is unchanged).

- [ ] **Step 3: Manual smoke (optional, if a dev server is handy)**

Confirm by reading the final code: `RequireAdmin` calls `sessionToken` (bearer-then-cookie); `Login` adds `out["token"]` only on `client=="mobile"` or `?token=1`; `Logout` revokes via `auth.BearerToken` when no cookie. A live check: `curl -sX POST .../api/login -d '{"username":"...","password":"...","client":"mobile"}'` returns a `token`; `curl .../api/admins/me -H "Authorization: Bearer <token>"` returns the admin.

---

## Self-Review

- **Spec coverage:** `RequireAdmin` bearer + `BearerToken`/`sessionToken` → Task 1; `loginReq.Client` + opt-in token-in-body (`client=mobile` and `?token=1`) → Task 2 Step 3; `Logout` bearer revoke → Task 2 Step 4; web parity (no token without opt-in, cookie path intact) → tests in Tasks 1–2; gates incl. web-unaffected → Task 3. All spec sections mapped.
- **Type consistency:** `auth.BearerToken(r *http.Request) string` defined in Task 1 and reused in Task 2's `Logout`; `Handler.sessionToken`/`RequireAdmin` consistent; `loginReq.Client` field referenced in the `Login` opt-in check matches the struct.
- **Placeholders:** none — complete code in every step; commands have expected output.
- **Risk note:** behaviour-preserving for the browser (login without `client`/`?token=1` is byte-identical; `RequireAdmin` still reads the cookie when no bearer); the rate-limiter ordering in `Login` is untouched.
