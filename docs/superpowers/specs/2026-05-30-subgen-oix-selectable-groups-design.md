# Subgen: selectable oixCloud proxy-groups + skip-proxy tweak — Design

**Date:** 2026-05-30
**Status:** Approved (scope confirmed via Q&A)

## Goal

Three changes to the fixed dler.io/oixCloud subgen templates shipped in v0.17.0:

1. Remove the `10.0.0.0/8` CIDR from the Surge `[General]` `skip-proxy` line.
2. Make the template's **service** proxy-groups individually selectable in the
   template editor (like the pre-v0.17.0 category selection). Deselecting a group
   removes that group **and all rules / rule-providers that target it** from the
   generated Surge and Clash output; that traffic then falls through to `Others`
   (the final catch-all).
3. Already-saved custom templates default to **all groups selected** — no
   migration, no behavior change for existing subscriptions.

## Decisions (confirmed via Q&A)

- **Only service groups are selectable; core groups are always present.**
  Core (always-on, 5): `Proxy`, `Domestic`, `Others`, `Auto - UrlTest`,
  `Auto - Smart` — they are the main group / catch-all / auto-test targets;
  dropping them would leave `FINAL`/`Proxy` references dangling.
  Selectable service groups (24): `AdBlock`, `AI Suite`, `Netflix`,
  `Disney Plus`, `YouTube`, `Max`, `Spotify`, `CN Mainland TV`, `Asian TV`,
  `Global TV`, `Apple Push`, `Apple Services`, `Apple TV`, `Telegram`,
  `Google FCM`, `Crypto`, `Discord`, `PayPal`, `Microsoft`, `Scholar`,
  `Speedtest`, `Steam`, `TikTok`, `miHoYo`.
- **Approach A — render-time text filter keyed on group name.** The embedded
  templates remain the single source of truth (no transcription of ~29 groups /
  ~70 rules back into Go, which would reintroduce the drift risk v0.17.0
  eliminated). Each group, its rules, and (Clash) its rule-providers are linked by
  the group **name**, which the templates already encode, so filtering is pure
  line removal keyed on names. Rejected: per-group conditional markers in the
  template (heavy, three non-contiguous edit sites per group) and a Go data
  catalog (drift risk).
- **Store the DISABLED set, not the selected set.** `disabled_groups []string`
  with zero-value = empty = nothing disabled = all groups on. Existing templates
  (whose `rules_json` has no such key) parse to all-on automatically — satisfies
  requirement 3 with no pointer/sentinel tricks and no migration.
- **No per-group policy.** Each oix group is itself a `select` policy target with
  a fixed member list; the editor only toggles inclusion (checkbox), unlike the
  old `CategorySel{Name, Policy}`.
- **Flat checklist UI** with select-all / clear-all (no Media/Apple/… category
  columns — YAGNI).

## Components

### 1. Group catalog — `internal/plugins/subgen/oixgroups.go` (new)

Single source of truth for which names are core vs selectable, shared by the
renderers, `ParseTemplate` validation, and the UI endpoint.

```go
// OixCoreGroups are always emitted; not user-selectable.
var OixCoreGroups = map[string]bool{
    "Proxy": true, "Domestic": true, "Others": true,
    "Auto - UrlTest": true, "Auto - Smart": true,
}

// OixServiceGroups is the ordered list of user-selectable service groups.
var OixServiceGroups = []string{
    "AdBlock", "AI Suite", "Netflix", "Disney Plus", "YouTube", "Max",
    "Spotify", "CN Mainland TV", "Asian TV", "Global TV", "Apple Push",
    "Apple Services", "Apple TV", "Telegram", "Google FCM", "Crypto",
    "Discord", "PayPal", "Microsoft", "Scholar", "Speedtest", "Steam",
    "TikTok", "miHoYo",
}

func isOixServiceGroup(name string) bool { /* membership over OixServiceGroups */ }
```

### 2. Data model — `internal/plugins/subgen/template.go`

- `TemplateSpec` gains `DisabledGroups []string \`json:"disabled_groups,omitempty"\``.
- `ParseTemplate`: each entry must satisfy `isOixServiceGroup` (unknown ⇒ error,
  consistent with existing `unknown category` validation). Absent/empty ⇒ all-on.
- Legacy `Categories []CategorySel` field stays untouched (dead since v0.17.0 but
  harmless; old templates still parse).
- `builtinSpec` leaves `DisabledGroups` empty (built-ins render the full template).

### 3. Intermediate + Assemble — `internal/plugins/subgen/base.go`

- `Intermediate` gains `DisabledGroups []string`.
- `Assemble(nodes, spec)` copies `spec.DisabledGroups` into the intermediate
  (normalized: drop names not in `OixServiceGroups`, so a stale name can never
  break rendering).

### 4. Surge filter — `internal/plugins/subgen/render_surge.go`

A new step runs on the template text **before** marker substitution (so dropping a
group line also drops its `{{NODES}}`):

- `[Proxy Group]`: drop a line whose left-hand name (`Name = …`) is a disabled
  service group.
- `[Rule]`: drop a line whose **target policy** is a disabled service group. The
  target is the field before `,extended-matching` for `RULE-SET` lines, else the
  last comma-separated field. Structural rules (`…/Special.list,DIRECT`,
  `RULE-SET,LAN,DIRECT`, `GEOIP,CN,Domestic`, `FINAL,Others,dns-failed`) target
  core groups and are always kept.

Filtering is scoped to the `[Proxy Group]` and `[Rule]` sections only; all other
sections (`[General]`, `[Host]`, `[Script]`, `[Panel]`, `[URL Rewrite]`, etc.)
pass through unchanged. Helper: `filterSurgeGroups(tmpl string, disabled map[string]bool) string`.

### 5. Clash filter — `internal/plugins/subgen/render_clash.go`

Runs on the template text before marker substitution:

- `proxy-groups:`: drop a `- { name: <G>, … }` item whose name is a disabled
  service group (names may be bare or single-quoted, e.g. `'Disney Plus'`).
- `rules:`: drop a `- 'RULE-SET,<provider>,<group>'` item whose **target group**
  (last field) is a disabled service group.
- `rule-providers:`: after the rule pass, drop any provider whose key is no longer
  referenced by a surviving `RULE-SET,<key>,…` rule. This generically handles
  one-group-to-many-providers (e.g. `Asian TV` → Abema TV/Bahamut/DMM/…) and keeps
  core-referenced providers (`PROXY`, `Domestic`, `Domestic IPs`, `LAN`) and all
  `{{CUSTOM_PROVIDERS}}`. Output must still round-trip via `yaml.Unmarshal`.

Helper: `filterClashGroups(tmpl string, disabled map[string]bool) string`.

### 6. Endpoint — `internal/plugins/subgen/routes.go`

`GET /api/admin/plugins/subgen/oix-groups` returns `OixServiceGroups` (ordered
JSON array of names) so the editor renders the checklist from the same source the
renderer filters on (no frontend hard-coding / drift). Mirror the existing
`GET …/categories` handler pattern.

### 7. Editor UI — `web/src/pages/admin/plugins/subgen/TemplatesTab.tsx`

- Replace the old category-selection block with a flat checklist of the service
  groups fetched from `…/oix-groups`, plus select-all / clear-all controls.
- A group is checked iff its name is **not** in the template's `disabled_groups`.
  A freshly loaded template with empty/absent `disabled_groups` shows all checked.
- On save: `disabled_groups = OixServiceGroups − checked`. New templates with
  everything checked send `disabled_groups: []` (renders the full template).
- Live preview (`previewSubgenTemplate`) already round-trips through the renderer,
  so it reflects the selection without extra work.

### 8. Surge template — `internal/plugins/subgen/templates/oix_surge.tmpl`

Remove `,10.0.0.0/8` from the `[General]` `skip-proxy` line (line 6). No other
template edits — selection is applied at render time, not baked into the file.

## Data flow

```
TemplateSpec.disabled_groups
  → ParseTemplate (validate ∈ OixServiceGroups)
  → Assemble → Intermediate.DisabledGroups (normalized)
  → SurgeRenderer/ClashRenderer.Render:
        filter template text by disabled names → substitute {{…}} markers → output
```

ShadowRocket renders through the Surge path, so it inherits the Surge filter
automatically.

## Testing

**Go (`render_surge_test.go`, `render_clash_test.go`, `template_test.go`):**
- Surge subset: disable `Netflix` ⇒ no `Netflix = select` line and no
  `…/Netflix.list,Netflix` rule; `Proxy`/`Others` lines and structural rules
  (`GEOIP,CN,Domestic`, `FINAL,Others`) remain; no unresolved `{{`.
- Clash subset: disable `Asian TV` ⇒ its proxy-group, all `RULE-SET,…,Asian TV`
  rules, and the now-orphaned providers (Abema TV/Bahamut/…) are gone; core
  providers (`PROXY`/`Domestic`/`LAN`) remain; output still parses via
  `yaml.Unmarshal`.
- Legacy parity: empty `disabled_groups` ⇒ output identical to today (all groups
  present) for both renderers.
- `ParseTemplate`: unknown disabled-group name ⇒ error; a core-group name in
  `disabled_groups` ⇒ error (not a service group).

**Frontend (`TemplatesTab.test.tsx`):**
- Empty `disabled_groups` ⇒ all checkboxes checked.
- Unchecking N groups ⇒ save payload `disabled_groups` contains exactly those N
  names; select-all clears it to `[]`.

## Out of scope

- Reordering / renaming the oixCloud groups, or per-group policy override.
- Touching the merged v0.17.0 fixed-template structure beyond the skip-proxy line.
- Node selection, the public wall, or any non-subgen code.
- Removing the dead legacy `Categories` field/validation (left as-is to keep old
  `rules_json` parseable).

## Verification gates

`go test -race ./...`, `golangci-lint run` (staticcheck), `gofmt`; frontend `tsc`
+ `vitest`. End-to-end: generate a Surge and a Clash subscription with a subset of
groups deselected and confirm the dropped groups/rules/providers are absent and
the configs still load.
