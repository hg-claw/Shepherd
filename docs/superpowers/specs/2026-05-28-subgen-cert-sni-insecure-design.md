# Subgen: auto skip-cert-verify on cert/SNI mismatch (sing-box) — Design

**Date:** 2026-05-28
**Status:** Approved (rules confirmed via Q&A)

## Goal

For managed **sing-box** inbounds, automatically decide `skip-cert-verify` in the
generated subscription by comparing the inbound's **certificate domain** against
its **SNI**. Match → secure (no skip). Mismatch (e.g. a camouflage SNI like
`www.bing.com` over a cert for `vpn.example.com`) → emit `skip-cert-verify`.

## Background (verified)

- `singbox_certificates` has a single `domain TEXT NOT NULL UNIQUE` per cert
  (`certs.go:13`, migration `0004`). All certs are ACME (Let's Encrypt,
  http-01 or dns-01-cf) — dns-01-cf can issue **wildcard** certs.
- Cert-based sing-box protocols reference `cert_id`: vless-ws/h2/httpupgrade-tls,
  vmess-*-tls, trojan-*-tls, hysteria2, tuic-v5, anytls (`render.go` → `certPaths`).
  **vless-reality** uses no cert (reality handshake) — must never get skip.
- subgen's `collectSingbox` does **not** currently join certs or set
  `Node.Insecure`. `Node.Insecure` (set today only by the share-link parser)
  drives `skip-cert-verify` across Surge (vmess/trojan/vless + now anytls/hy2/
  tuic), Clash, and ShadowRocket (inherits Surge).
- The forward-relay path (just shipped) builds a node from the **upstream
  landing's** protocol/creds/SNI; the TLS terminates at the landing, so the
  relevant cert is the landing's (`u.cert_id`), compared to the upstream SNI.

## Match rule (confirmed)

`certMatchesSNI(certDomain, sni string) bool` — case-insensitive (lowercase
both, trim surrounding whitespace):
1. Exact: `sni == certDomain` → match.
2. Wildcard: `certDomain` begins with `*.` → matches `sni` iff `sni` is a
   **single-label** subdomain of the base. I.e. let `base = certDomain[1:]`
   (the `.example.com` part incl. the leading dot); `sni` matches iff
   `strings.HasSuffix(sni, base)` AND the label before `base`
   (`sni[:len(sni)-len(base)]`) is non-empty and contains no `.`.
   - `*.example.com` matches `a.example.com`; does **not** match `example.com`
     (apex) or `a.b.example.com` (multi-label).
3. Otherwise → no match.

Empty `certDomain` or empty `sni` → treated as "cannot compare" by the caller
(see below), not passed to a match decision.

## Insecure decision (per node, in `collectSingbox`)

```
certDomain, sni := <relevant cert domain>, <relevant sni>
insecure := certDomain != "" && sni != "" && !certMatchesSNI(certDomain, sni)
```

- **Direct landing / proxy-mode relay**: `certDomain` = own cert
  (`singbox_certificates` via `i.cert_id`), `sni` = `i.sni`.
- **Forward-mode relay**: `certDomain` = upstream landing's cert
  (`uc` via `u.cert_id`), `sni` = upstream SNI (`u.sni`) — matching the creds the
  relay node already carries.
- **No cert** (cert_id NULL → `certDomain == ""`; reality, plain vmess,
  shadowsocks) → `insecure = false`.
- **Empty SNI** (even with a cert) → `insecure = false` (conservative,
  confirmed). The cert-based protocols normally always set SNI.

The resulting `insecure` is carried on the node and the renderers emit
`skip-cert-verify` exactly as they do for share-link insecure nodes.

## Implementation (subgen only)

`internal/plugins/subgen/collect.go`:
- `singboxRow`: add `CertDomain sql.NullString \`db:"cert_domain"\`` and
  `UpCertDomain sql.NullString \`db:"upstream_cert_domain"\``.
- `collectSingbox` query: add
  `LEFT JOIN singbox_certificates c  ON c.id = i.cert_id` selecting
  `c.domain AS cert_domain`, and
  `LEFT JOIN singbox_certificates uc ON uc.id = u.cert_id` selecting
  `uc.domain AS upstream_cert_domain`.
- New helper `certMatchesSNI(certDomain, sni string) bool` (in `collect.go` or
  `node.go`).
- Compute `insecure` in each build branch (forward-relay uses `UpCertDomain` +
  upstream SNI; the own-fields branch uses `CertDomain` + `i.sni`) and pass it
  into the node via a new `singboxLite.Insecure bool` field;
  `singboxInboundToNode` sets `n.Insecure = in.Insecure`.

No DB schema change. No UI change. xray untouched (no managed cert table —
xray uses reality/ws). share-link nodes are unaffected (they keep their own
parsed `Insecure`).

## Testing

**Helper (`certMatchesSNI`):** exact match (incl. case-insensitive); wildcard
matches single-label subdomain; wildcard does NOT match apex or multi-label;
mismatch; empty inputs.

**`collectSingbox` (hand-rolled `singbox_inbounds` + `singbox_certificates`):**
- cert domain == SNI → node `Insecure == false`.
- cert domain != SNI (camouflage) → node `Insecure == true`.
- wildcard cert + subdomain SNI → `Insecure == false`.
- cert present, SNI empty → `Insecure == false`.
- no cert (cert_id NULL, e.g. vless-reality) → `Insecure == false`.
- forward relay whose **landing** has cert==SNI → relay node `Insecure == false`;
  landing cert != landing SNI → relay node `Insecure == true`.

(subgen tests hand-roll these tables, as established; add a
`singbox_certificates(id INTEGER PRIMARY KEY, domain TEXT)` table and a
`cert_id INTEGER` column on the inline `singbox_inbounds` DDL where needed.)

## Out of scope

- xray inbounds (no managed cert system).
- Validating cert expiry/status (only domain-vs-SNI is compared).
- A manual per-inbound override (the auto rule is the whole feature; share-link
  nodes still carry their own explicit `insecure`).
