# Inbound Password "Random" Generator Design

**Date:** 2026-05-27
**Status:** Approved (scope confirmed via Q&A)

## Goal

Add a one-click **Random** generator (a small `new` button, mirroring the
existing UUID `new` button) next to password/key fields in the admin inbound
dialogs, so operators don't hand-type secrets.

## Scope (confirmed)

- **sing-box `InboundDialog`**
  - Generic **Password** field (trojan / hysteria2 / tuic / anytls): add `new` →
    random password.
  - **Shadowsocks "Password (base64)"** field: add `new` → **method-aware** key.
    sing-box offers only SS2022 methods, whose key must be an exact-length
    standard-base64 value (16 bytes for `…aes-128-gcm`, 32 bytes otherwise).
- **xray `InboundDialog`** — the Shadowsocks option currently renders **no**
  fields (stub). Build out the Shadowsocks form (method dropdown + password
  input) wired into create/patch, then add the `new` button. xray accepts both
  legacy (arbitrary password) and 2022 (fixed-length base64 key) methods, so the
  generator is method-aware here too.

xray has no generic Password field (only vless-reality / vmess-ws / shadowsocks),
so only its SS field gets the button.

## Background (verified)

- UUID already has a `new` button: `onClick={() => setUUID(randomUUID())}`
  (`randomUUID` from `xray/templates.ts`). We mirror this exactly.
- `randomPassword()` (24 random bytes → base64url, no padding) is **duplicated**
  in `singbox/BulkRelayDialog.tsx:25` and `xray/BulkRelayDialog.tsx:25`. It is
  not in the shared `templates.ts`.
- xray backend (`render.go:139`, `config.go:169`) passes `ss_method`/`ss_password`
  through unchanged — no method/key validation. Tests/bulk-relay use
  `aes-256-gcm`.
- `XrayInbound` (GET response) has **no** `ss_password` (redacted like
  `private_key`); `CreateXrayInboundBody`/`PatchXrayInboundBody` already have
  optional `ss_method`/`ss_password`.

## Design

### Shared helpers — `web/src/pages/admin/plugins/xray/templates.ts`

Add (and export):

- `randomPassword(): string` — 24 random bytes → URL-safe base64, no padding.
  Moved here from the two BulkRelayDialog copies; both import it instead (DRY,
  byte-identical, no behaviour change).
- `randomSSKey(method: string): string` — method-aware Shadowsocks key:
  - If `method` starts with `2022-blake3-`: generate exactly 16 bytes when the
    method contains `aes-128`, else 32 bytes; encode as **standard** base64
    (with padding) — a valid SS2022 key.
  - Otherwise (legacy methods): return `randomPassword()` (arbitrary string is
    fine for legacy).

### sing-box `InboundDialog.tsx`

- Password field (`needsPassword`): wrap input + a `new` Button →
  `setPassword(randomPassword())`. Same markup as the UUID row.
- SS field: add a `new` Button next to "Password (base64)" →
  `setSSPassword(randomSSKey(ssMethod))` (method-aware; SS_METHODS are all 2022).

### xray `InboundDialog.tsx`

- New state: `ssMethod` (default `'aes-256-gcm'`, from `editing?.ss_method`),
  `ssPassword` (default `''` — not returned in GET).
- `XRAY_SS_METHODS` constant: legacy + 2022, e.g.
  `['aes-256-gcm','aes-128-gcm','chacha20-poly1305','xchacha20-poly1305',
    '2022-blake3-aes-128-gcm','2022-blake3-aes-256-gcm','2022-blake3-chacha20-poly1305']`,
  default `aes-256-gcm`.
- Render an SS block when `protocol === 'shadowsocks'`: a Method `<select>` +
  a Password `<Input>` + a `new` Button → `setSSPassword(randomSSKey(ssMethod))`.
- Create body: when `protocol === 'shadowsocks'`, include
  `ss_method: ssMethod, ss_password: ssPassword`.
- Patch body: `ss_method: ssMethod !== editing.ss_method ? ssMethod : undefined`;
  `ss_password: ssPassword || undefined` (only send if generated/typed — mirrors
  `private_key` handling, since the existing value isn't returned).

## Testing

- sing-box `InboundDialog.test.tsx`: clicking Password `new` fills the password
  input (non-empty); clicking SS `new` fills the SS field; assert the generated
  SS key decodes to the right byte length for the selected SS2022 method.
- xray `InboundDialog.test.tsx`: selecting Shadowsocks renders Method + Password;
  create sends `ss_method`/`ss_password`; SS `new` fills the password.
- `templates`: unit-test `randomSSKey` byte lengths (16 vs 32) for 2022 methods
  and that legacy falls back to a non-empty string.
- Update the two BulkRelayDialog files (and any affected tests) to import
  `randomPassword` from `templates` instead of the local copy.

## Out of Scope (YAGNI)

- Changing bulk-relay's SS password behaviour (it keeps using `randomPassword`;
  only the import source changes).
- A copy-to-clipboard affordance on the generated value.
- Backend changes (none needed — DTOs and rendering already support SS).
