# Hardening + build hygiene (audit batches 1–4) — Design

**Date:** 2026-05-31
**Status:** Approved (scope + policy confirmed via Q&A)
**Source:** `docs/system-optimization-audit.md` (sequencing items 1–4)

## Goal

Land the four highest-priority, low-effort items from the system optimization
audit in one branch, then PR + release. The rest of the audit is deferred to a
later round.

1. **WSConn panic fix** — eliminate a reachable `send on closed channel` crash on
   the normal reconnect/eviction path.
2. **Login rate-limiting + account lockout + timing fix** — throttle brute force
   against the root-capable admin gate and close the username-enumeration timing
   oracle.
3. **Bound the `tokenRateLimiter` map** — stop unbounded growth on public
   endpoints (memory-DoS) and make the limiter reusable for login.
4. **Build hygiene** — `.dockerignore` data/tmp, strip Go binaries
   (`-s -w -trimpath`), add BuildKit cache mounts, remove a committed vitest cache
   artifact.

Implementation order: **3 → 2 → 1 → 4** (login reuses the bounded limiter).

## Confirmed decisions (Q&A)

- **Both** per-IP throttle **and** per-account lockout, sharing one bounded
  sliding-window counter, threshold **10 failed attempts / 5 min**. Account
  lockout's self-DoS risk (an attacker keeping the sole admin's username locked)
  is accepted; the 5-minute self-clearing window mitigates it.
- **Bounded map via opportunistic sweep + hard cap**, not the audit's "delete on
  empty slice" (the verifier proved that ineffective for single-use-token floods).
- **Client IP from `RemoteAddr`**; `X-Forwarded-For` trust is deferred (only safe
  behind a trusted proxy) — documented as a follow-up, not implemented now.

---

## Batch 3 — bounded `tokenRateLimiter` (do first)

**File:** `internal/api/agent_status_ratelimit.go` (+ test).

`tokenRateLimiter` is a per-key sliding-window counter (`hits map[string][]time.Time`).
Currently it never evicts keys, so any public endpoint that calls `allow(key)`
*before* validating the key (`/sub/{token}`, `?token=` agent status) lets an
attacker grow the map without bound.

**Changes:**

- Add fields: `maxKeys int` (hard cap) and `lastSweep time.Time`.
- `newTokenRateLimiter(max int, window time.Duration)` keeps its signature; set a
  default `maxKeys` (e.g. `50_000`) internally.
- Add a private `sweepLocked(now time.Time)` (caller holds `mu`): delete every key
  whose entries are all `<= now-window` (fully expired); set `lastSweep = now`.
- In every mutating/peeking path, call sweep opportunistically: if
  `now.Sub(l.lastSweep) >= l.window` **or** `len(l.hits) >= l.maxKeys`, run
  `sweepLocked(now)`. After a forced sweep, if `len(l.hits) >= l.maxKeys` and the
  key is new, **fail closed** (treat as over-limit) — under an active flood a brand
  new key is rejected, but already-tracked (legitimate, recurring) keys are
  unaffected. Log nothing in the hot path.
- **Split the API** so login can peek without counting:
  - `blocked(key string) bool` — read-only: sweep-expired this key's slice, return
    `len(kept) >= max` (does **not** append; writes back the pruned slice).
  - `record(key string)` — append `now` to the key's slice (the counting step).
  - `reset(key string)` — `delete(l.hits, key)`.
  - `allow(key string) bool` — preserve existing semantics for the token endpoints:
    `if blocked(key) { return false }; record(key); return true`. (Same
    check-then-increment behaviour the token endpoints already rely on.)
- All methods take `l.mu` (the limiter is shared across goroutines); keep critical
  sections lock-only, no I/O.

**Tests** (`agent_status_ratelimit_test.go`, extend existing if present):
`allow` still enforces `max`/`window` (drive with an injectable `now`); `blocked`
never increments; `record` increments; `reset` clears; an expired key is evicted
by the time-based sweep (map shrinks); `maxKeys` caps the map under a flood of
unique keys; `-race` clean under concurrent `allow`/`blocked`/`record`.

---

## Batch 2 — login rate-limit + lockout + timing fix

**Files:** `internal/api/admin_auth.go`, `cmd/server/main.go` (wiring),
`internal/api/router.go` (no route change — `POST /api/login` already exists),
`internal/auth` (dummy hash constant) (+ test).

**Wiring:** add to `AuthAPI` a limiter and config:

```go
type AuthAPI struct {
    Auth  *auth.Handler
    limit *tokenRateLimiter // nil → no limiting (tests)
}

// InitRateLimit mirrors PublicAPI/SubgenAPI; called from main.go.
func (a *AuthAPI) InitRateLimit(max int, window time.Duration) {
    a.limit = newTokenRateLimiter(max, window)
}
```

In `cmd/server/main.go`, alongside the other `InitRateLimit` calls, add
`authAPI.InitRateLimit(10, time.Minute*5)`.

**`Login` handler flow** (replacing the current body):

1. Decode JSON (unchanged 400 on bad body).
2. Compute `ip := clientIP(r)` and `userKey := "user:" + req.Username`.
3. **Peek before doing any work:** if `a.limit != nil && (a.limit.blocked(ip) ||
   a.limit.blocked(userKey))` → `writeError(w, 429, "too many attempts")` and
   return. Peeking (not recording) when already blocked prevents an attacker from
   indefinitely extending the window — it self-clears 5 min after the last
   *recorded* failure.
4. Look up the admin. On **not found** (`err != nil`), still run
   `auth.VerifyPassword(auth.DummyHash, req.Password)` and discard the result, so
   response time is constant whether or not the username exists. Then treat as a
   failure.
5. On found, `auth.VerifyPassword(admin.PasswordHash, req.Password)`.
6. **On any auth failure:** if `a.limit != nil` → `a.limit.record(ip)` and
   `a.limit.record(userKey)`; `writeError(w, 401, "invalid credentials")`; return.
7. **On success:** if `a.limit != nil` → `a.limit.reset(ip)` and
   `a.limit.reset(userKey)`; issue session + cookie + 200 (unchanged).

**`clientIP(r *http.Request) string`** helper (in `api`): return the host part of
`r.RemoteAddr` (`net.SplitHostPort`, fall back to the raw string). A comment notes
that honoring `X-Forwarded-For` requires a trusted-proxy allowlist and is a
deliberate follow-up.

**`auth.DummyHash`**: a package-level constant in `internal/auth` — a valid bcrypt
hash (cost matching `VerifyPassword`'s expectation) of an arbitrary string, used
only to spend constant time on the not-found branch. Verify `auth.VerifyPassword`
accepts it (returns false) without erroring.

**Tests** (`admin_auth_test.go`): with a stub `auth.Store`,
- 10 failed logins from one IP → the 11th returns 429 (not 401).
- A successful login resets the counter (a subsequent failure returns 401, not
  429).
- An unknown username returns 401 **and** the handler still invoked bcrypt (assert
  via a timing-independent signal: e.g. the not-found path returns the same status
  and the dummy-hash verify is exercised — test by confirming `clientIP`/flow, and
  add a focused unit test that `VerifyPassword(DummyHash, "x") == false`).
- `blocked` peek does not itself push the count over the edge (a blocked request
  doesn't extend the window — drive with injectable `now`).
- `clientIP` parses `host:port` and bare-host `RemoteAddr`.

---

## Batch 1 — WSConn panic fix

**File:** `internal/agentsvc/wsconn.go` (+ test).

`Close()` does `close(c.done); close(c.sendCh)`. `Send()` may be mid-`select` with
a `case c.sendCh <- f` arm when `Close()` runs; sending on a closed channel
panics, and `select` does not guarantee the ready `done` arm wins — so the normal
concurrent Send+Close (reconnect/eviction) path can panic. The pushers
(pty/file/telemetry goroutines) are not the HTTP handler, so the panic is
unrecovered and can crash the process. `-race` will not catch it (not a data
race).

**Fix — never close `sendCh`; use `done` as the sole shutdown signal:**

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

`Send` is unchanged: its `case c.sendCh <- f` now targets a channel that is never
closed (so it can never panic), and its `case <-c.done` arm returns
`ErrConnClosed` once closed. A frame already buffered when `Close` runs may be
dropped (acceptable — the conn is going away); a late `WriteFrame` after
`raw.Close()` simply errors and re-invokes the idempotent `Close`.

**Tests** (`wsconn_test.go`, extend existing if present): a stress test spawning
many concurrent `Send` goroutines while another goroutine calls `Close` must never
panic (run under `-race`, repeat enough iterations to hit the window); `Send`
after `Close` returns `ErrConnClosed`; a normal `Send` still reaches `WriteFrame`
via a fake `RawWriter`.

---

## Batch 4 — build hygiene (mechanical)

1. **`.dockerignore`** — add `data/`, `tmp/`, `*.db-shm`, `*.db-wal` (the existing
   `shepherd.db*` only matches the repo root, not `data/dev.db`).
2. **Strip + trim Go builds** — change every `go build` ldflags from
   `-ldflags "-X ..."` to `-ldflags "-s -w -X ..."` and add `-trimpath`:
   - `Dockerfile` — the two agent builds and the server build.
   - `Makefile` — the agent and server `build` targets (and the release matrix
     target if it carries ldflags).
   - `.github/workflows/release.yml` — the agent cross-compile step and the native
     server build step.
   `-s -w` strips the symbol table + DWARF; `-trimpath` removes absolute build
   paths. Safe for the CGO server build; no runtime/panic-trace impact.
3. **BuildKit cache mounts** — in `Dockerfile` go-builder, add
   `--mount=type=cache,target=/go/pkg/mod` to the `go mod download` RUN and
   `--mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build`
   to the `go build` RUN(s). The `# syntax=docker/dockerfile:1.7` header already
   enables this. Content-addressed → no stale-artifact risk.
4. **Remove committed vitest cache** — `git rm --cached
   node_modules/.vite/vitest/<hash>/results.json` and add `/node_modules/` to the
   root `.gitignore` (currently only `/web/node_modules/` is ignored).

**Verification:** `docker build` succeeds (or, if Docker is unavailable in the
work env, assert the Dockerfile/Makefile/release.yml ldflags via grep and confirm
`go build` still succeeds locally); `git ls-files | grep node_modules` returns
nothing; the binaries shrink (spot-check `ls -l` on a local stripped build).

---

## Out of scope

- Audit items 5+ (N+1 batch helpers, frontend render fixes, refactors, dead code,
  the larger DB/realtime optimizations) — deferred to the next round.
- `X-Forwarded-For` trusted-proxy support (documented follow-up).
- Persisting lockout state across restarts (in-memory is sufficient for a
  self-hosted single-admin panel; a restart clears counters, which is acceptable).

## Verification gates

`go test -race ./...`, `golangci-lint run` (staticcheck), `gofmt`; frontend `tsc`
+ `vitest` (only the committed-cache change touches the frontend tree). CI runs
`go test -race ./...` + golangci-lint + the web build.
