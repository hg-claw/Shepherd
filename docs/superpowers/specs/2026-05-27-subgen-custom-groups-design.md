# Subgen: Custom Proxy Groups (+ Ponte/DEVICE) — Design

**Date:** 2026-05-27
**Plugin:** `internal/plugins/subgen`
**Status:** Approved design, ready for implementation plan

## Goal

Let a template define its own named proxy groups (beyond the auto-generated
PROXY / Auto Select / per-category groups), so users can build groups like a
Surge **Ponte** intranet group (`Home = select, DEVICE:HomeMac, DIRECT`) and
route traffic to them via custom rules or category policies. Groups render in
all three targets; Surge-only `DEVICE:` members are auto-filtered out of Clash
and ShadowRocket output.

## Decisions (from brainstorming)

1. **Structured** custom groups `{name, type, members[]}` (not raw passthrough).
   `type ∈ {select, url-test}`. Members are free strings (node names, `PROXY`/
   `DIRECT`/`REJECT`, `DEVICE:HomeMac`, other group names).
2. Members render **verbatim** — no auto-`DIRECT` fallback (unlike the
   auto-generated select groups).
3. **`DEVICE:` is Surge-only.** Surge renders `DEVICE:` members/rules; **Clash
   and ShadowRocket auto-filter** them (drop the member; drop a rule whose policy
   is `DEVICE:`). (Surge Ponte's `DEVICE:NAME` policy needs no `[Proxy]`
   declaration and has no Clash/ShadowRocket equivalent.)

## Background — current state

- `Assemble` (`base.go`) builds `im.Groups`: `PROXY` (select, first), optional
  `Auto Select` (url-test), then one `select` per category. `Group{Name, Type,
  Members []string}`.
- `SurgeRenderer.render(im, subURL, rulesetBase, wgInline bool)` is shared by
  Surge (`wgInline=false`) and ShadowRocket (`wgInline=true`); `groupLine`
  renders a group (select groups get an auto-`DIRECT` fallback appended unless
  already present). `ClashRenderer` builds `proxy-groups` from `im.Groups`.
- Custom rules + category policies already accept any non-empty policy string
  (`validPolicy`), so they can target a custom group by name, or `DEVICE:x`
  directly, today.

## Data model

`TemplateSpec` (`template.go`) — add:

```go
CustomGroups []CustomGroup `json:"custom_groups,omitempty"`

type CustomGroup struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`    // "select" | "url-test"
	Members []string `json:"members"`
}
```

`ParseTemplate` validation for each custom group: `Name != ""`; `Type ∈
{"select","url-test"}`; `len(Members) >= 1`. Member strings are NOT validated
(they may be `DEVICE:x`, future names, etc.). On violation return an error like
`bad custom group %q: ...`.

`Group` (`base.go`) — add `Verbatim bool` so the renderer can skip the
auto-`DIRECT` fallback for user-defined groups:

```go
type Group struct {
	Name     string
	Type     string
	Members  []string
	Verbatim bool // user-defined: render members exactly, no auto-DIRECT
}
```

## Assemble

After the `PROXY` + optional `Auto Select` groups and **before** the per-category
groups, append each custom group verbatim:

```go
for _, cg := range spec.CustomGroups {
	im.Groups = append(im.Groups, Group{
		Name: cg.Name, Type: cg.Type, Members: cg.Members, Verbatim: true,
	})
}
```

No filtering here (Assemble is target-agnostic); `DEVICE:` filtering happens in
the renderers.

## Rendering

A small shared helper drops Surge-only `DEVICE:` members:

```go
func dropDevicePolicies(members []string) []string {
	out := members[:0:0]
	for _, m := range members {
		if !strings.HasPrefix(m, "DEVICE:") {
			out = append(out, m)
		}
	}
	return out
}
```

### Surge / ShadowRocket (`render_surge.go`)

Refactor the shared body's flavor flag from `wgInline bool` to `target string`
so it can express both ShadowRocket behaviors:

```go
func (r *SurgeRenderer) Render(im, subURL, rulesetBase string) string {
	return r.render(im, subURL, rulesetBase, "surge")
}
func (r *ShadowRocketRenderer) Render(im, subURL, rulesetBase string) string {
	return r.render(im, subURL, rulesetBase, "shadowrocket")
}
func (r *SurgeRenderer) render(im Intermediate, subURL, rulesetBase, target string) string {
	wgInline := target == "shadowrocket"
	filterDevice := target != "surge" // only Surge keeps DEVICE:
	// ...
}
```

- **`[Proxy Group]` loop:** if `filterDevice`, replace the group's members with
  `dropDevicePolicies(g.Members)`; if that leaves zero members, skip the group.
- **`groupLine`:** when `g.Verbatim`, render `select` members exactly (no
  auto-`DIRECT` append); `url-test` unchanged (still adds url/interval). The
  existing auto-`DIRECT` behavior is kept for non-verbatim (auto-generated)
  groups.
- **`[Rule]` loop:** if `filterDevice` and `rule.Target` starts with `DEVICE:`,
  skip that rule line.

Surge (`target="surge"`): `filterDevice=false` → `DEVICE:` members/rules render
as-is, e.g. `Home = select, DEVICE:HomeMac, DIRECT` and
`IP-CIDR,192.168.1.0/24,Home`.

### Clash (`render_clash.go`)

Clash always filters `DEVICE:` (no Ponte):
- **proxy-groups:** `members := dropDevicePolicies(g.Members)`; skip the group if
  empty; emit `{name, type, proxies: members}` (+ url/interval for url-test).
- **rules:** skip a rule whose `Target` starts with `DEVICE:`.

## Routing (unchanged)

Custom rules (`IP-CIDR,192.168.1.0/24,Home`) and category policies can target a
custom group by name — already supported by `validPolicy`. Worked example
(Ponte intranet):
- custom group: `Home = select, DEVICE:HomeMac, DIRECT`
- custom rule: `IP-CIDR,192.168.1.0/24,Home`
→ Surge routes LAN through the Ponte device; Clash/ShadowRocket render
`Home = select, DIRECT` (DEVICE filtered) and the rule still targets `Home`.

## Editor UI (`TemplatesTab.tsx`)

Add a **Custom groups** `<textarea>` after the Custom-rules block, one group per
line: `Name = type, member1, member2`. Convert text ↔ the `custom_groups`
structured model the same way `customRulesToText`/`textToCustomRules` handle
custom rules:
- parse a line: split on the first `=` → `Name` (trimmed); split the right side
  on `,` → first token is `Type` (trimmed), the rest are `Members` (trimmed);
  skip lines without `=` or with <1 member.
- serialize: `Name = Type, m1, m2`.
Placeholder/help: `Home = select, DEVICE:HomeMac, DIRECT` — "Members are free
text (node names, PROXY/DIRECT/REJECT, DEVICE:Name for Surge Ponte, or other
group names). DEVICE: members render only for Surge." Raw-JSON mode + live
preview reflect it automatically.

## Edge cases

- A custom group reduced to empty after `DEVICE:` filtering (clash/ShadowRocket)
  is dropped. **Recommendation (documented): give cross-format groups at least
  one non-`DEVICE:` member** (e.g. `DIRECT`) so they survive. A rule referencing
  a dropped group dangles — user-avoidable by following the recommendation.
- Group names with spaces (e.g. `Home Network`) are fine: the editor splits on
  the first `=`, and Surge/Clash group names allow spaces.
- Member token for "all nodes": use `PROXY` (the main group already contains all
  nodes). No special token is introduced.

## Testing

- `template_test.go`: `ParseTemplate` accepts a valid `custom_groups`; rejects
  bad type, empty name, empty members.
- `base_test.go`: `Assemble` appends each custom group (Verbatim=true) after
  Auto Select, before category groups.
- `render_surge_test.go`: a custom `select` group with a `DEVICE:` member renders
  verbatim (no auto-`DIRECT`, DEVICE kept) for Surge; a `DEVICE:` custom rule
  renders.
- `render_shadowrocket_test.go`: the same group renders with the `DEVICE:` member
  filtered out; a `DEVICE:` rule is dropped.
- `render_clash_test.go`: the same group → `DEVICE:` member filtered; non-DEVICE
  members kept; `DEVICE:` rule dropped.
- Non-DEVICE custom groups render identically across all targets; existing tests
  stay green (the `wgInline`→`target` refactor preserves WireGuard behavior).

## Compatibility / migration

- New optional `custom_groups` field; legacy `rules_json` parses unchanged.
- `Group.Verbatim` defaults false → auto-generated groups behave exactly as
  before.
- The `render` signature change (`wgInline bool` → `target string`) is internal;
  WireGuard inline behavior is preserved (`target=="shadowrocket"`).
- No DB migration.

## Out of scope (deferred)

- Surge-specific group types (`subnet`, `fallback`, `load-balance`) — only
  `select`/`url-test` (the cross-format types) in v1.
- Declaring the Ponte/`DEVICE` device itself (it needs no `[Proxy]` entry).
- Cascade-dropping rules that reference a group emptied by DEVICE filtering.
- A structured per-member editor (the line-based textarea is the v1 UI).
