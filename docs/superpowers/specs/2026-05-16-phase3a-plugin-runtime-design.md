# Phase 3a: Plugin Runtime + Plugin Center — Design

**Status:** approved (2026-05-16)
**Builds on:** v0.3.0 (Linear-style admin UI; PluginsPage placeholder shipped)
**Next phases not in scope here:** Phase 3b (relay plugin), Phase 3c (third-party / marketplace)

## 1. Scope

### 1.1 What ships in 3a

- Plugin runtime: compile-time built-in Go interface + registry + lifecycle.
- Plugin center UI: lists every compiled plugin, lets the admin enable / disable, shows per-host deployment state for `HostAware` plugins.
- Reference plugin **xray** (HostAware): GitHub release fetcher + per-OS/arch binary cache + per-host deploy via existing filehandler + systemd-managed daemon.
- Reference plugin **cloudflare** (server-side only): API token storage + Zones / DNS / Audit log passthrough UI.
- Per-plugin migrations wired through the runtime so each plugin owns its own tables.

### 1.2 Explicitly NOT in scope

- Third-party dynamic loading, signing, OCI distribution — no marketplace. All plugins are first-party Go packages in the Shepherd monorepo.
- relay plugin — almost identical to xray in shape; building it after xray will lift 80% of the deploy plumbing. Tracked as Phase 3b.
- Hot reload of plugin code — restart the server. The plugin registry is built at `init()` time.
- Plugin observability (metrics emitted by plugins back to Shepherd telemetry) — defer.
- Plugin-to-plugin events / pub-sub — defer.

### 1.3 Key constraints

- Shepherd server needs outbound network access to `github.com` to download xray releases. Failures surface to the operator UI with a "try again" affordance; no automatic retries.
- Plugin credentials (cloudflare API tokens, xray UUIDs / passwords) are stored plain in SQLite/Postgres. The Shepherd DB already holds SSH passwords plain — this is the same risk surface, not a new one. API responses redact `secret: true` fields to `"***"` before serialization.
- xray daemon on the target host is managed via systemd. Linux-only for 3a (Shepherd's only Phase 1 target; macOS hosts can run xray, but launchd integration ships in 3b alongside relay).

## 2. Architecture

### 2.1 Backend layout

```
internal/
  plugins/
    plugin.go           # Plugin interface, Meta, Deps, HostAware
    registry.go         # global Registry: Register / All / Get / Enabled
    deploy/
      pusher.go         # generic "push binary + write file + control systemd" helpers
                        # used by xray today, relay tomorrow
    xray/
      meta.go           # Meta() {ID, Name, Icon, Description}
      release.go        # GitHub release index + download with sha256
      deploy.go         # implements HostAware: DeployToHost / UndeployFromHost / HostStatus
      config.go         # builds xray config.json from a simplified-template request,
                        # OR passes raw JSON through after schema validation
      routes.go         # /api/admin/plugins/xray/* handlers
      migrations/
        0001_xray.up.sql
        0001_xray.down.sql
    cloudflare/
      meta.go
      api.go            # api.cloudflare.com client with token from plugins.config_json
      routes.go         # /api/admin/plugins/cloudflare/*
      # no migrations in 3a — zones are fetched on demand and cached in-process
  api/
    plugins.go          # /api/admin/plugins shared endpoints (list/manifest/enable/...)
  db/migrations/
    0003_plugins.up.sql # shared plugins + plugin_hosts tables
    0003_plugins.down.sql
```

### 2.2 The Plugin interface

```go
package plugins

type Meta struct {
    ID          string // stable identifier, used in URLs and DB
    Name        string
    Description string
    Icon        string // lucide icon name, surfaced to the frontend manifest
    Category    string // "proxy" | "dns" | "system" | ...
    HostAware   bool   // mirrors interface assertion below; UI uses this hint
}

type Migration struct {
    Name string
    SQL  string
}

type Deps struct {
    DB        *sqlx.DB
    Hub       *agentsvc.Hub        // for talking to live agents
    Audit     *audit.Logger
    DataDir   string               // e.g. data/plugins/<id>/
    Settings  *serversvc.SettingsStore
}

type Plugin interface {
    Meta() Meta
    Migrations() []Migration
    RegisterRoutes(r chi.Router, deps Deps)
    OnEnable(ctx context.Context, deps Deps) error
    OnDisable(ctx context.Context, deps Deps) error
}

// Optional capability for plugins that touch managed hosts.
type HostAware interface {
    Plugin
    DeployToHost(ctx context.Context, deps Deps, serverID int64, configJSON []byte) error
    UndeployFromHost(ctx context.Context, deps Deps, serverID int64) error
    HostStatus(ctx context.Context, deps Deps, serverID int64) (HostStatus, error)
}

type HostStatus struct {
    State       string // pending | deploying | running | failed | stopped
    Version     string
    Message     string // diagnostic line for the UI
    CheckedAt   time.Time
}
```

Plugins register themselves in their package `init()`:

```go
// internal/plugins/xray/xray.go
func init() { plugins.Register(&xrayPlugin{}) }
```

`cmd/server/main.go` imports `_ "github.com/hg-claw/Shepherd/internal/plugins/xray"` (and cloudflare) once, after which the global registry has them. The server then walks `plugins.All()` to run shared + per-plugin migrations, and mounts every plugin's routes once at boot. A middleware on each plugin subtree returns `404 plugin disabled` when the `plugins.enabled` flag is 0, so toggling enable/disable never needs a router rebuild (see §4.4).

### 2.3 Frontend layout

```
web/src/pages/admin/plugins/
  index.tsx            # plugin center: cards for every compiled plugin, enable/disable
  detail.tsx           # generic detail wrapper: header, tabs (Config / Hosts / About)
  PluginRegistry.ts    # static map: id -> { lazy(() => import('./xray')), labels, routes }
  xray/
    index.tsx          # default export = the xray plugin's React routes
    HostsTab.tsx
    ConfigTab.tsx
  cloudflare/
    index.tsx
    ZonesTab.tsx
    DnsTab.tsx
```

The shell calls `/api/admin/plugins` once and merges the response (enabled IDs + UI routes from the static registry) into the sidebar and React Router routes. Disabled plugins simply don't render their routes. The static registry is the single source of truth for plugin frontend code — there is no dynamic JS loading from the server.

## 3. Data model

### 3.1 Shared schema (`db/migrations/0003_plugins.up.sql`)

```sql
CREATE TABLE plugins (
  id          TEXT      PRIMARY KEY,
  enabled     INTEGER   NOT NULL DEFAULT 0,
  config_json TEXT      NOT NULL DEFAULT '{}',
  enabled_at  TIMESTAMP,
  created_at  TIMESTAMP NOT NULL
);

CREATE TABLE plugin_hosts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id        TEXT    NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  server_id        INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  config_json      TEXT    NOT NULL DEFAULT '{}',
  deployed_version TEXT,
  status           TEXT    NOT NULL DEFAULT 'pending', -- pending|deploying|running|failed|stopped
  last_error       TEXT,
  updated_at       TIMESTAMP NOT NULL,
  UNIQUE(plugin_id, server_id)
);
CREATE INDEX plugin_hosts_plugin ON plugin_hosts(plugin_id);

-- Tracks which per-plugin migrations have run. Each plugin owns a
-- namespace within this table keyed by plugin_id; migration names must
-- be unique per plugin.
CREATE TABLE plugin_migrations (
  plugin_id  TEXT      NOT NULL,
  name       TEXT      NOT NULL,
  applied_at TIMESTAMP NOT NULL,
  PRIMARY KEY (plugin_id, name)
);
```

### 3.2 xray per-plugin schema

```sql
CREATE TABLE xray_binaries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  version       TEXT    NOT NULL,
  os            TEXT    NOT NULL, -- linux
  arch          TEXT    NOT NULL, -- amd64 | arm64
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT    NOT NULL,
  path          TEXT    NOT NULL, -- absolute path under deps.DataDir/<id>/cache
  downloaded_at TIMESTAMP NOT NULL,
  UNIQUE(version, os, arch)
);
```

cloudflare currently does not need its own table; zones can be fetched on demand and cached in-process for the request. If a caching table proves necessary it lands as `cloudflare/migrations/0001_cf.up.sql` later.

### 3.3 Postgres dialect

A parallel `db/migrations/postgres/0003_plugins.up.sql` mirrors the schema with the project's existing translation conventions (`AUTOINCREMENT` → `BIGSERIAL`, `INTEGER NOT NULL DEFAULT 0` for booleans stays the same, `TIMESTAMP` → `TIMESTAMPTZ`). Same goes for per-plugin migrations.

## 4. Lifecycle

### 4.1 Enable / disable a plugin

`POST /api/admin/plugins/{id}/enable`:

1. Look up the plugin in the in-process registry. 404 if unknown.
2. Inside a transaction: if `plugins.id` row doesn't exist, insert it (`enabled=0`, empty config). If `enabled=1` already, return 200 (idempotent).
3. Run any unapplied per-plugin migrations using a `plugin_id`-scoped migration table (`plugin_migrations(plugin_id, name, applied_at)`).
4. Call `OnEnable(ctx, deps)`. If it returns an error: rollback enabling, write the error to the audit log, return 500.
5. Set `plugins.enabled=1`, `enabled_at=NOW()`. Audit `plugin.enabled` with `{plugin_id}`.
6. Reload the router (see §4.4).

`POST .../disable`:

1. Idempotent if already disabled.
2. If plugin is HostAware, for each row in `plugin_hosts` with `status IN (running, failed)`: call `UndeployFromHost` best-effort, log failures. Don't block disable on a host that's offline — set its status to `stopped` and record `last_error`.
3. Call `OnDisable(ctx, deps)`.
4. Set `plugins.enabled=0`, clear `enabled_at`. Audit `plugin.disabled`.
5. Reload the router.

### 4.2 Per-host deploy (HostAware plugins, xray today)

`POST /api/admin/plugins/xray/hosts` body:

```json
{ "server_id": 7, "version": "1.8.11", "config": { ... } }
```

1. Plugin enabled check — 400 if not.
2. Upsert `plugin_hosts(plugin_id="xray", server_id=7)` row with `status="deploying"`, `deployed_version=null`, `last_error=null`. Returns immediately with the row.
3. Kick off background goroutine bound to a context derived from the server lifecycle (not the request):
   a. Ensure binary cache entry for `(version, host.os, host.arch)`. If missing, download from
      `https://github.com/XTLS/Xray-core/releases/download/v{version}/Xray-{os}-{arch}.zip`,
      verify sha256 against the release's `dgst` sidecar, unzip into
      `data/plugins/xray/cache/{os}-{arch}/v{version}/xray`, insert row into `xray_binaries`.
   b. Render config.json from `config` (template or raw — see §5).
   c. Use `internal/plugins/deploy.Pusher`:
      - filehandler PUT binary → `/usr/local/bin/shepherd-xray` (mode 0755)
      - filehandler PUT config → `/etc/shepherd-xray/config.json` (mode 0600)
      - filehandler PUT systemd unit → `/etc/systemd/system/shepherd-xray.service`
      - PTY exec `systemctl daemon-reload && systemctl enable --now shepherd-xray`
   d. Probe `systemctl is-active shepherd-xray`. Set `status="running"` on `active`,
      `status="failed"` + `last_error` otherwise.
4. The HTTP caller polls `GET /api/admin/plugins/xray/hosts/{server_id}` for updates, or the
   Plugin Center frontend subscribes via the existing 30s react-query refetch.

Re-deploy / config-change is the same endpoint with `PUT`. After writing the new config:

```
systemctl reload shepherd-xray || systemctl restart shepherd-xray
```

xray does not support config reload via SIGHUP in all cases — the unit file sets `ExecReload` to a restart so `reload` is always semantically correct (even if it's actually a restart).

### 4.3 Plugin manifest endpoint

`GET /api/admin/plugins` returns:

```json
[
  {
    "id": "xray",
    "meta": {
      "name": "xray",
      "description": "Manage xray-core as a managed proxy on selected hosts.",
      "icon": "shield",
      "category": "proxy",
      "host_aware": true
    },
    "enabled": true,
    "enabled_at": "2026-05-16T10:11:12Z",
    "host_count": 4
  },
  {
    "id": "cloudflare",
    "meta": { "name": "Cloudflare", "icon": "cloud", "category": "dns", "host_aware": false },
    "enabled": false,
    "enabled_at": null,
    "host_count": null
  }
]
```

The frontend cross-references this with its static `PluginRegistry.ts` to know which lazy module to mount and which sidebar entries / routes to expose.

### 4.4 Router reload

The HTTP router is a `chi.Mux` constructed at startup. Plugin routes mount under `/api/admin/plugins/{id}/...` from the start (always reachable), but each plugin's handlers are wrapped in middleware that returns `404 plugin disabled` when the plugins.enabled flag is 0. No actual router rebuild needed. The frontend hides UI for disabled plugins so the 404 path is unreachable from the app.

## 5. xray plugin specifics

### 5.1 Binary distribution

- The plugin holds the release URL template as a constant. Operators don't configure the
  template per install.
- `GET /api/admin/plugins/xray/versions` returns the cached versions table plus an option to
  fetch the latest 10 release tags via `GET https://api.github.com/repos/XTLS/Xray-core/releases?per_page=10`.
- `POST /api/admin/plugins/xray/binaries` `{version, os, arch}` triggers a download to cache.
  Streamed to `data/plugins/xray/cache/{os}-{arch}/v{version}/xray.zip`, unzipped, sha256 verified
  against the official `Xray-{os}-{arch}.zip.dgst` file fetched alongside it. Sha256 mismatch deletes
  the cache and returns 500.
- On disable, cache is preserved; only `OnDisable` of cloudflare-style state is cleared.

### 5.2 Config UI

Two-tab editor on the per-host config page:

- **Template** (default) — admin picks an inbound preset (VLESS+REALITY / VMess+WS / Shadowsocks),
  fills in port, UUID, sni, etc. The server-side `config.go` `Render(template, fields) -> xrayConfig`
  returns the canonical JSON.
- **Raw** — plain `<textarea>` with monospaced font and a tab-to-spaces handler. Validation is
  server-side only: the plugin calls `xray run -test -confdir /tmp/<sid>` against a copy of the
  submitted JSON before persisting, and surfaces xray's own error text to the client. We don't
  bundle xray's schema — running xray's own validator is the source of truth and avoids drift.

UUID and password fields are `secret: true` — they round-trip from the server as `"***"` and the
admin must explicitly toggle "edit" to type a new value. On save the client only sends a non-`***`
value when the operator actually edited it.

### 5.3 systemd unit

Embedded in the binary at `internal/plugins/xray/unit.tmpl`:

```ini
[Unit]
Description=Shepherd-managed xray
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/shepherd-xray run -c /etc/shepherd-xray/config.json
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

## 6. cloudflare plugin specifics

### 6.1 Global config

`plugins.config_json` schema:

```json
{
  "api_token": "***",
  "account_id": "optional, for account-scoped operations"
}
```

`api_token` is `secret: true`.

### 6.2 Endpoints (all under `/api/admin/plugins/cloudflare/`)

- `GET /zones` — pass-through to `GET https://api.cloudflare.com/client/v4/zones?per_page=50`,
  cache for 60s per process.
- `GET /zones/{id}/records` — pass-through.
- `POST /zones/{id}/records` — body matches CF's create-record schema; pass-through.
- `PATCH /zones/{id}/records/{rid}` — pass-through.
- `DELETE /zones/{id}/records/{rid}` — pass-through.
- `GET /audit?since=...` — pulls the last N days of CF audit log entries (account scope).

All requests go server-side; the admin browser never receives the API token. Errors from CF map to
4xx/5xx on our side with the CF error code in the body.

### 6.3 UI tabs (in `pages/admin/plugins/cloudflare/`)

- **Setup**: API token form (only visible if not yet configured, or via edit).
- **Zones**: table of zones (name, plan, name servers).
- **DNS records**: zone selector + records table with inline add/edit/delete.
- **Activity**: recent audit log entries (admin-only context).

## 7. API surface summary

Shared:

```
GET    /api/admin/plugins                       # list with manifest
POST   /api/admin/plugins/{id}/enable
POST   /api/admin/plugins/{id}/disable
GET    /api/admin/plugins/{id}/config           # global config (secrets redacted)
PUT    /api/admin/plugins/{id}/config
GET    /api/admin/plugins/{id}/hosts            # HostAware only; 404 otherwise
POST   /api/admin/plugins/{id}/hosts            # deploy
PUT    /api/admin/plugins/{id}/hosts/{server_id}
DELETE /api/admin/plugins/{id}/hosts/{server_id}
GET    /api/admin/plugins/{id}/hosts/{server_id}
```

Per-plugin:

```
# xray
GET    /api/admin/plugins/xray/versions         # cached + latest 10 tags
POST   /api/admin/plugins/xray/binaries         # trigger download {version, os, arch}
GET    /api/admin/plugins/xray/binaries         # cache inventory

# cloudflare
GET    /api/admin/plugins/cloudflare/zones
GET    /api/admin/plugins/cloudflare/zones/{id}/records
POST   /api/admin/plugins/cloudflare/zones/{id}/records
PATCH  /api/admin/plugins/cloudflare/zones/{id}/records/{rid}
DELETE /api/admin/plugins/cloudflare/zones/{id}/records/{rid}
GET    /api/admin/plugins/cloudflare/audit
```

## 8. Error handling

- Enable / disable: failures rollback the DB row and return JSON `{error, code}`; the audit log
  always records the attempt.
- Deploy operations: HTTP returns 200 with the (deploying) row. Real status arrives via polling
  the host endpoint. Background goroutine writes `status=failed, last_error=…` for the UI to
  surface in red on the Hosts tab.
- xray binary download: sha256 mismatch is the only fatal case; transient network errors are
  returned to the client with `code: "download_failed"` and the client may retry.
- cloudflare passthrough: errors from CF API are wrapped:
  ```json
  { "error": "CF API: <code> <message>", "code": "cloudflare_api_error" }
  ```
- Plugin not enabled: 404 from anything under `/api/admin/plugins/{id}/...` except the shared
  `enable` / `config` endpoints.

## 9. Testing

- `internal/plugins`: unit tests for registry, lifecycle ordering, migration runner.
- `internal/plugins/xray/release_test.go`: GitHub release index parsing + sha256 verify using a
  small fixture.
- `internal/plugins/xray/deploy_test.go`: tests against a fake `Pusher` interface that records
  the operations. Verifies the systemd unit template renders correctly.
- `internal/plugins/cloudflare/api_test.go`: httptest server impersonating api.cloudflare.com,
  verifies token forwarding, redaction in responses, error mapping.
- `internal/api/plugins_test.go`: enable/disable/manifest end-to-end using two fake registered
  plugins (one HostAware, one not).
- Frontend: render tests for the plugin center index page (uses MSW to stub `/api/admin/plugins`).

No end-to-end real-xray test; that requires a Linux VM and an actual systemd. Manual smoke test
checklist lives in the implementation plan.

## 10. Open items deferred to later phases

- relay plugin (3b).
- xray on macOS via launchd (3b).
- Plugin metrics back into Shepherd telemetry (e.g. xray connection counts) — needs a plugin →
  telemetrysvc bridge.
- Plugin update notifications (new xray release detected).
- Multi-version coexistence on a single host (we only support one deployed version per host today).
- Sidecar / WASM model for third-party plugins (3c, if we ever go there).
