import type { Point, ServerRow } from './servers'

const ONLINE_WINDOW_MS = 90_000

export function memPct(p: Point | null): number | null {
  if (!p || p.mem_used == null || p.mem_total == null || p.mem_total === 0) return null
  return (p.mem_used / p.mem_total) * 100
}

export function firstDiskPct(disksJSON?: string): number | null {
  if (!disksJSON) return null
  try {
    const arr = JSON.parse(disksJSON)
    if (!Array.isArray(arr) || arr.length === 0) return null
    const d = arr[0] as { used?: number; total?: number; pct?: number }
    if (typeof d.pct === 'number') return d.pct
    if (typeof d.used === 'number' && typeof d.total === 'number' && d.total > 0) {
      return (d.used / d.total) * 100
    }
    return null
  } catch {
    return null
  }
}

function lastSeenISO(v: ServerRow['agent_last_seen']): string | null {
  if (!v) return null
  if (typeof v === 'string') return v
  return v.Valid ? v.Time : null
}

export function isOnline(row: ServerRow): boolean {
  if (row.connected) return true
  const iso = lastSeenISO(row.agent_last_seen)
  if (!iso) return false
  return Date.now() - new Date(iso).getTime() <= ONLINE_WINDOW_MS
}
