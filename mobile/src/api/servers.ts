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
  agent_last_seen?: { Valid: boolean; Time: string } | string | null
  connected: boolean
  latest: Point | null
  public_alias?: NullStr | string | null
  public_group?: NullStr | string | null
  country_code?: NullStr | string | null
}

export function useServers(): UseQueryResult<ServerRow[]> {
  return useQuery({
    queryKey: ['servers'],
    queryFn: () => authedFetch<ServerRow[]>('/api/servers?with=latest'),
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    staleTime: 2000,
  })
}

export function useServer(id: number): ServerRow | undefined {
  return useServers().data?.find((s) => s.id === id)
}
