# Subgen: fixed dler.io/oixCloud Surge + Clash templates — Design

**Date:** 2026-05-30
**Status:** Approved (scope confirmed via Q&A)

## Goal

Make subgen's generated Surge and Clash subscriptions match the dler.io/oixCloud
reference configs the user supplied in `tmp/oixCloudSurge` and `tmp/oixCloudClash`:
a full `[General]`/DNS block, a fixed proxy-group taxonomy (~28 groups: `Proxy` +
~25 service groups + `Auto - UrlTest`/`Auto - Smart`), the dler.io `RULE-SET`
providers per service, and the extra sections (`[URL Rewrite]`/`[Host]`/
`[Script]`/`[Panel]` for Surge; `dns`/`experimental`/`rule-providers` for Clash).
The user's selected nodes fill the proxy definitions and every group's member
list. The existing **custom logic stays** (custom rules/groups/nodes, free-text
sections, DOMAIN-SET handling).

## Decisions (confirmed)

1. **Embed the two files as fixed base templates + inject nodes.** The reference
   files become committed, templatized assets; generation substitutes the user's
   nodes and emits the rest verbatim.
2. **Fixed dler.io taxonomy; retire category-driven rules/groups.** The renderer
   no longer derives groups/rules from `spec.Categories` — the fixed template
   provides them. Custom rules/groups/nodes/free-text still layer on.
3. **Clash injected as text** (not parse-and-remarshal), to preserve the file's
   exact formatting, comments, and flow-style `{ }` — faithful to "按这两个文件".

## Template assets (committed)

Two templatized copies, embedded via `//go:embed`, under
`internal/plugins/subgen/templates/`:
- `oix_surge.tmpl` — `tmp/oixCloudSurge` with injection markers.
- `oix_clash.tmpl` — `tmp/oixCloudClash` with injection markers.

The **original `tmp/` files are NOT committed** (see `.gitignore`); only the
templatized copies are.

### Injection markers
Everything outside the markers is emitted verbatim (General/DNS/group structure/
rules/rule-providers/Host/Script/Panel).

| Marker | Location | Replaced with |
|---|---|---|
| `{{PROXIES}}` | Surge `[Proxy]` body / Clash `proxies:` body | the rendered node definitions (one block) |
| `{{WIREGUARD}}` | Surge, after `[Proxy]` | the `[WireGuard wgN]` sections (Surge WG nodes); empty if none |
| `{{NODES}}` | every node-listing group (each `select`/`url-test`/`smart` group's member tail; groups with no nodes like `AdBlock` have no marker) | the comma-joined node-name list (Surge) / YAML inline-seq items (Clash) — identical in every group |
| `{{CUSTOM_RULES}}` | top of `[Rule]` / `rules:` (BEFORE the dler.io rules → custom rules win) | rendered custom rules (with DOMAIN-SET→Clash conversion) |
| `{{CUSTOM_GROUPS}}` | end of the proxy-group section | rendered custom groups |
| `{{GENERAL_EXTRA}}` | end of `[General]` (Surge) | free-text `general` (later keys override → user wins) |
| `{{MITM}}` | Surge (own `[MITM]` section, emitted only if non-empty) | free-text `mitm` |
| `{{URLREWRITE_EXTRA}}` | end of `[URL Rewrite]` (Surge) | free-text `url_rewrite` |
| `{{CLASH_EXTRA}}` | Clash top level | free-text `clash_general` (validated YAML, appended) |

Markers that resolve to nothing are replaced with the empty string (and any
now-empty section header is harmless / can be trimmed). The templatizer (a
one-time manual edit of the embedded copies) inserts `{{NODES}}` into each
node-listing group line, replacing the oixCloud node names, keeping the group's
fixed policy tokens (`Proxy`, `Direct`, `Auto - Smart`, `Auto - UrlTest`,
`REJECT`/`Block`, etc.).

## Rendering (template substitution)

`render_surge.go` / `render_clash.go` are rewritten from section-builders to
**template fillers**:

1. **Node set** = the subscription's selected-node `Nodes` + parsed custom nodes
   (`ParseShareLinks(spec.CustomNodes)`) — unchanged assembly.
2. **`{{PROXIES}}`** = the rendered node definitions, reusing the existing
   per-protocol helpers (`proxyLine` for Surge incl. WireGuard `section-name`/
   inline + insecure/`skip-cert-verify`; `clashProxy` for Clash incl. all
   protocols + `skip-cert-verify` + WireGuard). Clash node maps are marshalled to
   correctly-indented `proxies:` list items as text.
3. **`{{WIREGUARD}}`** (Surge) = the `[WireGuard wgN]` sections produced by the
   existing WG helpers; empty when there are no WG nodes.
4. **`{{NODES}}`** = the node display names (`n.Name`), comma-joined (Surge) or as
   a YAML inline sequence fragment (Clash), substituted into every node-listing
   group. Custom nodes are included automatically (they're in the node set).
5. **`{{CUSTOM_RULES}}`** = `spec.CustomRules` rendered as rule lines. Surge:
   verbatim `Match,Policy` (incl. native `DOMAIN-SET`). Clash: reuse the shipped
   conversion — `DOMAIN-SET` → a `behavior: domain` rule-provider + `RULE-SET`;
   other matches verbatim. Placed above the dler.io rules so they take effect.
6. **`{{CUSTOM_GROUPS}}`** = `spec.CustomGroups` rendered (Surge `name = type,
   members`; Clash `- { name, type, proxies:[...] }`), with `DEVICE:` policies
   kept only for Surge (`dropDevicePolicies` for Clash), as today.
7. **Free-text** = `spec.General`/`MITM`/`URLRewrite`/`ClashGeneral` substituted
   into their `*_EXTRA`/`MITM` markers.
8. Substitute all markers into the embedded template; return the string.

`base.go` `Assemble`: stops expanding `spec.Categories` into rules/groups (the
fixed template owns those). It still produces the node set + carries the custom
fields. `catalog.go`/`ResolveRuleLines` and the category→group/rule expansion are
no longer used by rendering (left in place for the `/categories` endpoint /
removed in the plan as dead code — the plan decides; rendering must not depend on
them).

> The per-target `Renderer` interface (`Target/Supports/Render`) and
> `rendererFor` are unchanged; only the bodies become template fillers.

## `.gitignore`

Add `/tmp/` so the original reference configs (and any scratch) are never
committed. The templatized copies live under `internal/plugins/subgen/templates/`
and ARE committed (they're the embedded assets).

## Out of scope

- Removing the category-selection **frontend UI** (the renderer simply ignores
  `Categories`; UI cleanup is a separate follow-up if wanted).
- Making the dler.io template user-configurable / multiple presets (it's THE
  fixed base now).
- ShadowRocket target beyond what it already inherits from the Surge renderer
  (ShadowRocket uses the Surge family; it gets the same template, with
  ShadowRocket-specific node handling — WG inline — as today).
- Changing node selection, the public wall, or any non-subgen code.

## Testing

- **Template integrity:** the embedded `oix_surge.tmpl`/`oix_clash.tmpl` contain
  every expected marker and no stray `{{` after rendering (a "no unresolved
  markers" assertion on the output).
- **Surge render:** given an Intermediate with two nodes + a custom rule + a
  custom group + free-text general, the output: lists both node names in the
  `Proxy` group and in `Auto - UrlTest`; defines both nodes under `[Proxy]`;
  custom rule appears in `[Rule]` BEFORE the first dler.io `RULE-SET`; custom
  group appears after the fixed groups; the free-text general line appears in
  `[General]`; `[Host]`/`[Script]`/`[Panel]` are present verbatim.
- **Clash render:** same Intermediate → valid YAML (`yaml.Unmarshal` round-trip);
  both nodes in `proxies:` and in the `Proxy` group's `proxies:` list; a
  `DOMAIN-SET` custom rule becomes a `behavior: domain` rule-provider + `RULE-SET`
  (no verbatim `DOMAIN-SET`); the dler.io `rule-providers` block is present.
- **WireGuard (Surge):** a WG node yields a `[WireGuard wgN]` section via
  `{{WIREGUARD}}` and a `section-name=wgN` proxy line.
- **No-nodes / no-custom:** empty markers collapse cleanly (valid output, no
  dangling separators).
- Existing subgen tests adjusted to the new output shape; the DOMAIN-SET and
  insecure/skip-cert-verify behaviors retained.
