export type Point = {
  ts: string
  cpu_pct?: number; mem_used?: number; mem_total?: number; load_1?: number
  net_rx_bps?: number; net_tx_bps?: number; tcp_conn?: number; disks_json?: string
}
export type ServerRow = {
  id: number; name: string
  agent_os?: string | null; agent_arch?: string | null
  agent_last_seen?: { Valid: boolean; Time: string } | string | null
  connected: boolean
  latest: Point | null
}
