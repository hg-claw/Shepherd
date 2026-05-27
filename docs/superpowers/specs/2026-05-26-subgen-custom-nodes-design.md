# Subgen: Custom Nodes via Share Links (template field) — Design

**Date:** 2026-05-26
**Plugin:** `internal/plugins/subgen`
**Status:** Approved design, ready for implementation plan

## Goal

Let a template carry **custom nodes** entered as proxy share links
(`vless://`, `ss://`, `vmess://`, `trojan://`, `hysteria2://`, `tuic://`,
`anytls://`). These are parsed into the unified `Node` model and merged with the
subscription's inbound-derived nodes, so they participate in the same proxy
groups, routing, and Surge/Clash rendering. Editing happens in the existing
template editor; the live preview reflects them immediately.

## Decision: template-level scope (not per-subscription)

Custom nodes live on the **template** (in `rules_json`), not the subscription.
All subscriptions using a template share its custom nodes. This was a deliberate
simplicity trade-off (chosen by the user over per-subscription granularity): it
reuses the template's existing `rules_json` storage, editor, Raw-JSON mode, and
live preview — **no DB migration, no subscription/store/endpoint/NodePicker
changes**. A user who needs different custom nodes per subscription uses
different templates.

## Background — current state

- `TemplateSpec` (`template.go`) holds `Categories`, `CustomRules`, `Final`,
  `IncludeAutoSelect`, `General`, `MITM`, `ClashGeneral` — all serialized in a
  template's `rules_json`.
- `Generate` (`service.go`): `ParseTemplate(tpl.RulesJSON)` → `spec`;
  `nodes,_,_ := CollectNodes(...)`; `im := Assemble(nodes, spec)`.
- `PreviewTemplate` (`service.go`): `spec` from rulesJSON;
  `im := Assemble(sampleNodes(), spec)`.
- `Assemble(nodes []Node, spec TemplateSpec) Intermediate` builds groups + rules
  from `nodes` + `spec`. `Node` is the unified model consumed by both renderers;
  `SurgeRenderer.Supports`/`ClashRenderer.Supports` + `clashProxy` cover all 7
  protocols.

**Key consequence:** both `Generate` and `PreviewTemplate` already pass `spec`
to `Assemble`. If `Assemble` reads `spec.CustomNodes`, neither caller changes —
the only Go edits are the new field, the parser, and one append in `Assemble`.

## Data model

`TemplateSpec` (`template.go`) — add one field:

```go
CustomNodes string `json:"custom_nodes,omitempty"` // newline-separated proxy share links
```

`ParseTemplate` does **not** validate `CustomNodes` (best-effort; malformed
lines are skipped at render, surfaced via the live preview). It is free text,
like `General`/`MITM`.

## Share-link parser (`sharelink.go` — new)

```go
// ParseShareLinks parses newline-separated proxy share links into Nodes.
// Blank lines and lines beginning with '#' are skipped. Unparseable or
// unsupported lines are skipped and reported in warnings (one per bad line).
func ParseShareLinks(text string) (nodes []Node, warnings []string)
```

Per line: trim; skip empty / `#`-comment; dispatch on the URI scheme. The URL
**fragment** (`#...`, URL-decoded) becomes `Node.Name`; if absent, use
`<server>:<port>`. `Node.Country` is left empty (grouping no longer uses it).
Each parser maps to the unified `Node`:

| Scheme | Format | Node mapping |
|--------|--------|--------------|
| `ss://` | SIP002 `ss://<b64url(method:password)>@host:port#name`, or legacy `ss://<b64(method:password@host:port)>#name` | `Protocol:"shadowsocks"`, `SSMethod`, `Password`, `Server`, `Port` |
| `vmess://` | `vmess://<base64(JSON)>` (v2rayN: `ps,add,port,id,aid,net,type,host,path,tls,sni`) | `Protocol:"vmess"`, `Server:add`, `Port`, `UUID:id`, `Name:ps`, `Transport: net=="ws"?"ws":""`, `Path`, `Host`, `SNI: sni|host when tls` |
| `vless://` | `vless://uuid@host:port?security&flow&pbk&sid&sni&type&path&host#name` | `Protocol:"vless"`, `Server`, `Port`, `UUID`, `Flow`, `SNI`, `RealityPublicKey:pbk` (when `security=reality`), `RealityShortID:sid`, `Transport: type=="ws"?"ws":""`, `Path`, `Host` |
| `trojan://` | `trojan://password@host:port?sni&type&path&host&allowInsecure#name` | `Protocol:"trojan"`, `Server`, `Port`, `Password`, `SNI`, `Transport`, `Path`, `Host`, `Insecure: allowInsecure=="1"` |
| `hysteria2://` / `hy2://` | `hysteria2://password@host:port?sni&insecure#name` | `Protocol:"hysteria2"`, `Server`, `Port`, `Password`, `SNI`, `Insecure: insecure=="1"` |
| `tuic://` | `tuic://uuid:password@host:port?congestion_control&sni#name` | `Protocol:"tuic"`, `Server`, `Port`, `UUID`, `Password`, `SNI`, `Extra:{congestion_control}` |
| `anytls://` | `anytls://password@host:port?sni&insecure#name` | `Protocol:"anytls"`, `Server`, `Port`, `Password`, `SNI`, `Insecure` |

Implementation notes:
- `vless`/`trojan`/`hysteria2`/`tuic`/`anytls` parse with `net/url.Parse`
  (`scheme://user[:pass]@host:port/?query#fragment`); `Port` via
  `strconv.Atoi(u.Port())`; `Name` from `u.Fragment`.
- `ss`/`vmess` need manual base64 decoding (try `base64.RawURLEncoding` then
  `base64.StdEncoding`). `ss` must handle both SIP002 (has `@`) and legacy
  (whole payload base64) shapes; split the `#fragment` off first.
- A line whose port is non-numeric, host is empty, or required credential is
  missing → a warning, skipped (never a partial/invalid Node).

The 7 protocol strings produced match exactly what the renderers already handle
(`baseScheme` values), so no renderer changes are needed.

## Integration — one append in `Assemble`

```go
func Assemble(nodes []Node, spec TemplateSpec) Intermediate {
	if custom, _ := ParseShareLinks(spec.CustomNodes); len(custom) > 0 {
		nodes = append(nodes, custom...)
	}
	// ... unchanged: allNames, groups, rules ...
}
```

- Custom nodes are appended **after** the passed-in nodes (so inbound nodes list
  first, custom nodes last) and flow unchanged into PROXY / Auto Select / each
  category group, and into both renderers.
- `Generate`: inbound nodes + template custom nodes. **No change to `Generate`.**
- `PreviewTemplate`: `sampleNodes()` (🇺🇸/🇭🇰, standing in for the subscription's
  inbound selection) + template custom nodes → pasting a link shows the node in
  the preview immediately. **No change to `PreviewTemplate`.**
- Warnings from `ParseShareLinks` are discarded here; the live preview is the
  feedback channel (a link that fails to parse simply does not appear).

## Editor UI (`TemplatesTab.tsx`)

Mirror the existing `clash_general` field exactly:
- `RulesModel` gains `custom_nodes: string`.
- `parseRules` returns `custom_nodes: String(raw.custom_nodes ?? '')`.
- `TemplateEditor` adds `customNodes`/`setCustomNodes` state from
  `initial.custom_nodes`; `buildModel` emits `custom_nodes: customNodes`;
  `switchToForm` calls `setCustomNodes(m.custom_nodes)`.
- A **Custom nodes (share links)** `<textarea>` (form mode) placed after the
  `[Clash] general` textarea, with help text: "One proxy share link per line
  (`vless://`, `ss://`, `vmess://`, `trojan://`, `hysteria2://`, `tuic://`,
  `anytls://`). Parsed nodes appear in the preview." Placeholder e.g.
  `vless://uuid@host:443?security=reality&pbk=...#🇺🇸 US`.
- Raw-JSON mode + live preview need no special handling (they already
  serialize/render whatever the model carries).

## Edge cases

- **Unsupported protocol** in a link (none today — all 7 are supported): the
  renderer's existing skip logic drops it (Surge emits a `# skipped` comment).
- **Malformed line**: skipped by `ParseShareLinks` (warning), absent from output.
- **Name collision** between a custom node's fragment name and an inbound node
  name (e.g. a fragment that equals `🇺🇸 server proto`): both appear; Surge/Clash
  group references become ambiguous. Rare (inbound names are flag+server+proto);
  **not de-duplicated in v1** — documented known edge.
- **Empty `custom_nodes`**: no nodes appended; behavior identical to today.

## Testing

- `sharelink_test.go`: one case per scheme asserting the mapped `Node` fields +
  `#fragment` name; a SIP002 `ss` and a legacy `ss`; a `vmess` base64-JSON; a
  malformed line → exactly one warning and zero nodes; a `#`-comment/blank line
  skipped.
- `base_test.go`: a `spec.CustomNodes` with one link → `Assemble` output
  includes a node with that name (appended after the passed-in nodes).
- `service_test.go`: `PreviewTemplate` with a `custom_nodes` link → output
  contains the custom node for both `surge` and `clash`.
- FE: `tsc` clean + `vitest` green after adding the `custom_nodes` field.

## Compatibility / migration

- `custom_nodes` is an optional JSON field; legacy `rules_json` parses unchanged.
- **No DB migration**, no subscription/store/endpoint changes.
- Templates without custom nodes render byte-identically to today.

## Out of scope (deferred)

- Per-subscription custom nodes (this is template-level by decision).
- Remote subscription-URL import / periodic refresh.
- Manual structured (form-field) node entry.
- Surfacing parse warnings outside the live preview (e.g. a save-time summary).
- De-duplicating custom vs inbound node names.
