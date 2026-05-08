import { useQuery } from '@tanstack/react-query'
import { api } from './client'

export interface AuditRow {
  id: number
  ts: string
  admin_id?: number | null
  server_id?: number | null
  action: string
  details: string
  result: 'ok' | 'error'
}

export interface AuditFilters {
  action?: string
  server_id?: number
  from?: string
  to?: string
}

export function useAuditLog(filters: AuditFilters) {
  const params = new URLSearchParams()
  if (filters.action) params.set('action', filters.action)
  if (filters.server_id) params.set('server_id', String(filters.server_id))
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  const qs = params.toString()
  return useQuery({
    queryKey: ['audit', filters],
    queryFn: () => api.get<AuditRow[]>(`/api/admin/audit${qs ? '?' + qs : ''}`),
  })
}
