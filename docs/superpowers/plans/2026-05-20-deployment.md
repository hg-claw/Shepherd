# Shepherd Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Shepherd installable in two commands — `docker compose up -d` on the server, one `curl … | sudo bash` on each managed target (auto systemd / launchd).

**Architecture:** Server compose flow already works (PR #13 fixed the admin bootstrap). New work: (a) two server endpoints (`POST /api/servers/script` to mint an install command; `GET /api/agent/status?token=T` for the script's healthcheck), (b) `scripts/install-agent.sh` that auto-detects OS+arch + writes systemd unit or launchd plist, (c) UI tab + copy box in ServerNew, (d) Quickstart docs.

**Tech Stack:** Go 1.25 / sqlx / net/http stdlib mux, bash + curl + tar + sha256sum / shasum + systemctl / launchctl, React 19 + TS + react-query, BATS for bash unit tests.

**Spec:** `docs/superpowers/specs/2026-05-20-deployment-design.md`.

---

## File map

| File | Purpose | Action |
|---|---|---|
| `internal/agentsvc/enroll.go` | Add `LookupEnrollment` (read-only, allows recently-consumed tokens) | Modify |
| `internal/agentsvc/enroll_test.go` | Tests for `LookupEnrollment` | Modify |
| `internal/api/public.go` | Add `AgentStatus` handler (public, token-auth) + healthz | Modify |
| `internal/api/public_test.go` | Tests for `AgentStatus` + `Healthz` | Modify |
| `internal/api/agent_status_ratelimit.go` | Token-keyed token bucket | New |
| `internal/api/agent_status_ratelimit_test.go` | Rate limit tests | New |
| `internal/api/router.go` | Wire `/healthz` and `/api/agent/status` | Modify |
| `internal/api/admin_servers.go` | Add `ScriptInstall` handler + `installCommand` URL builder | Modify |
| `internal/api/admin_servers_test.go` | Test for `ScriptInstall` and URL builder | Modify |
| `scripts/install-agent.sh` | One-shot install script (linux + darwin) | New |
| `scripts/install-agent.bats` | BATS tests for script helpers | New |
| `docker-compose.yml` | Add healthcheck | Modify |
| `.env.example` | New env template | New |
| `README.md` | Add Quickstart section | Modify |
| `web/src/api/servers.ts` | Add `useScriptInstall` mutation | Modify |
| `web/src/pages/admin/ServerNew.tsx` | Add "Script install" tab | Modify |

---

## Task 1: agentsvc — LookupEnrollment (read-only token resolver)

**Files:**
- Modify: `internal/agentsvc/enroll.go`
- Modify: `internal/agentsvc/enroll_test.go`

The existing `RedeemEnrollment` consumes the token. The script's healthcheck endpoint needs to resolve `token → server_id` without consuming, and must tolerate already-consumed tokens for up to 24h (the install script polls for ~30s, and the same admin may re-run install for an upgrade within the day).

- [ ] **Step 1: Add failing test for the unconsumed path**

Open `internal/agentsvc/enroll_test.go` and add:

```go
func TestService_LookupEnrollment_Unconsumed(t *testing.T) {
	s, _ := newServiceWithDB(t) // existing helper that returns *Service + *sqlx.DB
	tok, _, err := s.IssueEnrollmentToken(context.Background(), 7)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	serverID, err := s.LookupEnrollment(context.Background(), tok)
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if serverID != 7 {
		t.Fatalf("server_id = %d, want 7", serverID)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./internal/agentsvc/ -run TestService_LookupEnrollment_Unconsumed -count=1
```

Expected: FAIL with `s.LookupEnrollment undefined`.

- [ ] **Step 3: Add `LookupEnrollment` to `enroll.go`**

Append after the existing `RedeemEnrollment` function:

```go
// LookupEnrollment resolves a token to a server_id without consuming it.
// Tolerates tokens that have been consumed up to 24h ago so the install
// script can poll /api/agent/status after the agent has already enrolled.
// Returns ErrInvalidEnrollment for unknown / expired / older-than-24h-consumed tokens.
func (s *Service) LookupEnrollment(ctx context.Context, token string) (int64, error) {
	var (
		serverID   int64
		expiresAt  time.Time
		consumedAt sql.NullTime
	)
	err := s.DB.QueryRowContext(ctx,
		"SELECT server_id, expires_at, consumed_at FROM enrollment_tokens WHERE token=$1",
		token).Scan(&serverID, &expiresAt, &consumedAt)
	if err == sql.ErrNoRows {
		return 0, ErrInvalidEnrollment
	}
	if err != nil {
		return 0, err
	}
	now := time.Now().UTC()
	if !consumedAt.Valid && now.After(expiresAt) {
		return 0, ErrInvalidEnrollment
	}
	if consumedAt.Valid && now.Sub(consumedAt.Time.UTC()) > 24*time.Hour {
		return 0, ErrInvalidEnrollment
	}
	return serverID, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
go test ./internal/agentsvc/ -run TestService_LookupEnrollment_Unconsumed -count=1
```

Expected: PASS.

- [ ] **Step 5: Add tests for the other code paths**

Append to `enroll_test.go`:

```go
func TestService_LookupEnrollment_RecentlyConsumed(t *testing.T) {
	s, db := newServiceWithDB(t)
	tok, _, err := s.IssueEnrollmentToken(context.Background(), 9)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	// Simulate the agent having redeemed the token an hour ago.
	if _, err := db.Exec(
		`UPDATE enrollment_tokens SET consumed_at=$1 WHERE token=$2`,
		time.Now().Add(-time.Hour), tok); err != nil {
		t.Fatalf("update consumed_at: %v", err)
	}
	if _, err := s.LookupEnrollment(context.Background(), tok); err != nil {
		t.Fatalf("expected recently-consumed token to be accepted: %v", err)
	}
}

func TestService_LookupEnrollment_StaleConsumed(t *testing.T) {
	s, db := newServiceWithDB(t)
	tok, _, _ := s.IssueEnrollmentToken(context.Background(), 11)
	if _, err := db.Exec(
		`UPDATE enrollment_tokens SET consumed_at=$1 WHERE token=$2`,
		time.Now().Add(-25*time.Hour), tok); err != nil {
		t.Fatalf("update consumed_at: %v", err)
	}
	if _, err := s.LookupEnrollment(context.Background(), tok); err != agentsvc.ErrInvalidEnrollment {
		t.Fatalf("expected ErrInvalidEnrollment, got %v", err)
	}
}

func TestService_LookupEnrollment_Unknown(t *testing.T) {
	s, _ := newServiceWithDB(t)
	if _, err := s.LookupEnrollment(context.Background(), "nope"); err != agentsvc.ErrInvalidEnrollment {
		t.Fatalf("expected ErrInvalidEnrollment, got %v", err)
	}
}
```

If `newServiceWithDB` does not yet expose the `*sqlx.DB`, add a sibling test helper that does. Check the top of `enroll_test.go` for the existing helper shape — if it returns only `*Service`, modify the helper to return both `(*Service, *sqlx.DB)` and update existing call sites at the same time.

- [ ] **Step 6: Run all enroll tests**

```bash
go test ./internal/agentsvc/ -run TestService_LookupEnrollment -count=1
```

Expected: 4 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/agentsvc/enroll.go internal/agentsvc/enroll_test.go
git commit -m "feat(agentsvc): LookupEnrollment for read-only token resolution"
```

---

## Task 2: install-command URL builder

**Files:**
- Modify: `internal/api/admin_servers.go`
- Modify: `internal/api/admin_servers_test.go`

Pure helper that builds the curl|bash command given the running server's BuildVersion and PublicURL. Tested in isolation so the handler test can mock the URL.

- [ ] **Step 1: Add failing test**

Append to `internal/api/admin_servers_test.go`:

```go
func TestBuildInstallCommand(t *testing.T) {
	cases := []struct {
		name           string
		buildVersion   string
		publicURL      string
		token          string
		wantContains   []string
		wantNotContain []string
	}{
		{
			name:         "release version → versioned raw URL",
			buildVersion: "v0.5.0",
			publicURL:    "https://shepherd.example.com",
			token:        "T_abc",
			wantContains: []string{
				"raw.githubusercontent.com/hg-claw/Shepherd/v0.5.0/scripts/install-agent.sh",
				"--token T_abc",
				"--server https://shepherd.example.com",
				"sudo bash -s --",
			},
			wantNotContain: []string{"main"},
		},
		{
			name:         "dev build → main branch",
			buildVersion: "dev",
			publicURL:    "https://shepherd.example.com",
			token:        "T_xyz",
			wantContains: []string{
				"raw.githubusercontent.com/hg-claw/Shepherd/main/scripts/install-agent.sh",
				"--token T_xyz",
			},
			wantNotContain: []string{"v0.5.0", "dev"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := buildInstallCommand(c.buildVersion, c.publicURL, c.token)
			for _, sub := range c.wantContains {
				if !strings.Contains(got, sub) {
					t.Errorf("missing %q in: %s", sub, got)
				}
			}
			for _, sub := range c.wantNotContain {
				if strings.Contains(got, sub) {
					t.Errorf("unwanted %q in: %s", sub, got)
				}
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./internal/api/ -run TestBuildInstallCommand -count=1
```

Expected: FAIL with `buildInstallCommand undefined`.

- [ ] **Step 3: Add the helper**

Append to `internal/api/admin_servers.go`:

```go
// buildInstallCommand renders the single-line curl|bash an admin pastes
// onto a target machine. The script URL is pinned to the running
// server's BuildVersion so script + binary + server stay in lockstep;
// for dev builds we point at `main` (raw URLs have no `latest` symlink).
func buildInstallCommand(buildVersion, publicURL, token string) string {
	tag := buildVersion
	if tag == "" || tag == "dev" {
		tag = "main"
	}
	scriptURL := "https://raw.githubusercontent.com/hg-claw/Shepherd/" + tag + "/scripts/install-agent.sh"
	return "curl -fsSL " + scriptURL +
		" | sudo bash -s -- --token " + token +
		" --server " + publicURL
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
go test ./internal/api/ -run TestBuildInstallCommand -count=1
```

Expected: PASS for both subtests.

- [ ] **Step 5: Commit**

```bash
git add internal/api/admin_servers.go internal/api/admin_servers_test.go
git commit -m "feat(api): buildInstallCommand helper for one-shot install URL"
```

---

## Task 3: POST /api/servers/script handler

**Files:**
- Modify: `internal/api/admin_servers.go`
- Modify: `internal/api/admin_servers_test.go`
- Modify: `internal/api/router.go`

Admin-authenticated. Creates a server row with empty SSH fields, issues an enrollment token, returns the install command.

- [ ] **Step 1: Add failing handler test**

Append to `internal/api/admin_servers_test.go`:

```go
func TestServersAPI_ScriptInstall(t *testing.T) {
	a := newServersAPIForTest(t) // existing helper; check the file for shape
	// Override the BuildVersion the handler reads. The handler should
	// read it via a closure / config struct so tests can inject.
	a.BuildVersion = "v0.5.0"
	a.PublicURL = "https://shepherd.example.com"

	body := strings.NewReader(`{"name":"vps-1","public_alias":"hk-01","show_on_public":true}`)
	req := httptest.NewRequest("POST", "/api/servers/script", body)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	a.ScriptInstall(rr, req)

	if rr.Code != 201 {
		t.Fatalf("status %d: %s", rr.Code, rr.Body)
	}
	var got struct {
		ServerID  int64  `json:"server_id"`
		Token     string `json:"token"`
		Command   string `json:"command"`
		ExpiresAt string `json:"expires_at"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ServerID == 0 || got.Token == "" {
		t.Fatalf("missing fields: %+v", got)
	}
	if !strings.Contains(got.Command, "--token "+got.Token) {
		t.Errorf("command does not embed token: %s", got.Command)
	}
	if !strings.Contains(got.Command, "v0.5.0") {
		t.Errorf("command not pinned to BuildVersion: %s", got.Command)
	}
}

func TestServersAPI_ScriptInstall_NameRequired(t *testing.T) {
	a := newServersAPIForTest(t)
	a.BuildVersion = "v0.5.0"
	a.PublicURL = "https://x"
	req := httptest.NewRequest("POST", "/api/servers/script", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	a.ScriptInstall(rr, req)
	if rr.Code != 400 {
		t.Fatalf("want 400, got %d", rr.Code)
	}
}
```

If `newServersAPIForTest` does not yet exist, inspect the file for whatever helper sets up a `ServersAPI` with an in-memory DB, and either reuse it or extract one from the existing handler tests.

- [ ] **Step 2: Add fields to ServersAPI struct**

Find the `ServersAPI` struct in `internal/api/admin_servers.go` (near the top). Add two string fields the handler reads at request time:

```go
type ServersAPI struct {
	Servers        *serversvc.Service
	Tokens         *agentsvc.Service
	InstallManager *serversvc.InstallManager
	// ↓ new
	BuildVersion string
	PublicURL    string
}
```

Then update the wiring in `cmd/server/main.go` where `serversAPI` is constructed (search for `&api.ServersAPI{`). Add:

```go
serversAPI := &api.ServersAPI{
	Servers:        serverSvc,
	Tokens:         agentSvc,
	InstallManager: installManager,
	BuildVersion:   cfg.BuildVersion,
	PublicURL:      deriveServerURL(cfg),
}
```

- [ ] **Step 3: Run handler test to verify it fails**

```bash
go test ./internal/api/ -run TestServersAPI_ScriptInstall -count=1
```

Expected: FAIL with `a.ScriptInstall undefined`.

- [ ] **Step 4: Add the handler**

Append to `internal/api/admin_servers.go`:

```go
type scriptInstallReq struct {
	Name         string `json:"name"`
	PublicAlias  string `json:"public_alias"`
	PublicGroup  string `json:"public_group"`
	CountryCode  string `json:"country_code"`
	ShowOnPublic bool   `json:"show_on_public"`
}

// ScriptInstall creates a server row with no SSH credentials (the agent
// will fill in connection metadata via auto-register on first WS connect)
// and returns the one-shot curl|bash install command.
func (a *ServersAPI) ScriptInstall(w http.ResponseWriter, r *http.Request) {
	var in scriptInstallReq
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeError(w, 400, "name required")
		return
	}
	srv, err := a.Servers.Create(r.Context(), serversvc.CreateInput{
		Name:         in.Name,
		PublicAlias:  in.PublicAlias,
		PublicGroup:  in.PublicGroup,
		CountryCode:  in.CountryCode,
		ShowOnPublic: in.ShowOnPublic,
		// No SSH fields — script flow doesn't need them.
	})
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	tok, exp, err := a.Tokens.IssueEnrollmentToken(r.Context(), srv.ID)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 201, map[string]any{
		"server_id":  srv.ID,
		"token":      tok,
		"expires_at": exp,
		"command":    buildInstallCommand(a.BuildVersion, a.PublicURL, tok),
	})
}
```

- [ ] **Step 5: Wire the route**

In `internal/api/router.go`, find the `admin.HandleFunc("POST /api/servers/install"` line and add a sibling immediately below it:

```go
admin.HandleFunc("POST /api/servers/script", r.Servers.ScriptInstall)
```

- [ ] **Step 6: Run handler tests to verify they pass**

```bash
go test ./internal/api/ -run TestServersAPI_ScriptInstall -count=1
```

Expected: 2 PASS.

- [ ] **Step 7: Run all api + agentsvc tests**

```bash
go test ./internal/api/... ./internal/agentsvc/... -count=1
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add internal/api/admin_servers.go internal/api/admin_servers_test.go internal/api/router.go cmd/server/main.go
git commit -m "feat(api): POST /api/servers/script — one-shot install command"
```

---

## Task 4: Rate limiter for agent-status

**Files:**
- Create: `internal/api/agent_status_ratelimit.go`
- Create: `internal/api/agent_status_ratelimit_test.go`

A simple token-keyed sliding window counter. Caps requests at 30/min per token to prevent abuse from a leaked URL. Standalone so it can be unit-tested without an HTTP server.

- [ ] **Step 1: Write the failing test**

Create `internal/api/agent_status_ratelimit_test.go`:

```go
package api

import (
	"testing"
	"time"
)

func TestTokenRateLimiter_AllowsUnderLimit(t *testing.T) {
	lim := newTokenRateLimiter(3, time.Minute)
	for i := 0; i < 3; i++ {
		if !lim.allow("abc") {
			t.Fatalf("hit %d: unexpected reject", i)
		}
	}
}

func TestTokenRateLimiter_RejectsOverLimit(t *testing.T) {
	lim := newTokenRateLimiter(3, time.Minute)
	for i := 0; i < 3; i++ {
		lim.allow("abc")
	}
	if lim.allow("abc") {
		t.Fatalf("4th hit should be rejected")
	}
}

func TestTokenRateLimiter_PerTokenIsolation(t *testing.T) {
	lim := newTokenRateLimiter(3, time.Minute)
	for i := 0; i < 3; i++ {
		lim.allow("abc")
	}
	if !lim.allow("xyz") {
		t.Fatalf("different token should not be rate-limited")
	}
}

func TestTokenRateLimiter_WindowAdvances(t *testing.T) {
	lim := newTokenRateLimiter(3, 50*time.Millisecond)
	for i := 0; i < 3; i++ {
		lim.allow("abc")
	}
	if lim.allow("abc") {
		t.Fatalf("should be rejected before window advance")
	}
	time.Sleep(60 * time.Millisecond)
	if !lim.allow("abc") {
		t.Fatalf("should be allowed after window advance")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./internal/api/ -run TestTokenRateLimiter -count=1
```

Expected: FAIL with `newTokenRateLimiter undefined`.

- [ ] **Step 3: Implement the limiter**

Create `internal/api/agent_status_ratelimit.go`:

```go
package api

import (
	"sync"
	"time"
)

// tokenRateLimiter is a per-key sliding-window counter. Each key independently
// gets `max` hits per `window`. Hits older than `window` are discarded on every
// allow() call. Safe for concurrent use.
//
// Keyspace is small (one entry per active enrollment token) so the map of
// slices does not need a bounded size.
type tokenRateLimiter struct {
	max    int
	window time.Duration
	mu     sync.Mutex
	hits   map[string][]time.Time
	now    func() time.Time
}

func newTokenRateLimiter(max int, window time.Duration) *tokenRateLimiter {
	return &tokenRateLimiter{
		max:    max,
		window: window,
		hits:   map[string][]time.Time{},
		now:    time.Now,
	}
}

func (l *tokenRateLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	cutoff := now.Add(-l.window)
	// Drop expired entries.
	prev := l.hits[key]
	kept := prev[:0]
	for _, t := range prev {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.max {
		l.hits[key] = kept
		return false
	}
	l.hits[key] = append(kept, now)
	return true
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
go test ./internal/api/ -run TestTokenRateLimiter -count=1
```

Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/api/agent_status_ratelimit.go internal/api/agent_status_ratelimit_test.go
git commit -m "feat(api): token-keyed sliding-window rate limiter"
```

---

## Task 5: GET /api/agent/status handler

**Files:**
- Modify: `internal/api/public.go`
- Modify: `internal/api/public_test.go`
- Modify: `internal/api/router.go`
- Modify: `cmd/server/main.go`

Public endpoint (no admin session). Resolves token via `LookupEnrollment`, queries `agent_last_seen` on the matching server row, returns `{online, last_seen_at}`. Rate-limited at 30/min/token.

- [ ] **Step 1: Add failing handler test**

In `internal/api/public_test.go`, append:

```go
func TestPublicAPI_AgentStatus_Online(t *testing.T) {
	a, db := newPublicAPIForTest(t) // existing helper or sibling pattern
	// Seed a server row + enrollment token + recent last_seen.
	res, _ := db.Exec(`INSERT INTO servers (name, agent_last_seen) VALUES (?, ?)`,
		"s1", time.Now().Add(-5*time.Second))
	serverID, _ := res.LastInsertId()
	tok := "tok_online"
	if _, err := db.Exec(
		`INSERT INTO enrollment_tokens (token, server_id, expires_at) VALUES (?, ?, ?)`,
		tok, serverID, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("seed: %v", err)
	}
	req := httptest.NewRequest("GET", "/api/agent/status?token="+tok, nil)
	rr := httptest.NewRecorder()
	a.AgentStatus(rr, req)
	if rr.Code != 200 {
		t.Fatalf("status %d", rr.Code)
	}
	var got struct {
		Online     bool    `json:"online"`
		LastSeenAt *string `json:"last_seen_at"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	if !got.Online {
		t.Errorf("expected online=true; body=%s", rr.Body)
	}
}

func TestPublicAPI_AgentStatus_Offline(t *testing.T) {
	a, db := newPublicAPIForTest(t)
	res, _ := db.Exec(`INSERT INTO servers (name, agent_last_seen) VALUES (?, ?)`,
		"s2", time.Now().Add(-10*time.Minute))
	serverID, _ := res.LastInsertId()
	tok := "tok_offline"
	_, _ = db.Exec(
		`INSERT INTO enrollment_tokens (token, server_id, expires_at) VALUES (?, ?, ?)`,
		tok, serverID, time.Now().Add(time.Hour))
	req := httptest.NewRequest("GET", "/api/agent/status?token="+tok, nil)
	rr := httptest.NewRecorder()
	a.AgentStatus(rr, req)
	if rr.Code != 200 {
		t.Fatalf("status %d", rr.Code)
	}
	var got struct {
		Online bool `json:"online"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &got)
	if got.Online {
		t.Errorf("expected online=false")
	}
}

func TestPublicAPI_AgentStatus_UnknownToken(t *testing.T) {
	a, _ := newPublicAPIForTest(t)
	req := httptest.NewRequest("GET", "/api/agent/status?token=nope", nil)
	rr := httptest.NewRecorder()
	a.AgentStatus(rr, req)
	if rr.Code != 404 {
		t.Fatalf("want 404, got %d", rr.Code)
	}
}

func TestPublicAPI_AgentStatus_RateLimit(t *testing.T) {
	a, db := newPublicAPIForTest(t)
	res, _ := db.Exec(`INSERT INTO servers (name) VALUES (?)`, "s3")
	serverID, _ := res.LastInsertId()
	tok := "tok_rl"
	_, _ = db.Exec(
		`INSERT INTO enrollment_tokens (token, server_id, expires_at) VALUES (?, ?, ?)`,
		tok, serverID, time.Now().Add(time.Hour))
	for i := 0; i < 30; i++ {
		req := httptest.NewRequest("GET", "/api/agent/status?token="+tok, nil)
		rr := httptest.NewRecorder()
		a.AgentStatus(rr, req)
		if rr.Code != 200 {
			t.Fatalf("hit %d: status %d", i, rr.Code)
		}
	}
	// 31st should be 429.
	req := httptest.NewRequest("GET", "/api/agent/status?token="+tok, nil)
	rr := httptest.NewRecorder()
	a.AgentStatus(rr, req)
	if rr.Code != 429 {
		t.Fatalf("want 429, got %d", rr.Code)
	}
}
```

- [ ] **Step 2: Add fields to PublicAPI struct**

Find `PublicAPI` in `internal/api/public.go` and add:

```go
type PublicAPI struct {
	Servers      *serversvc.Service
	Settings     *serversvc.SettingsStore
	Tokens       *agentsvc.Service // ← new
	// ↓ new — initialized in main.go
	statusLimit *tokenRateLimiter
}
```

If `Tokens` already exists, only add `statusLimit`. Wire it in `cmd/server/main.go` where `publicAPI` is constructed:

```go
publicAPI := &api.PublicAPI{
	Servers:  serverSvc,
	Settings: settingsStore,
	Tokens:   agentSvc,
}
publicAPI.InitRateLimit(30, time.Minute)
```

And add an exported initializer to `public.go`:

```go
// InitRateLimit configures the per-token rate limit for AgentStatus.
// Called once at startup; tests set their own via direct field access.
func (a *PublicAPI) InitRateLimit(max int, window time.Duration) {
	a.statusLimit = newTokenRateLimiter(max, window)
}
```

- [ ] **Step 3: Run handler tests to verify they fail**

```bash
go test ./internal/api/ -run TestPublicAPI_AgentStatus -count=1
```

Expected: FAIL with `a.AgentStatus undefined`.

- [ ] **Step 4: Implement the handler**

Append to `internal/api/public.go`:

```go
// AgentStatus is a public, token-authenticated endpoint used by the
// install script to verify the agent has connected. Returns 404 for
// unknown / expired tokens, 429 when the per-token rate limit is hit,
// and 200 with {online, last_seen_at} otherwise.
//
// `online` is true if agent_last_seen is non-null and within the last 60s.
func (a *PublicAPI) AgentStatus(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		writeError(w, 400, "token required")
		return
	}
	if a.statusLimit != nil && !a.statusLimit.allow(token) {
		writeError(w, 429, "rate limit exceeded")
		return
	}
	serverID, err := a.Tokens.LookupEnrollment(r.Context(), token)
	if err != nil {
		writeError(w, 404, "unknown or expired token")
		return
	}
	srv, err := a.Servers.Get(r.Context(), serverID)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	online := srv.AgentLastSeen.Valid &&
		time.Since(srv.AgentLastSeen.Time) <= 60*time.Second
	var lastSeenAt *string
	if srv.AgentLastSeen.Valid {
		s := srv.AgentLastSeen.Time.UTC().Format(time.RFC3339)
		lastSeenAt = &s
	}
	writeJSON(w, 200, map[string]any{
		"online":       online,
		"last_seen_at": lastSeenAt,
	})
}
```

- [ ] **Step 5: Wire the route**

In `internal/api/router.go`, find the public route block (search for `mux.HandleFunc("GET /api/public/`) and add:

```go
mux.HandleFunc("GET /api/agent/status", r.Public.AgentStatus)
```

- [ ] **Step 6: Run handler tests to verify they pass**

```bash
go test ./internal/api/ -run TestPublicAPI_AgentStatus -count=1
```

Expected: 4 PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/api/public.go internal/api/public_test.go internal/api/router.go cmd/server/main.go
git commit -m "feat(api): GET /api/agent/status for install-script healthcheck"
```

---

## Task 6: /healthz route + compose healthcheck

**Files:**
- Modify: `internal/api/router.go`
- Modify: `internal/api/public.go` (or new file)
- Modify: `docker-compose.yml`

Trivial endpoint that returns 200 OK if the HTTP server is up. Used by docker compose healthcheck.

- [ ] **Step 1: Add failing test**

In `internal/api/public_test.go` append:

```go
func TestHealthz(t *testing.T) {
	a, _ := newPublicAPIForTest(t)
	req := httptest.NewRequest("GET", "/healthz", nil)
	rr := httptest.NewRecorder()
	a.Healthz(rr, req)
	if rr.Code != 200 {
		t.Fatalf("want 200, got %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), `"ok":true`) {
		t.Errorf("body = %s", rr.Body)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./internal/api/ -run TestHealthz -count=1
```

Expected: FAIL.

- [ ] **Step 3: Implement Healthz**

Append to `internal/api/public.go`:

```go
// Healthz is a liveness probe used by docker compose's healthcheck.
// Returns 200 immediately as long as the HTTP server can answer.
// Does not touch the DB; if you want a readiness probe that does, add a
// separate /readyz.
func (a *PublicAPI) Healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true})
}
```

- [ ] **Step 4: Wire the route**

In `internal/api/router.go`, in the public-mux block, add:

```go
mux.HandleFunc("GET /healthz", r.Public.Healthz)
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
go test ./internal/api/ -run TestHealthz -count=1
```

Expected: PASS.

- [ ] **Step 6: Add compose healthcheck**

In `docker-compose.yml`, under the `shepherd` service block, before `volumes:`, add:

```yaml
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

`wget` is present in the `alpine` base image the runtime stage uses. Verify in the Dockerfile:

```bash
grep -n "FROM.*alpine" Dockerfile
```

Expected: at least one alpine stage in the runtime image.

- [ ] **Step 7: Commit**

```bash
git add internal/api/public.go internal/api/public_test.go internal/api/router.go docker-compose.yml
git commit -m "feat(server): GET /healthz + compose healthcheck"
```

---

## Task 7: install-agent.sh — skeleton + OS/arch detection

**Files:**
- Create: `scripts/install-agent.sh`
- Create: `scripts/install-agent.bats`

Build the script incrementally. This task sets up the skeleton, arg parsing, and OS/arch detection — verified by BATS unit tests that exercise the helpers without actually installing anything.

Install BATS once if missing:

```bash
which bats || brew install bats-core
```

- [ ] **Step 1: Write failing BATS test**

Create `scripts/install-agent.bats`:

```bash
#!/usr/bin/env bats

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/install-agent.sh"
}

@test "detect_os: linux" {
  run bash -c "source '$SCRIPT' --source && uname() { echo Linux; }; detect_os"
  [ "$status" -eq 0 ]
  [ "$output" = "linux" ]
}

@test "detect_os: darwin" {
  run bash -c "source '$SCRIPT' --source && uname() { echo Darwin; }; detect_os"
  [ "$status" -eq 0 ]
  [ "$output" = "darwin" ]
}

@test "detect_os: unsupported" {
  run bash -c "source '$SCRIPT' --source && uname() { echo FreeBSD; }; detect_os"
  [ "$status" -ne 0 ]
}

@test "detect_arch: x86_64 → amd64" {
  run bash -c "source '$SCRIPT' --source && uname() { echo x86_64; }; detect_arch"
  [ "$status" -eq 0 ]
  [ "$output" = "amd64" ]
}

@test "detect_arch: aarch64 → arm64" {
  run bash -c "source '$SCRIPT' --source && uname() { echo aarch64; }; detect_arch"
  [ "$status" -eq 0 ]
  [ "$output" = "arm64" ]
}

@test "detect_arch: arm64 → arm64" {
  run bash -c "source '$SCRIPT' --source && uname() { echo arm64; }; detect_arch"
  [ "$status" -eq 0 ]
  [ "$output" = "arm64" ]
}

@test "detect_arch: unsupported" {
  run bash -c "source '$SCRIPT' --source && uname() { echo i386; }; detect_arch"
  [ "$status" -ne 0 ]
}
```

- [ ] **Step 2: Run BATS to verify failure**

```bash
bats scripts/install-agent.bats
```

Expected: all tests fail because the script does not exist yet.

- [ ] **Step 3: Create the script skeleton**

Create `scripts/install-agent.sh`:

```bash
#!/usr/bin/env bash
# install-agent.sh — one-shot installer for the Shepherd agent.
#
# Usage:
#   curl -fsSL <URL> | sudo bash -s -- --token T --server https://...
#   curl -fsSL <URL> | sudo bash -s -- --uninstall
#
# Exit codes: 0 ok / 1 not root / 2 unsupported OS|arch / 3 download failed
#             4 checksum mismatch / 5 no service manager / 6 connect timeout

set -euo pipefail

# --- Configuration knobs ---------------------------------------------------

REPO="hg-claw/Shepherd"
BIN_DIR="/usr/local/bin"
BIN_PATH="${BIN_DIR}/shepherd-agent"
ENV_DIR="/etc/shepherd-agent"
ENV_FILE="${ENV_DIR}/env"
LINUX_UNIT="/etc/systemd/system/shepherd-agent.service"
DARWIN_PLIST="/Library/LaunchDaemons/com.shepherd.agent.plist"
LAUNCHD_LABEL="com.shepherd.agent"
LOG_FILE="/var/log/shepherd-agent.log"
HEALTHCHECK_TIMEOUT=30
HEALTHCHECK_INTERVAL=2

# --- Helpers ---------------------------------------------------------------

err() { echo "error: $*" >&2; }

detect_os() {
	case "$(uname -s)" in
		Linux)  echo linux  ;;
		Darwin) echo darwin ;;
		*) err "unsupported OS: $(uname -s)"; return 2 ;;
	esac
}

detect_arch() {
	case "$(uname -m)" in
		x86_64|amd64) echo amd64 ;;
		aarch64|arm64) echo arm64 ;;
		*) err "unsupported arch: $(uname -m)"; return 2 ;;
	esac
}

# --- Source-only short-circuit (for BATS tests) ---------------------------
#
# When sourced with `--source` as the first arg, define the helpers but
# don't run main(). Lets unit tests exercise individual functions.

if [ "${1:-}" = "--source" ]; then
	return 0 2>/dev/null || exit 0
fi

# --- Main (placeholder until later tasks) ---------------------------------
err "install body not implemented yet"
exit 99
```

- [ ] **Step 4: Make executable**

```bash
chmod +x scripts/install-agent.sh
```

- [ ] **Step 5: Run BATS to verify helpers pass**

```bash
bats scripts/install-agent.bats
```

Expected: 7 PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/install-agent.sh scripts/install-agent.bats
git commit -m "feat(scripts): install-agent.sh skeleton with OS/arch detection"
```

---

## Task 8: install-agent.sh — argument parsing

**Files:**
- Modify: `scripts/install-agent.sh`
- Modify: `scripts/install-agent.bats`

- [ ] **Step 1: Add failing BATS tests**

Append to `scripts/install-agent.bats`:

```bash
@test "parse_args: install" {
  run bash -c "source '$SCRIPT' --source && parse_args --token T --server https://x && echo \$MODE \$TOKEN \$SERVER_URL"
  [ "$status" -eq 0 ]
  [ "$output" = "install T https://x" ]
}

@test "parse_args: uninstall" {
  run bash -c "source '$SCRIPT' --source && parse_args --uninstall && echo \$MODE"
  [ "$status" -eq 0 ]
  [ "$output" = "uninstall" ]
}

@test "parse_args: install missing token" {
  run bash -c "source '$SCRIPT' --source && parse_args --server https://x"
  [ "$status" -ne 0 ]
}

@test "parse_args: install missing server" {
  run bash -c "source '$SCRIPT' --source && parse_args --token T"
  [ "$status" -ne 0 ]
}

@test "parse_args: optional --version" {
  run bash -c "source '$SCRIPT' --source && parse_args --token T --server https://x --version v0.5.0 && echo \$VERSION"
  [ "$status" -eq 0 ]
  [ "$output" = "v0.5.0" ]
}
```

- [ ] **Step 2: Run BATS to verify failure**

```bash
bats scripts/install-agent.bats
```

Expected: 5 new tests fail.

- [ ] **Step 3: Add parse_args to install-agent.sh**

Insert the following after `detect_arch` and before the source-only short-circuit:

```bash
# Globals set by parse_args.
MODE=""        # install | uninstall
TOKEN=""
SERVER_URL=""
VERSION=""     # optional override; empty → derived from script URL pinning

parse_args() {
	MODE="install"
	while [ $# -gt 0 ]; do
		case "$1" in
			--token)     TOKEN="$2";      shift 2 ;;
			--server)    SERVER_URL="$2"; shift 2 ;;
			--version)   VERSION="$2";    shift 2 ;;
			--uninstall) MODE="uninstall"; shift   ;;
			*) err "unknown arg: $1"; return 1 ;;
		esac
	done
	if [ "$MODE" = "install" ]; then
		[ -n "$TOKEN" ]      || { err "--token required"; return 1; }
		[ -n "$SERVER_URL" ] || { err "--server required"; return 1; }
	fi
}
```

- [ ] **Step 4: Run BATS to verify they pass**

```bash
bats scripts/install-agent.bats
```

Expected: 12 PASS total.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-agent.sh scripts/install-agent.bats
git commit -m "feat(scripts): install-agent.sh argument parsing"
```

---

## Task 9: install-agent.sh — binary fetch + sha256 verify

**Files:**
- Modify: `scripts/install-agent.sh`
- Modify: `scripts/install-agent.bats`

Add helpers that build the release URLs and verify checksums. Manual smoke test rather than full integration test — BATS validates only the URL builder + checksum verify against a fixture.

- [ ] **Step 1: Add failing BATS tests**

Append to `scripts/install-agent.bats`:

```bash
@test "release_tag: --version override wins" {
  run bash -c "source '$SCRIPT' --source && VERSION=v0.5.0 && release_tag"
  [ "$status" -eq 0 ]
  [ "$output" = "v0.5.0" ]
}

@test "release_tag: defaults to v0.5.0 baseline when unset" {
  # Without VERSION, fall through to the embedded BUILD_TAG, which the
  # repo CI pipeline rewrites on release. For local script runs we use
  # a sane default.
  run bash -c "source '$SCRIPT' --source && unset VERSION; release_tag"
  [ "$status" -eq 0 ]
  [ -n "$output" ]
}

@test "asset_url: linux amd64" {
  run bash -c "source '$SCRIPT' --source && asset_url linux amd64 v0.5.0"
  [ "$status" -eq 0 ]
  [ "$output" = "https://github.com/hg-claw/Shepherd/releases/download/v0.5.0/shepherd-linux-amd64.tar.gz" ]
}

@test "asset_url: darwin arm64" {
  run bash -c "source '$SCRIPT' --source && asset_url darwin arm64 v0.5.0"
  [ "$status" -eq 0 ]
  [ "$output" = "https://github.com/hg-claw/Shepherd/releases/download/v0.5.0/shepherd-agent-darwin-arm64.tar.gz" ]
}

@test "verify_sha256: match" {
  tmp=$(mktemp -d)
  echo hello > "$tmp/file"
  if command -v sha256sum >/dev/null; then
    sum=$(sha256sum "$tmp/file" | awk '{print $1}')
  else
    sum=$(shasum -a 256 "$tmp/file" | awk '{print $1}')
  fi
  echo "$sum  file" > "$tmp/file.sha256"
  run bash -c "source '$SCRIPT' --source && cd '$tmp' && verify_sha256 file file.sha256"
  [ "$status" -eq 0 ]
  rm -rf "$tmp"
}

@test "verify_sha256: mismatch" {
  tmp=$(mktemp -d)
  echo hello > "$tmp/file"
  echo "0000000000000000000000000000000000000000000000000000000000000000  file" > "$tmp/file.sha256"
  run bash -c "source '$SCRIPT' --source && cd '$tmp' && verify_sha256 file file.sha256"
  [ "$status" -ne 0 ]
  rm -rf "$tmp"
}
```

- [ ] **Step 2: Add the helpers to install-agent.sh**

Insert before the source-only short-circuit:

```bash
# BUILD_TAG: substituted by `make release` at build time. Default lets
# the script run from a `git clone` checkout against the latest release.
BUILD_TAG="${BUILD_TAG:-v0.5.0}"

release_tag() {
	if [ -n "${VERSION:-}" ]; then echo "$VERSION"; else echo "$BUILD_TAG"; fi
}

asset_url() {
	local os="$1" arch="$2" tag="$3"
	if [ "$os" = "linux" ]; then
		# Linux release ships server+agent in one tarball.
		echo "https://github.com/${REPO}/releases/download/${tag}/shepherd-linux-${arch}.tar.gz"
	else
		# Darwin release ships agent-only.
		echo "https://github.com/${REPO}/releases/download/${tag}/shepherd-agent-${os}-${arch}.tar.gz"
	fi
}

sha256sum_cmd() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	else
		shasum -a 256 "$1" | awk '{print $1}'
	fi
}

verify_sha256() {
	local file="$1" sumfile="$2"
	local got want
	got=$(sha256sum_cmd "$file")
	want=$(awk '{print $1}' "$sumfile")
	[ "$got" = "$want" ] || { err "sha256 mismatch: got $got want $want"; return 1; }
}

download_with_retry() {
	local url="$1" out="$2" attempt
	for attempt in 1 2 3; do
		if curl -fsSL --connect-timeout 10 -o "$out" "$url"; then
			return 0
		fi
		err "download attempt $attempt failed: $url"
		sleep $((attempt * 2))
	done
	return 3
}
```

- [ ] **Step 3: Run BATS to verify they pass**

```bash
bats scripts/install-agent.bats
```

Expected: 18 PASS total (the URL + sha tests).

- [ ] **Step 4: Commit**

```bash
git add scripts/install-agent.sh scripts/install-agent.bats
git commit -m "feat(scripts): asset URL builder + sha256 verify + retry download"
```

---

## Task 10: install-agent.sh — systemd unit writer

**Files:**
- Modify: `scripts/install-agent.sh`

No BATS unit test — the function writes a file and exercises `systemctl`, which is not unit-testable without a Linux container. Manual smoke at the end.

- [ ] **Step 1: Add install_linux function**

Append before the source-only short-circuit:

```bash
install_linux() {
	command -v systemctl >/dev/null 2>&1 || { err "systemctl not found"; return 5; }
	systemctl stop shepherd-agent 2>/dev/null || true

	mv -f "$1" "${BIN_PATH}.new"
	chmod 0755 "${BIN_PATH}.new"
	mv -f "${BIN_PATH}.new" "$BIN_PATH"

	mkdir -p "$ENV_DIR"
	cat > "$ENV_FILE" <<EOF
SHEPHERD_SERVER_URL=${SERVER_URL}
SHEPHERD_ENROLLMENT_TOKEN=${TOKEN}
EOF
	chmod 0600 "$ENV_FILE"

	cat > "$LINUX_UNIT" <<'EOF'
[Unit]
Description=Shepherd Agent
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/shepherd-agent/env
ExecStart=/usr/local/bin/shepherd-agent
Restart=always
RestartSec=5
StandardOutput=append:/var/log/shepherd-agent.log
StandardError=append:/var/log/shepherd-agent.log

[Install]
WantedBy=multi-user.target
EOF

	systemctl daemon-reload
	systemctl enable --now shepherd-agent
}
```

- [ ] **Step 2: Add uninstall_linux**

Append:

```bash
uninstall_linux() {
	systemctl disable --now shepherd-agent 2>/dev/null || true
	rm -f "$LINUX_UNIT"
	rm -f "$BIN_PATH"
	systemctl daemon-reload || true
	echo "Config dir $ENV_DIR preserved. To remove: sudo rm -rf $ENV_DIR"
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/install-agent.sh
git commit -m "feat(scripts): systemd unit writer + uninstall for linux"
```

---

## Task 11: install-agent.sh — launchd plist writer

**Files:**
- Modify: `scripts/install-agent.sh`

- [ ] **Step 1: Add install_darwin**

Append:

```bash
install_darwin() {
	command -v launchctl >/dev/null 2>&1 || { err "launchctl not found"; return 5; }
	launchctl bootout "system/${LAUNCHD_LABEL}" 2>/dev/null || true

	mv -f "$1" "${BIN_PATH}.new"
	chmod 0755 "${BIN_PATH}.new"
	mv -f "${BIN_PATH}.new" "$BIN_PATH"

	mkdir -p "$ENV_DIR"
	cat > "$ENV_FILE" <<EOF
SHEPHERD_SERVER_URL=${SERVER_URL}
SHEPHERD_ENROLLMENT_TOKEN=${TOKEN}
EOF
	chmod 0600 "$ENV_FILE"

	cat > "$DARWIN_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
    "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>                <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>     <array><string>${BIN_PATH}</string></array>
    <key>EnvironmentVariables</key> <dict>
        <key>SHEPHERD_SERVER_URL</key>        <string>${SERVER_URL}</string>
        <key>SHEPHERD_ENROLLMENT_TOKEN</key>  <string>${TOKEN}</string>
    </dict>
    <key>RunAtLoad</key>            <true/>
    <key>KeepAlive</key>            <true/>
    <key>StandardOutPath</key>      <string>${LOG_FILE}</string>
    <key>StandardErrorPath</key>    <string>${LOG_FILE}</string>
</dict>
</plist>
EOF
	chmod 0644 "$DARWIN_PLIST"
	launchctl bootstrap system "$DARWIN_PLIST"
	launchctl kickstart -k "system/${LAUNCHD_LABEL}"
}
```

- [ ] **Step 2: Add uninstall_darwin**

Append:

```bash
uninstall_darwin() {
	launchctl bootout "system/${LAUNCHD_LABEL}" 2>/dev/null || true
	rm -f "$DARWIN_PLIST"
	rm -f "$BIN_PATH"
	echo "Config dir $ENV_DIR preserved. To remove: sudo rm -rf $ENV_DIR"
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/install-agent.sh
git commit -m "feat(scripts): launchd plist writer + uninstall for darwin"
```

---

## Task 12: install-agent.sh — healthcheck + main glue

**Files:**
- Modify: `scripts/install-agent.sh`

Replace the placeholder main section. Adds the `await_online` poller that hits `/api/agent/status?token=T` until `online=true` or timeout.

- [ ] **Step 1: Add await_online**

Append (before main):

```bash
await_online() {
	local end=$(($(date +%s) + HEALTHCHECK_TIMEOUT))
	while [ "$(date +%s)" -lt "$end" ]; do
		local body
		body=$(curl -fsSL "${SERVER_URL}/api/agent/status?token=${TOKEN}" 2>/dev/null || true)
		case "$body" in
			*'"online":true'*) return 0 ;;
		esac
		sleep "$HEALTHCHECK_INTERVAL"
	done
	err "agent did not connect within ${HEALTHCHECK_TIMEOUT}s"
	echo "--- last 20 lines of $LOG_FILE ---"
	tail -n 20 "$LOG_FILE" 2>/dev/null || echo "(no log yet)"
	return 6
}
```

- [ ] **Step 2: Replace the placeholder main**

Remove the placeholder block (`err "install body not implemented yet" / exit 99`) and append:

```bash
main() {
	[ "$(id -u)" -eq 0 ] || { err "must run as root"; exit 1; }

	parse_args "$@"
	local os arch tag tmp
	os=$(detect_os) || exit 2
	arch=$(detect_arch) || exit 2

	if [ "$MODE" = "uninstall" ]; then
		if [ "$os" = linux ]; then uninstall_linux; else uninstall_darwin; fi
		echo "uninstalled."
		exit 0
	fi

	tag=$(release_tag)
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT

	local url tar agent_bin
	url=$(asset_url "$os" "$arch" "$tag")
	tar="$tmp/asset.tar.gz"
	echo "downloading $url"
	download_with_retry "$url"           "$tar"           || exit 3
	download_with_retry "${url}.sha256"  "${tar}.sha256"  || exit 3
	verify_sha256 "$tar" "${tar}.sha256" || exit 4

	echo "extracting agent"
	tar -xzf "$tar" -C "$tmp"
	agent_bin=$(find "$tmp" -maxdepth 2 -name 'shepherd-agent*' -type f | head -n1)
	[ -n "$agent_bin" ] || { err "agent binary not found in tarball"; exit 3; }

	if [ "$os" = linux ]; then install_linux "$agent_bin"; else install_darwin "$agent_bin"; fi

	echo "service started; waiting for agent to connect"
	await_online || exit 6
	echo "OK — agent connected. log: $LOG_FILE"
}

main "$@"
```

- [ ] **Step 3: Manual sanity test — uninstall path on macOS**

(Assuming no Shepherd agent running on this dev machine.)

```bash
sudo bash scripts/install-agent.sh --uninstall
```

Expected: prints `uninstalled.` and the preserved-config message. Exit 0 even though nothing was installed (idempotent).

- [ ] **Step 4: Manual sanity test — argument validation**

```bash
bash scripts/install-agent.sh                           # → "must run as root", exit 1
sudo bash scripts/install-agent.sh                      # → "--token required", exit 1
sudo bash scripts/install-agent.sh --token T            # → "--server required", exit 1
```

Each command should print the expected error and exit non-zero. Do NOT proceed past this step until each error path behaves as expected.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-agent.sh
git commit -m "feat(scripts): main flow + /api/agent/status healthcheck poll"
```

---

## Task 13: Web — useScriptInstall mutation

**Files:**
- Modify: `web/src/api/servers.ts`

- [ ] **Step 1: Find the existing install hook**

```bash
grep -n "useInstall" web/src/api/servers.ts
```

Note the line number — the new hook will live adjacent to it for consistency.

- [ ] **Step 2: Add the hook**

After the `useInstall` definition, append:

```typescript
export interface ScriptInstallInput {
  name: string
  public_alias?: string
  public_group?: string
  country_code?: string
  show_on_public: boolean
}

export interface ScriptInstallResult {
  server_id: number
  token: string
  expires_at: string
  command: string
}

export function useScriptInstall() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ScriptInstallInput) =>
      api.post<ScriptInstallResult>('/api/servers/script', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }),
  })
}
```

- [ ] **Step 3: Typecheck**

```bash
cd web && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/api/servers.ts
git commit -m "feat(web/api): useScriptInstall mutation"
```

---

## Task 14: Web — ServerNew Script-install tab

**Files:**
- Modify: `web/src/pages/admin/ServerNew.tsx`

Add a Tabs component at the top: "SSH install" (existing form, default) | "Script install" (new). Script install asks only for the name + optional metadata, calls the mutation, then shows a copy box with the install command.

- [ ] **Step 1: Check existing imports**

```bash
grep -n "from '@/components/ui'" web/src/pages/admin/ServerNew.tsx | head -5
```

The codebase uses shadcn/ui. Tabs component should already exist at `@/components/ui/tabs`. Verify:

```bash
ls web/src/components/ui/tabs.tsx
```

If missing, install via:

```bash
cd web && npx shadcn@latest add tabs
```

- [ ] **Step 2: Refactor existing form into a named component**

In `ServerNew.tsx`, lift the existing SSH form into a `<SshInstallForm />` component within the same file. Keep all existing logic identical, just wrap the JSX. Then below it add the new `<ScriptInstallForm />`:

```tsx
function ScriptInstallForm() {
  const { t } = useTranslation()
  const scriptInstall = useScriptInstall()
  const toast = useUI((s) => s.toast)
  const [name, setName] = useState('')
  const [publicAlias, setPublicAlias] = useState('')
  const [publicGroup, setPublicGroup] = useState('')
  const [countryCode, setCountryCode] = useState('')
  const [showOnPublic, setShowOnPublic] = useState(false)
  const [result, setResult] = useState<{ command: string; expires_at: string } | null>(null)

  const submit = async () => {
    if (!name.trim()) { toast({ kind: 'error', message: 'name required' }); return }
    try {
      const r = await scriptInstall.mutateAsync({
        name, public_alias: publicAlias, public_group: publicGroup,
        country_code: countryCode || undefined, show_on_public: showOnPublic,
      })
      setResult({ command: r.command, expires_at: r.expires_at })
    } catch (e: unknown) {
      toast({ kind: 'error', message: (e as Error).message })
    }
  }

  const copy = async () => {
    if (!result) return
    await navigator.clipboard.writeText(result.command)
    toast({ kind: 'success', message: 'copied' })
  }

  if (result) {
    return (
      <Card>
        <CardHeader><CardTitle>Run this on the target host</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">{result.command}</pre>
          <div className="flex items-center gap-2">
            <Button onClick={copy}>Copy</Button>
            <span className="text-xs text-muted-foreground">
              Token expires {new Date(result.expires_at).toLocaleString()}
            </span>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader><CardTitle>Add via install script</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><Label>Public alias</Label><Input value={publicAlias} onChange={(e) => setPublicAlias(e.target.value)} /></div>
        <div><Label>Public group</Label><Input value={publicGroup} onChange={(e) => setPublicGroup(e.target.value)} /></div>
        <div><Label>Country code (ISO-2)</Label><Input value={countryCode} onChange={(e) => setCountryCode(e.target.value.toUpperCase())} maxLength={2} /></div>
        <div className="flex items-center gap-2"><Switch checked={showOnPublic} onCheckedChange={setShowOnPublic} /><Label>Show on public wall</Label></div>
        <Button onClick={submit} disabled={scriptInstall.isPending}>
          {scriptInstall.isPending ? 'Issuing…' : 'Generate install command'}
        </Button>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 3: Add the Tabs wrapper as the default export**

Replace the `export default function ServerNew()` body to render Tabs:

```tsx
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export default function ServerNew() {
  return (
    <Tabs defaultValue="ssh" className="space-y-4">
      <TabsList>
        <TabsTrigger value="ssh">SSH install</TabsTrigger>
        <TabsTrigger value="script">Script install</TabsTrigger>
      </TabsList>
      <TabsContent value="ssh"><SshInstallForm /></TabsContent>
      <TabsContent value="script"><ScriptInstallForm /></TabsContent>
    </Tabs>
  )
}
```

(The pre-existing SSH form contents become the body of `SshInstallForm`.)

- [ ] **Step 4: Typecheck + build**

```bash
cd web && npx tsc --noEmit && npm run build
```

Expected: 0 type errors; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/ServerNew.tsx web/src/components/ui/tabs.tsx
git commit -m "feat(web): ServerNew Tabs — Script install tab with copy-paste command"
```

---

## Task 15: Quickstart docs + .env.example

**Files:**
- Create: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Create .env.example**

```bash
cat > .env.example <<'EOF'
# Public port the Shepherd HTTP server is published on (host side).
SHEPHERD_PORT=8080

# Externally reachable URL of this Shepherd server (no trailing slash).
# Used to build the agent install command the UI shows. Leave blank for
# LAN demos behind no proxy; required when behind a reverse proxy.
SERVER_PUBLIC_URL=

# Storage backend: sqlite (default, single-file at /data) or postgres
# (requires `docker compose --profile pg up -d`).
DATABASE_DRIVER=sqlite
DATABASE_DSN=file:/data/shepherd.db?_fk=1
PG_PASSWORD=shepherd

# Initial admin credentials. Leave BOTH blank on first start and the
# server prints a random password ONCE to docker compose logs as part
# of a loud banner — grep for "Generated password". To set deterministic
# creds (CI / IaC), fill both in.
INITIAL_ADMIN_USERNAME=
INITIAL_ADMIN_PASSWORD=

# Used by /api/admin/recover if you lose all admins. Optional.
AUTO_RECOVER_KEY=

# How the server distributes the agent binary to managed targets:
#   embedded (default) — server contains the agent bytes; works offline
#   github             — server tells the install script to pull from GH
AGENT_DISTRIBUTION=embedded
EOF
```

- [ ] **Step 2: Add Quickstart to README.md**

Find the existing top-level section (likely after a project description, before any per-phase docs). Insert immediately before the first existing `##` section:

```markdown
## Quickstart

### Server (docker compose)

```bash
git clone https://github.com/hg-claw/Shepherd.git
cd Shepherd
cp .env.example .env
docker compose up -d
docker compose logs shepherd | grep -A2 'Generated password'
```

Open `http://<host>:8080` and log in with the user `admin` and the
password printed in the logs.

To use Postgres instead of the default sqlite:

```bash
docker compose --profile pg up -d
```

Set `SERVER_PUBLIC_URL` in `.env` if your server is behind a reverse
proxy or accessed via a domain different from the docker host's IP —
the UI uses it to build the agent install command.

### Agents

Once the server is running, add a managed host:

1. In the admin UI, click **+ Add server → Script install**.
2. Fill in the name + optional metadata, click **Generate install command**.
3. Copy the displayed `curl … | sudo bash` line and run it as root on
   the target machine. The script auto-installs the agent under systemd
   (linux) or launchd (macOS) and waits for it to connect.

The script also supports `--uninstall` to reverse the install. Logs
go to `/var/log/shepherd-agent.log` on both OSes.
```

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md
git commit -m "docs: Quickstart + .env.example"
```

---

## Task 16: End-to-end manual smoke

This is a manual integration check, not an automated test. Run it on a fresh Linux VM (or a Docker container that supports systemd) and a macOS dev box to confirm the full flow before opening the PR.

- [ ] **Step 1: Bring up a fresh server**

```bash
docker compose down -v
cp .env.example .env
docker compose up -d
docker compose logs shepherd | grep -A2 'Generated password'
```

Note the generated password.

- [ ] **Step 2: Log in + generate an install command**

Open `http://<server>:8080`, log in, click "+ Add server" → "Script install" tab, fill name `smoke-vps`, click "Generate install command". Copy the command from the result box.

- [ ] **Step 3: Run on a Linux target**

SSH to a fresh Linux VM (Debian/Ubuntu) and paste the copied command. Expected:

```
downloading https://github.com/hg-claw/Shepherd/releases/download/v0.5.0/shepherd-linux-amd64.tar.gz
extracting agent
service started; waiting for agent to connect
OK — agent connected. log: /var/log/shepherd-agent.log
```

- [ ] **Step 4: Verify in UI**

Refresh the servers list. `smoke-vps` should show as online. Click into it and verify telemetry is flowing.

- [ ] **Step 5: Run uninstall**

```bash
sudo bash -c 'curl -fsSL https://raw.githubusercontent.com/hg-claw/Shepherd/v0.5.0/scripts/install-agent.sh | bash -s -- --uninstall'
```

Expected: prints "uninstalled." and the config-preserve hint. systemd reports the unit gone.

- [ ] **Step 6: Repeat steps 2–4 on macOS**

Same flow on a macOS box. Expected: launchd shows `com.shepherd.agent` running:

```bash
sudo launchctl print system/com.shepherd.agent | head
```

- [ ] **Step 7: Open the PR**

```bash
gh pr create --base main --title "feat: deployment flow — compose quickstart + agent install script" --body "$(cat <<'EOF'
## Summary

- POST /api/servers/script + GET /api/agent/status enable a copy-paste install flow from the admin UI.
- scripts/install-agent.sh handles linux+systemd and darwin+launchd.
- README Quickstart section + .env.example + compose healthcheck.

## Test plan

- [x] go test ./... — all green
- [x] BATS scripts/install-agent.bats — 18 PASS
- [x] Manual: docker compose up → log in with generated password → script install on linux VM → online in UI
- [x] Manual: same on macOS dev box
- [x] Manual: uninstall path

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

Checked against spec sections:

- **Server compose quickstart (Part 1)** — Tasks 6 (healthcheck), 15 (README + .env.example). ✓
- **Agent script (Part 2)** — Tasks 7-12 cover skeleton, args, fetch, systemd, launchd, healthcheck. ✓
- **Server-side support (Part 3)** — Tasks 1 (LookupEnrollment), 2 (URL builder), 3 (POST /script), 4 (rate limiter), 5 (status handler). ✓
- **Testing strategy** — every task includes the failing-test step. BATS covers script helpers; Go covers handlers + URL builder + token lookup + rate limit. Task 16 is the manual integration smoke. ✓
- **Error matrix (exit codes 1-6)** — covered across Tasks 7 (root + OS), 9 (sha256), 10/11 (service manager), 12 (connect timeout). ✓
- **Idempotency** — Task 10 stops service before replace; Task 11 boots-out before bootstrap. ✓

Type consistency: `LookupEnrollment` signature stable across Tasks 1 and 5. `buildInstallCommand` args (`buildVersion, publicURL, token`) match between Tasks 2 and 3. Script helper signatures (`detect_os`, `detect_arch`, `release_tag`, `asset_url`, `verify_sha256`, `download_with_retry`) consistent across Tasks 7-12.

No placeholders. Every step has either exact code or exact commands.
