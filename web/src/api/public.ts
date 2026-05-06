import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import type { Point, Range } from './servers'

export type PublicCard = {
  id: number
  alias: string
  group: string
  country_code: string
  online: boolean
  latest?: {
    ts: string
    cpu_pct: number
    mem_pct: number
    disks_pct: number[]
    net_rx_bps: number
    net_tx_bps: number
    load_1: number
    tcp_conn: number
  }
}

export function usePublicServers() {
  return useQuery({
    queryKey: ['public-servers'],
    queryFn: () => api.get<PublicCard[]>('/api/public/servers'),
    refetchInterval: 30_000,
  })
}

export function usePublicSettings() {
  return useQuery({
    queryKey: ['public-settings'],
    queryFn: () => api.get<{ public_display_mode: 'raw' | 'level' | 'both' }>('/api/public/settings'),
    staleTime: 5 * 60_000,
  })
}

export function usePublicTelemetry(id: number, range: Range) {
  return useQuery({
    queryKey: ['public-telemetry', id, range],
    queryFn: () => api.get<Point[]>(`/api/public/servers/${id}/telemetry?range=${range}`),
    staleTime: range === '1h' ? 30_000 : range === '24h' ? 5 * 60_000 : 30 * 60_000,
    enabled: !!id,
  })
}
