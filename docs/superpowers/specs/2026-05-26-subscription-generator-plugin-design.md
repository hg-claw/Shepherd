# Subscription Generator Plugin (`subgen`) — Design

**Status:** approved-pending-review
**Date:** 2026-05-26

## Goal

A pure-Go Shepherd plugin that aggregates the xray + sing-box inbounds
Shepherd already manages into **client subscription URLs**. Clients
(Surge, ShadowRocket in v1) poll a token URL and receive a ready-to-use
config with **category-based routing (分流)**. Architecture mirrors
[7Sageer/sublink-worker](https://github.com/7Sageer/sublink-worker): a
shared base builder produces a target-agnostic intermediate model, and a
per-format renderer serializes it. subconverter / sublink-worker are
reference implementations only — no external binary or service runs.

## Scope

**v1 ships:** Surge + ShadowRocket renderers; category routing with
built-in templates + custom rules; per-subscription node selection; a
public token subscription endpoint; admin CRUD UI.

**Deferred (architecture leaves room, not built now):** Clash.Meta,
sing-box client JSON, Quantumult X renderers; remote ruleset-URL
templates; per-inbound public-host override; emoji/rename pipelines.

**Non-goals:** running subconverter/sublink-worker; converting *inbound*
subscriptions from external sources (we only emit from managed inbounds).

## Architecture

```
selected inbounds (xray + singbox)
        │  xrayInboundToNode / singboxInboundToNode
        ▼
   []Node  ─────────────┐
                        ├─▶ Base.Assemble() ─▶ Intermediate{Nodes, Groups, Rules}
 template (categories,  ┘                          │
 custom rules, options) ───────────────────────────┘
                        ▼
              Renderer.Render(Intermediate) ─▶ config text
              (SurgeRenderer | ShadowRocketRenderer)
```

Go has no subclassing, so the "base + per-format builder" split is
expressed as: a `Base` that assembles a target-agnostic `Intermediate`,
plus a `Renderer` interface each format implements. This matches
subconverter's `Proxy`/`ProxyGroup`/`RulesetContent` → `proxyToX`
structure.

### Components / files (all under `internal/plugins/subgen/`)

- `subgen.go` — Plugin impl (`Meta`, `Migrations`, `RegisterRoutes`,
  `OnEnable` idempotently seeds built-in templates (insert-if-absent by
  `name` where `builtin=1`; never overwrites a user's edits), `OnDisable`
  no-op). Plain plugin, **not** HostAware. Category `"proxy"`.
- `node.go` — `Node` intermediate model + `xrayInboundToNode`,
  `singboxInboundToNode` mappers.
- `catalog.go` — embedded `UNIFIED_CATEGORIES` (name → geosite/geoip
  sources + default policy) and `PREDEFINED_TEMPLATES`
  (minimal/balanced/comprehensive).
- `template.go` — template schema (`rules_json`) + validation.
- `base.go` — `Base.Assemble(nodes, template) Intermediate` (builds
  proxy groups, country grouping, auto-select, rule list).
- `render.go` — `Renderer` interface + `supports(proto) bool`.
- `render_surge.go`, `render_shadowrocket.go` — the two v1 renderers.
- `store.go` — subscription + template CRUD over `deps.DB`.
- `service.go` — `Generate(ctx, token, target) (text, contentType, err)`;
  the public endpoint calls this.
- `routes.go` — admin CRUD handlers (`RegisterRoutes`).
- `migrations/{sqlite,postgres}/0001_subgen.up.sql`.

## Data model

```sql
-- one subscription = a node selection + a template, addressed by token
CREATE TABLE subgen_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  token       TEXT    NOT NULL UNIQUE,         -- high-entropy random
  template_id INTEGER NOT NULL REFERENCES subgen_templates(id) ON DELETE RESTRICT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMP NOT NULL,
  updated_at  TIMESTAMP NOT NULL
);

-- node-level selection; (source, inbound_id) points into the xray or
-- singbox inbound tables. No FK across plugins — resolved at generate
-- time, missing inbounds are skipped.
CREATE TABLE subgen_subscription_inbounds (
  subscription_id INTEGER NOT NULL REFERENCES subgen_subscriptions(id) ON DELETE CASCADE,
  source          TEXT    NOT NULL,            -- 'xray' | 'singbox'
  inbound_id      INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, source, inbound_id)
);

-- built-in templates are seeded read-only on OnEnable; custom rows are
-- user-created. rules_json holds the category selection + custom rules.
CREATE TABLE subgen_templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  builtin    INTEGER NOT NULL DEFAULT 0,
  rules_json TEXT    NOT NULL,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);
```

Postgres mirror uses `BIGSERIAL` / `BOOLEAN` / `TIMESTAMPTZ` per the
existing per-driver migration convention.

### `rules_json` schema

```json
{
  "categories": [
    {"name": "Ad Block",     "policy": "REJECT"},
    {"name": "Location:CN",  "policy": "DIRECT"},
    {"name": "Telegram",     "policy": "PROXY"},
    {"name": "Streaming",    "policy": "PROXY"}
  ],
  "custom_rules": [
    {"match": "IP-CIDR,10.0.0.0/24", "policy": "PROXY"}
  ],
  "final": "PROXY",
  "group_by_country": true,
  "include_auto_select": true
}
```

- Category `name` must exist in `UNIFIED_CATEGORIES`. `policy` ∈
  `{PROXY, DIRECT, REJECT, <named group>}` where `PROXY` is the main
  manual-select group.
- `custom_rules[].match` is a target-agnostic rule expressed as
  `TYPE,VALUE` (`IP-CIDR`, `DOMAIN-SUFFIX`, `DOMAIN`, `GEOIP`,
  `DOMAIN-KEYWORD`). The renderer maps each to the format's syntax.
  The motivating example `内网 10.0.0.0/24 走某节点` is a custom rule.
- `final` is the default outbound for unmatched traffic.

### `UNIFIED_CATEGORIES` (embedded catalog, ported from sublink-worker)

Each entry: `{Name, SiteRules []string (geosite), IPRules []string
(geoip), DefaultPolicy}`. Initial set: Ad Block (REJECT), AI Services,
Bilibili, Youtube, Google, Private (DIRECT), Location:CN (DIRECT),
Telegram, Github, Microsoft, Apple, Social Media, Streaming, Gaming,
Non-China. Predefined templates:
- `minimal`: Location:CN, Private, Non-China
- `balanced`: + Github, Google, Youtube, AI Services, Telegram
- `comprehensive`: all categories

## Node model + mappers

```go
type Node struct {
    Name      string // "{flag} {server_name} {protocol}" (deduped with -2, -3…)
    Protocol  string // vless | vmess | trojan | shadowsocks | hysteria2 | tuic | anytls
    Server    string // servers.ssh_host (skip node if empty)
    Port      int
    Country   string // servers.country_code (grouping + flag)
    UUID      string
    Password  string
    SNI       string
    Flow      string
    // TLS / REALITY
    RealityPublicKey string
    RealityShortID   string
    // transport
    Transport string // "", "ws", "h2", "httpupgrade"
    Path      string
    Host      string
    // shadowsocks
    SSMethod  string
    // raw protocol extras (hysteria2/tuic knobs) carried from ExtraJSON
    Extra     map[string]any
}
```

- `xrayInboundToNode`: maps xray.Inbound (`UUID, SNI, PublicKey,
  ShortID, WSPath, SSMethod, SSPassword`) + its server.
- `singboxInboundToNode`: maps singbox.Inbound (`UUID, Flow, Password,
  SNI, RealityPublicKey, RealityShortID, TransportPath, TransportHost,
  SSMethod, ExtraJSON`) + its server. Only `role="landing"` and
  `role="relay"` with `relay_mode="proxy"` produce client-connectable
  nodes; `forward` relays reuse the landing's params at the relay's
  IP:port (mapper handles this).
- Server lookup pulls `ssh_host` + `country_code` from the `servers`
  table. Node with empty `ssh_host` is skipped with a warning.

## Subscription endpoint (one core-router change)

`GET /sub/{token}?target=surge|shadowrocket` — **public** (proxy clients
have no admin cookie; the token is the secret). Plugins only receive the
gated admin mux, so this single public route is wired in the core router
(`internal/api/router.go`) alongside `/healthz` and `/agent/*`, backed by
a `subgen.Service` injected in `cmd/server`. Behavior:

- Unknown `target` → 400.
- Unknown / disabled / empty token → 404 (constant-time compare; no leak
  of which failed).
- Valid → render via `Service.Generate`, return the format's content type
  (`text/plain; charset=utf-8`) with the node count in a header.
- Basic per-IP rate limit reusing the existing public rate-limit helper.

All **admin CRUD** stays on the gated admin mux via the plugin's
`RegisterRoutes`.

## Admin API (gated, plugin-owned)

- `GET/POST /api/admin/plugins/subgen/subscriptions`,
  `PATCH/DELETE …/subscriptions/{id}`,
  `POST …/subscriptions/{id}/rotate-token`.
- `GET/POST …/templates`, `PATCH/DELETE …/templates/{id}` (builtin rows
  reject PATCH/DELETE; clone via POST).
- `GET …/categories` — the `UNIFIED_CATEGORIES` catalog for the UI.
- `GET …/subscriptions/{id}/preview?target=surge` — admin-side render
  preview.

## Frontend

Register `subgen` in `web/src/pages/admin/plugins/PluginRegistry.ts` with
two tabs:

- **Subscriptions**: table of subscriptions; create/edit dialog (name,
  node picker grouped by server with xray/singbox inbounds as
  checkboxes, template dropdown); per-row subscription URL with copy +
  `surge`/`shadowrocket` target buttons; rotate-token action.
- **Templates**: list (built-in read-only + clonable, custom editable);
  editor = category checklist with a per-category policy dropdown
  (PROXY/DIRECT/REJECT/group), custom-rules textarea (`TYPE,VALUE,policy`
  per line), and toggles for `group_by_country` / `include_auto_select`
  + a `final` dropdown.

## Protocol × format coverage (v1)

| protocol     | Surge | ShadowRocket |
|--------------|-------|--------------|
| shadowsocks  | ✓     | ✓            |
| vmess        | ✓     | ✓            |
| trojan       | ✓     | ✓            |
| vless/reality| best-effort (Surge 5+) | ✓ |
| hysteria2    | ✓     | ✓            |
| tuic (v5)    | ✓     | ✓            |
| anytls       | ✗     | ✗            |

Each renderer exposes `supports(protocol) bool`. Unsupported nodes are
omitted from that target's output and listed in a `#` comment header
(e.g. `# skipped 2 anytls node(s): not supported by surge`). Generation
never hard-fails on an unsupported protocol.

## Error handling

- No inbounds selected / all skipped → valid config with only DIRECT +
  a comment; never a 500.
- Server missing `ssh_host` → skip that node, note in header comment.
- Malformed `rules_json` on a custom template → rejected at save time
  (validation in `template.go`), so generation always sees valid input.
- Unknown category name in a template → rejected at save time.

## Testing

- `node_test.go` — table-driven xray/singbox inbound → Node, incl.
  forward-relay reuse and ss/reality/transport field mapping.
- `catalog_test.go` — predefined templates reference only known
  categories; default policies correct.
- `template_test.go` — `rules_json` validation (good/bad cases).
- `render_surge_test.go`, `render_shadowrocket_test.go` — golden-file
  output per protocol + groups + rules + the skip-unsupported path.
- `service_test.go` — Generate dispatch by target, unknown target,
  unknown/disabled token.
- `routes_test.go` — admin CRUD incl. builtin-template immutability +
  token rotation.
- Public endpoint test in `internal/api` — token auth (valid / invalid /
  disabled), content type, 400 on bad target.

## Implementation phasing (within v1)

1. Migrations + store + Node model + mappers (+ tests)
2. Catalog + template schema/validation + Base.Assemble (+ tests)
3. Surge renderer + ShadowRocket renderer (golden tests)
4. service.Generate + public `/sub/{token}` route wiring + admin CRUD
5. Frontend Subscriptions + Templates tabs
6. End-to-end smoke + docs
