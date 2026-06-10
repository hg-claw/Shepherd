// Client for the netquality plugin's dedicated endpoints (/api/admin/plugins/
// netquality/*). These are SEPARATE from the generic plugin deployment table —
// the route collision documented in the bug diagnosis means GET
// /api/admin/plugins/netquality/hosts returns netquality_hosts PROBE CONFIG
// rows (server_id/enabled/sample_interval_seconds), NOT the generic
// HostDeployment shape. We type them correctly here so the screen reads real
// data instead of the lie usePluginHosts('netquality') produces.
//
// Wire shapes mirror internal/plugins/netquality/routes.go exactly:
//  - hostRow.last_error is Go *string + omitempty  → plain string-or-absent
//  - hostRow.updated_at is Go *time.Time + omitempty → RFC3339-or-absent
// These are POINTER-null-or-absent values, NOT sql.Null* {String,Valid}
// objects — so nullStr() is the WRONG helper for them; read as optional.
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { authedFetch } from './authed'
import type { NetqualityISP } from './plugins'

export type { NetqualityISP } from './plugins'

const ROOT = '/api/admin/plugins/netquality'

// ── targets catalog ───────────────────────────────────────────────────────────

// targetRow in routes.go — all plain values (no sql.Null wrappers anywhere).
export type NetqualityTarget = {
  id: number
  source: 'builtin' | 'custom'
  isp: NetqualityISP
  region: string
  label: string
  host: string
  enabled: boolean
  created_at: string
}

export function listNetqualityTargets(): Promise<NetqualityTarget[]> {
  return authedFetch<NetqualityTarget[]>(`${ROOT}/targets`)
}

export function useNetqualityTargets(enabled: boolean = true): UseQueryResult<NetqualityTarget[]> {
  return useQuery({ queryKey: ['netquality-targets'], queryFn: listNetqualityTargets, enabled })
}

export function createNetqualityTarget(body: {
  isp: NetqualityISP
  region?: string
  label: string
  host: string
}): Promise<{ ok: true }> {
  return authedFetch<{ ok: true }>(`${ROOT}/targets`, { method: 'POST', body })
}

// patch enable/disable or rename; empty body → server returns {ok,noop}.
export function patchNetqualityTarget(
  id: number,
  body: { enabled?: boolean; label?: string },
): Promise<{ ok: true; noop?: boolean }> {
  return authedFetch<{ ok: true; noop?: boolean }>(`${ROOT}/targets/${id}`, { method: 'PATCH', body })
}

// Hard-deletes a CUSTOM target only (builtins 404). 200 {ok:true} on success.
export function deleteNetqualityTarget(id: number): Promise<{ ok: true }> {
  return authedFetch<{ ok: true }>(`${ROOT}/targets/${id}`, { method: 'DELETE' })
}

// ── per-server probe config (netquality_hosts) ────────────────────────────────

// hostRow in routes.go. last_error/updated_at are Go pointers + omitempty:
// plain string-or-absent, NEVER a sql.Null* object — guard with `!= null`.
export type NetqualityHostConfig = {
  server_id: number
  enabled: boolean
  sample_interval_seconds: number
  last_error?: string
  updated_at?: string
}

export function listNetqualityHostConfigs(): Promise<NetqualityHostConfig[]> {
  return authedFetch<NetqualityHostConfig[]>(`${ROOT}/hosts`)
}

// The Hosts tab data source. NOTE: this is NOT the generic deploy table — see
// the file header. The count of rows where enabled=true is the correct "Hosts"
// number the bug diagnosis asks us to surface (vs the stale plugin_hosts count).
export function useNetqualityHostConfigs(): UseQueryResult<NetqualityHostConfig[]> {
  return useQuery({
    queryKey: ['netquality-host-configs'],
    queryFn: listNetqualityHostConfigs,
    refetchInterval: 15000, // web's Hosts tab auto-refreshes at 15s
  })
}

// Enable/disable probing + set interval. <=0 interval is coerced to 300 server
// side; first enable seeds the host's target set then PushConfig.
export function putNetqualityHost(
  serverID: number,
  body: { enabled: boolean; sample_interval_seconds: number },
): Promise<{ ok: true; warning?: string }> {
  return authedFetch<{ ok: true; warning?: string }>(`${ROOT}/hosts/${serverID}`, { method: 'PUT', body })
}

// ── per-host target picker ────────────────────────────────────────────────────

// hostTargetRow — every globally-enabled target + a `selected` flag for this
// host. All plain values.
export type NetqualityHostTarget = {
  target_id: number
  isp: NetqualityISP
  region: string
  label: string
  host: string
  selected: boolean
}

export function listNetqualityHostTargets(serverID: number): Promise<NetqualityHostTarget[]> {
  return authedFetch<NetqualityHostTarget[]>(`${ROOT}/hosts/${serverID}/targets`)
}

export function useNetqualityHostTargets(serverID: number | null): UseQueryResult<NetqualityHostTarget[]> {
  return useQuery({
    queryKey: ['netquality-host-targets', serverID],
    queryFn: () => listNetqualityHostTargets(serverID as number),
    enabled: serverID != null,
  })
}

// Idempotently replace the host's selected target set, then PushConfig.
export function updateNetqualityHostTargets(serverID: number, targetIDs: number[]): Promise<{ ok: true }> {
  return authedFetch<{ ok: true }>(`${ROOT}/hosts/${serverID}/targets`, {
    method: 'PUT',
    body: { target_ids: targetIDs },
  })
}

// ── sample history (RTT/loss time-series for one host × target) ────────────────

// querySamples in routes.go returns {resolution, points:[…]}. Each point is a
// MapScan of the chosen table, so columns are plain JSON values that may be
// null. rtt_avg_ms is null on a fully-lost bucket — guard with `!= null`, never
// nullStr (these are NOT sql.Null wrappers, just raw column values).
export type NetqualitySamplePoint = {
  ts: string
  rtt_avg_ms?: number | null
  loss_pct?: number | null
  // raw-resolution-only extras (absent on minute/hour rollups)
  rtt_min_ms?: number | null
  rtt_max_ms?: number | null
  jitter_ms?: number | null
  status?: 'ok' | 'lost' | 'error'
  // rollup-only
  samples?: number | null
}

export type NetqualitySamplesResponse = {
  resolution: 'raw' | 'minute' | 'hour'
  points: NetqualitySamplePoint[]
}

export function fetchNetqualitySamples(params: {
  server_id: number
  target_id: number
  from: string
  to: string
  resolution?: 'raw' | 'minute' | 'hour'
}): Promise<NetqualitySamplesResponse> {
  const qs = new URLSearchParams({
    server_id: String(params.server_id),
    target_id: String(params.target_id),
    from: params.from,
    to: params.to,
  })
  if (params.resolution) qs.set('resolution', params.resolution)
  return authedFetch<NetqualitySamplesResponse>(`${ROOT}/samples?${qs.toString()}`)
}

// useNetqualitySamples drives the history screen. The query key carries the
// range token so switching 1h/24h refetches cleanly without an effect. Disabled
// until both ids are present.
export function useNetqualitySamples(params: {
  serverID: number | null
  targetID: number | null
  range: NetqualityRange
  windowEnd: number
}): UseQueryResult<NetqualitySamplesResponse> {
  const { serverID, targetID, range, windowEnd } = params
  const { resolution, ms } = rangeParams(range)
  return useQuery({
    queryKey: ['netquality-samples', serverID, targetID, range, windowEnd],
    queryFn: () =>
      fetchNetqualitySamples({
        server_id: serverID as number,
        target_id: targetID as number,
        from: new Date(windowEnd - ms).toISOString(),
        to: new Date(windowEnd).toISOString(),
        resolution,
      }),
    enabled: serverID != null && targetID != null,
    refetchInterval: 30000,
  })
}

// Range presets mirror the web HistoryDrawer's rangeToParams (the server's
// /samples auto-resolution: span ≤ 2h → raw, ≤ 7d → minute, else hour).
export type NetqualityRange = '1h' | '24h'

export function rangeParams(r: NetqualityRange): { resolution: 'raw' | 'minute' | 'hour'; ms: number } {
  return r === '1h'
    ? { resolution: 'raw', ms: 60 * 60 * 1000 }
    : { resolution: 'minute', ms: 24 * 60 * 60 * 1000 }
}
