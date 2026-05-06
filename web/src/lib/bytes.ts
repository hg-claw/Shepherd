const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
const BPS_UNITS = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s']

function humanScale(n: number, units: string[]): string {
  if (!isFinite(n) || n < 0) return '-'
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return '-'
  return humanScale(n, BYTE_UNITS)
}

export function bps(n: number | null | undefined): string {
  if (n == null) return '-'
  return humanScale(n, BPS_UNITS)
}

export function pct(used: number | null | undefined, total: number | null | undefined): number | null {
  if (used == null || total == null || total <= 0) return null
  return (used / total) * 100
}
