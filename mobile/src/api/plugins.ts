import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { authedFetch } from './authed'
import { wsURL } from '@/lib/wsurl'

export type PluginMeta = { name: string; description: string; icon: string; category: string; host_aware: boolean }
export type Plugin = { id: string; meta: PluginMeta; enabled: boolean; enabled_at?: string | null; host_count?: number | null }
export type HostDeployment = { id: number; plugin_id: string; server_id: number; deployed_version?: string | null; status: string; last_error?: string | null; updated_at: string; config?: unknown }

export function usePlugins(): UseQueryResult<Plugin[]> {
  return useQuery({ queryKey: ['plugins'], queryFn: () => authedFetch<Plugin[]>('/api/admin/plugins') })
}
export function enablePlugin(id: string): Promise<{ enabled: boolean }> {
  return authedFetch<{ enabled: boolean }>(`/api/admin/plugins/${id}/enable`, { method: 'POST' })
}
export function disablePlugin(id: string): Promise<{ enabled: boolean }> {
  return authedFetch<{ enabled: boolean }>(`/api/admin/plugins/${id}/disable`, { method: 'POST' })
}
export function usePluginConfig(id: string): UseQueryResult<Record<string, unknown>> {
  return useQuery({ queryKey: ['plugin-config', id], queryFn: () => authedFetch<Record<string, unknown>>(`/api/admin/plugins/${id}/config`) })
}
export function savePluginConfig(id: string, cfg: Record<string, unknown>): Promise<{ ok: boolean }> {
  return authedFetch<{ ok: boolean }>(`/api/admin/plugins/${id}/config`, { method: 'PUT', body: cfg })
}

const DEPLOYING = new Set(['pending', 'deploying'])

export function usePluginHosts(id: string): UseQueryResult<HostDeployment[]> {
  return useQuery({
    queryKey: ['plugin-hosts', id],
    queryFn: () => authedFetch<HostDeployment[]>(`/api/admin/plugins/${id}/hosts`),
    refetchInterval: (query) => {
      const rows = query.state.data as HostDeployment[] | undefined
      const anyDeploying = !!rows && rows.some((h) => DEPLOYING.has(h.status))
      return anyDeploying ? 2000 : false
    },
  })
}
export function deployHost(id: string, body: { server_id: number; version?: string; config?: Record<string, unknown> }): Promise<HostDeployment> {
  return authedFetch<HostDeployment>(`/api/admin/plugins/${id}/hosts`, { method: 'POST', body })
}
export function undeployHost(id: string, serverId: number): Promise<{ ok: boolean }> {
  return authedFetch<{ ok: boolean }>(`/api/admin/plugins/${id}/hosts/${serverId}`, { method: 'DELETE' })
}
export function startHost(id: string, serverId: number): Promise<{ status: string }> {
  return authedFetch<{ status: string }>(`/api/admin/plugins/${id}/hosts/${serverId}/start`, { method: 'POST' })
}
export function stopHost(id: string, serverId: number): Promise<{ status: string }> {
  return authedFetch<{ status: string }>(`/api/admin/plugins/${id}/hosts/${serverId}/stop`, { method: 'POST' })
}
export function restartHost(id: string, serverId: number): Promise<{ status: string }> {
  return authedFetch<{ status: string }>(`/api/admin/plugins/${id}/hosts/${serverId}/restart`, { method: 'POST' })
}
export function refreshHost(id: string, serverId: number): Promise<HostDeployment> {
  return authedFetch<HostDeployment>(`/api/admin/plugins/${id}/hosts/${serverId}/refresh-status`)
}

// pluginLogsWSURL builds the admin live-log WS endpoint for one plugin host.
// The bearer token is deliberately NOT in the URL — RN passes it via the
// WebSocket headers option (same as the console session), so it never leaks
// into server logs or proxies.
export function pluginLogsWSURL(baseURL: string, pluginId: string, serverId: number): string {
  return wsURL(baseURL, `/api/admin/plugins/${encodeURIComponent(pluginId)}/hosts/${serverId}/logs`)
}

// ── read-only plugin status views ────────────────────────────────────────────
// Wire shapes mirror web/src/api/plugins.ts + web/src/api/netquality.ts (and the
// Go handlers behind them). Only the fields the mobile status screen renders are
// typed; extra wire fields (keys, transport details) are deliberately ignored.

// singbox and xray expose identical /inbounds + /traffic/batch shapes.
export type ProxyPluginID = 'singbox' | 'xray'

export type ProxyInbound = {
  id: number
  server_id: number
  server_name: string
  tag: string
  alias: string
  port: number
  role: 'landing' | 'relay'
  protocol: string
}

export function listProxyInbounds(plugin: ProxyPluginID, serverId?: number): Promise<ProxyInbound[]> {
  const qs = serverId != null ? `?server_id=${serverId}` : ''
  return authedFetch<ProxyInbound[]>(`/api/admin/plugins/${plugin}/inbounds${qs}`)
}

export function useProxyInbounds(plugin: ProxyPluginID, serverId: number | null): UseQueryResult<ProxyInbound[]> {
  return useQuery({
    queryKey: ['plugin-inbounds', plugin, serverId],
    queryFn: () => listProxyInbounds(plugin, serverId as number),
    enabled: serverId != null,
  })
}

export type TrafficPoint = { ts: string; bytes_up: number; bytes_down: number }
export type TrafficSeries = { tag: string; kind: string; points: TrafficPoint[] }
export type TrafficResolution = 'raw' | 'minute' | 'hour'
export type TrafficBatchResponse = { resolution: TrafficResolution; series: TrafficSeries[] }

export function fetchTrafficBatch(plugin: ProxyPluginID, params: {
  server_id: number
  tags: string[]
  from: string // ISO 8601
  to: string   // ISO 8601
  resolution?: TrafficResolution
}): Promise<TrafficBatchResponse> {
  // Tags are comma-joined per the batch handler's contract; each tag is encoded
  // individually so the commas stay literal separators.
  let q = `server_id=${params.server_id}`
    + `&tags=${params.tags.map(encodeURIComponent).join(',')}`
    + `&from=${encodeURIComponent(params.from)}&to=${encodeURIComponent(params.to)}`
  if (params.resolution) q += `&resolution=${params.resolution}`
  return authedFetch<TrafficBatchResponse>(`/api/admin/plugins/${plugin}/traffic/batch?${q}`)
}

export function useTrafficBatch(plugin: ProxyPluginID, params: {
  server_id: number | null
  tags: string[]
  from: string
  to: string
  resolution?: TrafficResolution
}): UseQueryResult<TrafficBatchResponse> {
  const { server_id, tags, from, to, resolution } = params
  return useQuery({
    queryKey: ['plugin-traffic-batch', plugin, server_id, tags.join(','), from, to, resolution ?? ''],
    queryFn: () => fetchTrafficBatch(plugin, { server_id: server_id as number, tags, from, to, resolution }),
    enabled: server_id != null && tags.length > 0,
  })
}

// certResponse in internal/plugins/singbox/cert_routes.go: expires_at is a plain
// RFC3339 string (the Go ZERO time "0001-01-01T00:00:00Z" while still issuing);
// last_renew_attempt_at/last_error are *string → null when absent.
export type SingboxCertificate = {
  id: number
  domain: string
  status: 'issuing' | 'active' | 'failed' | 'revoked'
  issuer: string
  expires_at: string
  challenge_type: 'dns-01-cf' | 'http-01'
  last_renew_attempt_at: string | null
  last_error: string | null
}

export function listSingboxCerts(): Promise<SingboxCertificate[]> {
  return authedFetch<SingboxCertificate[]>('/api/admin/plugins/singbox/certificates')
}

export function useSingboxCerts(enabled: boolean = true): UseQueryResult<SingboxCertificate[]> {
  return useQuery({
    queryKey: ['singbox-certs'],
    queryFn: listSingboxCerts,
    enabled,
  })
}

export type NetqualityISP = 'telecom' | 'unicom' | 'mobile' | 'overseas'

// One row per enabled target on a server (latestPerTarget in
// internal/plugins/netquality/routes.go). ts/rtt_avg_ms/loss_pct/status are
// pointers with omitempty server-side — a target with no samples yet (LEFT
// JOIN NULLs) simply omits them.
export type NetqualityLatestRow = {
  target_id: number
  isp: NetqualityISP
  region: string
  label: string
  ts?: string
  rtt_avg_ms?: number
  loss_pct?: number
  status?: 'ok' | 'lost' | 'error'
}

export function fetchNetqualityLatest(serverId: number): Promise<NetqualityLatestRow[]> {
  return authedFetch<NetqualityLatestRow[]>(`/api/admin/plugins/netquality/samples/latest?server_id=${serverId}`)
}

export function useNetqualityLatest(serverId: number | null): UseQueryResult<NetqualityLatestRow[]> {
  return useQuery({
    queryKey: ['netquality-latest', serverId],
    queryFn: () => fetchNetqualityLatest(serverId as number),
    enabled: serverId != null,
  })
}
