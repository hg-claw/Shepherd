# Subgen: WireGuard Node Support (`wg://`) — Design

**Date:** 2026-05-26
**Plugin:** `internal/plugins/subgen`
**Status:** Approved design, ready for implementation plan

## Goal

Support WireGuard nodes pasted as `wg://` (and `wireguard://`) share links in a
template's custom-nodes field, parsed into the unified `Node` model and rendered
in all three output targets: Clash.Meta (`type: wireguard`), Surge (separate
`[WireGuard]` section), and ShadowRocket (inline `[Proxy]` line).

## The input format (confirmed with the user)

```
wg://home.hg.ht:51820?publicKey=<b64>&privateKey=<b64>&presharedKey=<b64>&ip=10.254.253.3&udp=1&reserved=0,0,0&flag=CN#WG
```

- `host:port` → endpoint (`Server`/`Port`).
- Query params (auto URL-decoded by `net/url`): `publicKey` (peer public key),
  `privateKey` (local), `presharedKey`, `ip` (interface self-ip, no CIDR),
  `udp` (`1`), `reserved` (`0,0,0`), `flag` (country code).
- `#WG` → name fragment.

## Decisions (from brainstorming)

1. **Store WG fields in `Node.Extra`** (no new struct/field) — consistent with
   the existing `tuic` precedent (`Extra["congestion_control"]`), and matches the
   user's "no sub-structure" preference.
2. **Render in all three targets**, each in its native WireGuard form (below).
3. ShadowRocket uses an **inline `[Proxy]` line** (no `[WireGuard]` section),
   per the reference config
   [LOWERTOP/Shadowrocket/lazy.conf](https://github.com/LOWERTOP/Shadowrocket/blob/main/lazy.conf):
   `name = wireguard, <server>, <port>, privateKey=…, publicKey=…, ip=…, udp=1[, presharedKey=…, mtu=…, reserved=r/r/r]`.

## Background — current state

- `Node` (`node.go`) has `Protocol`, `Server`, `Port`, `Name`, …, and a generic
  `Extra map[string]any` (used today only by `tuic`). `Supports`/renderers cover
  7 protocols; `wireguard` is not among them.
- `sharelink.go` `ParseShareLinks` dispatches on URI scheme to per-protocol
  parsers (`parseSS`/`parseVMess`/`parseURINode`). Helpers: `splitFragment`,
  `nameOr`, `b64decode`, `splitHostPort`, `countryFlag` (in node.go).
- `render_surge.go`: `SurgeRenderer.Render(im, subURL, rulesetBase)` builds
  `[General]/[Proxy]/[Proxy Group]/[Rule]/[MITM]`; `proxyLine(n)` returns one
  proxy line. `ShadowRocketRenderer struct{ SurgeRenderer }` overrides only
  `Target()` — it currently inherits `Render` verbatim.
- `render_clash.go`: `clashProxy(n)` maps a node to a mihomo proxy map;
  `ClashRenderer.Supports` lists the 7 protocols.

## `Node.Extra` keys for WireGuard

`Protocol = "wireguard"`, `Server`/`Port` = endpoint, `Name` from fragment +
flag. `Extra` holds:

| Key | Type | From | Notes |
|-----|------|------|-------|
| `private_key` | string | `privateKey`/`private_key` | required |
| `public_key` | string | `publicKey`/`public_key` | required (peer) |
| `preshared_key` | string | `presharedKey`/`preshared_key` | optional |
| `ip` | string | `ip`/`address` | self-ip, no CIDR (e.g. `10.254.253.3`) |
| `reserved` | string | `reserved` | raw `"0,0,0"` (optional) |
| `mtu` | int | `mtu` | optional, omit when 0 |
| `udp` | bool | `udp` | `true` unless `udp=0`; WireGuard is UDP |

## Parser (`sharelink.go`)

Add dispatch: `wg://` and `wireguard://` → `parseWireGuard`.

```go
func parseWireGuard(line string) (Node, error)
```
- `splitFragment` → name; `url.Parse` the body; `Server=u.Hostname()`,
  `Port=atoi(u.Port())` (error → warning/skip).
- Read query (camelCase + snake_case aliases) into `Extra` per the table.
- `udp`: `Extra["udp"] = q.Get("udp") != "0"` (default true).
- `mtu`: parse if present.
- Name: `withFlag(q.Get("flag"), fragmentName)` — if `flag` set and
  `countryFlag(flag) != ""`, prepend the emoji + space (so `flag=CN` + `#WG`
  → `🇨🇳 WG`); otherwise the fragment (or `server:port`).
- Require `private_key` and `public_key`, else return an error (→ warning, skip).

New helpers: `withFlag(flag, name string) string`; a small `firstNonEmpty(...string) string`
for the camel/snake aliases. `countryFlag` already exists in `node.go`.

## Clash rendering (`render_clash.go`)

Add `"wireguard"` to `Supports`, and a `clashProxy` case producing the mihomo
single-peer shape (field spellings verified against the mihomo docs):

```yaml
- name: 🇨🇳 WG
  type: wireguard
  server: home.hg.ht
  port: 51820
  private-key: <priv>
  public-key: <pub>
  pre-shared-key: <psk>          # only if present
  ip: 10.254.253.3/32            # append /32 if Extra ip lacks a CIDR
  allowed-ips: ['0.0.0.0/0', '::/0']
  reserved: [0, 0, 0]            # only if Extra reserved present; "0,0,0" → []int
  mtu: 1408                      # only if present
  udp: true
```

`reserved` parsing: split `"0,0,0"` on `,`, atoi each → `[]int`; skip if not 3
valid ints.

## Surge rendering (`render_surge.go`) — separate section

`Supports("wireguard") = true`. WireGuard needs a `[Proxy]` reference line plus a
trailing `[WireGuard <section>]` block. Section names must be plain identifiers
(node names contain emoji/spaces), so assign sequential `wg0`, `wg1`, … in node
order.

- `[Proxy]` line: `🇨🇳 WG = wireguard, section-name=wg0`
- trailing block (after `[Rule]`/`[MITM]`):
  ```
  [WireGuard wg0]
  private-key = <priv>
  self-ip = 10.254.253.3
  mtu = 1408                     # only if present
  peer = (public-key = <pub>, allowed-ips = "0.0.0.0/0, ::/0", endpoint = home.hg.ht:51820, preshared-key = <psk>)
  ```
  `preshared-key` omitted from the `peer(...)` when absent. **`reserved` is
  dropped** (Surge has no field for it; the WARP-only field is meaningless for a
  plain WireGuard peer, and the sample value is `0,0,0`).

## ShadowRocket rendering — inline `[Proxy]` line

ShadowRocket does **not** use a `[WireGuard]` section; it takes an inline proxy
line (confirmed via the user's reference `lazy.conf`):

```
🇨🇳 WG = wireguard, home.hg.ht, 51820, privateKey=<priv>, publicKey=<pub>, ip=10.254.253.3, udp=1, presharedKey=<psk>, mtu=1408, reserved=0/0/0
```
- `presharedKey`/`mtu` omitted when absent.
- `reserved` comma→slash: `"0,0,0"` → `0/0/0` (only if present).
- No `allowed-ips` (the reference omits it; full-tunnel implied).

### Renderer refactor to support the Surge/ShadowRocket divergence

`ShadowRocketRenderer` can no longer inherit `Render` verbatim (its WG handling
differs). Extract the shared body into a parameterized method and give each
renderer a thin `Render`:

```go
func (r *SurgeRenderer) Render(im Intermediate, subURL, rulesetBase string) string {
	return r.render(im, subURL, rulesetBase, false) // wgInline=false → [WireGuard] section
}
func (r *ShadowRocketRenderer) Render(im Intermediate, subURL, rulesetBase string) string {
	return r.render(im, subURL, rulesetBase, true)  // wgInline=true → inline [Proxy] line
}
func (r *SurgeRenderer) render(im Intermediate, subURL, rulesetBase string, wgInline bool) string { … }
```

`ShadowRocketRenderer` still embeds `SurgeRenderer` (for `Supports`, `proxyLine`,
`groupLine`, etc.); only `Target()` and `Render()` are overridden. Calling
`r.render(...)` from `ShadowRocketRenderer.Render` invokes the embedded method
with the explicit `wgInline=true` argument (no virtual-dispatch reliance).

In `render`:
- Track a WG counter while emitting `[Proxy]`. For each `wireguard` node: if
  `wgInline`, emit the inline ShadowRocket line; else emit
  `<name> = wireguard, section-name=wg<N>` and record `(node, "wg<N>")`.
- Non-WG nodes: `proxyLine(n)` as today.
- After the rule/MITM output: if `!wgInline`, emit a `[WireGuard wg<N>]` block
  per recorded WG node.
- WG proxy/section formatting lives in small helpers
  (`surgeWGProxyRef`, `surgeWGSection`, `shadowrocketWGLine`).

Non-WG output is byte-identical for both targets (regression-guarded).

## Group membership

WG nodes are ordinary `Node`s → they join `PROXY`/`Auto Select`/category groups
by `Name`. Group members reference the WG node's name, which matches the proxy
definition's name in every target. No change to `Assemble`.

## Testing

- `sharelink_test.go`: parse the user's `wg://…` link → `Protocol=="wireguard"`,
  `Server`/`Port`, `Extra` keys (private_key/public_key/preshared_key/ip/
  reserved/udp), name `🇨🇳 WG`; a `wg://` missing `privateKey` → warning, skipped.
- `render_clash_test.go`: a WG node → YAML has `type: wireguard`, `private-key`,
  `public-key`, `ip: …/32`, `allowed-ips`, `reserved: [0, 0, 0]`, `udp: true`.
- `render_surge_test.go`: WG node (surge) → `[Proxy]` line
  `… = wireguard, section-name=wg0` AND a `[WireGuard wg0]` block with
  `private-key`/`self-ip`/`peer = (public-key = …, endpoint = host:port, …)`.
- `render_shadowrocket_test.go`: WG node (shadowrocket) → inline
  `… = wireguard, host, port, privateKey=…, publicKey=…, ip=…, udp=1[, reserved=0/0/0]`
  AND **no** `[WireGuard` section; assert a non-WG node still renders identically
  to Surge.

## Compatibility / migration

- Uses only `Node.Extra` — no `Node` struct change, no `TemplateSpec` change, no
  DB migration.
- `ShadowRocketRenderer.Render` override changes only WG handling; all existing
  Surge/ShadowRocket output (no WG nodes) is unchanged and regression-tested.

## Out of scope (deferred)

- Multi-peer WireGuard (`peers:` list) — single-peer only.
- WireGuard `dns`/`keepalive`/`amnezia` options beyond what `wg://` carries.
- `reserved` for Surge (no field).
- IPv6 self-ip (`ipv6`) — only `ip` (v4) is parsed from `wg://`.
