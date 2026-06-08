import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { authedFetch } from './authed'

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
