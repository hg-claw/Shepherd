# Subgen Template: [General]/[MITM] Sections + Rule-Derived Proxy Groups — Design

**Date:** 2026-05-26
**Plugin:** `internal/plugins/subgen`
**Status:** Approved design, ready for implementation plan

## Goal

Let a subgen template (1) carry free-text `[General]` and `[MITM]` sections that
pass through verbatim into the rendered Surge/ShadowRocket config, and (2)
generate one switchable `select` proxy group per selected rule category so the
client can re-route any category on the fly. Remove the per-country grouping
feature.

## Background — current state

- **`TemplateSpec`** (`template.go`) carries: `categories []CategorySel`,
  `custom_rules []CustomRule`, `final string`, `group_by_country bool`,
  `include_auto_select bool`.
- **`Assemble`** (`base.go`) builds the target-agnostic `Intermediate`:
  - `PROXY` (select, prepended first), `Auto Select` (url-test, if
    `IncludeAutoSelect`), one url-test group per country (if `GroupByCountry`).
  - Rules = custom first, then per-category `ResolveRuleLines(...)`, then
    `FINAL,<final>`.
- **`ResolveRuleLines(category, policy, target, base)`** (`catalog.go`) returns
  the rule line(s) with `policy` baked into the last field — e.g.
  `RULE-SET,<base>/rule/Surge/Telegram/Telegram.list,PROXY` or, for native
  categories, `GEOIP,CN,DIRECT` / `RULE-SET,SYSTEM,DIRECT`.
- **`SurgeRenderer.Render`** (`render_surge.go`) emits a hardcoded
  `[General]\nbypass-system = true`, computed `[Proxy]` / `[Proxy Group]` /
  `[Rule]`, and **no `[MITM]`**. `ShadowRocketRenderer` embeds `SurgeRenderer`
  and only overrides `Target()`.
- **Categories** (`catalog.go`, `UnifiedCategories`): 12 named categories, each
  with `Rulesets` (remote) or `Native` directive, and a `DefaultPolicy`.

**Gaps the user hit:** templates can't touch `[General]`, have no `[MITM]`, and
a category's policy is baked into the rule (not client-switchable).

## Requirements (decisions made during brainstorming)

1. `[General]` and `[MITM]` are **free-text** blocks stored on the template and
   emitted verbatim. (Not structured fields, not a full INI template.)
2. **Every** selected category generates a switchable `select` group; the rule
   for that category points at the group, not at a baked policy.
3. Each generated group's members = `<configured policy>` (default selection,
   first) + `PROXY` + `DIRECT` + `REJECT` + **all node names**, de-duplicated.
   No `Auto Select`, no country groups in the member list.
4. **Remove the per-country grouping feature entirely**: delete the
   `group_by_country` field, its UI toggle, and the country-group generation.
5. `PROXY` group is always emitted **first** in `[Proxy Group]`.
6. **Custom rules keep their explicit policy** and do **not** generate a group.

## Data model

`TemplateSpec` (`template.go`):

```go
type TemplateSpec struct {
	Categories        []CategorySel `json:"categories"`
	CustomRules       []CustomRule  `json:"custom_rules"`
	Final             string        `json:"final"`
	IncludeAutoSelect bool          `json:"include_auto_select"`
	General           string        `json:"general,omitempty"` // raw [General] body
	MITM              string        `json:"mitm,omitempty"`     // raw [MITM] body
	// REMOVED: GroupByCountry bool `json:"group_by_country"`
}
```

- `General`/`MITM` are opaque text (one or more lines). `ParseTemplate` does
  **not** validate their contents — Surge's directive surface is too large to
  mirror. They are stored and emitted as-is.
- Removing `GroupByCountry` from the struct means any legacy `rules_json` that
  still contains `"group_by_country": true` simply has that key ignored by
  `json.Unmarshal`. No DB migration, no parse error.

## Proxy-group generation (Assemble)

New `Assemble(nodes, spec, target, rulesetBase)` behavior:

1. Collect `allNames` = every node's `Name`, in node order.
2. Build the main groups, in this order:
   - `PROXY` = `select`, members = `[Auto Select?] + allNames`. (The renderer's
     `groupLine` already appends `DIRECT` as the conventional fallback.)
     **Prepended first.**
   - `Auto Select` = `url-test`, members = `allNames` — only if
     `IncludeAutoSelect`.
   - **No country groups.**
3. For **each** `c` in `spec.Categories`, append a category group:
   - Name = `c.Name`.
   - Type = `select`.
   - Members = `dedupe([c.Policy, "PROXY", "DIRECT", "REJECT"] + allNames)`.
     `c.Policy` is first → it is the default selection. Dedupe keeps first
     occurrence (so if `c.Policy == "PROXY"`, `PROXY` is not repeated).
   - Category groups come **after** `PROXY`/`Auto Select`.
4. Rules, in this order:
   - Custom rules verbatim: `r.Match + "," + r.Policy` (unchanged — explicit
     policy, no group).
   - Per category, route the rule to the **group name** instead of the policy:
     call `ResolveRuleLines(c.Name, c.Name, target, rulesetBase)`. Passing the
     category name as the `policy` argument makes the last field the group name
     for both remote (`RULE-SET,<url>,Telegram`) and native
     (`GEOIP,CN,Location:CN`) categories. `ResolveRuleLines`'s signature is
     unchanged.
   - `FINAL,<spec.Final>`.

**Worked example** — category `Telegram` (policy `PROXY`), `Location:CN`
(policy `DIRECT`), `Ad Block` (policy `REJECT`), two nodes `🇺🇸 us`, `🇭🇰 hk`,
`include_auto_select` on:

```
[Proxy Group]
PROXY = select, Auto Select, 🇺🇸 us, 🇭🇰 hk, DIRECT
Auto Select = url-test, 🇺🇸 us, 🇭🇰 hk, url=…, interval=300
Telegram = select, PROXY, DIRECT, REJECT, 🇺🇸 us, 🇭🇰 hk
Location:CN = select, DIRECT, PROXY, REJECT, 🇺🇸 us, 🇭🇰 hk
Ad Block = select, REJECT, PROXY, DIRECT, 🇺🇸 us, 🇭🇰 hk
[Rule]
RULE-SET,…/Telegram/Telegram.list,Telegram
GEOIP,CN,Location:CN
RULE-SET,…/AdvertisingLite/AdvertisingLite.list,Ad Block
FINAL,PROXY
```

Node names still carry the country-flag emoji (that is node *naming*, untouched
by removing country *groups*).

## Renderer changes (Surge → inherited by ShadowRocket)

`SurgeRenderer.Render` section order and rules:

```
#!MANAGED-CONFIG <subURL> interval=43200 strict=false

# (skipped-node comment, if any — unchanged)

[General]
<spec.General, trimmed>          ← if non-empty
bypass-system = true             ← fallback when spec.General is empty

[Proxy]
DIRECT = direct
<supported node lines>           ← unchanged

[Proxy Group]
<groupLine for each im.Group>     ← PROXY first, then Auto Select, then categories

[Rule]
<each im.Rule>

[MITM]
<spec.MITM, trimmed>             ← emitted ONLY if spec.MITM is non-empty; section omitted otherwise
```

- `[General]`: if `spec.General` (after `strings.TrimSpace`) is non-empty, emit
  its body; otherwise emit the current default line. (We do not merge — the
  template's `[General]` fully replaces the default when provided.)
- `[MITM]`: if `spec.MITM` is empty, the entire `[MITM]` header + body is
  omitted. ShadowRocket uses the same `[MITM]` syntax, so inheritance is
  correct; no ShadowRocket-specific override needed.
- The renderer reads `spec` for the two text blocks. Since `Render` currently
  takes `(im Intermediate, subURL string)`, the General/MITM text must reach
  it: carry them on `Intermediate` (add `General string` and `MITM string`
  fields, populated by `Assemble`). This keeps `Render`'s signature stable and
  keeps the renderer target-agnostic about where the text came from.

## Editor UI (`TemplatesTab.tsx`)

Form mode (`RulesModel` + `TemplateEditor`):

- Add `general: string` and `mitm: string` to `RulesModel`; parse from / serialize
  to `general` / `mitm`. **Remove** `group_by_country` from `RulesModel`,
  `parseRules`, `buildModel`, and the editor state.
- Remove the **"Group by country"** checkbox.
- Add two textareas:
  - **`[General]`** — placeholder e.g. `dns-server = 119.29.29.29, 223.5.5.5`.
  - **`[MITM]`** — placeholder e.g. `hostname = *.googlevideo.com`.
- Update the Categories help text: the per-category policy dropdown now means
  "default selected member of the generated group" rather than the baked policy.
- Raw JSON mode + the live preview need no special handling — they already
  serialize/render whatever fields the model carries, so the new sections and
  group layout appear automatically in the preview.

## Validation & edge cases

- **Group names = category names** verbatim, including spaces and the colon in
  `Location:CN`. Surge group definitions are delimited only by `=` and `,`;
  category names contain neither, and spaces are already proven safe (existing
  node names use them). No sanitization.
- **Dedupe** category-group members so the configured policy isn't duplicated
  when it equals `PROXY`/`DIRECT`/`REJECT`.
- **No nodes**: a category group degrades to `select, <policy>, PROXY, DIRECT,
  REJECT` (still valid). `PreviewTemplate` injects two sample nodes so members
  are visible in preview.
- **General empty** → default `[General]`. **MITM empty** → section omitted.
- `ParseTemplate` continues to validate categories + policies + custom rules;
  `General`/`MITM` are accepted as free text.

## Testing

- `base_test.go`: with the new model, assert each selected category yields a
  `select` group named after it whose first member is the configured policy and
  whose members include `PROXY/DIRECT/REJECT` + node names (deduped); assert the
  matching rule's last field is the category name; assert **no** country groups
  are produced; assert `PROXY` is the first group. Update the existing fixture
  that sets `GroupByCountry`.
- `render_surge_test.go`: `[General]` uses `spec.General` when set and the
  default otherwise; `[MITM]` present when `spec.MITM` set and absent when not;
  category-group lines render in order.
- `template_test.go`: `ParseTemplate` round-trips `general`/`mitm`; the struct no
  longer has `GroupByCountry`.
- `service_test.go`: drop the `group_by_country` reference; the 🇺🇸/🇭🇰 assertion
  still holds via node names / category-group members, but update the comment to
  reflect why.
- FE `vitest` + `tsc` stay green after removing `group_by_country` from the
  model.

## Compatibility / migration

- New JSON fields are optional; legacy `rules_json` parses unchanged.
- Removing `group_by_country` is non-breaking: the key is ignored on parse, and
  the new group model derives entirely from `categories`.
- `builtinSpec` (`template.go`) stops setting `GroupByCountry`. Built-in
  templates re-seed only when absent (idempotent), so already-seeded builtins
  keep their stored `rules_json`; the new rendering behavior applies to them
  regardless because it is derived from their categories.
- **No DB migration.**

## Out of scope (deferred)

- Structured/validated `[General]`/`[MITM]` fields.
- Free-text "extra proxy groups" beyond the rule-derived ones (the rule-derived
  groups satisfy the stated need).
- Other Surge sections (`[URL Rewrite]`, `[Script]`, `[Host]`, etc.).
- Seeding non-empty default `[General]`/`[MITM]` into built-in templates.
