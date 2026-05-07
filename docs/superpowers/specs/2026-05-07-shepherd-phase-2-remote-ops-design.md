# Shepherd Phase 2 — Remote Ops Design

**Status:** approved (2026-05-07)
**Scope:** PTY remote terminal + script library/runner (with fan-out) + file browser + audit log, all over the existing agent reverse-WS channel.
**Predecessor:** Phase 1 (1.A backend + 1.B SPA + 1.C deploy/CI), shipped at v0.1.0.

---

## 1. Goals & non-goals

**Goals**
- Admin opens an interactive PTY to any online server from the browser.
- Admin authors reusable scripts (with parameter templates) and runs them on a single server or fan-out across many.
- Scripts run inside a PTY so interactive prompts (sudo, `read`, package managers) work; output is captured for audit.
- Admin browses, uploads, downloads, mkdir/rename/rm files on any online server, gated by a configurable path sandbox.
- Every privileged remote-ops action lands in a queryable `audit_log` table with configurable retention.
- All of the above multiplexed on the **existing single agent WS connection** (no new server↔agent transport).

**Non-goals (Phase 2)** — see §11 for the full list. Headlines:
- No RBAC (single admin role unchanged).
- No multi-viewer shared PTY sessions, no team workspaces.
- No file editor in the browser (read-only preview; upload-to-overwrite to "edit").
- No scheduling / cron / webhooks / alerting (Phase 6).
- No agent-side command whitelist (admin == root-equivalent already; sandbox covers files only).

---

## 2. Architecture overview

```
┌────────────┐  admin-cookie WS   ┌────────────────────────┐  agent-token WS   ┌─────────────┐
│  Browser   │ ◄───────────────► │  Server (single bin)    │ ◄──────────────► │  Agent (root)│
│ xterm.js   │  binary frames     │  sessionmux Registry   │  envelope + bin   │  ptyrunner   │
│ scripts UI │  for pty / files   │  ptysvc / scriptsvc    │  multiplexed by   │  filehandler │
│ FB UI      │                    │  filesvc / audit       │  sid              │  state.json  │
└────────────┘                    └────────────────────────┘                   └─────────────┘
                                  ▲           ▲                                       ▲
                                  │           │                                       │
                                  │  HTTP REST│ for script CRUD, file ops,            │  /etc/shepherd/
                                  │           │ audit, recording playback             │  agent.state.json
                                  └───────────┘                                       │  (sandbox config)
```

**New top-level packages**
- `internal/sessionmux` — sid → consumer registry (browser conn, http req-reply chan, internal channels)
- `internal/ptysvc` — PTY session lifecycle on the server (open / close / record / finalize)
- `internal/scriptsvc` — script CRUD, template render, fan-out scheduler
- `internal/filesvc` — file ops API, HTTP↔WS bridging via sid
- `internal/audit` — audit log writer + retention loop
- `internal/agent/ptyrunner` — agent-side pty spawn/wire
- `internal/agent/filehandler` — agent-side file ops + sandbox

**Touched existing packages**
- `internal/agentapi` — new envelope types + binary frame header parser
- `internal/agentsvc` — Hub gains `SendBinary(serverID, sid, kind, payload)`; per-conn write goroutine
- `internal/agent/wsclient` — read loop dispatches text vs binary; runners registry
- `internal/api` — new admin routes; agent_routes binary dispatch
- `internal/serversvc` — Settings adds 7 keys (see §6.4)
- `internal/web` (Go embed) — new frontend bundle

---

## 3. Wire protocol

### 3.1 Envelope (unchanged, Phase 1)

```go
type Envelope struct {
    Sid  string          `json:"sid,omitempty"`
    Type string          `json:"type"`
    P    json.RawMessage `json:"p"`
}
```

Phase 1 reserved `sid` for Phase 2; this design uses it. JSON envelopes flow as **WebSocket text frames**.

### 3.2 Control-plane types (added in Phase 2)

PTY (covers both interactive console and script execution — same path):

| Direction | Type | Payload fields |
|---|---|---|
| s→a | `pty.open` | `sid, kind ("console"\|"script"), user, rows, cols, term, exec, env (map[string]string), timeout_s` |
| s→a | `pty.resize` | `sid, rows, cols` |
| s→a | `pty.close` | `sid, reason` |
| a→s | `pty.exit` | `sid, code` |

File ops (request / reply, correlated by sid):

| Direction | Type | Payload fields |
|---|---|---|
| s→a | `file.list` | `sid, path` |
| a→s | `file.list.result` | `sid, entries:[{name,size,mode,mtime,is_dir,is_link,link_target}], error` |
| s→a | `file.stat` | `sid, path` |
| a→s | `file.stat.result` | `sid, entry, error` |
| s→a | `file.mkdir` | `sid, path, mode` |
| s→a | `file.rename` | `sid, src, dst` |
| s→a | `file.rm` | `sid, path, recursive` |
| a→s | `file.op.result` | `sid, ok, error` |
| s→a | `file.upload.begin` | `sid, path, size, mode, sha256` |
| s→a | `file.upload.end` | `sid, total_bytes, sha256` |
| a→s | `file.upload.ack` | `sid, ok, error` |
| s→a | `file.download.begin` | `sid, path` |
| a→s | `file.download.meta` | `sid, size, mode, mtime, error` |
| a→s | `file.download.end` | `sid` |
| s↔a | `file.cancel` | `sid, reason` |

`config.update` is extended (s→a) to push sandbox settings (see §6.3).

### 3.3 Data-plane (binary frames)

WebSocket **binary** messages carry stream payloads. Header layout:

```
[2B sid_len, big-endian][1B kind][sid_len bytes of sid][payload bytes ...]
```

Total header = 3 + sid_len bytes. `sid_len` ≤ 64 (defensive cap; v1 always 22).

`kind` enum:

| 0x01 | `pty.out` (a→s) |
| 0x02 | `pty.in`  (s→a) |
| 0x10 | `file.chunk` (direction follows the begin context) |

`sid` is generated by the server: 16 random bytes via `crypto/rand`, base64url-encoded → 22 ASCII chars. Validated as `^[A-Za-z0-9_-]{22}$` on agent.

### 3.4 Read loop dispatch

Both `internal/agent/wsclient/client.go::dialAndRun` and `internal/api/agent_routes.go` switch on `websocket.MessageType`:

- `TextMessage` → JSON-decode `Envelope` → `dispatchControl(env)`
- `BinaryMessage` → parse header → `dispatchData(serverID, sid, kind, payload)`

Unknown kind / oversized sid_len → drop frame, log once per (serverID, kind).

### 3.5 Write serialization (slow-consumer policy)

Each WS conn (agent end and server's per-agent end and per-browser end) wraps the raw `*websocket.Conn` in a `wsConn` with a single writer goroutine and bounded `sendCh chan outFrame` (cap 256). `Send` non-blocking with 100 ms timeout. On timeout the conn is closed. For the agent-end this triggers reconnect; for browser-end this triggers `pty.close{reason:"slow_consumer"}` + browser WS close.

---

## 4. PTY / Script subsystem

### 4.1 Agent-side `internal/agent/ptyrunner`

```go
type Runner struct {
    sid     string
    cmd     *exec.Cmd
    ptmx    *os.File
    pgid    int
    sender  Sender   // SendBinary(sid string, kind byte, p []byte); SendControl(env Envelope)
    onExit  func(code int, err error)
    cancel  context.CancelFunc
    closed  atomic.Bool
}

func Spawn(ctx context.Context, opts SpawnOpts, sender Sender, onExit func(int, error)) (*Runner, error)
```

**SpawnOpts → command resolution**

| `kind` | `user` | command argv |
|---|---|---|
| `console` | `""` or `"root"` | `/bin/bash -l` |
| `console` | non-root | `/bin/su -l <user>` |
| `script`  | `""` or `"root"` | `/bin/bash -lc <exec>` |
| `script`  | non-root | `/bin/su -l <user> -c <exec>` (the `-c` arg is shell-escaped via Go `strconv.Quote`-equivalent) |

`user` validated against `^[a-z_][a-z0-9_-]{0,31}$`; reject otherwise (`spawn_user_invalid`). `exec` length limited to 64 KiB. `term` defaults to `xterm-256color`. Env minimum: `TERM`, `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, `HOME` resolved via the target user's passwd entry.

**Process group:** `cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}`. The `-pgid` is signalled on close to take down all descendants.

**PTY allocation:** `creack/pty.StartWithSize(cmd, &pty.Winsize{Rows, Cols})`.

**Reader goroutine:** loop `n, err := ptmx.Read(buf[16384])`; coalesce in a 4 KiB output buffer; flush on full or 20 ms timer; each flush emits one `pty.out` binary frame via `sender.SendBinary(sid, 0x01, buf)`. EOF / err → break, then `cmd.Wait()` collects the exit code.

**Wait goroutine:** `cmd.Wait()` → `onExit(cmd.ProcessState.ExitCode(), nil)`. The handler synthesises `pty.exit{sid, code}` to the server.

**Resize:** `pty.Setsize(ptmx, &pty.Winsize{Rows, Cols})`. Mid-session resize is **not** persisted in the recording (initial size only is recorded).

**Close flow:** `Close(reason)` does
1. `closed.Store(true)`
2. `syscall.Kill(-pgid, syscall.SIGTERM)`
3. wait up to 5 s for `cmd.Wait`'s goroutine
4. if still alive, `syscall.Kill(-pgid, syscall.SIGKILL)`
5. `ptmx.Close`

**Runners registry** in `wsclient`: `map[string]*Runner` mutex-guarded. Bounded by `pty_max_concurrent_per_admin` × number of admins; agent enforces a hard ceiling of 50 concurrent runners (defensive).

### 4.2 Server-side `internal/ptysvc`

```go
type Service struct {
    DB      *sqlx.DB
    Hub     *agentsvc.Hub
    Reg     *sessionmux.Registry
    Audit   *audit.Writer
    Records RecordingStore
    Now     func() time.Time
}

type OpenOpts struct {
    AdminID    int64
    ServerID   int64
    Kind       string // "console" | "script"
    User       string // "" → root
    Rows, Cols int
    Term       string
    Exec       string // "" → login shell
    Env        map[string]string
    TimeoutS   int    // only honoured for kind="script"
    Browser    BrowserConn // nullable for headless script runs
}

func (s *Service) Open(ctx, OpenOpts) (*Session, error)
```

`Session` shape:

```go
type Session struct {
    SID         string
    PTYRowID    int64        // pty_sessions.id
    ServerID    int64
    AdminID     int64
    Kind        string
    Started     time.Time
    Recorder    *castWriter
    Browser     atomic.Value // *BrowserConn or nil
    Closed      atomic.Bool
    deadline    *time.Timer  // for script timeout
}
```

`Open` sequence:
1. Generate `sid` (22-char base64url).
2. INSERT `pty_sessions` row → get `id`.
3. Create recording file (only if `pty_recording_enabled` and `kind == "console"` OR a recorder is requested for scripts; default: record both kinds). Path: `data/pty-recordings/<server_id>/<id>.cast`. `MkdirAll(0700)`. Open writer in append mode; write asciicast v2 header.
4. Register in `Reg.RegisterPTY(sid, session)`.
5. Build `pty.open` envelope; `Hub.Send(serverID, env)`. On `ErrAgentOffline` → `Reg.Unregister(sid)`, finalize recording (header only, mark `error="agent_offline"`), DELETE pty_sessions row OR write `ended_reason="agent_offline"`. Return `ErrAgentOffline`.
6. Audit: `pty.open` with `details_json = {kind, user, rows, cols, exec_sha256_hex, timeout_s}`. (Never log raw exec content; that's in the run row / cast.)
7. If `kind=="script" && timeoutS > 0`, start a `time.AfterFunc(timeoutS, s.timeoutClose(sid))`.
8. Return `*Session`.

`Close(sid, reason)` orchestrates:
- Send `pty.close{sid, reason}` to agent (best-effort; agent may already be gone).
- Mark `Closed`. The actual finalization happens on `pty.exit` arrival OR after a 7 s timeout if no `pty.exit` (agent stuck) — finalize with `exit_code=-3, ended_reason="agent_unresponsive"`.

`onExit(sid, code)` arrives via the agent_routes `pty.exit` handler:
- Lookup session in Reg; idempotent (drop if already closed).
- `Recorder.Close()`.
- UPDATE `pty_sessions SET ended_at=?, exit_code=?, ended_reason=?` (reason = "exit" / "timeout" / "browser_closed" / "slow_consumer" depending on Close path).
- If linked to a `script_run_targets` row, UPDATE that row's `status` and `finished_at`; check siblings → maybe UPDATE `script_runs.finished_at`.
- Notify `Browser` with control text frame `{op:"exited", code}`; close browser conn.
- Audit: `pty.close` with `{exit_code, duration_s, ended_reason}`.
- `Reg.Unregister(sid)`.

### 4.3 Recording (asciicast v2)

```go
type castWriter struct {
    f       *os.File
    mu      sync.Mutex
    started time.Time
    bytes   int64           // for truncation cap
    capped  bool
}
```

Header (one JSON object on first line):

```json
{"version":2,"width":80,"height":24,"timestamp":1715000000,"command":"/bin/bash -l","title":"shepherd:srv1:console","env":{"SHELL":"/bin/bash","TERM":"xterm-256color"}}
```

Each output flush appends one event line:

```
[<elapsed_seconds float>, "o", "<JSON-escaped UTF-8 string of payload>"]
```

Non-UTF-8 bytes get replaced via Go's `string(p)` round-trip (acceptable v1 limit).

**Cap:** if `bytes > 100 MiB`, set `capped=true`, stop appending, log warning, audit detail `recording_truncated:true`. The PTY session continues normally; only the recording file is frozen.

**Finalize:** rename atomic? No — the file is already valid asciicast at any point because each line is independently parseable. Just `f.Sync(); f.Close()`.

### 4.4 sessionmux

```go
type Registry struct {
    mu       sync.Mutex
    pty      map[string]*ptysvc.Session
    file     map[string]*filesvc.Transfer  // upload / download streams
    request  map[string]chan agentapi.Envelope // single-shot req/reply
}

func (r *Registry) RegisterPTY(sid string, sess *ptysvc.Session)
func (r *Registry) RegisterFile(sid string, t *filesvc.Transfer)
func (r *Registry) RegisterRequest(sid string) <-chan agentapi.Envelope
func (r *Registry) Unregister(sid string)
func (r *Registry) Deliver(env agentapi.Envelope) bool
func (r *Registry) DeliverBinary(sid string, kind byte, p []byte) bool
```

`Deliver` first checks `pty` for known PTY data routes, then `file` for chunk data, then `request` for single-shot replies. Unknown sid → drop, log once.

### 4.5 Script fan-out — `internal/scriptsvc`

```go
type Service struct {
    DB    *sqlx.DB
    PTY   *ptysvc.Service
    Audit *audit.Writer
    Now   func() time.Time
}

func (s *Service) Run(ctx context.Context, scriptID, adminID int64, args map[string]string, targets []int64) (runID int64, err error)
```

Steps:
1. SELECT `scripts` row.
2. Validate args: required params present; param names match `^[a-zA-Z_][a-zA-Z0-9_]*$`; values are arbitrary strings (pass-through).
3. Render `text/template` over `script.content` with `data=args` (no funcMap; template syntax errors at template-parse time → 400).
4. INSERT `script_runs(script_id, admin_id, args_json, started_at)` → `runID`.
5. For each `targetServerID`:
   - INSERT `script_run_targets(run_id=runID, server_id=tgt, status="pending")` → `targetID`.
   - Call `ptysvc.Open({Kind:"script", Exec:rendered, User:"root", TimeoutS:script.default_timeout_s, Rows:80, Cols:24, Browser:nil})`. On success: UPDATE target `status="running", pty_session_id=ptyRowID, started_at=now`. On `ErrAgentOffline`: UPDATE `status="agent_offline", finished_at=now`.
6. Audit `script.run` with `{run_id, script_id, target_count, args_json}` (rendered exec NOT in audit; it's in pty_sessions.exec).
7. Return `runID`.

Convergence (all-targets-done detection): the `pty.exit` handler in §4.2 checks if the closed session is linked to a `script_run_targets` row, and if so checks for siblings. UPDATE `script_runs.finished_at = now` once `COUNT(*) FROM script_run_targets WHERE run_id=? AND finished_at IS NULL = 0`.

**Limits:** `len(targets) ≤ 50` (defensive); `len(args) ≤ 64`; `len(rendered exec) ≤ 64 KiB`.

### 4.6 PTY admin API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/admin/console/open` | Body `{server_id, user, rows, cols, term}`. Response `{session_id, sid}` (sid for the WS query). |
| GET  | `/api/admin/console/ws?session_id=X` | WS upgrade. Auth via admin cookie. Resize is a control text frame on this WS (`{op:"resize",rows,cols}`); no separate REST endpoint. |
| GET  | `/api/admin/recordings/{pty_session_id}.cast` | Sendfile for replay. |

The flow is "open then attach": POST returns `{sid}` and the browser opens the WS. Server holds the session for 10 s waiting for the WS attach; if the browser never attaches, the session is closed with `ended_reason="never_attached"`. (For headless script runs, no attach is required.)

---

## 5. Files subsystem

### 5.1 HTTP API

| Method | Path | Body / Query | Notes |
|---|---|---|---|
| GET  | `/api/admin/files?server_id=&path=` | — | ls; returns entries array |
| POST | `/api/admin/files/stat` | `{server_id, path}` | single entry |
| POST | `/api/admin/files/mkdir` | `{server_id, path, mode}` | mode default 0755 |
| POST | `/api/admin/files/rename` | `{server_id, src, dst}` | src and dst both sandbox-checked |
| POST | `/api/admin/files/rm` | `{server_id, path, recursive}` | recursive default false |
| GET  | `/api/admin/files/preview?server_id=&path=&max_bytes=` | — | text only; 415 if binary; max_bytes ≤ 256 KiB |
| GET  | `/api/admin/files/download?server_id=&path=` | — | streaming |
| POST | `/api/admin/files/upload?server_id=&path=&mode=` | request body = file bytes | streaming, max 100 MiB |

All endpoints admin-cookie-authenticated.

### 5.2 HTTP→sid bridging

```go
// internal/sessionmux/registry.go
func (r *Registry) Request(serverID int64, hub *Hub, frameType string, payload any, timeout time.Duration) (json.RawMessage, error)
```

Allocates sid, registers single-shot reply chan, sends envelope, blocks until reply or timeout. The agent-side reply (`file.list.result`, `file.op.result`, `file.stat.result`) is dispatched in `agent_routes.go::dispatchControl` via `Reg.Deliver(env)`.

Default timeouts:
- `file.list`, `file.stat`: 10 s
- `file.mkdir`, `file.rename`, `file.rm`: 30 s (rm of large dir)
- `file.upload.begin`, `file.download.begin`: 30 s before first chunk

### 5.3 Streaming

**Upload:** server reads HTTP request body in 256 KiB chunks. For each chunk: `Hub.SendBinary(serverID, sid, 0x10, chunk)`. If `received > file_upload_max_bytes`, send `file.cancel{reason:"oversize"}` and 413. After EOF, send text envelope `file.upload.end{sid, total_bytes, sha256}`; agent verifies the hash and replies `file.upload.ack{sid, ok, error}`. Server returns HTTP 200 `{ok, error?}` on ack.

**Download:** server sends `file.download.begin{sid, path}`. Awaits `file.download.meta{sid, size, mode, mtime}` (or `error`). On meta, sets HTTP `Content-Length`, `Content-Type=application/octet-stream`, `Content-Disposition`. Then for each incoming `file.chunk` binary frame matching sid: `w.Write(payload); flusher.Flush()`. Terminates on `file.download.end{sid}` (text envelope). On agent error mid-stream → connection drop or `file.cancel{reason}` → server tries to flush 500 trailer (best-effort) and closes.

### 5.4 Agent-side `internal/agent/filehandler`

```go
type Handler struct {
    sender    Sender
    sandbox   atomic.Pointer[Sandbox]   // hot-swappable via config.update
    transfers map[string]*xfer          // sid → upload/download state
    mu        sync.Mutex
}

type Sandbox struct {
    Enabled bool
    Allowed []string  // canonicalized absolute paths, no trailing slash
}
```

`Sandbox.Check(path string, mustExist bool) error`:
1. `enabled=false` → nil.
2. `abs := filepath.Abs(path)`.
3. `resolved, err := filepath.EvalSymlinks(abs)`:
   - on `os.IsNotExist(err)` and `mustExist=false`: re-resolve `filepath.Dir(abs)`; the parent's resolved path becomes the candidate (so we only allow creating *under* a whitelisted ancestor).
   - other err → return.
4. `cleaned := filepath.Clean(resolved)`.
5. For each `p` in `Allowed` (cleaned): if `cleaned == p` or `strings.HasPrefix(cleaned, p+string(filepath.Separator))` → nil.
6. Otherwise → `ErrPathNotAllowed`.

**Per-op flow:**

- `file.list`: Check, then `os.ReadDir`, `os.Lstat` per entry, build list, send `file.list.result`.
- `file.stat`: Check, `os.Lstat`, send.
- `file.mkdir`: Check (mustExist=false), `os.MkdirAll(path, mode&0777)`, ack.
- `file.rename`: Check src AND dst, `os.Rename`. Cross-FS `EXDEV` → return error (no copy fallback in v1).
- `file.rm`: Check. If recursive: `os.RemoveAll`. Else: `os.Remove`.
- `file.upload.begin`: Check, parent must exist; create temp file `<path>.shep-uploading-<sid>` with mode 0600; record state `xfer{f, sha256:hash.Hash, written:int64, target:path, mode}`; ack ok.
- `file.chunk` (binary in): write to temp, update sha; if `written > size_limit_from_begin`, cancel and remove temp.
- `file.upload.end`: hash check; if mismatch, remove temp; else `os.Chmod(temp, mode); os.Rename(temp, target)`; ack.
- `file.download.begin`: Check, `os.Open`, `os.Stat`; send `file.download.meta`. Spawn reader goroutine: 256 KiB chunks via binary frame; on EOF send `file.download.end`; on err send `file.cancel`.
- `file.cancel` (s→a): close active xfer for sid, remove temp file if upload.

### 5.5 Sandbox config sync

`agentapi.ConfigUpdate` extension:

```go
type ConfigUpdate struct {
    TelemetryIntervalSeconds int       `json:"telemetry_interval_seconds,omitempty"`
    FileSandboxEnabled       *bool     `json:"file_sandbox_enabled,omitempty"`
    FileSandboxPaths         []string  `json:"file_sandbox_paths,omitempty"`
}
```

Push points:
- On every successful agent WS attach: server sends a full snapshot `config.update` immediately after the heartbeat.
- On admin save in Settings (sandbox enabled / paths changed): server iterates `Hub.connections` and sends a delta to all online agents. Failure to push to an agent is logged but not retried; next attach will pick up the snapshot.

Agent persists `Sandbox` into `state.json` (new top-level field). On restart, the agent applies the persisted state until the next snapshot arrives (within seconds).

---

## 6. Audit subsystem

### 6.1 Schema

```sql
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           DATETIME NOT NULL,
  admin_id     INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  server_id    INTEGER REFERENCES servers(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  result       TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX audit_log_ts        ON audit_log(ts);
CREATE INDEX audit_log_server_ts ON audit_log(server_id, ts);
CREATE INDEX audit_log_action_ts ON audit_log(action, ts);
```

`action` enum (string): `pty.open`, `pty.close`, `script.create`, `script.update`, `script.delete`, `script.run`, `file.list`, `file.preview`, `file.upload`, `file.download`, `file.mkdir`, `file.rename`, `file.rm`, `settings.update`.

`result` ∈ `{"ok","error"}`.

### 6.2 Writer

```go
type Writer struct{ DB *sqlx.DB; Now func() time.Time }
func (w *Writer) Write(ctx, adminID, serverID *int64, action string, details map[string]any, errResult error)
```

Best-effort: writer never panics on DB error, only logs. (Audit DB write failure is a soft failure; we don't want it to block remote ops.)

### 6.3 API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/audit?from=&to=&action=&server_id=&admin_id=&q=&page=&page_size=` | Paginated; `q` matches `details_json` LIKE |
| GET | `/api/admin/audit.csv?...` | Same filters, CSV export, max 10 000 rows |

### 6.4 Retention

```go
type AuditRetention struct{ DB *sqlx.DB; Settings *serversvc.SettingsStore }
func (r *AuditRetention) Run(ctx context.Context)  // every 10 minutes
```

Reads `audit_retention_days` from settings; `DELETE FROM audit_log WHERE ts < now()-Ndays`. Same goroutine slot as `telemetrysvc.Retention` is wired in `cmd/server/main.go`.

---

## 7. Frontend

### 7.1 Components / pages

New routes (all under `/admin/...`):

| Path | Component | Purpose |
|---|---|---|
| `/admin/scripts` | `ScriptsListPage` | library list |
| `/admin/scripts/new` | `ScriptEditPage` | create |
| `/admin/scripts/:id` | `ScriptEditPage` | edit |
| `/admin/scripts/:id/run` | `ScriptRunPage` | params + targets + dispatch |
| `/admin/script-runs` | `ScriptRunsPage` | history |
| `/admin/script-runs/:rid` | `ScriptRunDetailPage` | per-target status; attach |
| `/admin/files/:server_id` | `FileBrowserPage` | dual-pane FB |
| `/admin/audit` | `AuditLogPage` | filtered table |
| `/admin/recordings/:pty_id` | `RecordingPlayerPage` | asciinema-player |

Global mounted at root layout: `<ConsoleDock />` — bottom drawer, default 320 px tall, drag-resize handle, tab strip.

`<XtermPane sessionId>` lifecycle:
- Mount: open `wss://.../api/admin/console/ws?session_id=X`. WS `binaryType="arraybuffer"`.
- Receive binary → `term.write(new Uint8Array(buf))`.
- Receive text → JSON `{op:"exited",code}` → display banner + disable input.
- `term.onData(d => ws.send(new TextEncoder().encode(d)))` — but the server expects binary `pty.in`; the browser→server WS protocol uses **binary frames for input** (no header — the server's per-conn handler tags it as `0x02 pty.in` toward the agent automatically). Resize uses **text frames** as JSON: `{op:"resize",rows,cols}`.
- Unmount → `ws.close()`.

### 7.2 New deps

```
@xterm/xterm                ~5.x
@xterm/addon-fit            ~0.x
@xterm/addon-web-links      ~0.x
asciinema-player            ~3.x
```

Bundle impact: ~120 KiB gzipped added. Total bundle target ≤ 280 KiB gzipped.

### 7.3 zustand stores

```
useConsoleTabsStore   // { tabs: Tab[]; openTab(); closeTab(); focus() } — non-persistent
useFileBrowserStore   // per-server cwd, sort, selection (sessionStorage)
useScriptDraftStore   // create/edit-page autosave (sessionStorage)
```

### 7.4 i18n

Sites: `web/src/i18n/{zh-CN,en}.json` add namespaces `scripts.*`, `console.*`, `files.*`, `audit.*`, `recording.*`. Both languages must be complete at merge time.

---

## 8. Database schema (full Phase 2 migration)

`internal/db/migrations/sqlite/0010_phase2.sql` (postgres mirror under `postgres/`):

```sql
CREATE TABLE pty_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id       INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  admin_id        INTEGER NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
  kind            TEXT    NOT NULL CHECK (kind IN ('console','script')),
  exec_user       TEXT    NOT NULL DEFAULT 'root',
  rows            INTEGER NOT NULL DEFAULT 24,
  cols            INTEGER NOT NULL DEFAULT 80,
  exec            TEXT    NOT NULL DEFAULT '',
  recording_path  TEXT,
  started_at      DATETIME NOT NULL,
  ended_at        DATETIME,
  exit_code       INTEGER,
  ended_reason    TEXT
);
CREATE INDEX pty_sessions_server ON pty_sessions(server_id, started_at);
CREATE INDEX pty_sessions_admin  ON pty_sessions(admin_id, started_at);

CREATE TABLE scripts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT    NOT NULL UNIQUE,
  description        TEXT    NOT NULL DEFAULT '',
  content            TEXT    NOT NULL,
  params_json        TEXT    NOT NULL DEFAULT '[]',
  default_timeout_s  INTEGER,
  created_at         DATETIME NOT NULL,
  updated_at         DATETIME NOT NULL
);

CREATE TABLE script_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id   INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
  args_json   TEXT    NOT NULL DEFAULT '{}',
  started_at  DATETIME NOT NULL,
  finished_at DATETIME
);
CREATE INDEX script_runs_started ON script_runs(started_at);

CREATE TABLE script_run_targets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER NOT NULL REFERENCES script_runs(id) ON DELETE CASCADE,
  server_id       INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  pty_session_id  INTEGER REFERENCES pty_sessions(id) ON DELETE SET NULL,
  status          TEXT    NOT NULL,  -- pending|running|succeeded|failed|agent_offline|timeout
  exit_code       INTEGER,
  started_at      DATETIME,
  finished_at     DATETIME
);
CREATE INDEX script_run_targets_run ON script_run_targets(run_id);

CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            DATETIME NOT NULL,
  admin_id      INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  server_id     INTEGER REFERENCES servers(id) ON DELETE SET NULL,
  action        TEXT    NOT NULL,
  details_json  TEXT    NOT NULL DEFAULT '{}',
  result        TEXT    NOT NULL DEFAULT 'ok'
);
CREATE INDEX audit_log_ts        ON audit_log(ts);
CREATE INDEX audit_log_server_ts ON audit_log(server_id, ts);
CREATE INDEX audit_log_action_ts ON audit_log(action, ts);
```

`internal/db/migrations/sqlite/0011_phase2_settings.sql`:

```sql
INSERT INTO settings(key, value) VALUES
 ('file_sandbox_enabled',          'true'),
 ('file_sandbox_paths',             '/tmp\n/var/log\n/etc/shepherd\n/home\n/opt\n/srv'),
 ('audit_retention_days',           '30'),
 ('pty_recording_enabled',          'true'),
 ('pty_max_concurrent_per_admin',   '5'),
 ('file_upload_max_bytes',          '104857600'),
 ('file_chunk_bytes',               '262144')
ON CONFLICT(key) DO NOTHING;
```

Postgres equivalents: `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`; `DATETIME` → `TIMESTAMPTZ`; `ON CONFLICT(key) DO NOTHING` works in both.

---

## 9. Limits / quotas

| Limit | Default | Source |
|---|---|---|
| Concurrent PTYs per admin | 5 | `pty_max_concurrent_per_admin` |
| Concurrent PTYs per server | 10 | hardcoded |
| `pty.open exec` length | 64 KiB | hardcoded |
| Script template render output | 64 KiB | hardcoded |
| Script fan-out targets per run | 50 | hardcoded |
| File upload size | 100 MiB | `file_upload_max_bytes` |
| File chunk | 256 KiB | `file_chunk_bytes` |
| File preview max | 256 KiB | request param ceiling |
| Recording file max | 100 MiB | hardcoded; truncates session's recording, not the session itself |
| Audit `details_json` length | 16 KiB | hardcoded; oversized details are summarized to `{truncated:true,size:N}` |

---

## 10. Error handling matrix

| Trigger | Behaviour |
|---|---|
| `Hub.Send` while agent offline | API → 503 `{error:"agent_offline"}`. UI banner + "retry when online" hint. |
| `Reg.Request` timeout | 504 `{error:"agent_timeout"}`. Server does NOT send `file.cancel` (agent may still be doing work; reply will be dropped). |
| Sandbox reject | agent → `file.op.result{ok:false,error:"path not allowed: <abs>"}`. server → 403 with that message. |
| PTY spawn failure (user/shell) | agent → `pty.exit{code:127}`. server finalizes with `ended_reason="spawn_failed"`. UI banner. |
| Template render error | API 400 `{error:"template",detail:"..."}`. Form highlights culprit param. |
| Upload size exceeded | server sends `file.cancel{reason:"oversize"}`. HTTP 413. Agent removes temp file. |
| Recording write failure | Continues PTY; logs once; audit detail `recording_error`. |
| Browser slow consumer | server → 100 ms write timeout → close browser conn + send `pty.close{reason:"slow_consumer"}`. |
| Server restart | startup sweep: `UPDATE pty_sessions SET ended_at=now, ended_reason='server_restart' WHERE ended_at IS NULL`; `UPDATE script_run_targets SET status='failed', finished_at=now WHERE status IN ('pending','running')`; cascade `script_runs.finished_at=now`. |
| Agent disconnect mid-session | Hub Unregister → ptysvc onDisconnect callback → finalize all sessions for that serverID with `exit_code=-2, ended_reason='agent_disconnected'`. |
| Old agent (no Phase 2 support) connects | server detects via `pty.open` request not getting `pty.exit` reply within 10 s → API 503 + admin Settings UI shows version warning per server (red badge "agent vX.Y, < required vY.Z"). |

---

## 11. Out of scope (explicit YAGNI)

- RBAC / roles
- Multi-viewer shared PTY
- File editor (preview only; upload-to-overwrite)
- Searching across files (`grep` fan-out)
- Resumable / chunked-with-retry upload
- Binary preview (hex viewer)
- Cron / scheduled scripts
- Webhooks / notifications
- Agent-side command whitelist
- TTY resize event recording
- Self-update of agent binary
- ssh-agent / kerberos forwarding

---

## 12. Test plan

- Unit: agentapi binary frame codec; ptyrunner spawn (linux build tag, `echo`-based); filehandler sandbox table-driven (incl. symlink escapes); sessionmux concurrency under `-race`; ptysvc lifecycle with fake hub + fake agent; scriptsvc render + fan-out + convergence; audit write + retention; settings push.
- Frontend: vitest for `XtermPane` (mock WS), `ScriptRunDetailPage`, `FileBrowserPage`, ConsoleDock store, params form rendering. Existing 34-test base must remain green.
- E2E smoke `scripts/phase2-smoke.sh`:
  1. boot server (sqlite) + agent;
  2. open PTY, type `echo hello`, assert output;
  3. create script `echo $PACKAGE` with one required param `PACKAGE`, run on `[1]` with `args={PACKAGE:"shep-test"}`, poll target → `succeeded`, fetch the recorded `.cast` → assert it contains `shep-test`;
  4. mkdir `/tmp/shep-smoke`; upload "hello"; list; download; rm;
  5. attempt list of `/etc/shadow` → assert 403;
  6. assert audit_log contains all expected actions;
  7. teardown.
- Lint / format: `gofmt -l`, `go vet`, `golangci-lint run --timeout=5m`, `go test -race ./...`, `npm test`, `npm run build` — all clean before tagging.

---

## 13. Migration / rollout notes

- Adds 5 tables, 7 settings rows, 1 settings field push (sandbox). No existing rows touched.
- New `data/pty-recordings/` directory; created on first PTY open. Docker volume already mounts `/data`.
- Agent binary requires re-deploy to gain Phase 2 capabilities; old agents (v0.1.x) keep running for telemetry/install/heartbeat. Server feature-detects via response timeout; UI surfaces a per-server "needs upgrade" banner.
- No breaking changes to existing endpoints; minor additive change to `agentapi.ConfigUpdate` is backward-compatible (omitempty fields).
- Bilingual README and deploy docs gain a "Remote Ops" section after spec is implemented.
