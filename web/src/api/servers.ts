import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'

export interface IPCandidate {
  server_id: number
  addr: string
  kind: string
  source: string
  detected_at: string
}

export function useServerIPCandidates(id: number) {
  return useQuery({
    queryKey: ['server-ip-candidates', id],
    queryFn: () => api.get<IPCandidate[]>(`/api/servers/${id}/ip-candidates`),
    enabled: !!id,
  })
}

export type ServerRecord = {
  id: number
  name: string
  public_alias: { Valid: boolean; String: string } | null
  public_group: { Valid: boolean; String: string } | null
  country_code: { Valid: boolean; String: string } | null
  show_on_public: boolean
  ssh_host: { Valid: boolean; String: string } | null
  ssh_port: number
  ssh_user: { Valid: boolean; String: string } | null
  install_stage: 'pending' | 'installing' | 'done' | 'failed'
  install_log: string
  install_error: { Valid: boolean; String: string } | null
  install_started_at: { Valid: boolean; Time: string } | null
  agent_version: { Valid: boolean; String: string } | null
  agent_os: { Valid: boolean; String: string } | null
  agent_arch: { Valid: boolean; String: string } | null
  agent_kernel: { Valid: boolean; String: string } | null
  agent_last_seen: { Valid: boolean; Time: string } | null
  agent_fingerprint: { Valid: boolean; String: string } | null
  created_at: string
  connected?: boolean
}

export type Latest = {
  ts: string
  cpu_pct?: number
  mem_used?: number
  mem_total?: number
  load_1?: number
  net_rx_bps?: number
  net_tx_bps?: number
  tcp_conn?: number
  disks_json?: string
}

export type ServerWithLatest = ServerRecord & { latest: Latest | null }

export function useServers(opts?: {
  withLatest?: boolean
  refetchInterval?: number | ((q: any) => number | false)
}) {
  const path = opts?.withLatest ? '/api/servers?with=latest' : '/api/servers'
  return useQuery({
    queryKey: opts?.withLatest ? ['servers', 'with-latest'] : ['servers'],
    queryFn: () => api.get<ServerWithLatest[]>(path),
    refetchInterval: opts?.refetchInterval,
  })
}

export function useServer(
  id: number,
  opts?: { refetchInterval?: number | ((q: any) => number | false) },
) {
  return useQuery({
    queryKey: ['server', id],
    queryFn: () => api.get<ServerRecord>(`/api/servers/${id}`),
    refetchInterval: opts?.refetchInterval,
    enabled: !!id,
  })
}

export type Range = '1h' | '24h' | '7d'

export type Point = {
  ts: string
  cpu_pct?: number
  mem_used?: number
  mem_total?: number
  load_1?: number
  net_rx_bps?: number
  net_tx_bps?: number
  tcp_conn?: number
  disks_json?: string
}

export function useTelemetry(id: number, range: Range, isPublic: boolean) {
  const path = isPublic
    ? `/api/public/servers/${id}/telemetry?range=${range}`
    : `/api/servers/${id}/telemetry?range=${range}`
  return useQuery({
    queryKey: [isPublic ? 'public-telemetry' : 'admin-telemetry', id, range],
    queryFn: () => api.get<Point[]>(path),
    staleTime: range === '1h' ? 30_000 : range === '24h' ? 5 * 60_000 : 30 * 60_000,
    enabled: !!id,
  })
}

export type InstallInput = {
  name: string
  ssh_host: string
  ssh_port?: number
  ssh_user: string
  ssh_password?: string
  ssh_key?: string
  arch: 'amd64' | 'arm64'
  public_alias?: string
  public_group?: string
  country_code?: string
  show_on_public?: boolean
}

export function useInstall() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: InstallInput) =>
      api.post<{ server_id: number }>('/api/servers/install', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }),
  })
}

export interface ScriptInstallInput {
  name: string
  public_alias?: string
  public_group?: string
  country_code?: string
  show_on_public: boolean
}

export interface ScriptInstallResult {
  server_id: number
  token: string
  expires_at: string
  command: string
}

export function useScriptInstall() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ScriptInstallInput) =>
      api.post<ScriptInstallResult>('/api/servers/script', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }),
  })
}

export type PatchInput = {
  name?: string
  public_alias?: string
  public_group?: string
  country_code?: string
  show_on_public?: boolean
  ssh_host?: string
}

export function usePatchServer(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: PatchInput) => api.patch<ServerRecord>(`/api/servers/${id}`, input),
    onSuccess: (data) => {
      qc.setQueryData(['server', id], data)
      qc.invalidateQueries({ queryKey: ['servers'] })
    },
  })
}

export function useDeleteServer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/api/servers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }),
  })
}

export function useRepair(id: number) {
  return useMutation({
    mutationFn: () => api.post<{ enrollment_token: string; expires_at: string }>(`/api/servers/${id}/repair`),
  })
}

export function useServerInstallCommand(id: number) {
  return useMutation({
    mutationFn: () =>
      api.post<ScriptInstallResult>(`/api/servers/${id}/install-command`, {}),
  })
}

export function usePushConfig(id: number) {
  return useMutation({
    mutationFn: (input: { telemetry_interval_seconds: number }) =>
      api.post<void>(`/api/servers/${id}/config`, input),
  })
}
