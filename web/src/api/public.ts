import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import type { Point, Range } from './servers'

// One per-ISP RTT/loss summary, appended to the card when the
// netquality plugin is enabled for this server AND has recent samples.
// Field shape matches internal/api/public.go: NetqualityISPSummary.
export type NetqualityISPSummary = {
  isp: 'telecom' | 'unicom' | 'mobile' | 'overseas'
  rtt_avg_ms: number
  loss_pct: number
}

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
  netquality?: NetqualityISPSummary[]
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

// Per-ISP RTT history for the public detail page chart. Empty array when
// the plugin isn't enabled for this server — the chart card hides itself.
export type NetqualityHistoryPoint = {
  ts: string
  rtt_avg_ms?: number
  loss_pct?: number
}

export type NetqualityHistoryRow = {
  isp: 'telecom' | 'unicom' | 'mobile' | 'overseas'
  points: NetqualityHistoryPoint[]
}

export function usePublicNetquality(id: number, range: Range) {
  return useQuery({
    queryKey: ['public-netquality', id, range],
    queryFn: () => api.get<NetqualityHistoryRow[]>(`/api/public/servers/${id}/netquality?range=${range}`),
    staleTime: range === '1h' ? 30_000 : range === '24h' ? 5 * 60_000 : 30 * 60_000,
    enabled: !!id,
  })
}
