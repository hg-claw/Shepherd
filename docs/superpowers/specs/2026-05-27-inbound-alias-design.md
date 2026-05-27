# Inbound Alias (别名) Design

**Date:** 2026-05-27
**Status:** Approved

## Goal

Give each xray / sing-box **inbound** an optional free-text **alias**. When a
subscription is generated, an inbound with an alias is named by that alias
instead of the auto-generated `🇺🇸 ServerName protocol` label — so nodes are
easy to identify in the client.

## Background

An inbound is a proxy-server entry stored per plugin:

- `xray_inbounds` (struct `xray.Inbound`, `internal/plugins/xray/inbounds.go`)
- `singbox_inbounds` (struct `singbox.Inbound`, `internal/plugins/singbox/inbounds.go`)

Both tables have postgres **and** sqlite migrations. Neither has a
name/alias/remark column today — an inbound carries only a system `tag`
(e.g. `landing-deadbeef`).

The subgen plugin reads inbounds directly. `internal/plugins/subgen/collect.go`
JOINs each selected inbound with its `servers` row and projects into
`xrayRow` / `singboxRow`, then maps to a `subgen.Node` via
`xrayInboundToNode` / `singboxInboundToNode` (`internal/plugins/subgen/node.go`).
Today the node name is set unconditionally:

```go
n.Name = nodeName(srv.Country, srv.Name, n.Protocol) // → "🇺🇸 Tokyo vless"
```

A subscription's inbounds come from the join table
`subgen_subscription_inbounds(subscription_id, source, inbound_id)`.
`Service.Generate` → `CollectNodes` → `Assemble` → renderer.

## Decisions

1. **Alias replaces the name entirely.** A non-empty alias becomes `Node.Name`
   verbatim — no country flag or protocol auto-appended (the user includes the
   flag in the alias themselves, e.g. `🇭🇰 香港 CIA 01`). Empty alias → current
   `nodeName(country, server, proto)` fallback, unchanged.
2. **Duplicate node names are de-duplicated with a numeric suffix.** If two
   selected nodes resolve to the same name, the first keeps it and later ones
   get ` 2`, ` 3`, … (Clash and similar clients break or silently overwrite on
   duplicate proxy names). De-dup runs over the **complete** node set — inbound
   nodes plus the template's custom share-link nodes.
3. **Alias is a property of the inbound** (chosen over a per-subscription
   alias), stored as a column on each inbound table.
4. **Scope:** both xray and sing-box; settable at create and edit; free text,
   leading/trailing whitespace trimmed, no format restriction.

## Architecture

Per-inbound `alias` column → flows through subgen's existing read path into
`Node.Name`. No new tables, no change to the subscription↔inbound join.

### Unit 1 — Persistence (xray & sing-box plugins)

**Migrations** (column is `alias TEXT NOT NULL DEFAULT ''`, postgres + sqlite):

- xray: `internal/plugins/xray/migrations/{postgres,sqlite}/0005_inbound_alias.{up,down}.sql`
- singbox: `internal/plugins/singbox/migrations/{postgres,sqlite}/0007_inbound_alias.{up,down}.sql`

`up` is `ALTER TABLE <t> ADD COLUMN alias TEXT NOT NULL DEFAULT '';`,
`down` is `ALTER TABLE <t> DROP COLUMN alias;` — same in both dialects,
matching the existing convention (e.g. singbox `0006_relay_mode`).

**Structs / DAO:**

- `xray.Inbound` and `singbox.Inbound`: add `Alias string \`db:"alias"\``.
- `xray.InboundPatch` and `singbox.InboundPatch`: add `Alias *string` (nil =
  leave unchanged), wired into `Update`.
- `Insert` writes `alias` (defaults to `''` when unset).

### Unit 2 — Node naming (subgen)

- `xrayRow` / `singboxRow` (`collect.go`): add `Alias string \`db:"alias"\``;
  both SELECTs add `i.alias`.
- `xrayLite` / `singboxLite` (`node.go`): add `Alias string`; `collectXray` /
  `collectSingbox` pass it through.
- `xrayInboundToNode` / `singboxInboundToNode`: replace the unconditional
  assignment with

  ```go
  if a := strings.TrimSpace(in.Alias); a != "" {
      n.Name = a
  } else {
      n.Name = nodeName(srv.Country, srv.Name, n.Protocol)
  }
  ```

- **De-dup** — new helper in subgen (`node.go`):

  ```go
  // dedupeNodeNames makes Node.Name unique across the slice, in place,
  // preserving order. The first occurrence of a name is kept; later
  // collisions get " 2", " 3", … (skipping any suffix already taken).
  func dedupeNodeNames(nodes []Node) {
      seen := map[string]bool{}
      for i := range nodes {
          name := nodes[i].Name
          if !seen[name] {
              seen[name] = true
              continue
          }
          for n := 2; ; n++ {
              cand := fmt.Sprintf("%s %d", name, n)
              if !seen[cand] {
                  nodes[i].Name = cand
                  seen[cand] = true
                  break
              }
          }
      }
  }
  ```

  Called in `Assemble` (`base.go`) immediately after the template's custom
  share-link nodes are appended and **before** `allNames` is built, so groups
  and rules reference the final, unique names.

### Unit 3 — API + Admin UI

- xray and singbox inbound create/update request + response DTOs: add `alias`.
  (Pin exact handler files during planning — the inbound CRUD routes in each
  plugin.)
- xray and singbox React inbound forms: add an optional **别名 (Alias)** text
  input; empty = default naming. Show the alias in the inbound list row
  alongside the tag for quick identification.

## Data Flow

```
Admin sets alias on inbound
  → stored in xray_inbounds.alias / singbox_inbounds.alias
Subscription fetched (/sub/<token>)
  → CollectNodes: SELECT … i.alias … → xrayRow/singboxRow
  → xrayInboundToNode/singboxInboundToNode: Node.Name = alias (or default)
  → Assemble: append custom nodes → dedupeNodeNames(nodes) → groups/rules
  → renderer emits unique node names
```

## Error / Edge Handling

- **Empty / whitespace-only alias** → default naming (trimmed before the
  non-empty check).
- **Duplicate names** (same alias, or alias colliding with an auto-generated
  name, or two auto-generated names colliding) → numeric suffix via
  `dedupeNodeNames`. This subsumes the pre-existing (unhandled) case of two
  servers with the same name+protocol.
- **Existing rows** get `''` via the column default → behaviour unchanged until
  an alias is set.

## Testing

- `node_test.go`: alias set → `Node.Name == alias`; alias empty/whitespace →
  default `nodeName` output.
- `base_test.go` (or `node_test.go`): `dedupeNodeNames` — `X`,`X` → `X`,`X 2`;
  three-way `X`,`X`,`X` → `X`,`X 2`,`X 3`; a custom share-link node colliding
  with an inbound node is suffixed; pre-taken suffix is skipped.
- xray & singbox inbound store tests: alias insert + update round-trip
  (including patch with `nil` leaving it unchanged).
- Frontend vitest: inbound form reads/writes the alias field.

## Out of Scope (YAGNI)

- Per-subscription alias overrides.
- Alias uniqueness enforcement at the DB/API layer (de-dup at render time is
  enough; two inbounds may legitimately share an alias).
- Auto-suggesting aliases.
