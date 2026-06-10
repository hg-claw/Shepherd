export function bps(n: number): string {
  if (n < 1000) return `${Math.round(n)} B/s`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} KB/s`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB/s`
  return `${(n / 1_000_000_000).toFixed(1)} GB/s`
}

export function pct(n: number | null | undefined): string {
  return n == null ? '—' : `${Math.round(n)}%`
}

// Hermes builds without Intl, so no toLocaleString — humanize cumulative byte
// counts manually (same scale rules as web/src/lib/bytes.ts).
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
export function bytes(n: number | null | undefined): string {
  if (n == null || !isFinite(n) || n < 0) return '—'
  let v = n
  let i = 0
  while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${BYTE_UNITS[i]}`
}

// cmpStr is an engine-independent string comparator for Array.sort. Hermes builds
// without Intl don't expose String.prototype.localeCompare (it crashes with
// "undefined is not a function"), so we compare by code unit instead.
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function relTime(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

// countryFlag turns an ISO-3166-1 alpha-2 code into its flag emoji ('' if absent/invalid).
export function countryFlag(code?: string | null): string {
  if (!code) return ''
  const cc = code.toUpperCase()
  if (!/^[A-Z]{2}$/.test(cc)) return ''
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
}
