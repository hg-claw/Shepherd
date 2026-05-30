# Subgen: Clash `DOMAIN-SET` → `RULE-SET` (behavior domain) — Design

**Date:** 2026-05-30
**Status:** Approved (scope confirmed)

## Problem

A subgen custom rule `DOMAIN-SET,<url>,<policy>` (a Surge/ShadowRocket remote
domain-list directive, e.g. pointing at blackmatrix7's
`rule/Shadowrocket/Advertising/Advertising_Domain.list`) is emitted **verbatim**
into the Clash config by `render_clash.go`'s custom-rule path. Clash/mihomo has
no `DOMAIN-SET` rule type and rejects the config at load:
`error: unsupported rule type: DOMAIN-SET`.

Surge and ShadowRocket are unaffected — `surgeRuleLine`'s default case passes the
`Match` through verbatim and `DOMAIN-SET` is native there. So this is **Clash-only**.

## Background (verified)

- `render_clash.go` rules loop: a custom rule (`rl.Match != ""`, the `default:`
  case) currently does `rules = append(rules, rl.Match+","+rl.Target)` — verbatim.
- The existing remote-category path builds a `rule-providers` entry
  `{type:http, behavior:classical, format:yaml|text, url, path, interval:86400}`
  and a `RULE-SET,<name>,<policy>` rule, deduping by provider name. This is the
  pattern to follow — but DOMAIN-SET needs `behavior: domain`, not classical.
- Clash's equivalent of a Surge `DOMAIN-SET` (a pure domain list) is a
  **rule-provider with `behavior: domain`**. blackmatrix7 ships the Clash variant
  at `rule/Clash/<Cat>/<Cat>_Domain.yaml` — a `payload:` list of bare domains
  (`+.` for suffixes) = domain behavior. Verified the user's file exists:
  `…/rule/Clash/Advertising/Advertising_Domain.yaml`.
- The Shadowrocket `.list` and Clash `_Domain.yaml` are NOT interchangeable
  (Shadowrocket uses leading-dot `.example.com` suffixes; Clash domain behavior
  uses `+.example.com`), so Clash must consume the **Clash** file — hence the URL
  rewrite, not a raw passthrough.

## Change (Clash renderer only)

In `internal/plugins/subgen/render_clash.go`, the custom-rule `default:` case
(`rl.Match`) gains a `DOMAIN-SET` branch:

1. **Detect**: `strings.HasPrefix(strings.ToUpper(strings.TrimSpace(rl.Match)), "DOMAIN-SET,")`.
2. **Parse**: split `rl.Match` on the first comma → `<url>` (trimmed). If the URL
   is empty, fall back to verbatim (defensive; never panics).
3. **Rewrite to the Clash file** (best-effort) via a small pure helper
   `clashDomainSetURL(url string) string`:
   - replace `/rule/Shadowrocket/` → `/rule/Clash/`
   - if the URL ends with `.list`, replace the suffix with `.yaml`
   - otherwise leave the URL unchanged (a non-blackmatrix7 URL has no known Clash
     equivalent; it's emitted as-is and the operator supplies a Clash-format file).
4. **Provider**: derive a name from the rewritten URL's last path segment without
   extension (`Advertising_Domain`), sanitized to `[A-Za-z0-9_-]` (other runs →
   `_`). Add to the existing `providers` map (dedup by name):
   `{type:http, behavior:"domain", format:<"yaml" if .yaml/.yml else "text">,
     url:<clash-url>, path:"./ruleset/<name>.<ext>", interval:86400}`.
5. **Rule**: append `RULE-SET,<name>,<policy>` to `rules` (NOT the verbatim
   `DOMAIN-SET`).

Non-`DOMAIN-SET` custom rules keep the existing verbatim behavior.

### Example
Custom rule `Match="DOMAIN-SET,https://…/rule/Shadowrocket/Advertising/Advertising_Domain.list"`, `Policy="Ad Block"` →
```yaml
rule-providers:
  Advertising_Domain:
    type: http
    behavior: domain
    format: yaml
    url: https://…/rule/Clash/Advertising/Advertising_Domain.yaml
    path: ./ruleset/Advertising_Domain.yaml
    interval: 86400
rules:
  - RULE-SET,Advertising_Domain,Ad Block
```

## Out of scope

- Other Surge-only set directives (`RULE-SET,<url>` classical, `IP-CIDR-SET`,
  etc.) — only `DOMAIN-SET` was reported. The helper is small enough to extend
  later if needed.
- Surge / ShadowRocket rendering (unchanged — `DOMAIN-SET` is native).
- Validating that the rewritten Clash URL actually exists (best-effort transform;
  the operator owns non-blackmatrix7 URLs).

## Testing

- **Helper `clashDomainSetURL`** (pure, table): blackmatrix7 Shadowrocket `.list`
  → Clash `.yaml` (`/Shadowrocket/`→`/Clash/`, `.list`→`.yaml`); a non-matching
  URL is returned unchanged; a `.yaml` URL stays `.yaml`.
- **Clash render**: an Intermediate with a `DOMAIN-SET` custom rule renders a
  `rule-providers` entry with `behavior: domain` + the rewritten Clash URL, and a
  `RULE-SET,<name>,<policy>` rule; the output does NOT contain a verbatim
  `DOMAIN-SET,` rule (the bug).
- **Surge regression**: the same `DOMAIN-SET` custom rule still emits
  `DOMAIN-SET,<original-url>,<policy>` verbatim in the Surge `[Rule]` section
  (unchanged).
