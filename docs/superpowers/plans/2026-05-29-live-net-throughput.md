# Live 1s Network Throughput — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stream ~1s network throughput from each agent over its WebSocket to an in-memory server hub, fan it out to admin browsers over a WebSocket, and show a live ↑/↓ readout + rolling sparkline on ServerDetail.

**Architecture:** Always-on agent `livenetsampler` (separate `NetMeter`, rate-only `live.net` frames) → `Ingest.HandleFrame` routes to an in-memory `livenet.Hub` (per-server latest + 60-ring + browser watchers) — a path entirely separate from `WriteSample`, so sub-project B's cumulative bytes are untouched. A browser WebSocket (mirroring the PTY console) attaches watchers; a `useLiveNet` hook drives the UI card.

**Tech Stack:** Go, gorilla/websocket, gopsutil net (via existing NetMeter), React/TS + a raw WebSocket hook, vitest. No DB / migration (ephemeral).

**Spec:** `docs/superpowers/specs/2026-05-29-live-net-throughput-design.md`

Run from `/Users/hg/project/Shepherd`; never `git checkout`/`reset`/`stash` (commit on `feat/live-net-throughput`). Frontend cmds from `web/`; do NOT run `npm run build`. Rate-only throughout: `live.net` carries `rx_bps`/`tx_bps`, never byte deltas, never persisted.

---

## Task 1: agentapi type + livenetsampler

**Files:**
- Modify: `internal/agentapi/types.go`
- Create: `internal/agent/livenetsampler/sampler.go`
- Test: `internal/agent/livenetsampler/sampler_test.go`

- [ ] **Step 1: Add wire type** to `internal/agentapi/types.go` — add to the `const (...)` block (after `TypeHostInventory`):
```go
	// TypeLiveNet: agent → server, ~1s, rate-only. Ephemeral live throughput
	// for the detail page; NEVER accumulated into cumulative traffic.
	TypeLiveNet = "live.net"
```
and add the payload struct (near `Telemetry`):
```go
type LiveNetSample struct {
	TS    time.Time `json:"ts"`
	RxBps int64     `json:"rx_bps"`
	TxBps int64     `json:"tx_bps"`
}
```
(`time` is already imported in types.go.)

- [ ] **Step 2: Write failing tests** — create `internal/agent/livenetsampler/sampler_test.go`:
```go
package livenetsampler

import (
	"context"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

func TestTick_SendsWhenOK(t *testing.T) {
	var sent []agentapi.Envelope
	s := &Sampler{
		Send:   func(e agentapi.Envelope) error { sent = append(sent, e); return nil },
		Source: func() (int64, int64, bool) { return 100, 200, true },
	}
	s.tick()
	if len(sent) != 1 || sent[0].Type != agentapi.TypeLiveNet {
		t.Fatalf("expected one live.net frame, got %+v", sent)
	}
	var p agentapi.LiveNetSample
	if err := sent[0].Decode(&p); err != nil || p.RxBps != 100 || p.TxBps != 200 {
		t.Fatalf("payload: %+v err=%v", p, err)
	}
}

func TestTick_SkipsWhenNotOK(t *testing.T) {
	called := false
	s := &Sampler{
		Send:   func(e agentapi.Envelope) error { called = true; return nil },
		Source: func() (int64, int64, bool) { return 0, 0, false },
	}
	s.tick()
	if called {
		t.Fatal("should not send when source not ok")
	}
}

func TestRun_StopsOnCancel(t *testing.T) {
	s := &Sampler{
		Interval: 5 * time.Millisecond,
		Send:     func(e agentapi.Envelope) error { return nil },
		Source:   func() (int64, int64, bool) { return 1, 1, true },
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not return after cancel")
	}
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/agent/livenetsampler/ -v`
Expected: FAIL — package/Sampler undefined.

- [ ] **Step 4: Implement `internal/agent/livenetsampler/sampler.go`:**
```go
// Package livenetsampler emits ~1s rate-only network throughput frames
// (TypeLiveNet) for the live server-detail view. It is intentionally
// independent of the 30s telemetry collector and carries NO byte deltas, so it
// never feeds cumulative-traffic accumulation.
package livenetsampler

import (
	"context"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// Sampler pushes a LiveNetSample every Interval while Run's context is live.
type Sampler struct {
	// Send is the agent's envelope sender (client.Send). Nil = no-op.
	Send func(agentapi.Envelope) error
	// Source returns the current rx/tx bps and ok=false to skip a tick
	// (first call primes the underlying meter). Injected for testability.
	Source func() (rxBps, txBps int64, ok bool)
	// Interval defaults to 1s.
	Interval time.Duration
}

func (s *Sampler) tick() {
	if s.Send == nil || s.Source == nil {
		return
	}
	rx, tx, ok := s.Source()
	if !ok {
		return
	}
	env, err := agentapi.Frame(agentapi.TypeLiveNet, agentapi.LiveNetSample{
		TS: time.Now().UTC(), RxBps: rx, TxBps: tx,
	})
	if err != nil {
		return
	}
	_ = s.Send(env)
}

// Run blocks until ctx is canceled, ticking every Interval (default 1s).
func (s *Sampler) Run(ctx context.Context) {
	interval := s.Interval
	if interval <= 0 {
		interval = time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick()
		}
	}
}
```

- [ ] **Step 5: Run to verify pass + gofmt/vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/agent/livenetsampler/ -v && gofmt -l internal/agent/livenetsampler/sampler.go internal/agentapi/types.go && go vet ./internal/agent/livenetsampler/ ./internal/agentapi/`
Expected: PASS; gofmt empty; vet clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/agentapi/types.go internal/agent/livenetsampler/
git commit -m "feat(agent): live.net wire type + livenetsampler (1s rate-only)"
```

---

## Task 2: Wire the sampler into the agent

**Files:**
- Modify: `internal/agent/wsclient/client.go`
- Modify: `cmd/agent/main.go`

- [ ] **Step 1: Add the Client field** — in `internal/agent/wsclient/client.go`, add to the `Client` struct (next to `NetqualitySampler`):
```go
	// LiveNetSampler, if non-nil, is started as a goroutine after each WS
	// connect (always-on 1s rate-only live throughput).
	LiveNetSampler *livenetsampler.Sampler
```
Add the import `"github.com/hg-claw/Shepherd/internal/agent/livenetsampler"` to client.go.

- [ ] **Step 2: Spawn it in `dialAndRun`** — immediately AFTER the `if c.NetqualitySampler != nil { … go c.NetqualitySampler.Run(nqCtx) }` block (ends ~line 269), add the same per-connection pattern:
```go
	if c.LiveNetSampler != nil {
		lnCtx, lnCancel := context.WithCancel(ctx)
		go func() {
			select {
			case <-stop:
				lnCancel()
			case <-ctx.Done():
				lnCancel()
			}
		}()
		go c.LiveNetSampler.Run(lnCtx)
	}
```

- [ ] **Step 3: Construct it in `cmd/agent/main.go`** — where the other samplers are built (after `netqSampler := &netqualitysampler.Sampler{Send: client.Send}; client.NetqualitySampler = netqSampler`), add:
```go
	liveNetMeter := &collector.NetMeter{}
	liveNetSampler := &livenetsampler.Sampler{
		Send: client.Send,
		Source: func() (int64, int64, bool) {
			rx, tx, _, _, ok := liveNetMeter.Sample()
			return rx, tx, ok
		},
	}
	client.LiveNetSampler = liveNetSampler
```
Add imports to main.go if missing: `"github.com/hg-claw/Shepherd/internal/agent/collector"` and `"github.com/hg-claw/Shepherd/internal/agent/livenetsampler"`.
> Implementer note: `collector` is likely already imported (the 30s `Collector` is constructed in main.go). The `Source` closure owns its OWN `NetMeter` instance — separate prev counters from the 30s collector's meter, so the two never interfere. It returns rx/tx bps and drops the byte deltas (rate-only).

- [ ] **Step 4: Build + vet + gofmt**

Run: `cd /Users/hg/project/Shepherd && go build ./... && go vet ./internal/agent/wsclient/ ./cmd/agent/ && gofmt -l internal/agent/wsclient/client.go cmd/agent/main.go`
Expected: build OK; vet clean; gofmt empty.

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/agent/wsclient/client.go cmd/agent/main.go
git commit -m "feat(agent): start livenetsampler on WS connect"
```

---

## Task 3: Server-side livenet.Hub

**Files:**
- Create: `internal/livenet/hub.go`
- Test: `internal/livenet/hub_test.go`

- [ ] **Step 1: Write failing tests** — create `internal/livenet/hub_test.go`:
```go
package livenet

import (
	"errors"
	"testing"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

type fakeConn struct {
	got  []agentapi.LiveNetSample
	fail bool
}

func (c *fakeConn) WriteJSON(v any) error {
	if c.fail {
		return errors.New("boom")
	}
	c.got = append(c.got, v.(agentapi.LiveNetSample))
	return nil
}

func TestHub_PublishFansOutToWatchers(t *testing.T) {
	h := NewHub()
	c := &fakeConn{}
	detach := h.Attach(1, c)
	defer detach()
	h.Publish(1, agentapi.LiveNetSample{RxBps: 10, TxBps: 20})
	if len(c.got) != 1 || c.got[0].RxBps != 10 {
		t.Fatalf("watcher got %+v", c.got)
	}
	// a different server's publish is not delivered
	h.Publish(2, agentapi.LiveNetSample{RxBps: 99})
	if len(c.got) != 1 {
		t.Fatalf("cross-server leak: %+v", c.got)
	}
}

func TestHub_AttachBackfillsRing(t *testing.T) {
	h := NewHub()
	for i := 0; i < 65; i++ {
		h.Publish(1, agentapi.LiveNetSample{RxBps: int64(i)})
	}
	c := &fakeConn{}
	detach := h.Attach(1, c)
	defer detach()
	// ring keeps the most recent 60
	if len(c.got) != 60 || c.got[0].RxBps != 5 || c.got[59].RxBps != 64 {
		t.Fatalf("backfill got %d items, first=%+v last=%+v", len(c.got), c.got[0], c.got[len(c.got)-1])
	}
}

func TestHub_DetachStopsDelivery(t *testing.T) {
	h := NewHub()
	c := &fakeConn{}
	detach := h.Attach(1, c)
	detach()
	h.Publish(1, agentapi.LiveNetSample{RxBps: 1})
	if len(c.got) != 0 {
		t.Fatalf("got delivery after detach: %+v", c.got)
	}
}

func TestHub_DropsConnOnWriteError(t *testing.T) {
	h := NewHub()
	bad := &fakeConn{fail: true}
	_ = h.Attach(1, bad)
	h.Publish(1, agentapi.LiveNetSample{RxBps: 1}) // bad errors → dropped
	good := &fakeConn{}
	_ = h.Attach(1, good)
	h.Publish(1, agentapi.LiveNetSample{RxBps: 2})
	if len(good.got) == 0 {
		t.Fatal("good conn should still receive")
	}
}
```
> Note on `AttachBackfillsRing`: `bad` has `fail:true`, so its backfill `WriteJSON` errors and `Attach` must NOT register it (returns a no-op detach) — see Step 3 behavior.

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/livenet/ -v`
Expected: FAIL — package undefined.

- [ ] **Step 3: Implement `internal/livenet/hub.go`:**
```go
// Package livenet holds the in-memory fan-out hub for ~1s live network
// throughput. State is ephemeral (latest sample + a short ring per server +
// the set of attached browser watchers); nothing is persisted.
package livenet

import (
	"sync"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// ringSize bounds the per-server backfill replayed to a newly attached watcher
// (≈ the sparkline window at 1s resolution).
const ringSize = 60

// Conn is the minimal browser-connection sink the hub writes to. *websocket.Conn
// satisfies it; tests use a fake.
type Conn interface {
	WriteJSON(v any) error
}

type serverState struct {
	ring     []agentapi.LiveNetSample
	watchers map[Conn]struct{}
}

// Hub fans out live samples to browser watchers, per server. Safe for
// concurrent use; all conn writes happen under the hub lock (bounded by the
// connection's own write deadline), so a stalled client can't corrupt state.
type Hub struct {
	mu      sync.Mutex
	servers map[int64]*serverState
}

func NewHub() *Hub { return &Hub{servers: map[int64]*serverState{}} }

func (h *Hub) stateLocked(serverID int64) *serverState {
	st := h.servers[serverID]
	if st == nil {
		st = &serverState{watchers: map[Conn]struct{}{}}
		h.servers[serverID] = st
	}
	return st
}

// Publish records a sample (updating the ring) and broadcasts it to the
// server's watchers. A watcher whose write fails is dropped.
func (h *Hub) Publish(serverID int64, s agentapi.LiveNetSample) {
	h.mu.Lock()
	defer h.mu.Unlock()
	st := h.stateLocked(serverID)
	st.ring = append(st.ring, s)
	if len(st.ring) > ringSize {
		st.ring = st.ring[len(st.ring)-ringSize:]
	}
	for c := range st.watchers {
		if err := c.WriteJSON(s); err != nil {
			delete(st.watchers, c)
		}
	}
}

// Attach replays the current ring to c (immediate paint), then registers it as
// a watcher. If the backfill write fails the conn is not registered. The
// returned func deregisters the watcher.
func (h *Hub) Attach(serverID int64, c Conn) func() {
	h.mu.Lock()
	defer h.mu.Unlock()
	st := h.stateLocked(serverID)
	for _, s := range st.ring {
		if err := c.WriteJSON(s); err != nil {
			return func() {}
		}
	}
	st.watchers[c] = struct{}{}
	return func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if s := h.servers[serverID]; s != nil {
			delete(s.watchers, c)
		}
	}
}
```

- [ ] **Step 4: Run to verify pass + gofmt/vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/livenet/ -v && gofmt -l internal/livenet/hub.go && go vet ./internal/livenet/`
Expected: PASS; gofmt empty; vet clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/livenet/
git commit -m "feat(livenet): in-memory per-server live-throughput fan-out hub"
```

---

## Task 4: Ingest dispatch + hub wiring

**Files:**
- Modify: `internal/telemetrysvc/ingest.go`
- Modify: `cmd/server/main.go`
- Test: `internal/telemetrysvc/livenet_ingest_test.go` (create)

- [ ] **Step 1: Write failing test** — create `internal/telemetrysvc/livenet_ingest_test.go`:
```go
package telemetrysvc

import (
	"context"
	"testing"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/livenet"
)

type capConn struct{ got []agentapi.LiveNetSample }

func (c *capConn) WriteJSON(v any) error {
	c.got = append(c.got, v.(agentapi.LiveNetSample))
	return nil
}

func TestHandleFrame_LiveNet_ToHubNotAccumulated(t *testing.T) {
	ing, sid := newIngest(t)
	hub := livenet.NewHub()
	ing.LiveNet = hub
	conn := &capConn{}
	detach := hub.Attach(sid, conn)
	defer detach()

	env, _ := agentapi.Frame(agentapi.TypeLiveNet, agentapi.LiveNetSample{RxBps: 123, TxBps: 456})
	ing.HandleFrame(context.Background(), sid, env)

	if len(conn.got) != 1 || conn.got[0].RxBps != 123 {
		t.Fatalf("hub did not get sample: %+v", conn.got)
	}
	// a live.net frame must NOT create/touch host_traffic (B's accumulation)
	var n int
	_ = ing.DB.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM host_traffic WHERE server_id=$1`, sid).Scan(&n)
	if n != 0 {
		t.Fatalf("live.net must not write host_traffic, got %d rows", n)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/telemetrysvc/ -run TestHandleFrame_LiveNet -v`
Expected: FAIL — `ing.LiveNet` undefined.

- [ ] **Step 3: Add the field + dispatch case** — in `internal/telemetrysvc/ingest.go`:

Add the import `"github.com/hg-claw/Shepherd/internal/livenet"` and a field to the `Ingest` struct:
```go
type Ingest struct {
	DB      *sqlx.DB
	LiveNet *livenet.Hub // optional; live throughput fan-out
}
```
Add a case to the `HandleFrame` switch (after `TypeHostInventory`):
```go
	case agentapi.TypeLiveNet:
		if i.LiveNet == nil {
			return
		}
		var s agentapi.LiveNetSample
		if err := env.Decode(&s); err != nil {
			log.Printf("live.net decode (server=%d): %v", serverID, err)
			return
		}
		i.LiveNet.Publish(serverID, s)
```

- [ ] **Step 4: Wire the hub in `cmd/server/main.go`** — where `Ingest` is constructed (search `telemetrysvc.Ingest{` or `&telemetrysvc.Ingest{`), create the hub before it and set the field. Add:
```go
	liveNetHub := livenet.NewHub()
```
and set `LiveNet: liveNetHub` on the `Ingest` literal (or assign `ingest.LiveNet = liveNetHub` after construction — match the existing construction style). Add the import `"github.com/hg-claw/Shepherd/internal/livenet"`.
> Implementer note: keep the `liveNetHub` variable in scope — Task 5 injects the same instance into the browser-WS API. Read how `Ingest` is currently built/handed to the agent API and mirror it.

- [ ] **Step 5: Run test + build + gofmt/vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/telemetrysvc/ -run TestHandleFrame_LiveNet -v && go build ./... && gofmt -l internal/telemetrysvc/ingest.go cmd/server/main.go && go vet ./internal/telemetrysvc/ ./cmd/server/`
Expected: PASS; build OK; gofmt empty; vet clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/telemetrysvc/ingest.go internal/telemetrysvc/livenet_ingest_test.go cmd/server/main.go
git commit -m "feat(telemetry): route live.net frames to the livenet hub (no accumulation)"
```

---

## Task 5: Browser WebSocket endpoint

**Files:**
- Create: `internal/api/livenet_routes.go`
- Modify: `internal/api/router.go`
- Modify: `cmd/server/main.go`
- Test: `internal/api/livenet_routes_test.go` (create)

- [ ] **Step 1: Write failing test** — create `internal/api/livenet_routes_test.go` (auth gate; the fan-out logic is covered by the hub tests):
```go
package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hg-claw/Shepherd/internal/livenet"
)

func TestLiveNetAttachWS_RequiresAdmin(t *testing.T) {
	a := &LiveNetAPI{Hub: livenet.NewHub()}
	rec := httptest.NewRecorder()
	// no admin in context → 401, no upgrade attempted
	req := httptest.NewRequest("GET", "/api/admin/servers/1/net-live/ws", nil)
	a.AttachWS(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without admin, got %d", rec.Code)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/api/ -run TestLiveNetAttachWS_RequiresAdmin -v`
Expected: FAIL — `LiveNetAPI` undefined.

- [ ] **Step 3: Implement `internal/api/livenet_routes.go`:**
```go
package api

import (
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/hg-claw/Shepherd/internal/auth"
	"github.com/hg-claw/Shepherd/internal/livenet"
)

type LiveNetAPI struct {
	Hub *livenet.Hub
}

var liveNetUpgrader = websocket.Upgrader{
	ReadBufferSize: 1024, WriteBufferSize: 4 * 1024,
	CheckOrigin: func(*http.Request) bool { return true },
}

// wsLiveConn adapts *websocket.Conn to livenet.Conn with a write deadline so a
// stalled browser can't block the hub indefinitely.
type wsLiveConn struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (c *wsLiveConn) WriteJSON(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return c.conn.WriteJSON(v)
}

// AttachWS streams ~1s live throughput for one server to an admin browser.
func (a *LiveNetAPI) AttachWS(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.AdminFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "unauth")
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, 400, "bad id")
		return
	}
	conn, err := liveNetUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()
	detach := a.Hub.Attach(id, &wsLiveConn{conn: conn})
	defer detach()
	// Read loop: we never expect inbound frames; reading just detects close.
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}
```
> Implementer note: confirm `writeError` + `auth.AdminFromContext` signatures by reading `console_routes.go` (same package); `r.PathValue("id")` works because the route is registered with a `{id}` pattern (Step 4). The 401 path returns before `Upgrade`, so the test (a plain ResponseRecorder, not a hijackable conn) exercises the auth gate cleanly.

- [ ] **Step 4: Register the route + Router field** — in `internal/api/router.go`:

Add a field to the `Router` struct (after `Console *ConsoleAPI`):
```go
	LiveNet    *LiveNetAPI
```
In the `Handler()` method, where admin routes are registered (near the console route `admin.HandleFunc("GET /api/admin/console/ws", r.Console.AttachWS)`), add a nil-guarded registration:
```go
	if r.LiveNet != nil {
		admin.HandleFunc("GET /api/servers/{id}/net-live/ws", r.LiveNet.AttachWS)
	}
```
> Implementer note: `LiveNet` is set as a post-construction field (NOT added to `NewRouter`'s positional signature, to avoid churning every caller). Read `Handler()` to find the exact admin-mux variable name (`admin`) and place the registration alongside the other per-server `/api/servers/{id}/...` routes. The nil guard means existing `NewRouter` callers/tests that don't set it simply skip the route.

- [ ] **Step 5: Wire in `cmd/server/main.go`** — after the Router is constructed (and the `liveNetHub` from Task 4 is in scope), set the field before `Handler()` is called:
```go
	router.LiveNet = &api.LiveNetAPI{Hub: liveNetHub}
```
> Implementer note: use the actual router variable name in main.go (e.g. `router`/`r`). It must be set BEFORE `.Handler()` / `.WithPlugins()` is invoked to serve. Mirror where `Console` is wired.

- [ ] **Step 6: Run test + full api package + build + gofmt/vet**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/api/ -run TestLiveNetAttachWS_RequiresAdmin -v && go test ./internal/api/ && go build ./... && gofmt -l internal/api/livenet_routes.go internal/api/router.go cmd/server/main.go && go vet ./internal/api/ ./cmd/server/`
Expected: PASS; build OK; gofmt empty; vet clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/api/livenet_routes.go internal/api/router.go internal/api/livenet_routes_test.go cmd/server/main.go
git commit -m "feat(api): browser WebSocket for live net throughput"
```

---

## Task 6: Admin UI — useLiveNet + Live card

**Files:**
- Create: `web/src/api/livenet.ts`
- Modify: `web/src/pages/admin/ServerDetail.tsx`
- Test: `web/src/pages/admin/ServerDetail.test.tsx`

- [ ] **Step 1: Create `web/src/api/livenet.ts`:**
```ts
import { useEffect, useRef, useState } from 'react'

export type LiveNetSample = { ts: string; rx_bps: number; tx_bps: number }
export type LivePoint = { ts: string; v: number }

export function liveNetWSURL(id: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/servers/${id}/net-live/ws`
}

const WINDOW = 60

export function useLiveNet(id: number) {
  const [rx, setRx] = useState<number | null>(null)
  const [tx, setTx] = useState<number | null>(null)
  const [rxSeries, setRxSeries] = useState<LivePoint[]>([])
  const [txSeries, setTxSeries] = useState<LivePoint[]>([])
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!id) return
    const ws = new WebSocket(liveNetWSURL(id))
    wsRef.current = ws
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onmessage = (ev) => {
      let s: LiveNetSample
      try {
        s = JSON.parse(ev.data as string)
      } catch {
        return
      }
      setRx(s.rx_bps)
      setTx(s.tx_bps)
      setRxSeries((prev) => [...prev, { ts: s.ts, v: s.rx_bps }].slice(-WINDOW))
      setTxSeries((prev) => [...prev, { ts: s.ts, v: s.tx_bps }].slice(-WINDOW))
    }
    return () => {
      ws.onmessage = null
      ws.close()
      wsRef.current = null
    }
  }, [id])

  return { rx, tx, rxSeries, txSeries, connected }
}
```

- [ ] **Step 2: Add the Live card** to `web/src/pages/admin/ServerDetail.tsx`. READ the file; reuse its `Card`/`CardHeader`/`CardTitle`/`CardContent`, `TimeSeriesChart`, and the `bps()` humanizer (already imported for the net chart). Add near the existing net chart:
```tsx
const live = useLiveNet(id)
```
and a card:
```tsx
<Card>
  <CardHeader><CardTitle>实时网速</CardTitle></CardHeader>
  <CardContent className="min-w-0">
    {live.rx === null ? (
      <p className="text-muted-foreground text-[12px]">{live.connected ? '等待数据…' : '未连接'}</p>
    ) : (
      <>
        <div className="text-[13px] mb-2">↑ {bps(live.tx ?? 0)}　↓ {bps(live.rx ?? 0)}</div>
        <TimeSeriesChart
          series={[
            { name: 'rx', values: live.rxSeries },
            { name: 'tx', values: live.txSeries },
          ]}
          yFormat={(v) => bps(v)}
          tooltipFormat={(v) => bps(v)}
        />
      </>
    )}
  </CardContent>
</Card>
```
Import `useLiveNet` from `../../api/livenet` (match the file's import style). Mirror the existing net `<Card>` markup exactly; up=tx, down=rx (consistent with the rest of the app).
> Implementer note: confirm `bps()` + `TimeSeriesChart` import paths from the existing net chart in the same file; reuse them verbatim. `live.rx`/`live.tx` are the readout; the series feed the sparkline.

- [ ] **Step 3: Add a vitest** to `web/src/pages/admin/ServerDetail.test.tsx`. READ it first (it mocks `@/api/servers`). Mock `@/api/livenet`'s `useLiveNet` to return a populated value (`{ rx: 100, tx: 200, rxSeries: [{ts:'t', v:100}], txSeries: [{ts:'t', v:200}], connected: true }`) and assert the card shows "实时网速" and the formatted readout; add a `rx: null, connected:false` case → shows "未连接". Keep other hook mocks intact.
> Implementer note: mock the `@/api/livenet` module with `vi.mock` (don't try to drive a real WebSocket in jsdom). Mirror how the test already mocks `@/api/servers`.

- [ ] **Step 4: Run vitest + tsc**

Run: `cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/admin/ServerDetail.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add web/src/api/livenet.ts web/src/pages/admin/ServerDetail.tsx web/src/pages/admin/ServerDetail.test.tsx
git commit -m "feat(web): live net throughput card (WS readout + sparkline)"
```

---

## Task 7: Full verification

- [ ] **Step 1: Full Go suite (with -race) + vet + build**

Run: `cd /Users/hg/project/Shepherd && go build ./... && go test -race ./internal/agent/... ./internal/livenet/... ./internal/telemetrysvc/... ./internal/api/... && go test ./... && go vet ./...`
Expected: build OK; race-clean; all packages PASS; vet clean.

- [ ] **Step 2: gofmt on changed Go files**

Run: `cd /Users/hg/project/Shepherd && gofmt -l internal/agentapi/types.go internal/agent/livenetsampler/ internal/agent/wsclient/client.go cmd/agent/main.go internal/livenet/ internal/telemetrysvc/ingest.go internal/api/livenet_routes.go internal/api/router.go cmd/server/main.go`
Expected: prints nothing.

- [ ] **Step 3: Frontend tsc + full vitest**

Run: `cd /Users/hg/project/Shepherd/web && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all suites PASS.

- [ ] **Step 4: Restore embed artifact if touched + clean tree**

Run: `cd /Users/hg/project/Shepherd && git checkout -- internal/web/dist/.gitkeep 2>/dev/null; git status --short`
Expected: clean.

---

## Self-Review Notes

- **Spec coverage:** live.net rate-only type + always-on livenetsampler with test seam (Task 1) ✓; per-connection spawn + own NetMeter instance (Task 2) ✓; in-memory Hub with latest+60-ring+watchers, fan-out, backfill, drop-on-error (Task 3) ✓; ingest case routing to hub + the explicit "no host_traffic accumulation" assertion (Task 4) ✓; browser WS mirroring console with cookie auth + write-deadline adapter (Task 5) ✓; useLiveNet hook + readout+sparkline card (Task 6) ✓; `-race` verification (Task 7) ✓. Ephemeral/no-DB honored (no migration). Out-of-scope (on-demand, persistence, public) absent.
- **Refinement vs spec:** spec sketched `Attach` returning `(backfill, detach)`; the plan writes the backfill **inside** `Attach` under the hub lock and returns just `detach` — this closes a race where a concurrent `Publish` could interleave with the handler writing the backfill to a freshly-registered conn. Functionally equivalent (immediate paint), strictly safer.
- **Type consistency:** `agentapi.LiveNetSample{TS,RxBps,TxBps}` (json ts/rx_bps/tx_bps) is identical agent→hub→ingest→WS→TS `LiveNetSample`. `livenet.Conn` = `WriteJSON(v any) error` satisfied by `*websocket.Conn` (via `wsLiveConn`) and the test `fakeConn`/`capConn`. `Ingest.LiveNet *livenet.Hub` shared (one `liveNetHub`) across ingest (Task 4) + API (Task 5). up=tx / down=rx consistent through the UI.
- **No double-count with B:** `live.net` has its own `HandleFrame` case that only calls `Hub.Publish`; it never reaches `WriteSample`. Task 4's test asserts a `live.net` frame leaves `host_traffic` empty.
- **Concurrency:** hub writes occur under its mutex, each bounded by the conn's 5s write deadline; Publish for a given server comes from that agent's single reader goroutine. (A per-watcher buffered-channel writer would reduce head-of-line blocking but is unnecessary at admin-tool scale — noted, not built.)
- **CI gate:** Task 7 runs `go test -race` (covers the hub fan-out + agent goroutines).
