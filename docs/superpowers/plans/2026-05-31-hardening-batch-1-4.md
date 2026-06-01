# Hardening + Build Hygiene (Audit Batches 1–4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land four high-priority, low-effort hardening items — bounded rate limiter, login rate-limit/lockout + timing fix, WSConn panic fix, and build hygiene — in one branch, then PR + release.

**Architecture:** Batch 3 first makes `tokenRateLimiter` bounded and splits its API into `blocked`/`record`/`reset` (peek vs count). Batch 2 reuses that limiter to throttle `POST /api/login` by client IP *and* username, plus a constant-time dummy-bcrypt on the not-found path. Batch 1 removes a `send on closed channel` crash by never closing `sendCh`. Batch 4 is mechanical build/git hygiene.

**Tech Stack:** Go 1.25 (stdlib `net`/`sync`/`time`, `golang.org/x/crypto/bcrypt`), Docker BuildKit, Make, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-05-31-hardening-batch-1-4-design.md`

**Order:** 3 → 2 → 1 → 4 (login reuses the bounded limiter). Tasks below are numbered in execution order.

---

## File Structure

- `internal/api/agent_status_ratelimit.go` — bounded sliding-window limiter; new `blocked`/`record`/`reset` + sweep/cap (Task 1).
- `internal/auth/bcrypt.go` — add `DummyHash` const (Task 2).
- `internal/api/admin_auth.go` — `clientIP` helper (Task 3); `AuthAPI.limit` + `InitRateLimit` + new `Login` flow (Task 4).
- `cmd/server/main.go` — wire `authAPI.InitRateLimit(10, 5*time.Minute)` (Task 4).
- `internal/agentsvc/wsconn.go` — never close `sendCh`; `select`-based `writeLoop` (Task 5).
- `.dockerignore`, root `.gitignore`, remove committed vitest cache (Task 6).
- `Dockerfile`, `Makefile`, `.github/workflows/release.yml` — `-s -w -trimpath` + BuildKit cache mounts (Task 7).

---

## Task 1: Bound `tokenRateLimiter` + split API (Batch 3)

**Files:**
- Modify: `internal/api/agent_status_ratelimit.go`
- Test: `internal/api/agent_status_ratelimit_test.go` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `internal/api/agent_status_ratelimit_test.go`:

```go
func TestTokenRateLimiter_BlockedDoesNotIncrement(t *testing.T) {
	lim := newTokenRateLimiter(2, time.Minute)
	// Peeking many times must not accumulate hits.
	for i := 0; i < 5; i++ {
		if lim.blocked("k") {
			t.Fatalf("blocked at peek %d before any record", i)
		}
	}
	lim.record("k")
	lim.record("k")
	if !lim.blocked("k") {
		t.Fatalf("should be blocked after 2 records")
	}
}

func TestTokenRateLimiter_ResetClears(t *testing.T) {
	lim := newTokenRateLimiter(1, time.Minute)
	lim.record("k")
	if !lim.blocked("k") {
		t.Fatalf("should be blocked")
	}
	lim.reset("k")
	if lim.blocked("k") {
		t.Fatalf("reset should clear the key")
	}
}

func TestTokenRateLimiter_SweepEvictsExpiredKeys(t *testing.T) {
	clock := time.Unix(1000, 0)
	lim := newTokenRateLimiter(5, time.Minute)
	lim.now = func() time.Time { return clock }
	lim.record("a")
	lim.record("b")
	// Advance well past the window so a's/b's hits are all expired AND the
	// time-based sweep fires (now - lastSweep >= window).
	clock = clock.Add(3 * time.Minute)
	lim.blocked("c") // any op triggers maybeSweep
	if len(lim.hits) != 0 {
		t.Fatalf("expired keys not swept: %v", lim.hits)
	}
}

func TestTokenRateLimiter_MaxKeysCap(t *testing.T) {
	lim := newTokenRateLimiter(5, time.Minute)
	lim.maxKeys = 2
	lim.record("a")
	lim.record("b")
	lim.record("c") // map full → new key dropped (fail-closed)
	if _, ok := lim.hits["c"]; ok {
		t.Fatalf("new key recorded past maxKeys cap")
	}
	if lim.allow("d") {
		t.Fatalf("allow must fail-closed for a new key when at cap")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/api/ -run TestTokenRateLimiter -v`
Expected: FAIL — `lim.blocked/record/reset undefined`, `lim.maxKeys` undefined.

- [ ] **Step 3: Rewrite the limiter**

Replace the body of `internal/api/agent_status_ratelimit.go` (keep the `package api` + imports `sync`, `time`) with:

```go
package api

import (
	"sync"
	"time"
)

// tokenRateLimiter is a bounded per-key sliding-window counter. Each key gets
// `max` hits per `window`. Expired keys are evicted by an opportunistic sweep
// (time-based or when the map exceeds maxKeys); under a flood of unique keys the
// map is capped at maxKeys and brand-new keys fail closed. Safe for concurrent use.
//
// blocked/record/reset let callers peek without counting (login: peek before
// auth, record only on failure, reset on success); allow() keeps the original
// check-then-increment semantics for the token endpoints.
type tokenRateLimiter struct {
	max       int
	window    time.Duration
	maxKeys   int
	mu        sync.Mutex
	hits      map[string][]time.Time
	lastSweep time.Time
	now       func() time.Time
}

func newTokenRateLimiter(max int, window time.Duration) *tokenRateLimiter {
	return &tokenRateLimiter{
		max:     max,
		window:  window,
		maxKeys: 50_000,
		hits:    map[string][]time.Time{},
		now:     time.Now,
	}
}

// pruneLocked returns key's live (within-window) hits, writing the pruned slice
// back (deleting the key if empty). Caller holds mu.
func (l *tokenRateLimiter) pruneLocked(key string, now time.Time) []time.Time {
	cutoff := now.Add(-l.window)
	prev := l.hits[key]
	kept := prev[:0]
	for _, t := range prev {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(l.hits, key)
	} else {
		l.hits[key] = kept
	}
	return kept
}

// sweepLocked drops every key whose hits are all expired. Caller holds mu.
func (l *tokenRateLimiter) sweepLocked(now time.Time) {
	cutoff := now.Add(-l.window)
	for k, hs := range l.hits {
		alive := false
		for _, t := range hs {
			if t.After(cutoff) {
				alive = true
				break
			}
		}
		if !alive {
			delete(l.hits, k)
		}
	}
	l.lastSweep = now
}

// maybeSweepLocked sweeps on a timer or when the map is over its cap. Caller holds mu.
func (l *tokenRateLimiter) maybeSweepLocked(now time.Time) {
	if now.Sub(l.lastSweep) >= l.window || len(l.hits) >= l.maxKeys {
		l.sweepLocked(now)
	}
}

// addLocked prunes, enforces the cap, and appends a hit. Returns false if the cap
// rejected a brand-new key. Caller holds mu.
func (l *tokenRateLimiter) addLocked(key string, now time.Time) bool {
	kept := l.pruneLocked(key, now)
	if _, exists := l.hits[key]; !exists && len(l.hits) >= l.maxKeys {
		return false
	}
	l.hits[key] = append(kept, now)
	return true
}

// blocked reports whether key is at/over its limit, without recording a hit.
func (l *tokenRateLimiter) blocked(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.maybeSweepLocked(now)
	return len(l.pruneLocked(key, now)) >= l.max
}

// record adds a hit for key (the counting step).
func (l *tokenRateLimiter) record(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.maybeSweepLocked(now)
	l.addLocked(key, now)
}

// reset clears key's counter (e.g. after a successful login).
func (l *tokenRateLimiter) reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.hits, key)
}

// allow is the original check-then-increment: false if at the limit (or capped).
func (l *tokenRateLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.maybeSweepLocked(now)
	if len(l.pruneLocked(key, now)) >= l.max {
		return false
	}
	return l.addLocked(key, now)
}
```

- [ ] **Step 4: Run to verify pass**

Run: `go test -race ./internal/api/ -run TestTokenRateLimiter -v`
Expected: PASS (new tests + the 4 pre-existing `TestTokenRateLimiter_*`). Then `gofmt -l internal/api/agent_status_ratelimit.go` (nothing) and `go vet ./internal/api/`.

- [ ] **Step 5: Commit**

```bash
git add internal/api/agent_status_ratelimit.go internal/api/agent_status_ratelimit_test.go
git commit -m "fix(api): bound tokenRateLimiter map (sweep+cap); add blocked/record/reset"
```

---

## Task 2: `auth.DummyHash` constant (Batch 2 prereq)

**Files:**
- Modify: `internal/auth/bcrypt.go`
- Test: `internal/auth/bcrypt_test.go` (create)

- [ ] **Step 1: Write the failing test**

Create `internal/auth/bcrypt_test.go`:

```go
package auth

import (
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestDummyHashIsValidAndRejects(t *testing.T) {
	if _, err := bcrypt.Cost([]byte(DummyHash)); err != nil {
		t.Fatalf("DummyHash is not a valid bcrypt hash: %v", err)
	}
	if VerifyPassword(DummyHash, "anything") {
		t.Fatal("DummyHash must not verify any input password")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/auth/ -run TestDummyHashIsValidAndRejects -v`
Expected: FAIL — `undefined: DummyHash`.

- [ ] **Step 3: Add the constant**

In `internal/auth/bcrypt.go`, after the `bcryptCost` const, add:

```go
// DummyHash is a valid bcrypt hash (cost 12) of an arbitrary fixed string. It is
// used only to spend constant bcrypt time on the login username-not-found path so
// response latency cannot distinguish a missing user from a wrong password.
const DummyHash = "$2a$12$AHF.apOKYbCydULJSlOhA.kpg4BSLCHiTJEF9Vjhs0WR3e1Aled5q"
```

- [ ] **Step 4: Run to verify pass**

Run: `go test ./internal/auth/ -run TestDummyHashIsValidAndRejects -v`
Expected: PASS. Then `go test ./internal/auth/` (full package green).

- [ ] **Step 5: Commit**

```bash
git add internal/auth/bcrypt.go internal/auth/bcrypt_test.go
git commit -m "feat(auth): add DummyHash for constant-time login not-found path"
```

---

## Task 3: `clientIP` helper (Batch 2)

**Files:**
- Modify: `internal/api/admin_auth.go`
- Test: `internal/api/admin_auth_test.go` (extend)

- [ ] **Step 1: Write the failing test**

Append to `internal/api/admin_auth_test.go`:

```go
func TestClientIP(t *testing.T) {
	cases := map[string]string{
		"1.2.3.4:5678": "1.2.3.4",
		"1.2.3.4":      "1.2.3.4",
		"[::1]:443":    "::1",
	}
	for remote, want := range cases {
		r := httptest.NewRequest("POST", "/api/login", nil)
		r.RemoteAddr = remote
		if got := clientIP(r); got != want {
			t.Errorf("clientIP(%q)=%q want %q", remote, got, want)
		}
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/api/ -run TestClientIP -v`
Expected: FAIL — `undefined: clientIP`.

- [ ] **Step 3: Add the helper**

In `internal/api/admin_auth.go`, add the import `"net"` to the import block and add this function (e.g. at the end of the file):

```go
// clientIP returns the host part of the direct TCP peer (RemoteAddr). NOTE: it
// does NOT honor X-Forwarded-For — doing so safely requires a trusted-proxy
// allowlist and is a deliberate follow-up.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
```

- [ ] **Step 4: Run to verify pass**

Run: `go test ./internal/api/ -run TestClientIP -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/api/admin_auth.go internal/api/admin_auth_test.go
git commit -m "feat(api): clientIP helper (RemoteAddr host)"
```

---

## Task 4: Login rate-limit + lockout + timing (Batch 2)

**Files:**
- Modify: `internal/api/admin_auth.go` (`AuthAPI` struct, new `InitRateLimit`, rewrite `Login`)
- Modify: `cmd/server/main.go` (wire the limiter)
- Test: `internal/api/admin_auth_test.go` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `internal/api/admin_auth_test.go`:

```go
func doLogin(t *testing.T, a *AuthAPI, user, pass string) int {
	t.Helper()
	body, _ := json.Marshal(loginReq{Username: user, Password: pass})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/login", bytes.NewReader(body))
	a.Login(w, r)
	return w.Code
}

func TestLogin_RateLimitedAfterMaxFailures(t *testing.T) {
	a, _ := newAuthAPI(t)
	a.InitRateLimit(3, time.Minute)
	for i := 0; i < 3; i++ {
		if got := doLogin(t, a, "alice", "wrong"); got != http.StatusUnauthorized {
			t.Fatalf("fail %d: status=%d want 401", i, got)
		}
	}
	if got := doLogin(t, a, "alice", "wrong"); got != http.StatusTooManyRequests {
		t.Fatalf("4th attempt: status=%d want 429", got)
	}
}

func TestLogin_SuccessResetsCounter(t *testing.T) {
	a, _ := newAuthAPI(t)
	a.InitRateLimit(3, time.Minute)
	doLogin(t, a, "alice", "wrong")
	doLogin(t, a, "alice", "wrong")
	if got := doLogin(t, a, "alice", "hunter2"); got != http.StatusOK {
		t.Fatalf("good login status=%d want 200", got)
	}
	// Counter reset → a subsequent failure is 401, not 429.
	if got := doLogin(t, a, "alice", "wrong"); got != http.StatusUnauthorized {
		t.Fatalf("after reset: status=%d want 401", got)
	}
}

func TestLogin_UnknownUserIs401(t *testing.T) {
	a, _ := newAuthAPI(t)
	a.InitRateLimit(3, time.Minute)
	if got := doLogin(t, a, "nobody", "whatever"); got != http.StatusUnauthorized {
		t.Fatalf("unknown user status=%d want 401", got)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/api/ -run TestLogin -v`
Expected: FAIL — `a.InitRateLimit undefined`.

- [ ] **Step 3: Add limiter field + InitRateLimit, rewrite Login**

In `internal/api/admin_auth.go`, ensure the import block has `"net"`, `"net/http"`, `"time"`, and `"github.com/hg-claw/Shepherd/internal/auth"`. Change the struct and `Login`:

```go
type AuthAPI struct {
	Auth  *auth.Handler
	limit *tokenRateLimiter // nil → no limiting (e.g. tests that don't init)
}

// InitRateLimit configures per-IP + per-username login throttling. Mirrors
// PublicAPI/SubgenAPI; called from main.go.
func (a *AuthAPI) InitRateLimit(max int, window time.Duration) {
	a.limit = newTokenRateLimiter(max, window)
}

func (a *AuthAPI) Login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	ip := clientIP(r)
	userKey := "user:" + req.Username
	// Peek before any work; do NOT record here, so an attacker cannot extend the
	// lockout window indefinitely — it self-clears `window` after the last failure.
	if a.limit != nil && (a.limit.blocked(ip) || a.limit.blocked(userKey)) {
		writeError(w, http.StatusTooManyRequests, "too many attempts")
		return
	}

	admin, err := a.Auth.Store.FindAdminByUsername(r.Context(), req.Username)
	ok := false
	if err != nil {
		// Constant-time: spend a bcrypt comparison even when the user is unknown,
		// so latency cannot reveal whether the username exists.
		_ = auth.VerifyPassword(auth.DummyHash, req.Password)
	} else {
		ok = auth.VerifyPassword(admin.PasswordHash, req.Password)
	}
	if !ok {
		if a.limit != nil {
			a.limit.record(ip)
			a.limit.record(userKey)
		}
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	sess, err := a.Auth.Store.IssueSession(r.Context(), admin.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "session error")
		return
	}
	if a.limit != nil {
		a.limit.reset(ip)
		a.limit.reset(userKey)
	}
	a.Auth.SetSessionCookie(w, sess)
	writeJSON(w, http.StatusOK, map[string]any{
		"id":       admin.ID,
		"username": admin.Username,
	})
}
```

- [ ] **Step 4: Run to verify pass**

Run: `go test ./internal/api/ -run TestLogin -v`
Expected: PASS (new tests + existing `TestLogin_OK`/`TestLogin_BadCreds`).

- [ ] **Step 5: Wire the limiter in main.go**

In `cmd/server/main.go`, immediately after the line `public.InitRateLimit(30, time.Minute)` (~line 237), add:

```go
	authAPI.InitRateLimit(10, 5*time.Minute)
```

(`authAPI` is constructed earlier at `authAPI := &api.AuthAPI{Auth: authH}`; `time` is already imported.)

- [ ] **Step 6: Run to verify build + package**

Run: `go build ./cmd/server/ && go test -race ./internal/api/ -run 'TestLogin|TestClientIP|TestTokenRateLimiter'`
Expected: build OK; tests PASS. Then `gofmt -l internal/api/admin_auth.go cmd/server/main.go` (nothing) and `golangci-lint run ./internal/api/...` (clean).

- [ ] **Step 7: Commit**

```bash
git add internal/api/admin_auth.go internal/api/admin_auth_test.go cmd/server/main.go
git commit -m "feat(api): rate-limit + lockout + constant-time login (per-IP and per-user)"
```

---

## Task 5: WSConn panic fix (Batch 1)

**Files:**
- Modify: `internal/agentsvc/wsconn.go`
- Test: `internal/agentsvc/wsconn_test.go` (extend)

- [ ] **Step 1: Write the failing/guard tests**

Append to `internal/agentsvc/wsconn_test.go` (it already has `fakeRaw` + imports `sync`, `time`, `errors`, `testing`):

```go
func TestWSConn_ConcurrentSendCloseNoPanic(t *testing.T) {
	// With the old `close(sendCh)` in Close, a concurrent Send racing Close
	// panics ("send on closed channel"), crashing the test binary. The fix must
	// survive many iterations of the race.
	for i := 0; i < 300; i++ {
		c := NewWSConn(&fakeRaw{}, 4, time.Second)
		var wg sync.WaitGroup
		for s := 0; s < 8; s++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for j := 0; j < 20; j++ {
					_ = c.Send(OutFrame{Text: []byte("x")})
				}
			}()
		}
		go c.Close()
		wg.Wait()
		c.Close()
	}
}

func TestWSConn_SendAfterCloseReturnsClosed(t *testing.T) {
	c := NewWSConn(&fakeRaw{}, 4, time.Second)
	c.Close()
	if err := c.Send(OutFrame{Text: []byte("x")}); !errors.Is(err, ErrConnClosed) {
		t.Fatalf("send after close: err=%v want ErrConnClosed", err)
	}
}
```

- [ ] **Step 2: Run to verify the panic/failure**

Run: `go test ./internal/agentsvc/ -run TestWSConn_ConcurrentSendCloseNoPanic -count=1`
Expected: FAIL/CRASH — `panic: send on closed channel` (current `Close` closes `sendCh`). (If a run happens to not hit the window, re-run; the fix makes it deterministically safe.)

- [ ] **Step 3: Apply the fix**

In `internal/agentsvc/wsconn.go`, replace `writeLoop` and `Close`:

```go
func (c *WSConn) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case f := <-c.sendCh:
			if err := c.raw.WriteFrame(f); err != nil {
				c.Close()
				return
			}
		}
	}
}

func (c *WSConn) Close() {
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.raw.Close()
	})
}
```

(`Send` is unchanged: its `case c.sendCh <- f` now targets a channel that is never closed, so it cannot panic; its `case <-c.done` aborts once closed. Do not modify `Send`.)

- [ ] **Step 4: Run to verify pass**

Run: `go test -race ./internal/agentsvc/ -run TestWSConn -count=1 -v`
Expected: PASS (both new tests + existing `TestWSConn_QueuesFrames`, `TestWSConn_SlowConsumerError`). Then `gofmt -l internal/agentsvc/wsconn.go` (nothing) and `go vet ./internal/agentsvc/`.

- [ ] **Step 5: Commit**

```bash
git add internal/agentsvc/wsconn.go internal/agentsvc/wsconn_test.go
git commit -m "fix(agentsvc): never close sendCh — eliminate WSConn send-on-closed-channel panic"
```

---

## Task 6: Git / Docker hygiene (Batch 4a)

**Files:**
- Modify: `.dockerignore`, `.gitignore`
- Remove from git: `node_modules/.vite/vitest/<hash>/results.json`

- [ ] **Step 1: Remove the committed vitest cache + ignore root node_modules**

```bash
cd /Users/hg/project/Shepherd
git rm --cached -r node_modules
```

Then add to the root `.gitignore` (under the existing `# Frontend` section, alongside `/web/node_modules/`):

```
/node_modules/
```

- [ ] **Step 2: Extend `.dockerignore`**

Append to `.dockerignore`:

```
data/
tmp/
*.db-shm
*.db-wal
```

- [ ] **Step 3: Verify**

Run:
```bash
git ls-files | grep -c node_modules   # expect 0
git check-ignore node_modules/x data/dev.db tmp/foo   # expect all three echoed (ignored)
```
Expected: `0` tracked node_modules files; all three paths reported as ignored.

- [ ] **Step 4: Commit**

```bash
git add .dockerignore .gitignore
git commit -m "chore: dockerignore data/tmp, untrack root node_modules vitest cache"
```

---

## Task 7: Go build flags + BuildKit cache mounts (Batch 4b)

**Files:**
- Modify: `Dockerfile`, `Makefile`, `.github/workflows/release.yml`

- [ ] **Step 1: Dockerfile — strip/trim + cache mounts**

In `Dockerfile`, change the `go mod download` RUN to:

```dockerfile
RUN --mount=type=cache,target=/go/pkg/mod go mod download
```

Change the two agent builds (one RUN with `&&`) to add `-trimpath`, `-s -w`, and cache mounts:

```dockerfile
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X github.com/hg-claw/Shepherd/internal/agentconfig.BuildVersion=${VERSION}" \
      -o internal/installer/bin/shepherd-agent-linux-amd64 ./cmd/agent && \
    GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath \
      -ldflags "-s -w -X github.com/hg-claw/Shepherd/internal/agentconfig.BuildVersion=${VERSION}" \
      -o internal/installer/bin/shepherd-agent-linux-arm64 ./cmd/agent
```

Change the server build RUN to:

```dockerfile
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=1 go build -trimpath \
      -ldflags "-s -w -X github.com/hg-claw/Shepherd/internal/config.BuildVersion=${VERSION}" \
      -o /out/shepherd-server ./cmd/server
```

- [ ] **Step 2: Makefile — strip/trim**

In `Makefile`, for the `agent-amd64`, `agent-arm64`, `server`, and `release` recipes, add `-trimpath` to each `go build` and change `-ldflags "-X ...` to `-ldflags "-s -w -X ...`. For example `agent-amd64` becomes:

```make
agent-amd64:
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath \
	  -ldflags "-s -w -X github.com/hg-claw/Shepherd/internal/agentconfig.BuildVersion=$(VERSION)" \
	  -o internal/installer/bin/shepherd-agent-linux-amd64 ./cmd/agent
```

Apply the same `-trimpath` + `-s -w` edit to `agent-arm64` (agentconfig var), `server` (config var), and the `release` recipe's per-arch `go build` (config var). Leave `server-no-web` and `agent` (the quick-iteration recipes with no ldflags) unchanged.

- [ ] **Step 3: release.yml — strip/trim**

In `.github/workflows/release.yml`, the agent cross-compile step: change the inner build to

```yaml
              GOOS=$goos GOARCH=$goarch CGO_ENABLED=0 go build -trimpath \
                -ldflags "-s -w -X github.com/hg-claw/Shepherd/internal/agentconfig.BuildVersion=${VERSION}" \
                -o internal/installer/bin/shepherd-agent-${goos}-${goarch} ./cmd/agent
```

and the native server build step:

```yaml
          CGO_ENABLED=1 \
            go build -trimpath \
            -ldflags "-s -w -X github.com/hg-claw/Shepherd/internal/config.BuildVersion=${VERSION}" \
            -o dist/shepherd-server-linux-${{ matrix.arch }} \
            ./cmd/server
```

- [ ] **Step 4: Verify the builds still work + flags present**

Run:
```bash
cd /Users/hg/project/Shepherd
go build -trimpath -ldflags "-s -w -X github.com/hg-claw/Shepherd/internal/config.BuildVersion=test" -o /tmp/shep-test ./cmd/server && echo SERVER_OK && rm /tmp/shep-test
grep -c -- "-s -w -X" Dockerfile Makefile .github/workflows/release.yml
grep -c "type=cache" Dockerfile
```
Expected: `SERVER_OK`; each file reports ≥1 `-s -w -X` occurrence (Dockerfile 3, Makefile 4, release.yml 2); Dockerfile reports ≥3 `type=cache` mounts.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile Makefile .github/workflows/release.yml
git commit -m "build: strip+trim Go binaries (-s -w -trimpath) and add BuildKit cache mounts"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Backend gates**

Run: `gofmt -l ./internal/... ./cmd/... && go build ./... && go test -race ./... && golangci-lint run`
Expected: gofmt lists only pre-existing files outside this change (none of the files we edited); build OK; tests PASS; linter clean.

- [ ] **Step 2: Frontend untouched-but-verify**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: clean (only Task 6 touched the tree, removing an untracked cache file — no source change).

- [ ] **Step 3: Sanity-check the security behavior end to end**

Confirm by reading the final `Login` that: blocked peek happens before the DB lookup; failures `record` both keys; success `reset`s both; the not-found branch runs `auth.VerifyPassword(auth.DummyHash, ...)`. Confirm `main.go` passes `10, 5*time.Minute`.

---

## Self-Review

- **Spec coverage:** Batch 3 bounded limiter + blocked/record/reset → Task 1. DummyHash → Task 2. clientIP → Task 3. Login peek/record/reset/dummy-bcrypt + main wiring (10/5min) → Task 4. WSConn never-close-sendCh → Task 5. `.dockerignore` data/tmp + vitest cache + root gitignore → Task 6. `-s -w -trimpath` (Dockerfile/Makefile/release.yml) + BuildKit cache mounts → Task 7. Final gates → Task 8. All spec sections mapped.
- **Type consistency:** `blocked(string) bool`/`record(string)`/`reset(string)`/`allow(string) bool` and `maxKeys`/`now` fields are defined in Task 1 and used unchanged in Task 4; `auth.DummyHash` (Task 2) is referenced in Task 4; `clientIP(*http.Request) string` (Task 3) used in Task 4; `AuthAPI.InitRateLimit(int, time.Duration)` defined in Task 4 and called in Task 4 Step 5 main.go.
- **Placeholders:** none — every code step is complete; the bcrypt `DummyHash` is a real cost-12 hash verified to reject inputs; commands have expected output.
- **Risk note:** Task 5 Step 2 is timing-dependent (the panic needs the race window); the loop count (300) and `-race` make it reliable, and the fix makes it deterministically safe regardless.
