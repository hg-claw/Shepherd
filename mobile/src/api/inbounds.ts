import { useQuery, type UseQueryResult, type QueryClient } from '@tanstack/react-query'
import { authedFetch } from './authed'
import { APIError } from './client'
import { useAuth } from '../store/auth'
import type { ProxyPluginID } from './plugins'

// ─────────────────────────────────────────────────────────────────────────────
// Shared sing-box + xray inbounds API.
//
// Both plugins expose IDENTICAL /inbounds shapes (the Go handler runs the same
// inboundToMap for either), so this file is keyed by plugin id and serves both.
// The mobile ProxyInbound subset in api/plugins.ts is read-only (status view);
// here we WIDEN it into ProxyInboundFull carrying every editable field as one
// shared OPTIONAL type — singbox-only fields and xray-only fields are simply
// absent on the other.
//
// Wire gotchas baked into the types below:
//   • sing-box *T omitempty pointer fields (uuid/password/sni/flow/transport_*/
//     reality_*/alter_id/ss_method/extra_json) serialize as JSON null when nil.
//     xray returns the SAME logical fields as plain (possibly empty) strings.
//     We treat null/undefined/'' equivalently → all optional.
//   • reality_private_key / private_key are ALWAYS the literal "[REDACTED]" on
//     GET — never trust them, never echo them back on PATCH.
//   • cert_id / upstream_inbound_id (sing-box) are *int64 with NO omitempty →
//     `number | null` (present-but-null), so null-check explicitly.
//   • upstream_tag / upstream_server_id / upstream_server_name are sql.Null* in
//     Go but the handler UNWRAPS them, so on the wire they are bare
//     string|number OR the key is absent — read directly, do NOT use nullStr().
// ─────────────────────────────────────────────────────────────────────────────

export type { ProxyPluginID } from './plugins'

export type InboundRole = 'landing' | 'relay'

export type ProxyInboundFull = {
  id: number
  server_id: number
  server_name: string
  tag: string
  alias: string
  port: number
  role: InboundRole
  protocol: string

  // identity / secrets (sing-box: *T null-or-present; xray: plain strings)
  uuid?: string | null
  flow?: string | null
  password?: string | null
  sni?: string | null

  // REALITY (sing-box uses reality_* keys; xray uses bare public_key/short_id)
  reality_public_key?: string | null
  reality_short_id?: string | null
  reality_handshake_server?: string | null
  reality_handshake_port?: number | null
  // xray REALITY keys
  public_key?: string | null
  short_id?: string | null

  // transport (sing-box) / ws (xray)
  transport_type?: string | null
  transport_path?: string | null
  transport_host?: string | null
  ws_path?: string | null

  // vmess
  alter_id?: number | null

  // shadowsocks
  ss_method?: string | null

  // sing-box-only
  cert_id?: number | null
  extra_json?: string | null
  relay_mode?: 'proxy' | 'forward'

  // relay upstream join (handler-unwrapped: bare value or absent — NOT nullStr)
  upstream_inbound_id?: number | null
  upstream_tag?: string
  upstream_server_id?: number
  upstream_server_name?: string

  created_at?: string
  updated_at?: string
}

function basePath(plugin: ProxyPluginID): string {
  return `/api/admin/plugins/${plugin}/inbounds`
}

// listInbounds GETs the inbound list, optionally filtered by server_id.
export function listInbounds(plugin: ProxyPluginID, serverId?: number): Promise<ProxyInboundFull[]> {
  const qs = serverId != null ? `?server_id=${serverId}` : ''
  return authedFetch<ProxyInboundFull[]>(`${basePath(plugin)}${qs}`)
}

// useInbounds is the list query for the inbounds screen. Unfiltered (we group by
// server_id client-side from the full set, matching the web tab).
export function useInbounds(plugin: ProxyPluginID): UseQueryResult<ProxyInboundFull[]> {
  return useQuery({
    queryKey: ['plugin-inbounds', plugin],
    queryFn: () => listInbounds(plugin),
  })
}

// invalidateInbounds re-runs the list (+ host status) after a mutation. Called
// from the form screen after create/patch and the list after delete.
export function invalidateInbounds(qc: QueryClient, plugin: ProxyPluginID): void {
  void qc.invalidateQueries({ queryKey: ['plugin-inbounds', plugin] })
  void qc.invalidateQueries({ queryKey: ['plugin-hosts', plugin] })
}

// ─── create ──────────────────────────────────────────────────────────────────
// Tag is server-generated (store.GenerateTag) — NEVER send it. Create is always
// role=landing on mobile (relays are a web-only flow). extra_json is omitted —
// the Go side decodes json key "extra" so the web "extra_json" key is a no-op,
// and mobile has no use for it.

export type CreateInboundBody = Record<string, unknown> & {
  server_id: number
  port: number
  role: InboundRole
  protocol: string
}

export function createInbound(plugin: ProxyPluginID, body: CreateInboundBody): Promise<ProxyInboundFull> {
  return authedFetch<ProxyInboundFull>(basePath(plugin), { method: 'POST', body })
}

// ─── patch ───────────────────────────────────────────────────────────────────
// PATCH applies only the keys present in the body — presence is the intent to
// change. A redacted/empty private key is never sent (see the form): sing-box
// ignores empty, but xray does NOT guard empty so an empty private_key WIPES the
// stored key and breaks REALITY.

export type PatchInboundBody = Record<string, unknown>

export function patchInbound(plugin: ProxyPluginID, id: number, body: PatchInboundBody): Promise<ProxyInboundFull> {
  return authedFetch<ProxyInboundFull>(`${basePath(plugin)}/${id}`, { method: 'PATCH', body })
}

// ─── delete ──────────────────────────────────────────────────────────────────
// sing-box returns 204 (empty body); xray returns 200 {ok:true}. BOTH return 409
// {error, relay_inbound_ids:[…]} when deleting a landing that still has relay
// dependents. The shared apiFetch only surfaces `.error` from an error body, so
// we do our own fetch here to recover relay_inbound_ids for the UI.

export class DeleteInboundConflict extends Error {
  constructor(message: string, public relayInboundIDs: number[]) {
    super(message)
    this.name = 'DeleteInboundConflict'
  }
}

export async function deleteInbound(plugin: ProxyPluginID, id: number): Promise<void> {
  const { baseURL, token } = useAuth.getState()
  if (!baseURL) throw new APIError(401, 'not signed in')
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${baseURL}${basePath(plugin)}/${id}`, { method: 'DELETE', headers })
  if (res.ok) return // 204 (sing-box) or 200 {ok:true} (xray) — body ignored

  let body: { error?: string; relay_inbound_ids?: number[] } | null = null
  try { body = await res.json() } catch { body = null }
  if (res.status === 401) await useAuth.getState().clearSession()
  if (res.status === 409) {
    throw new DeleteInboundConflict(
      body?.error || 'Landing has relay dependents — delete them first.',
      body?.relay_inbound_ids ?? [],
    )
  }
  throw new APIError(res.status, body?.error || `request failed (${res.status})`)
}

// ─── REALITY key helpers ───────────────────────────────────────────────────────
// These crypto endpoints live under the XRAY namespace and are shared crypto, so
// the sing-box form calls them too (per spec).

export type X25519KeyPair = { private_key: string; public_key: string }

export function generateX25519(): Promise<X25519KeyPair> {
  return authedFetch<X25519KeyPair>('/api/admin/plugins/xray/keys/x25519', { method: 'POST', body: {} })
}

export function generateShortID(): Promise<{ short_id: string }> {
  return authedFetch<{ short_id: string }>('/api/admin/plugins/xray/keys/short-id', { method: 'POST', body: {} })
}

// ─── random helpers (RN-safe, no Hermes Intl/crypto deps) ──────────────────────
// Hermes lacks crypto.getRandomValues in some builds; Math.random is sufficient
// for a default UUID / port / secret the admin can regenerate. (Reality keys come
// from the server endpoint above, not these.)

export function randomUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function randB64(nBytes: number): string {
  // base64 of nBytes random bytes; uses Math.random per byte. Standard alphabet
  // with padding (SS2022 wants exact-length standard base64).
  let bits = ''
  for (let i = 0; i < nBytes; i++) {
    bits += ((Math.random() * 256) | 0).toString(2).padStart(8, '0')
  }
  let out = ''
  for (let i = 0; i < bits.length; i += 6) {
    const chunk = bits.slice(i, i + 6).padEnd(6, '0')
    out += B64[parseInt(chunk, 2)]
  }
  while (out.length % 4 !== 0) out += '='
  return out
}

// randomPassword: 24 random bytes URL-safe base64 (no padding) — matches the web
// trojan/hysteria2/tuic/anytls/legacy-ss helper.
export function randomPassword(): string {
  return randB64(24).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

// randomSSKey: SS2022 (2022-blake3-*) needs an exact-length STANDARD base64 key
// (16 bytes for aes-128, else 32); legacy methods accept any string.
export function randomSSKey(method: string): string {
  if (!method.startsWith('2022-blake3-')) return randomPassword()
  return randB64(method.includes('aes-128') ? 16 : 32)
}

// ─── share-URL builders (ported from web; no Intl, no btoa dependency) ─────────
// b64encode is a pure UTF-8-safe base64 encoder (Hermes has no global btoa).

function b64encode(input: string): string {
  // Encode the string as UTF-8 bytes, then base64 those.
  const bytes: number[] = []
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i)
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const lo = input.charCodeAt(++i)
      code = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00)
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? B64[b2 & 63] : '='
  }
  return out
}

// qs builds a query string from ordered [key,value] pairs (RFC3986 component
// encoding, '%20' for spaces — matches URLSearchParams which web relies on).
function qs(pairs: [string, string][]): string {
  return pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
}

// The 18 sing-box protocols with implemented share-URL builders.
export const SINGBOX_URL_PROTOCOLS = new Set([
  'vless-reality', 'vless-ws-tls', 'vless-h2-tls', 'vless-httpupgrade-tls',
  'vmess-tcp', 'vmess-http', 'vmess-quic', 'vmess-ws-tls', 'vmess-h2-tls', 'vmess-httpupgrade-tls',
  'trojan-tls', 'trojan-ws-tls', 'trojan-h2-tls', 'trojan-httpupgrade-tls',
  'hysteria2', 'tuic-v5', 'anytls', 'shadowsocks-2022',
])

// xray only builds share URLs for these two.
export const XRAY_URL_PROTOCOLS = new Set(['vless-reality', 'vmess-ws'])

// ─── protocol metadata + per-protocol field predicates ─────────────────────────
// Shared by the form (which fields to show + send) and the list (what's
// shareable). Ported from the web InboundDialog predicates.

export type SingboxProtocol = string

export const SINGBOX_PROTOCOLS: { value: string; label: string }[] = [
  { value: 'vless-reality', label: 'VLESS + REALITY' },
  { value: 'vless-ws-tls', label: 'VLESS + WS + TLS' },
  { value: 'vless-h2-tls', label: 'VLESS + H2 + TLS' },
  { value: 'vless-httpupgrade-tls', label: 'VLESS + HTTPUpgrade + TLS' },
  { value: 'vmess-tcp', label: 'VMess + TCP' },
  { value: 'vmess-http', label: 'VMess + HTTP' },
  { value: 'vmess-quic', label: 'VMess + QUIC' },
  { value: 'vmess-ws-tls', label: 'VMess + WS + TLS' },
  { value: 'vmess-h2-tls', label: 'VMess + H2 + TLS' },
  { value: 'vmess-httpupgrade-tls', label: 'VMess + HTTPUpgrade + TLS' },
  { value: 'trojan-tls', label: 'Trojan + TLS' },
  { value: 'trojan-ws-tls', label: 'Trojan + WS + TLS' },
  { value: 'trojan-h2-tls', label: 'Trojan + H2 + TLS' },
  { value: 'trojan-httpupgrade-tls', label: 'Trojan + HTTPUpgrade + TLS' },
  { value: 'hysteria2', label: 'Hysteria2' },
  { value: 'tuic-v5', label: 'TUIC v5' },
  { value: 'anytls', label: 'AnyTLS' },
  { value: 'shadowsocks-2022', label: 'Shadowsocks 2022' },
]

export const SINGBOX_SS_METHODS = [
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
]

export const XRAY_PROTOCOLS: { value: string; label: string }[] = [
  { value: 'vless-reality', label: 'VLESS + REALITY' },
  { value: 'vmess-ws', label: 'VMess + WS' },
  { value: 'shadowsocks', label: 'Shadowsocks' },
]

export const XRAY_SS_METHODS = [
  'aes-256-gcm', 'aes-128-gcm', 'chacha20-poly1305', 'xchacha20-poly1305',
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305',
]

export function needsUUID(p: string): boolean {
  return p.startsWith('vless-') || p.startsWith('vmess-') || p === 'tuic-v5'
}
export function needsPassword(p: string): boolean {
  return p.startsWith('trojan-') || p === 'hysteria2' || p === 'tuic-v5' || p === 'anytls'
}
export function needsSS(p: string): boolean {
  return p === 'shadowsocks-2022'
}
export function needsReality(p: string): boolean {
  return p === 'vless-reality'
}
export function needsCertAndSNI(p: string): boolean {
  // TLS protocols that use an ACME cert (not reality / ss2022 / vmess-tcp/http).
  if (needsReality(p) || needsSS(p)) return false
  return p.endsWith('-tls') || p === 'vmess-quic' || p === 'hysteria2' || p === 'tuic-v5' || p === 'anytls'
}
export function needsTransport(p: string): boolean {
  return p.includes('-ws-') || p.includes('-h2-') || p.includes('-httpupgrade-') || p === 'vmess-http'
}

// ─── cert expiry helpers (shared by the form's inline cert picker) ──────────────
// Ported from the status screen so the inbound form can render a cert's domain +
// expiry urgency inline without importing a sibling screen's component module.
// The wire `expires_at` is a plain RFC3339 string and, while a cert is still
// issuing, the Go ZERO time ("0001-01-01T00:00:00Z") — that must render as "—",
// never as a real (year-1) date. Hermes-safe: no Intl / toLocaleString.

export type CertUrgency = 'ok' | 'warn' | 'err' | 'neutral'

// certDaysLeft → whole days until expiry (floor), or null when the cert has no
// real expiry yet (zero time → epoch <= 0) or the string is unparseable.
export function certDaysLeft(expiresAt: string | null | undefined, now: number = Date.now()): number | null {
  if (!expiresAt) return null
  const ms = new Date(expiresAt).getTime()
  if (!isFinite(ms) || ms <= 0) return null
  return Math.floor((ms - now) / 86_400_000)
}

// certUrgency: expiry tone — <14d (or expired) err, <30d warn, else ok; unknown
// expiry → neutral. Matches the status screen's certTone thresholds.
export function certUrgency(days: number | null): CertUrgency {
  if (days == null) return 'neutral'
  if (days < 14) return 'err'
  if (days < 30) return 'warn'
  return 'ok'
}

// certExpiryLabel: short human label for a cert row ("—" while issuing, "expired",
// else "Nd left").
export function certExpiryLabel(days: number | null): string {
  if (days == null) return '—'
  if (days < 0) return 'expired'
  return `${days}d left`
}

// buildSingboxShareURL — ported 1:1 from web InboundsTab.buildSingboxShareURL.
// Returns null when the inbound lacks the secrets the URL needs (e.g. a redacted
// or relay-proxy row).
export function buildSingboxShareURL(i: ProxyInboundFull, hostname: string): string | null {
  if (!hostname || !i.port) return null
  const label = encodeURIComponent(`${i.server_name}/${i.tag}`)
  const p = i.protocol

  if (p === 'vless-reality') {
    if (!i.uuid || !i.reality_public_key) return null
    const q = qs([
      ['encryption', 'none'], ['security', 'reality'], ['sni', i.sni ?? ''],
      ['fp', 'chrome'], ['pbk', i.reality_public_key], ['sid', i.reality_short_id ?? ''],
      ['type', 'tcp'], ['flow', 'xtls-rprx-vision'],
    ])
    return `vless://${i.uuid}@${hostname}:${i.port}?${q}#${label}`
  }

  if (p === 'vless-ws-tls' || p === 'vless-h2-tls' || p === 'vless-httpupgrade-tls') {
    if (!i.uuid) return null
    const netMap: Record<string, string> = {
      'vless-ws-tls': 'ws', 'vless-h2-tls': 'http', 'vless-httpupgrade-tls': 'httpupgrade',
    }
    const q = qs([
      ['encryption', 'none'], ['security', 'tls'], ['sni', i.sni ?? i.transport_host ?? ''],
      ['fp', 'chrome'], ['type', netMap[p]], ['path', i.transport_path || '/'], ['host', i.transport_host ?? ''],
    ])
    return `vless://${i.uuid}@${hostname}:${i.port}?${q}#${label}`
  }

  if (p === 'vmess-tcp' || p === 'vmess-http' || p === 'vmess-quic' ||
      p === 'vmess-ws-tls' || p === 'vmess-h2-tls' || p === 'vmess-httpupgrade-tls') {
    if (!i.uuid) return null
    const netMap: Record<string, string> = {
      'vmess-tcp': 'tcp', 'vmess-http': 'tcp', 'vmess-quic': 'quic',
      'vmess-ws-tls': 'ws', 'vmess-h2-tls': 'h2', 'vmess-httpupgrade-tls': 'httpupgrade',
    }
    const tlsProtos = new Set(['vmess-ws-tls', 'vmess-h2-tls', 'vmess-httpupgrade-tls'])
    const obj = {
      v: '2', ps: `${i.server_name}/${i.tag}`, add: hostname, port: String(i.port),
      id: i.uuid, aid: String(i.alter_id ?? 0), scy: 'auto', net: netMap[p],
      type: p === 'vmess-http' ? 'http' : 'none', host: i.transport_host ?? '',
      path: i.transport_path || '/', tls: tlsProtos.has(p) ? 'tls' : '', sni: i.sni ?? i.transport_host ?? '',
    }
    return `vmess://${b64encode(JSON.stringify(obj))}`
  }

  if (p === 'trojan-tls' || p === 'trojan-ws-tls' || p === 'trojan-h2-tls' || p === 'trojan-httpupgrade-tls') {
    if (!i.password) return null
    const netMap: Record<string, string> = {
      'trojan-tls': 'tcp', 'trojan-ws-tls': 'ws', 'trojan-h2-tls': 'http', 'trojan-httpupgrade-tls': 'httpupgrade',
    }
    const pairs: [string, string][] = [['security', 'tls'], ['sni', i.sni ?? ''], ['type', netMap[p]]]
    if (p !== 'trojan-tls') {
      pairs.push(['path', i.transport_path || '/'], ['host', i.transport_host ?? ''])
    }
    return `trojan://${encodeURIComponent(i.password)}@${hostname}:${i.port}?${qs(pairs)}#${label}`
  }

  if (p === 'hysteria2') {
    if (!i.password || !i.sni) return null
    const q = qs([['sni', i.sni], ['insecure', '0']])
    return `hysteria2://${encodeURIComponent(i.password)}@${hostname}:${i.port}?${q}#${label}`
  }

  if (p === 'tuic-v5') {
    if (!i.uuid || !i.password || !i.sni) return null
    const q = qs([['congestion_control', 'bbr'], ['udp_relay_mode', 'native'], ['sni', i.sni]])
    return `tuic://${i.uuid}:${encodeURIComponent(i.password)}@${hostname}:${i.port}?${q}#${label}`
  }

  if (p === 'anytls') {
    if (!i.password) return null
    const pairs: [string, string][] = [['insecure', '0']]
    if (i.sni) pairs.push(['sni', i.sni])
    return `anytls://${encodeURIComponent(i.password)}@${hostname}:${i.port}?${qs(pairs)}#${label}`
  }

  if (p === 'shadowsocks-2022') {
    if (!i.ss_method || !i.password) return null
    const userinfo = b64encode(`${i.ss_method}:${i.password}`).replace(/=/g, '')
    return `ss://${userinfo}@${hostname}:${i.port}#${label}`
  }

  return null
}

// buildXrayShareURL — ported from web xray templates.buildShareURL. xray only
// supports vless-reality + vmess-ws.
export function buildXrayShareURL(i: ProxyInboundFull, hostname: string): string | null {
  if (!hostname || !i.port || !i.uuid) return null
  const label = `${i.server_name}/${i.tag}`

  if (i.protocol === 'vless-reality') {
    if (!i.public_key) return null
    const q = qs([
      ['encryption', 'none'], ['security', 'reality'], ['sni', i.sni ?? ''],
      ['fp', 'chrome'], ['pbk', i.public_key], ['sid', i.short_id ?? ''],
      ['type', 'tcp'], ['flow', 'xtls-rprx-vision'],
    ])
    return `vless://${i.uuid}@${hostname}:${i.port}?${q}#${encodeURIComponent(label)}`
  }

  if (i.protocol === 'vmess-ws') {
    const obj = {
      v: '2', ps: label, add: hostname, port: String(i.port),
      id: i.uuid, aid: '0', scy: 'auto', net: 'ws', type: 'none',
      host: '', path: i.ws_path ?? '/ws', tls: '',
    }
    return `vmess://${b64encode(JSON.stringify(obj))}`
  }
  return null
}

// shareURLFor picks the right builder for the plugin, and for a sing-box
// FORWARD relay synthesises the URL from the LANDING's secrets with the relay's
// port (forward relays carry no per-row secrets — they're a transparent NAT).
export function shareURLFor(
  plugin: ProxyPluginID,
  inbound: ProxyInboundFull,
  hostname: string,
  byID: Map<number, ProxyInboundFull>,
): string | null {
  if (plugin === 'xray') {
    if (!XRAY_URL_PROTOCOLS.has(inbound.protocol)) return null
    return buildXrayShareURL(inbound, hostname)
  }
  if (!SINGBOX_URL_PROTOCOLS.has(inbound.protocol)) return null
  let source = inbound
  if (inbound.role === 'relay' && inbound.relay_mode === 'forward' && inbound.upstream_inbound_id != null) {
    const landing = byID.get(inbound.upstream_inbound_id)
    if (landing) source = { ...landing, port: inbound.port }
  }
  return buildSingboxShareURL(source, hostname)
}
