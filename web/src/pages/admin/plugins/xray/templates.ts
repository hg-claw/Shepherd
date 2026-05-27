// templates.ts — utility helpers for the xray plugin UI.
// Multi-inbound (Phase 3c-1) moved config rendering to the server,
// so `renderTemplate` / `parseConfig` are no longer used. This file
// keeps only the share-URL builder + random helpers used by dialogs.

export type Inbound = 'vless-reality' | 'vmess-ws'

export interface TemplateValues {
  inbound: Inbound
  port: number
  uuid?: string
  sni?: string
  publicKey?: string
  privateKey?: string
  shortID?: string
  wsPath?: string
}

export function buildShareURL(parsed: TemplateValues, hostname: string, label: string): string | null {
  if (!hostname || !parsed.port || !parsed.uuid) return null

  if (parsed.inbound === 'vless-reality') {
    if (!parsed.publicKey) return null
    const q = new URLSearchParams({
      encryption: 'none',
      security: 'reality',
      sni: parsed.sni ?? '',
      fp: 'chrome',
      pbk: parsed.publicKey,
      sid: parsed.shortID ?? '',
      type: 'tcp',
      flow: 'xtls-rprx-vision',
    })
    return `vless://${parsed.uuid}@${hostname}:${parsed.port}?${q.toString()}#${encodeURIComponent(label)}`
  }

  if (parsed.inbound === 'vmess-ws') {
    const obj = {
      v: '2', ps: label, add: hostname, port: String(parsed.port),
      id: parsed.uuid, aid: '0', scy: 'auto', net: 'ws', type: 'none',
      host: '', path: parsed.wsPath ?? '/ws', tls: '',
    }
    return `vmess://${btoa(JSON.stringify(obj))}`
  }
  return null
}

export function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000)
}

export function randomUUID(): string {
  if ('randomUUID' in crypto) return (crypto as any).randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// randomPassword returns 24 random bytes as URL-safe base64 (no padding).
// Suitable for arbitrary-string passwords (trojan/hysteria2/tuic/anytls and
// legacy shadowsocks methods).
export function randomPassword(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

// randomSSKey returns a Shadowsocks key appropriate for the given method.
// SS2022 methods (2022-blake3-*) need an exact-length standard-base64 key:
// 16 bytes for aes-128, 32 bytes otherwise. Legacy methods accept any string,
// so they reuse randomPassword().
export function randomSSKey(method: string): string {
  if (!method.startsWith('2022-blake3-')) return randomPassword()
  const n = method.includes('aes-128') ? 16 : 32
  const bytes = new Uint8Array(n)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)) // standard base64, with padding
}
