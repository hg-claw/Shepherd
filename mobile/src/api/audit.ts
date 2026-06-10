import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { authedFetch } from './authed'

// One row of the admin audit trail. `details` is a JSON-encoded string blob;
// render it verbatim (mono) rather than parsing — older rows may not be JSON.
export type AuditRow = {
  id: number
  ts: string
  admin_id?: number | null
  server_id?: number | null
  action: string
  details: string
  result: 'ok' | 'error'
}

export type AuditFilters = {
  action?: string
}

// useAuditLog fetches the most recent audit events (backend caps at 1000,
// ts DESC). No refetchInterval — the screen relies on pull-to-refresh.
export function useAuditLog(filters?: AuditFilters): UseQueryResult<AuditRow[]> {
  const action = filters?.action ?? ''
  const qs = action ? `?action=${encodeURIComponent(action)}` : ''
  return useQuery({
    queryKey: ['audit', action],
    queryFn: () => authedFetch<AuditRow[]>(`/api/admin/audit${qs}`),
    staleTime: 10000,
  })
}
