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
- `catalog.go` — embedded `UNIFIED_CATEGORIES` (name → blackmatrix7
  ruleset folder(s) or a native directive + default policy) and
  `PREDEFINED_TEMPLATES` (minimal/balanced/comprehensive). Resolves a
  category + target format + `ruleset_base` into the `RULE-SET` URL line.
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

### Routing = remote `RULE-SET` references (not inlined rules)

Categories are emitted as **remote rule-set subscriptions**, not baked-in
domain/IP lists. For each selected category the renderer writes one line
referencing a GitHub-hosted `.list` so the client fetches and
auto-updates the rules itself, e.g. (Surge / ShadowRocket):

```
RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Telegram/Telegram.list,🚀 Proxy
```

This is the whole point of the design: Shepherd ships node membership +
policy mapping; the heavy, frequently-changing rule data lives on GitHub
and the client subscribes to it directly. Shepherd never has to maintain
or update domain lists.

**Rule-set source:** [blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script)
(`rule/Surge/<Name>/<Name>.list`; ShadowRocket consumes the Surge
format). The base URL is a plugin setting `subgen_ruleset_base`
(default `https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master`).
Mainland-China deployments can point it at a CDN/mirror
(`https://cdn.jsdelivr.net/gh/blackmatrix7/ios_rule_script@master` or a
gh-proxy mirror) — same motivation as the v0.9.0 CN-mirror work.

Categories backed by a directive the client resolves natively (CN by
geoip, LAN/private) emit that directive instead of a remote set
(`GEOIP,CN,DIRECT`, `RULE-SET,SYSTEM,DIRECT` / `IP-CIDR,10.0.0.0/8` etc.),
so they cost no extra fetch.

### `UNIFIED_CATEGORIES` (embedded catalog)

Each entry: `{Name, Ruleset string (blackmatrix7 folder, e.g. "Telegram"),
Native string (a built-in directive when no remote set is needed, e.g.
"GEOIP,CN"), DefaultPolicy}`. A category sets either `Ruleset` (→
`RULE-SET,<base>/rule/<format>/<Ruleset>/<Ruleset>.list,<policy>`) or
`Native`. Initial set:

| Category      | Ruleset / Native            | Default policy |
|---------------|-----------------------------|----------------|
| Ad Block      | AdvertisingLite             | REJECT         |
| AI Services   | OpenAI                      | PROXY          |
| Telegram      | Telegram                    | PROXY          |
| Google        | Google                      | PROXY          |
| Youtube       | YouTube                     | PROXY          |
| Github        | GitHub                      | PROXY          |
| Microsoft     | Microsoft                   | PROXY          |
| Apple         | Apple                       | PROXY          |
| Streaming     | Netflix, Disney, HBO…       | PROXY          |
| Social Media  | Facebook, Twitter, TikTok…  | PROXY          |
| Location:CN   | `GEOIP,CN` (native)         | DIRECT         |
| Private/LAN   | `RULE-SET,SYSTEM` (native)  | DIRECT         |

(A category may carry multiple rulesets; the renderer emits one
`RULE-SET` line per ruleset, all pointing at the same policy.)

Predefined templates:
- `minimal`: Location:CN, Private, Ad Block
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
- `GET …/categories` — the `UNIFIED_CATEGORIES` catalog (incl. each
  category's resolved rule-set URL) for the UI.
- `GET …/subscriptions/{id}/preview?target=surge` — admin-side render
  preview.
- `ruleset_base` is stored in the plugin's `config_json` and edited via
  the generic `GET/PUT /api/admin/plugins/subgen/config`. `Service`
  reads it (falling back to the GitHub-raw default) when resolving
  `RULE-SET` URLs.

## Frontend

Register `subgen` in `web/src/pages/admin/plugins/PluginRegistry.ts` with
two tabs:

- **Subscriptions**: table of subscriptions; create/edit dialog (name,
  node picker grouped by server with xray/singbox inbounds as
  checkboxes, template dropdown); per-row subscription URL with copy +
  `surge`/`shadowrocket` target buttons; rotate-token action.
- **Templates**: list (built-in read-only + clonable, custom editable);
  editor = category checklist with a per-category policy dropdown
  (PROXY/DIRECT/REJECT/group); each checked category shows its resolved
  GitHub rule-set URL(s) (read-only, so the operator sees exactly what the
  client will subscribe to). Plus a custom-rules textarea
  (`TYPE,VALUE,policy` per line), toggles for `group_by_country` /
  `include_auto_select`, and a `final` dropdown.
- **Rule-set base** field (plugin config): edits `ruleset_base`; a
  "use jsDelivr CDN (CN)" preset button fills the mirror URL.

## Protocol × format coverage (v1)

| protocol     | Surge | ShadowRocket |
|--------------|-------|--------------|
| shadowsocks  | ✓     | ✓            |
| vmess        | ✓     | ✓            |
| trojan       | ✓     | ✓            |
| vless/reality| ✓     | ✓            |
| hysteria2    | ✓     | ✓            |
| tuic (v5)    | ✓     | ✓            |
| anytls       | ✓     | ✓            |

Both targets cover all of Shepherd's protocols in v1. The
`supports(protocol) bool` hook is kept anyway so a future format (or a
protocol a client later drops) degrades gracefully: unsupported nodes are
omitted from that target's output and listed in a `#` comment header
(e.g. `# skipped 1 node(s): proto not supported by <target>`). Generation
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
  categories; default policies correct; category → `RULE-SET` URL
  resolution honours `ruleset_base` (default + mirror).
- `template_test.go` — `rules_json` validation (good/bad cases).
- `render_surge_test.go`, `render_shadowrocket_test.go` — golden-file
  output per protocol (incl. anytls) + groups + `RULE-SET` rule lines
  pointing at the resolved GitHub URLs + native directives + the
  skip-unsupported path.
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
