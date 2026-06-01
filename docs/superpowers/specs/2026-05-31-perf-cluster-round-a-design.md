# Perf cluster (audit Round A, items 5–7) — Design

**Date:** 2026-05-31
**Status:** Approved (scope confirmed via Q&A)
**Source:** `docs/system-optimization-audit.md` (sequencing items 5–7)

## Goal

Land the highest-leverage performance/correctness items from the optimization
audit in one branch, then PR + release:

1. **Batch the N+1 queries** on the public wall and the admin server list (each
   currently runs ~2N–3N serial DB round-trips per page load).
2. **Wrap `WriteSample`'s three writes in one transaction** (the hottest ingest
   path; three implicit fsyncs → one).
3. **Fix the `Preview` file-download goroutine leak** so it stops the agent
   transfer when the preview read completes (today it streams the whole file and
   head-of-line-blocks the agent connection).
4. **Make `BatchUpdateAgent` actually bound concurrent installs to 20** (today the
   semaphore only gates lightweight setup; the WS install RunCmds escape it).
5. **Switch the `ServerList` row click to `navigate()`** (today it does a full SPA
   page reload).

## Confirmed decisions

- **Portable batch SQL via a window function** (`ROW_NUMBER() OVER (PARTITION BY
  server_id ORDER BY ts DESC)`), expanded with `sqlx.In` + `db.Rebind` — works on
  both the SQLite (≥3.25) and Postgres drivers the project supports.
- **Missing→default indexing:** batch helpers return maps keyed by `server_id`;
  callers fall back to the same defaults the per-row helpers use today
  (`HostTraffic` absent → `{ServerID, ResetDay: 1}`; `Latest` absent → field
  omitted; netquality absent → nil/omitempty). The batch rewrite must not assume
  every id is present.
- **`BatchUpdateAgent` keeps fire-and-forget semantics** — the HTTP response still
  returns immediately with `OK: true` ("dispatched"), installs still run on
  `context.Background()` (a client disconnect must not cancel an install). The fix
  only adds a **shared bounded install semaphore** so total concurrent installs
  are capped at 20 across all batch calls.
- **No public-wall TTL cache** (YAGNI) — the batch query alone removes the N+1.

---

## ① Batch N+1 queries

### Telemetry batch helpers — `internal/telemetrysvc`

Add (mirroring the existing single-row `Latest`/`HostTraffic`):

```go
// LatestForAll returns the most recent sample per server for the given ids,
// keyed by server_id. Ids with no samples are absent from the map.
func (q *Query) LatestForAll(ctx context.Context, ids []int64) (map[int64]*Point, error)

// HostTrafficForAll returns the host_traffic row per server for the given ids,
// keyed by server_id. Ids with no row are absent (caller defaults).
func (q *Query) HostTrafficForAll(ctx context.Context, ids []int64) (map[int64]*HostTrafficRow, error)
```

- `LatestForAll`: one query selecting the same columns as `Latest`, ranked
  `ROW_NUMBER() OVER (PARTITION BY server_id ORDER BY ts DESC)` and filtered to
  `rn = 1`, with `WHERE server_id IN (?)`. Build via
  `query, args, _ := sqlx.In(base, ids); query = q.DB.Rebind(query)` then
  `SelectContext` into a slice; fold into the map by `server_id`. The `Point`
  struct must carry `server_id` for the fold (add an unexported scan field or
  select it into a wrapper row — see plan).
- `HostTrafficForAll`: `SELECT ... FROM host_traffic WHERE server_id IN (?)` via
  the same `sqlx.In`/`Rebind` pattern, folded into the map.
- Empty `ids` → return an empty map without querying.

### Netquality batch — `internal/plugins/netquality` + `cmd/server/main.go`

- Add a func field on `PublicAPI`:
  `NetqualitySummaryForAll func(ctx context.Context, ids []int64) map[int64][]NetqualityISPSummary`
  (alongside the existing per-server `NetqualitySummary`).
- `main.go` wires it to a new netquality plugin method that runs ONE grouped query
  over the id set and returns per-server ISP summaries (the batch analogue of the
  per-server summary the current closure builds). Absent ids → absent from the map.
- Keep the existing single-server `NetqualitySummary` for the per-server
  history/other callers; the wall switches to the batch func.

### Callers

- `public.go Servers_ListPublic`: after building the `show_on_public` id list, call
  `LatestForAll`, `HostTrafficForAll`, and (if wired) `NetqualitySummaryForAll`
  ONCE each; build each `publicCard` by indexing the maps with the missing→default
  fallback above. Behaviour (fields, omitempty, online threshold) is unchanged.
- `admin_servers.go List?with=latest`: collect ids, call `LatestForAll` once, index
  per row; `Connected` still comes from `a.hubIsOnline(s.ID)` per row (in-memory,
  not a DB call).

---

## ② WriteSample transaction — `internal/telemetrysvc/ingest.go`

Wrap the three statements (sample insert, conditional `host_traffic` upsert,
`agent_last_seen` update) in one transaction:

```go
tx, err := i.DB.BeginTxx(ctx, nil)
if err != nil { return err }
defer tx.Rollback() // no-op after Commit
// ... the three ExecContext calls become tx.ExecContext, SQL unchanged ...
return tx.Commit()
```

The `agent_last_seen` bump keeps `time.Now().UTC()` (server clock — the
false-offline fix from commit `e12434a`); the sample's own `ts` keeps `t.TS`. One
fsync per frame instead of three; sample+traffic+liveness become atomic.

---

## ③ Preview goroutine leak — `internal/api/files_routes.go`

Extract a small, unit-testable helper and use it from `Preview`:

```go
// previewRead pipes downloadFn's output, returns up to maxB bytes, and on return
// cancels the download context (so Download sends FileCancel and the agent stops)
// and closes the pipe reader (so an in-flight write fails fast instead of
// head-of-line-blocking the agent connection).
func previewRead(ctx context.Context, maxB int, downloadFn func(context.Context, io.Writer) error) []byte {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	pr, pw := io.Pipe()
	defer pr.Close()
	go func() { _ = pw.CloseWithError(downloadFn(ctx, pw)) }()
	buf := make([]byte, maxB)
	n, _ := io.ReadFull(pr, buf)
	return buf[:n]
}
```

`Preview` calls `data := previewRead(r.Context(), maxB, func(ctx, w) error { _, err := a.Files.Download(ctx, sid, path, w); return err })`, then keeps the
existing NUL-byte binary check + 200 text write on `data`. This makes the fix
testable without turning `FilesAPI.Files` into an interface.

---

## ④ BatchUpdateAgent bounded installs — `internal/api/admin_servers.go` (+ main.go)

- Add `installSem chan struct{}` to `ServersAPI`, initialized to capacity 20 where
  `ServersAPI` is constructed in `cmd/server/main.go` (`installSem: make(chan struct{}, 20)`).
- In `BatchUpdateAgent`, the background install goroutine acquires/releases it:

```go
go func() {
	a.installSem <- struct{}{}
	defer func() { <-a.installSem }()
	_, _, _, _ = a.HostExec.RunCmd(context.Background(), serverID, "sh", "-c", cmd)
}()
```

- Response still returns immediately with `OK: true` per dispatched server; the
  request-scoped setup semaphore (`sem`) and `wg.Wait()` over setup are unchanged.
  The new `installSem` is the only thing bounding the long WS RunCmds, shared
  across concurrent batch calls. Guard against a nil `installSem` (tests that
  construct `ServersAPI` without it) by lazily defaulting or requiring the test to
  set it — the plan uses an `installCap()`-style guard so a nil channel never
  blocks forever.

---

## ⑤ ServerList row navigation — `web/src/pages/admin/ServerList.tsx`

Replace `onClick={() => window.location.assign(\`/admin/servers/${s.id}\`)}` (line
414) with React Router navigation: add `const navigate = useNavigate()` and use
`navigate(\`/admin/servers/${s.id}\`)`. Inner cells keep their `stopPropagation`.
Mirrors the public Wall, which already uses `navigate()`.

---

## Testing

**Go:**
- `LatestForAll`/`HostTrafficForAll` (sqlite temp DB, mirror existing telemetrysvc
  tests): seed several servers with multiple samples/rows; assert the map returns
  the newest per server and that ids with no data are absent; empty-ids → empty
  map, no query.
- `WriteSample`: existing behaviour tests still pass; add one asserting all three
  effects land (a sample row, the host_traffic cumulative bump when net bytes
  present, and `agent_last_seen` advanced) — proving the transactional version is
  behaviour-preserving.
- `previewRead`: a `downloadFn` that writes a few bytes then blocks until its ctx
  is cancelled — assert it returns the written prefix, that the ctx ends up
  cancelled (download observed `ctx.Done`), and that a post-read write does not
  deadlock (pipe reader closed).
- `BatchUpdateAgent`: a stub `hostExecer` whose `RunCmd` tracks live concurrency
  and blocks briefly; dispatch N≫20 servers with a small `installSem`; assert the
  observed max concurrency never exceeds the cap and all installs eventually run.

**Frontend:** `ServerList` row click invokes `navigate` (vitest, mock
`useNavigate`); tsc + vitest green.

## Out of scope

- The remaining audit items (frontend render cluster = Round B; refactors/dead
  code = Round C; the lower-priority DB cleanups; the verifier-downgraded "do not
  pursue" items).
- Extracting a shared `dispatchAgentUpdate` for `UpdateAgent`+`BatchUpdateAgent`
  (a Round C refactor) — this round only bounds the batch path's installs.

## Verification gates

`go test -race ./...`, `golangci-lint run`, `gofmt`; frontend `tsc` + `vitest`.
End-to-end: load the public wall + admin list and confirm identical output with
far fewer queries; trigger a batch agent update and confirm ≤20 concurrent WS
installs.
