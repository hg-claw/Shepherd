// Client for /api/admin/plugins/netquality/*.
//
// Wire shape mirrors `routes.go` exactly; if the JSON-tag for a field
// here drifts from the server's struct tag the TS compiler keeps shipping
// but the rendered UI silently misses data. Keep these in sync.
import { api } from './client'

const ROOT = '/api/admin/plugins/netquality'

export type NetqualityISP = 'telecom' | 'unicom' | 'mobile' | 'overseas'

export interface NetqualityTarget {
  id: number
  source: 'builtin' | 'custom'
  isp: NetqualityISP
  region: string
  label: string
  host: string
  enabled: boolean
  created_at: string
}

export interface NetqualityHost {
  server_id: number
  enabled: boolean
  sample_interval_seconds: number
  last_error?: string
  updated_at?: string
}

// One row per enabled target on a server. ts/rtt_avg_ms/loss_pct/status
// are optional because a target with no samples yet returns NULLs from
// the LEFT JOIN in /samples/latest.
export interface NetqualityLatestRow {
  target_id: number
  isp: NetqualityISP
  region: string
  label: string
  ts?: string
  rtt_avg_ms?: number
  loss_pct?: number
  status?: 'ok' | 'lost' | 'error'
}

export interface NetqualitySamplePoint {
  ts: string
  rtt_avg_ms?: number | null
  loss_pct: number
  rtt_min_ms?: number
  rtt_max_ms?: number
  jitter_ms?: number
  status?: 'ok' | 'lost' | 'error'
  samples?: number
}

export interface NetqualitySamplesResponse {
  resolution: 'raw' | 'minute' | 'hour'
  points: NetqualitySamplePoint[]
}

export const listNetqualityTargets = () =>
  api.get<NetqualityTarget[]>(`${ROOT}/targets`)

export const createNetqualityTarget = (body: {
  isp: NetqualityISP
  region?: string
  label: string
  host: string
}) => api.post<{ ok: true }>(`${ROOT}/targets`, body)

export const patchNetqualityTarget = (
  id: number,
  body: { enabled?: boolean; label?: string },
) => api.patch<{ ok: true }>(`${ROOT}/targets/${id}`, body)

export const deleteNetqualityTarget = (id: number) =>
  api.delete<{ ok: true }>(`${ROOT}/targets/${id}`)

export const listNetqualityHosts = () =>
  api.get<NetqualityHost[]>(`${ROOT}/hosts`)

export const putNetqualityHost = (
  serverID: number,
  body: { enabled: boolean; sample_interval_seconds: number },
) => api.put<{ ok: true }>(`${ROOT}/hosts/${serverID}`, body)

export const fetchNetqualityLatest = (serverID: number) =>
  api.get<NetqualityLatestRow[]>(`${ROOT}/samples/latest?server_id=${serverID}`)

// Per-host target picker.
//
// listHostTargets returns one row per globally-enabled target with a
// `selected` flag for the given host; updateHostTargets idempotently
// replaces the host's selection. The agent gets a fresh PushConfig
// after the PUT so the next tick uses the new set.
export interface HostTargetRow {
  target_id: number
  isp: NetqualityISP
  region: string
  label: string
  host: string
  selected: boolean
}

export const listHostTargets = (serverID: number) =>
  api.get<HostTargetRow[]>(`${ROOT}/hosts/${serverID}/targets`)

export const updateHostTargets = (serverID: number, targetIDs: number[]) =>
  api.put<{ ok: true }>(`${ROOT}/hosts/${serverID}/targets`, { target_ids: targetIDs })

export const fetchNetqualitySamples = (params: {
  server_id: number
  target_id: number
  from: string
  to: string
  resolution?: 'raw' | 'minute' | 'hour'
}) => {
  const qs = new URLSearchParams({
    server_id: String(params.server_id),
    target_id: String(params.target_id),
    from: params.from,
    to: params.to,
  })
  if (params.resolution) qs.set('resolution', params.resolution)
  return api.get<NetqualitySamplesResponse>(`${ROOT}/samples?${qs.toString()}`)
}
