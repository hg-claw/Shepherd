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
  server_id: number; version?: string; config?: unknown;
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
