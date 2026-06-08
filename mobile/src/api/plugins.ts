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
