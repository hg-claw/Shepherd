import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { authedFetch } from './authed'
import type { Point, ServerRow, NullStr } from './servers'

export type { Point } from './servers'

const ONLINE_WINDOW_MS = 90_000

export type TelemetryRange = '1h' | '24h' | '7d'

// useTelemetrySeries fetches the history series for one server. 1h is raw 30s
// samples so it refreshes at that cadence; the rolled-up ranges move slower.
export function useTelemetrySeries(id: number, range: TelemetryRange): UseQueryResult<Point[]> {
  return useQuery({
    queryKey: ['telemetry', id, range],
    queryFn: () => authedFetch<Point[]>(`/api/servers/${id}/telemetry?range=${range}`),
    refetchInterval: range === '1h' ? 30000 : 60000,
    staleTime: 10000,
  })
}

// nullStr extracts a plain string from a Go sql.NullString ({String, Valid}),
// a plain string, or null/undefined → '' when absent.
export function nullStr(v: NullStr | string | null | undefined): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  return v.Valid ? v.String : ''
}

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
