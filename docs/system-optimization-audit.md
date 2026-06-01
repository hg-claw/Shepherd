# System Optimization Audit

## Executive Summary

This audit consolidates **31 adversarially-verified findings** into 27 distinct items after deduplication, spanning backend performance (DB N+1 patterns dominate), concurrency safety, security, frontend rendering, and build/infra hygiene. The biggest recurring theme is **serial DB round-trips on hot or public paths** (public wall, admin list, subscription render, telemetry ingest), followed by **maintainability debt** (duplicated helpers/components, god files, dead code) and a small but sharp **concurrency/security** cluster. The top 3 highest-leverage items are: (1) fix the **WSConn.Send panic-on-closed-channel** race — high impact, small effort, can crash the process; (2) add **login rate-limiting/lockout** — the only gate to a root-capable admin surface is currently unthrottled; (3) **batch the public-wall N+1 queries** — the highest-fanout unauthenticated endpoint runs ~2N-3N serial queries per page load. Note that several findings' headline fixes were flagged by the verifier as incomplete or risky and are caveated below.

---

## Quick wins (small effort, medium+ impact)

**Add rate limiting / lockout to `POST /api/login`**
`internal/api/router.go:77`, `internal/api/admin_auth.go:18`, `cmd/server/main.go:237`
The single gate to the entire root-capable admin surface (SSH installs, root PTY, arbitrary file R/W) has no rate limiter, lockout, or CAPTCHA, while lower-value public/subgen endpoints already do. An attacker with panel reachability can run unthrottled online password guessing against the bcrypt hash.
**Fix:** Add a per-IP and/or per-username limiter with lockout-after-N-failures in front of `AuthAPI.Login`, wired in `main.go` like the other `InitRateLimit` calls. **Verifier caveat:** do *not* naively reuse the existing `tokenRateLimiter` keyed by raw client IP — its per-key map never prunes (see the unbounded-map finding below), so IP-keyed reuse reintroduces a memory-DoS; bound/evict the key map or key by username, and read `X-Forwarded-For` only behind a trusted proxy.
**Impact / Effort:** High / Small

**WriteSample does 2-3 un-transacted writes per telemetry frame on the hottest ingest path**
`internal/telemetrysvc/ingest.go:115,117,127,144`
Every frame from every agent does an INSERT into `telemetry_samples_30s`, a conditional `host_traffic` upsert, and a standalone `UPDATE servers SET agent_last_seen` — three separate `ExecContext` calls, each its own implicit transaction (fsync) on the single-connection SQLite DB, tripling commit/fsync count and serializing all other DB work behind them.
**Fix:** Wrap the three statements in one `BeginTxx`/`Commit` (mirroring `WriteTrafficBatch`), giving one fsync per frame and atomic sample+liveness+traffic update.
**Impact / Effort:** Medium / Small

**Static-asset gzip recomputed from scratch on every request**
`internal/web/embed.go:40,66,83`
`gzipMiddleware` recompresses the ~700kB main chunk + ~300kB vendor chunks live for every asset hit even though `/assets/` files are content-hashed and served `immutable`; the `sync.Pool` only recycles `gzip.Writer` allocations, not the output, and `Content-Length` is stripped (forcing chunked transfer).
**Fix:** Precompute gzip (optionally brotli) for the immutable embedded assets once at startup into an in-memory map keyed by path, serve precompressed bytes with correct `Content-Length`/`Vary`, and keep the live wrapper only for the SPA HTML. **Verifier caveat:** real-world CPU savings are bounded for a low-traffic self-hosted admin SPA — impact leans toward the low end of medium.
**Impact / Effort:** Medium / Small

**Preview leaks the file-download goroutine and streams the whole file after a 64KB read**
`internal/api/files_routes.go:103`, `internal/filesvc/service.go:241`
`Preview()` spawns `go a.Files.Download(...)` into a synchronous `io.Pipe`, reads only `maxB` bytes, then returns without closing `pr`. The download goroutine blocks on the next `pw.Write` and the agent keeps streaming the entire file until request-context cancellation — wasting full-file agent→server bandwidth. **Verifier note:** worse than stated — the blocked write stalls the *entire* agent connection's read loop (head-of-line blocking across all that agent's sessions).
**Fix:** Wrap `r.Context()` in `context.WithCancel` and `defer cancel()` so `Download`'s `ctx.Done` arm sends `FileCancel` and stops the agent transfer. `pr.CloseWithError(nil)` alone unblocks the read loop but does *not* send `FileCancel`, so the context-cancel path is the complete fix.
**Impact / Effort:** Medium / Small

**BatchUpdateAgent semaphore does not bound the actual install work**
`internal/api/admin_servers.go:690,716`
The `maxConcurrent=20` semaphore only gates the lightweight setup (Get + IssueEnrollmentToken); the heavy `HostExec.RunCmd` (a 60s-timeout WS round-trip) runs in a nested fire-and-forget `go func()` outside the semaphore, so a batch of N servers fans out N concurrent WS sessions, not 20.
**Fix:** Run `RunCmd` inside the semaphored goroutine, or use a dedicated bounded worker pool for the dispatches. **Verifier caveat:** current code intentionally uses `context.Background()` for fire-and-forget and `res.OK` means "dispatched"; a naive synchronous change re-ties installs to client-disconnect cancellation and changes OK semantics — the worker-pool variant is safer.
**Impact / Effort:** Medium / Small

**Row click in ServerList forces a full page reload**
`web/src/pages/admin/ServerList.tsx:414`
Table rows navigate via `window.location.assign('/admin/servers/${s.id}')`, tearing down and re-downloading the entire SPA + lazy ServerDetail chunk with an empty query cache — while the same row's inner `<Link>`/checkbox already use React Router. The public Wall (`Wall.tsx:196`) already uses `navigate()` for the identical pattern.
**Fix:** Add `useNavigate` and switch the row handler to `navigate('/admin/servers/${s.id}')`; inner cells keep `stopPropagation`.
**Impact / Effort:** Medium / Small

---

## High-impact (worth the effort)

**Public wall list does ~2N-3N serial DB queries per page load (N+1)** — also affects the admin server list
`internal/api/public.go:114,149,158,167`; `internal/api/admin_servers.go:54,56`
`Servers_ListPublic` loads all servers then, for each `show_on_public` server, serially issues `Query.Latest`, `Query.HostTraffic`, and `NetqualitySummary` (~2 queries floor, up to ~4 with netquality on) — on the highest-fanout *unauthenticated* endpoint, fresh per page load with no caching. The admin `List?with=latest` has the same per-row `Query.Latest` loop and is polled as fast as every 1.5s.
**Fix:** Add batch helpers in `telemetrysvc` — `LatestForAll(ctx, ids)` (`SELECT DISTINCT ON (server_id) ... ORDER BY server_id, ts DESC`), `HostTrafficForAll(ctx, ids)` (`WHERE server_id = ANY($1)`), and a set-based netquality `LatestPerISP` — returning maps keyed by `server_id`; index into them per row. Collapses ~2N-3N queries into ~3 constant queries and the shared `LatestForAll` covers both endpoints. Optionally memoize the anonymous wall card list for a 1-2s TTL. **Verifier caveat:** `HostTraffic` synthesizes a default row when absent and `Latest`/`LatestPerISP` return empty for missing data, so the batch rewrite must index with a missing→default fallback rather than assume every id is present.
**Impact / Effort:** High (public) / Medium (admin) — Medium effort

**Wall live WebSocket re-renders the entire server wall on every push**
`web/src/api/wallLive.ts:22-26`, `web/src/pages/public/Wall.tsx:21-150`
`useWallLiveNet` does `setLive(prev => new Map(prev).set(...))` per WS frame, so N online servers → ~N state updates/sec, each a fresh Map identity. `Wall` reads `live` at page scope; `rxOf`/`txOf` are recreated each render and `ServerListTable`/`WallServerCard` rows aren't memoized, so the whole tree reconciles ~1Hz even though cpu/mem/disk only change every 30s.
**Fix:** Move the live rx/tx read into a memoized leaf that subscribes per-id (a Zustand store keyed by `server_id` with per-id selectors is cleanest), or coalesce WS frames into one `setLive` per animation frame; wrap rows in `React.memo` and stabilize `rxOf`/`txOf` with `useCallback`.
**Impact / Effort:** Medium / Medium

**Subscription render is N+1: one DB round-trip per selected inbound on the public `/sub` endpoint**
`internal/plugins/subgen/collect.go:12,61,129`, `internal/plugins/subgen/service.go:44`
`Service.Generate` (the public, token-auth `/sub/{token}` handler that clients poll) calls `CollectNodes`, which loops over each selection issuing a separate `GetContext` (`collectXray`, or `collectSingbox` — a 4-table JOIN) per inbound. K selections → K serial round-trips, fully serialized on the single-connection SQLite pool.
**Fix:** Split selections into xray/singbox id sets, run two `WHERE i.id IN (...)` (`sqlx.In`) queries with the existing JOINs, map rows back by id, and diff requested-vs-returned to preserve the existing "not found / no ssh_host, skipped" warnings. Reduces K+1 to 2 queries. **Verifier note:** selection counts are admin-bounded (handful to a few dozen) and all are indexed PK fetches, so this is an optimization, not a hard scaling failure.
**Impact / Effort:** Medium / Medium

**livenet fan-out re-marshals identical sample JSON once per watcher per second**
`internal/livenet/hub.go:69-74`, `internal/api/livenet_routes.go:31-36`, `internal/api/public.go:311-317,355-362`
`Hub.Publish` calls gorilla's `conn.WriteJSON(s)` per watcher, which `json.Marshal`s on every call; on the public wall one browser is subscribed to every public server (up to 256 conns), so each 1s tick re-encodes byte-identical payloads O(servers × watchers) times.
**Fix:** Marshal the per-server payload once per `Publish` and write pre-encoded bytes via `conn.WriteMessage(TextMessage, buf)` or gorilla `PreparedMessage`; build the per-server `wallLiveFrame` bytes once and hand the cached buffer to each conn. **Verifier note:** payloads are tiny 4-field structs at 1Hz, so this only bites at high fan-out (many public servers × ~256 browsers).
**Impact / Effort:** Medium / Medium

---

## Concurrency & correctness risks

**WSConn.Send can panic with "send on closed channel" under concurrent Close**
`internal/agentsvc/wsconn.go:52,71`, `internal/api/agent_routes.go:120`
`Send()` does a non-blocking `done`-precheck then a `select` containing both `case c.sendCh <- f` and `case <-c.done`; `Close()` does `close(c.done); close(c.sendCh)`. A send on a closed channel always panics, and `select` gives no guarantee it picks the ready `done` arm — so the TOCTOU window panics (not a data race, so `-race` won't catch it). Concurrent Send+Close is the *normal* reconnect/eviction path, and pusher goroutines (pty/file/telemetry) aren't the http handler, so an unrecovered panic can crash the process.
**Fix:** Stop calling `close(c.sendCh)` entirely; use only `done` as the shutdown signal — rewrite `writeLoop` to `select` on `<-c.done` to exit, and let `Send`'s existing `case <-c.done` arm abort. Never close a channel a producer may send on.
**Impact / Effort:** High / Small

**Unbounded map growth in tokenRateLimiter on public unauthenticated endpoints**
`internal/api/agent_status_ratelimit.go:31`, `internal/api/subgen.go:30`, `internal/api/public.go:381`
`tokenRateLimiter.allow(key)` keys `l.hits` by the raw client-supplied token and never deletes a key, on two PUBLIC endpoints (`/sub/{token}`, `?token=` agent status) where `allow()` runs *before* token validation. An attacker issuing requests with distinct random tokens grows the map without bound (slow memory-exhaustion DoS).
**Fix:** **Verifier flagged the finding's headline fix as ineffective:** deleting on `len(kept)==0` never fires for the single-use-token attack (the attacker never re-calls `allow()` for that key, and the empty-slice branch is never reached). Only the "optional" remedies actually bound the map — add a periodic sweep removing keys whose newest hit is older than the window, and/or a global cap on `len(l.hits)`.
**Impact / Effort:** Medium / Small

---

## Security

**Login leaks a valid-username signal via timing (bcrypt only runs when the username exists)**
`internal/api/admin_auth.go:24`
`if err != nil || !auth.VerifyPassword(...)` short-circuits, so an unknown username returns in microseconds (DB lookup only) while a valid one always pays the full cost-12 bcrypt (tens of ms) — a measurable username-enumeration oracle that compounds the missing login rate limit.
**Fix:** Always run a bcrypt comparison against a fixed dummy hash on the not-found branch so response time is constant; the generic "invalid credentials" error is already returned in both branches.
**Impact / Effort:** Low / Small

*(See also "Add rate limiting / lockout to POST /api/login" under Quick wins, and "Unbounded map growth in tokenRateLimiter" under Concurrency & correctness.)*

---

## Frontend

**Pause toggle in plugin LogsTab tears down the WebSocket and wipes the log buffer**
`web/src/pages/admin/plugins/xray/LogsTab.tsx:19`, `web/src/pages/admin/plugins/singbox/LogsTab.tsx:19`
The streaming effect lists `paused` in its dep array and calls `setLines([])` on every run, so clicking Pause closes/reopens the live-log WS and clears all accumulated lines — the opposite of pause — and reconnects the agent-side stream. (A separate Clear button already exists.)
**Fix:** Remove `paused` from the deps (keep `[serverID]`), read `paused` via a `useRef` inside `onmessage`, and clear only on `serverID` change or explicit Clear. **Note:** fix this in both byte-identical files (see the LogsTab-duplication item under Larger refactors).
**Impact / Effort:** Medium / Small

**Two parallel toast systems bridged by an effect that collapses rapid toasts**
`web/src/store/ui.ts:30`, `web/src/hooks/use-toast.ts:8`, `web/src/components/ToastBridge.tsx:9`
Toasts go into the zustand `useUI.toasts` array (35 call sites), then `ToastBridge` re-emits each into the shadcn `use-toast` reducer (which has `TOAST_LIMIT = 1`) and dismisses it — so two toasts in one tick drop all but the last. Two queues, two id schemes, pure overhead plus a latent dropped-toast bug.
**Fix:** Pick one system — render `useUI.toasts` directly in a Toaster and drop `use-toast`/`ToastBridge`, or have pages call shadcn `toast()` directly and drop the zustand slice; raise/remove `TOAST_LIMIT` if concurrent toasts are expected. **Verifier note:** the loop does *not* infinite-re-trigger (dismiss is an immutable set over a captured snapshot), but the dropped-toast hazard is real.
**Impact / Effort:** Medium / Medium

**Per-mutation error toasting is copy-pasted ~26 times instead of centralized**
`web/src/pages/admin/plugins/subgen/SubscriptionsTab.tsx:59`, `web/src/pages/admin/ServerList.tsx:209`, `web/src/api/client.ts` (APIError)
`onError: (e: any) => toast('error', String(e?.message ?? e))` recurs across ~26 sites with inconsistent extraction (some translate the fallback, some don't) and unnecessary `: any` casts despite a typed `APIError`; a forgotten handler silently swallows errors.
**Fix:** Add a shared `errMsg(e: unknown): string` helper plus either a `useToastedMutation` wrapper or a QueryClient `MutationCache.onError` default that toasts unless opted out. **Verifier note:** the cited `servers.ts` `useInstall` actually has *no* `onError` — it illustrates the silent-swallow risk rather than being a copy-paste site.
**Impact / Effort:** Medium / Medium

**TimeSeriesChart recomputes scales and rebuilds path strings every render**
`web/src/components/TimeSeriesChart.tsx:42-49,68-84,125-141`
`min/max/tMin/tMax` use unmemoized `flatMap` + `Math.min/max(...spread)` per render, and the SVG `d` path strings are rebuilt inline in the render body, so a hoverX change (every mousemove) or the ~1/s live-net update regenerates geometry across all 4 charts; `closestPoints` does an O(series·points) scan per pointer event.
**Fix:** Memoize `min/max/tMin/tMax`/scales and per-series `d` strings on `[series, width]`, rAF-throttle `hoverX`, and bisect the time-sorted points array instead of linear-scanning. **Verifier note:** `closestPoints`/ticks are *already* memoized; series are small telemetry sparklines, so this is reasonable to defer.
**Impact / Effort:** Low / Medium

**ServerList re-reconciles every row on the 1.5s install poll with no memoization**
`web/src/pages/admin/ServerList.tsx:141-186,36-42,405-473`
During an install the list polls every 1.5s; `servers` is filtered inline (unmemoized), `hostStage(s)` is called twice per row, and rows/handlers aren't memoized, so every row reconciles each poll even though only the installing host changed.
**Fix:** `useMemo` a per-row view-model and the filtered/sorted `servers`, wrap `HostCard`/table rows in `React.memo`, and stabilize `toggleSelect`/`handleDelete` with `useCallback`. **Verifier correction:** the "parse-heavy" justification is false — `hostStage` never calls `topPct`/`JSON.parse`; the only un-memoized parse is in the filter and only when `statusFilter !== 'all'`. Remaining cost is plain transient reconciliation, so impact is low.
**Impact / Effort:** Low / Medium

---

## Build/infra

**Go binaries built without `-trimpath` and `-s -w`, leaving symbol/DWARF bloat in server and embedded agents**
`Dockerfile:29-38`, `Makefile:18-38`, `release.yml:46-58`
Every `go build` (server CGO=1, both agent arches, release matrix) passes only `-ldflags "-X ...BuildVersion=..."`, leaving DWARF + symbol tables (~20-30% size) — doubled because agent binaries are embedded into the server image via `internal/installer/bin`.
**Fix:** Change ldflags to `-ldflags "-s -w -X ..."` and add `-trimpath` across Dockerfile, Makefile, and release.yml. Safe for the CGO server build; no runtime/panic-trace impact.
**Impact / Effort:** Medium / Small

**Dockerfile go-builder lacks BuildKit cache mounts for the Go module/build cache**
`Dockerfile:22-38`
`go mod download` + three sequential `go build` steps use plain `RUN`, so a cold layer cache (or CI gha-cache miss) re-downloads all modules and recompiles the full dependency graph including `sagernet/sing-box` and gvisor — despite the `# syntax=docker/dockerfile:1.7` header enabling cache mounts.
**Fix:** Add `--mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build` to the `go mod download` and `go build` RUN steps. Content-addressed caches, so no stale-artifact risk.
**Impact / Effort:** Medium / Small

**`data/` (115MB) and `tmp/` missing from `.dockerignore` inflate build context and an intermediate layer**
`.dockerignore:1-16`, `Dockerfile:23`, `data/`
`data/` is 115MB (dev.db + WAL + 80MB plugin binaries) and is gitignored but not dockerignored; the go-builder's `COPY . .` uploads it all to the daemon and bakes it into the intermediate layer (`shepherd.db*` only matches the repo root, not `data/dev.db`).
**Fix:** Add `data/`, `tmp/`, `*.db-shm`, `*.db-wal` to `.dockerignore`. **Verifier note:** this is a developer-machine cost (clean CI checkouts have no populated `data/`), so impact is medium, not high.
**Impact / Effort:** Medium / Small

**Vitest run-cache artifact committed to git under root `node_modules/`**
`node_modules/.vite/vitest/.../results.json`
A stray vitest `results.json` (recording a stale failed InboundsTab test) is tracked at the repo root, where there's no `package.json` and no real dependency tree — pure accidental commit noise.
**Fix:** `git rm --cached` the file and add `/node_modules/` to the root `.gitignore` (currently only `/web/node_modules/` is ignored).
**Impact / Effort:** Low / Small

---

## Larger refactors

**Dead code: orphaned xray topology methods, config.go renderers, AuditAPI.CSV, subgen TemplateByName**
`internal/plugins/xray/topology.go:31`, `internal/plugins/xray/routes.go:136`, `internal/plugins/xray/config.go:42,55`, `internal/api/audit_routes.go:58`, `internal/plugins/subgen/store.go:114`
`deadcode` flags 19 unreachable funcs: the `/topology` route is now 410 Gone leaving `TopologyStore.{now,Get,Upsert*,List*}` + `topologyHandler` orphaned; `config.go`'s `RenderTemplate`/`renderVLESSReality`/`renderVMessWS`/`renderShadowsocks` are referenced only by tests (`render.go` is live); `AuditAPI.CSV` is never routed (frontend builds CSV client-side); `subgen Store.TemplateByName` is unreachable.
**Fix:** Delete `AuditAPI.CSV`, `subgen Store.TemplateByName`, the dead xray topology *methods* + `topologyHandler`, and the test-only `config.go` renderers (plus their test). **Verifier caveat (build-breaking if ignored):** do **not** delete `topology.go` wholesale — `TopologyStore.Delete` and the `Topology`/`TopologyView` structs are LIVE (called from `Plugin.UndeployFromHost`, `xray.go:131`); keep them and remove only the dead methods.
**Impact / Effort:** Low / Medium

**`writeJSON`/`writeErr` response helper duplicated across 5 packages with subtly diverging shapes**
`internal/api/jsonio.go:8`, `internal/plugins/netquality/routes.go:501`, `internal/plugins/subgen/httputil.go:10`, `internal/plugins/singbox/inbounds_routes.go:67`, `internal/plugins/xray/inbounds_routes.go:40`
Five near-identical JSON response writers diverge subtly (error as `map[string]string` vs `map[string]any`, error vs string param, nil-body guard only in the api copy), so any envelope change must be made 5×; subgen's own comment admits it "mirrors" netquality's.
**Fix:** Create one `internal/httpjson` package exposing `WriteJSON`/`WriteError`/`WriteErr` and have all plugins import it; standardize one error-envelope shape. **Verifier note:** `map[string]string` vs `map[string]any` produce identical `{"error":"..."}` wire output, so no response-shape regression.
**Impact / Effort:** Medium / Medium

**`admin_servers.go` (777L) mixes 4 concerns; install/agent-update fire-and-forget pattern duplicated**
`internal/api/admin_servers.go:614,672,371,468`
One 777-line `ServersAPI` bundles CRUD, telemetry/traffic, SSH install/reinstall, and agent self-update. `UpdateAgent` and `BatchUpdateAgent` repeat a verbatim `Get → IsOnline → IssueEnrollmentToken → buildInstallCommand → go func(){ RunCmd(context.Background(), ...) }()` sequence, and `Reinstall` rebuilds `installer.SSHCredentials` inline.
**Fix:** Split into `admin_servers_crud.go` / `_install.go` / `_update.go`, and extract `dispatchAgentUpdate(...)` shared by both update paths. **Verifier caveat:** "reuse `installerCreds` in Reinstall" is not a drop-in — `installerCreds` derives from the request only, while `Reinstall` falls back to the stored server row; reusing it requires generalizing the helper signature.
**Impact / Effort:** Medium / Medium

**`singbox`/`xray` LogsTab are byte-identical duplicates differing only by a plugin string**
`web/src/pages/admin/plugins/xray/LogsTab.tsx:1`, `web/src/pages/admin/plugins/singbox/LogsTab.tsx:1`
A `diff` of the two files yields exactly 2 changed lines (`'xray'` vs `'singbox'` literals); any fix — including the pause bug above — must be applied twice and will drift.
**Fix:** Extract a shared `<PluginLogsTab plugin="xray"|"singbox" />`. **Verifier correction:** the claim that the *same* byte-identical duplication spans InboundsTab/DeployTab/BulkRelayDialog/Traffic is overstated — those carry plugin-specific logic and typed APIs and can't be folded by a trivial `plugin=` prop, so scope this to LogsTab; impact is low.
**Impact / Effort:** Low / Medium

**ServerList is a 721-line god component duplicating the delete dialog**
`web/src/pages/admin/ServerList.tsx:409,586,670`
One 721-line file holds the page, KPI logic, grid+table renderers, and four sub-components; the delete-confirm `<Dialog>` is hand-duplicated in `DeleteButton` and `HostCard`, and `t`/`refetchInterval` props leak `any`.
**Fix:** Split renderers + sub-components into `./ServerList/` modules, extract one `ConfirmDeleteDialog`, and type the `t` props as `TFunction` and the refetch callback with React Query's `Query` type. **Verifier correction:** `hostStage` is computed twice (not three times) and does *no* `JSON.parse`, so the perf angle is false — this is a pure maintainability cleanup; impact low.
**Impact / Effort:** Low / Large

**singbox `render.go` (586L): `renderTransport` and `renderUpstreamTransport` are duplicated ws/http/httpupgrade builders**
`internal/plugins/singbox/render.go:382,511`
The two functions have byte-identical ws/http/httpupgrade case bodies, differing only in field source and inbound-only extras (`method=PUT`, a `quic` case); they've already drifted (the upstream variant lacks `method=PUT`).
**Fix:** Extract one `buildTransport(ttype, path, host string, isInbound bool) map[string]any` called from both.
**Impact / Effort:** Low / Small

**CN gh-proxy mirror prefix and `?cn=` parsing duplicated as scattered literals**
`internal/plugins/singbox/release.go:35`, `internal/plugins/xray/release.go:25`, `internal/api/admin_servers.go:759,598,640`
`https://gh-proxy.com/` is a `const CNMirrorPrefix` in both release.go files, hardcoded inline in `buildInstallCommand`, and again in `scripts/install-agent.sh:69`; the `?cn=` parse is copy-pasted verbatim at `admin_servers.go:598` and `:640`.
**Fix:** Hoist `CNMirrorPrefix` to one shared package-level const imported by both plugins and the api package, and extract a `cnFlag(r *http.Request) bool` helper. **Verifier note:** the shell script literal can't import a Go const, so consolidation covers the 3 Go sites.
**Impact / Effort:** Low / Small

---

## Lower-priority backend items (small DB cleanups)

**`deleteHostDomain` runs two SELECTs for two columns of the same row** — `internal/plugins/cloudflare/host_domains.go:151,156`. Fetch `record_id` + `zone_id` in one `SELECT`, cutting the delete path from 3 to 2 round-trips. **Impact / Effort:** Low / Small

**Traffic batch handler issues one query per tag instead of one `IN` query** — `internal/plugins/singbox/traffic_query.go:238,146`. Use `WHERE tag IN (...)` + partition in Go (the `(server_id, tag, ts)` index supports it). **Verifier caveat:** the rewrite must explicitly seed all requested tags or empty-series tags get silently dropped; perf benefit is minor on local SQLite, so impact is low. **Impact / Effort:** Low / Small

**`SaveCandidates` loops per-candidate INSERTs without a transaction on every heartbeat** — `internal/agentsvc/ip_candidates.go:47,49`, `internal/telemetrysvc/ingest.go:46`. Wrap upserts in one `BeginTxx`/`Commit` with a prepared statement (candidate lists are tiny). **Impact / Effort:** Low / Small

**`pushAllEnabledHosts` rebuilds each host's config with 2 queries in a per-server loop** — `internal/plugins/netquality/routes.go:441`, `internal/plugins/netquality/push.go:51`. Only batch (2 grouped queries) if catalog-edit fanout becomes slow at scale; admin-edit path, not client hot path. **Impact / Effort:** Low / Medium

**`index.html` re-read from the embedded FS on every SPA navigation** — `internal/web/embed.go:51`. Read once into a package-level `[]byte` at `Handler()` construction; keep the placeholder fallback for the build-missing case. **Impact / Effort:** Low / Small

**SQLite missing `busy_timeout`; WAL benefit limited by `SetMaxOpenConns(1)`** — `internal/db/db.go:46,56`, `internal/config/config.go:58`. Add `PRAGMA busy_timeout=5000` and `synchronous=NORMAL` (safe under WAL). **Verifier downgrade:** the single-conn pin is a deliberate, documented choice and in-process `SQLITE_BUSY` is essentially impossible through the one shared handle; this is a cheap defensive nicety against external handles (backup/CLI), not a medium concurrency defect. **Impact / Effort:** Low / Medium

---

## Deferred / verifier-downgraded (low value, document but don't prioritize)

**Telemetry per-sample `agent_last_seen` UPDATE** — `internal/telemetrysvc/ingest.go:115-145`. The third per-sample exec is partly redundant with the heartbeat bump. **Verifier flagged the headline fix as risky:** simply dropping the per-sample UPDATE regresses liveness — `online` is `agent_last_seen` within 60s and the heartbeat ticker is also 60s, so the 30s telemetry bump is the freshness margin (exactly the false-offline mode commit `e12434a` hardened). Only fold-into-fewer-statements (preserving 30s freshness) is safe. **Impact / Effort:** Low / Small

**Agent→server frame double-encodes every payload (Frame marshal + Decode unmarshal)** — `internal/agentapi/envelope.go:16-41`, `internal/telemetrysvc/ingest.go:85-94`. **Verifier overstated→low:** the struct is 3 fields at 1Hz (sub-microsecond, dwarfed by WS framing), and the nested `RawMessage` is the protocol's routing mechanism (`Reg.Deliver` dispatches by `Sid`/`Type` before decode), so the proposed bypass would break uniform routing for negligible savings. Do not pursue.

**singboxv2sampler dials a fresh gRPC client every tick** — `internal/agent/singboxv2sampler/sampler.go:116-181`. **Verifier overstated→low:** 30s interval to a local `127.0.0.1` socket (~1ms), and the lazy-dial is a *deliberate, documented* choice to keep sing-box restart visibility and counter-reset semantics clean; a persistent conn reverses that tradeoff and is not a no-regression change. Do not pursue without care.

---

## Recommended sequencing

1. **WSConn.Send panic fix** (`wsconn.go`) — High impact, Small effort, and a reachable process crash on the normal reconnect path. Do first; no dependencies.
2. **Login rate-limiting + lockout** (`router.go`/`main.go`) — High impact, Small effort, closes an unthrottled brute-force on the root-capable admin gate. Pair with the **timing-oracle dummy-bcrypt fix** (trivial) since both touch `admin_auth.go`.
3. **tokenRateLimiter unbounded-map sweep/cap** — Small effort; do it alongside #2 because the safe login-limiter design depends on a bounded key map (avoid the verifier-flagged ineffective delete-on-empty approach).
4. **`.dockerignore` `data/`/`tmp/`** then **ldflags `-s -w -trimpath`** and **BuildKit cache mounts** — all Small effort, independent, and improve every subsequent build/CI iteration, so front-load them. Sweep up the **committed vitest cache file** in the same pass.
5. **Public-wall + admin-list N+1 batch helper (`LatestForAll`/`HostTrafficForAll`)** — Highest-leverage backend perf item; one shared helper covers both endpoints. Do before the subgen and livenet batch work since it establishes the batch-helper pattern and touches the highest-fanout public path.
6. **WriteSample transaction wrap** and **Preview context-cancel leak** — Small effort, contained, medium impact on the hottest ingest path and a connection-stalling leak respectively.
7. **BatchUpdateAgent semaphore** and **ServerList `navigate()`** — Small, low-risk wins once the higher-impact items land.
8. **Frontend render fixes** — Wall live store/selectors and LogsTab pause-ref, then ToastBridge consolidation; do the LogsTab pause fix *together with* extracting the shared `<PluginLogsTab>` so the fix lands once and can't drift.
9. **Larger refactors last** — `writeJSON` consolidation, `admin_servers.go` split + `dispatchAgentUpdate`, ServerList god-component split, render.go `buildTransport`, mirror-const hoist, and dead-code removal (keeping `TopologyStore.Delete` + structs). These are maintainability-only with negligible runtime impact and the most merge-conflict surface, so schedule them after the perf/security/correctness work, ideally one file-area at a time.