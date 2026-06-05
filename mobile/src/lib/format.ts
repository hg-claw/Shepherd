export function bps(n: number): string {
  if (n < 1000) return `${Math.round(n)} B/s`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} KB/s`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB/s`
  return `${(n / 1_000_000_000).toFixed(1)} GB/s`
}

export function pct(n: number | null | undefined): string {
  return n == null ? '—' : `${Math.round(n)}%`
}

export function relTime(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
