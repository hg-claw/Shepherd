# Subgen: Clash Output + Cross-Format Model + Usage Doc — Design

**Date:** 2026-05-26
**Plugin:** `internal/plugins/subgen`
**Status:** Approved design, ready for implementation plan

## Goal

Add a third subscription output target, **Clash.Meta (mihomo) YAML**, alongside
Surge and ShadowRocket. To make this clean, refactor the renderer model so the
shared `Assemble` produces a **semantic** intermediate (not pre-baked
Surge-format strings) and each renderer formats for its own target. Handle
cross-format differences explicitly: Surge-only `[General]`/`[MITM]` stay
Surge-only; Clash gets its own optional YAML preamble. Ship a user-facing usage
guide at `docs/subgen.md`.

## Background — current state

- `Assemble` (`base.go`) bakes **Surge-format rule strings** into
  `Intermediate.Rules []string` via `ResolveRuleLines(c.Name, c.Name, "surge", base)`
  → e.g. `RULE-SET,<surge-url>,Telegram`, `GEOIP,CN,Location:CN`, `FINAL,PROXY`.
- `rulesetDir(target)` (`catalog.go`) returns `("Surge","list")` for every target.
- `Intermediate.Groups []Group{Name,Type,Members}` is already semantic.
- `SurgeRenderer.Render(im, subURL) string` formats `.conf`; `ShadowRocketRenderer`
  embeds it. `rendererFor(target)` maps `surge`/`shadowrocket`; everything else →
  `ErrBadTarget`. `"clash"` is currently used in tests as the canonical *invalid*
  target.
- `TemplateSpec` has `General`/`MITM` (Surge free text). No YAML dependency in
  `go.mod`.

**Gap:** Clash uses YAML, routes rule-sets through a `rule-providers` section,
uses `MATCH` (not `FINAL`) for the catch-all, and has no `[MITM]`. Pre-baked
Surge strings cannot produce it.

## Requirements (decisions made during brainstorming)

1. **Architecture A — semantic intermediate.** `Assemble` emits semantic rules;
   each renderer formats them per target. (Not: Clash bypassing Assemble; not:
   re-parsing Surge strings.)
2. **Clash YAML via `gopkg.in/yaml.v3`** (new dependency) — safe escaping of
   emoji group/proxy names; no hand-rolled YAML.
3. **Per-format free text.** `general`/`mitm` apply only to surge/shadowrocket.
   Add `clash_general` (raw YAML top-level keys) for Clash. When `clash_general`
   is empty, the default preamble is `{mode: rule}` only.
4. **Clash rule-providers** use `behavior: classical` (blackmatrix7 Clash lists
   mix domain/IP), `format: yaml`, `type: http`.
5. **Target = Clash.Meta / mihomo** (supports all 7 protocols we emit).

## Data model

`TemplateSpec` (`template.go`) — add one field:

```go
ClashGeneral string `json:"clash_general,omitempty"` // raw YAML top-level keys for Clash; empty → {mode: rule}
```

`ParseTemplate` gains validation: if `ClashGeneral` is non-empty, it must parse
as YAML into a `map[string]any`, else return an error like
`bad clash_general: <yaml error>`. (`general`/`mitm` remain unvalidated free
text — they have no parser.)

`Intermediate` (`base.go`) — `Rules` becomes semantic, and the Clash preamble
rides along:

```go
type Rule struct {
	// Exactly one shape is set:
	Ruleset string // remote rule-set folder name (a category may expand to several)
	Native  string // built-in matcher, e.g. "GEOIP,CN" or "RULE-SET,SYSTEM"
	Match   string // custom rule body, e.g. "DOMAIN-SUFFIX,example.com"
	Final   bool   // catch-all (Surge: FINAL / Clash: MATCH)
	Target  string // policy or group name
}

type Intermediate struct {
	Nodes        []Node
	Groups       []Group
	Rules        []Rule
	General      string // Surge [General] body
	MITM         string // Surge [MITM] body
	ClashGeneral string // Clash YAML preamble
}
```

Note: `Native: "RULE-SET,SYSTEM"` is the `Private` category's directive. In Clash
there is no `SYSTEM` rule-set; the Clash renderer maps the `Private` category to
the equivalent classical matchers (see Clash renderer §"Native"). Surge keeps
emitting `RULE-SET,SYSTEM,<target>` verbatim.

## Assemble (base.go) — build semantic rules

Group construction is unchanged (PROXY first, optional Auto Select, one `select`
group per category with deduped members). Only rule construction changes — and it
no longer takes a baked-string detour:

```go
im := Intermediate{Nodes: nodes, General: spec.General, MITM: spec.MITM, ClashGeneral: spec.ClashGeneral}
// ... groups unchanged ...

for _, r := range spec.CustomRules {
	im.Rules = append(im.Rules, Rule{Match: r.Match, Target: r.Policy})
}
for _, c := range spec.Categories {
	cat, _ := categoryByName(c.Name)        // catalog lookup
	if cat.Native != "" {
		im.Rules = append(im.Rules, Rule{Native: cat.Native, Target: c.Name})
	} else {
		for _, folder := range cat.Rulesets {
			im.Rules = append(im.Rules, Rule{Ruleset: folder, Target: c.Name})
		}
	}
}
im.Rules = append(im.Rules, Rule{Final: true, Target: spec.Final})
```

`target`/`rulesetBase` are no longer needed by `Assemble` for rule formatting
(renderers resolve URLs), so `Assemble`'s signature drops them:
`Assemble(nodes []Node, spec TemplateSpec) Intermediate`. The `rulesetBase` and
`target` move to the renderers (passed via `Render`). See §"Renderer interface".

## catalog.go — per-target ruleset URLs

```go
// rulesetDir maps a target to the blackmatrix7 directory + file extension.
func rulesetDir(target string) (dir, ext string) {
	if target == "clash" {
		return "Clash", "yaml"
	}
	return "Surge", "list" // surge + shadowrocket
}

// rulesetURL builds the blackmatrix7 raw URL for one folder + target.
func rulesetURL(folder, target, base string) string {
	dir, ext := rulesetDir(target)
	base = strings.TrimRight(base, "/")
	return base + "/rule/" + dir + "/" + folder + "/" + folder + "." + ext
}
```

`rulesetURL` becomes the shared primitive. `ResolveRuleLines(category, policy,
target, base)` is **kept** (its remote branch reimplemented to call `rulesetURL`,
behavior identical) because the `/categories` admin endpoint (`listCategories`
in `routes.go`) still uses it to surface display rule lines to the editor — that
endpoint and its test are unchanged. `Assemble` no longer calls it (it emits
semantic rules); the renderers call `rulesetURL` directly. `DefaultRulesetBase`
is unchanged.

## Renderer interface (render.go)

`Render` needs the ruleset base and (for URL building) the target. Update the
interface so renderers receive what they need:

```go
type Renderer interface {
	Target() string
	Supports(protocol string) bool
	Render(im Intermediate, subURL, rulesetBase string) string
}

func rendererFor(target string) (Renderer, bool) {
	switch target {
	case "surge":
		return &SurgeRenderer{}, true
	case "shadowrocket":
		return &ShadowRocketRenderer{}, true
	case "clash":
		return &ClashRenderer{}, true
	}
	return nil, false
}
```

Each renderer knows its own target string for `rulesetURL` (Surge uses
`"surge"`, Clash uses `"clash"`). `service.go` passes `s.base()` as
`rulesetBase` to `Render`.

## Surge renderer (render_surge.go) — same output, semantic input

`Render` now consumes `[]Rule` and reconstructs the existing `.conf` exactly:

- `Ruleset` → `RULE-SET,<rulesetURL(folder,"surge",base)>,<Target>`
- `Native`  → `<Native>,<Target>`  (e.g. `GEOIP,CN,Location:CN`, `RULE-SET,SYSTEM,Private`)
- `Match`   → `<Match>,<Target>`
- `Final`   → `FINAL,<Target>`

`[General]` (from `im.General` or default `bypass-system = true`) and `[MITM]`
(from `im.MITM`, omitted when empty) and the `groupLine` DIRECT-dedup behavior
are all unchanged. ShadowRocket still just overrides `Target()`. Existing Surge
tests must still pass byte-for-byte.

## Clash renderer (render_clash.go — new)

`type ClashRenderer struct{}`, `Target() string { return "clash" }`,
`Supports` returns true for the same 7 protocols Surge supports.

`Render` builds a `map[string]any` and marshals it with `yaml.v3`:

1. **Preamble base.** If `im.ClashGeneral` is non-empty, `yaml.Unmarshal` it into
   `map[string]any` (already validated at parse time; on the off chance it fails
   here, fall back to the default). Else start from `map[string]any{"mode": "rule"}`.
2. **`proxies`** — `[]map[string]any`, one per supported node (skip unsupported;
   no node is unsupported today). Protocol → mihomo mapping:

   | Node.Protocol | mihomo `type` | Key fields |
   |---|---|---|
   | shadowsocks | `ss` | `cipher: SSMethod`, `password` |
   | vmess | `vmess` | `uuid`, `alterId: 0`, `cipher: auto`; if `SNI`: `tls: true`, `servername: SNI` (+`skip-cert-verify: true` if `Insecure`); if `Transport=="ws"`: `network: ws`, `ws-opts: {path: Path, headers: {Host: Host}}` (Host header omitted if empty) |
   | trojan | `trojan` | `password`, `sni: SNI`; `skip-cert-verify: true` if `Insecure`; ws-opts as above if `Transport=="ws"` |
   | vless | `vless` | `uuid`, `tls: true`, `servername: SNI`; `flow: Flow` if set; if `RealityPublicKey`: `reality-opts: {public-key, short-id}`, `client-fingerprint: chrome`; `skip-cert-verify: true` if `Insecure`; ws-opts if `Transport=="ws"` |
   | hysteria2 | `hysteria2` | `password`, `sni: SNI`; `skip-cert-verify: true` if `Insecure` |
   | tuic | `tuic` | `uuid`, `password`, `sni: SNI`; `congestion-controller: <Extra["congestion_control"]>` if present |
   | anytls | `anytls` | `password`, `sni: SNI`; `skip-cert-verify: true` if `Insecure` |

   All include `name`, `server`, `port`. Transports other than `ws` are emitted
   without a `network` key (matching Surge's v1 transport scope).
3. **`proxy-groups`** — from `im.Groups`. `select` → `{name, type: select,
   proxies: Members}`; `url-test` → `{name, type: url-test, proxies: Members,
   url: "http://www.gstatic.com/generate_204", interval: 300}`. `DIRECT`/`REJECT`
   are mihomo built-ins and valid members. (The Surge `groupLine` DIRECT-append
   is Surge-specific; Clash uses members as-is from `Assemble`, which already
   includes DIRECT in category groups.)
4. **`rule-providers`** — `map[string]any`, one entry per distinct `Rule.Ruleset`
   (dedup by folder name):
   ```yaml
   <folder>:
     type: http
     behavior: classical
     format: yaml
     url: <rulesetURL(folder,"clash",base)>
     path: ./ruleset/<folder>.yaml
     interval: 86400
   ```
5. **`rules`** — `[]string`, in `im.Rules` order:
   - `Ruleset` → `RULE-SET,<folder>,<Target>`
   - `Native`  → Clash equivalent: `GEOIP,CN` → `GEOIP,CN,<Target>`; the `Private`
     category's `RULE-SET,SYSTEM` has no Clash analogue, so map it to
     `GEOIP,PRIVATE,<Target>` (mihomo recognizes the `PRIVATE` GeoIP group for
     LAN/loopback). Implement as a small `nativeToClash(native)` switch keyed on
     the catalog `Native` value.
   - `Match`   → `<Match>,<Target>`
   - `Final`   → `MATCH,<Target>`
6. Assign `proxies`, `proxy-groups`, `rule-providers` (omit the key if empty),
   `rules` into the base map; `yaml.Marshal`. Key order is yaml.v3's sorted
   default — acceptable (Clash is order-insensitive across top-level keys).

`subURL` is unused by Clash (no managed-config header); that's fine.

## service.go

`Generate` and `PreviewTemplate` call `Assemble(nodes, spec)` (new signature)
then `r.Render(im, subURL, s.base())`. `sampleNodes()` is unchanged (the two
sample nodes populate Clash proxies/groups too). No content-type change — all
targets return `text/plain; charset=utf-8`.

## Target wiring (frontend + API)

- **API:** no change needed — `rendererFor` now accepts `clash`, so the public
  `/sub/{token}` and admin preview endpoints validate it automatically.
- **`web/src/api/subgen.ts`:** the `previewSubgenTemplate` target param is a
  string already; no type change.
- **`SubscriptionsTab.tsx`:** `type Target = 'surge' | 'shadowrocket' | 'clash'`;
  add `<option value="clash">clash</option>` to the per-row target select.
- **`TemplatesTab.tsx`:** `PreviewTarget` adds `'clash'`; add the preview
  `<option value="clash">clash</option>`. Add a `clash_general` field to the form
  (`RulesModel.clash_general: string`, parse/serialize, a `[Clash] general`
  textarea — placeholder e.g. `mode: rule`), parallel to the `[General]`/`[MITM]`
  textareas. Raw-JSON mode + preview already handle arbitrary fields.

## Tests

- **`catalog_test.go`:** keep the existing `TestResolveRuleLines_RemoteAndNative`
  (still passes — surge behavior unchanged); add a `rulesetURL` test:
  `("Telegram","surge",base)` → `.../rule/Surge/Telegram/Telegram.list`;
  `("Telegram","clash",base)` → `.../rule/Clash/Telegram/Telegram.yaml`.
  `listCategories`/`TestRoutes_Categories` are unchanged.
- **`base_test.go`:** `Assemble` now returns semantic `[]Rule`; update assertions
  to check `Rule{Ruleset:"Telegram", Target:"Telegram"}`, `Rule{Native:"GEOIP,CN",
  Target:"Location:CN"}`, custom `Rule{Match:..., Target:...}` first, `Rule{Final:true,
  Target:"PROXY"}` last. Update the `Assemble(nodes, spec)` call (dropped args).
- **`render_surge_test.go`:** update fixtures to pass `[]Rule` and the new
  `Render(im, subURL, base)` signature; assert the *same* `.conf` substrings as
  before (regression: Surge output unchanged), including `FINAL,PROXY` and a
  `RULE-SET,<surge-url>,Telegram` line built from a `Rule{Ruleset:"Telegram"}`.
- **`render_clash_test.go` (new):** render an `Intermediate` with mixed
  protocols + a ruleset rule + a native CN rule + custom + final, then
  `yaml.Unmarshal` the output and assert: it parses; `proxies` has the expected
  types; `proxy-groups` includes `PROXY` and a category `select`; `rule-providers`
  has the folder with `behavior: classical`/clash URL; `rules` contains
  `RULE-SET,Telegram,Telegram`, `GEOIP,CN,Location:CN`, and ends with
  `MATCH,PROXY` (not `FINAL`); `clash_general` preamble injected when set vs
  default `mode: rule` when empty; an emoji-named group round-trips.
- **`template_test.go`:** `ParseTemplate` accepts valid `clash_general` YAML and
  rejects invalid YAML.
- **`service_test.go` / `routes_test.go`:** replace the `"clash"` *invalid*-target
  cases with a still-invalid target (`"quantumultx"`); add a `target=clash`
  success case to the preview/generate tests.
- FE `tsc` + `vitest` stay green after adding the `clash` option + `clash_general`
  field.

## Documentation — `docs/subgen.md` (usage guide)

User-facing. Sections:
1. **Overview** — what subgen does (client subscription URLs with category routing).
2. **Subscriptions** — create one, the public URL `/sub/<token>?target=…`, token
   rotation, picking inbound nodes, enable/disable.
3. **Output formats** — `surge`, `shadowrocket`, `clash`; which clients; how to
   switch the `target` query param.
4. **Templates** — categories → switchable proxy groups (policy = default member),
   custom rules (`TYPE,VALUE,policy`), `final`, auto-select; Form vs Raw JSON +
   live preview.
5. **Per-format sections** — `[General]`/`[MITM]` (Surge/ShadowRocket only, raw
   Surge directives, with examples) and `clash_general` (Clash YAML top-level
   keys, e.g. `dns:`/`mode:`, with an example). Note MITM has no Clash equivalent.
6. **Routing categories** — the unified category list and that each ships
   blackmatrix7 GitHub rule-set addresses (Surge `.list` vs Clash `.yaml`).
7. **Example** — a small end-to-end template + the rendered Surge and Clash output.

## Compatibility / migration

- New `clash_general` field is optional; legacy `rules_json` parses unchanged.
- The semantic-`Intermediate` change is internal; **Surge/ShadowRocket output is
  byte-for-byte unchanged** (guarded by regression assertions).
- New dependency `gopkg.in/yaml.v3` added to `go.mod`/`go.sum`.
- No DB migration.

## Out of scope (deferred)

- Quantumult X, sing-box client, or other targets.
- Clash `rule-providers` behaviors beyond `classical`; `proxy-providers`.
- grpc/h2/httpupgrade transport specifics (Clash emits base proxy, matching
  Surge's current v1 transport scope).
- Auto-translating Surge `[General]` keys into Clash (explicitly rejected — Clash
  uses its own `clash_general`).
- Seeding non-empty default `[General]`/`[MITM]`/`clash_general` into built-ins.
