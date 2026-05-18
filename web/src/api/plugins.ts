import { api } from './client'

export interface PluginMeta {
  name: string
  description: string
  icon: string
  category: string
  host_aware: boolean
}

export interface PluginEntry {
  id: string
  meta: PluginMeta
  enabled: boolean
  enabled_at: string | null
  host_count: number | null
}

export interface PluginHost {
  id: number
  server_id: number
  config: unknown
  deployed_version: string | null
  status: 'pending' | 'deploying' | 'running' | 'failed' | 'stopped'
  last_error: string | null
  updated_at: string
}

export interface PluginEvent {
  ts: string
  admin_id: number | null
  server_id: number | null
  action: string
  result: string
  details: unknown
}

export interface XrayTopologyRow {
  role: 'landing' | 'relay'
  upstream_server_id: number | null
  upstream_name: string | null
}

// Map keyed by server_id (string in JSON, number for callers).
// Servers without an xray deployment are simply absent.
export const fetchXrayTopology = async (): Promise<Map<number, XrayTopologyRow>> => {
  const raw = await api.get<Record<string, XrayTopologyRow>>('/api/admin/plugins/xray/topology')
  const out = new Map<number, XrayTopologyRow>()
  for (const [k, v] of Object.entries(raw)) out.set(Number(k), v)
  return out
}

export const listPlugins = () => api.get<PluginEntry[]>('/api/admin/plugins')

export const enablePlugin = (id: string) =>
  api.post<{ enabled: boolean }>(`/api/admin/plugins/${id}/enable`, {})

export const disablePlugin = (id: string) =>
  api.post<{ enabled: boolean }>(`/api/admin/plugins/${id}/disable`, {})

export const getPluginConfig = (id: string) =>
  api.get<Record<string, unknown>>(`/api/admin/plugins/${id}/config`)

export const putPluginConfig = (id: string, body: Record<string, unknown>) =>
  api.put(`/api/admin/plugins/${id}/config`, body)

export const listPluginHosts = (id: string) =>
  api.get<PluginHost[]>(`/api/admin/plugins/${id}/hosts`)

export const deployPluginHost = (id: string, body: {
  server_id: number
  version?: string
  config?: unknown
  topology?: { role: 'landing' | 'relay'; upstream_server_id?: number }
}) => api.post<PluginHost>(`/api/admin/plugins/${id}/hosts`, body)

export const removePluginHost = (id: string, serverId: number) =>
  api.del(`/api/admin/plugins/${id}/hosts/${serverId}`)

export const listPluginEvents = (id: string, params: { since?: string; limit?: number; server_id?: number } = {}) => {
  const q = new URLSearchParams()
  if (params.since) q.set('since', params.since)
  if (params.limit) q.set('limit', String(params.limit))
  if (params.server_id) q.set('server_id', String(params.server_id))
  const qs = q.toString()
  return api.get<PluginEvent[]>(`/api/admin/plugins/${id}/events${qs ? '?' + qs : ''}`)
}

export const pluginLogsWSURL = (id: string, serverId: number) => {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/admin/plugins/${id}/hosts/${serverId}/logs`
}

export interface HostDomain {
  id: number
  server_id: number
  zone_id: string
  record_id: string
  domain: string
  type: string
  content: string
  created_at: string
}

export const listHostDomains = (serverID?: number) => {
  const qs = serverID != null ? `?server_id=${serverID}` : ''
  return api.get<HostDomain[]>(`/api/admin/plugins/cloudflare/host-domains${qs}`)
}

export const addHostDomain = (body: { server_id: number; domain?: string; content?: string; type?: string }) =>
  api.post<HostDomain>(`/api/admin/plugins/cloudflare/host-domains`, body)

export const removeHostDomain = (id: number) =>
  api.del(`/api/admin/plugins/cloudflare/host-domains/${id}`)

export interface XrayVersionsResp { cached: { version: string; os: string; arch: string }[]; latest: string[] }
export const fetchXrayVersions = () =>
  api.get<XrayVersionsResp>('/api/admin/plugins/xray/versions')

export interface X25519KeyPair { private_key: string; public_key: string }
export const generateX25519 = () =>
  api.post<X25519KeyPair>('/api/admin/plugins/xray/keys/x25519', {})

export const generateShortID = () =>
  api.post<{ short_id: string }>('/api/admin/plugins/xray/keys/short-id', {})
