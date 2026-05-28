# Subgen: forward-mode relays + Surge insecure — Design

**Date:** 2026-05-27
**Status:** Approved (scope confirmed via Q&A)

Two independent subgen subscription-output fixes.

---

## Part 1 — Surge `skip-cert-verify` for anytls / hysteria2 / tuic

### Problem
`Node.Insecure` is already parsed from share-link custom nodes
(`sharelink.go:227/231/242`: trojan `allowInsecure`, hysteria2/anytls
`insecure`). But the **Surge** renderer (`render_surge.go` `proxyLine`) only
emits `skip-cert-verify=true` for vmess/trojan/vless — the **anytls**,
**hysteria2**, and **tuic** cases never emit it, so a pasted
`anytls://…?insecure=1` node renders without `skip-cert-verify` and the client
rejects the self-signed/camouflage cert.

Clash (`render_clash.go`) already emits `skip-cert-verify` for anytls + hysteria2
but **not tuic**. ShadowRocket embeds `SurgeRenderer`, so it inherits the Surge
fix automatically.

### Change
- `render_surge.go` `proxyLine`: in the `anytls`, `hysteria2`, and `tuic` cases,
  append `, skip-cert-verify=true` when `n.Insecure` (placed after the `sni=`
  segment, matching the trojan/vless pattern).
- `render_clash.go` `clashProxy`: in the `tuic` case, set
  `p["skip-cert-verify"] = true` when `n.Insecure` (parity with anytls/hy2).
- No model change. No new field. The signal already flows from the share link.

### Scope notes
- Managed sing-box inbounds use ACME certs (trusted) → they never set `Insecure`,
  so this only affects custom share-link nodes that opt in via `?insecure=1`.
  That matches the confirmed use case.

---

## Part 2 — sing-box forward-mode relay nodes

### Problem
`collect.go` `collectSingbox` skips relays whose `role=="relay" &&
relay_mode=="forward"` (`"forward-mode relay not supported in subscriptions,
skipped"`). A forward-mode relay is a transparent dokodemo-style forwarder: the
client connects to the **relay's** IP:port but speaks the **landing's** protocol
and presents the **landing's** credentials (no per-relay keys). subgen's query
fetches only the relay's own row (which has no usable creds for forward mode), so
it cannot build the node — hence the skip.

proxy-mode sing-box relays and xray relays are **proxy-style** (relay terminates
its own protocol with its own keys), so the relay's own row fields are correct
and they already render. **Only sing-box forward-mode is the gap.**

### Change — `internal/plugins/subgen/collect.go`
1. Add a `LEFT JOIN singbox_inbounds u ON u.id = i.upstream_inbound_id` to the
   `collectSingbox` query, selecting the upstream landing's creds:
   `u.protocol, u.uuid, u.flow, u.password, u.sni, u.reality_public_key,
   u.reality_short_id, u.transport_path, u.transport_host, u.ss_method,
   u.extra_json` (aliased `upstream_*`). Add matching `sql.NullString` fields to
   `singboxRow`.
   (subgen reads the DB directly, as established — this mirrors the singbox
   plugin's `ListAllWithUpstream`, plus `upstream_flow` which `InboundView`
   omits but a vless-reality relay needs.)
2. In `collectSingbox`, replace the forward-relay skip with: build the node from
   the **upstream** landing's fields but the **relay's own** server/port:
   - If `role=="relay" && relay_mode=="forward"`:
     - If the upstream join is NULL (landing deleted) → skip with warning
       `"singbox <tag> on <srv>: forward relay upstream landing missing, skipped"`.
     - Else populate `singboxLite` with `Protocol/UUID/Flow/Password/SNI/
       RealityPublicKey/RealityShortID/TransportPath/TransportHost/SSMethod/
       ExtraJSON` from the `upstream_*` columns, and `Alias`/`Tag` from the
       relay's own row.
     - `serverLite` stays the **relay's own** server (`srv_name/srv_host/
       srv_country`) — so the node connects to the relay's IP:port and is named
       by the relay's location.
   - Otherwise (landing, or proxy-mode relay) → unchanged (relay/landing's own
     fields, as today).
3. `singboxInboundToNode` is unchanged — it just receives upstream-sourced
   `singboxLite` values for the forward-relay case. The existing
   `aliasOrDefault` names it from the relay's alias or relay server+country +
   the (upstream) protocol.

### Why server stays the relay's
A forward relay's whole point is a different entry IP (the relay) into the same
landing. The TLS/REALITY handshake still targets the landing's SNI/keys (carried
in `upstream_*`), but the TCP endpoint is the relay's `host:port`.

### Out of scope
- xray relays (proxy-style, already render).
- proxy-mode sing-box relays (already render).
- Auto-including a landing's relays on landing selection — the confirmed model is
  **explicit** relay selection (admin ticks the relay inbound).
- No DB schema change; no change to the singbox/xray plugins.

---

## Testing

**Part 1 (render):**
- `render_surge_test.go`: an `anytls` node with `Insecure:true` →
  line contains `skip-cert-verify=true`; without `Insecure` → absent. Same for
  `hysteria2` and `tuic`. (ShadowRocket inherits — optionally assert via
  `ShadowRocketRenderer`.)
- `render_clash_test.go`: a `tuic` node with `Insecure:true` →
  `skip-cert-verify: true` in the proxy map.

**Part 2 (collect):**
- `collect_test.go`: seed a landing (e.g. vless-reality with uuid/sni/reality
  keys) and a forward-mode relay (`role='relay'`, `relay_mode='forward'`,
  `upstream_inbound_id`=landing, own server host/port) → `CollectNodes` returns a
  node whose `Server`/`Port` are the **relay's** and whose
  `Protocol`/`UUID`/`SNI`/`RealityPublicKey` are the **landing's**.
- A forward relay with a missing/deleted upstream → skipped with a warning (no
  node, no error).
- Regression: a proxy-mode relay still renders from its own fields; a landing is
  unaffected.
