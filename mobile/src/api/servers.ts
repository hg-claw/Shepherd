import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { authedFetch } from './authed'

export type Point = {
  ts: string
  cpu_pct?: number; mem_used?: number; mem_total?: number; load_1?: number
  net_rx_bps?: number; net_tx_bps?: number; tcp_conn?: number; disks_json?: string
}
// Go serializes sql.NullString as {String, Valid} (not a plain string).
export type NullStr = { String: string; Valid: boolean }
export type ServerRow = {
  id: number; name: string
  agent_os?: NullStr | string | null; agent_arch?: NullStr | string | null
  agent_kernel?: NullStr | string | null
  agent_last_seen?: { Valid: boolean; Time: string } | string | null
  connected: boolean
  latest: Point | null
  public_alias?: NullStr | string | null
  public_group?: NullStr | string | null
  country_code?: NullStr | string | null
  ssh_host?: NullStr | string | null
}

// useServers is the FAST list — plain /api/servers, no telemetry join. Used to
// paint the home immediately. Metrics arrive separately via useServersLatest().
export function useServers(): UseQueryResult<ServerRow[]> {
  return useQuery({
    queryKey: ['servers'],
    queryFn: () => authedFetch<ServerRow[]>('/api/servers'),
    refetchInterval: 30000,
    refetchOnWindowFocus: true,
    staleTime: 10000,
  })
}

// useServersLatest adds the latest telemetry + live connected flag. This hits the
// heavier ?with=latest path (a window scan over telemetry), so it's a separate
// query that fills the metric bars after the list is already on screen.
export function useServersLatest(): UseQueryResult<ServerRow[]> {
  return useQuery({
    queryKey: ['servers', 'latest'],
    queryFn: () => authedFetch<ServerRow[]>('/api/servers?with=latest'),
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    staleTime: 2000,
  })
}

// useServer (detail) needs metrics → reads the latest query.
export function useServer(id: number): ServerRow | undefined {
  return useServersLatest().data?.find((s) => s.id === id)
}

// --- Traffic cycle (read-only on mobile; reset-day editing stays on web) ---

export type HostTraffic = {
  server_id: number
  cum_bytes_up: number
  cum_bytes_down: number
  prev_bytes_up: number
  prev_bytes_down: number
  reset_day: number
  last_reset_at: string | null
}

export function useHostTraffic(id: number): UseQueryResult<HostTraffic> {
  return useQuery({
    queryKey: ['host-traffic', id],
    queryFn: () => authedFetch<HostTraffic>(`/api/servers/${id}/traffic`),
    enabled: !!id,
    refetchInterval: 10000,
  })
}

// --- Per-host actions (plain authed mutations, same shape as api/plugins.ts) ---

// updateAgent asks the host's agent to self-update. 202 = accepted (fire-and-
// forget); 409 = agent offline. `cn` routes the download via the CN mirror.
export function updateAgent(id: number, cn?: boolean): Promise<unknown> {
  return authedFetch<unknown>(`/api/servers/${id}/update-agent${cn ? '?cn=1' : ''}`, { method: 'POST' })
}

// repairServer issues a short-lived enrollment token the user runs on the host
// to re-enroll a broken agent.
export function repairServer(id: number): Promise<{ enrollment_token: string; expires_at: string }> {
  return authedFetch<{ enrollment_token: string; expires_at: string }>(`/api/servers/${id}/repair`, { method: 'POST' })
}

export function deleteServer(id: number): Promise<unknown> {
  return authedFetch<unknown>(`/api/servers/${id}`, { method: 'DELETE' })
}
