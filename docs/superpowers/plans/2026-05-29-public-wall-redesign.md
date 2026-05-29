# Public Wall Redesign + 1s Live Net — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rebuild the public Wall as a Dstatus-style probe dashboard (List default + Grid toggle, summary strip, region groups, per-server metric bars + cumulative traffic + platform·arch + load), with the network rate updating live (~1s) via a single multiplexed public WebSocket reusing sub-project C's hub.

**Architecture:** Backend extends `publicCard` with platform/arch (servers row) + cumulative traffic (sub-project B's `host_traffic`), and adds a public, anonymous multiplexed live-net WS that `Subscribe`s one shared browser conn to every opted-in server in `livenet.Hub` (tagging each frame with `server_id`). Frontend rewrites `Wall.tsx` and overlays the live net map onto the 30s-polled cards.

**Tech Stack:** Go, gorilla/websocket (existing `wsLiveConn`+`liveNetUpgrader` in the `api` pkg), React/TS + react-query + a raw WS hook, vitest. No DB/migration.

**Spec:** `docs/superpowers/specs/2026-05-29-public-wall-redesign-design.md`
**Design bundle reference (read for visual fidelity):** `/Users/hg/.claude/projects/-Users-hg-project-Shepherd/6caeb6d7-588f-4de9-a42d-73f890e089ee/tool-results/design_extract/shepherd-design-system/project/ui_kits/shepherd-web/Wall.jsx`

Run from `/Users/hg/project/Shepherd`; never `git checkout`/`reset`/`stash` (commit on `feat/public-wall-redesign`). Frontend cmds from `web/`; do NOT run `npm run build`. Run `golangci-lint run --timeout=5m` before finishing Go work (CI runs it; go vet+gofmt miss staticcheck). up=tx=BytesSent, down=rx=BytesRecv throughout.

---

## Task 1: Backend — platform/arch + cumulative traffic on the public card

**Files:**
- Modify: `internal/api/public.go`
- Test: `internal/api/public_test.go`

- [ ] **Step 1: Write the failing test.** Read `internal/api/public_test.go` for the harness that builds a `PublicAPI` (with a migrated DB + `serversvc`/`telemetrysvc.Query`) and seeds an opted-in server. Mirror it. Add:

```go
func TestPublicServers_PlatformArchTraffic(t *testing.T) {
	a, sid := <build PublicAPI + seed a show_on_public server with agent_os/agent_arch set — mirror existing public_test setup>
	// seed cumulative traffic via sub-project B's ingest
	ing := &telemetrysvc.Ingest{DB: a.Query.DB}
	_ = ing.WriteHostInventory // (ignore) — ensure host_traffic exists:
	_, _ = a.Query.DB.ExecContext(context.Background(),
		`INSERT INTO host_traffic (server_id, cum_bytes_up, cum_bytes_down, updated_at) VALUES ($1,$2,$3,$4)`,
		sid, int64(500), int64(900), nowUTC())

	rec := httptest.NewRecorder()
	a.Servers_ListPublic(rec, httptest.NewRequest("GET", "/api/public/servers", nil))
	body := rec.Body.String()
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, body)
	}
	for _, want := range []string{`"platform":"linux"`, `"arch":"amd64"`, `"traffic_rx_bytes":900`, `"traffic_tx_bytes":500`} {
		if !strings.Contains(body, want) {
			t.Errorf("body missing %q: %s", want, body)
		}
	}
}
```
> Implementer note: match the existing public_test's server-seed (it sets `show_on_public`, and uses `agent_os`/`agent_arch` columns — seed those `linux`/`amd64`). Use the same DB handle the harness exposes (`a.Query.DB` or equivalent). `host_traffic` exists because core migrations run in the test DB. Use whatever `now` helper the file already uses, else `time.Now().UTC()`. If `agent_os`/`agent_arch` aren't set by the existing seed, set them via an `UPDATE servers SET agent_os='linux', agent_arch='amd64' WHERE id=$1`.

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/api/ -run TestPublicServers_PlatformArchTraffic -v`
Expected: FAIL — fields absent.

- [ ] **Step 3: Add the fields + populate them.** In `internal/api/public.go`, add to the `publicCard` struct (after `Online bool`):
```go
	Platform       string `json:"platform,omitempty"`
	Arch           string `json:"arch,omitempty"`
	TrafficRxBytes int64  `json:"traffic_rx_bytes"`
	TrafficTxBytes int64  `json:"traffic_tx_bytes"`
```
In `Servers_ListPublic`, inside the loop after building `card` (and after the `card.Latest` block), add:
```go
		if s.AgentOS.Valid {
			card.Platform = s.AgentOS.String
		}
		if s.AgentArch.Valid {
			card.Arch = s.AgentArch.String
		}
		if tr, err := a.Query.HostTraffic(r.Context(), s.ID); err == nil && tr != nil {
			card.TrafficRxBytes = tr.CumBytesDown // down = rx = received
			card.TrafficTxBytes = tr.CumBytesUp   // up = tx = sent
		}
```
(`telemetrysvc.Query.HostTraffic` from sub-project B returns a zeroed default when absent, so traffic is `0` for servers with no row — no error path.)

- [ ] **Step 4: Run to verify pass + full api package + lint**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/api/ -run TestPublicServers_PlatformArchTraffic -v && go test ./internal/api/ && gofmt -l internal/api/public.go && go vet ./internal/api/ && golangci-lint run --timeout=5m`
Expected: PASS; gofmt empty; vet clean; `0 issues.`

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/api/public.go internal/api/public_test.go
git commit -m "feat(public): expose platform/arch + cumulative traffic on the public card"
```

---

## Task 2: Backend — `livenet.Hub.Subscribe` (no backfill)

**Files:**
- Modify: `internal/livenet/hub.go`
- Test: `internal/livenet/hub_test.go`

- [ ] **Step 1: Write the failing test.** Add to `internal/livenet/hub_test.go` (reuses the existing `fakeConn`):
```go
func TestHub_SubscribeNoBackfill(t *testing.T) {
	h := NewHub()
	for i := 0; i < 5; i++ {
		h.Publish(1, agentapi.LiveNetSample{RxBps: int64(i)})
	}
	c := &fakeConn{}
	detach := h.Subscribe(1, c)
	// no ring replay on subscribe
	if len(c.got) != 0 {
		t.Fatalf("Subscribe should not backfill, got %d", len(c.got))
	}
	// but receives subsequent live samples
	h.Publish(1, agentapi.LiveNetSample{RxBps: 99})
	if len(c.got) != 1 || c.got[0].RxBps != 99 {
		t.Fatalf("subscribed conn missed live sample: %+v", c.got)
	}
	detach()
	h.Publish(1, agentapi.LiveNetSample{RxBps: 100})
	if len(c.got) != 1 {
		t.Fatalf("detached conn still received: %+v", c.got)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/livenet/ -run TestHub_SubscribeNoBackfill -v`
Expected: FAIL — `Subscribe` undefined.

- [ ] **Step 3: Add `Subscribe`** to `internal/livenet/hub.go` (after `Attach`):
```go
// Subscribe registers c as a watcher WITHOUT replaying the ring — for
// multiplexed consumers (e.g. the public wall feed) that only want live
// samples, not each server's backfill. Returns a detach func.
func (h *Hub) Subscribe(serverID int64, c Conn) func() {
	h.mu.Lock()
	st := h.stateLocked(serverID)
	st.watchers[c] = struct{}{}
	h.mu.Unlock()
	return func() { h.remove(serverID, c) }
}
```
(`stateLocked` and `remove` already exist from sub-project C.)

- [ ] **Step 4: Run to verify pass (incl -race) + lint**

Run: `cd /Users/hg/project/Shepherd && go test -race ./internal/livenet/ -v && gofmt -l internal/livenet/hub.go && go vet ./internal/livenet/ && golangci-lint run --timeout=5m`
Expected: PASS (race-clean); gofmt empty; vet clean; `0 issues.`

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/livenet/hub.go internal/livenet/hub_test.go
git commit -m "feat(livenet): Hub.Subscribe — register a watcher without ring backfill"
```

---

## Task 3: Backend — public multiplexed live-net WebSocket

**Files:**
- Modify: `internal/api/public.go` (add `LiveNet` field + `taggingConn` + `LiveNetWS`)
- Modify: `internal/api/router.go` (route)
- Modify: `cmd/server/main.go` (wire the hub)
- Test: `internal/api/public_livenet_test.go` (create)

- [ ] **Step 1: Write the failing test** — create `internal/api/public_livenet_test.go`:
```go
package api

import (
	"testing"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// captureConn records the JSON values written to it.
type captureConn struct{ got []any }

func (c *captureConn) WriteJSON(v any) error { c.got = append(c.got, v); return nil }

func TestTaggingConn_WrapsWithServerID(t *testing.T) {
	inner := &captureConn{}
	tc := &taggingConn{serverID: 42, inner: inner}
	if err := tc.WriteJSON(agentapi.LiveNetSample{RxBps: 10, TxBps: 20}); err != nil {
		t.Fatal(err)
	}
	if len(inner.got) != 1 {
		t.Fatalf("expected one wrapped frame, got %d", len(inner.got))
	}
	f, ok := inner.got[0].(wallLiveFrame)
	if !ok {
		t.Fatalf("expected wallLiveFrame, got %T", inner.got[0])
	}
	if f.ServerID != 42 || f.RxBps != 10 || f.TxBps != 20 {
		t.Fatalf("bad frame: %+v", f)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/api/ -run TestTaggingConn_WrapsWithServerID -v`
Expected: FAIL — `taggingConn`/`wallLiveFrame` undefined.

- [ ] **Step 3: Add the field, frame, tagging conn, and handler** to `internal/api/public.go`.

Add `"github.com/hg-claw/Shepherd/internal/livenet"` and `"github.com/hg-claw/Shepherd/internal/agentapi"` imports if missing. Add to the `PublicAPI` struct:
```go
	// LiveNet is the in-memory live-throughput hub (sub-project C), shared
	// with telemetrysvc.Ingest. Optional; nil disables the public live feed.
	LiveNet *livenet.Hub
```
Add the frame + tagging conn + handler (the `liveNetUpgrader` and `wsLiveConn` types already exist in this package — reuse them):
```go
// wallLiveFrame is one live-net sample tagged with its server, streamed to the
// public wall's multiplexed WebSocket.
type wallLiveFrame struct {
	ServerID int64     `json:"server_id"`
	TS       time.Time `json:"ts"`
	RxBps    int64     `json:"rx_bps"`
	TxBps    int64     `json:"tx_bps"`
}

// taggingConn adapts a single browser conn into N per-server hub watchers,
// tagging each LiveNetSample with its server_id. The inner conn (wsLiveConn)
// serializes the concurrent writes from those watchers via its own mutex.
type taggingConn struct {
	serverID int64
	inner    livenet.Conn
}

func (t *taggingConn) WriteJSON(v any) error {
	s, ok := v.(agentapi.LiveNetSample)
	if !ok {
		return nil // hub only ever sends LiveNetSample
	}
	return t.inner.WriteJSON(wallLiveFrame{ServerID: t.serverID, TS: s.TS, RxBps: s.RxBps, TxBps: s.TxBps})
}

// LiveNetWS streams ~1s live network throughput for every opted-in server to an
// anonymous public browser. One socket, multiplexed: the browser conn is
// subscribed to each show_on_public server in the hub via a taggingConn.
// GET /api/public/net-live/ws
func (a *PublicAPI) LiveNetWS(w http.ResponseWriter, r *http.Request) {
	if a.LiveNet == nil {
		writeError(w, 503, "unavailable")
		return
	}
	all, err := a.Servers.List(r.Context())
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	conn, err := liveNetUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()
	shared := &wsLiveConn{conn: conn}
	var detaches []func()
	for _, s := range all {
		if !s.ShowOnPublic {
			continue
		}
		detaches = append(detaches, a.LiveNet.Subscribe(s.ID, &taggingConn{serverID: s.ID, inner: shared}))
	}
	defer func() {
		for _, d := range detaches {
			d()
		}
	}()
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}
```
> Implementer note: `wsLiveConn` has an unexported `conn *websocket.Conn` field (see `livenet_routes.go`); `&wsLiveConn{conn: conn}` is valid (same package). Confirm the field name. `Servers.List` + `ShowOnPublic` are already used by `Servers_ListPublic` in this file.

- [ ] **Step 4: Register the route** — in `internal/api/router.go`, after `mux.HandleFunc("GET /api/public/servers/{id}/netquality", ...)` (line ~71):
```go
	mux.HandleFunc("GET /api/public/net-live/ws", r.Public.LiveNetWS)
```
(The `/api/public/` prefix is already in the no-auth public allowlist at router.go:171.)

- [ ] **Step 5: Wire the hub** — in `cmd/server/main.go`, the `public := &api.PublicAPI{...}` literal (line ~193): add `LiveNet: liveNetHub,` (the `liveNetHub` var from sub-project C is in scope at that point — confirm; it's created near line 70 and already passed to `telemetrysvc.Ingest`).

- [ ] **Step 6: Run test + full api package + build + lint**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/api/ -run TestTaggingConn_WrapsWithServerID -v && go test ./internal/api/ && go build ./... && gofmt -l internal/api/public.go internal/api/router.go cmd/server/main.go && go vet ./internal/api/ ./cmd/server/ && golangci-lint run --timeout=5m`
Expected: PASS; build OK; gofmt empty; vet clean; `0 issues.`

- [ ] **Step 7: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/api/public.go internal/api/router.go internal/api/public_livenet_test.go cmd/server/main.go
git commit -m "feat(public): multiplexed public live-net WebSocket (1s, opted-in only)"
```

---

## Task 4: Frontend — PublicCard fields + useWallLiveNet hook

**Files:**
- Modify: `web/src/api/public.ts`

- [ ] **Step 1: Extend `PublicCard`** in `web/src/api/public.ts` — add to the type (after `online: boolean`):
```ts
  platform?: string
  arch?: string
  traffic_rx_bytes?: number
  traffic_tx_bytes?: number
```

- [ ] **Step 2: Add the live hook** — append to `web/src/api/public.ts`:
```ts
import { useEffect, useState } from 'react'

export type WallLiveMap = Map<number, { rx_bps: number; tx_bps: number }>

// useWallLiveNet opens ONE multiplexed public WebSocket and keeps the latest
// {rx_bps,tx_bps} per server_id. All other wall metrics stay on the 30s poll.
export function useWallLiveNet(): { live: WallLiveMap; connected: boolean } {
  const [live, setLive] = useState<WallLiveMap>(() => new Map())
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/api/public/net-live/ws`)
    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onmessage = (ev) => {
      let f: { server_id: number; rx_bps: number; tx_bps: number }
      try {
        f = JSON.parse(ev.data as string)
      } catch {
        return
      }
      setLive((prev) => {
        const m = new Map(prev)
        m.set(f.server_id, { rx_bps: f.rx_bps, tx_bps: f.tx_bps })
        return m
      })
    }
    return () => {
      ws.onmessage = null
      ws.close()
    }
  }, [])
  return { live, connected }
}
```
> Implementer note: confirm `react` isn't already imported in public.ts (it's an api file; if `useEffect`/`useState` collide with an existing import, merge into it). If the file lints against importing React hooks into `api/`, instead create `web/src/api/wallLive.ts` for the hook + map type and keep only the `PublicCard` field additions in public.ts. Match the repo's convention (check where `useLiveNet` from sub-project C lives — mirror that location choice).

- [ ] **Step 3: tsc**

Run: `cd /Users/hg/project/Shepherd/web && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/hg/project/Shepherd
git add web/src/api/public.ts web/src/api/wallLive.ts 2>/dev/null; git add web/src/api/
git commit -m "feat(web): PublicCard platform/arch/traffic fields + useWallLiveNet hook"
```

---

## Task 5: Frontend — Wall redesign (List/Grid + summary + live)

**Files:**
- Create: `web/src/components/MetricBar.tsx`
- Create: `web/src/components/SummaryStat.tsx`
- Modify: `web/src/pages/public/Wall.tsx`
- Test: `web/src/pages/public/Wall.test.tsx` (create)

**Read first:** the design reference `…/design_extract/shepherd-design-system/project/ui_kits/shepherd-web/Wall.jsx` (visual target), the current `web/src/pages/public/Wall.tsx`, `web/src/pages/admin/ServerList.tsx` (the List/Grid segmented toggle to mirror), `web/src/components/{OnlineDot,CountryFlag,MetricCard}.tsx`, and `web/src/lib/bytes.ts` (`bps`/`bytes`).

- [ ] **Step 1: Create `web/src/components/MetricBar.tsx`** — a thin labeled progress bar with 80/92 threshold colors (used in list rows + grid cards):
```tsx
import { cn } from '@/lib/utils'

// MetricBar: a thin labeled usage bar. Threshold colors match the product's
// 80% warn / 92% alert bands.
export function MetricBar({ label, value }: { label: string; value: number }) {
  const tone = value >= 92 ? 'err' : value >= 80 ? 'warn' : 'ok'
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-fg-dim text-[10px] w-[30px] shrink-0">{label}</span>
      <div className="flex-1 h-1.5 rounded-[3px] bg-sunken overflow-hidden">
        <div
          className={cn(
            'h-full rounded-[3px]',
            tone === 'err' ? 'bg-err' : tone === 'warn' ? 'bg-warn' : 'bg-primary',
          )}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </div>
      <span
        className={cn(
          'font-mono tabular-nums text-[11px] w-[34px] text-right',
          tone === 'warn' && 'text-warn',
          tone === 'err' && 'text-err',
        )}
      >
        {value.toFixed(0)}%
      </span>
    </div>
  )
}
```
> Implementer note: confirm `bg-sunken`/`bg-primary`/`bg-ok`/`bg-warn`/`bg-err` utility classes exist (they're used across the app — check `MetricCard.tsx`). If a class differs (e.g. `bg-bg-sunken`), use the repo's actual token class.

- [ ] **Step 2: Create `web/src/components/SummaryStat.tsx`** — an icon + label + value summary card:
```tsx
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export function SummaryStat({
  label,
  value,
  sub,
  tone,
  icon: Icon,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'ok' | 'err'
  icon: LucideIcon
}) {
  return (
    <div className="bg-elev border rounded-lg p-3.5 flex items-center gap-3">
      <span className="grid place-items-center h-[34px] w-[34px] rounded-lg bg-sunken text-muted-foreground shrink-0">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <div className="text-fg-dim text-[10.5px] uppercase tracking-[0.05em]">{label}</div>
        <div
          className={cn(
            'font-mono tabular-nums truncate text-[16px] leading-tight',
            tone === 'ok' && 'text-ok',
            tone === 'err' && 'text-err',
          )}
        >
          {value}
        </div>
        {sub && <div className="font-mono text-fg-dim truncate text-[11px] mt-0.5">{sub}</div>}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Rewrite `web/src/pages/public/Wall.tsx`.** Replace the current body with the probe layout. Structure (match `Wall.jsx` for visuals; use repo components + `bps()`/`bytes()`):
  - Hooks: `const servers = usePublicServers()`, `const { live } = useWallLiveNet()`, `const [view, setView] = useState<'list'|'grid'>(...localStorage 'shep_wall_view' default 'list')` with a `setViewPersist`.
  - Effective net per server: `const netRx = (s) => live.get(s.id)?.rx_bps ?? s.latest?.net_rx_bps ?? 0` and `netTx` likewise (live wins, else polled).
  - **Header:** `<h1>` "Server status" (font-mono text-[18px] tracking-tight) + redaction subtitle + a List/Grid segmented toggle on the right (mirror `ServerList.tsx`'s toggle component; options `{value:'list',icon:Rows3,label:'List'}` / `{value:'grid',icon:LayoutGrid,label:'Grid'}`).
  - **Summary strip:** a `grid gap-3` (`grid-cols-[repeat(auto-fit,minmax(150px,1fr))]`) of 5 `SummaryStat`: Nodes (`Server`), Online (`CircleCheck`, tone ok), Offline (`CircleX`, tone err if >0), Realtime (`Activity`, value `↓ ${bps(Σ netRx)}`, sub `↑ ${bps(Σ netTx)}`), Traffic (`ArrowDownUp`, value `↓ ${bytes(Σ traffic_rx_bytes)}`, sub `↑ ${bytes(Σ traffic_tx_bytes)}`).
  - **Groups:** group by `s.group||''`, sort; each `<section>` with a dashed-bottom header (`border-b border-dashed`) showing the group name + `${online}/${count} online`.
  - **List view (default):** a `Card`-wrapped horizontally-scrollable `<table>` with columns: Node (`OnlineDot` + `CountryFlag` + alias mono), Platform (`platform · arch`, `—` if offline/absent), CPU/Memory/Disk (each `<MetricBar>` using `s.latest.cpu_pct`/`mem_pct`/`disks_pct[0]`), Network ↓↑ (`bps(netRx)` / `bps(netTx)`), Traffic ↓↑ (`bytes(traffic_rx_bytes)` / `bytes(traffic_tx_bytes)`), Load (`s.latest.load_1.toFixed(2)`); offline cells render `—`; row `onClick`→`navigate('/public/servers/'+id)`. Sort rows online-first then alias.
  - **Grid view:** keep using `MetricCard` (it already renders the tile with status border + CPU headline), OR a richer card matching `Wall.jsx`'s `ServerCard` (online dot + flag + alias + platform·arch, CPU/MEM/DISK `MetricBar`s, live net + load line, cumulative traffic ↓↑ line). Mirror `Wall.jsx`'s `ServerCard` for the richer card; reuse `MetricBar`.
  - Empty state: `t('wall.no_servers')` when zero servers; loading/error as today.
> Implementer note: this is the large piece — match `Wall.jsx` (the design reference) for spacing/typography, but use the repo's Tailwind tokens + components (`OnlineDot`, `CountryFlag`, `Card` styling `bg-elev border rounded-lg`, `bps`/`bytes`) — NOT the bundle's raw inline styles/`fmtMbps`/`fmtGB`. Keep i18n keys where the current Wall used them (`wall.title`, `wall.subtitle`, etc.); add new keys (`view.list`/`view.grid`, summary labels) with English fallbacks like the current code does (`t('key','English')`). The segmented toggle: reuse the same component `ServerList.tsx` imports — read that import and use it; if it's a local component, lift the minimal version inline.

- [ ] **Step 4: Add a vitest** — create `web/src/pages/public/Wall.test.tsx`. Mock `@/api/public` so `usePublicServers` returns two servers (one online with latest+platform+traffic, one offline) in two groups, and `useWallLiveNet` returns a `live` map overriding one server's rx. Render `<Wall/>` (wrap with the providers the other page tests use — check an existing test e.g. `ServerDetail.test.tsx` for the harness/i18n/router mocks). Assert:
  - "Server status" heading + the summary strip renders (e.g. "Nodes" + value "2", "Online" "1").
  - List view (default) shows the online server's alias, its platform, and the **live** net value (the overridden rx via `bps`), not the polled one.
  - Switching to Grid (click the Grid toggle) renders the grid container.
  - Group headers show `X/Y online`.
> Implementer note: mirror the mocking style of the existing `web/src/pages/admin/ServerDetail.test.tsx` (it `vi.mock`s `@/api/*` modules + stubs charts). Mock `useWallLiveNet` to return a fixed map; don't open a real WebSocket.

- [ ] **Step 5: Run vitest + tsc**

Run: `cd /Users/hg/project/Shepherd/web && npx vitest run src/pages/public/Wall.test.tsx && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/hg/project/Shepherd
git add web/src/components/MetricBar.tsx web/src/components/SummaryStat.tsx web/src/pages/public/Wall.tsx web/src/pages/public/Wall.test.tsx
git commit -m "feat(web): Dstatus-style public Wall (List/Grid, summary strip, 1s live net)"
```

---

## Task 6: Full verification

- [ ] **Step 1: Full Go suite (with -race) + vet + build + lint**

Run: `cd /Users/hg/project/Shepherd && go build ./... && go test -race ./internal/livenet/... ./internal/api/... && go test ./... && go vet ./... && golangci-lint run --timeout=5m`
Expected: build OK; race-clean; all packages PASS; vet clean; `0 issues.`

- [ ] **Step 2: gofmt on changed Go files**

Run: `cd /Users/hg/project/Shepherd && gofmt -l internal/api/public.go internal/api/router.go internal/livenet/hub.go cmd/server/main.go`
Expected: prints nothing.

- [ ] **Step 3: Frontend tsc + full vitest**

Run: `cd /Users/hg/project/Shepherd/web && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all suites PASS.

- [ ] **Step 4: Restore embed artifact if touched + clean tree**

Run: `cd /Users/hg/project/Shepherd && git checkout -- internal/web/dist/.gitkeep 2>/dev/null; git status --short`
Expected: clean.

---

## Self-Review Notes

- **Spec coverage:** publicCard platform/arch + cumulative traffic (Task 1) ✓; `Hub.Subscribe` no-backfill (Task 2) ✓; public multiplexed live WS — opted-in only, taggingConn server_id wrap, shared wsLiveConn, route, wiring (Task 3) ✓; PublicCard FE fields + `useWallLiveNet` single multiplexed WS (Task 4) ✓; Wall List(default)/Grid toggle + summary strip + groups + MetricBar/SummaryStat + live-overrides-polled net (Task 5) ✓; lint+race verification (Task 6) ✓. Omitted-by-design (uptime, monthly plan) absent. Redaction preserved (ShowOnPublic gate on both list + live).
- **Type consistency:** `publicCard.{Platform,Arch,TrafficRxBytes,TrafficTxBytes}` (json platform/arch/traffic_rx_bytes/traffic_tx_bytes) ↔ TS `PublicCard.{platform,arch,traffic_rx_bytes,traffic_tx_bytes}`. `wallLiveFrame{server_id,ts,rx_bps,tx_bps}` ↔ FE `useWallLiveNet` parses `{server_id,rx_bps,tx_bps}`. `Hub.Subscribe(int64, Conn) func()` used by `taggingConn`. down=rx=CumBytesDown, up=tx=CumBytesUp (matches B). Net: live `rx_bps`/`tx_bps` override polled `latest.net_rx_bps`/`net_tx_bps`.
- **Reuse:** `wsLiveConn`+`liveNetUpgrader` (api pkg, from C), `OnlineDot`/`CountryFlag`/`bps`/`bytes`/`MetricCard`, ServerList toggle. No new infra, no migration.
- **Lint gate:** every Go task + Task 6 run `golangci-lint run` (staticcheck) — the lesson from the v0.15.0 lint miss.
